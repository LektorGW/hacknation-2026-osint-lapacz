// Prawdopodobny indywidualny adres wpłat na giełdę („jeden krok dalej”).
// Giełdy dają klientom osobne adresy wpłat bez publicznej etykiety i szybko
// zamiatają z nich środki na portfel zbiorczy. Jeśli kontrahent bez etykiety
// wkrótce po otrzymaniu środków przekazał niemal całość na adres oznaczony
// jako giełda, zgłaszamy to jako WNIOSKOWANIE — nie jako ustalony fakt.

import type { Network } from '@olcys/core';
import type { RawTransfer } from './activity.ts';
import { ChainProviderError } from './http.ts';
import type { RequestBudget } from './http.ts';
import { classify, normalizeAddress } from './labels.ts';
import type { LabelSet } from './labels.ts';
import { isQueryableAddress } from './party-labels.ts';
import type { LabelLookup } from './party-labels.ts';

export interface DepositOptions {
  /** Wyłącznik heurystyki; domyślnie działa tam, gdzie dostawca ją obsługuje. */
  enabled?: boolean;
  /** W ciągu ilu godzin od wpłaty środki muszą trafić na giełdę. */
  windowHours?: number;
  /** Ilu kontrahentów (odbiorców największych przelewów) najwyżej badamy. */
  maxCandidates?: number;
  /** Jaka część wpłaconej kwoty musi zostać przekazana na giełdę (0–1). */
  minForwardedShare?: number;
}

export const DEFAULT_DEPOSIT_OPTIONS: Required<DepositOptions> = {
  enabled: true,
  windowHours: 48,
  maxCandidates: 5,
  minForwardedShare: 0.9,
};

/** Łączny budżet żądań do publicznych API na analizę jednego adresu. */
export const DEFAULT_REQUEST_BUDGET = 15;

/** Wynik wnioskowania dla jednego przelewu wychodzącego z badanego adresu. */
export interface InferredDeposit {
  /** Przelew z badanego adresu do adresu pośredniego. */
  txid: string;
  /** Adres pośredni — prawdopodobny indywidualny adres wpłat. */
  counterparty: string;
  asset: string;
  /** Adres i etykieta portfela giełdy, na który trafiły środki. */
  exchangeAddress: string;
  exchangeLabel: string;
  /** Skąd pochodzi etykieta giełdy. */
  exchangeLabelSource: string;
  /** Po ilu godzinach od wpłaty środki zaczęły trafiać na giełdę. */
  hoursToForward: number;
  forwardedAmount: number;
  /** Jaka część wpłaty została przekazana (może przekroczyć 1, gdy adres zbierał kilka wpłat). */
  forwardedShare: number;
  forwardTxid: string;
}

// Zgrubne wagi służą WYŁĄCZNIE do ustalenia kolejności „największych przelewów”
// między różnymi walutami; nie są kursami i nie trafiają do żadnej wyceny.
const ORDER_WEIGHTS: Record<string, number> = { BTC: 300_000, ETH: 10_000, WETH: 10_000, TRX: 1, USDT: 4, USDC: 4, DAI: 4 };

export interface DepositSearch {
  network: Network;
  address: string;
  /** Przelewy badanego adresu (wraz z tym, co źródło wie o kontrahentach). */
  transfers: RawTransfer[];
  labels: LabelSet;
  /** Nazwa źródła danych dostawcy, do opisu pochodzenia etykiety. */
  sourceName: string;
  budget: RequestBudget;
  options?: DepositOptions;
  /** Przelewy WYCHODZĄCE z adresu pośredniego w podanej walucie (jedno żądanie do API). */
  fetchOutgoing(counterparty: string, asset: string): Promise<RawTransfer[]>;
  /** Dodatkowe źródło etykiet dla adresów docelowych (np. WalletExplorer); każde pytanie zużywa budżet. */
  lookup?: LabelLookup;
  signal?: AbortSignal;
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export async function findLikelyDepositAddresses(
  search: DepositSearch,
): Promise<{ deposits: InferredDeposit[]; limitations: string[] }> {
  const options = { ...DEFAULT_DEPOSIT_OPTIONS, ...search.options };
  const { network, labels, budget } = search;
  const subject = normalizeAddress(search.address);
  const deposits: InferredDeposit[] = [];
  const limitations: string[] = [];
  if (!options.enabled) return { deposits, limitations };

  const describe = (transfer: RawTransfer) =>
    classify(network, transfer.counterparty, {
      labels,
      sourceLabel: transfer.counterpartyLabel,
      sourceClass: transfer.counterpartyClass,
      sourceKind: transfer.counterpartyKind,
      sourceName: transfer.counterpartyLabelSource ?? search.sourceName,
      isContract: transfer.counterpartyIsContract,
    });

  // Kandydaci: odbiorcy przelewów wychodzących, o których nic nie wiadomo.
  const byCounterparty = new Map<string, { weight: number; transfers: RawTransfer[] }>();
  for (const transfer of search.transfers) {
    if (transfer.direction !== 'out' || !isQueryableAddress(transfer.counterparty)) continue;
    const weight = ORDER_WEIGHTS[transfer.asset.toUpperCase()];
    if (weight === undefined || transfer.amount <= 0) continue;
    const known = describe(transfer);
    if (known.addressClass !== 'unknown' || known.label || known.kind) continue;
    const group = byCounterparty.get(transfer.counterparty) ?? { weight: 0, transfers: [] };
    group.weight = Math.max(group.weight, transfer.amount * weight);
    group.transfers.push(transfer);
    byCounterparty.set(transfer.counterparty, group);
  }
  const candidates = [...byCounterparty.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const selected = candidates.slice(0, options.maxCandidates);

  const lookedUp = new Map<string, string | undefined>();
  let examined = 0;
  let stoppedBy: string | undefined;

  for (const [counterparty, group] of selected) {
    if (!budget.take()) {
      stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
      break;
    }
    // Badamy walutę największego przelewu do tego kontrahenta.
    const largest = group.transfers.reduce((best, item) =>
      item.amount * ORDER_WEIGHTS[item.asset.toUpperCase()]! > best.amount * ORDER_WEIGHTS[best.asset.toUpperCase()]! ? item : best,
    );
    let outgoing: RawTransfer[];
    try {
      outgoing = (await search.fetchOutgoing(counterparty, largest.asset)).filter(
        (item) => item.direction === 'out' && item.asset === largest.asset && normalizeAddress(item.counterparty) !== subject,
      );
    } catch (error) {
      if (search.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ChainProviderError && (error.code === 'rate_limited' || error.code === 'timeout')) {
        stoppedBy = `błąd źródła danych — ${reason}`;
        break;
      }
      limitations.push(`Nie udało się sprawdzić dalszej drogi środków z adresu ${counterparty}: ${reason}`);
      continue;
    }
    examined += 1;

    for (const deposit of group.transfers.filter((item) => item.asset === largest.asset)) {
      const sentAt = Date.parse(deposit.time);
      const windowEnd = sentAt + options.windowHours * 3_600_000;
      const forwards = outgoing
        .filter((item) => {
          const time = Date.parse(item.time);
          return time >= sentAt && time <= windowEnd && item.txid !== deposit.txid;
        })
        .sort((a, b) => b.amount - a.amount);

      const toExchange: { transfer: RawTransfer; label: string; source: string }[] = [];
      for (const forward of forwards) {
        let known = describe(forward);
        // Źródło danych nie zna adresu docelowego — pytamy serwis etykiet o dwóch największych odbiorców.
        if (
          known.addressClass === 'unknown' &&
          !known.label &&
          search.lookup &&
          isQueryableAddress(forward.counterparty) &&
          forwards.indexOf(forward) < 2
        ) {
          if (!lookedUp.has(forward.counterparty)) {
            if (!budget.take()) {
              stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
              break;
            }
            try {
              lookedUp.set(forward.counterparty, await search.lookup.lookup(forward.counterparty, search.signal));
            } catch (error) {
              if (search.signal?.aborted) throw error;
              lookedUp.set(forward.counterparty, undefined);
              limitations.push(
                `${search.lookup.sourceName}: nie udało się sprawdzić etykiety adresu ${forward.counterparty} ` +
                  `(${error instanceof Error ? error.message : String(error)})`,
              );
            }
          }
          const label = lookedUp.get(forward.counterparty);
          if (label) {
            known = classify(network, forward.counterparty, { labels, sourceLabel: label, sourceName: search.lookup.sourceName });
          }
        }
        if (known.addressClass === 'exchange') {
          toExchange.push({ transfer: forward, label: known.label ?? 'giełda', source: known.classificationSource });
        }
      }

      const forwardedAmount = toExchange.reduce((total, item) => total + item.transfer.amount, 0);
      if (toExchange.length === 0 || forwardedAmount < deposit.amount * options.minForwardedShare) continue;
      const main = toExchange[0]!;
      const first = toExchange.reduce((best, item) => (Date.parse(item.transfer.time) < Date.parse(best.transfer.time) ? item : best));
      deposits.push({
        txid: deposit.txid,
        counterparty,
        asset: deposit.asset,
        exchangeAddress: main.transfer.counterparty,
        exchangeLabel: main.label,
        exchangeLabelSource: main.source,
        hoursToForward: round((Date.parse(first.transfer.time) - sentAt) / 3_600_000, 1),
        forwardedAmount: round(forwardedAmount, 8),
        forwardedShare: round(forwardedAmount / deposit.amount, 2),
        forwardTxid: main.transfer.txid,
      });
    }
    if (stoppedBy) break;
  }

  if (stoppedBy) {
    limitations.push(
      `Wyszukiwanie prawdopodobnych adresów wpłat na giełdy przerwano: ${stoppedBy}. Sprawdzono ${examined} z ` +
        `${candidates.length} kontrahentów bez etykiety — pozostałe przelewy mogły prowadzić na giełdę.`,
    );
  } else if (candidates.length > selected.length) {
    limitations.push(
      `Dalszą drogę środków sprawdzono tylko dla ${selected.length} z ${candidates.length} kontrahentów bez etykiety ` +
        '(odbiorcy największych przelewów) — pozostałe przelewy mogły prowadzić na giełdę.',
    );
  }
  if (deposits.length > 0) {
    limitations.push(
      `Wskaźniki „prawdopodobny adres wpłat na giełdę” (${deposits.length}) są WNIOSKOWANIEM z dalszej drogi środków ` +
        `(okno ${options.windowHours} h, co najmniej ${Math.round(options.minForwardedShare * 100)}% kwoty przekazane na adres ` +
        'oznaczony jako giełda). Adres pośredni może należeć do innej osoby lub usługi — potwierdzenie wymaga danych giełdy.',
    );
  }
  return { deposits, limitations };
}

/** Wyjaśnienie wskaźnika wypłaty opartego na wnioskowaniu. */
export function describeInferredDeposit(deposit: InferredDeposit, amountText: string, windowHours: number): string {
  const hours = deposit.hoursToForward.toLocaleString('pl-PL', { maximumFractionDigits: 1 });
  const share = Math.round(deposit.forwardedShare * 100);
  return (
    `WNIOSKOWANIE (nie ustalony fakt): przelew ${amountText} na adres ${deposit.counterparty}, który nie ma publicznej etykiety. ` +
    `Ten adres pośredni przekazał środki (${share}% kwoty przelewu) do portfela giełdy „${deposit.exchangeLabel}” ` +
    `(${deposit.exchangeAddress}) po ${hours} h, w oknie ${windowHours} h od wpłaty — to prawdopodobny indywidualny adres wpłat ` +
    'klienta giełdy. Giełdy pozwalają sprzedać kryptowaluty i wypłacić pieniądze na rachunek bankowy. ' +
    `Etykieta giełdy: ${deposit.exchangeLabelSource}. Transakcja przekazania: ${deposit.forwardTxid}.`
  );
}
