// Trasy monitoringu źródeł: stan i ustawienia harmonogramu, ręczny przebieg,
// lista trafień oraz działania na trafieniu (analiza autora, sprawa, odrzucenie).

import type { FastifyInstance } from 'fastify';
import type { WatchHit } from '@olcys/core';
import { HttpError, idParams } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { createCaseFromAnalysis } from './lead-case.ts';
import { NoAuthorError, UnknownSourceError, compareHits, hitKey } from './monitor.ts';
import type { MonitorPatch } from './monitor.ts';

const DEFAULT_HIT_LIMIT = 100;

export function registerMonitorRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, monitor, now } = context;

  const requireHit = async (id: string): Promise<WatchHit> => {
    const hit = await storage.getHit(id);
    if (!hit) throw new HttpError(404, 'Nie znaleziono trafienia monitoringu.');
    return hit;
  };

  /** Analiza autora trafienia z czytelnym błędem, gdy publikacja nie ma autora. */
  const analyze = async (id: string): Promise<WatchHit> => {
    await requireHit(id);
    try {
      return (await monitor.analyze(id))!;
    } catch (error) {
      if (error instanceof NoAuthorError) throw new HttpError(400, error.message);
      throw error;
    }
  };

  app.get('/api/monitor', async () => monitor.status());

  app.put<{ Body: MonitorPatch }>(
    '/api/monitor',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean' },
            everyMinutes: { type: 'integer', minimum: 1, maximum: 10080 },
            autoAnalyzeThreshold: { type: 'integer', minimum: 0, maximum: 200 },
            maxAutoAnalyses: { type: 'integer', minimum: 0, maximum: 200 },
            maxAiPublications: { type: 'integer', minimum: 0, maximum: 2000 },
            sources: { type: 'object', maxProperties: 500, additionalProperties: { type: 'boolean' } },
          },
        },
      },
    },
    async (request) => {
      try {
        return await monitor.configure(request.body);
      } catch (error) {
        if (error instanceof UnknownSourceError) throw new HttpError(400, error.message);
        throw error;
      }
    },
  );

  // Ręczny przebieg: odpowiedź po jego zakończeniu (trwający przebieg nie jest dublowany).
  app.post('/api/monitor/run', async () => {
    const newHits = await monitor.run();
    return { status: await monitor.status(), newHits };
  });

  // Jednorazowe sprzątanie po zmianie reguł: zapisane trafienia są przeliczane bieżącymi regułami,
  // a niespełniające kryteriów — oznaczane jako odrzucone z powodem.
  app.post('/api/monitor/recheck', async () => ({ ...(await monitor.recheck()), status: await monitor.status() }));

  app.get<{ Querystring: { status?: WatchHit['status']; minPolish?: number; minSuspicion?: number; limit?: number } }>(
    '/api/monitor/hits',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['new', 'analyzed', 'dismissed'] },
            minPolish: { type: 'integer', minimum: 0, maximum: 100 },
            minSuspicion: { type: 'integer', minimum: 0, maximum: 100 },
            limit: { type: 'integer', minimum: 1, maximum: 500 },
          },
        },
      },
    },
    async (request) => {
      const { status, minPolish = 0, minSuspicion = 0, limit = DEFAULT_HIT_LIMIT } = request.query;
      return (await storage.listHits())
        .filter((hit) => (!status || hit.status === status) && hit.polishNexus.score >= minPolish && hit.suspicion.score >= minSuspicion)
        .sort(compareHits)
        .slice(0, limit);
    },
  );

  app.post<{ Params: { id: string } }>('/api/monitor/hits/:id/analyze', { schema: { params: idParams } }, async (request) =>
    analyze(request.params.id),
  );

  app.post<{ Params: { id: string } }>('/api/monitor/hits/:id/case', { schema: { params: idParams } }, async (request, reply) => {
    let hit = await requireHit(request.params.id);
    // Ponowne wywołanie zwraca sprawę już założoną z tego trafienia.
    if (hit.caseId) return context.requireCase(hit.caseId);
    if (!(await storage.getHitAnalysis(hit.id))) hit = await analyze(hit.id);
    const analysis = (await storage.getHitAnalysis(hit.id))!;
    const created = await createCaseFromAnalysis(
      storage,
      `Monitoring: ${hit.author}`,
      analysis,
      `Analiza wykonana przez monitoring źródeł po publikacji ${hit.url}; sprawa założona z trafienia.`,
      now().toISOString(),
    );
    await storage.saveHit({ ...hit, caseId: created.id }, hitKey(hit));
    context.invalidateDossiers();
    return reply.code(201).send(created);
  });

  app.post<{ Params: { id: string } }>('/api/monitor/hits/:id/dismiss', { schema: { params: idParams } }, async (request) => {
    const hit = await requireHit(request.params.id);
    const dismissed: WatchHit = { ...hit, status: 'dismissed' };
    await storage.saveHit(dismissed, hitKey(hit));
    return dismissed;
  });
}
