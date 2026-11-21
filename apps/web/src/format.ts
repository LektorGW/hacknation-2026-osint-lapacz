// Formatowanie dat, kwot i adresów w konwencji polskiej.

const dateTime = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('pl-PL', { dateStyle: 'medium' });
const pln = new Intl.NumberFormat('pl-PL', { style: 'currency', currency: 'PLN', maximumFractionDigits: 0 });

function format(formatter: Intl.DateTimeFormat, iso: string | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : formatter.format(date);
}

export const fmtDateTime = (iso?: string) => format(dateTime, iso);
export const fmtDate = (iso?: string) => format(dateOnly, iso);
export const fmtPln = (value: number) => pln.format(value);

export function fmtAmount(value: number, asset: string): string {
  return `${value.toLocaleString('pl-PL', { maximumFractionDigits: 8 })} ${asset}`;
}

/** Zmiana wyniku ze znakiem, np. `+15 p.p.` lub `−5 p.p.`. */
export function fmtDelta(delta: number): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return `${sign}${Math.abs(delta)} p.p.`;
}

/** Skrót długiego ciągu (adres, skrót treści) do postaci `początek…koniec`. */
export function shorten(value: string, head = 8, tail = 6): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/** Przycięcie tekstu do podanej długości (SVG nie zawija ani nie skraca napisów). */
export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Zwraca adres tylko dla schematów http/https; treści ze źródeł są niezaufane. */
export function safeHttpUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export type ScoreLevel = 'high' | 'likely' | 'medium' | 'low' | 'excluded';

/** Poziom używany wyłącznie do kolorowania; etykietę słowną podaje API (`tier`). */
export function scoreLevel(score: number, excluded = false): ScoreLevel {
  if (excluded) return 'excluded';
  if (score >= 80) return 'high';
  if (score >= 60) return 'likely';
  if (score >= 40) return 'medium';
  return 'low';
}

const plnCompact = new Intl.NumberFormat('pl-PL', { notation: 'compact', maximumFractionDigits: 1 });

/** Kwota skrócona do etykiet wykresów, np. `130 tys. zł`. */
export const fmtPlnCompact = (value: number) => `${plnCompact.format(value)} zł`;

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Rok kalendarzowy z daty ISO (bez przeliczania stref — wystarczy do grupowania). */
export const yearOf = (iso: string) => iso.slice(0, 4);

export const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
