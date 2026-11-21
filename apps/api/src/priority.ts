// Priorytet sprawy: którą sprawą analityk powinien zająć się najpierw.
//
// JEDYNE miejsce ze wzorem. Priorytet to suma ważona czterech składników, każdy 0–100:
//
//   priorytet = 0,40·P + 0,35·S + 0,15·A + 0,10·Z      (zaokrąglony do liczby całkowitej)
//
//   P — Wskaźnik Pewności najlepszego niewykluczonego adresu.
//   S — skala szacowanych wypłat w PLN, logarytmicznie: 100·log10(1+PLN)/log10(1+1 000 000),
//       najwyżej 100 (pełna skala od 1 mln zł). Logarytm, bo różnica między 10 a 100 tys. zł
//       jest dla sprawy ważniejsza niż między 1,0 a 1,1 mln zł.
//   A — aktualność ostatniej możliwej wypłaty: 100 do roku wstecz, potem liniowo do 0
//       po 5 latach (okres przedawnienia zobowiązań podatkowych); brak wypłat = 0.
//   Z — niezależne źródła (różne serwisy) najlepszego adresu: 100·min(3, liczba)/3.
//
// Do sum wypłat wchodzą tylko adresy „powiązane”: niewykluczone, nieodrzucone przez
// analityka, ze Wskaźnikiem Pewności co najmniej 40% albo podane przez analityka.
// Priorytet jest wynikiem obliczeń pomocniczym w kolejkowaniu spraw, a nie oceną podmiotu.

import type { Finding } from '@olcys/core';
import { formatDate, roundPln, sumByYear } from './format.ts';
import { addressKey } from './intel.ts';

export const PRIORITY_RULES = {
  formula: 'priorytet = 0,40·P + 0,35·S + 0,15·A + 0,10·Z',
  weights: { confidence: 0.4, scale: 0.35, recency: 0.15, sources: 0.1 },
  /** Kwota wypłat w PLN, od której składnik skali wynosi 100. */
  scaleFullPln: 1_000_000,
  /** Do ilu dni wstecz ostatnia wypłata jest w pełni aktualna. */
  recencyFullDays: 365,
  /** Po ilu dniach aktualność spada do zera. */
  recencyZeroDays: 5 * 365,
  /** Liczba niezależnych źródeł dająca pełny składnik. */
  sourcesFull: 3,
  /** Minimalny Wskaźnik Pewności, od którego adres liczy się do sum wypłat. */
  linkedMinScore: 40,
  components: {
    confidence: 'P — Wskaźnik Pewności najlepszego niewykluczonego adresu (0–100).',
    scale: 'S — skala szacowanych wypłat w PLN: 100·log10(1+PLN)/log10(1+1 000 000), najwyżej 100.',
    recency: 'A — aktualność ostatniej możliwej wypłaty: 100 do roku wstecz, liniowo do 0 po 5 latach; brak wypłat = 0.',
    sources: 'Z — niezależne źródła najlepszego adresu: 100·min(3, liczba)/3.',
  },
  note: 'Do sum wypłat wchodzą adresy niewykluczone, nieodrzucone przez analityka, ze Wskaźnikiem Pewności co najmniej 40% albo podane przez analityka. Priorytet porządkuje kolejkę spraw; nie jest oceną podmiotu.',
} as const;

export interface PriorityInput {
  topScore: number;
  cashOutPlnTotal: number;
  /** Czas ostatniej możliwej wypłaty (ISO 8601). */
  lastCashOutAt?: string;
  independentSources: number;
  now: Date;
}

export interface PriorityResult {
  priority: number;
  reasons: string[];
}

const DAY_MS = 86_400_000;
const points = (value: number) => value.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const weight = (value: number) => value.toLocaleString('pl-PL', { minimumFractionDigits: 2 });

export function computePriority(input: PriorityInput): PriorityResult {
  const { weights } = PRIORITY_RULES;

  const confidence = Math.max(0, Math.min(100, input.topScore));

  const pln = Math.max(0, input.cashOutPlnTotal);
  const scale = Math.min(100, (100 * Math.log10(1 + pln)) / Math.log10(1 + PRIORITY_RULES.scaleFullPln));

  let recency = 0;
  let ageDays: number | undefined;
  if (input.lastCashOutAt && !Number.isNaN(new Date(input.lastCashOutAt).getTime())) {
    ageDays = Math.max(0, Math.floor((input.now.getTime() - new Date(input.lastCashOutAt).getTime()) / DAY_MS));
    const span = PRIORITY_RULES.recencyZeroDays - PRIORITY_RULES.recencyFullDays;
    recency = Math.max(0, Math.min(100, (100 * (PRIORITY_RULES.recencyZeroDays - ageDays)) / span));
  }

  const sourceCount = Math.max(0, input.independentSources);
  const sources = (100 * Math.min(PRIORITY_RULES.sourcesFull, sourceCount)) / PRIORITY_RULES.sourcesFull;

  const priority = Math.round(
    weights.confidence * confidence + weights.scale * scale + weights.recency * recency + weights.sources * sources,
  );

  const reasons = [
    `Pewność najlepszego adresu: ${confidence}% × ${weight(weights.confidence)} = ${points(weights.confidence * confidence)} pkt.`,
    pln > 0
      ? `Skala szacowanych wypłat: ${roundPln(pln)} → ${Math.round(scale)}/100 w skali logarytmicznej (pełna skala od 1 mln zł) × ${weight(weights.scale)} = ${points(weights.scale * scale)} pkt.`
      : 'Skala szacowanych wypłat: nie stwierdzono wypłat z adresów powiązanych — 0 pkt.',
    ageDays === undefined
      ? 'Aktualność: brak wypłat do oceny — 0 pkt.'
      : `Aktualność: ostatnia możliwa wypłata ${formatDate(input.lastCashOutAt!)} (${ageDays} dni temu) → ${Math.round(recency)}/100 × ${weight(weights.recency)} = ${points(weights.recency * recency)} pkt.`,
    `Niezależne źródła najlepszego adresu: ${sourceCount} → ${Math.round(sources)}/100 × ${weight(weights.sources)} = ${points(weights.sources * sources)} pkt.`,
    `Razem: ${priority}/100 (wynik obliczeń według jawnego wzoru).`,
  ];
  return { priority, reasons };
}

export interface FindingsSummary {
  /** Adresy liczone do sum wypłat. */
  linked: Finding[];
  linkedAddresses: number;
  excludedAddresses: number;
  topScore: number;
  cashOutPlnByYear: Record<string, number>;
  cashOutPlnTotal: number;
  lastCashOutAt?: string;
  priority: number;
  priorityReasons: string[];
}

/**
 * Zbiorcze liczby dla listy adresów (po uwzględnieniu decyzji analityka — adres
 * odrzucony ma już `confidence.excluded`). `analystAddresses`: klucze `network:address`
 * adresów podanych przez analityka jako identyfikatory.
 */
export function summarizeFindings(findings: Finding[], analystAddresses: Set<string>, now: Date): FindingsSummary {
  const active = findings.filter((finding) => !finding.confidence.excluded);
  const linked = active.filter(
    (finding) => finding.confidence.score >= PRIORITY_RULES.linkedMinScore || analystAddresses.has(addressKey(finding)),
  );
  const best = [...active].sort((a, b) => b.confidence.score - a.confidence.score)[0];
  const cashOutPlnByYear = sumByYear(linked.map((finding) => finding.chain?.cashOutPlnByYear ?? {}));
  const cashOutPlnTotal = Math.round(Object.values(cashOutPlnByYear).reduce((sum, value) => sum + value, 0) * 100) / 100;
  const lastCashOutAt = linked
    .flatMap((finding) => finding.chain?.cashOuts ?? [])
    .map((item) => item.time)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
    .at(-1);
  const topScore = best?.confidence.score ?? 0;
  const { priority, reasons } = computePriority({
    topScore,
    cashOutPlnTotal,
    lastCashOutAt,
    independentSources: new Set((best?.evidence ?? []).map((item) => item.service.toLowerCase())).size,
    now,
  });
  return {
    linked,
    linkedAddresses: linked.length,
    excludedAddresses: findings.length - active.length,
    topScore,
    cashOutPlnByYear,
    cashOutPlnTotal,
    lastCashOutAt,
    priority,
    priorityReasons: reasons,
  };
}
