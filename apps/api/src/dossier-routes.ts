// Trasy teczki podmiotu: teczka, decyzje analityka, dopisywanie identyfikatorów,
// zestawienie spraw, jawne reguły ocen oraz materiał do zapytania do usługi.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Decision, Identifier } from '@olcys/core';
import { AI_RULES } from './ai-rules.ts';
import { ALIAS_RULES } from './aliases.ts';
import { PIVOT_LIMITS } from './pivot.ts';
import { DEFAULT_MAX_IDENTIFIERS, DEFAULT_WIDELY_CITED_AUTHORS } from './analysis.ts';
import { HttpError, TOOL_VERSION, idParams, identifierItems } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { PERSON_RULES } from './persons.ts';
import { PRIORITY_RULES } from './priority.ts';
import { PROOF_RULES } from './proof.ts';
import { DEPTH_LIMITS } from './runs.ts';
import { RELATION_STRENGTH } from './relations.ts';
import { renderServiceRequestHtml } from './report-service.ts';
import { SERVICE_STRENGTH_RULES } from './services.ts';
import { SIGNAL_RULES } from './signals.ts';
import { sumByYear } from './format.ts';
import type { DecisionRecord } from './storage.ts';

/** Narzędzie nie ma jeszcze kont użytkowników — autor decyzji jest stały. */
const DECISION_AUTHOR = 'analityk';
const TOP_CASES = 10;

/** Nagłówki dla dokumentów HTML z treściami z internetu: nic nie może się wykonać ani pobrać. */
export const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function registerDossierRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, now, requireCase, requireRun, loadDossier } = context;

  /** Ostatnia zakończona analiza sprawy. */
  const latestRun = async (caseId: string) => {
    const caseSummary = await requireCase(caseId);
    const last = caseSummary.runs.filter((run) => run.status === 'completed').at(-1);
    if (!last) throw new HttpError(404, 'Sprawa nie ma jeszcze zakończonej analizy.');
    return requireRun(last.id);
  };

  app.get('/api/priority-rules', async () => ({
    priority: PRIORITY_RULES,
    persons: PERSON_RULES,
    services: SERVICE_STRENGTH_RULES,
    relations: RELATION_STRENGTH,
    signals: SIGNAL_RULES,
    ai: AI_RULES,
    aliases: ALIAS_RULES,
    pivot: PIVOT_LIMITS,
    proof: PROOF_RULES,
    analysis: { depth: DEPTH_LIMITS, widelyCitedAuthors: DEFAULT_WIDELY_CITED_AUTHORS },
  }));

  app.get<{ Params: { id: string } }>('/api/runs/:id/dossier', { schema: { params: idParams } }, async (request) =>
    loadDossier(await requireRun(request.params.id)),
  );

  app.get<{ Params: { id: string } }>('/api/cases/:id/dossier', { schema: { params: idParams } }, async (request) =>
    loadDossier(await latestRun(request.params.id)),
  );

  // ---------- Decyzje analityka ----------

  app.get<{ Params: { id: string } }>('/api/cases/:id/decisions', { schema: { params: idParams } }, async (request) => {
    await requireCase(request.params.id);
    return storage.listDecisions(request.params.id);
  });

  app.post<{ Params: { id: string }; Body: { target: 'profile' | 'address' | 'evidence'; key: string; decision: Decision; note?: string } }>(
    '/api/cases/:id/decisions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['target', 'key', 'decision'],
          additionalProperties: false,
          properties: {
            // `evidence`: decyzja dla pojedynczego śladu (klucz = identyfikator śladu), np. cofnięcie wpływu modelu.
            target: { type: 'string', enum: ['profile', 'address', 'evidence'] },
            key: { type: 'string', minLength: 1, maxLength: 500 },
            decision: { type: 'string', enum: ['confirmed', 'rejected'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const caseSummary = await requireCase(request.params.id);
      const key = request.body.key.trim();
      if (!key) throw new HttpError(400, 'Klucz decyzji nie może być pusty.');
      const note = request.body.note?.trim();
      const record: DecisionRecord = {
        id: randomUUID(),
        caseId: caseSummary.id,
        target: request.body.target as DecisionRecord['target'],
        key,
        decision: request.body.decision,
        ...(note ? { note } : {}),
        decidedAt: now().toISOString(),
        author: DECISION_AUTHOR,
      };
      await storage.addDecision(record);
      context.invalidateDossiers();
      return reply.code(201).send(record);
    },
  );

  app.delete<{ Params: { id: string; decisionId: string } }>(
    '/api/cases/:id/decisions/:decisionId',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'decisionId'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, decisionId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      await requireCase(request.params.id);
      if (!(await storage.deleteDecision(request.params.id, request.params.decisionId))) {
        throw new HttpError(404, 'Nie znaleziono decyzji w tej sprawie.');
      }
      context.invalidateDossiers();
      return reply.code(204).send();
    },
  );

  // ---------- Dopisanie identyfikatorów (np. odkrytych) do sprawy ----------

  app.post<{ Params: { id: string }; Body: { identifiers: Identifier[] } }>(
    '/api/cases/:id/identifiers',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['identifiers'],
          additionalProperties: false,
          properties: { identifiers: { type: 'array', minItems: 1, maxItems: 20, items: identifierItems } },
        },
      },
    },
    async (request) => {
      const caseSummary = await requireCase(request.params.id);
      const merged = [...caseSummary.query.identifiers];
      const keyOf = (identifier: Identifier) => `${identifier.type}:${identifier.value.trim().toLowerCase()}`;
      for (const identifier of context.cleanIdentifiers(request.body.identifiers)) {
        if (!merged.some((known) => keyOf(known) === keyOf(identifier))) merged.push(identifier);
      }
      if (merged.length > DEFAULT_MAX_IDENTIFIERS) {
        throw new HttpError(400, `Sprawa może mieć najwyżej ${DEFAULT_MAX_IDENTIFIERS} identyfikatorów.`);
      }
      await storage.updateCaseQuery(caseSummary.id, { identifiers: merged });
      return requireCase(caseSummary.id);
    },
  );

  // ---------- Zestawienie wszystkich spraw ----------

  app.get('/api/overview', async () => {
    const cases = await storage.listCases();
    const latest = await storage.listLatestRuns();
    const dossiers = await Promise.all(latest.map((item) => loadDossier(item.run)));
    const topCases = dossiers
      .map((dossier, index) => ({
        caseId: dossier.caseId,
        name: latest[index]!.caseName,
        priority: dossier.totals.priority,
        topScore: dossier.totals.topScore,
        cashOutPlnTotal: dossier.totals.cashOutPlnTotal,
      }))
      .sort((a, b) => b.priority - a.priority || b.cashOutPlnTotal - a.cashOutPlnTotal || a.name.localeCompare(b.name, 'pl'))
      .slice(0, TOP_CASES);
    return {
      cases: cases.length,
      runs: cases.reduce((sum, item) => sum + item.runs.length, 0),
      linkedAddresses: dossiers.reduce((sum, dossier) => sum + dossier.totals.linkedAddresses, 0),
      cashOutPlnByYear: sumByYear(dossiers.map((dossier) => dossier.totals.cashOutPlnByYear)),
      topCases,
      monitor: await context.monitor.status().then((status) => ({
        enabled: status.enabled,
        ...(status.lastRunAt ? { lastRunAt: status.lastRunAt } : {}),
        newHits: status.totals.newHits,
      })),
    };
  });

  // ---------- Indeks publikacji i model językowy ----------

  app.get('/api/corpus/stats', async () => ({ ...(await storage.corpusStats()), ...context.corpusSettings }));

  app.get('/api/ai', async () =>
    context.ai
      ? {
          enabled: true,
          provider: context.ai.assistant.id,
          model: context.ai.assistant.model,
          description: context.ai.assistant.description,
          usage: context.ai.usage,
        }
      : {
          enabled: false,
          provider: null,
          model: null,
          description: 'Model językowy nie jest skonfigurowany — wszystkie wyniki liczą wyłącznie jawne reguły.',
          usage: { analyzePublication: 0, summarize: 0, compareAuthors: 0, errors: 0 },
        },
  );

  // ---------- Materiał do zapytania do usługi ----------

  app.get<{ Params: { id: string; file: string } }>(
    '/api/runs/:id/service-request/:file',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'file'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, file: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const run = await requireRun(request.params.id);
      const caseSummary = await requireCase(run.caseId);
      const dossier = await loadDossier(run);
      const serviceId = request.params.file.replace(/\.html$/i, '');
      const link = dossier.serviceLinks.find((item) => item.id === serviceId);
      if (!link) throw new HttpError(404, 'Analiza nie wykazała powiązania z taką usługą.');
      return reply
        .type('text/html; charset=utf-8')
        .header('Content-Security-Policy', HTML_CSP)
        .send(renderServiceRequestHtml(caseSummary, run, dossier, link, { version: TOOL_VERSION, generatedAt: now().toISOString() }));
    },
  );
}
