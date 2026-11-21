// Logika grafu śledczego — czyste funkcje bez DOM: statusy relacji, filtry widoku,
// zwijanie gałęzi i wyszukiwanie ścieżki dowodowej.
import type { ClaimStatus, GraphEdge, GraphNode, GraphNodeKind, OperatorHypothesis } from '@olcys/core';

export type GraphLayer = 'identity' | 'chain';
export type LayerView = GraphLayer | 'both';

const STATUSES: ClaimStatus[] = ['source_fact', 'computed', 'hypothesis', 'confirmed', 'rejected'];
const isStatus = (value: unknown): value is ClaimStatus => STATUSES.includes(value as ClaimStatus);

/**
 * Status relacji. Starsze teczki mają tylko `inferred`: wnioskowanie narzędzia to hipoteza,
 * reszta to fakt ze źródła. Nieznana wartość statusu (nowsza usługa) jest traktowana ostrożnie — jak hipoteza.
 */
export function edgeStatus(edge: Pick<GraphEdge, 'status' | 'inferred'>): ClaimStatus {
  if (edge.status !== undefined) return isStatus(edge.status) ? edge.status : 'hypothesis';
  return edge.inferred ? 'hypothesis' : 'source_fact';
}

/** Warstwa relacji: przepływy blockchain rysujemy osobno od powiązań tożsamości. */
export function edgeLayer(edge: Pick<GraphEdge, 'layer' | 'kind'>): GraphLayer {
  if (edge.layer === 'chain' || edge.layer === 'identity') return edge.layer;
  return edge.kind === 'transfer' || edge.kind === 'cash_out' ? 'chain' : 'identity';
}

const HYPOTHESIS_BY_DEFAULT: GraphNodeKind[] = ['operator', 'person'];

/**
 * Status węzła-hipotezy. Operator i osoba powiązana bez jawnego statusu to zawsze hipoteza:
 * nic nie może wyglądać na ustaloną tożsamość, dopóki analityk tego nie potwierdzi.
 */
export function nodeStatus(node: Pick<GraphNode, 'kind' | 'status'>): ClaimStatus | undefined {
  if (node.status !== undefined) return isStatus(node.status) ? node.status : 'hypothesis';
  return HYPOTHESIS_BY_DEFAULT.includes(node.kind) ? 'hypothesis' : undefined;
}

// ---------- Filtry widoku ----------

export interface ViewFilter {
  statuses: ReadonlySet<ClaimStatus>;
  kinds: ReadonlySet<GraphNodeKind>;
  /** Najmniejszy wynik węzła i najmniejsza waga relacji (0 = bez ograniczenia). Elementy bez liczby zostają. */
  minScore: number;
  layer: LayerView;
}

interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Usuwa krawędzie bez obu końców i węzły (poza podmiotem), które straciły wszystkie połączenia. */
function prune(nodes: GraphNode[], edges: GraphEdge[], keepIsolated: (node: GraphNode) => boolean): Graph {
  let keptNodes = nodes;
  let keptEdges = edges;
  for (;;) {
    const ids = new Set(keptNodes.map((node) => node.id));
    keptEdges = keptEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const connected = new Set(keptEdges.flatMap((edge) => [edge.from, edge.to]));
    const next = keptNodes.filter((node) => keepIsolated(node) || connected.has(node.id));
    if (next.length === keptNodes.length) return { nodes: keptNodes, edges: keptEdges };
    keptNodes = next;
  }
}

/**
 * Filtry grafu: status relacji, rodzaj węzła, minimalny wynik/waga i warstwa.
 * Warstwa „Przepływy blockchain” zostawia wyłącznie relacje łańcuchowe i ich końce (portfele, usługi).
 */
export function applyView(nodes: GraphNode[], edges: GraphEdge[], filter: ViewFilter): Graph {
  const chainOnly = filter.layer === 'chain';
  const keptEdges = edges.filter(
    (edge) =>
      filter.statuses.has(edgeStatus(edge)) &&
      (filter.layer === 'both' || edgeLayer(edge) === filter.layer) &&
      !(edge.weight !== undefined && edge.weight < filter.minScore),
  );
  const keptNodes = nodes.filter(
    (node) =>
      (node.kind === 'subject' && !chainOnly) ||
      (filter.kinds.has(node.kind) && !(node.score !== undefined && node.score < filter.minScore)),
  );
  return prune(keptNodes, keptEdges, (node) => node.kind === 'subject' && !chainOnly);
}

// ---------- Zwijanie gałęzi ----------

/** Węzeł nadrzędny źródła: `parent`, a gdy go brak — drugi koniec relacji „udokumentowane w źródle”. */
export function sourceParents(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string> {
  const kinds = new Map(nodes.map((node) => [node.id, node.kind]));
  const result = new Map<string, string>();
  for (const node of nodes) if (node.kind === 'source' && node.parent && kinds.has(node.parent)) result.set(node.id, node.parent);
  for (const edge of edges) {
    for (const [source, other] of [
      [edge.to, edge.from],
      [edge.from, edge.to],
    ] as const) {
      if (kinds.get(source) === 'source' && kinds.has(other) && kinds.get(other) !== 'source' && !result.has(source)) result.set(source, other);
    }
  }
  return result;
}

/** Liczba źródeł schowanych za każdym węzłem — do znaczka z licznikiem. */
export function sourceCounts(nodes: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const parent of sourceParents(nodes, edges).values()) counts.set(parent, (counts.get(parent) ?? 0) + 1);
  return counts;
}

/**
 * Dzieci węzłów do zwijania: gdy węzeł ma `parent`, należy do tego rodzica; w przeciwnym razie
 * jest dzieckiem każdego węzła, z którego wychodzi do niego relacja. Podmiot nigdy nie jest dzieckiem.
 */
export function childMap(nodes: GraphNode[], edges: GraphEdge[]): Map<string, string[]> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, Set<string>>();
  const add = (parent: string, child: string) => {
    if (parent === child || !byId.has(parent) || byId.get(child)?.kind === 'subject') return;
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)!.add(child);
  };
  for (const node of nodes) if (node.parent) add(node.parent, node.id);
  for (const edge of edges) {
    const target = byId.get(edge.to);
    if (target && !(target.parent && byId.has(target.parent))) add(edge.from, edge.to);
  }
  return new Map([...children].map(([parent, set]) => [parent, [...set]]));
}

function descendants(children: Map<string, string[]>, start: string, stopAt?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current !== start && stopAt?.has(current)) continue;
    for (const child of children.get(current) ?? []) {
      if (child === start || seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return seen;
}

export interface CollapseState {
  /** Węzły ze zwiniętą gałęzią. */
  collapsed: ReadonlySet<string>;
  /** Węzły, których źródła dowodowe są rozwinięte (domyślnie źródła są schowane za licznikiem). */
  sourcesShown: ReadonlySet<string>;
}

/**
 * Węzły ukryte przez zwinięcie. Potomek zwiniętego węzła zostaje widoczny, jeśli prowadzi do niego
 * także droga omijająca zwinięte gałęzie (np. adres publikowany przez dwa konta, z których zwinięto jedno).
 */
export function hiddenByCollapse(nodes: GraphNode[], edges: GraphEdge[], state: CollapseState): Set<string> {
  const hidden = new Set<string>();
  const parents = sourceParents(nodes, edges);
  for (const [source, parent] of parents) if (!state.sourcesShown.has(parent)) hidden.add(source);

  const collapsed = [...state.collapsed].filter((id) => nodes.some((node) => node.id === id));
  if (collapsed.length === 0) return hidden;
  const children = childMap(nodes, edges);
  const below = new Set<string>();
  for (const id of collapsed) for (const child of descendants(children, id)) below.add(child);

  // Osiągalne bez przechodzenia przez zwinięte węzły: od korzeni (węzłów, które nie są niczyim dzieckiem).
  const isChild = new Set([...children.values()].flat());
  const reachable = new Set<string>();
  const stop = new Set(collapsed);
  for (const node of nodes) {
    if (isChild.has(node.id) && node.kind !== 'subject') continue;
    reachable.add(node.id);
    if (stop.has(node.id)) continue;
    for (const child of descendants(children, node.id, stop)) reachable.add(child);
  }
  for (const id of below) if (!reachable.has(id)) hidden.add(id);
  return hidden;
}

/** Graf po zwinięciu gałęzi oraz liczba węzłów schowanych za każdym zwiniętym węzłem. */
export function collapseGraph(nodes: GraphNode[], edges: GraphEdge[], state: CollapseState): Graph & { hiddenCount: Map<string, number> } {
  const hidden = hiddenByCollapse(nodes, edges, state);
  const children = childMap(nodes, edges);
  const hiddenCount = new Map<string, number>();
  for (const id of state.collapsed) {
    const count = [...descendants(children, id)].filter((child) => hidden.has(child)).length;
    if (count > 0) hiddenCount.set(id, count);
  }
  return {
    nodes: nodes.filter((node) => !hidden.has(node.id)),
    edges: edges.filter((edge) => !hidden.has(edge.from) && !hidden.has(edge.to)),
    hiddenCount,
  };
}

/** Przełącza obecność wartości w zbiorze, nie zmieniając oryginału. */
export function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

// ---------- Ścieżka dowodowa ----------

/**
 * Koszt przejścia relacją: fakty i potwierdzenia są najtańsze, hipotezy drogie, więc ścieżka
 * wybiera hipotezę tylko wtedy, gdy nie ma drogi po faktach. Relacje odrzucone nie należą do ścieżki.
 */
export const PATH_COST: Record<ClaimStatus, number> = {
  source_fact: 1,
  confirmed: 1,
  computed: 1.5,
  hypothesis: 6,
  rejected: Infinity,
};

export interface EvidencePathStep {
  edge: GraphEdge;
  from: string;
  to: string;
  status: ClaimStatus;
  /** Czy krok idzie zgodnie z kierunkiem relacji. */
  forward: boolean;
}

export interface EvidencePath {
  nodes: string[];
  steps: EvidencePathStep[];
  /** Liczba kroków opartych na hipotezie — ścieżka z hipotezą nie jest dowodem. */
  hypotheses: number;
}

/** Najtańsza ścieżka między dwoma węzłami (Dijkstra, relacje traktowane jako nieskierowane); `null`, gdy jej nie ma. */
export function findEvidencePath(edges: GraphEdge[], from: string, to: string): EvidencePath | null {
  if (from === to) return { nodes: [from], steps: [], hypotheses: 0 };
  const around = new Map<string, { edge: GraphEdge; other: string; forward: boolean }[]>();
  const link = (id: string, item: { edge: GraphEdge; other: string; forward: boolean }) => {
    if (!around.has(id)) around.set(id, []);
    around.get(id)!.push(item);
  };
  for (const edge of edges) {
    if (edge.from === edge.to || PATH_COST[edgeStatus(edge)] === Infinity) continue;
    link(edge.from, { edge, other: edge.to, forward: true });
    link(edge.to, { edge, other: edge.from, forward: false });
  }
  const distance = new Map<string, number>([[from, 0]]);
  const previous = new Map<string, EvidencePathStep>();
  const done = new Set<string>();
  for (;;) {
    let current: string | undefined;
    for (const [id, value] of distance) if (!done.has(id) && (current === undefined || value < distance.get(current)!)) current = id;
    if (current === undefined) return null;
    if (current === to) break;
    done.add(current);
    for (const { edge, other, forward } of around.get(current) ?? []) {
      const status = edgeStatus(edge);
      const next = distance.get(current)! + PATH_COST[status];
      if (next < (distance.get(other) ?? Infinity)) {
        distance.set(other, next);
        previous.set(other, { edge, from: current, to: other, status, forward });
      }
    }
  }
  const steps: EvidencePathStep[] = [];
  for (let at = to; at !== from; ) {
    const step = previous.get(at)!;
    steps.unshift(step);
    at = step.from;
  }
  return { nodes: [from, ...steps.map((step) => step.to)], steps, hypotheses: steps.filter((step) => step.status === 'hypothesis').length };
}

// ---------- Powiązanie krawędzi z hipotezą wspólnego operatora ----------

/** Hipoteza (wskaźnik B) opisująca krawędź `same_operator`: po identyfikatorze albo po parze kont na końcach. */
export function hypothesisForEdge(edge: GraphEdge, hypotheses: OperatorHypothesis[]): OperatorHypothesis | undefined {
  const id = edge.id.toLowerCase();
  const ends = [edge.from.toLowerCase(), edge.to.toLowerCase()];
  const refs = new Set((edge.evidence ?? []).map((item) => item.value.toLowerCase()));
  return (
    hypotheses.find((item) => id === item.id.toLowerCase() || id.endsWith(item.id.toLowerCase()) || refs.has(item.id.toLowerCase())) ??
    hypotheses.find((item) => {
      const [a, b] = item.accounts.map((account) => account.toLowerCase());
      const matches = (end: string, account: string | undefined) => account !== undefined && (end === account || end.endsWith(`:${account}`) || end.endsWith(account));
      return (matches(ends[0]!, a) && matches(ends[1]!, b)) || (matches(ends[0]!, b) && matches(ends[1]!, a));
    })
  );
}

/** Klucz decyzji `link` dla pary kont — taki sam jak `linkKey` w `@olcys/core` (niezależny od kolejności). */
export const linkKeyOf = (a: string, b: string): string => [a.trim().toLowerCase(), b.trim().toLowerCase()].sort().join('<->');
