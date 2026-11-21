// Pochodzenie środków (śledzenie WSTECZ): skąd przyszły największe wpływy na
// adres podmiotu. Idziemy najwyżej 1–2 kroki wstecz i zatrzymujemy się na adresie
// z etykietą (giełda, usługa, lista sankcyjna, znany incydent, organ państwa)
// albo na adresie o dużej aktywności. Drugi krok jest HEURYSTYKĄ: „główne źródło
// wpływów nadawcy” nie musi być źródłem akurat tych środków.

import type { AddressClass, Network } from '@olcys/core';
import type { RawTransfer } from './activity.ts';
import { ChainProviderError } from './http.ts';
import type { RequestBudget } from './http.ts';
import { classify, normalizeAddress } from './labels.ts';
import type { Classification, LabelCategory, LabelSet } from './labels.ts';
import type { IncomingNode } from './links.ts';
import { OFAC_LABEL } from './ofac.ts';
import type { SanctionsList } from './ofac.ts';
import { isQueryableAddress } from './party-labels.ts';
import type { LabelLookup } from './party-labels.ts';

/** Źródło środków adresu podmiotu. */
export interface FundingSource {
  /** Adres, z którego (bezpośrednio lub przez jeden adres pośredni) przyszły środki. */
  address: string;
  network: Network;
  label?: string;
  addressClass: AddressClass;
  /** `law_enforcement`, `incident` albo `sanctioned`, gdy adres jest tak oznaczony. */
  category?: LabelCategory | 'sanctioned';
  /** Skąd pochodzi etykieta. */
  labelSource?: string;
  /** Kwota wpływów na adres podmiotu przypisana temu źródłu. */
  amount: number;
  asset: string;
  /** Udział w całości wpływów tej waluty na adres podmiotu (0–1). */
  share: number;
  /** 1 = adres wysłał środki wprost na adres podmiotu; 2 = jeden adres pośredni. */
  hops: number;
  /** Adres pośredni przy dwóch krokach. */
  via?: string;
  txids: string[];
  /** Dlaczego ścieżka kończy się na tym adresie. */
  reason: string;
}

export interface FundingOptions {
  enabled?: boolean;
  /** Ilu największych nadawców badamy. */
  maxSources?: number;
  /** Ile kroków wstecz najwyżej (1 lub 2). */
  maxHops?: number;
  /** Powyżej tylu transakcji adres podmiotu nie jest analizowany wstecz. */
  maxSubjectTxCount?: number;
  /** Powyżej tylu transakcji nadawca jest traktowany jak usługa i nie idziemy dalej. */
  maxNodeTxCount?: number;
}

export const DEFAULT_FUNDING_OPTIONS: Required<FundingOptions> = { enabled: true, maxSources: 5, maxHops: 2, maxSubjectTxCount: 200, maxNodeTxCount: 200 };
export const DEFAULT_FUNDING_BUDGET = 8;
export const DEEP_FUNDING_BUDGET = 16;

export interface FundingSearch {
  network: Network;
  address: string;
  /** Przelewy badanego adresu. */
  transfers: RawTransfer[];
  /** Liczba transakcji adresu (cała historia). */
  txCount: number;
  historyComplete: boolean;
  labels: LabelSet;
  sanctions?: SanctionsList;
  sourceName: string;
  budget: RequestBudget;
  options?: FundingOptions;
  /** Przelewy przychodzące na adres nadawcy — jedno żądanie. */
  fetchIncoming?(address: string, asset: string): Promise<IncomingNode>;
  /** Etykieta pojedynczego adresu (np. WalletExplorer); każde nowe pytanie zużywa budżet. */
  lookup?: LabelLookup;
  signal?: AbortSignal;
}

const round8 = (value: number) => Math.round(value * 1e8) / 1e8;

export async function traceFundingSources(search: FundingSearch): Promise<{ sources: FundingSource[]; limitations: string[] }> {
  const options = { ...DEFAULT_FUNDING_OPTIONS, ...search.options };
  const { network, labels, budget } = search;
  const subject = normalizeAddress(search.address);
  const sources: FundingSource[] = [];
  const limitations: string[] = [];
  if (!options.enabled) return { sources, limitations };
  const incoming = search.transfers.filter((item) => item.direction === 'in' && item.amount > 0 && !item.asset.includes('niezweryfikowany'));
  if (incoming.length === 0) return { sources, limitations };
  if (search.txCount > options.maxSubjectTxCount) {
    limitations.push(
      `Pochodzenie środków: nie analizowano wstecz — adres ma ${search.txCount} transakcji (próg ${options.maxSubjectTxCount}); ` +
        'przy tak wielu wpływach „największe źródła” niewiele mówią o pochodzeniu środków.',
    );
    return { sources, limitations };
  }

  let lookupBroken = false;
  let stoppedBy: string | undefined;
  const lookedUp = new Map<string, string | undefined>();
  interface Described extends Classification {
    category?: FundingSource['category'];
    labelSource?: string;
  }
  /** Co wiadomo o adresie: zbiór etykiet, lista sankcyjna, etykieta ze źródła danych, serwis etykiet. */
  async function describe(transfer: RawTransfer): Promise<Described> {
    const address = transfer.counterparty;
    const base = classify(network, address, {
      labels,
      sourceLabel: transfer.counterpartyLabel,
      sourceClass: transfer.counterpartyClass,
      sourceKind: transfer.counterpartyKind,
      sourceName: transfer.counterpartyLabelSource ?? search.sourceName,
      isContract: transfer.counterpartyIsContract,
    });
    const sanctioned = search.sanctions?.lookup(address);
    if (sanctioned) {
      return { ...base, label: `${OFAC_LABEL}: ${sanctioned.entity}${base.label ? ` — ${base.label}` : ''}`, category: 'sanctioned', labelSource: search.sanctions!.source };
    }
    if (base.label || base.addressClass !== 'unknown') return { ...base, labelSource: base.source ?? base.classificationSource };
    if (search.lookup && !lookupBroken && isQueryableAddress(address)) {
      if (!lookedUp.has(address)) {
        if (!search.lookup.cached?.(address) && !budget.take()) {
          stoppedBy = `wyczerpano budżet ${budget.limit} żądań na pochodzenie środków`;
          return base;
        }
        try {
          lookedUp.set(address, await search.lookup.lookup(address, search.signal));
        } catch (error) {
          if (search.signal?.aborted) throw error;
          lookupBroken = true;
          limitations.push(`Pochodzenie środków: ${search.lookup.sourceName} nie odpowiedział (${error instanceof Error ? error.message : String(error)}) — etykiety nadawców z tego serwisu pominięto.`);
        }
      }
      const label = lookedUp.get(address);
      if (label) {
        const known = classify(network, address, { labels, sourceLabel: label, sourceName: search.lookup.sourceName });
        return { ...known, labelSource: known.classificationSource };
      }
    }
    return base;
  }
  const isKnown = (known: Described) => Boolean(known.label) || (known.addressClass !== 'unknown' && known.addressClass !== 'private');

  // Wpływy pogrupowane według nadawcy, osobno dla każdej waluty.
  const totals = new Map<string, number>();
  const groups = new Map<string, RawTransfer[]>();
  for (const item of incoming) {
    totals.set(item.asset, (totals.get(item.asset) ?? 0) + item.amount);
    if (normalizeAddress(item.counterparty) === subject) continue;
    const key = `${item.asset}|${normalizeAddress(item.counterparty)}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const mainAsset = [...totals.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const ranked = [...groups.values()]
    .map((items) => ({ items, amount: items.reduce((sum, item) => sum + item.amount, 0) }))
    .sort((a, b) => Number(b.items[0]!.asset === mainAsset) - Number(a.items[0]!.asset === mainAsset) || b.amount - a.amount);
  const selected = ranked.slice(0, options.maxSources);

  for (const { items, amount } of selected) {
    if (stoppedBy) break;
    const first = items[0]!;
    const asset = first.asset;
    const share = Math.round((amount / (totals.get(asset) ?? amount)) * 10_000) / 10_000;
    const txids = items.map((item) => item.txid);
    const known = await describe(first);
    const entry = (address: string, info: Described, hops: number, reason: string, via?: string): FundingSource => ({
      address,
      network,
      ...(info.label ? { label: info.label } : {}),
      addressClass: info.addressClass,
      ...(info.category ? { category: info.category } : {}),
      ...(info.labelSource && isKnown(info) ? { labelSource: info.labelSource } : {}),
      amount: round8(amount),
      asset,
      share,
      hops,
      ...(via ? { via } : {}),
      txids,
      reason,
    });
    if (isKnown(known)) {
      sources.push(entry(first.counterparty, known, 1, 'adres z etykietą wysłał środki wprost na adres podmiotu'));
      continue;
    }
    if (options.maxHops < 2 || !search.fetchIncoming || !isQueryableAddress(first.counterparty)) {
      sources.push(entry(first.counterparty, known, 1, 'nadawca bez publicznej etykiety; dalszego kroku wstecz nie wykonano'));
      continue;
    }
    if (!budget.take()) {
      stoppedBy = `wyczerpano budżet ${budget.limit} żądań na pochodzenie środków`;
      sources.push(entry(first.counterparty, known, 1, 'nadawca bez publicznej etykiety; zabrakło budżetu na krok wstecz'));
      break;
    }
    let node: IncomingNode;
    try {
      node = await search.fetchIncoming(first.counterparty, asset);
    } catch (error) {
      if (search.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ChainProviderError && (error.code === 'rate_limited' || error.code === 'timeout')) stoppedBy = `błąd źródła danych — ${reason}`;
      sources.push(entry(first.counterparty, known, 1, `nadawca bez publicznej etykiety; nie udało się pobrać jego historii (${reason})`));
      continue;
    }
    if (node.more || (node.txCount !== undefined && node.txCount > options.maxNodeTxCount)) {
      sources.push(
        entry(first.counterparty, known, 1, `nadawca bez publicznej etykiety o dużej aktywności (${node.txCount ?? 'ponad jedna strona historii'} transakcji) — prawdopodobnie usługa; dalej nie śledzimy`),
      );
      continue;
    }
    // Drugi krok: największy nadawca środków na adres pośredni PRZED przelewem do podmiotu.
    const before = Date.parse(items.at(-1)!.time);
    const earlier = node.incoming.filter((item) => item.direction === 'in' && item.asset === asset && Date.parse(item.time) <= before && normalizeAddress(item.counterparty) !== subject);
    const byOrigin = new Map<string, RawTransfer[]>();
    for (const item of earlier) byOrigin.set(normalizeAddress(item.counterparty), [...(byOrigin.get(normalizeAddress(item.counterparty)) ?? []), item]);
    const top = [...byOrigin.values()].sort((a, b) => b.reduce((s, i) => s + i.amount, 0) - a.reduce((s, i) => s + i.amount, 0))[0];
    if (!top) {
      sources.push(entry(first.counterparty, known, 1, 'nadawca bez publicznej etykiety; w pobranej historii nie widać, skąd sam otrzymał środki'));
      continue;
    }
    const origin = await describe(top[0]!);
    const received = round8(top.reduce((sum, item) => sum + item.amount, 0));
    sources.push(
      entry(
        top[0]!.counterparty,
        origin,
        2,
        `HEURYSTYKA: adres pośredni ${first.counterparty} (bez etykiety) otrzymał wcześniej ${received} ${asset} z tego adresu — to jego największe źródło wpływów` +
          (isKnown(origin) ? '' : '; adres źródłowy też nie ma publicznej etykiety'),
        first.counterparty,
      ),
    );
  }

  if (ranked.length > selected.length) {
    const covered = selected.filter((item) => item.items[0]!.asset === mainAsset).reduce((sum, item) => sum + item.amount, 0);
    limitations.push(
      `Pochodzenie środków: zbadano ${selected.length} z ${ranked.length} nadawców (największe wpływy) — ${Math.round((covered / (totals.get(mainAsset) ?? covered)) * 100)}% wpływów ${mainAsset}.`,
    );
  }
  if (!search.historyComplete) limitations.push('Pochodzenie środków ustalono z pobranej części historii adresu — starsze wpływy nie są uwzględnione.');
  if (stoppedBy) limitations.push(`Pochodzenie środków: analizę przerwano — ${stoppedBy}.`);
  if (sources.length > 0) {
    limitations.push(
      'Pochodzenie środków pokazuje, z jakich adresów przyszły największe wpływy. Etykiety pochodzą ze źródeł publicznych; drugi krok wstecz jest heurystyką ' +
        '(główne źródło wpływów adresu pośredniego) i nie dowodzi, że to te same środki.',
    );
  }
  return { sources: sources.sort((a, b) => b.amount - a.amount), limitations };
}
