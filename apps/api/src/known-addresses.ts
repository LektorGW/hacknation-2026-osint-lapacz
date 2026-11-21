// Adresy już przypisane podmiotom innych spraw. Gdy monitoring albo przegląd źródeł trafi na
// autora publikującego taki adres, to mocny trop: ta sama osoba pod inną nazwą albo ktoś z nią związany.

import type { Lead } from '@olcys/core';
import { PRIORITY_RULES } from './priority.ts';
import type { LatestRun } from './storage.ts';

/** Sprawa, w której adres jest już przypisany podmiotowi. */
export interface KnownAddress {
  address: string;
  caseId: string;
  caseName: string;
}

/** Wskazanie lub trafienie z informacją o adresach znanych z innych spraw (lokalne rozszerzenie kontraktu). */
export type KnownLead = Lead & { knownFromCases?: KnownAddress[] };

/** Priorytet nadawany wskazaniu, gdy publikuje adres znany z innej sprawy. */
export const KNOWN_ADDRESS_PRIORITY = 90;

/** Adres → sprawy, w których jest powiązany z podmiotem (ostatnia zakończona analiza każdej sprawy). */
export function indexKnownAddresses(latest: LatestRun[]): Map<string, KnownAddress[]> {
  const index = new Map<string, KnownAddress[]>();
  for (const { caseId, caseName, run } of latest) {
    for (const finding of run.findings) {
      if (finding.confidence.excluded || finding.confidence.score < PRIORITY_RULES.linkedMinScore) continue;
      const key = finding.address.toLowerCase();
      index.set(key, [...(index.get(key) ?? []), { address: finding.address, caseId, caseName }]);
    }
  }
  return index;
}

/** Sprawy, z których znane są podane adresy; `exceptCaseId` pomija sprawę założoną z tego samego wskazania. */
export function knownFor(index: Map<string, KnownAddress[]>, addresses: string[], exceptCaseId?: string): KnownAddress[] {
  return addresses.flatMap((address) => index.get(address.toLowerCase()) ?? []).filter((item) => item.caseId !== exceptCaseId);
}

/** Podnosi priorytet wskazania publikującego adres znany z innej sprawy i dopisuje jawne uzasadnienie. */
export function markKnown(lead: Lead, known: KnownAddress[]): KnownLead {
  if (known.length === 0) return lead;
  const cases = [...new Set(known.map((item) => `„${item.caseName}”`))].join(', ');
  return {
    ...lead,
    priority: Math.max(lead.priority, KNOWN_ADDRESS_PRIORITY),
    priorityReasons: [
      ...lead.priorityReasons,
      `Adres znany ze sprawy ${cases}: autor publikuje adres już przypisany innemu podmiotowi — możliwa ta sama osoba pod inną nazwą lub osoba powiązana; priorytet co najmniej ${KNOWN_ADDRESS_PRIORITY}.`,
    ],
    knownFromCases: known,
  };
}
