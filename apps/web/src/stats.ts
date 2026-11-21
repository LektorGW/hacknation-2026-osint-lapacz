// Statystyki skuteczności i historia spraw: czysta logika (bez DOM), testowana w `test/stats.test.ts`.
// Definicje są te same co w usłudze analizy (apps/api/src/stats.ts) — tryb demo liczy je tu.
import { countText } from './ux.ts';

/**
 * Trafienie: adres powiązany ze sprawą, nieodrzucony, z Wskaźnikiem Pewności co najmniej 60 —
 * czyli co najmniej na poziomie „prawdopodobne”.
 */
export const HIT_THRESHOLD = 60;

/** Liczby jednej sprawy z ostatniej zakończonej analizy. */
export interface CaseStat {
  caseId: string;
  name: string;
  priority: number;
  topScore: number;
  cashOutPlnTotal: number;
  linkedAddresses: number;
  hits: number;
  services?: string[];
}

export interface StatsSummary {
  hitThreshold: number;
  totalCases: number;
  analysedCases: number;
  casesWithHits: number;
  totalHits: number;
  averageConfidence: number | null;
  averageHits: number | null;
  effectiveness: number | null;
  casesWithHitsShare: number | null;
}

/** Liczba trafień wśród adresów teczki. */
export function countHits(findings: { confidence: { score: number; excluded: boolean } }[], threshold = HIT_THRESHOLD): number {
  return findings.filter((finding) => !finding.confidence.excluded && finding.confidence.score >= threshold).length;
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const percent = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : null);

/** Średnie po sprawach z zakończoną analizą; odsetek spraw z trafieniami — względem wszystkich spraw. */
export function summarizeStats(stats: Pick<CaseStat, 'topScore' | 'hits'>[], totalCases: number): StatsSummary {
  const analysed = stats.length;
  const withHits = stats.filter((item) => item.hits > 0).length;
  const totalHits = stats.reduce((sum, item) => sum + item.hits, 0);
  return {
    hitThreshold: HIT_THRESHOLD,
    totalCases,
    analysedCases: analysed,
    casesWithHits: withHits,
    totalHits,
    averageConfidence: analysed > 0 ? round1(stats.reduce((sum, item) => sum + item.topScore, 0) / analysed) : null,
    averageHits: analysed > 0 ? round1(totalHits / analysed) : null,
    effectiveness: percent(withHits, analysed),
    casesWithHitsShare: percent(withHits, Math.max(totalCases, analysed)),
  };
}

/** Liczba z jednym miejscem po przecinku, po polsku; brak danych — kreska. */
export const fmtStat = (value: number | null, unit = ''): string =>
  value === null ? '—' : `${value.toLocaleString('pl-PL', { maximumFractionDigits: 1 })}${unit}`;

// ---------- Historia spraw: sortowanie ----------

export type HistorySortKey = 'created' | 'priority' | 'strength' | 'payouts';
export type SortDirection = 'asc' | 'desc';

export interface HistoryRow {
  id: string;
  name: string;
  createdAt: string;
  /** Brak — sprawa bez zakończonej analizy (zawsze na końcu, niezależnie od kierunku). */
  stat?: Pick<CaseStat, 'priority' | 'topScore' | 'cashOutPlnTotal'>;
}

export const HISTORY_SORT_LABEL: Record<HistorySortKey, string> = {
  created: 'Utworzono',
  priority: 'Priorytet',
  strength: 'Najmocniejsze powiązanie',
  payouts: 'Szacowane wypłaty',
};

const sortValue = (row: HistoryRow, key: HistorySortKey): number | undefined => {
  if (key === 'created') return new Date(row.createdAt).getTime();
  if (!row.stat) return undefined;
  return key === 'priority' ? row.stat.priority : key === 'strength' ? row.stat.topScore : row.stat.cashOutPlnTotal;
};

/** Domyślnie od najnowszej; sprawy bez analizy zawsze na końcu; remis rozstrzyga data utworzenia (nowsze wyżej). */
export function sortHistory<T extends HistoryRow>(rows: T[], key: HistorySortKey = 'created', direction: SortDirection = 'desc'): T[] {
  const sign = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortValue(a, key);
    const right = sortValue(b, key);
    if (left === undefined || right === undefined) {
      if (left !== right) return left === undefined ? 1 : -1;
    } else if (left !== right) return (left - right) * sign;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

/** Kliknięcie w nagłówek: ta sama kolumna odwraca kierunek, nowa zaczyna od malejącego. */
export function nextSort(current: { key: HistorySortKey; direction: SortDirection }, key: HistorySortKey): { key: HistorySortKey; direction: SortDirection } {
  if (current.key === key) return { key, direction: current.direction === 'desc' ? 'asc' : 'desc' };
  return { key, direction: 'desc' };
}

// ---------- Obserwowane sprawy ----------

/** Odstępy automatycznej analizy do wyboru (minuty). */
export const WATCH_INTERVALS = [60, 360, 1440] as const;
export const DEFAULT_WATCH_MINUTES = 360;

export function intervalLabel(minutes: number): string {
  if (minutes === 60) return 'co godzinę';
  if (minutes === 1440) return 'codziennie';
  if (minutes % 1440 === 0) return `co ${minutes / 1440} dni`;
  if (minutes % 60 === 0) return `co ${minutes / 60} godzin${minutes / 60 >= 2 && minutes / 60 <= 4 ? 'y' : ''}`;
  return `co ${minutes} min`;
}

/** Krótki opis zmian między dwiema ostatnimi analizami; pusta lista — nic się nie zmieniło. */
export function changeSummary(changes: { diff: { addedAddresses: string[]; removedAddresses: string[]; scoreChanges: unknown[]; replacedAddresses: unknown[] }; newCashOuts: unknown[] }): string[] {
  const { diff, newCashOuts } = changes;
  const parts: string[] = [];
  if (diff.addedAddresses.length > 0) parts.push(countText(diff.addedAddresses.length, 'nowy adres', 'nowe adresy', 'nowych adresów'));
  if (diff.removedAddresses.length > 0) parts.push(countText(diff.removedAddresses.length, 'adres zniknął', 'adresy zniknęły', 'adresów zniknęło'));
  if (diff.scoreChanges.length > 0) parts.push(countText(diff.scoreChanges.length, 'zmiana wyniku', 'zmiany wyniku', 'zmian wyniku'));
  if (diff.replacedAddresses.length > 0) parts.push(countText(diff.replacedAddresses.length, 'podmiana adresu', 'podmiany adresu', 'podmian adresu'));
  if (newCashOuts.length > 0) parts.push(countText(newCashOuts.length, 'nowy przelew do usługi', 'nowe przelewy do usług', 'nowych przelewów do usług'));
  return parts;
}
