// Zajęcie środków i ich pochodzenie — ustalenia z publicznych etykiet adresów.
// Przekazanie środków na adres organu państwa to ZAJĘCIE, nie spieniężenie: nie wchodzi do sum
// wypłat ani do dowodu spieniężenia. Pochodzenie środków z adresu oznaczonego jako związany
// z incydentem (włamanie, oszustwo) albo z listy sankcyjnej jest osobnym ustaleniem i jawnym
// czynnikiem priorytetu. Pola modułu danych blockchain są czytane dynamicznie (poza kontraktem core).

import type { ChainActivity, Finding } from '@olcys/core';
import { formatAmount, formatDate, roundPln, shortAddress } from './format.ts';
import { linkedAddressesOf } from './pivot.ts';
import type { LinkKind } from './pivot.ts';

/** Przekazanie środków z adresu podmiotu na adres organu państwa. */
export interface SeizureView {
  /** Adres podmiotu, z którego wyszły środki. */
  subjectAddress: string;
  network: string;
  txid: string;
  time: string;
  asset: string;
  amount: number;
  /** Adres organu państwa lub zajętych środków i jego publiczna etykieta. */
  counterparty: string;
  counterpartyLabel: string;
  /** Publiczne źródło etykiety. */
  labelSource: string;
  valuePln?: number;
  valuation?: string;
  explanation: string;
  explorerUrl: string;
}

/** Skąd przyszły środki na adres podmiotu. */
export interface FundingSourceView {
  subjectAddress: string;
  network: string;
  address: string;
  label?: string;
  addressClass: string;
  /** `incident` — adres związany z włamaniem lub oszustwem; `law_enforcement` — organ państwa; `sanctioned` — lista sankcyjna. */
  category?: string;
  labelSource?: string;
  amount: number;
  asset: string;
  /** Udział we wpływach tej waluty na adres podmiotu, 0–1. */
  share: number;
  /** 1 = przelew wprost; 2 = przez jeden adres pośredni (heurystyka). */
  hops: number;
  via?: string;
  txids: string[];
  reason: string;
}

/** Inny adres powiązany z adresem podmiotu w samym blockchainie, bez żadnej publikacji — nie jest osobą. */
export interface RelatedAddress {
  address: string;
  kind: LinkKind;
  strength: number;
  reason?: string;
  txids: string[];
}

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const list = (chain: ChainActivity | undefined, field: string): Record<string, unknown>[] => {
  const raw = (chain as unknown as Record<string, unknown> | undefined)?.[field];
  return Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
};

export function collectSeizures(findings: Finding[]): SeizureView[] {
  const result: SeizureView[] = [];
  for (const finding of findings) {
    for (const item of list(finding.chain, 'seizures')) {
      const [txid, time, counterparty] = [text(item.txid), text(item.time), text(item.counterparty)];
      if (!txid || !time || !counterparty) continue;
      result.push({
        subjectAddress: finding.address,
        network: finding.network,
        txid,
        time,
        asset: text(item.asset) ?? '',
        amount: number(item.amount) ?? 0,
        counterparty,
        counterpartyLabel: text(item.counterpartyLabel) ?? 'adres organu państwa',
        labelSource: text(item.labelSource) ?? 'źródło etykiety nie zostało podane',
        ...(number(item.valuePln) !== undefined ? { valuePln: number(item.valuePln) } : {}),
        ...(text(item.valuation) ? { valuation: text(item.valuation) } : {}),
        explanation: text(item.explanation) ?? '',
        explorerUrl: text(item.explorerUrl) ?? '',
      });
    }
  }
  return result.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
}

export function collectFundingSources(findings: Finding[]): FundingSourceView[] {
  const result: FundingSourceView[] = [];
  for (const finding of findings) {
    for (const item of list(finding.chain, 'fundingSources')) {
      const address = text(item.address);
      if (!address) continue;
      result.push({
        subjectAddress: finding.address,
        network: finding.network,
        address,
        ...(text(item.label) ? { label: text(item.label) } : {}),
        addressClass: text(item.addressClass) ?? 'unknown',
        ...(text(item.category) ? { category: text(item.category) } : {}),
        ...(text(item.labelSource) ? { labelSource: text(item.labelSource) } : {}),
        amount: number(item.amount) ?? 0,
        asset: text(item.asset) ?? '',
        share: number(item.share) ?? 0,
        hops: number(item.hops) ?? 1,
        ...(text(item.via) ? { via: text(item.via) } : {}),
        txids: Array.isArray(item.txids) ? (item.txids as unknown[]).filter((value): value is string => typeof value === 'string') : [],
        reason: text(item.reason) ?? '',
      });
    }
  }
  return result.sort((a, b) => b.share - a.share);
}

/** Adresy powiązane w blockchainie, których nikt nie opublikował (`published`: adresy z publikacją — te są tożsamościami). */
export function relatedAddressesOf(finding: Finding, published: Set<string>): RelatedAddress[] {
  return linkedAddressesOf(finding.chain)
    .filter((item) => !published.has(item.address.toLowerCase()))
    .map((item) => ({ address: item.address, kind: item.kind, strength: item.strength, ...(item.reason ? { reason: item.reason } : {}), txids: item.txids }));
}

/** Źródło środków oznaczone jako związane z incydentem lub objęte sankcjami. */
export const isIncidentSource = (item: FundingSourceView): boolean => item.category === 'incident' || item.category === 'sanctioned';

export const seizureSentence = (item: SeizureView): string =>
  `Środki z adresu ${shortAddress(item.subjectAddress)} (${formatAmount(item.amount)} ${item.asset}${item.valuePln !== undefined ? `, ok. ${roundPln(item.valuePln)}` : ''}) ` +
  `zostały ${formatDate(item.time)} przekazane na adres organu państwa: „${item.counterpartyLabel}” — źródło etykiety: ${item.labelSource}. To zajęcie, nie spieniężenie.`;

export const fundingSentence = (item: FundingSourceView): string =>
  `Środki na adresie ${shortAddress(item.subjectAddress)} pochodzą w ${Math.round(item.share * 100)}% z adresu ${shortAddress(item.address)}` +
  `${item.label ? ` oznaczonego jako „${item.label}”` : ' bez publicznej etykiety'}` +
  `${item.category === 'incident' ? ' (adres związany z incydentem: włamaniem lub oszustwem)' : item.category === 'sanctioned' ? ' (lista sankcyjna)' : item.category === 'law_enforcement' ? ' (organ państwa)' : ''}` +
  `${item.hops > 1 ? ' — przez jeden adres pośredni (heurystyka)' : ''}${item.labelSource ? `; źródło etykiety: ${item.labelSource}` : ''}.`;
