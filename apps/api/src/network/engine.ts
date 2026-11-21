// Silnik rozwijania na żądanie: jeden węzeł → ekspandery wskazanych grup relacji → zapis rozwinięcia.
// Jeden krok domyślnie; więcej kroków tylko jawnie i z twardym limitem. Budżet zapytań na żądanie,
// pomijanie dróg już wykonanych (w tym żądaniu i we wcześniejszych, niewycofanych rozwinięciach),
// wynik uporządkowany deterministycznie — to samo rozwinięcie na tych samych danych daje ten sam zapis.

import { entityFromNode } from './entities.ts';
import { EXPANDERS } from './expanders.ts';
import type { ExpandContext, Expander } from './expander.ts';
import type { Entity, ExpanderRun, ExpansionRecord, ExpansionSourceError, ExpansionStop, NetworkEdge, NetworkNode, RelationGroup } from './types.ts';

export const NETWORK_LIMITS = {
  /** Domyślny i największy budżet zapytań jednego rozwinięcia. */
  defaultBudget: 20,
  maxBudget: 60,
  /** Największa liczba kroków rozwinięcia (głębokość > 1 tylko jawnie). */
  maxDepth: 3,
  /** Najwyżej tyle nowych bytów rozwijanych w kolejnym kroku. */
  frontier: 8,
  /** Najwyżej tyle nowych węzłów w jednym rozwinięciu. */
  maxNodes: 80,
} as const;

export interface ExpansionPlanItem {
  expander: string;
  label: string;
  group: RelationGroup;
  reads: string;
  provider: string;
  legalBasis: string;
  produces: string[];
  cost: number;
  available: boolean;
  reason?: string;
  /** Droga już wykonana dla tego węzła we wcześniejszym, niewycofanym rozwinięciu. */
  done?: boolean;
}

/** Plan rozwinięcia węzła: które drogi pasują, ile kosztują i czy są dostępne. */
export function planExpansion(entity: Entity, context: ExpandContext, previous: ExpansionRecord[] = [], expanders: Expander[] = EXPANDERS): ExpansionPlanItem[] {
  const done = doneKeys(previous);
  return expanders
    .filter((expander) => expander.applies(entity))
    .map((expander) => {
      const blocked = expander.unavailable?.(entity, context) ?? null;
      return {
        expander: expander.id,
        label: expander.label,
        group: expander.group,
        reads: expander.reads,
        provider: expander.provider,
        legalBasis: expander.legalBasis,
        produces: expander.produces,
        cost: blocked ? 0 : expander.cost(entity, context),
        available: blocked === null,
        ...(blocked ? { reason: blocked.detail } : {}),
        ...(done.has(`${expander.id}|${entity.key}`) ? { done: true } : {}),
      };
    });
}

const doneKeys = (previous: ExpansionRecord[]) =>
  new Set(previous.filter((record) => !record.withdrawnAt).flatMap((record) => record.results.runs.map((run) => `${run.expander}|${run.entity}`)));

export interface ExpansionParams {
  id: string;
  caseId: string;
  runId?: string;
  seed: NetworkNode;
  groups: RelationGroup[];
  depth: number;
  budget: number;
  /** Wykonaj ponownie drogi już wykonane we wcześniejszych rozwinięciach. */
  force?: boolean;
  requestedBy: string;
  /** Bieżąca sieć (teczka + niewycofane rozwinięcia) — do oznaczania znanych węzłów. */
  network: { nodes: NetworkNode[]; edges: NetworkEdge[] };
  previous: ExpansionRecord[];
  /** Kontekst bez budżetu i mapy węzłów — te zakłada silnik. */
  context: Omit<ExpandContext, 'reserve' | 'nodes'>;
  /** Czy byt pochodzi z danych demonstracyjnych (np. konto w serwisie piaskownicy). */
  isSynthetic?: (node: NetworkNode) => boolean;
  expanders?: Expander[];
}

export async function runExpansion(params: ExpansionParams): Promise<ExpansionRecord> {
  const startedAt = params.context.now().toISOString();
  const expanders = params.expanders ?? EXPANDERS;
  const depth = Math.max(1, Math.min(NETWORK_LIMITS.maxDepth, Math.floor(params.depth) || 1));
  const limit = Math.max(1, Math.min(NETWORK_LIMITS.maxBudget, Math.floor(params.budget) || NETWORK_LIMITS.defaultBudget));
  const groups = params.groups.length > 0 ? params.groups : (['accounts', 'flows', 'organizations', 'sanctions', 'publications'] as RelationGroup[]);
  let used = 0;
  const known = new Map(params.network.nodes.map((node) => [node.id, node]));
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();
  const runs: ExpanderRun[] = [];
  const stops: ExpansionStop[] = [];
  const sourceErrors: ExpansionSourceError[] = [];
  const done = params.force ? new Set<string>() : doneKeys(params.previous);
  const asked = new Set<string>();
  const context: ExpandContext = {
    ...params.context,
    nodes: new Map(known),
    reserve: () => {
      if (used >= limit) return false;
      used++;
      return true;
    },
  };
  const markSynthetic = (node: NetworkNode): NetworkNode => (params.isSynthetic?.(node) && !node.meta?.synthetic ? { ...node, meta: { ...(node.meta ?? {}), synthetic: true } } : node);

  // Węzeł wyjściowy jest kotwicą zapisu: rozwinięcie dopina się do niego także po ponownej analizie.
  nodes.set(params.seed.id, { ...params.seed, depth: params.seed.depth ?? 0, known: true });
  let frontier: { node: NetworkNode; hop: number }[] = [{ node: markSynthetic(params.seed), hop: 1 }];
  let budgetStopped = 0;
  let nodeLimitHit = false;

  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: NetworkNode[] = [];
    for (const { node } of frontier) {
      const entity = entityFromNode(node, params.context.profiles);
      if (!entity) {
        stops.push({ reason: 'not_applicable', detail: `Węzła „${node.label}” (${node.kind}) nie da się rozwijać — to hipoteza narzędzia, nie byt ze źródła.` });
        continue;
      }
      for (const expander of expanders) {
        if (!groups.includes(expander.group) || !expander.applies(entity)) continue;
        const key = `${expander.id}|${entity.key}`;
        if (asked.has(key)) continue;
        asked.add(key);
        if (done.has(key)) {
          stops.push({ reason: 'duplicate', expander: expander.id, detail: `„${expander.label}” dla „${entity.label}” wykonano już we wcześniejszym rozwinięciu — pominięto (wynik jest w sieci).` });
          continue;
        }
        const blocked = expander.unavailable?.(entity, context);
        if (blocked) {
          stops.push({ ...blocked, expander: expander.id });
          continue;
        }
        const cost = expander.cost(entity, context);
        if (cost > 0 && used >= limit) {
          budgetStopped++;
          stops.push({ reason: 'budget', expander: expander.id, detail: `Budżet ${limit} zapytań wyczerpany — „${expander.label}” dla „${entity.label}” nie wykonano.`, skipped: 1 });
          continue;
        }
        let output;
        try {
          output = await expander.run(entity, context);
        } catch (error) {
          sourceErrors.push({ source: expander.provider, expander: expander.id, message: error instanceof Error ? error.message : String(error) });
          continue;
        }
        sourceErrors.push(...(output.errors ?? []));
        stops.push(...(output.notes ?? []));
        let added = 0;
        for (const raw of output.nodes) {
          const produced = markSynthetic(raw);
          if (nodes.has(produced.id)) continue;
          const existing = known.get(produced.id);
          if (!existing && nodes.size >= NETWORK_LIMITS.maxNodes) {
            nodeLimitHit = true;
            continue;
          }
          const stored: NetworkNode = existing ? { ...produced, ...existing, known: true, depth: existing.depth ?? 0, meta: { ...(produced.meta ?? {}), ...(existing.meta ?? {}) } } : { ...produced, depth: hop, expansionId: params.id };
          nodes.set(produced.id, stored);
          context.nodes.set(produced.id, stored);
          if (!existing) added++;
          // Byt już znany (teczka, wcześniejsze rozwinięcie) też jest rozwijany w kolejnym kroku — powtórzeń pilnuje `done`.
          next.push(stored);
        }
        let edgeCount = 0;
        for (const edge of output.edges) {
          if (edges.has(edge.id) || !(nodes.has(edge.from) || known.has(edge.from)) || !(nodes.has(edge.to) || known.has(edge.to))) continue;
          edges.set(edge.id, { ...edge, expansionId: params.id });
          edgeCount++;
        }
        runs.push({ expander: expander.id, label: expander.label, entity: entity.key, provider: expander.provider, legalBasis: expander.legalBasis, requests: output.requests, nodes: added, edges: edgeCount, hop });
      }
    }
    if (hop === depth && next.length > 0) {
      stops.push({ reason: 'depth_limit', detail: `Osiągnięto wskazaną głębokość (${depth} ${depth === 1 ? 'krok' : 'kroki'}) — nowych bytów (${next.length}) nie rozwijano dalej. Każdy z nich można rozwinąć osobno.`, skipped: next.length });
    }
    const ordered = next.sort((a, b) => a.id.localeCompare(b.id));
    if (hop < depth && ordered.length > NETWORK_LIMITS.frontier) {
      stops.push({ reason: 'node_limit', detail: `Krok ${hop + 1}: rozwinięto ${NETWORK_LIMITS.frontier} z ${ordered.length} nowych bytów (limit na krok).`, skipped: ordered.length - NETWORK_LIMITS.frontier });
    }
    frontier = ordered.slice(0, NETWORK_LIMITS.frontier).map((node) => ({ node, hop: hop + 1 }));
  }
  if (nodeLimitHit) stops.push({ reason: 'node_limit', detail: `Limit ${NETWORK_LIMITS.maxNodes} nowych węzłów w jednym rozwinięciu — pozostałe pominięto.` });
  if (budgetStopped > 1) stops.push({ reason: 'budget', detail: `Łącznie pominięto ${budgetStopped} dróg z powodu budżetu (${limit} zapytań). Zwiększ budżet albo rozwiń węzły osobno.`, skipped: budgetStopped });

  const sortedNodes = [...nodes.values()].sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.id.localeCompare(b.id));
  const sortedEdges = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));
  return {
    id: params.id,
    caseId: params.caseId,
    nodeId: params.seed.id,
    relations: params.groups,
    depth,
    budget: { limit, used },
    startedAt,
    finishedAt: params.context.now().toISOString(),
    requestedBy: params.requestedBy,
    results: { nodes: sortedNodes, edges: sortedEdges, runs },
    stops: dedupeStops(stops),
    sourceErrors,
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

function dedupeStops(stops: ExpansionStop[]): ExpansionStop[] {
  const seen = new Set<string>();
  return stops.filter((stop) => {
    const key = `${stop.reason}|${stop.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
