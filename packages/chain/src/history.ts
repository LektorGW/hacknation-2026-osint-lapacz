// Zakres historii adresu pobieranej do analizy. Domyślnie bierzemy najnowsze
// transakcje (`recent`); dla adresu będącego przedmiotem sprawy potrzebna jest
// pełna historia (`full`) — stronicowana do limitu żądań, osobnego od budżetu
// śledzenia środków, z opcjonalnym zakresem dat.

import type { ConnectorContext } from '@olcys/core';
import { RequestBudget } from './http.ts';

export type HistoryMode = 'recent' | 'full';

export interface HistoryOptions {
  /**
   * `recent` (domyślnie): najnowsze ~50 transakcji. `full`: cała historia adresu,
   * stronicowana aż do końca, do limitu żądań albo do wyjścia poza `since`.
   */
  history?: HistoryMode;
  /** Początek analizowanego okresu (ISO 8601); starsze transakcje są pomijane, a stronicowanie się na nich kończy. */
  since?: string;
  /** Koniec analizowanego okresu (ISO 8601); nowsze transakcje są pomijane. */
  until?: string;
  /** Limit żądań o kolejne strony historii (osobny od budżetu śledzenia); domyślnie 24, w trybie głębokim 60. */
  maxHistoryRequests?: number;
}

/**
 * Kontekst wywołania `getActivity` / `getActivityFromProviders`: zwykły kontekst
 * łącznika rozszerzony o zakres historii — ustawiany osobno dla każdego adresu.
 */
export interface ChainRequestContext extends ConnectorContext, HistoryOptions {
  /** Budżet żądań na etykiety i śledzenie środków dla TEGO adresu; nadpisuje ustawienie dostawcy (15 / 40 w trybie głębokim). */
  requestBudget?: number;
}

/** Budżet śledzenia z kontekstu wywołania albo domyślny dostawcy. */
export function traceBudgetLimit(context: ConnectorContext, fallback: number): number {
  const requested = (context as ChainRequestContext).requestBudget;
  return typeof requested === 'number' && requested > 0 ? requested : fallback;
}

export const DEFAULT_HISTORY_REQUESTS = 24;
export const DEEP_HISTORY_REQUESTS = 60;
/** Górny limit liczby przelewów pobieranych w trybie pełnej historii (Ethereum, Tron). */
export const FULL_HISTORY_TRANSFER_LIMIT = 2000;

export interface HistoryPlan {
  mode: HistoryMode;
  /** Granice okresu w milisekundach. */
  since?: number;
  until?: number;
  /** Budżet żądań o kolejne strony historii. */
  budget: RequestBudget;
}

const parseTime = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const time = Date.parse(value);
  if (Number.isNaN(time)) throw new Error(`Nieprawidłowa data w polu „${name}”: ${value} (oczekiwany zapis ISO 8601).`);
  return time;
};

/** Łączy ustawienia z kontekstu wywołania (pierwszeństwo) z domyślnymi ustawieniami dostawcy. */
export function planHistory(context: ConnectorContext, defaults: HistoryOptions = {}): HistoryPlan {
  const request = context as ChainRequestContext;
  const since = parseTime(request.since ?? defaults.since, 'since');
  const until = parseTime(request.until ?? defaults.until, 'until');
  return {
    mode: request.history ?? defaults.history ?? 'recent',
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    budget: new RequestBudget(request.maxHistoryRequests ?? defaults.maxHistoryRequests ?? DEFAULT_HISTORY_REQUESTS),
  };
}

/** Czy chwila mieści się w analizowanym okresie. */
export function inHistoryRange(plan: HistoryPlan, time: number): boolean {
  return (plan.since === undefined || time >= plan.since) && (plan.until === undefined || time <= plan.until);
}

/** Opis okresu do `limitations`; pusty, gdy okres nie jest ograniczony. */
export function describeRange(plan: HistoryPlan): string {
  const day = (time: number) => new Date(time).toISOString().slice(0, 10);
  if (plan.since !== undefined && plan.until !== undefined) return `od ${day(plan.since)} do ${day(plan.until)}`;
  if (plan.since !== undefined) return `od ${day(plan.since)}`;
  if (plan.until !== undefined) return `do ${day(plan.until)}`;
  return '';
}
