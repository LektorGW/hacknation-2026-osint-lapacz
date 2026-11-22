// Obieg środków („ping-pong”, „Szukaj dalej”) — typy wyniku usługi i czysta logika widoku (bez DOM):
// raporty obiegów węzła, odznaka „ping-pong”, ścieżka obiegu na grafie, opisy kwot i czasu.
import type { ClaimStatus, GraphEdge } from '@olcys/core';
import { fmtAmount, fmtPln } from '../format.ts';
import type { EvidencePath } from './investigation.ts';
import type { ExpansionRecord, NetworkView } from './network.ts';

export type RoundTripPattern = 'direct' | 'intermediaries' | 'exchange' | 'mixer' | 'contract';
export type IntermediaryClass = 'exchange' | 'mixer' | 'contract' | 'unlabelled' | 'labelled';

export interface RoundTripHop {
  from: string;
  to: string;
  txid: string;
  time: string;
  amount: number;
  asset: string;
  valuePln?: number;
  valuation?: string;
  explorerUrl?: string;
}

export interface RoundTripCycle {
  id: string;
  pattern: RoundTripPattern;
  label: string;
  sameFunds: 'hypothesis';
  hops: RoundTripHop[];
  hopCount: number;
  startedAt: string;
  endedAt: string;
  durationHours: number;
  out: { amount: number; asset: string; valuePln?: number };
  back: { amount: number; asset: string; valuePln?: number };
  ratio?: number;
  returnsTo: { address: string; role: 'subject' | 'cluster' | 'case' };
  intermediaries: { address: string; class: IntermediaryClass; label?: string }[];
  repeats?: number;
  note: string;
  /** Węzły i krawędzie sieci w kolejności kroków (pierwszy i ostatni węzeł to adres powrotu). */
  nodeIds: string[];
  edgeIds: string[];
}

export interface RoundTripReport {
  anchor: string;
  origin: string;
  network: string;
  params: { maxHops: number; budget: number; windowDays: number; fanOut: number; minShare: number };
  cycles: RoundTripCycle[];
  stops: { reason: string; detail: string; count: number }[];
  stats: { addressesFetched: number; deepestHop: number; pathsExplored: number; cyclesFound: number };
  caveat: string;
}

export interface RoundTripProgress {
  nodeId: string;
  startedAt: string;
  finished: boolean;
  addressesFetched: number;
  deepestHop: number;
  cyclesFound: number;
  queued: number;
}

export interface NetworkProgress {
  running: boolean;
  roundtrip: RoundTripProgress | null;
}

export interface RoundTripRequest {
  maxHops?: number;
  budget?: number;
  windowDays?: number;
}

/** Wybory w panelu „Szukaj dalej” (limity jak w usłudze: do 50 kroków, do 200 pobrań). */
export const ROUNDTRIP_CHOICES = {
  maxHops: [3, 5, 10, 20, 30, 50],
  budget: [20, 60, 100, 200],
  windowDays: [30, 90, 180, 365, 730],
  defaults: { maxHops: 10, budget: 60, windowDays: 180 },
} as const;

export const PATTERN_CHIP: Record<RoundTripPattern, string> = {
  direct: 'chip-warn',
  intermediaries: 'chip-warn',
  exchange: 'chip-calc',
  mixer: 'chip-warn',
  contract: 'chip-calc',
};

export const INTERMEDIARY_LABEL: Record<IntermediaryClass, string> = {
  exchange: 'giełda / usługa',
  mixer: 'mikser',
  contract: 'kontrakt',
  unlabelled: 'bez etykiety',
  labelled: 'z etykietą',
};

export const RETURN_ROLE_LABEL: Record<RoundTripCycle['returnsTo']['role'], string> = {
  subject: 'na ten sam adres',
  cluster: 'na inny adres tego samego portfela (heurystyka)',
  case: 'na inny adres sprawy',
};

/** Wyniki „Szukaj dalej” dla węzła z niewycofanych rozwinięć — najnowszy pierwszy. */
export function roundTripReports(network: NetworkView | null, nodeId: string): { record: ExpansionRecord; report: RoundTripReport }[] {
  if (!network) return [];
  return network.expansions
    .filter((record) => !record.withdrawnAt && record.nodeId === nodeId && record.results.roundtrip)
    .map((record) => ({ record, report: record.results.roundtrip! }))
    .sort((a, b) => b.record.startedAt.localeCompare(a.record.startedAt));
}

/** Adresy pośrednie obiegów z niewycofanych rozwinięć — odznaka „ping-pong” na grafie. */
export function roundTripNodeIds(network: NetworkView | null): Set<string> {
  const ids = new Set<string>();
  for (const record of network?.expansions ?? []) {
    if (record.withdrawnAt || !record.results.roundtrip) continue;
    for (const cycle of record.results.roundtrip.cycles) for (const id of cycle.nodeIds.slice(1, -1)) ids.add(id);
  }
  return ids;
}

/**
 * Obieg jako ścieżka dowodowa grafu (do podświetlenia): kroki = krawędzie-przelewy w kolejności.
 * `null`, gdy któraś krawędź nie jest widoczna (filtr warstwy, statusów, zwinięta gałąź).
 */
export function cycleEvidencePath(cycle: Pick<RoundTripCycle, 'nodeIds' | 'edgeIds'>, edges: GraphEdge[]): EvidencePath | null {
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const steps: EvidencePath['steps'] = [];
  for (let index = 0; index < cycle.edgeIds.length; index++) {
    const edge = byId.get(cycle.edgeIds[index]!);
    const from = cycle.nodeIds[index];
    const to = cycle.nodeIds[index + 1];
    if (!edge || !from || !to) return null;
    steps.push({ edge, from, to, status: (edge.status ?? 'source_fact') as ClaimStatus, forward: edge.from === from });
  }
  if (steps.length === 0) return null;
  return { nodes: [...cycle.nodeIds], steps, hypotheses: steps.filter((step) => step.status === 'hypothesis').length };
}

/** Czas trwania obiegu: „30 min”, „5 godz.”, „3 dni”. */
export function durationText(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.round(hours)} godz.`;
  return `${Math.round(hours / 24)} dni`;
}

const valueOf = (side: { amount: number; asset: string; valuePln?: number }) => `${fmtAmount(side.amount, side.asset)}${side.valuePln !== undefined ? ` (ok. ${fmtPln(side.valuePln)})` : ''}`;

/** Jedno zdanie o obiegu: liczba przelewów, czas, wyszło / wróciło i stosunek. */
export function cycleSummary(cycle: RoundTripCycle): string {
  const hops = cycle.hopCount === 1 ? '1 przelew' : cycle.hopCount < 5 ? `${cycle.hopCount} przelewy` : `${cycle.hopCount} przelewów`;
  const ratio = cycle.ratio !== undefined ? ` (${Math.round(cycle.ratio * 100)}%)` : '';
  return `${hops} · ${durationText(cycle.durationHours)} · wyszło ${valueOf(cycle.out)}, wróciło ${valueOf(cycle.back)}${ratio}`;
}

/** Postęp wyszukiwania dla paska stanu. */
export function progressText(progress: Pick<RoundTripProgress, 'addressesFetched' | 'deepestHop' | 'cyclesFound'> | null): string {
  if (!progress) return 'przygotowanie…';
  return `pobrane adresy: ${progress.addressesFetched} · najdalszy krok: ${progress.deepestHop} · znalezione obiegi: ${progress.cyclesFound}`;
}
