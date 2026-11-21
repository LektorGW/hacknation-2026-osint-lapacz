// Bitcoin przez publiczne API Esplora (blockstream.info, mempool.space).
// Najwyżej trzy żądania na adres: statystyki oraz dwie strony historii.
// Opcjonalnie: etykiety portfeli z WalletExplorer i dalsza droga środków
// (prawdopodobne adresy wpłat na giełdy) — w ramach wspólnego budżetu żądań.

import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { NATIVE_ASSET, buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { DEFAULT_DEPOSIT_OPTIONS, DEFAULT_REQUEST_BUDGET, findLikelyDepositAddresses } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
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

interface EsploraTx {
  txid: string;
  status?: { confirmed?: boolean; block_time?: number };
  vin?: { is_coinbase?: boolean; prevout?: { scriptpubkey_address?: string; value?: number } | null }[];
  vout?: { scriptpubkey_address?: string; value?: number }[];
}

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
}

/**
 * Sprowadza transakcję do jednego przelewu z punktu widzenia badanego adresu.
 * Zwraca `null` dla transakcji bez wpływu na saldo adresu.
 */
export function esploraTransfer(tx: EsploraTx, address: string, time: string, explorerUrl: string): Omit<RawTransfer, 'asset'> | null {
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

  // Wyjście: kontrahentem jest odbiorca największej kwoty, a kwotą — suma wyjść
  // do obcych adresów, nie większa niż ubytek salda (gdy transakcję współfinansują inni).
  const external = outputs.filter((output) => output.scriptpubkey_address && output.scriptpubkey_address !== address);
  const largest = external.reduce<(typeof external)[number] | undefined>(
    (best, output) => (best === undefined || (output.value ?? 0) > (best.value ?? 0) ? output : best),
    undefined,
  );
  const externalTotal = external.reduce((total, output) => total + (output.value ?? 0), 0);
  const amount = externalTotal > 0 ? Math.min(externalTotal, -net) : -net;
  return {
    txid: tx.txid,
    time,
    direction: 'out',
    counterparty: largest?.scriptpubkey_address ?? 'nieustalony',
    amount: amount / SATOSHI,
    explorerUrl,
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
    };
    this.labelLookup = config.labelLookup;
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.followDeposits = config.followDeposits ?? false;
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
    const budget = new RequestBudget(this.requestBudget);
    const labels = this.options.labels ?? getDefaultLabels();

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
    if (txs.length === PAGE_SIZE && stats.tx_count > PAGE_SIZE) {
      budget.take();
      const next = await fetchJson<EsploraTx[]>(this.fetchImpl, `${api}/txs/chain/${txs.at(-1)!.txid}`, request);
      if (Array.isArray(next)) txs = [...txs, ...next];
    }
    txs = txs.slice(0, TRANSACTION_LIMIT);

    const asset = NATIVE_ASSET[network];
    const transfers: RawTransfer[] = [];
    for (const tx of txs) {
      const time = new Date((tx.status?.block_time ?? 0) * 1000).toISOString();
      const transfer = esploraTransfer(tx, address, time, `${site}/tx/${tx.txid}`);
      if (transfer) transfers.push({ ...transfer, asset });
    }

    const limitations = [
      'Bitcoin: kontrahent transakcji jest uproszczeniem — dla wypłat to odbiorca największej kwoty, ' +
        'dla wpłat pierwszy adres nadawcy. Transakcja może mieć wielu nadawców i odbiorców; zweryfikuj ją w eksploratorze.',
    ];
    const complete = stats.tx_count <= txs.length;
    if (!complete) {
      limitations.push(
        `Pobrano ${txs.length} najnowszych z ${stats.tx_count} transakcji (limit ${TRANSACTION_LIMIT}). ` +
          'Starsze przelewy i wypłaty nie są uwzględnione.',
      );
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
    if (follow) {
      const found = await findLikelyDepositAddresses({
        network,
        address,
        transfers,
        labels,
        sourceName: this.label,
        budget,
        options: this.options.deposit,
        lookup,
        signal: context.signal,
        fetchOutgoing: async (counterparty) => {
          const page = await fetchJson<EsploraTx[]>(this.fetchImpl, `${site}/api/address/${encodeURIComponent(counterparty)}/txs`, request);
          const hop: RawTransfer[] = [];
          for (const tx of Array.isArray(page) ? page : []) {
            if (!tx.status?.confirmed) continue;
            const time = new Date((tx.status.block_time ?? 0) * 1000).toISOString();
            const transfer = esploraTransfer(tx, counterparty, time, `${site}/tx/${tx.txid}`);
            if (transfer) hop.push({ ...transfer, asset });
          }
          return hop;
        },
      });
      inferredDeposits = found.deposits;
      limitations.push(...found.limitations);
    }

    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: false,
        label: subjectLabel,
        ...(subjectLabel ? { labelSource: lookup!.sourceName } : {}),
        inferredDeposits,
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
