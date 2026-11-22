// Trasy rozwijania sieci na żądanie:
//   GET    /api/cases/:id/network                 — sieć sprawy (teczka + rozwinięcia) i historia rozwinięć,
//   GET    /api/cases/:id/network/plan?nodeId=…   — dostępne drogi rozwinięcia węzła, koszt i podstawa prawna,
//   POST   /api/cases/:id/network/expand          — rozwiń węzeł (jeden krok; więcej tylko jawnie, z limitem),
//   DELETE /api/cases/:id/network/expand/:eid     — wycofaj rozwinięcie (wpis zostaje w audycie),
//   GET    /api/cases/:id/network/progress        — postęp trwającego „Szukaj dalej” (obieg środków).
//
// „Szukaj dalej” = POST …/expand z `relations: ['roundtrip']` i opcjonalnym `roundtrip: { maxHops, budget, windowDays }`.

import { randomUUID } from 'node:crypto';
import type { RoundTripProgress } from '@olcys/chain';
import type { FastifyInstance } from 'fastify';
import type { AnalysisRun, ChainProvider } from '@olcys/core';
import { createGithubSocialProvider } from '@olcys/sources';
import type { SocialGraphProvider } from '@olcys/sources';
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
  /** Dostawcy relacji kont w serwisach z kodem (grupa `social`); domyślnie GitHub REST API przy `live`, `null` wyłącza. */
  social?: SocialGraphProvider[] | null;
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
  /** Postęp ostatniego „Szukaj dalej” w sprawie (w pamięci procesu; po zakończeniu zostaje do odczytu). */
  const progress = new Map<string, RoundTripProgress & { nodeId: string; startedAt: string; finished: boolean }>();
  const sandboxBase = deps.sandboxUrl?.replace(/\/+$/, '');
  // Relacje kont w serwisach z kodem: domyślnie GitHub REST API; token GITHUB_TOKEN odczytywany przy każdym żądaniu.
  const social: SocialGraphProvider[] =
    config.social === undefined
      ? live
        ? [createGithubSocialProvider({ ...(deps.fetch ? { fetcher: deps.fetch } : {}), token: () => process.env.GITHUB_TOKEN })]
        : []
      : (config.social ?? []);

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
      social,
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
      // Obieg środków ma osobny przycisk „Szukaj dalej” z parametrami — nie jest polem wyboru zwykłego „Rozwiń”.
      const groups = RELATION_GROUPS.filter((group) => group.id !== 'roundtrip' && items.some((item) => item.group === group.id)).map((group) => {
        const own = items.filter((item) => item.group === group.id);
        return { ...group, cost: own.filter((item) => item.available && !item.done).reduce((total, item) => total + item.cost, 0), available: own.some((item) => item.available), done: own.every((item) => item.done) };
      });
      const roundtripItem = items.find((item) => item.group === 'roundtrip');
      const roundtrip = roundtripItem ? { available: roundtripItem.available, ...(roundtripItem.reason ? { reason: roundtripItem.reason } : {}), limits: NETWORK_LIMITS.roundtrip } : undefined;
      return { nodeId: node.id, entity: { kind: entity.kind, label: entity.label, ...(entity.identifierKind ? { identifierKind: entity.identifierKind } : {}) }, expandable: true, items, groups, limits: NETWORK_LIMITS, live, ...(roundtrip ? { roundtrip } : {}) };
    },
  );

  app.get<{ Params: { id: string } }>('/api/cases/:id/network/progress', { schema: { params: idParams } }, async (request) => {
    const caseId = request.params.id;
    return { running: busy.has(caseId), roundtrip: progress.get(caseId) ?? null };
  });

  const RT = NETWORK_LIMITS.roundtrip;
  app.post<{ Params: { id: string }; Body: { nodeId: string; relations?: RelationGroup[]; depth?: number; budget?: number; force?: boolean; roundtrip?: { maxHops?: number; budget?: number; windowDays?: number } } }>(
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
            // Ponad `maxBudget` tylko dla obiegu środków (silnik przycina pozostałe grupy do `maxBudget`).
            budget: { type: 'integer', minimum: 1, maximum: RT.maxBudget },
            force: { type: 'boolean' },
            roundtrip: {
              type: 'object',
              additionalProperties: false,
              properties: {
                maxHops: { type: 'integer', minimum: 2, maximum: RT.maxHops },
                budget: { type: 'integer', minimum: 1, maximum: RT.maxBudget },
                windowDays: { type: 'integer', minimum: 1, maximum: RT.maxWindowDays },
              },
            },
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
        const groups = [...new Set(request.body.relations ?? [])];
        const roundtrip = groups.includes('roundtrip');
        const rt = request.body.roundtrip ?? {};
        // „Szukaj dalej”: budżet = pobrania adresów pośrednich (+1 na sam adres, gdy nie ma go w teczce).
        const budget = roundtrip ? (rt.budget ?? request.body.budget ?? RT.defaultBudget) + 1 : (request.body.budget ?? NETWORK_LIMITS.defaultBudget);
        const base = await expandContext(caseId, run, dossier);
        const startedAt = now().toISOString();
        if (roundtrip) progress.set(caseId, { nodeId: seed.id, startedAt, finished: false, addressesFetched: 0, deepestHop: 0, cyclesFound: 0, queued: 0 });
        const record = await runExpansion({
          id: randomUUID(),
          caseId,
          runId: run.id,
          seed,
          groups,
          depth: roundtrip ? 1 : (request.body.depth ?? 1),
          budget,
          ...(roundtrip ? { maxBudget: RT.maxBudget + 1 } : {}),
          ...(request.body.force ? { force: true } : {}),
          requestedBy: config.requestedBy ?? 'analityk',
          network: { nodes: merged.nodes, edges: merged.edges },
          previous: expansions,
          context: roundtrip
            ? {
                ...base,
                roundtrip: { ...(rt.maxHops ? { maxHops: rt.maxHops } : {}), budget: budget - 1, ...(rt.windowDays ? { windowDays: rt.windowDays } : {}) },
                onRoundTripProgress: (value) => progress.set(caseId, { ...value, nodeId: seed.id, startedAt, finished: false }),
              }
            : base,
          isSynthetic: isSynthetic(dossier),
        });
        if (roundtrip) {
          const last = progress.get(caseId);
          if (last) progress.set(caseId, { ...last, finished: true });
        }
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
      // Rozwinięcie osoby publicznej zasila teczkę (karta organizacji) — teczkę trzeba policzyć od nowa.
      context.invalidateDossiers();
      const record = (await storage.listNetworkExpansions(request.params.id)).find((item) => item.id === request.params.expansionId) as ExpansionRecord;
      return { withdrawn: true, expansion: record };
    },
  );
}
