// Trasy HTTP. `buildApp` składa aplikację z wstrzykniętych zależności i nie
// otwiera portu — nasłuch uruchamia `server.ts`, a testy używają `app.inject`.

import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_RULES, validateAddress } from '@olcys/core';
import type { AnalysisRun, Identifier, IdentifierType, SourceConnector } from '@olcys/core';
import { runAnalysis } from './analysis.ts';
import { detectReplacements, diffRuns } from './diff.ts';
import { buildDossier } from './dossier.ts';
import type { DossierView } from './dossier.ts';
import { registerDossierRoutes } from './dossier-routes.ts';
import { HttpError, IDENTIFIER_TYPES, TOOL_VERSION, idParams, identifierItems } from './http-common.ts';
import type { AppDeps, RouteContext } from './http-common.ts';
import { looksLikePersonName } from './persons.ts';
import { renderReportHtml } from './report.ts';
import type { ConnectorInfo } from './report.ts';
import type { CaseSummary, Storage } from './storage.ts';
import { registerSweepRoutes } from './sweep-routes.ts';

export type { AppDeps } from './http-common.ts';
export { TOOL_VERSION } from './http-common.ts';

export interface CaseSchedule {
  everyMinutes: number;
  nextRunAt: string;
}

/** Sprawa w odpowiedzi API: podsumowanie + ewentualny harmonogram cyklicznych analiz. */
export type CaseView = CaseSummary & { schedule?: CaseSchedule };

/** Rozpoznaje rodzaj identyfikatora po jego postaci — analityk wpisuje jedną wartość. */
export function detectIdentifierType(value: string): IdentifierType {
  const text = value.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return 'email';
  if (/^https?:\/\//i.test(text)) return 'profile_url';
  if (validateAddress(text)) return 'crypto_address';
  if (/^[^\s]+\.eth$/i.test(text)) return 'ens_name';
  if (looksLikePersonName(text)) return 'full_name';
  return 'nick';
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { storage, connectors, chainProviders } = deps;
  const rules = deps.rules ?? DEFAULT_RULES;
  const now = deps.now ?? (() => new Date());
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'DELETE'] });

  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ error: `Nieprawidłowe dane wejściowe: ${error.message}` });
    }
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 500;
    if (status === 500) app.log.error(error);
    const message =
      error instanceof HttpError ? error.message : status === 500 ? 'Błąd wewnętrzny serwera.' : 'Nieprawidłowe żądanie.';
    return reply.code(status).send({ error: message });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Nie znaleziono zasobu.' }));

  const connectorInfo = (): ConnectorInfo[] =>
    connectors.map(({ id, service, label, description, accepts, enabledByDefault }) => ({
      id,
      service,
      label,
      description,
      accepts,
      enabledByDefault,
    }));

  const requireCase = async (id: string): Promise<CaseSummary> => {
    const found = await storage.getCase(id);
    if (!found) throw new HttpError(404, 'Nie znaleziono sprawy.');
    return found;
  };
  const requireRun = async (id: string): Promise<AnalysisRun> => {
    const found = await storage.getRun(id);
    if (!found) throw new HttpError(404, 'Nie znaleziono analizy.');
    return found;
  };

  const selectConnectors = (connectorIds?: string[]): SourceConnector[] => {
    const unknown = (connectorIds ?? []).filter((id) => !connectors.some((connector) => connector.id === id));
    if (unknown.length > 0) throw new HttpError(400, `Nieznane łączniki: ${unknown.join(', ')}.`);
    return connectorIds
      ? connectors.filter((connector) => connectorIds.includes(connector.id))
      : connectors.filter((connector) => connector.enabledByDefault);
  };

  const cleanIdentifiers = (raw: Identifier[]): Identifier[] => {
    const identifiers = raw.map((item) => ({ type: item.type, value: item.value.trim() }));
    for (const identifier of identifiers) {
      if (!identifier.value) throw new HttpError(400, 'Identyfikator nie może być pusty.');
      if (identifier.type === 'crypto_address' && !validateAddress(identifier.value)) {
        throw new HttpError(400, `„${identifier.value}” nie jest poprawnym adresem obsługiwanej sieci (Bitcoin, Ethereum, TRON).`);
      }
    }
    return identifiers;
  };

  // Teczka liczy się z zapisanej analizy i decyzji; wynik pamiętamy do najbliższej zmiany danych.
  const dossiers = new Map<string, DossierView>();
  const invalidateDossiers = () => dossiers.clear();
  const loadDossier = async (run: AnalysisRun): Promise<DossierView> => {
    const cached = dossiers.get(run.id);
    if (cached) return cached;
    const [caseSummary, intel, decisions, latest] = await Promise.all([
      requireCase(run.caseId),
      storage.getRunIntel(run.id),
      storage.listDecisions(run.caseId),
      storage.listLatestRuns(),
    ]);
    const dossier = buildDossier({
      caseSummary,
      run,
      intel,
      decisions,
      otherCases: latest.filter((item) => item.caseId !== run.caseId),
      rules,
      now: now(),
      matchService: deps.matchService,
    });
    if (run.status === 'completed') dossiers.set(run.id, dossier);
    return dossier;
  };

  /** Wykonuje analizę sprawy i zapisuje wynik wraz z kopiami treści. */
  const executeRun = async (caseSummary: CaseSummary, connectorIds?: string[]): Promise<AnalysisRun> => {
    const selected = selectConnectors(connectorIds);

    const run: AnalysisRun = {
      id: randomUUID(),
      caseId: caseSummary.id,
      startedAt: now().toISOString(),
      status: 'running',
      query: caseSummary.query,
      connectors: selected.map((connector) => connector.id),
      findings: [],
      log: [],
    };
    await storage.saveRun(run);
    try {
      const result = await runAnalysis({
        query: caseSummary.query,
        connectors: selected,
        chainProviders,
        resolveActivity: deps.resolveActivity,
        rules,
        now,
        log: (message) => app.log.info({ runId: run.id }, message),
      });
      run.findings = result.findings;
      run.log = result.log;
      run.status = 'completed';
      run.finishedAt = now().toISOString();
      await storage.saveRun(run);
      await storage.saveDocuments(run.id, result.documents);
      await storage.saveRunIntel(run.id, result.intel);
      // Nowa analiza zmienia też powiązania między sprawami w teczkach innych spraw.
      invalidateDossiers();
    } catch (error) {
      run.status = 'failed';
      run.finishedAt = now().toISOString();
      run.log.push({ time: run.finishedAt, message: `Analiza przerwana błędem: ${error instanceof Error ? error.message : String(error)}` });
      await storage.saveRun(run);
      throw error;
    }
    return run;
  };

  // ---------- Harmonogram cyklicznych analiz (w pamięci procesu) ----------

  const schedules = new Map<string, { timer: NodeJS.Timeout; everyMinutes: number; nextRunAt: string }>();
  const withSchedule = (caseSummary: CaseSummary): CaseView => {
    const schedule = schedules.get(caseSummary.id);
    return schedule
      ? { ...caseSummary, schedule: { everyMinutes: schedule.everyMinutes, nextRunAt: schedule.nextRunAt } }
      : caseSummary;
  };
  const clearSchedule = (caseId: string) => {
    const schedule = schedules.get(caseId);
    if (schedule) clearInterval(schedule.timer);
    schedules.delete(caseId);
  };
  app.addHook('onClose', async () => {
    for (const caseId of [...schedules.keys()]) clearSchedule(caseId);
  });

  // ---------- Trasy ----------

  app.get('/api/health', async () => ({ status: 'ok', version: TOOL_VERSION, time: now().toISOString() }));

  app.get('/api/connectors', async () => connectorInfo());

  app.get('/api/rules', async () => rules);

  app.get('/api/cases', async () => (await storage.listCases()).map(withSchedule));

  app.post<{ Body: { name: string; identifiers: Identifier[] } }>(
    '/api/cases',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'identifiers'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 200 },
            identifiers: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: identifierItems,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) throw new HttpError(400, 'Nazwa sprawy nie może być pusta.');
      const identifiers = cleanIdentifiers(request.body.identifiers);
      const created = await storage.createCase(name, { identifiers }, now().toISOString());
      return reply.code(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>('/api/cases/:id', { schema: { params: idParams } }, async (request) =>
    withSchedule(await requireCase(request.params.id)),
  );

  app.post<{ Params: { id: string }; Body?: { connectors?: string[] } }>(
    '/api/cases/:id/runs',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            connectors: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 100 } },
          },
        },
      },
    },
    async (request, reply) => {
      const caseSummary = await requireCase(request.params.id);
      const run = await executeRun(caseSummary, request.body?.connectors);
      return reply.code(201).send(run);
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id', { schema: { params: idParams } }, async (request) =>
    requireRun(request.params.id),
  );

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    '/api/cases/:id/diff',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          properties: {
            from: { type: 'string', maxLength: 64 },
            to: { type: 'string', maxLength: 64 },
          },
        },
      },
    },
    async (request) => {
      const caseSummary = await requireCase(request.params.id);
      // Bez parametrów porównujemy dwie ostatnie analizy sprawy.
      const recent = caseSummary.runs.slice(-2);
      const fromId = request.query.from || recent[0]?.id;
      const toId = request.query.to || recent[1]?.id;
      if (!fromId || !toId || fromId === toId) {
        throw new HttpError(400, 'Do porównania potrzebne są dwie różne analizy tej sprawy.');
      }
      for (const id of [fromId, toId]) {
        if (!caseSummary.runs.some((run) => run.id === id)) {
          throw new HttpError(404, `Analiza ${id} nie należy do tej sprawy.`);
        }
      }
      return diffRuns(await requireRun(fromId), await requireRun(toId));
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id/replacements', { schema: { params: idParams } }, async (request) =>
    detectReplacements(await requireRun(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id/report.html', { schema: { params: idParams } }, async (request, reply) => {
    const run = await requireRun(request.params.id);
    const caseSummary = await requireCase(run.caseId);
    const dossier = await loadDossier(run);
    const html = renderReportHtml(caseSummary, run, dossier, detectReplacements({ ...run, findings: dossier.findings }), {
      connectors: connectorInfo(),
      rules,
      version: TOOL_VERSION,
      generatedAt: now().toISOString(),
    });
    return reply
      .type('text/html; charset=utf-8')
      // Raport zawiera treści z internetu — przeglądarka nie może z niego nic wykonać ani pobrać.
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'")
      .send(html);
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/report.json', { schema: { params: idParams } }, async (request) => {
    const run = await requireRun(request.params.id);
    const caseSummary = await requireCase(run.caseId);
    return {
      tool: { name: 'OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów', version: TOOL_VERSION },
      generatedAt: now().toISOString(),
      case: { id: caseSummary.id, name: caseSummary.name, createdAt: caseSummary.createdAt },
      run,
      rules,
      connectors: connectorInfo().filter((connector) => run.connectors.includes(connector.id)),
      replacements: detectReplacements(run),
      // Materiał do teczki: widziane profile, ścieżka odkrywania identyfikatorów, wzmianki o usługach.
      intel: await storage.getRunIntel(run.id),
      decisions: await storage.listDecisions(run.caseId),
      // Kopie treści, z których policzono skróty SHA-256 śladów.
      documents: await storage.listDocuments(run.id),
    };
  });

  app.post<{ Params: { id: string }; Body: { everyMinutes: number } }>(
    '/api/cases/:id/schedule',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['everyMinutes'],
          additionalProperties: false,
          properties: { everyMinutes: { type: 'integer', minimum: 1, maximum: 10080 } },
        },
      },
    },
    async (request) => {
      const caseSummary = await requireCase(request.params.id);
      const { everyMinutes } = request.body;
      const intervalMs = everyMinutes * 60_000;
      clearSchedule(caseSummary.id);
      const timer = setInterval(() => {
        const schedule = schedules.get(caseSummary.id);
        if (schedule) schedule.nextRunAt = new Date(now().getTime() + intervalMs).toISOString();
        executeRun(caseSummary).catch((error) => app.log.error(error, 'Cykliczna analiza nie powiodła się.'));
      }, intervalMs);
      // Harmonogram nie może utrzymywać procesu przy życiu.
      timer.unref();
      schedules.set(caseSummary.id, {
        timer,
        everyMinutes,
        nextRunAt: new Date(now().getTime() + intervalMs).toISOString(),
      });
      return withSchedule(caseSummary);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/cases/:id/schedule', { schema: { params: idParams } }, async (request) => {
    const caseSummary = await requireCase(request.params.id);
    clearSchedule(caseSummary.id);
    return withSchedule(caseSummary);
  });

  // ---------- Jedno wywołanie: identyfikator → sprawa → analiza → teczka ----------

  app.post<{ Body: { value: string; type?: IdentifierType } }>(
    '/api/quick',
    {
      schema: {
        body: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: {
            value: { type: 'string', minLength: 1, maxLength: 200 },
            type: { type: 'string', enum: IDENTIFIER_TYPES },
          },
        },
      },
    },
    async (request, reply) => {
      const value = request.body.value.trim();
      if (!value) throw new HttpError(400, 'Identyfikator nie może być pusty.');
      const identifiers = cleanIdentifiers([{ type: request.body.type ?? detectIdentifierType(value), value }]);
      const created = await storage.createCase(value, { identifiers }, now().toISOString());
      const run = await executeRun(created);
      return reply.code(201).send({ case: withSchedule(await requireCase(created.id)), dossier: await loadDossier(run) });
    },
  );

  const context: RouteContext = {
    storage,
    connectors,
    deps,
    rules,
    now,
    requireCase,
    requireRun,
    connectorInfo,
    selectConnectors,
    executeRun,
    cleanIdentifiers,
    loadDossier,
    invalidateDossiers,
  };
  registerDossierRoutes(app, context);
  registerSweepRoutes(app, context);

  return app;
}
