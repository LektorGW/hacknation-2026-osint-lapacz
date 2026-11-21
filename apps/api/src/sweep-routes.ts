// Trasy typowania podmiotów: uruchomienie przeglądu źródeł, odczyt rankingu
// i założenie sprawy z wytypowanego podmiotu (bez ponownej analizy).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AnalysisRun } from '@olcys/core';
import { HttpError, idParams } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { DEFAULT_SWEEP_LIMIT, runSweep } from './sweep.ts';

export function registerSweepRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, now, deps } = context;

  const requireSweep = async (id: string) => {
    const sweep = await storage.getSweep(id);
    if (!sweep) throw new HttpError(404, 'Nie znaleziono przeglądu źródeł.');
    return sweep;
  };

  app.post<{ Body?: { connectors?: string[]; limit?: number } }>(
    '/api/sweeps',
    {
      schema: {
        body: {
          type: ['object', 'null'],
          additionalProperties: false,
          properties: {
            connectors: { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 100 } },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { sweep, analyses } = await runSweep({
        connectors: context.selectConnectors(request.body?.connectors),
        chainProviders: deps.chainProviders,
        resolveActivity: deps.resolveActivity,
        rules: context.rules,
        limit: request.body?.limit ?? DEFAULT_SWEEP_LIMIT,
        now,
        matchService: deps.matchService,
      });
      await storage.saveSweep(sweep);
      for (const [leadId, analysis] of analyses) await storage.saveLeadAnalysis(sweep.id, leadId, analysis);
      return reply.code(201).send(sweep);
    },
  );

  // Lista bez dzienników — te bywają długie i są dostępne w szczegółach przeglądu.
  app.get('/api/sweeps', async () => (await storage.listSweeps()).map((sweep) => ({ ...sweep, log: [] })));

  app.get<{ Params: { id: string } }>('/api/sweeps/:id', { schema: { params: idParams } }, async (request) =>
    requireSweep(request.params.id),
  );

  app.post<{ Params: { id: string; leadId: string } }>(
    '/api/sweeps/:id/leads/:leadId/case',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'leadId'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, leadId: { type: 'string', minLength: 1, maxLength: 64 } },
        },
      },
    },
    async (request, reply) => {
      const sweep = await requireSweep(request.params.id);
      const lead = sweep.leads.find((item) => item.id === request.params.leadId);
      if (!lead) throw new HttpError(404, 'Przegląd nie zawiera takiego wskazania.');
      // Ponowne wywołanie zwraca sprawę już założoną z tego wskazania.
      if (lead.caseId) return context.requireCase(lead.caseId);

      const analysis = await storage.getLeadAnalysis(sweep.id, lead.id);
      if (!analysis) throw new HttpError(404, 'Brak zapisanej analizy tego wskazania.');
      const created = await storage.createCase(`Typowanie: ${lead.handle}`, analysis.query, now().toISOString());
      const run: AnalysisRun = {
        id: randomUUID(),
        caseId: created.id,
        startedAt: analysis.startedAt,
        finishedAt: analysis.finishedAt,
        status: 'completed',
        query: analysis.query,
        connectors: analysis.connectors,
        findings: analysis.findings,
        log: [
          ...analysis.log,
          { time: now().toISOString(), message: `Analiza wykonana w przeglądzie źródeł ${sweep.id}; sprawa założona z wytypowanego podmiotu „${lead.handle}”.` },
        ],
      };
      await storage.saveRun(run);
      await storage.saveDocuments(run.id, analysis.documents);
      await storage.saveRunIntel(run.id, analysis.intel);
      lead.caseId = created.id;
      await storage.saveSweep(sweep);
      context.invalidateDossiers();
      return reply.code(201).send(await context.requireCase(created.id));
    },
  );
}
