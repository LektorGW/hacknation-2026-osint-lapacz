// Monitoring: lokalne rozszerzenia kontraktu trafień i stanu oraz czysta logika listy trafień.
import type { MonitorStatus, TextInsight, WatchHit } from '@olcys/core';
import type { KnownFromCase } from './identities.ts';

export type HitBasis = 'own_address' | 'offer_poland' | 'address_poland';

/** Trafienie z polami dodawanymi przez usługę poza kontraktem `WatchHit`; wszystkie opcjonalne. */
export type MonitorHit = WatchHit & {
  /** Która część definicji trafienia jest spełniona. */
  basis?: HitBasis | string;
  /** Dlaczego publikacja jest trafieniem. */
  hitReason?: string;
  /** Dlaczego trafienia nie przeanalizowano automatycznie. */
  autoAnalysis?: string;
  /** Powód odrzucenia przy ponownym przeliczeniu reguł. */
  dismissReason?: string;
  translationPl?: string;
  insight?: TextInsight;
  knownFromCases?: KnownFromCase[];
};

export interface MonitorRunStats {
  at?: string;
  documents: number;
  withAddress: number;
  candidates: number;
  aiRead: number;
  contractsFiltered: number;
  hits: number;
  analyzed: number;
  skipped?: { noAuthorNoAddress?: number; limit?: number; belowThreshold?: number };
}

export type MonitorStatusView = MonitorStatus & {
  maxAutoAnalyses?: number;
  maxAiPublications?: number;
  totals: MonitorStatus['totals'] & { dismissed?: number; lastRun?: Partial<MonitorRunStats> };
};

export interface RecheckResult {
  checked: number;
  kept: number;
  dismissed: number;
  status?: MonitorStatusView;
}

const HIT_BASIS_LABEL: Record<string, string> = {
  own_address: 'autor podaje adres jako własny',
  offer_poland: 'oferta obrotu kryptowalutą ze związkiem z Polską',
  address_poland: 'adres i związek z Polską',
};

/** Podstawa trafienia po polsku; nieznaną (nowsza usługa) pokazujemy bez zmian, brak — pomijamy. */
export const hitBasisLabel = (basis: string | null | undefined): string | undefined => (basis ? (HIT_BASIS_LABEL[basis] ?? basis) : undefined);

/** Próg oceny „Związek z Polską”, od którego trafienie uznajemy za mające związek z Polską. */
export const POLISH_NEXUS_THRESHOLD = 40;

/** Zakresy przyjmowane przez `PUT /api/monitor`. */
export const LIMIT_RANGE = { maxAutoAnalyses: { min: 0, max: 200 }, maxAiPublications: { min: 0, max: 2000 } } as const;

const score = (signal: { score?: number } | null | undefined) => (typeof signal?.score === 'number' && Number.isFinite(signal.score) ? signal.score : 0);

/** Suma ocen „Związek z Polską” i „Sygnały do sprawdzenia” (0–200). */
export const hitTotal = (hit: Pick<WatchHit, 'polishNexus' | 'suspicion'>): number => score(hit.polishNexus) + score(hit.suspicion);

const hitTime = (hit: Pick<WatchHit, 'publishedAt' | 'detectedAt'>) => hit.publishedAt ?? hit.detectedAt ?? '';

export interface HitFilter {
  /** `all` — każdy status poza odrzuconymi (te włącza `showDismissed`). */
  status: WatchHit['status'] | 'all';
  showDismissed: boolean;
  polishOnly: boolean;
  minPolish: number;
  minSuspicion: number;
  network: string;
  service: string;
}

export const DEFAULT_HIT_FILTER: HitFilter = { status: 'all', showDismissed: false, polishOnly: false, minPolish: 0, minSuspicion: 0, network: 'all', service: 'all' };

export function filterHits<T extends WatchHit>(hits: T[], filter: HitFilter): T[] {
  const minPolish = Math.max(filter.minPolish, filter.polishOnly ? POLISH_NEXUS_THRESHOLD : 0);
  return hits.filter(
    (hit) =>
      (filter.status === 'all' ? filter.showDismissed || hit.status !== 'dismissed' : hit.status === filter.status) &&
      score(hit.polishNexus) >= minPolish &&
      score(hit.suspicion) >= filter.minSuspicion &&
      (filter.network === 'all' || (hit.addresses ?? []).some((item) => item.network === filter.network)) &&
      (filter.service === 'all' || hit.service === filter.service),
  );
}

/** Od najwyższej sumy ocen (przy remisie nowsze wyżej) albo od najnowszego. */
export function sortHits<T extends WatchHit>(hits: T[], order: 'total' | 'date'): T[] {
  const byDate = (a: T, b: T) => hitTime(b).localeCompare(hitTime(a));
  return [...hits].sort((a, b) => (order === 'date' ? byDate(a, b) : hitTotal(b) - hitTotal(a) || byDate(a, b)));
}

export const countDismissed = (hits: WatchHit[]): number => hits.filter((hit) => hit.status === 'dismissed').length;

/** Wartość limitu z pola formularza: liczba całkowita w zakresie; `undefined`, gdy wpis nie jest liczbą. */
export function parseLimit(raw: string, range: { min: number; max: number }): number | undefined {
  if (raw.trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(range.min, Math.min(range.max, Math.round(value)));
}

/** Rozbicie ostatniego przebiegu jako wiersze etykieta–liczba; brakujące liczniki pomijamy. */
export function lastRunRows(run: Partial<MonitorRunStats> | null | undefined): { label: string; value: number; hint?: string }[] {
  if (!run) return [];
  const rows: { label: string; value: number | undefined; hint?: string }[] = [
    { label: 'Publikacje pobrane', value: run.documents },
    { label: 'Z adresem kryptowalutowym', value: run.withAddress },
    { label: 'Kandydaci do odczytu', value: run.candidates },
    { label: 'Odczytane przez model', value: run.aiRead },
    { label: 'Odsiane adresy kontraktów i usług', value: run.contractsFiltered, hint: 'Adresy rozpoznane jako smart kontrakty lub adresy usług — nie należą do autora publikacji' },
    { label: 'Nowe trafienia', value: run.hits },
    { label: 'Autorzy przeanalizowani', value: run.analyzed },
    { label: 'Bez analizy: brak autora i adresu', value: run.skipped?.noAuthorNoAddress },
    { label: 'Bez analizy: limit na przebieg', value: run.skipped?.limit },
    { label: 'Bez analizy: poniżej progu', value: run.skipped?.belowThreshold },
  ];
  return rows.filter((row): row is { label: string; value: number; hint?: string } => typeof row.value === 'number' && Number.isFinite(row.value));
}
