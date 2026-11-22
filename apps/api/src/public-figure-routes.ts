// Trasa decyzji o osobie publicznej:
//   POST /api/cases/:id/public-figure — analityk potwierdza albo odrzuca dopasowanie podmiotu do wpisu Wikidata
//   (także wybór jednego z kilku kandydatów). Potwierdzenie rozwija sieć organizacji osoby na głębokość 2 i zapisuje
//   wynik jako rozwinięcie sieci (historia, dowody, wycofanie) — teczka bierze z niego kartę organizacji i graf.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AnalysisRun, GraphEdge, GraphNode } from '@olcys/core';
import { HttpError, idParams } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { isSyntheticConnector, LEGAL } from './network/expander.ts';
import type { ExpansionRecord, ExpansionStop, NetworkEdge, NetworkNode } from './network/types.ts';
import { organizationGraph } from './organizations.ts';
import { PUBLIC_FIGURE_LIMITS, buildPublicFigureNetwork, createWikidataClient, networkCounts, publicFigureGraph, publicFigureNodeId } from './public-figure.ts';
import type { DecisionRecord } from './storage.ts';

const AUTHOR = 'analityk';

const STOP_REASON: Record<string, ExpansionStop['reason']> = { query_limit: 'budget', source_error: 'source_error', depth_limit: 'depth_limit', time_limit: 'time_limit' };

export function registerPublicFigureRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, deps, now } = context;
  const live = deps.network?.live ?? context.connectors.some((connector) => connector.id.startsWith('live-'));
  const busy = new Set<string>();

  app.post<{ Params: { id: string }; Body: { wikidataId: string; decision: 'confirmed' | 'rejected'; note?: string } }>(
    '/api/cases/:id/public-figure',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['wikidataId', 'decision'],
          additionalProperties: false,
          properties: {
            wikidataId: { type: 'string', pattern: '^Q[0-9]{1,12}$' },
            decision: { type: 'string', enum: ['confirmed', 'rejected'] },
            note: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const caseSummary = await context.requireCase(request.params.id);
      const last = caseSummary.runs.filter((run) => run.status === 'completed').at(-1);
      if (!last) throw new HttpError(409, 'Sprawa nie ma zakończonej analizy — najpierw wykonaj analizę.');
      const run: AnalysisRun = await context.requireRun(last.id);
      const dossier = await context.loadDossier(run);
      const figure = dossier.publicFigure;
      const qid = request.body.wikidataId;
      if (!figure || (figure.wikidataId !== qid && !figure.candidates?.some((item) => item.wikidataId === qid))) {
        throw new HttpError(400, 'Ten wpis Wikidata nie jest kandydatem na osobę publiczną w tej sprawie.');
      }
      if (busy.has(caseSummary.id)) throw new HttpError(409, 'W tej sprawie trwa już rozwijanie sieci osoby publicznej — poczekaj na jego koniec.');
      const note = request.body.note?.trim();
      const decision: DecisionRecord = {
        id: randomUUID(),
        caseId: caseSummary.id,
        target: 'public_figure',
        key: qid,
        decision: request.body.decision,
        ...(note ? { note } : {}),
        decidedAt: now().toISOString(),
        author: AUTHOR,
      };
      await storage.addDecision(decision);
      context.invalidateDossiers();
      if (request.body.decision === 'rejected') return reply.code(201).send({ decision, expansion: null, note: 'Dopasowanie odrzucone — sieć tej osoby nie jest częścią teczki.' });

      const synthetic = run.connectors.length > 0 && run.connectors.every((id) => isSyntheticConnector(id) || id === 'corpus');
      if (synthetic) return reply.code(201).send({ decision, expansion: null, note: 'Sprawa na danych demonstracyjnych — prawdziwe rejestry nie są pytane.' });
      if (!live) return reply.code(201).send({ decision, expansion: null, note: 'Rozwinięcie wymaga włączenia źródeł publicznych (ENABLE_LIVE) — zapisano samą decyzję.' });

      busy.add(caseSummary.id);
      try {
        const startedAt = now().toISOString();
        const expansionId = randomUUID();
        const client = createWikidataClient({ ...(deps.fetch ? { fetch: deps.fetch } : {}), now, log: (message) => app.log.info({ caseId: caseSummary.id }, message) });
        const depth = PUBLIC_FIGURE_LIMITS.depthConfirmed as 2;
        const label = figure.wikidataId === qid ? figure.label : figure.candidates?.find((item) => item.wikidataId === qid)?.label;
        const result = await buildPublicFigureNetwork({
          wikidataId: qid,
          ...(label ? { label } : {}),
          depth,
          client,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          log: (message) => app.log.info({ caseId: caseSummary.id }, message),
        });
        // Węzły i relacje w tych samych kluczach co graf teczki — rozwinięcie dopina się do węzła osoby publicznej.
        const anchor = publicFigureNodeId(qid);
        const figureGraph = publicFigureGraph({ ...figure, wikidataId: qid, label: label ?? qid, url: `https://www.wikidata.org/wiki/${qid}`, status: 'confirmed', cryptoAddresses: result.cryptoAddresses }, 'subject');
        const orgGraph = organizationGraph([], result.network, { nodes: figureGraph.nodes as GraphNode[] });
        const nodes: NetworkNode[] = [...(figureGraph.nodes as GraphNode[]), ...orgGraph.nodes].map((node) =>
          node.id === anchor ? { ...node, depth: 0, known: true } : { ...node, depth: 1, expansionId, entityKind: node.kind === 'organization' ? 'organization' : node.kind === 'address' ? 'crypto_address' : 'person' },
        );
        const edges: NetworkEdge[] = [...orgGraph.edges, ...(figureGraph.edges as GraphEdge[]).filter((edge) => edge.from !== 'subject')].map((edge) => ({ ...edge, expansionId, expander: 'osoba-publiczna' }));
        const counts = networkCounts(result.network);
        const record: ExpansionRecord = {
          id: expansionId,
          caseId: caseSummary.id,
          nodeId: anchor,
          relations: ['organizations'],
          depth,
          // Zapytania dopasowania i etapu sieci organizacji (udane — po liczbie źródeł; nieudane — z licznika klienta).
          budget: { limit: PUBLIC_FIGURE_LIMITS.maxRequests, used: Math.max(client.requests, result.network.sources.length) },
          startedAt,
          finishedAt: now().toISOString(),
          requestedBy: AUTHOR,
          results: {
            nodes,
            edges,
            runs: [
              {
                expander: 'osoba-publiczna',
                label: 'Osoba publiczna → organizacje i role (Wikidata) → osoby w rolach i podmioty powiązane',
                entity: anchor,
                provider: 'Wikidata (+ GLEIF) przez moduł sieci organizacji',
                legalBasis: LEGAL.registries,
                requests: Math.max(client.requests, result.network.sources.length),
                nodes: nodes.length - 1,
                edges: edges.length,
                hop: 1,
              },
            ],
            organizationNetwork: result.network,
            publicFigure: { wikidataId: qid, depth, roles: result.roles, cryptoAddresses: result.cryptoAddresses },
          },
          stops: result.network.stops.map((stop) => ({ reason: STOP_REASON[stop.reason] ?? 'no_results', detail: stop.detail, expander: 'osoba-publiczna', ...(stop.skipped ? { skipped: stop.skipped } : {}) })),
          sourceErrors: client.failures.slice(0, 3).map((message) => ({ source: 'Wikidata', expander: 'osoba-publiczna', message })),
          runId: run.id,
        };
        await storage.addNetworkExpansion(record);
        context.invalidateDossiers();
        return reply.code(201).send({ decision, expansion: { id: record.id, counts, stops: record.stops, sourceErrors: record.sourceErrors }, note: `Siatka: ${counts.organizations} organizacji, ${counts.persons} osób, ${counts.relations} relacji.` });
      } finally {
        busy.delete(caseSummary.id);
      }
    },
  );
}
