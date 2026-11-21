// Zajęcie środków, pochodzenie środków i adresy powiązane w blockchainie:
// lokalne rozszerzenia kontraktu teczki oraz czysta logika widoków.

/** Przelew na adres publicznie opisany jako adres organu państwa — zajęcie, nie spieniężenie. */
export interface Seizure {
  subjectAddress: string;
  network: string;
  txid: string;
  time: string;
  asset: string;
  amount: number;
  counterparty: string;
  counterpartyLabel: string;
  /** Skąd pochodzi etykieta: zdanie z adresami stron źródłowych. */
  labelSource: string;
  valuePln?: number | null;
  valuation?: string | null;
  explanation: string;
  explorerUrl: string;
}

/** Skąd środki trafiły na adres podmiotu. */
export interface FundingSource {
  subjectAddress: string;
  network: string;
  address: string;
  label?: string | null;
  addressClass: string;
  category?: string | null;
  labelSource?: string | null;
  amount: number;
  asset: string;
  /** Udział we wpływach adresu podmiotu, ułamek 0–1. */
  share: number;
  hops: number;
  /** Adres pośredni, gdy źródło jest o krok dalej. */
  via?: string | null;
  txids: string[];
  reason: string;
}

export interface RelatedAddress {
  address: string;
  kind: string;
  /** Siła powiązania, 0–100. */
  strength: number;
  reason?: string | null;
  txids: string[];
}

const RELATED_KIND_LABEL: Record<string, string> = {
  same_wallet: 'ten sam portfel (heurystyka)',
  funded_by: 'finansowany z',
  funds: 'finansuje',
  co_depositor: 'wpłaca na ten sam adres wpłat',
  repeated_counterparty: 'powtarzający się kontrahent',
};

/** Rodzaj powiązania po polsku; nieznany rodzaj (nowsza usługa) pokazujemy bez zmian. */
export const relatedKindLabel = (kind: string): string => RELATED_KIND_LABEL[kind] ?? kind;

/** Adresy powiązane od najmocniejszego; przy remisie zachowana kolejność z usługi. */
export function sortRelated(items: RelatedAddress[]): RelatedAddress[] {
  return items.map((item, index) => ({ item, index })).sort((a, b) => b.item.strength - a.item.strength || a.index - b.index).map(({ item }) => item);
}

/** Liczba adresów powiązanych w podziale na rodzaje, w kolejności pierwszego wystąpienia. */
export function relatedSummary(items: RelatedAddress[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => `${relatedKindLabel(kind)}: ${count}`).join(' · ');
}

/** Udział (ułamek 0–1) jako procent; niezerowa kwota o znikomym udziale to „<1%”, nie „0%”. */
export function fmtShare(share: number | null | undefined, amount = 0): string {
  if (share == null || !Number.isFinite(share)) return '—';
  const percent = Math.round(Math.max(0, Math.min(1, share)) * 100);
  return percent === 0 && (share > 0 || amount > 0) ? '<1%' : `${percent}%`;
}

/** Liczba kroków słownie: 1 krok, 2 kroki, 5 kroków. */
export function hopsText(hops: number): string {
  const last = hops % 10;
  const teens = hops % 100 >= 12 && hops % 100 <= 14;
  return `${hops} ${hops === 1 ? 'krok' : last >= 2 && last <= 4 && !teens ? 'kroki' : 'kroków'}`;
}

export type TextPart = { text: string } | { url: string };

/**
 * Dzieli zdanie ze źródłem etykiety na zwykły tekst i adresy stron, żeby adresy dało się
 * pokazać jako odnośniki. Znaki przestankowe na końcu adresu zostają w tekście.
 */
export function splitLinks(text: string | null | undefined): TextPart[] {
  if (!text) return [];
  const parts: TextPart[] = [];
  let rest = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"„”]+/g)) {
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    if (match.index > rest) parts.push({ text: text.slice(rest, match.index) });
    parts.push({ url });
    rest = match.index + url.length;
  }
  if (rest < text.length) parts.push({ text: text.slice(rest) });
  return parts;
}

/** Wzmianka o identyfikatorze; nowsza usługa podaje liczbę serwisów, starsza — ich listę. */
export interface Mention {
  identifier: { type: string; value: string };
  documents: number;
  authors: number;
  services: string[] | number;
  /** Liczby są dolnym oszacowaniem (przeszukiwanie przerwano). */
  atLeast?: boolean;
  note?: string | null;
}

export function mentionServices(services: string[] | number | null | undefined): { count: number; names: string[] } {
  if (Array.isArray(services)) return { count: services.length, names: services };
  return { count: typeof services === 'number' && Number.isFinite(services) ? services : 0, names: [] };
}
