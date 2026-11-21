// Tron przez publiczne API TronGrid (bez klucza). Trzy żądania na adres:
// konto, transakcje (przelewy TRX) i transfery tokenów TRC-20. TronGrid nie podaje
// etykiet, więc opcjonalnie pytamy TronScan o publiczne znaczniki adresów
// i badamy dalszą drogę środków — w ramach wspólnego budżetu żądań.

import { createHash } from 'node:crypto';
import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { accountCluster } from '../cluster.ts';
import { DEFAULT_DEPOSIT_OPTIONS, DEFAULT_REQUEST_BUDGET } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
import { traceAccountFlows } from '../trace.ts';
import type { ExpandedNode, TracedTrail } from '../trace.ts';
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

/** Transfer TRC-20 w układzie TronScan (`/api/token_trc20/transfers`) — zawiera publiczne znaczniki stron. */
interface TronScanTransfer {
  transaction_id?: string;
  block_ts?: number;
  from_address?: string;
  to_address?: string;
  quant?: string;
  confirmed?: boolean;
  contractRet?: string;
  finalResult?: string;
  tokenInfo?: { tokenId?: string; tokenAbbr?: string; tokenDecimal?: number };
  from_address_tag?: { from_address_tag?: string };
  to_address_tag?: { to_address_tag?: string };
  fromAddressIsContract?: boolean;
  toAddressIsContract?: boolean;
}

interface TronScanTransferPage {
  total?: number;
  token_transfers?: TronScanTransfer[];
}

export const TRANSACTION_LIMIT = 50;
export const TRONSCAN_LABEL_SOURCE = 'TronScan';
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
  /**
   * Adres API TronScan, np. `https://apilist.tronscanapi.com`. Gdy podany, transfery TRC-20
   * pochodzą z TronScan — razem z publicznymi znacznikami kontrahentów (bez dodatkowych żądań);
   * przy błędzie TronScan dostawca wraca do TronGrid.
   */
  tronScanUrl?: string;
  /**
   * Tryb głęboki: dodatkowe żądanie o 50 najnowszych transferów TRC-20 WYCHODZĄCYCH z adresu —
   * przy aktywnych adresach przychodzące transfery (także spam) wypychają wypłaty z pierwszej strony.
   */
  extraOutgoing?: boolean;
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
  tronScanUrl: string | undefined;
  extraOutgoing: boolean;
  /** Symbol zweryfikowanego tokena → adres kontraktu (do zawężania zapytań o adresy pośrednie). */
  private tokenContracts = new Map<string, string>();

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
      trace: config.trace,
    };
    this.labelLookup = config.labelLookup;
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.followDeposits = config.followDeposits ?? false;
    this.tronScanUrl = config.tronScanUrl?.replace(/\/+$/, '');
    this.extraOutgoing = config.extraOutgoing ?? false;
  }

  /** Transfery TRC-20 adresu z TronScan wraz ze znacznikami stron; `total` to liczba transferów adresu. */
  private async tronScanTransfers(
    address: string,
    labels: LabelSet,
    network: Network,
    signal: AbortSignal | undefined,
    contract?: string,
    range?: { since: number; until: number },
  ): Promise<{ transfers: RawTransfer[]; full: boolean }> {
    const page = await fetchJson<TronScanTransferPage>(
      this.fetchImpl,
      `${this.tronScanUrl}/api/token_trc20/transfers?relatedAddress=${encodeURIComponent(address)}&limit=${TRANSACTION_LIMIT}&start=0` +
        (contract ? `&contract_address=${encodeURIComponent(contract)}` : '') +
        (range ? `&start_timestamp=${range.since}&end_timestamp=${range.until}` : ''),
      { source: TRONSCAN_LABEL_SOURCE, signal },
    );
    if (!Array.isArray(page.token_transfers)) {
      throw new ChainProviderError('invalid_response', `${TRONSCAN_LABEL_SOURCE}: odpowiedź bez listy transferów.`);
    }
    const transfers: RawTransfer[] = [];
    for (const item of page.token_transfers) {
      if (!item.transaction_id || !item.block_ts || !item.quant || !item.from_address || !item.to_address) continue;
      if (item.confirmed === false || (item.finalResult ?? item.contractRet ?? 'SUCCESS') !== 'SUCCESS') continue;
      const outgoing = item.from_address === address;
      const tag = (outgoing ? item.to_address_tag?.to_address_tag : item.from_address_tag?.from_address_tag)?.trim();
      const asset = verifiedTokenSymbol(labels, network, item.tokenInfo?.tokenId, item.tokenInfo?.tokenAbbr);
      if (item.tokenInfo?.tokenId && !asset.includes('niezweryfikowany')) this.tokenContracts.set(asset, item.tokenInfo.tokenId);
      transfers.push({
        txid: item.transaction_id,
        time: new Date(item.block_ts).toISOString(),
        direction: outgoing ? 'out' : 'in',
        counterparty: outgoing ? item.to_address : item.from_address,
        asset,
        amount: fromBaseUnits(item.quant, item.tokenInfo?.tokenDecimal ?? 0),
        explorerUrl: this.link(item.transaction_id),
        counterpartyIsContract: (outgoing ? item.toAddressIsContract : item.fromAddressIsContract) === true,
        // TronScan podał wszystko, co publicznie wie o kontrahencie — nie pytamy o niego ponownie.
        counterpartyLabelChecked: true,
        ...(tag ? { counterpartyLabel: tag, counterpartyLabelSource: TRONSCAN_LABEL_SOURCE } : {}),
      });
    }
    // Pole `total` TronScan jest obcinane (zwykle 10000) i nie mówi o aktywności adresu — liczy się tylko, czy strona jest pełna.
    return { transfers, full: page.token_transfers.length >= TRANSACTION_LIMIT };
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
      const symbol = verifiedTokenSymbol(labels, network, item.token_info?.address, item.token_info?.symbol);
      if (item.token_info?.address && !symbol.includes('niezweryfikowany')) this.tokenContracts.set(symbol, item.token_info.address);
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
    const sourceNotes: string[] = [];

    const gridTokens = () =>
      fetchJson<TronGridPage<Trc20Transfer>>(this.fetchImpl, `${api}/transactions/trc20?limit=${TRANSACTION_LIMIT}&only_confirmed=true`, request);
    // TRC-20 najpierw z TronScan (znaczniki kontrahentów w tej samej odpowiedzi), zapasowo z TronGrid.
    const scanTokens = this.tronScanUrl
      ? this.tronScanTransfers(address, labels, network, context.signal).catch((error: unknown) => {
          if (context.signal?.aborted) throw error;
          sourceNotes.push(
            `TronScan nie zwrócił transferów TRC-20 (${error instanceof Error ? error.message : String(error)}) — użyto TronGrid, ` +
              'który nie podaje znaczników kontrahentów.',
          );
          return undefined;
        })
      : Promise.resolve(undefined);

    const [account, transactions, scanned] = await Promise.all([
      fetchJson<TronGridPage<TronAccount>>(this.fetchImpl, api, request),
      fetchJson<TronGridPage<TronTransaction>>(
        this.fetchImpl,
        `${api}/transactions?limit=${TRANSACTION_LIMIT}&only_confirmed=true`,
        request,
      ),
      scanTokens,
    ]);
    if (this.tronScanUrl && !scanned) budget.take();
    const tokenTransfers: TronGridPage<Trc20Transfer> = scanned
      ? { data: [], ...(scanned.full ? { meta: { fingerprint: 'tronscan' } } : {}) }
      : await gridTokens();
    if (!Array.isArray(account.data) || !Array.isArray(transactions.data) || !Array.isArray(tokenTransfers.data)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź w nieoczekiwanym formacie.`);
    }

    const transfers = [
      ...this.nativeTransfers(transactions.data, address),
      ...(scanned ? scanned.transfers : this.tokenTransfers(tokenTransfers.data, address, labels, network)),
    ];
    const extraNotes: string[] = [];
    if (this.extraOutgoing && (scanned ? scanned.full : Boolean(tokenTransfers.meta?.fingerprint)) && budget.take()) {
      try {
        const page = await fetchJson<TronGridPage<Trc20Transfer>>(
          this.fetchImpl,
          `${api}/transactions/trc20?limit=${TRANSACTION_LIMIT}&only_confirmed=true&only_from=true`,
          request,
        );
        const seen = new Set(transfers.map((item) => `${item.txid}|${item.counterparty}`));
        const added = this.tokenTransfers(page.data ?? [], address, labels, network).filter((item) => !seen.has(`${item.txid}|${item.counterparty}`));
        transfers.push(...added);
        extraNotes.push(`Tryb głęboki: dodano ${added.length} starszych transferów TRC-20 wychodzących z adresu (osobne zapytanie o 50 najnowszych wychodzących).`);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        extraNotes.push(`Nie udało się pobrać dodatkowej strony transferów wychodzących: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

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

    limitations.push(...sourceNotes, ...extraNotes);
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
    let trails: TracedTrail[] = [];
    if (follow) {
      const found = await traceAccountFlows({
        network,
        address,
        transfers,
        labels,
        sourceName: this.label,
        budget,
        options: { ...this.options.deposit, ...this.options.trace },
        lookup,
        signal: context.signal,
        // Zapytania o adres pośredni zawężamy do okna czasu — dawne wpłaty też da się prześledzić.
        timeBounded: true,
        expand: async (counterparty, asset, range): Promise<ExpandedNode> => {
          const hop = `${this.apiUrl}/v1/accounts/${encodeURIComponent(counterparty)}/transactions`;
          const query = `limit=${TRANSACTION_LIMIT}&only_confirmed=true&only_from=true&min_timestamp=${range.since}&max_timestamp=${range.until}`;
          if (asset === 'TRX') {
            const page = await fetchJson<TronGridPage<TronTransaction>>(this.fetchImpl, `${hop}?${query}`, request);
            return { outgoing: this.nativeTransfers(page.data ?? [], counterparty), more: Boolean(page.meta?.fingerprint) };
          }
          if (this.tronScanUrl) {
            try {
              const scan = await this.tronScanTransfers(counterparty, labels, network, context.signal, this.tokenContracts.get(asset), range);
              return { outgoing: scan.transfers.filter((item) => item.direction === 'out'), more: scan.full };
            } catch (error) {
              if (context.signal?.aborted) throw error;
              // Zapas niżej: TronGrid, bez znaczników.
            }
          }
          const page = await fetchJson<TronGridPage<Trc20Transfer>>(this.fetchImpl, `${hop}/trc20?${query}`, request);
          return { outgoing: this.tokenTransfers(page.data ?? [], counterparty, labels, network), more: Boolean(page.meta?.fingerprint) };
        },
        ...(this.tronScanUrl
          ? {
              countTransactions: async (counterparty: string) => {
                const info = await fetchJson<{ totalTransactionCount?: number }>(
                  this.fetchImpl,
                  `${this.tronScanUrl}/api/account?address=${encodeURIComponent(counterparty)}`,
                  { source: TRONSCAN_LABEL_SOURCE, signal: context.signal },
                );
                return typeof info.totalTransactionCount === 'number' ? info.totalTransactionCount : undefined;
              },
            }
          : {}),
      });
      inferredDeposits = found.deposits;
      trails = found.trails;
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
        trails,
        cluster: accountCluster(network, address),
        balance: fromBaseUnits(info?.balance ?? 0, 6),
        historyComplete: !truncated,
        transfers,
        limitations,
      },
      this.options,
    );
  }
}
