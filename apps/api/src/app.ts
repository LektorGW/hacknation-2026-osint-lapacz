// Trasy HTTP. `buildApp` składa aplikację z wstrzykniętych zależności i nie
// otwiera portu — nasłuch uruchamia `server.ts`, a testy używają `app.inject`.

import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_RULES, validateAddress } from '@olcys/core';
import type { AnalysisRun, Identifier, IdentifierType, SourceConnector } from '@olcys/core';
import { anonymizeFacts, trackAi } from './ai-rules.ts';
import { DEFAULT_CORPUS_MAX_ROWS, DEFAULT_CORPUS_RETENTION_DAYS, createCorpusConnector } from './corpus.ts';
import { detectReplacements, diffRuns } from './diff.ts';
import { buildDossier } from './dossier.ts';
import type { DossierView } from './dossier.ts';
import { registerDossierRoutes } from './dossier-routes.ts';
import { HttpError, IDENTIFIER_TYPES, TOOL_VERSION, idParams, identifierItems } from './http-common.ts';
import type { AppDeps, RouteContext } from './http-common.ts';
import { createMonitor } from './monitor.ts';
import { registerMonitorRoutes } from './monitor-routes.ts';
import { looksLikePersonName } from './persons.ts';
import { renderReportHtml } from './report.ts';
import { createRunEngine } from './runs.ts';
import type { RunDepth, RunPeriod } from './runs.ts';
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
  const { storage, chainProviders } = deps;
  const rules = deps.rules ?? DEFAULT_RULES;
  const now = deps.now ?? (() => new Date());
  // Indeks własny jest zawsze dostępny jako źródło: analiza korzysta ze wszystkiego, co widział monitoring.
  const connectors: SourceConnector[] = [...deps.connectors, createCorpusConnector(storage)];
  const corpusSettings = {
    retentionDays: deps.corpus?.retentionDays ?? DEFAULT_CORPUS_RETENTION_DAYS,
    maxRows: deps.corpus?.maxRows ?? DEFAULT_CORPUS_MAX_ROWS,
  };
  const ai = deps.ai ? trackAi(deps.ai) : undefined;
  const summarizer = deps.summaryAi ? trackAi(deps.summaryAi) : undefined;

  /** Dane sprawy, które nie mogą trafić do zewnętrznego modelu w postaci jawnej. */
  const sensitiveTerms = (dossier: DossierView): Parameters<typeof anonymizeFacts>[1] => [
    ...[dossier.subject.name, ...dossier.subject.knownNames, ...dossier.persons.flatMap((person) => [person.fullName ?? '', ...person.nameVariants])].map((value) => ({ kind: 'OSOBA' as const, value })),
    ...dossier.subject.identifiers.map(({ identifier }) => ({
      kind: identifier.type === 'email' ? ('EMAIL' as const) : identifier.type === 'crypto_address' ? ('ADRES' as const) : identifier.type === 'full_name' ? ('OSOBA' as const) : ('NICK' as const),
      value: identifier.value,
    })),
    ...dossier.profiles.flatMap((profile) => [
      { kind: 'NICK' as const, value: profile.handle ?? '' },
      ...(profile.attributes.emails ?? []).map((value) => ({ kind: 'EMAIL' as const, value })),
      ...(profile.attributes.phones ?? []).map((value) => ({ kind: 'TELEFON' as const, value })),
    ]),
    ...dossier.relatedPersons.map((person) => ({ kind: 'NICK' as const, value: person.handle })),
    ...dossier.findings.map((finding) => ({ kind: 'ADRES' as const, value: finding.address })),
  ];
  const app = Fastify({ logger: deps.logger ?? false });

  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'DELETE'] });

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

  /**
   * Źródło dołączane w trybie głębokim: wyszukiwarka forów. Pojedyncze źródła monitoringu (`mon-*`)
   * pytają te same hosty co ona jednym zbiorczym zapytaniem — pomiar pokazał, że dublowały pracę
   * i zajmowały większość czasu analizy, więc zostają wyłącznie dla monitoringu.
   */
  const isDeepSource = (connector: SourceConnector) => connector.id === 'deep-search' && connector.accepts.length > 0;

  const selectConnectors = (connectorIds?: string[], depth: RunDepth = 'standard'): SourceConnector[] => {
    const unknown = (connectorIds ?? []).filter((id) => !connectors.some((connector) => connector.id === id));
    if (unknown.length > 0) throw new HttpError(400, `Nieznane łączniki: ${unknown.join(', ')}.`);
    return connectors.filter(
      (connector) =>
        (connectorIds ? connectorIds.includes(connector.id) : connector.enabledByDefault) || (depth === 'deep' && isDeepSource(connector)),
    );
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
      serviceLabels: deps.serviceLabels,
      deep: (run as AnalysisRun & { depth?: RunDepth }).depth === 'deep',
    });
    if (ai && dossier.keyFindings.length > 0) {
      // Streszczenie powstaje wyłącznie z gotowych ustaleń; błąd modelu zostawia teczkę bez streszczenia.
      const texts = dossier.keyFindings.map((item) => item.text);
      const summarize = (facts: string[]) => (summarizer ?? ai).assistant.summarize(facts);
      if (deps.aiLocal) dossier.summary = await summarize(texts);
      else {
        // Model poza tą maszyną dostaje fakty bez danych osobowych i adresów; znaczniki wracają po odpowiedzi.
        const { facts, restore } = anonymizeFacts(texts, sensitiveTerms(dossier));
        const summary = await summarize(facts);
        dossier.summary = summary ? { ...summary, text: restore(summary.text) } : null;
      }
    }
    if (run.status === 'completed') dossiers.set(run.id, dossier);
    return dossier;
  };

  // ---------- Wykonywanie analiz (tryb standardowy i głęboki, także w tle) ----------

  const runs = createRunEngine({
    storage,
    chainProviders,
    deepChainProviders: deps.deepChainProviders,
    resolveActivity: deps.resolveActivity,
    rules,
    now,
    ai: ai?.assistant,
    normalizeText: deps.normalizeText,
    limits: deps.runLimits,
    log: (runId, message) => app.log.info({ runId }, message),
    // Nowa analiza zmienia też powiązania między sprawami w teczkach innych spraw.
    onCompleted: invalidateDossiers,
  });
  app.addHook('preClose', () => runs.stop());

  /** Wykonuje analizę sprawy i zapisuje wynik wraz z kopiami treści. */
  const executeRun = (caseSummary: CaseSummary, connectorIds?: string[], depth: RunDepth = 'standard', period?: RunPeriod): Promise<AnalysisRun> =>
    runs.execute(caseSummary, { connectors: selectConnectors(connectorIds, depth), depth, period });

  const periodSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { from: { type: 'string', minLength: 4, maxLength: 40 }, to: { type: 'string', minLength: 4, maxLength: 40 } },
  } as const;
  /** Okres z żądania: daty muszą dać się odczytać, a początek nie może być po końcu. */
  const cleanPeriod = (period?: RunPeriod): RunPeriod | undefined => {
    if (!period?.from && !period?.to) return undefined;
    for (const value of [period.from, period.to]) {
      if (value !== undefined && Number.isNaN(new Date(value).getTime())) throw new HttpError(400, `„${value}” nie jest poprawną datą (ISO 8601).`);
    }
    if (period.from && period.to && new Date(period.from) > new Date(period.to)) throw new HttpError(400, 'Początek okresu jest późniejszy niż koniec.');
    return period;
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

  app.get('/api/health', async () => {
    const database = (await storage.ping()) ? 'ok' : 'error';
    return { status: database === 'ok' ? 'ok' : 'degraded', version: TOOL_VERSION, time: now().toISOString(), database };
  });

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

  app.post<{ Params: { id: string }; Body?: { connectors?: string[]; depth?: RunDepth; async?: boolean; period?: RunPeriod } }>(
    '/api/cases/:id/runs',
    {
      schema: {
        params: idParams,
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            connectors: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 100 } },
            depth: { type: 'string', enum: ['standard', 'deep'] },
            async: { type: 'boolean' },
            period: periodSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const caseSummary = await requireCase(request.params.id);
      const depth = request.body?.depth ?? 'standard';
      const period = cleanPeriod(request.body?.period);
      if (request.body?.async) {
        // Analiza liczy się w tle; postęp pod /api/runs/:id/progress, wynik pod /api/runs/:id.
        const { run } = await runs.start(caseSummary, { connectors: selectConnectors(request.body.connectors, depth), depth, period });
        return reply.code(202).send({ id: run.id, status: run.status });
      }
      const run = await executeRun(caseSummary, request.body?.connectors, depth, period);
      return reply.code(201).send(run);
    },
  );

  app.get<{ Params: { id: string } }>('/api/runs/:id/progress', { schema: { params: idParams } }, async (request) => {
    const live = runs.progress(request.params.id);
    if (live) return live;
    // Analiza z wcześniejszego uruchomienia serwera: znamy tylko jej stan końcowy.
    const run = (await requireRun(request.params.id)) as AnalysisRun & { depth?: RunDepth };
    return {
      runId: run.id,
      caseId: run.caseId,
      status: run.status,
      depth: run.depth ?? 'standard',
      stage: run.status === 'completed' ? 'done' : run.status === 'failed' ? 'failed' : 'search',
      connectorsDone: 0,
      connectorsTotal: 0,
      documents: new Set(run.findings.flatMap((finding) => finding.evidence.map((item) => item.url))).size,
      addresses: run.findings.length,
      startedAt: run.startedAt,
      updatedAt: run.finishedAt ?? run.startedAt,
      ...(await storage.getRunIntel(run.id).then((intel) => (intel?.timings ? { timings: intel.timings, slowestQueries: intel.slowestQueries ?? [] } : {}))),
    };
  });

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

  app.post<{ Body: { value: string; type?: IdentifierType; depth?: RunDepth; async?: boolean; period?: RunPeriod } }>(
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
            depth: { type: 'string', enum: ['standard', 'deep'] },
            async: { type: 'boolean' },
            period: periodSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const value = request.body.value.trim();
      if (!value) throw new HttpError(400, 'Identyfikator nie może być pusty.');
      const identifiers = cleanIdentifiers([{ type: request.body.type ?? detectIdentifierType(value), value }]);
      const period = cleanPeriod(request.body.period);
      const created = await storage.createCase(value, { identifiers }, now().toISOString());
      const depth = request.body.depth ?? 'standard';
      if (request.body.async) {
        const { run } = await runs.start(created, { connectors: selectConnectors(undefined, depth), depth, period });
        return reply.code(202).send({ case: created, run: { id: run.id, status: run.status } });
      }
      const run = await executeRun(created, undefined, depth, period);
      return reply.code(201).send({ case: withSchedule(await requireCase(created.id)), dossier: await loadDossier(run) });
    },
  );

  // ---------- Cykliczny monitoring źródeł ----------

  const monitor = createMonitor({
    storage,
    connectors,
    monitorConnectors: deps.monitorConnectors,
    chainProviders,
    resolveActivity: deps.resolveActivity,
    rules,
    matchService: deps.matchService,
    ai: ai?.assistant,
    normalizeText: deps.normalizeText,
    addressLabels: deps.serviceLabels,
    corpus: corpusSettings,
    now,
    timers: deps.monitorTimers,
    log: (message, error) => (error ? app.log.error({ err: error }, message) : app.log.info(message)),
  });
  // Przed zamknięciem bazy: zatrzymanie harmonogramu i dokończenie trwającego przebiegu.
  app.addHook('preClose', () => monitor.stop());
  await monitor.start();

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
    monitor,
    runs,
    ai,
    corpusSettings,
  };
  registerDossierRoutes(app, context);
  registerSweepRoutes(app, context);
  registerMonitorRoutes(app, context);

  return app;
}
