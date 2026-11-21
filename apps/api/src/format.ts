// Zapis liczb, dat i adresów po polsku — wspólny dla teczki i raportu.

const MONTHS_GENITIVE = [
  'stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca',
  'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia',
];

/** Skrócony adres lub skrót transakcji: początek i koniec wystarczają do rozpoznania. */
export const shortAddress = (text: string): string => (text.length > 20 ? `${text.slice(0, 10)}…${text.slice(-8)}` : text);

export const formatAmount = (value: number): string => value.toLocaleString('pl-PL', { maximumFractionDigits: 8 });

/** Kwota co do grosza — do tabel. */
export const formatPln = (value: number): string =>
  `${value.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} zł`;

/** Kwota zaokrąglona do czytania w zdaniu: „324 tys. zł”, „1,2 mln zł”. */
export function roundPln(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} mln zł`;
  if (value >= 10_000) return `${Math.round(value / 1000).toLocaleString('pl-PL')} tys. zł`;
  return `${Math.round(value).toLocaleString('pl-PL')} zł`;
}

/** Data w zdaniu: „14 marca 2025 r.”; nieczytelną wartość zwraca bez zmian. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.getUTCDate()} ${MONTHS_GENITIVE[date.getUTCMonth()]} ${date.getUTCFullYear()} r.`;
}

/** Odmiana rzeczownika przy liczbie: 1 adres, 2 adresy, 5 adresów. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (count === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** Suma słowników „rok → kwota”. */
export function sumByYear(parts: Record<string, number>[]): Record<string, number> {
  const total: Record<string, number> = {};
  for (const part of parts) {
    for (const [year, value] of Object.entries(part)) total[year] = (total[year] ?? 0) + value;
  }
  for (const year of Object.keys(total)) total[year] = Math.round(total[year]! * 100) / 100;
  return total;
}
