// Trasy HTTP. `buildApp` składa aplikację z wstrzykniętych zależności i nie
// otwiera portu — nasłuch uruchamia `server.ts`, a testy używają `app.inject`.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_RULES, validateAddress } from '@olcys/core';
import type { AnalysisRun, ChainProvider, Identifier, ScoreRules, SourceConnector } from '@olcys/core';
import { runAnalysis } from './analysis.ts';
import type { ActivityResolver } from './analysis.ts';
import { detectReplacements, diffRuns } from './diff.ts';
import { renderReportHtml } from './report.ts';
import type { ConnectorInfo } from './report.ts';
import type { CaseSummary, Storage } from './storage.ts';

export interface AppDeps {
  storage: Storage;
  connectors: SourceConnector[];
  chainProviders: ChainProvider[];
  /** Strategia wyboru dostawcy danych blockchain; bez niej analiza używa własnej, prostej. */
  resolveActivity?: ActivityResolver;
  rules?: ScoreRules;
  now?: () => Date;
  /** Włącza log serwera (domyślnie wyłączony, żeby nie zaśmiecać testów). */
  logger?: boolean;
}

export interface CaseSchedule {
  everyMinutes: number;
  nextRunAt: string;
}

/** Sprawa w odpowiedzi API: podsumowanie + ewentualny harmonogram cyklicznych analiz. */
export type CaseView = CaseSummary & { schedule?: CaseSchedule };

export const TOOL_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

const IDENTIFIER_TYPES = ['full_name', 'nick', 'login', 'email', 'messenger_id', 'crypto_address', 'profile_url', 'ens_name'];

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

/** Błąd z kodem HTTP i komunikatem dla analityka. */
class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
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

  /** Wykonuje analizę sprawy i zapisuje wynik wraz z kopiami treści. */
  const executeRun = async (caseSummary: CaseSummary, connectorIds?: string[]): Promise<AnalysisRun> => {
    const unknown = (connectorIds ?? []).filter((id) => !connectors.some((connector) => connector.id === id));
    if (unknown.length > 0) throw new HttpError(400, `Nieznane łączniki: ${unknown.join(', ')}.`);
    const selected = connectorIds
      ? connectors.filter((connector) => connectorIds.includes(connector.id))
      : connectors.filter((connector) => connector.enabledByDefault);

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
              items: {
                type: 'object',
                required: ['type', 'value'],
                additionalProperties: false,
                properties: {
                  type: { type: 'string', enum: IDENTIFIER_TYPES },
                  value: { type: 'string', minLength: 1, maxLength: 200 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      const identifiers = request.body.identifiers.map((item) => ({ type: item.type, value: item.value.trim() }));
      if (!name) throw new HttpError(400, 'Nazwa sprawy nie może być pusta.');
      for (const identifier of identifiers) {
        if (!identifier.value) throw new HttpError(400, 'Identyfikator nie może być pusty.');
        if (identifier.type === 'crypto_address' && !validateAddress(identifier.value)) {
          throw new HttpError(400, `„${identifier.value}” nie jest poprawnym adresem obsługiwanej sieci (Bitcoin, Ethereum, TRON).`);
        }
      }
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
    const html = renderReportHtml(caseSummary, run, detectReplacements(run), {
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

  return app;
}
