// Ethereum przez publiczne API Blockscout. Trzy żądania na adres: dane adresu,
// transakcje (waluta natywna) i transfery tokenów ERC-20; opcjonalnie po jednym
// żądaniu na badany adres pośredni (prawdopodobny adres wpłat na giełdę).
// Etykiety i klasy pochodzą z publicznych znaczników, które Blockscout dołącza
// do adresu i do stron każdej transakcji.

import type { AddressClass, ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { DEFAULT_REQUEST_BUDGET, findLikelyDepositAddresses } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
import { ChainProviderError, RequestBudget, fetchJson, fromBaseUnits } from '../http.ts';
import type { FetchLike } from '../http.ts';
import { getDefaultLabels, matchService, normalizeAddress } from '../labels.ts';
import type { LabelSet } from '../labels.ts';

interface BlockscoutTag {
  name?: string;
  slug?: string;
  tagType?: string;
  ordinal?: number;
}

interface BlockscoutPublicTag {
  display_name?: string;
  label?: string;
}

export interface BlockscoutParty {
  hash?: string;
  is_contract?: boolean;
  /** `eip7702` oznacza zwykłe konto z delegacją kodu (EIP-7702), nie kontrakt. */
  proxy_type?: string | null;
  name?: string | null;
  ens_domain_name?: string | null;
  public_tags?: BlockscoutPublicTag[] | null;
  private_tags?: BlockscoutPublicTag[] | null;
  metadata?: { tags?: BlockscoutTag[] | null } | null;
}

interface BlockscoutAddress extends BlockscoutParty {
  coin_balance?: string | null;
}

interface BlockscoutPage<T> {
  items?: T[];
  next_page_params?: unknown;
}

interface BlockscoutTransaction {
  hash: string;
  timestamp?: string | null;
  from?: BlockscoutParty | null;
  to?: BlockscoutParty | null;
  created_contract?: BlockscoutParty | null;
  value?: string;
  status?: string | null;
}

interface BlockscoutTokenTransfer {
  transaction_hash?: string;
  tx_hash?: string;
  timestamp?: string | null;
  from?: BlockscoutParty | null;
  to?: BlockscoutParty | null;
  token?: { symbol?: string | null; decimals?: string | null; address?: string; address_hash?: string } | null;
  total?: { value?: string | null; decimals?: string | null } | null;
}

export const TRANSACTION_LIMIT = 50;
/** Nazwa źródła etykiet w `classificationSource`. */
export const BLOCKSCOUT_LABEL_SOURCE = 'Blockscout';

const EXCHANGE_TAG_SLUGS = new Set(['exchange', 'cex', 'centralized-exchange']);

/** Co Blockscout publicznie wie o adresie. */
export interface BlockscoutPartyInfo {
  label?: string;
  /** Klasa wynikająca ze znaczników; brak, gdy znaczniki jej nie wskazują. */
  addressClass?: AddressClass;
  isContract: boolean;
  ens?: string;
}

/**
 * Czyta publiczne znaczniki adresu. Etykietą jest znacznik typu `name` o najwyższym
 * priorytecie (`ordinal`), dalej znacznik publiczny, nazwa kontraktu. Giełdą jest
 * adres ze znacznikiem ogólnym „Exchange” albo z nazwą giełdy z listy słów-kluczy;
 * dla kontraktów sama nazwa nie wystarcza (np. kontrakt tokena wydanego przez
 * giełdę), wymagany jest też znacznik „Exchange”.
 */
export function parseBlockscoutParty(party: BlockscoutParty | null | undefined): BlockscoutPartyInfo {
  if (!party) return { isContract: false };
  const isContract = party.is_contract === true && party.proxy_type !== 'eip7702';
  const tags = (party.metadata?.tags ?? []).filter((tag) => typeof tag?.name === 'string' && tag.name !== '');
  const nameTags = tags.filter((tag) => tag.tagType === 'name').sort((a, b) => (b.ordinal ?? 0) - (a.ordinal ?? 0));
  const publicNames = [...(party.public_tags ?? []), ...(party.private_tags ?? [])]
    .map((tag) => tag?.display_name ?? tag?.label)
    .filter((value): value is string => typeof value === 'string' && value !== '');
  const label = nameTags[0]?.name ?? publicNames[0] ?? party.name ?? undefined;

  const hasExchangeTag = tags.some(
    (tag) => tag.tagType !== 'name' && (EXCHANGE_TAG_SLUGS.has(tag.slug ?? '') || /^(centralized )?exchange$/i.test(tag.name ?? '')),
  );
  const names = [...nameTags.map((tag) => tag.name), ...tags.filter((tag) => tag.tagType === 'protocol').map((tag) => tag.name), ...publicNames, party.name];
  const exchangeName = names.some((name) => matchService(name ?? undefined, 'exchange') !== undefined);
  const isExchange = isContract ? exchangeName && hasExchangeTag : exchangeName || hasExchangeTag;

  return {
    ...(label ? { label } : {}),
    ...(isExchange ? { addressClass: 'exchange' as const } : {}),
    isContract,
    ...(party.ens_domain_name ? { ens: party.ens_domain_name } : {}),
  };
}

/**
 * Symbol tokena przyjmujemy tylko dla kontraktów ze zbioru etykiet. Symbol
 * deklaruje sam kontrakt, więc fałszywe „USDT” nie może trafić do wyceny.
 */
export function verifiedTokenSymbol(
  labels: LabelSet,
  network: Network,
  tokenAddress: string | undefined,
  symbol: string | null | undefined,
): string {
  const known = tokenAddress ? labels.lookup(network, tokenAddress)?.asset : undefined;
  if (known) return known;
  const short = tokenAddress ? `${tokenAddress.slice(0, 8)}…` : 'brak adresu';
  return `${symbol ?? 'token'} (niezweryfikowany token ${short})`;
}

export interface BlockscoutProviderConfig extends ActivityOptions {
  /** Adres instancji, domyślnie `https://eth.blockscout.com`. */
  siteUrl?: string;
  fetch?: FetchLike;
  /** Łączny budżet żądań na analizę jednego adresu. */
  requestBudget?: number;
  /** Czy badać dalszą drogę środków (prawdopodobne adresy wpłat na giełdy); domyślnie nie. */
  followDeposits?: boolean;
}

export class BlockscoutProvider implements ChainProvider {
  id = 'blockscout-ethereum';
  label = 'Blockscout (Ethereum)';
  siteUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  requestBudget: number;
  followDeposits: boolean;

  constructor(config: BlockscoutProviderConfig = {}) {
    this.siteUrl = (config.siteUrl ?? 'https://eth.blockscout.com').replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.options = {
      labels: config.labels,
      rateSource: config.rateSource,
      cashOut: config.cashOut,
      sanctions: config.sanctions,
      deposit: config.deposit,
    };
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.followDeposits = config.followDeposits ?? false;
  }

  supports(network: Network): boolean {
    return network === 'ethereum';
  }

  private describe(party: BlockscoutParty | null | undefined) {
    const info = parseBlockscoutParty(party);
    return {
      counterparty: party?.hash ?? 'nieustalony',
      counterpartyLabel: info.label,
      counterpartyClass: info.addressClass,
      counterpartyIsContract: info.isContract,
      counterpartyEns: info.ens,
      ...(info.label || info.addressClass ? { counterpartyLabelSource: BLOCKSCOUT_LABEL_SOURCE } : {}),
    };
  }

  private nativeTransfers(items: BlockscoutTransaction[], address: string): RawTransfer[] {
    const self = normalizeAddress(address);
    const transfers: RawTransfer[] = [];
    for (const tx of items.slice(0, TRANSACTION_LIMIT)) {
      // Wywołania kontraktów bez przekazania ETH i transakcje nieudane nie są przelewami.
      const amount = fromBaseUnits(tx.value ?? '0', 18);
      if (amount === 0 || tx.status === 'error' || !tx.timestamp) continue;
      const outgoing = tx.from?.hash !== undefined && normalizeAddress(tx.from.hash) === self;
      transfers.push({
        txid: tx.hash,
        time: tx.timestamp,
        direction: outgoing ? 'out' : 'in',
        ...this.describe(outgoing ? (tx.to ?? tx.created_contract) : tx.from),
        asset: 'ETH',
        amount,
        explorerUrl: `${this.siteUrl}/tx/${tx.hash}`,
      });
    }
    return transfers;
  }

  private tokenTransfers(items: BlockscoutTokenTransfer[], address: string, labels: LabelSet, network: Network): RawTransfer[] {
    const self = normalizeAddress(address);
    const transfers: RawTransfer[] = [];
    for (const item of items.slice(0, TRANSACTION_LIMIT)) {
      const txid = item.transaction_hash ?? item.tx_hash;
      if (!txid || !item.timestamp || !item.total?.value) continue;
      const decimals = Number(item.total.decimals ?? item.token?.decimals ?? 0);
      const outgoing = item.from?.hash !== undefined && normalizeAddress(item.from.hash) === self;
      transfers.push({
        txid,
        time: item.timestamp,
        direction: outgoing ? 'out' : 'in',
        ...this.describe(outgoing ? item.to : item.from),
        asset: verifiedTokenSymbol(labels, network, item.token?.address_hash ?? item.token?.address, item.token?.symbol),
        amount: fromBaseUnits(item.total.value, Number.isFinite(decimals) ? decimals : 0),
        explorerUrl: `${this.siteUrl}/tx/${txid}`,
      });
    }
    return transfers;
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    const labels = this.options.labels ?? getDefaultLabels();
    const base = `${this.siteUrl}/api/v2/addresses`;
    const api = `${base}/${encodeURIComponent(address)}`;
    const request = { source: this.label, signal: context.signal };
    const budget = new RequestBudget(this.requestBudget);
    const self = normalizeAddress(address);
    const limitations: string[] = [];

    // Dane adresu bywają niedostępne dla bardzo aktywnych adresów (limit czasu po stronie API).
    // Historia i znaczniki ze stron transakcji wystarczą wtedy do analizy, więc nie przerywamy.
    budget.used += 3;
    const [infoResult, transactions, tokenTransfers] = await Promise.all([
      fetchJson<BlockscoutAddress>(this.fetchImpl, api, request).catch((error: unknown) => {
        if (error instanceof ChainProviderError && (error.code === 'timeout' || error.code === 'unavailable')) return error;
        throw error;
      }),
      fetchJson<BlockscoutPage<BlockscoutTransaction>>(this.fetchImpl, `${api}/transactions`, request),
      fetchJson<BlockscoutPage<BlockscoutTokenTransfer>>(this.fetchImpl, `${api}/token-transfers?type=ERC-20`, request),
    ]);
    if (!Array.isArray(transactions.items) || !Array.isArray(tokenTransfers.items)) {
      throw new ChainProviderError('invalid_response', `${this.label}: odpowiedź bez listy transakcji.`);
    }

    let info: BlockscoutAddress;
    if (infoResult instanceof ChainProviderError) {
      // Ten sam opis adresu (znaczniki, ENS) Blockscout dołącza do stron transakcji.
      const parties = [...transactions.items, ...tokenTransfers.items].flatMap((item) => [item.from, item.to]);
      info = parties.find((party) => party?.hash !== undefined && normalizeAddress(party.hash) === self) ?? {};
      limitations.push(
        `Nie udało się pobrać danych adresu (${infoResult.message}) — saldo jest liczone z pobranych przelewów, ` +
          'a znaczniki adresu pochodzą z opisu stron transakcji.',
      );
    } else {
      info = infoResult;
    }

    const transfers = [
      ...this.nativeTransfers(transactions.items, address),
      ...this.tokenTransfers(tokenTransfers.items, address, labels, network),
    ];

    const truncated = Boolean(transactions.next_page_params) || Boolean(tokenTransfers.next_page_params);
    limitations.push(
      'Ethereum: uwzględniono przelewy ETH i tokenów ERC-20. Transakcje wewnętrzne kontraktów (np. ETH ' +
        'otrzymane z wymiany) nie są pobierane.',
      'Liczba transakcji i sumy wpływów/wydatków ETH są liczone z pobranych przelewów, nie z całej historii adresu.',
    );
    if (truncated) {
      limitations.push(
        `Pobrano po ${TRANSACTION_LIMIT} najnowszych transakcji i transferów tokenów (limit). ` +
          'Starsze przelewy i wypłaty nie są uwzględnione.',
      );
    }

    let inferredDeposits: InferredDeposit[] = [];
    if (this.followDeposits) {
      const found = await findLikelyDepositAddresses({
        network,
        address,
        transfers,
        labels,
        sourceName: this.label,
        budget,
        options: this.options.deposit,
        signal: context.signal,
        fetchOutgoing: async (counterparty, asset) => {
          const hop = `${base}/${encodeURIComponent(counterparty)}`;
          if (asset === 'ETH') {
            const page = await fetchJson<BlockscoutPage<BlockscoutTransaction>>(this.fetchImpl, `${hop}/transactions?filter=from`, request);
            return this.nativeTransfers(page.items ?? [], counterparty);
          }
          const page = await fetchJson<BlockscoutPage<BlockscoutTokenTransfer>>(
            this.fetchImpl,
            `${hop}/token-transfers?type=ERC-20&filter=from`,
            request,
          );
          return this.tokenTransfers(page.items ?? [], counterparty, labels, network);
        },
      });
      inferredDeposits = found.deposits;
      limitations.push(...found.limitations);
    }

    const party = parseBlockscoutParty(info);
    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: party.isContract,
        label: party.label,
        addressClass: party.addressClass,
        ...(party.label || party.addressClass ? { labelSource: BLOCKSCOUT_LABEL_SOURCE } : {}),
        ensName: party.ens,
        ...(info.coin_balance != null ? { balance: fromBaseUnits(info.coin_balance, 18) } : {}),
        historyComplete: !truncated,
        transfers,
        inferredDeposits,
        limitations,
      },
      this.options,
    );
  }
}
