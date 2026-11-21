// Wskaźnik C — wyjście do walut tradycyjnych: drabina dowodowa od samej transakcji w blockchainie
// do udokumentowanego wyjścia do fiat. Szczegóły w `packages/core/src/indicators.ts`.

import type { CashOutAssessment, Finding } from '@olcys/core';

export interface CashOutStageInput {
  /** Adresy teczki po korektach. */
  findings: Finding[];
  /** Adresy liczone jako powiązane z podmiotem (`network:address`). */
  linkedKeys: Set<string>;
  /** Adresy, dla których analityk potwierdził wyjście do fiat dokumentem spoza blockchaina (`network:address`). */
  documentedExits?: Set<string>;
}

export function buildCashOutAssessments(_input: CashOutStageInput): CashOutAssessment[] {
  return [];
}
