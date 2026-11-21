// Dowód spieniężenia: ustalenia „osoba → adres → ścieżka środków → usługa” z jedną,
// jawnie policzoną pewnością.
//
// WZÓR (jedyne miejsce):
//   łączna pewność ustalenia = P(osoba–adres) × P(ścieżka) / 100      (zaokrąglona)
//   P(osoba–adres) — łączne prawdopodobieństwo, że adres należy do osoby ze sprawy
//                    (`subjectProbability`; adres podany przez analityka = 100);
//                    dla adresu z klastra portfela dodatkowo × 0,8, bo przynależność
//                    do tego samego portfela wynika z heurystyki,
//   P(ścieżka)     — pewność ścieżki środków z modułu danych blockchain (`CashOutTrail.confidence`).
// Ustalenie mówi o przekazaniu środków do usługi, w której można je spieniężyć. Samej
// wypłaty na rachunek blockchain nie pokazuje — potwierdzi ją dopiero usługa (`openQuestions`).

import type { CashOutTrail, Finding, PersonCandidate } from '@olcys/core';
import { formatAmount, plural, roundPln, shortAddress } from './format.ts';
import { normalizeServiceLabel } from './services.ts';

export const PROOF_RULES = {
  formula: 'łączna pewność ustalenia = P(osoba–adres) × P(ścieżka) / 100',
  /** Mnożnik dla adresów przypisanych podmiotowi tylko heurystyką klastra portfela. */
  clusterFactor: 0.8,
  tiers: [
    { min: 80, label: 'bardzo wysoka' },
    { min: 60, label: 'wysoka' },
    { min: 40, label: 'średnia' },
    { min: 0, label: 'niska' },
  ],
  description:
    'P(osoba–adres) to łączne prawdopodobieństwo, że adres należy do osoby ze sprawy (adres podany przez analityka = 100; adres z klastra portfela × 0,8). ' +
    'P(ścieżka) to pewność udokumentowanej ścieżki środków do usługi. Ustalenie dotyczy przekazania środków do usługi; wypłatę na rachunek potwierdza dopiero usługa.',
} as const;

/** Jedno ustalenie „osoba przekazała X do usługi Y”. */
export interface CashOutProof {
  id: string;
  /** Osoba główna sprawy; `null`, gdy analiza nie ustaliła osoby. */
  person: { id: string; fullName?: string; probability: number } | null;
  /** Adres podmiotu, od którego zaczyna się ścieżka. */
  address: string;
  network: string;
  /** Skąd wiadomo, że adres jest adresem podmiotu. */
  addressBasis: 'published' | 'analyst' | 'cluster';
  /** Dla adresu z klastra: adres opublikowany przez podmiot i powód zaliczenia do tego samego portfela. */
  cluster?: { seed: string; reason: string };
  /** P(osoba–adres), 0–100 (po obniżce dla klastra). */
  personAddressProbability: number;
  /** P(ścieżka), 0–100. */
  trailConfidence: number;
  /** Łączna pewność ustalenia, 0–100. */
  combinedConfidence: number;
  /** Poziom słowny łącznej pewności. */
  tier: string;
  /** Rozbicie na składniki — zdania do pokazania analitykowi. */
  components: string[];
  /** `calculation`: ścieżka wprost z transakcji; `inference`: zawiera krok lub adres z heurystyki. */
  layer: 'calculation' | 'inference';
  /** Nazwa usługi bez numeru i rodzaju portfela („Binance 14” → „Binance”). */
  serviceName: string;
  /** Jedno zdanie dla laika. */
  statement: string;
  trail: CashOutTrail;
}

export interface ProofInput {
  /** Adresy teczki (po decyzjach), z łącznym prawdopodobieństwem osoba–adres. */
  findings: (Finding & { subjectProbability?: number })[];
  /** Adresy liczone jako powiązane z podmiotem. */
  linkedKeys: Set<string>;
  /** Adresy podane przez analityka (`network:address`). */
  analystAddresses: Set<string>;
  main?: PersonCandidate;
}

const tierOf = (score: number): string => PROOF_RULES.tiers.find((tier) => score >= tier.min)!.label;

/** Ścieżki wszystkich adresów powiązanych jako ustalenia, od najpewniejszego. */
export function buildCashOutProof(input: ProofInput): CashOutProof[] {
  const proofs: CashOutProof[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    const key = `${finding.network}:${finding.address}`;
    if (!input.linkedKeys.has(key)) continue;
    const analyst = input.analystAddresses.has(key);
    const base = analyst ? 100 : (finding.subjectProbability ?? 0);
    for (const trail of finding.chain?.trails ?? []) {
      if (seen.has(trail.id)) continue;
      seen.add(trail.id);
      const member = trail.sourceAddress === finding.address ? undefined : finding.chain?.cluster?.addresses.find((item) => item.address === trail.sourceAddress);
      const fromCluster = trail.sourceAddress !== finding.address;
      const personAddressProbability = Math.round(base * (fromCluster ? PROOF_RULES.clusterFactor : 1));
      const combinedConfidence = Math.round((personAddressProbability * trail.confidence) / 100);
      const inferred = fromCluster || trail.hops.some((hop) => hop.inferred);
      const value = trail.valuePln !== undefined ? ` (ok. ${roundPln(trail.valuePln)})` : '';
      const steps = `${trail.hops.length} ${plural(trail.hops.length, 'kroku', 'krokach', 'krokach')}`;
      const serviceName = normalizeServiceLabel(trail.serviceName);
      proofs.push({
        id: trail.id,
        person: input.main && input.main.probability > 0 ? { id: input.main.id, ...(input.main.fullName ? { fullName: input.main.fullName } : {}), probability: input.main.probability } : null,
        address: trail.sourceAddress,
        network: trail.network,
        addressBasis: fromCluster ? 'cluster' : analyst ? 'analyst' : 'published',
        ...(fromCluster ? { cluster: { seed: finding.address, reason: member?.reason ?? 'adres zaliczony do tego samego portfela heurystyką' } } : {}),
        personAddressProbability,
        trailConfidence: trail.confidence,
        combinedConfidence,
        tier: tierOf(combinedConfidence),
        components: [
          analyst
            ? 'P(osoba–adres) = 100%: adres podany przez analityka jako adres podmiotu.'
            : `P(osoba–adres) = ${base}%: łączne prawdopodobieństwo, że adres ${shortAddress(finding.address)} należy do osoby ze sprawy.`,
          ...(fromCluster
            ? [`Adres ${shortAddress(trail.sourceAddress)} zaliczono do tego samego portfela heurystyką (${member?.reason ?? 'klaster adresów'}) — obniżka × ${PROOF_RULES.clusterFactor.toLocaleString('pl-PL')} → ${personAddressProbability}%.`]
            : []),
          `P(ścieżka) = ${trail.confidence}%: ${trail.reasons.join(' ') || 'pewność ścieżki według modułu danych blockchain.'}`,
          `Łączna pewność ustalenia = ${personAddressProbability} × ${trail.confidence} / 100 = ${combinedConfidence}% (${tierOf(combinedConfidence)}).`,
        ],
        layer: inferred ? 'inference' : 'calculation',
        serviceName,
        statement:
          `Udokumentowano przekazanie ${formatAmount(trail.amount)} ${trail.asset}${value} z adresu ${shortAddress(trail.sourceAddress)} do usługi ${serviceName} ` +
          `w ${steps} — pewność ścieżki ${trail.confidence}%, łączna pewność ustalenia ${combinedConfidence}%.`,
        trail,
      });
    }
  }
  return proofs.sort((a, b) => b.combinedConfidence - a.combinedConfidence || (b.trail.valuePln ?? 0) - (a.trail.valuePln ?? 0) || a.id.localeCompare(b.id));
}
