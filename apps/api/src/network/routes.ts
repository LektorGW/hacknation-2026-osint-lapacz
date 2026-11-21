// Trasy rozwijania sieci na żądanie:
//   GET    /api/cases/:id/network                 — sieć sprawy (teczka + rozwinięcia) i historia rozwinięć,
//   GET    /api/cases/:id/network/plan?nodeId=…   — dostępne drogi rozwinięcia węzła, koszt i podstawa prawna,
//   POST   /api/cases/:id/network/expand          — rozwiń węzeł (jeden krok; więcej tylko jawnie, z limitem),
//   DELETE /api/cases/:id/network/expand/:eid     — wycofaj rozwinięcie (wpis zostaje w audycie).

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AnalysisRun, ChainProvider } from '@olcys/core';
import type { CapturedDocument } from '../analysis.ts';
import { HttpError, idParams } from '../http-common.ts';
import type { RouteContext } from '../http-common.ts';
import { entityFromNode } from './entities.ts';
import { NETWORK_LIMITS, planExpansion, runExpansion } from './engine.ts';
import type { ExpandContext } from './expander.ts';
import { isSyntheticConnector } from './expander.ts';
import { mergeNetwork } from './merge.ts';
import { createRegistryOrganizationProvider } from './organizations.ts';
import type { OrganizationProvider } from './organizations.ts';
import { createRdapClient } from './rdap.ts';
import type { RdapClient } from './rdap.ts';
import { createOfacProvider, createSandboxSanctionsProvider, discoverSanctionsModules } from './sanctions.ts';
import type { SanctionsProvider } from './sanctions.ts';
import { RELATION_GROUPS } from './types.ts';
import type { ExpansionRecord, NetworkNode, RelationGroup } from './types.ts';

/** Konfiguracja rozwijania (opcjonalna; bez niej — z łączników i zmiennych środowiskowych usługi). */
export interface NetworkDeps {
  /** Czy wolno pytać źródła poza systemem; domyślnie: gdy zarejestrowano łączniki `live-*` (ENABLE_LIVE). */
  live?: boolean;
  rdap?: RdapClient | null;
  organizations?: OrganizationProvider | null;
  sanctions?: SanctionsProvider[];
  /** Kto wykonuje rozwinięcie (narzędzie nie ma kont użytkowników). */
  requestedBy?: string;
}

const GROUP_IDS = RELATION_GROUPS.map((group) => group.id);

export function registerNetworkRoutes(app: FastifyInstance, context: RouteContext): void {
  const { storage, deps, now } = context;
  const config = (deps as { network?: NetworkDeps }).network ?? {};
  const live = config.live ?? context.connectors.some((connector) => connector.id.startsWith('live-'));
  const chainProviders: ChainProvider[] = deps.chainProviders;
  const busy = new Set<string>();
  const sandboxBase = deps.sandboxUrl?.replace(/\/+$/, '');

  // Dostawcy tworzeni raz, leniwie — moduły drugiego zespołu mogą pojawić się po starcie testów.
  let providers: Promise<{ rdap?: RdapClient; organizations?: OrganizationProvider; sanctions: SanctionsProvider[] }> | undefined;
  const loadProviders = () =>
    (providers ??= (async () => {
      const rdap = config.rdap === undefined ? (live ? createRdapClient({ ...(deps.fetch ? { fetch: deps.fetch } : {}), now }) : undefined) : (config.rdap ?? undefined);
      const organizations = config.organizations === undefined ? ((await createRegistryOrganizationProvider({ ...(deps.fetch ? { fetch: deps.fetch } : {}), now })) ?? undefined) : (config.organizations ?? undefined);
      // Moduł oficjalnych list ryzyka (zawiera też adresy OFAC SDN) zastępuje samą kopię adresów OFAC — bez podwójnych trafień.
      const modules = config.sanctions ? [] : await discoverSanctionsModules();
      const sanctions =
        config.sanctions ??
        [
          ...(modules.length > 0 ? modules : [await createOfacProvider()]),
          ...(deps.sandboxUrl ? [createSandboxSanctionsProvider(deps.sandboxUrl, deps.fetch ?? globalThis.fetch)] : []),
        ].filter((item): item is SanctionsProvider => item !== null);
      return { ...(rdap ? { rdap } : {}), ...(organizations ? { organizations } : {}), sanctions };
    })());

  /** Ostatnia zakończona analiza sprawy — podstawa sieci. */
  const latestRun = async (caseId: string): Promise<AnalysisRun> => {
    const caseSummary = await context.requireCase(caseId);
    const last = caseSummary.runs.filter((run) => run.status === 'completed').at(-1);
    if (!last) throw new HttpError(409, 'Sprawa nie ma zakończonej analizy — najpierw wykonaj analizę, potem rozwijaj sieć.');
    return context.requireRun(last.id);
  };

  const networkOf = async (caseId: string) => {
    const run = await latestRun(caseId);
    const dossier = await context.loadDossier(run);
    const expansions = await storage.listNetworkExpansions(caseId);
    return { run, dossier, expansions, merged: mergeNetwork(dossier.graph, expansions) };
  };

  const expandContext = async (caseId: string, run: AnalysisRun, dossier: Awaited<ReturnType<typeof networkOf>>['dossier']): Promise<Omit<ExpandContext, 'reserve' | 'nodes'>> => {
    const loaded = await loadProviders();
    const used = new Set(run.connectors);
    const connectors = context.connectors.filter((connector) => used.has(connector.id) && !connector.id.startsWith('mon-'));
    let documents: Promise<CapturedDocument[]> | undefined;
    return {
      caseId,
      connectors,
      chainProviders,
      ...(deps.resolveActivity ? { resolveActivity: deps.resolveActivity } : {}),
      findings: dossier.findings as unknown as ExpandContext['findings'],
      profiles: dossier.profiles,
      documents: () => (documents ??= storage.listDocuments(run.id)),
      corpusPhrase: (phrase, limit) => storage.searchCorpus({ phrase }, limit),
      corpusDocument: (url) => storage.getCorpusDocument(url),
      live,
      ...(loaded.rdap ? { rdap: loaded.rdap } : {}),
      ...(loaded.organizations ? { organizations: loaded.organizations } : {}),
      sanctions: loaded.sanctions,
      // Sprawa wyłącznie na danych demonstracyjnych: żadna droga nie wychodzi do prawdziwych rejestrów.
      synthetic: run.connectors.length > 0 && run.connectors.every((id) => isSyntheticConnector(id) || id === 'corpus'),
      now,
      log: (message) => app.log.info({ caseId }, `[rozwijanie] ${message}`),
    };
  };

  /** Byt z danych demonstracyjnych: konto w serwisie piaskownicy, strona piaskownicy, adres znaleziony tylko w piaskownicy. */
  const isSynthetic = (dossier: Awaited<ReturnType<typeof networkOf>>['dossier']) => (node: NetworkNode): boolean => {
    if (node.meta?.synthetic) return true;
    if (sandboxBase && node.url?.startsWith(sandboxBase)) return true;
    if (/^profile:[^|]+\.sandbox\|/.test(node.id) || /^profile:lab-/.test(node.id)) return true;
    const finding = node.kind === 'address' ? dossier.findings.find((item) => node.id === `addr:${item.network}:${item.address}`) : undefined;
    return Boolean(finding && finding.evidence.length > 0 && finding.evidence.every((item) => isSyntheticConnector(item.connectorId)));
  };

  app.get<{ Params: { id: string } }>('/api/cases/:id/network', { schema: { params: idParams } }, async (request) => {
    const { run, expansions, merged } = await networkOf(request.params.id);
    return {
      caseId: request.params.id,
      runId: run.id,
      generatedAt: now().toISOString(),
      graph: { nodes: merged.nodes, edges: merged.edges },
      depthCounts: merged.depthCounts,
      sanctioned: merged.sanctioned,
      orphanAnchors: merged.orphanAnchors,
      expansions,
      groups: RELATION_GROUPS,
      limits: NETWORK_LIMITS,
      live,
    };
  });

  app.get<{ Params: { id: string }; Querystring: { nodeId: string } }>(
    '/api/cases/:id/network/plan',
    { schema: { params: idParams, querystring: { type: 'object', required: ['nodeId'], properties: { nodeId: { type: 'string', minLength: 1, maxLength: 1000 } } } } },
    async (request) => {
      const { run, dossier, expansions, merged } = await networkOf(request.params.id);
      const node = merged.nodes.find((item) => item.id === request.query.nodeId);
      if (!node) throw new HttpError(404, 'Nie ma takiego węzła w sieci sprawy.');
      const marked = isSynthetic(dossier)(node) ? { ...node, meta: { ...(node.meta ?? {}), synthetic: true } } : node;
      const entity = entityFromNode(marked, dossier.profiles);
      if (!entity) return { nodeId: node.id, expandable: false, reason: 'Węzeł jest hipotezą narzędzia (np. operator) — rozwija się byty ze źródeł: konta, identyfikatory, adresy, organizacje, osoby, publikacje.', items: [], groups: [] };
      const ctx = { ...(await expandContext(request.params.id, run, dossier)), nodes: new Map(merged.nodes.map((item) => [item.id, item])), reserve: () => true };
      const items = planExpansion(entity, ctx, expansions);
      const groups = RELATION_GROUPS.filter((group) => items.some((item) => item.group === group.id)).map((group) => {
        const own = items.filter((item) => item.group === group.id);
        return { ...group, cost: own.filter((item) => item.available && !item.done).reduce((total, item) => total + item.cost, 0), available: own.some((item) => item.available), done: own.every((item) => item.done) };
      });
      return { nodeId: node.id, entity: { kind: entity.kind, label: entity.label, ...(entity.identifierKind ? { identifierKind: entity.identifierKind } : {}) }, expandable: true, items, groups, limits: NETWORK_LIMITS, live };
    },
  );

  app.post<{ Params: { id: string }; Body: { nodeId: string; relations?: RelationGroup[]; depth?: number; budget?: number; force?: boolean } }>(
    '/api/cases/:id/network/expand',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['nodeId'],
          additionalProperties: false,
          properties: {
            nodeId: { type: 'string', minLength: 1, maxLength: 1000 },
            relations: { type: 'array', maxItems: GROUP_IDS.length, items: { type: 'string', enum: GROUP_IDS } },
            depth: { type: 'integer', minimum: 1, maximum: NETWORK_LIMITS.maxDepth },
            budget: { type: 'integer', minimum: 1, maximum: NETWORK_LIMITS.maxBudget },
            force: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const caseId = request.params.id;
      if (busy.has(caseId)) throw new HttpError(409, 'W tej sprawie trwa już rozwijanie sieci — poczekaj na jego koniec.');
      busy.add(caseId);
      try {
        const { run, dossier, expansions, merged } = await networkOf(caseId);
        const seed = merged.nodes.find((node) => node.id === request.body.nodeId);
        if (!seed) throw new HttpError(404, 'Nie ma takiego węzła w sieci sprawy.');
        const record = await runExpansion({
          id: randomUUID(),
          caseId,
          runId: run.id,
          seed,
          groups: [...new Set(request.body.relations ?? [])],
          depth: request.body.depth ?? 1,
          budget: request.body.budget ?? NETWORK_LIMITS.defaultBudget,
          ...(request.body.force ? { force: true } : {}),
          requestedBy: config.requestedBy ?? 'analityk',
          network: { nodes: merged.nodes, edges: merged.edges },
          previous: expansions,
          context: await expandContext(caseId, run, dossier),
          isSynthetic: isSynthetic(dossier),
        });
        await storage.addNetworkExpansion(record);
        const fresh = record.results.nodes.filter((node) => !node.known).length;
        return reply.code(201).send({ expansion: record, added: { nodes: fresh, edges: record.results.edges.length } });
      } finally {
        busy.delete(caseId);
      }
    },
  );

  app.delete<{ Params: { id: string; expansionId: string } }>(
    '/api/cases/:id/network/expand/:expansionId',
    { schema: { params: { type: 'object', required: ['id', 'expansionId'], properties: { id: { type: 'string', minLength: 1, maxLength: 64 }, expansionId: { type: 'string', minLength: 1, maxLength: 64 } } } } },
    async (request) => {
      await context.requireCase(request.params.id);
      const withdrawn = await storage.withdrawNetworkExpansion(request.params.id, request.params.expansionId, { at: now().toISOString(), by: config.requestedBy ?? 'analityk' });
      if (!withdrawn) throw new HttpError(404, 'Nie ma takiego obowiązującego rozwinięcia w tej sprawie.');
      const record = (await storage.listNetworkExpansions(request.params.id)).find((item) => item.id === request.params.expansionId) as ExpansionRecord;
      return { withdrawn: true, expansion: record };
    },
  );
}
