// Tron przez publiczne API TronGrid (bez klucza). Trzy żądania na adres:
// konto, transakcje (przelewy TRX) i transfery tokenów TRC-20. TronGrid nie podaje
// etykiet, więc opcjonalnie pytamy TronScan o publiczne znaczniki adresów
// i badamy dalszą drogę środków — w ramach wspólnego budżetu żądań.

import { createHash } from 'node:crypto';
import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { DEFAULT_DEPOSIT_OPTIONS, DEFAULT_REQUEST_BUDGET, findLikelyDepositAddresses } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
import { ChainProviderError, RequestBudget, fetchJson, fromBaseUnits } from '../http.ts';
import type { FetchLike } from '../http.ts';
import { getDefaultLabels } from '../labels.ts';
import type { LabelSet } from '../labels.ts';
import { lookupPartyLabels } from '../party-labels.ts';
import type { LabelLookup } from '../party-labels.ts';
import { verifiedTokenSymbol } from './blockscout.ts';

interface TronGridPage<T> {
  data?: T[];
  meta?: { fingerprint?: string };
}

interface TronAccount {
  balance?: number;
  type?: string;
}

interface TronTransaction {
  txID: string;
  block_timestamp?: number;
  ret?: { contractRet?: string }[];
  raw_data?: {
    contract?: {
      type?: string;
      parameter?: { value?: { amount?: number; owner_address?: string; to_address?: string } };
    }[];
  };
}

interface Trc20Transfer {
  transaction_id: string;
  block_timestamp?: number;
  from?: string;
  to?: string;
  value?: string;
  token_info?: { symbol?: string; address?: string; decimals?: number };
}

export const TRANSACTION_LIMIT = 50;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

/** TronGrid podaje strony przelewu TRX szesnastkowo (`41…`); zamieniamy na zapis Base58Check. */
export function tronHexToBase58(hex: string): string {
  const payload = Buffer.from(hex, 'hex');
  const bytes = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let value = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export interface TronGridProviderConfig extends ActivityOptions {
  /** Adres API, domyślnie `https://api.trongrid.io`. */
  apiUrl?: string;
  /** Adres strony eksploratora do odnośników, domyślnie `https://tronscan.org`. */
  explorerUrl?: string;
  fetch?: FetchLike;
  /** Źródło publicznych znaczników adresów (TronScan). */
  labelLookup?: LabelLookup;
  /** Łączny budżet żądań na analizę jednego adresu. */
  requestBudget?: number;
  /** Czy badać dalszą drogę środków (prawdopodobne adresy wpłat na giełdy); domyślnie nie. */
  followDeposits?: boolean;
}

export class TronGridProvider implements ChainProvider {
  id = 'trongrid';
  label = 'TronGrid (Tron)';
  apiUrl: string;
  explorerUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  labelLookup: LabelLookup | undefined;
  requestBudget: number;
  followDeposits: boolean;

  constructor(config: TronGridProviderConfig = {}) {
    this.apiUrl = (config.apiUrl ?? 'https://api.trongrid.io').replace(/\/+$/, '');
    this.explorerUrl = (config.explorerUrl ?? 'https://tronscan.org').replace(/\/+$/, '');
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
    return network === 'tron';
  }

  private link(txid: string): string {
    return `${this.explorerUrl}/#/transaction/${txid}`;
  }

  private nativeTransfers(items: TronTransaction[], address: string): RawTransfer[] {
    const transfers: RawTransfer[] = [];
    for (const tx of items) {
      const contract = tx.raw_data?.contract?.[0];
      const value = contract?.parameter?.value;
      // Interesują nas tylko udane, zwykłe przelewy TRX; wywołania kontraktów widać w transferach TRC-20.
      if (contract?.type !== 'TransferContract' || !value?.owner_address || !value.to_address) continue;
      if (tx.ret?.[0]?.contractRet !== undefined && tx.ret[0].contractRet !== 'SUCCESS') continue;
      if (!tx.block_timestamp || !value.amount) continue;
      const from = tronHexToBase58(value.owner_address);
      const to = tronHexToBase58(value.to_address);
      const outgoing = from === address;
      transfers.push({
        txid: tx.txID,
        time: new Date(tx.block_timestamp).toISOString(),
        direction: outgoing ? 'out' : 'in',
        counterparty: outgoing ? to : from,
        asset: 'TRX',
        amount: fromBaseUnits(value.amount, 6),
        explorerUrl: this.link(tx.txID),
      });
    }
    return transfers;
  }

  private tokenTransfers(items: Trc20Transfer[], address: string, labels: LabelSet, network: Network): RawTransfer[] {
    const transfers: RawTransfer[] = [];
    for (const item of items) {
      if (!item.block_timestamp || !item.value || !item.from || !item.to) continue;
      const outgoing = item.from === address;
      transfers.push({
        txid: item.transaction_id,
        time: new Date(item.block_timestamp).toISOString(),
        direction: outgoing ? 'out' : 'in',
        counterparty: outgoing ? item.to : item.from,
        asset: verifiedTokenSymbol(labels, network, item.token_info?.address, item.token_info?.symbol),
        amount: fromBaseUnits(item.value, item.token_info?.decimals ?? 0),
        explorerUrl: this.link(item.transaction_id),
      });
    }
    return transfers;
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    const labels = this.options.labels ?? getDefaultLabels();
    const api = `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}`;
    const request = { source: this.label, signal: context.signal };
    const budget = new RequestBudget(this.requestBudget);
    budget.used += 3;

    const [account, transactions, tokenTransfers] = await Promise.all([
      fetchJson<TronGridPage<TronAccount>>(this.fetchImpl, api, request),
      fetchJson<TronGridPage<TronTransaction>>(
        this.fetchImpl,
        `${api}/transactions?limit=${TRANSACTION_LIMIT}&only_confirmed=true`,
        request,
      ),
      fetchJson<TronGridPage<Trc20Transfer>>(
        this.fetchImpl,
        `${api}/transactions/trc20?limit=${TRANSACTION_LIMIT}&only_confirmed=true`,
        request,
      ),
    ]);
    if (!Array.isArray(account.data) || !Array.isArray(transactions.data) || !Array.isArray(tokenTransfers.data)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź w nieoczekiwanym formacie.`);
    }

    const transfers = [
      ...this.nativeTransfers(transactions.data, address),
      ...this.tokenTransfers(tokenTransfers.data, address, labels, network),
    ];

    const truncated = Boolean(transactions.meta?.fingerprint) || Boolean(tokenTransfers.meta?.fingerprint);
    const limitations = [
      'Tron: uwzględniono zwykłe przelewy TRX i transfery tokenów TRC-20. TronGrid nie podaje etykiet adresów ' +
        'ani informacji, czy kontrahent jest kontraktem' +
        (this.labelLookup
          ? ` — etykiety pochodzą ze zbioru etykiet i z publicznych znaczników ${this.labelLookup.sourceName} (bez adresów kontraktów).`
          : ' — klasyfikacja kontrahentów opiera się wyłącznie na zbiorze etykiet.'),
      'Liczba transakcji i sumy wpływów/wydatków TRX są liczone z pobranych przelewów, nie z całej historii adresu.',
    ];
    if (truncated) {
      limitations.push(
        `Pobrano po ${TRANSACTION_LIMIT} najnowszych transakcji i transferów tokenów (limit). ` +
          'Starsze przelewy i wypłaty nie są uwzględnione.',
      );
    }

    const lookup = this.labelLookup;
    const follow = this.followDeposits && (this.options.deposit?.enabled ?? DEFAULT_DEPOSIT_OPTIONS.enabled);
    let subjectLabel: string | undefined;
    if (lookup) {
      subjectLabel = await lookupPartyLabels({
        lookup,
        network,
        address,
        transfers,
        labels,
        budget,
        reserve: follow ? 4 : 0,
        signal: context.signal,
        limitations,
      });
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
        fetchOutgoing: async (counterparty, asset) => {
          const hop = `${this.apiUrl}/v1/accounts/${encodeURIComponent(counterparty)}/transactions`;
          const query = `limit=${TRANSACTION_LIMIT}&only_confirmed=true&only_from=true`;
          if (asset === 'TRX') {
            const page = await fetchJson<TronGridPage<TronTransaction>>(this.fetchImpl, `${hop}?${query}`, request);
            return this.nativeTransfers(page.data ?? [], counterparty);
          }
          const page = await fetchJson<TronGridPage<Trc20Transfer>>(this.fetchImpl, `${hop}/trc20?${query}`, request);
          return this.tokenTransfers(page.data ?? [], counterparty, labels, network);
        },
      });
      inferredDeposits = found.deposits;
      limitations.push(...found.limitations);
    }

    const info = account.data[0];
    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: info?.type === 'Contract',
        label: subjectLabel,
        ...(subjectLabel ? { labelSource: lookup!.sourceName } : {}),
        inferredDeposits,
        balance: fromBaseUnits(info?.balance ?? 0, 6),
        historyComplete: !truncated,
        transfers,
        limitations,
      },
      this.options,
    );
  }
}
