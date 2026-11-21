// Rozwijanie sieci na żądanie — typy odpowiedzi usługi i czysta logika widoku (bez DOM):
// scalanie teczki z rozwinięciami, liczniki głębokości, nowe węzły, opis siły ścieżki i powiązania z podmiotem.
import type { ClaimStatus, GraphEdge, GraphNode } from '@olcys/core';
import { PATH_LEVEL_LABEL, describePath, linkToSubjectLabel, strongestPath } from '../../../../packages/core/src/network-path.ts';
import type { PathEdge, StrengthPath } from '../../../../packages/core/src/network-path.ts';
import type { EvidencePath } from './investigation.ts';

export type RelationGroup = 'accounts' | 'flows' | 'organizations' | 'sanctions' | 'publications';

export const RELATION_GROUP_LABEL: Record<RelationGroup, string> = {
  accounts: 'konta i identyfikatory',
  flows: 'adresy i przepływy',
  organizations: 'organizacje i role',
  sanctions: 'listy sankcyjne',
  publications: 'publikacje',
};

export const RELATION_GROUP_ORDER: RelationGroup[] = ['accounts', 'flows', 'organizations', 'sanctions', 'publications'];

export interface NodeLink {
  level: 'documented' | 'distant' | 'circumstantial' | 'none';
  label: string;
  summary: string;
  strength: number;
  hypotheses: number;
}

export interface NetworkNode extends GraphNode {
  expansionId?: string;
  depth?: number;
  known?: boolean;
  link?: NodeLink;
  meta?: { synthetic?: boolean; sanctioned?: { list: string; entryId: string; synthetic?: boolean } } & Record<string, unknown>;
}

export interface NetworkEdge extends GraphEdge {
  relation?: string;
  strength?: number;
  expansionId?: string;
  retrievedAt?: string;
  caveat?: string;
}

export interface ExpansionStop {
  reason: string;
  detail: string;
  expander?: string;
  skipped?: number;
}

export interface ExpanderRun {
  expander: string;
  label: string;
  entity: string;
  provider: string;
  legalBasis: string;
  requests: number;
  nodes: number;
  edges: number;
  hop: number;
}

export interface ExpansionRecord {
  id: string;
  caseId: string;
  nodeId: string;
  relations: RelationGroup[];
  depth: number;
  budget: { limit: number; used: number };
  startedAt: string;
  finishedAt: string;
  requestedBy: string;
  results: { nodes: NetworkNode[]; edges: NetworkEdge[]; runs: ExpanderRun[] };
  stops: ExpansionStop[];
  sourceErrors: { source: string; expander: string; message: string }[];
  runId?: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
}

export interface NetworkView {
  caseId: string;
  runId: string;
  generatedAt: string;
  graph: { nodes: NetworkNode[]; edges: NetworkEdge[] };
  depthCounts: Record<string, number>;
  sanctioned: string[];
  orphanAnchors?: string[];
  expansions: ExpansionRecord[];
  live?: boolean;
  /** Dane demonstracyjne (tryb demo) — wszystkie rozwinięcia są syntetyczne. */
  demo?: boolean;
}

export interface PlanItem {
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
  done?: boolean;
}

export interface NetworkPlan {
  nodeId: string;
  expandable: boolean;
  reason?: string;
  entity?: { kind: string; label: string };
  items: PlanItem[];
  groups: { id: RelationGroup; label: string; cost: number; available: boolean; done: boolean }[];
  limits?: { defaultBudget: number; maxBudget: number; maxDepth: number };
}

export interface ExpandRequest {
  nodeId: string;
  relations: RelationGroup[];
  depth: number;
  budget?: number;
  force?: boolean;
}

export interface ExpandResult {
  expansion: ExpansionRecord;
  added: { nodes: number; edges: number };
}

/** Graf do narysowania: sieć z usługi (teczka + rozwinięcia) albo sam graf teczki; opcjonalnie bez węzłów z rozwinięć. */
export function viewGraph(base: { nodes: GraphNode[]; edges: GraphEdge[] }, network: NetworkView | null, hideExpansions: boolean): { nodes: NetworkNode[]; edges: NetworkEdge[] } {
  if (!network) return base;
  if (!hideExpansions) return network.graph;
  const nodes = network.graph.nodes.filter((node) => !node.expansionId);
  const ids = new Set(nodes.map((node) => node.id));
  return { nodes, edges: network.graph.edges.filter((edge) => !edge.expansionId && ids.has(edge.from) && ids.has(edge.to)) };
}

/** Węzły dodane przez wskazane rozwinięcie (do znaczka „nowe” i animacji). */
export function freshNodeIds(network: NetworkView | null, expansionId: string | null): Set<string> {
  if (!network || !expansionId) return new Set();
  return new Set(network.graph.nodes.filter((node) => node.expansionId === expansionId).map((node) => node.id));
}

/** Liczby węzłów według odległości od teczki: „teczka: 40 · krok 1: 6 · krok 2: 3”. */
export function depthSummary(depthCounts: Record<string, number>): string {
  return Object.entries(depthCounts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([depth, count]) => (depth === '0' ? `teczka: ${count}` : `krok ${depth}: ${count}`))
    .join(' · ');
}

export const countExpansionNodes = (network: NetworkView | null): number => network?.graph.nodes.filter((node) => node.expansionId).length ?? 0;

/** Węzły będące wpisami list sankcyjnych / ryzyka. */
export const sanctionedNodes = (nodes: NetworkNode[]): NetworkNode[] => nodes.filter((node) => Boolean(node.meta?.sanctioned));

/** Opis siły ścieżki z kroków (te same zasady co w usłudze): liczba kroków i najsłabsze ogniwo. */
export function pathStrength(edges: (GraphEdge | NetworkEdge)[], nodes: string[]): StrengthPath {
  return describePath(nodes, edges as PathEdge[]);
}

export const PATH_LEVEL_TEXT = PATH_LEVEL_LABEL;

/**
 * Scalenie teczki z rozwinięciami (to samo, co robi usługa) — dla trybu demonstracyjnego.
 * Każdy węzeł z rozwinięcia dostaje opis powiązania z podmiotem z bezpiecznikiem „winy przez skojarzenie”.
 */
export function mergeExpansions(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, expansions: ExpansionRecord[]): Pick<NetworkView, 'graph' | 'depthCounts' | 'sanctioned'> {
  const nodes = new Map<string, NetworkNode>(graph.nodes.map((node) => [node.id, { ...node, depth: 0 }]));
  const edges = new Map<string, NetworkEdge>(graph.edges.map((edge) => [edge.id, edge]));
  for (const record of expansions.filter((item) => !item.withdrawnAt)) {
    const anchor = nodes.get(record.nodeId)?.depth ?? 0;
    for (const node of record.results.nodes) if (!nodes.has(node.id)) nodes.set(node.id, { ...node, depth: anchor + (node.depth ?? 1) });
    for (const edge of record.results.edges) if (!edges.has(edge.id) && nodes.has(edge.from) && nodes.has(edge.to)) edges.set(edge.id, edge);
  }
  const edgeList = [...edges.values()];
  const subject = [...nodes.values()].find((node) => node.kind === 'subject');
  for (const node of nodes.values()) {
    if (!node.expansionId || !subject) continue;
    const path = strongestPath(edgeList as PathEdge[], node.id, subject.id);
    node.link = path
      ? { level: path.level, label: linkToSubjectLabel(path), summary: path.summary, strength: Math.round(path.strength * 100) / 100, hypotheses: path.hypotheses }
      : { level: 'none', label: linkToSubjectLabel(null), summary: 'brak ścieżki do podmiotu', strength: 0, hypotheses: 0 };
  }
  const depthCounts: Record<string, number> = {};
  for (const node of nodes.values()) depthCounts[String(node.depth ?? 0)] = (depthCounts[String(node.depth ?? 0)] ?? 0) + 1;
  return { graph: { nodes: [...nodes.values()], edges: edgeList }, depthCounts, sanctioned: [...nodes.values()].filter((node) => node.meta?.sanctioned).map((node) => node.id) };
}

/**
 * Najmocniejsza ścieżka (iloczyn sił, najpierw same fakty) w kształcie ścieżki dowodowej grafu —
 * do „Ścieżka do podmiotu z listy sankcyjnej”.
 */
export function strongestEvidencePath(edges: GraphEdge[], from: string, to: string): EvidencePath | null {
  const found = strongestPath(edges as PathEdge[], from, to);
  if (!found) return null;
  const steps = found.steps.map((step) => ({ edge: step.edge as GraphEdge, from: step.from, to: step.to, status: step.status as ClaimStatus, forward: step.edge.from === step.from }));
  return { nodes: found.nodes, steps, hypotheses: found.hypotheses };
}

/** Opis ścieżki do wpisu listy: zgodność samej nazwy z wpisem = „możliwy imiennik”. */
export function riskPathNote(path: EvidencePath): string | null {
  return path.steps.some((step) => (step.edge as NetworkEdge).relation === 'sanctions_name_match') ? 'ścieżka poszlakowa — możliwy imiennik' : null;
}

/** Odznaka listy sankcyjnej dla węzła: z teczki (`riskLists`) albo wpis listy z rozwinięcia (`meta.sanctioned`). */
export function riskBadgeOf(
  node: NetworkNode,
  badges: Record<string, { badge: string; status: 'source_fact' | 'hypothesis'; summary: string; caveat: string }> | undefined,
): { badge: string; status: 'source_fact' | 'hypothesis'; tooltip: string } | null {
  const badge = badges?.[node.id];
  if (badge) return { badge: badge.badge, status: badge.status, tooltip: `${badge.summary} ${badge.caveat}` };
  const entry = node.meta?.sanctioned;
  if (entry) return { badge: 'lista sankcyjna', status: 'source_fact', tooltip: `Wpis na liście: ${entry.list} (${entry.entryId})${entry.synthetic ? ' — LISTA SYNTETYCZNA, dane zmyślone' : ''}. Fakt dotyczy wyłącznie tego wpisu.` };
  return null;
}

/** Zdanie podsumowania rozwinięcia dla historii. */
export function expansionSummary(record: ExpansionRecord, label: (id: string) => string): string {
  const fresh = record.results.nodes.filter((node) => !node.known).length;
  const groups = record.relations.length > 0 ? record.relations.map((group) => RELATION_GROUP_LABEL[group] ?? group).join(', ') : 'wszystkie grupy';
  return `${label(record.nodeId)} — ${groups}; ${record.depth === 1 ? '1 krok' : `${record.depth} kroki`}; nowych węzłów: ${fresh}, relacji: ${record.results.edges.length}; zapytań: ${record.budget.used}/${record.budget.limit}`;
}

/** Krótki status kroku ścieżki. */
export const STEP_STATUS_WORD: Record<ClaimStatus, string> = {
  source_fact: 'fakt źródłowy',
  computed: 'obliczenie',
  hypothesis: 'hipoteza',
  confirmed: 'potwierdzone',
  rejected: 'odrzucone',
};
