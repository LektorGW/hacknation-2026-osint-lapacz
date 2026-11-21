// Statystyki skuteczności: liczone z ostatniej zakończonej analizy każdej sprawy (po decyzjach analityka).
// Definicje są jawne i podawane razem z wynikiem, żeby ekran „Statystyki” mógł je pokazać.

import type { DossierView } from './dossier.ts';

/**
 * Trafienie: adres powiązany ze sprawą, nieodrzucony, z Wskaźnikiem Pewności co najmniej 60,
 * czyli co najmniej na poziomie „prawdopodobne” w skali wyniku.
 */
export const HIT_THRESHOLD = 60;

export const STATS_DEFINITIONS = {
  hit: `Trafienie — adres powiązany ze sprawą, nieodrzucony przez analityka, z Wskaźnikiem Pewności co najmniej ${HIT_THRESHOLD} (poziom „prawdopodobne” lub wyższy).`,
  averageConfidence: 'Średnia pewność — średnia z najwyższego Wskaźnika Pewności adresu w każdej sprawie z co najmniej jedną zakończoną analizą.',
  averageHits: 'Średnia liczba trafień — liczba trafień podzielona przez liczbę spraw z zakończoną analizą.',
  effectiveness: 'Skuteczność — odsetek spraw z zakończoną analizą, w których jest co najmniej jedno trafienie.',
  casesWithHitsShare: 'Odsetek spraw z trafieniami — sprawy z co najmniej jednym trafieniem wśród wszystkich spraw, także jeszcze nieanalizowanych.',
} as const;

/** Liczby jednej sprawy (ostatnia zakończona analiza). */
export interface CaseStat {
  caseId: string;
  name: string;
  priority: number;
  /** Najwyższy Wskaźnik Pewności wśród adresów niewykluczonych. */
  topScore: number;
  cashOutPlnTotal: number;
  linkedAddresses: number;
  /** Adresy spełniające definicję trafienia. */
  hits: number;
  /** Nazwy giełd i usług, do których wyszły środki. */
  services: string[];
}

export interface StatsSummary {
  hitThreshold: number;
  /** Wszystkie sprawy, także bez analizy. */
  totalCases: number;
  /** Sprawy z co najmniej jedną zakończoną analizą. */
  analysedCases: number;
  casesWithHits: number;
  totalHits: number;
  /** 0–100; `null`, gdy żadna sprawa nie ma zakończonej analizy. */
  averageConfidence: number | null;
  averageHits: number | null;
  /** % spraw z analizą, w których jest trafienie (0–100). */
  effectiveness: number | null;
  /** % wszystkich spraw z trafieniem (0–100). */
  casesWithHitsShare: number | null;
  definitions: typeof STATS_DEFINITIONS;
}

/** Ile adresów teczki spełnia definicję trafienia. */
export function countHits(dossier: Pick<DossierView, 'findings'>): number {
  return dossier.findings.filter((finding) => !finding.confidence.excluded && finding.confidence.score >= HIT_THRESHOLD).length;
}

export function caseStat(caseId: string, name: string, dossier: DossierView): CaseStat {
  return {
    caseId,
    name,
    priority: dossier.totals.priority,
    topScore: dossier.totals.topScore,
    cashOutPlnTotal: dossier.totals.cashOutPlnTotal,
    linkedAddresses: dossier.totals.linkedAddresses,
    hits: countHits(dossier),
    services: dossier.serviceLinks.filter((link) => link.transfersOut > 0).map((link) => link.name),
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;
const percent = (part: number, whole: number) => (whole > 0 ? round1((part / whole) * 100) : null);

/** Zbiorcze wskaźniki: średnie po sprawach z zakończoną analizą, odsetki jawnie względem podanej podstawy. */
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
    definitions: STATS_DEFINITIONS,
  };
}
