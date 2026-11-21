// Bitcoin przez publiczne API Esplora (blockstream.info, mempool.space).
// Najwyżej trzy żądania na adres: statystyki oraz dwie strony historii.
// Opcjonalnie: etykiety portfeli z WalletExplorer i dalsza droga środków
// (prawdopodobne adresy wpłat na giełdy) — w ramach wspólnego budżetu żądań.

import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { NATIVE_ASSET, buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { CLUSTER_METHOD_UTXO, detectChange } from '../cluster.ts';
import type { UtxoTx } from '../cluster.ts';
import { DEFAULT_DEPOSIT_OPTIONS, DEFAULT_REQUEST_BUDGET } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
import { traceUtxoFlows } from '../trace.ts';
import type { TracedTrail } from '../trace.ts';
import { describeRange, inHistoryRange, linkBudgetLimit, planHistory, traceBudgetLimit } from '../history.ts';
import type { HistoryOptions } from '../history.ts';
import { DEFAULT_LINK_BUDGET, findLinkedAddresses } from '../links.ts';
import type { LinkOptions, LinkSearch, LinkedAddress } from '../links.ts';
import { DEFAULT_FUNDING_BUDGET, traceFundingSources } from '../funding.ts';
import type { FundingSource } from '../funding.ts';
import { getDefaultSanctions } from '../ofac.ts';
import { ChainProviderError, RequestBudget, fetchJson } from '../http.ts';
import type { FetchLike } from '../http.ts';
import { getDefaultLabels } from '../labels.ts';
import { lookupPartyLabels } from '../party-labels.ts';
import type { LabelLookup } from '../party-labels.ts';

interface EsploraStats {
  funded_txo_sum: number;
  spent_txo_sum: number;
  tx_count: number;
}

interface EsploraAddress {
  chain_stats?: EsploraStats;
}

type EsploraTx = UtxoTx;

export const TRANSACTION_LIMIT = 50;
/** Esplora zwraca potwierdzone transakcje stronami po 25. */
const PAGE_SIZE = 25;
const SATOSHI = 1e8;

export interface EsploraProviderConfig extends ActivityOptions {
  id: string;
  label: string;
  /** Adres strony eksploratora sieci głównej, np. `https://blockstream.info`. */
  siteUrl: string;
  /** Adres strony eksploratora sieci testowej; bez niego dostawca obsługuje tylko sieć główną. */
  testnetSiteUrl?: string;
  fetch?: FetchLike;
  /** Źródło etykiet portfeli (WalletExplorer); używane tylko w sieci głównej. */
  labelLookup?: LabelLookup;
  /** Łączny budżet żądań na analizę jednego adresu. */
  requestBudget?: number;
  /** Czy badać dalszą drogę środków (prawdopodobne adresy wpłat na giełdy); domyślnie nie. */
  followDeposits?: boolean;
  /** Czy szukać powiązanych adresów (inne adresy tej samej osoby); domyślnie nie. */
  findLinks?: boolean;
  /** Osobny budżet żądań na szukanie powiązań (domyślnie 12). */
  linkBudget?: number;
  links?: LinkOptions;
  /** Osobny budżet żądań na pochodzenie środków (domyślnie 8). */
  fundingBudget?: number;
  /** Domyślny zakres historii; kontekst wywołania może go zmienić dla pojedynczego adresu. */
  history?: HistoryOptions;
  /** Zapasowy eksplorator sieci głównej z tym samym API (np. `https://mempool.space`) — używany, gdy podstawowy zwróci błąd przy stronicowaniu. */
  fallbackSiteUrl?: string;
}

/** Czego jeden „przelew” nie mówi o transakcji Bitcoin — trafia do ograniczeń, nie do listy przelewów. */
export interface EsploraTransferNotes {
  /** Adres uznany heurystycznie za resztę wracającą do portfela nadawcy. */
  changeAddress?: string;
  /** Liczba pozostałych odbiorców tej samej transakcji i łączna kwota do nich (BTC). */
  otherRecipients?: number;
  otherAmount?: number;
}

/**
 * Sprowadza transakcję do jednego przelewu z punktu widzenia badanego adresu.
 * Zwraca `null` dla transakcji bez wpływu na saldo adresu.
 */
export function esploraTransfer(
  tx: EsploraTx,
  address: string,
  time: string,
  explorerUrl: string,
): (Omit<RawTransfer, 'asset'> & EsploraTransferNotes) | null {
  const inputs = tx.vin ?? [];
  const outputs = tx.vout ?? [];
  const spent = inputs
    .filter((input) => input.prevout?.scriptpubkey_address === address)
    .reduce((total, input) => total + (input.prevout?.value ?? 0), 0);
  const received = outputs
    .filter((output) => output.scriptpubkey_address === address)
    .reduce((total, output) => total + (output.value ?? 0), 0);
  const net = received - spent;
  if (net === 0) return null;

  if (net > 0) {
    const sender = inputs.find((input) => {
      const from = input.prevout?.scriptpubkey_address;
      return from !== undefined && from !== address;
    });
    const counterparty = sender?.prevout?.scriptpubkey_address ?? (inputs[0]?.is_coinbase ? 'coinbase (nagroda za blok)' : 'nieustalony');
    return { txid: tx.txid, time, direction: 'in', counterparty, amount: net / SATOSHI, explorerUrl };
  }

  // Wyjście: kontrahentem jest odbiorca największej kwoty, a kwotą — to, co trafiło DO TEGO kontrahenta
  // (suma wyjść na jego adres), nie więcej niż ubytek salda (gdy transakcję współfinansują inni).
  // Kwot wysłanych w tej samej transakcji do innych odbiorców nie wolno przypisać kontrahentowi —
  // inaczej przelew na giełdę byłby zawyżony o płatności do osób trzecich.
  // Wyjście rozpoznane jako RESZTA wracająca do portfela nadawcy (heurystyka z `cluster.ts`: dwa wyjścia,
  // wszystkie wejścia z badanego adresu) nie jest płatnością — nie może zostać kontrahentem ani wejść do kwoty.
  const change = detectChange(tx, new Set([address]));
  const external = outputs.filter(
    (output, index) => output.scriptpubkey_address && output.scriptpubkey_address !== address && index !== change?.changeIndex,
  );
  const largest = external.reduce<(typeof external)[number] | undefined>(
    (best, output) => (best === undefined || (output.value ?? 0) > (best.value ?? 0) ? output : best),
    undefined,
  );
  const toCounterparty = external
    .filter((output) => output.scriptpubkey_address === largest?.scriptpubkey_address)
    .reduce((total, output) => total + (output.value ?? 0), 0);
  const others = external.filter((output) => output.scriptpubkey_address !== largest?.scriptpubkey_address);
  const amount = toCounterparty > 0 ? Math.min(toCounterparty, -net) : -net;
  return {
    txid: tx.txid,
    time,
    direction: 'out',
    counterparty: largest?.scriptpubkey_address ?? 'nieustalony',
    amount: amount / SATOSHI,
    explorerUrl,
    ...(change && change.changeAddress !== address ? { changeAddress: change.changeAddress } : {}),
    ...(others.length > 0
      ? { otherRecipients: new Set(others.map((output) => output.scriptpubkey_address)).size, otherAmount: others.reduce((total, output) => total + (output.value ?? 0), 0) / SATOSHI }
      : {}),
  };
}

export class EsploraProvider implements ChainProvider {
  id: string;
  label: string;
  siteUrl: string;
  testnetSiteUrl: string | undefined;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  labelLookup: LabelLookup | undefined;
  requestBudget: number;
  followDeposits: boolean;
  findLinks: boolean;
  linkBudget: number;
  linkOptions: LinkOptions | undefined;
  /** Osobny budżet żądań na pochodzenie środków. */
  fundingBudget: number;
  history: HistoryOptions;
  fallbackSiteUrl: string | undefined;

  constructor(config: EsploraProviderConfig) {
    this.id = config.id;
    this.label = config.label;
    this.siteUrl = config.siteUrl.replace(/\/+$/, '');
    this.testnetSiteUrl = config.testnetSiteUrl?.replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.options = {
      labels: config.labels,
      rateSource: config.rateSource,
      cashOut: config.cashOut,
      sanctions: config.sanctions,
      deposit: config.deposit,
      trace: config.trace,
    };
    this.labelLookup = config.labelLookup;
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.followDeposits = config.followDeposits ?? false;
    this.findLinks = config.findLinks ?? false;
    this.linkBudget = config.linkBudget ?? DEFAULT_LINK_BUDGET;
    this.linkOptions = config.links;
    this.fundingBudget = config.fundingBudget ?? DEFAULT_FUNDING_BUDGET;
    this.history = config.history ?? {};
    this.fallbackSiteUrl = config.fallbackSiteUrl?.replace(/\/+$/, '');
  }

  supports(network: Network): boolean {
    return network === 'bitcoin' || (network === 'bitcoin-testnet' && this.testnetSiteUrl !== undefined);
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    const site = network === 'bitcoin-testnet' ? this.testnetSiteUrl : this.siteUrl;
    if (!this.supports(network) || site === undefined) {
      throw new ChainProviderError('unavailable', `${this.label}: sieć ${network} nie jest obsługiwana.`);
    }
    const api = `${site}/api/address/${encodeURIComponent(address)}`;
    const request = { source: this.label, signal: context.signal };
    const budget = new RequestBudget(traceBudgetLimit(context, this.requestBudget));
    const labels = this.options.labels ?? getDefaultLabels();
    const plan = planHistory(context, this.history);
    const full = plan.mode === 'full';

    budget.take();
    const summary = await fetchJson<EsploraAddress>(this.fetchImpl, api, request);
    const stats = summary.chain_stats;
    if (!stats || typeof stats.tx_count !== 'number') {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź bez statystyk adresu.`);
    }

    if (stats.tx_count > 0) budget.take();
    const firstPage = stats.tx_count > 0 ? await fetchJson<EsploraTx[]>(this.fetchImpl, `${api}/txs`, request) : [];
    if (!Array.isArray(firstPage)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź bez listy transakcji.`);
    }
    const unconfirmed = firstPage.filter((tx) => !tx.status?.confirmed).length;
    let txs = firstPage.filter((tx) => tx.status?.confirmed);

    // Kolejne strony (po 25, od najnowszych): w trybie `recent` jedna, w trybie `full` — aż do końca
    // historii, limitu żądań albo wyjścia poza początek analizowanego okresu.
    let lastPageSize = txs.length;
    let historyRequests = stats.tx_count > 0 ? 1 : 0;
    let stoppedBy: string | undefined;
    let usedFallback = false;
    const fallback = network === 'bitcoin' && this.fallbackSiteUrl !== site ? this.fallbackSiteUrl : undefined;
    while (lastPageSize === PAGE_SIZE && stats.tx_count > txs.length && (full || txs.length < TRANSACTION_LIMIT)) {
      const oldest = (txs.at(-1)!.status?.block_time ?? 0) * 1000;
      if (plan.since !== undefined && oldest < plan.since) {
        stoppedBy = `dalsze transakcje są starsze niż początek analizowanego okresu (${describeRange(plan)})`;
        break;
      }
      if (full ? !plan.budget.take() : !budget.take()) {
        stoppedBy = `limit ${plan.budget.limit} żądań o kolejne strony historii`;
        break;
      }
      const path = `/api/address/${encodeURIComponent(address)}/txs/chain/${txs.at(-1)!.txid}`;
      let next: EsploraTx[];
      try {
        next = await fetchJson<EsploraTx[]>(this.fetchImpl, `${site}${path}`, request);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        const reason = error instanceof Error ? error.message : String(error);
        if (!fallback) {
          stoppedBy = `błąd przy pobieraniu kolejnej strony historii — ${reason}`;
          break;
        }
        // Ten sam interfejs API ma drugi publiczny eksplorator — kontynuujemy od tego samego miejsca.
        try {
          next = await fetchJson<EsploraTx[]>(this.fetchImpl, `${fallback}${path}`, { ...request, source: `${this.label} (zapas: ${fallback})` });
          usedFallback = true;
        } catch (second) {
          if (context.signal?.aborted) throw second;
          stoppedBy = `błąd przy pobieraniu kolejnej strony historii — ${reason}; zapasowy eksplorator też nie odpowiedział`;
          break;
        }
      }
      if (!Array.isArray(next)) break;
      historyRequests += 1;
      lastPageSize = next.length;
      txs = [...txs, ...next];
    }
    if (!full) txs = txs.slice(0, TRANSACTION_LIMIT);
    const fetchedCount = txs.length;
    const ranged = plan.since !== undefined || plan.until !== undefined;
    if (ranged) txs = txs.filter((tx) => inHistoryRange(plan, (tx.status?.block_time ?? 0) * 1000));

    const asset = NATIVE_ASSET[network];
    const transfers: RawTransfer[] = [];
    // Dokładne zmiany salda (z opłatami): otrzymane wyjścia minus wydane wejścia w każdej transakcji.
    const flows: { asset: string; time: string; delta: number }[] = [];
    let changeSkipped = 0;
    const multiRecipient = { count: 0, recipients: 0, satoshi: 0 };
    for (const tx of txs) {
      const time = new Date((tx.status?.block_time ?? 0) * 1000).toISOString();
      const described = esploraTransfer(tx, address, time, `${site}/tx/${tx.txid}`);
      if (described) {
        const { changeAddress, otherRecipients, otherAmount, ...transfer } = described;
        if (changeAddress) changeSkipped += 1;
        if (otherRecipients) {
          multiRecipient.count += 1;
          multiRecipient.recipients += otherRecipients;
          multiRecipient.satoshi += Math.round((otherAmount ?? 0) * SATOSHI);
        }
        transfers.push({ ...transfer, asset });
      }
      const received = (tx.vout ?? []).filter((output) => output.scriptpubkey_address === address).reduce((sum, output) => sum + (output.value ?? 0), 0);
      const spent = (tx.vin ?? []).filter((input) => input.prevout?.scriptpubkey_address === address).reduce((sum, input) => sum + (input.prevout?.value ?? 0), 0);
      if (received !== spent) flows.push({ asset, time, delta: (received - spent) / SATOSHI });
    }

    const limitations = [
      'Bitcoin: kontrahent transakcji jest uproszczeniem — dla wypłat to odbiorca największej kwoty, ' +
        'dla wpłat pierwszy adres nadawcy. Transakcja może mieć wielu nadawców i odbiorców; zweryfikuj ją w eksploratorze.',
    ];
    if (changeSkipped > 0) {
      limitations.push(
        `Bitcoin: w ${changeSkipped} transakcjach wychodzących jedno z dwóch wyjść uznano HEURYSTYCZNIE za resztę wracającą do portfela nadawcy ` +
          '(typ skryptu zgodny z wejściem albo „nieokrągła” kwota) — nie jest liczone jako płatność ani jako kontrahent. Kwota przelewu to wtedy samo wyjście-płatność; ' +
          'gdy heurystyka się myli, faktycznym odbiorcą jest drugie wyjście (do weryfikacji w eksploratorze).',
      );
    }
    if (multiRecipient.count > 0) {
      limitations.push(
        `Bitcoin: ${multiRecipient.count} transakcji wychodzących miało więcej niż jednego odbiorcę. Na liście przelewów jest odbiorca największej kwoty z kwotą, która trafiła do niego; ` +
          `pozostałe wyjścia (łącznie ${multiRecipient.satoshi / SATOSHI} BTC do ${multiRecipient.recipients} adresów) nie są pokazane jako osobne przelewy ani przypisane temu odbiorcy — ` +
          'pełny podział jest w eksploratorze, a śledzenie środków bada wyjścia osobno.',
      );
    }
    const complete = stats.tx_count <= fetchedCount && !ranged;
    if (full) {
      limitations.push(
        `Tryb pełnej historii: pobrano ${fetchedCount} z ${stats.tx_count} transakcji adresu w ${historyRequests} żądaniach` +
          (stoppedBy ? ` — stronicowanie przerwano: ${stoppedBy}. Starsze przelewy i wypłaty nie są uwzględnione.` : ' (cała historia).') +
          (usedFallback ? ` Część stron pobrano z zapasowego eksploratora ${fallback}.` : ''),
      );
    } else if (stats.tx_count > fetchedCount) {
      limitations.push(
        `Pobrano ${fetchedCount} najnowszych z ${stats.tx_count} transakcji (limit ${TRANSACTION_LIMIT}). ` +
          'Starsze przelewy i wypłaty nie są uwzględnione — pełną historię włącza opcja `history: \'full\'`.',
      );
    }
    if (ranged) {
      limitations.push(`Analiza ograniczona do okresu ${describeRange(plan)}: uwzględniono ${txs.length} z ${fetchedCount} pobranych transakcji.`);
    }
    if (unconfirmed > 0) {
      limitations.push(`Pominięto ${unconfirmed} transakcji oczekujących na potwierdzenie.`);
    }

    // Etykiety i dalsza droga środków tylko w sieci głównej — monety testowe nie trafiają na giełdy.
    const mainnet = network === 'bitcoin';
    const lookup = mainnet ? this.labelLookup : undefined;
    const follow = mainnet && this.followDeposits && (this.options.deposit?.enabled ?? DEFAULT_DEPOSIT_OPTIONS.enabled);
    let subjectLabel: string | undefined;
    if (lookup) {
      subjectLabel = await lookupPartyLabels({
        lookup,
        network,
        address,
        transfers,
        labels,
        budget,
        // Zostawiamy miejsce na zbadanie dwóch adresów pośrednich (historia + etykieta odbiorcy).
        reserve: follow ? 4 : 0,
        signal: context.signal,
        limitations,
      });
      limitations.push(
        `Etykiety ${lookup.sourceName} dotyczą portfeli wyznaczonych heurystyką wspólnego wydawania środków — ` +
          'przypisanie adresu do portfela jest oszacowaniem serwisu, nie potwierdzeniem właściciela.',
      );
    }

    let inferredDeposits: InferredDeposit[] = [];
    let trails: TracedTrail[] = [];
    let openQuestions: { txid: string; text: string }[] = [];
    let clusterAddresses: { address: string; reason: string; txid?: string }[] = [];
    const traceOptions = { ...this.options.deposit, ...this.options.trace };
    if (mainnet) {
      // Bez `followDeposits` budujemy tylko klaster z już pobranych transakcji (bez dodatkowych żądań).
      const found = await traceUtxoFlows({
        network,
        address,
        txs,
        labels,
        sourceName: this.label,
        budget,
        options: { ...traceOptions, enabled: follow },
        lookup,
        signal: context.signal,
        pageSize: PAGE_SIZE,
        txUrl: (txid) => `${site}/tx/${txid}`,
        fetchTxs: async (other) => {
          const page = await fetchJson<EsploraTx[]>(this.fetchImpl, `${site}/api/address/${encodeURIComponent(other)}/txs`, request);
          return Array.isArray(page) ? page : [];
        },
        fetchTxCount: async (other) => {
          const info = await fetchJson<EsploraAddress>(this.fetchImpl, `${site}/api/address/${encodeURIComponent(other)}`, request);
          return info.chain_stats?.tx_count;
        },
      });
      inferredDeposits = found.deposits;
      trails = found.trails;
      openQuestions = found.openQuestions;
      clusterAddresses = found.clusterAddresses;
      limitations.push(...found.limitations);
    }

    const cluster = mainnet ? { seed: address, network, addresses: clusterAddresses, method: CLUSTER_METHOD_UTXO } : undefined;
    let linkedAddresses: LinkedAddress[] = [];
    let fundingSources: FundingSource[] = [];
    if (mainnet && this.findLinks) {
      const linkSearch: LinkSearch = {
        network,
        address,
        transfers,
        deposits: inferredDeposits,
        cluster,
        historyComplete: complete,
        labels,
        sourceName: this.label,
        budget: new RequestBudget(linkBudgetLimit(context, this.linkBudget)),
        options: this.linkOptions,
        signal: context.signal,
        fetchIncoming: async (other) => {
          const page = await fetchJson<EsploraTx[]>(this.fetchImpl, `${site}/api/address/${encodeURIComponent(other)}/txs`, request);
          const incoming: RawTransfer[] = [];
          for (const tx of Array.isArray(page) ? page : []) {
            if (!tx.status?.confirmed) continue;
            const time = new Date((tx.status.block_time ?? 0) * 1000).toISOString();
            const transfer = esploraTransfer(tx, other, time, `${site}/tx/${tx.txid}`);
            if (transfer?.direction === 'in') {
              const { changeAddress: _change, otherRecipients: _count, otherAmount: _amount, ...rest } = transfer;
              incoming.push({ ...rest, asset });
            }
          }
          return { incoming, more: Array.isArray(page) && page.filter((tx) => tx.status?.confirmed).length >= PAGE_SIZE };
        },
        countTransactions: async (other) => {
          const info = await fetchJson<EsploraAddress>(this.fetchImpl, `${site}/api/address/${encodeURIComponent(other)}`, request);
          return info.chain_stats?.tx_count;
        },
      };
      const found = await findLinkedAddresses(linkSearch);
      linkedAddresses = found.links;
      limitations.push(...found.limitations);
      // Pochodzenie środków: te same zapytania o przelewy przychodzące, osobny budżet.
      const funding = await traceFundingSources({
        network,
        address,
        transfers,
        txCount: stats.tx_count,
        historyComplete: complete,
        labels,
        sanctions: this.options.sanctions ?? getDefaultSanctions(),
        sourceName: this.label,
        budget: new RequestBudget(this.fundingBudget),
        fetchIncoming: linkSearch.fetchIncoming,
        signal: context.signal,
        lookup,
      });
      fundingSources = funding.sources;
      limitations.push(...funding.limitations);
    }

    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: false,
        linkedAddresses,
        fundingSources,
        ...(mainnet
          ? {
              balanceInputs: {
                current: [{ asset, amount: (stats.funded_txo_sum - stats.spent_txo_sum) / SATOSHI }],
                flows,
                complete: complete ? [asset] : [],
                networkName: 'Bitcoin',
              },
            }
          : {}),
        label: subjectLabel,
        ...(subjectLabel ? { labelSource: lookup!.sourceName } : {}),
        inferredDeposits,
        trails,
        openQuestions,
        ...(cluster ? { cluster } : {}),
        txCount: stats.tx_count,
        totalReceived: stats.funded_txo_sum / SATOSHI,
        totalSent: stats.spent_txo_sum / SATOSHI,
        balance: (stats.funded_txo_sum - stats.spent_txo_sum) / SATOSHI,
        historyComplete: complete,
        transfers,
        limitations,
      },
      this.options,
    );
  }
}
