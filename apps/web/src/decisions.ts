// Decyzje analityka w interfejsie: wycofanie jest miękkie — decyzja zostaje w rejestrze
// z polami `withdrawnAt` / `withdrawnBy` i przestaje wpływać na wynik.
import type { AnalystDecision } from '@olcys/core';

export type DecisionRecord = AnalystDecision & {
  withdrawnAt?: string | null;
  withdrawnBy?: string | null;
  /** Autor decyzji, jeśli usługa go podaje. */
  author?: string | null;
  decidedBy?: string | null;
};

export const isWithdrawn = (decision: DecisionRecord): boolean => Boolean(decision.withdrawnAt);

/** Decyzje obowiązujące — wycofane nie wpływają na wynik ani na stan przycisków. */
export const activeDecisions = <T extends DecisionRecord>(decisions: T[]): T[] => decisions.filter((item) => !isWithdrawn(item));

/** Obowiązująca decyzja dla obiektu (ostatnia niewycofana). */
export function currentDecision<T extends DecisionRecord>(decisions: T[], target: string, key: string): T | undefined {
  const wanted = key.toLowerCase();
  return activeDecisions(decisions)
    .filter((item) => (item.target as string) === target && item.key.toLowerCase() === wanted)
    .at(-1);
}

/** Historia zmian: od najnowszego zdarzenia; opcjonalnie tylko dla wskazanych obiektów. */
export function decisionHistory<T extends DecisionRecord>(decisions: T[], keys?: string[]): T[] {
  const wanted = keys ? new Set(keys.map((key) => key.toLowerCase())) : null;
  const latest = (item: DecisionRecord) => (item.withdrawnAt && item.withdrawnAt > item.decidedAt ? item.withdrawnAt : item.decidedAt);
  return decisions.filter((item) => !wanted || wanted.has(item.key.toLowerCase())).sort((a, b) => latest(b).localeCompare(latest(a)));
}

export const DECISION_TARGET_LABEL: Record<string, string> = {
  profile: 'konto',
  address: 'adres',
  evidence: 'ślad (odczyt modelu)',
  link: 'hipoteza wspólnego operatora',
};

export const decisionAuthor = (decision: DecisionRecord): string => decision.author ?? decision.decidedBy ?? 'analityk';
