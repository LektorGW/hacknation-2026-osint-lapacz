// Ethereum przez publiczne API Blockscout. Trzy żądania na adres: dane adresu,
// transakcje (waluta natywna) i transfery tokenów ERC-20; opcjonalnie po jednym
// żądaniu na badany adres pośredni (prawdopodobny adres wpłat na giełdę).
// Etykiety i klasy pochodzą z publicznych znaczników, które Blockscout dołącza
// do adresu i do stron każdej transakcji.

import type { AddressClass, ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { accountCluster } from '../cluster.ts';
import { DEFAULT_REQUEST_BUDGET } from '../deposit.ts';
import type { InferredDeposit } from '../deposit.ts';
import { traceAccountFlows } from '../trace.ts';
import type { TracedTrail } from '../trace.ts';
import { FULL_HISTORY_TRANSFER_LIMIT, describeRange, inHistoryRange, planHistory, traceBudgetLimit } from '../history.ts';
import type { HistoryOptions } from '../history.ts';
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
  next_page_params?: Record<string, unknown> | null;
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
  /**
   * Adres usługi metadanych Blockscout (hurtowe znaczniki adresów, bez klucza), np.
   * `https://metadata.services.blockscout.com`. Bez niego używane są tylko znaczniki z transakcji.
   */
  metadataUrl?: string;
  /** Identyfikator sieci dla usługi metadanych (Ethereum: 1). */
  chainId?: number;
  /**
   * Tryb głęboki: dwa dodatkowe żądania o najnowsze przelewy WYCHODZĄCE (ETH i ERC-20), gdy
   * historia adresu nie mieści się na pierwszej stronie.
   */
  extraOutgoing?: boolean;
  /** Domyślny zakres historii; kontekst wywołania może go zmienić dla pojedynczego adresu. */
  history?: HistoryOptions;
}

/** Ilu adresów najwyżej dotyczy jedno hurtowe zapytanie o znaczniki. */
export const BULK_TAG_LIMIT = 40;

export class BlockscoutProvider implements ChainProvider {
  id = 'blockscout-ethereum';
  label = 'Blockscout (Ethereum)';
  siteUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  requestBudget: number;
  followDeposits: boolean;
  metadataUrl: string | undefined;
  chainId: number;
  extraOutgoing: boolean;
  history: HistoryOptions;

  constructor(config: BlockscoutProviderConfig = {}) {
    this.siteUrl = (config.siteUrl ?? 'https://eth.blockscout.com').replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
    this.options = {
      labels: config.labels,
      rateSource: config.rateSource,
      cashOut: config.cashOut,
      sanctions: config.sanctions,
      deposit: config.deposit,
      trace: config.trace,
    };
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.followDeposits = config.followDeposits ?? false;
    this.metadataUrl = config.metadataUrl?.replace(/\/+$/, '');
    this.chainId = config.chainId ?? 1;
    this.extraOutgoing = config.extraOutgoing ?? false;
    this.history = config.history ?? {};
  }

  /**
   * Hurtowe znaczniki adresów z usługi metadanych Blockscout: jedno żądanie dla wielu
   * adresów. Dopisuje etykietę i klasę do przelewów, których kontrahent nie ma jeszcze opisu.
   */
  async enrichWithBulkTags(transfers: RawTransfer[], signal?: AbortSignal): Promise<number> {
    if (!this.metadataUrl) return 0;
    const pending = [...new Set(transfers.filter((item) => !item.counterpartyLabel && !item.counterpartyClass && /^0x[0-9a-fA-F]{40}$/.test(item.counterparty)).map((item) => item.counterparty))].slice(0, BULK_TAG_LIMIT);
    if (pending.length === 0) return 0;
    const body = await fetchJson<{ addresses?: Record<string, { tags?: BlockscoutTag[] } | undefined> }>(
      this.fetchImpl,
      `${this.metadataUrl}/api/v1/metadata?addresses=${pending.join(',')}&chainId=${this.chainId}&tagsLimit=20`,
      { source: 'Blockscout (metadane adresów)', signal },
    );
    const byAddress = new Map<string, BlockscoutTag[]>();
    for (const [address, entry] of Object.entries(body.addresses ?? {})) {
      if (Array.isArray(entry?.tags)) byAddress.set(normalizeAddress(address), entry.tags);
    }
    let labelled = 0;
    for (const transfer of transfers) {
      if (transfer.counterpartyLabel || transfer.counterpartyClass) continue;
      const tags = byAddress.get(normalizeAddress(transfer.counterparty));
      if (pending.includes(transfer.counterparty)) transfer.counterpartyLabelChecked = true;
      if (!tags) continue;
      const info = parseBlockscoutParty({ hash: transfer.counterparty, is_contract: transfer.counterpartyIsContract, metadata: { tags } });
      if (!info.label && !info.addressClass) continue;
      transfer.counterpartyLabel = info.label;
      transfer.counterpartyClass = info.addressClass;
      transfer.counterpartyLabelSource = BLOCKSCOUT_LABEL_SOURCE;
      labelled += 1;
    }
    return labelled;
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

  private nativeTransfers(items: BlockscoutTransaction[], address: string, limit = TRANSACTION_LIMIT): RawTransfer[] {
    const self = normalizeAddress(address);
    const transfers: RawTransfer[] = [];
    for (const tx of items.slice(0, limit)) {
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

  private tokenTransfers(items: BlockscoutTokenTransfer[], address: string, labels: LabelSet, network: Network, limit = TRANSACTION_LIMIT): RawTransfer[] {
    const self = normalizeAddress(address);
    const transfers: RawTransfer[] = [];
    for (const item of items.slice(0, limit)) {
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
    const budget = new RequestBudget(traceBudgetLimit(context, this.requestBudget));
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

    // Pełna historia: kolejne strony obu list (po 50), do limitu żądań, limitu przelewów albo początku okresu.
    const plan = planHistory(context, this.history);
    const full = plan.mode === 'full';
    const ranged = plan.since !== undefined || plan.until !== undefined;
    if (full) {
      let pages = 0;
      const stops: string[] = [];
      const extend = async <T extends { timestamp?: string | null }>(page: BlockscoutPage<T>, url: string, what: string) => {
        const items = page.items!;
        while (page.next_page_params) {
          const oldest = Date.parse(items.at(-1)?.timestamp ?? '');
          if (plan.since !== undefined && oldest < plan.since) return;
          if (items.length >= FULL_HISTORY_TRANSFER_LIMIT) return void stops.push(`${what}: limit ${FULL_HISTORY_TRANSFER_LIMIT} pozycji`);
          if (!plan.budget.take()) return void stops.push(`${what}: limit ${plan.budget.limit} żądań o kolejne strony historii`);
          const query = new URLSearchParams(
            Object.entries(page.next_page_params)
              .filter(([, value]) => value !== null && value !== undefined)
              .map(([key, value]) => [key, String(value)]),
          );
          let next: BlockscoutPage<T>;
          try {
            next = await fetchJson<BlockscoutPage<T>>(this.fetchImpl, `${url}${url.includes('?') ? '&' : '?'}${query}`, request);
          } catch (error) {
            if (context.signal?.aborted) throw error;
            return void stops.push(`${what}: błąd przy pobieraniu kolejnej strony — ${error instanceof Error ? error.message : String(error)}`);
          }
          pages += 1;
          items.push(...(next.items ?? []));
          page.next_page_params = next.next_page_params ?? null;
        }
      };
      await extend(transactions, `${api}/transactions`, 'transakcje');
      await extend(tokenTransfers, `${api}/token-transfers?type=ERC-20`, 'transfery tokenów');
      limitations.push(
        `Tryb pełnej historii: pobrano ${transactions.items.length} transakcji i ${tokenTransfers.items.length} transferów tokenów ` +
          `(${pages} dodatkowych żądań)` +
          (stops.length > 0 ? ` — stronicowanie przerwano (${stops.join('; ')}). Starsze przelewy nie są uwzględnione.` : '.'),
      );
    }
    const pageLimit = full ? Number.POSITIVE_INFINITY : TRANSACTION_LIMIT;
    let transfers = [
      ...this.nativeTransfers(transactions.items, address, pageLimit),
      ...this.tokenTransfers(tokenTransfers.items, address, labels, network, pageLimit),
    ];
    if (ranged) {
      const before = transfers.length;
      transfers = transfers.filter((item) => inHistoryRange(plan, Date.parse(item.time)));
      limitations.push(`Analiza ograniczona do okresu ${describeRange(plan)}: uwzględniono ${transfers.length} z ${before} pobranych przelewów.`);
    }

    const truncated = Boolean(transactions.next_page_params) || Boolean(tokenTransfers.next_page_params);
    if (this.extraOutgoing && truncated && !full) {
      const seen = new Set(transfers.map((item) => `${item.txid}|${item.counterparty}|${item.asset}`));
      let added = 0;
      const merge = (items: RawTransfer[]) => {
        for (const item of items) {
          const key = `${item.txid}|${item.counterparty}|${item.asset}`;
          if (item.direction !== 'out' || seen.has(key)) continue;
          seen.add(key);
          transfers.push(item);
          added += 1;
        }
      };
      try {
        if (transactions.next_page_params && budget.take()) {
          const page = await fetchJson<BlockscoutPage<BlockscoutTransaction>>(this.fetchImpl, `${api}/transactions?filter=from`, request);
          merge(this.nativeTransfers(page.items ?? [], address));
        }
        if (tokenTransfers.next_page_params && budget.take()) {
          const page = await fetchJson<BlockscoutPage<BlockscoutTokenTransfer>>(this.fetchImpl, `${api}/token-transfers?type=ERC-20&filter=from`, request);
          merge(this.tokenTransfers(page.items ?? [], address, labels, network));
        }
        limitations.push(`Tryb głęboki: dodano ${added} starszych przelewów wychodzących z adresu (osobne zapytania o najnowsze przelewy wychodzące).`);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        limitations.push(`Nie udało się pobrać dodatkowych stron przelewów wychodzących: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    limitations.push(
      'Ethereum: uwzględniono przelewy ETH i tokenów ERC-20. Transakcje wewnętrzne kontraktów (np. ETH ' +
        'otrzymane z wymiany) nie są pobierane.',
      'Liczba transakcji i sumy wpływów/wydatków ETH są liczone z pobranych przelewów, nie z całej historii adresu.',
    );
    if (truncated && !full) {
      limitations.push(
        `Pobrano po ${TRANSACTION_LIMIT} najnowszych transakcji i transferów tokenów (limit). ` +
          'Starsze przelewy i wypłaty nie są uwzględnione.',
      );
    }

    // Znaczniki hurtowo: usługa metadanych zna etykiety, których nie ma w opisie stron transakcji.
    if (this.metadataUrl && budget.take()) {
      try {
        await this.enrichWithBulkTags(transfers, context.signal);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        limitations.push(`Nie udało się pobrać hurtowych znaczników adresów: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let inferredDeposits: InferredDeposit[] = [];
    let trails: TracedTrail[] = [];
    let openQuestions: { txid: string; text: string }[] = [];
    if (this.followDeposits) {
      const found = await traceAccountFlows({
        network,
        address,
        transfers,
        labels,
        sourceName: this.label,
        budget,
        options: { ...this.options.deposit, ...this.options.trace },
        signal: context.signal,
        expand: async (counterparty, asset) => {
          const hop = `${base}/${encodeURIComponent(counterparty)}`;
          if (asset === 'ETH') {
            const page = await fetchJson<BlockscoutPage<BlockscoutTransaction>>(this.fetchImpl, `${hop}/transactions?filter=from`, request);
            return { outgoing: this.nativeTransfers(page.items ?? [], counterparty), more: Boolean(page.next_page_params) };
          }
          const page = await fetchJson<BlockscoutPage<BlockscoutTokenTransfer>>(
            this.fetchImpl,
            `${hop}/token-transfers?type=ERC-20&filter=from`,
            request,
          );
          return { outgoing: this.tokenTransfers(page.items ?? [], counterparty, labels, network), more: Boolean(page.next_page_params) };
        },
        countTransactions: async (counterparty) => {
          const counters = await fetchJson<{ transactions_count?: string; token_transfers_count?: string }>(
            this.fetchImpl,
            `${base}/${encodeURIComponent(counterparty)}/counters`,
            request,
          );
          const total = Number(counters.transactions_count ?? 0) + Number(counters.token_transfers_count ?? 0);
          return Number.isFinite(total) ? total : undefined;
        },
        ...(this.metadataUrl
          ? {
              enrich: async (forwards: RawTransfer[]) => {
                await this.enrichWithBulkTags(forwards, context.signal);
              },
            }
          : {}),
      });
      inferredDeposits = found.deposits;
      trails = found.trails;
      openQuestions = found.openQuestions;
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
        historyComplete: !truncated && !ranged,
        transfers,
        inferredDeposits,
        trails,
        openQuestions,
        cluster: accountCluster(network, address),
        limitations,
      },
      this.options,
    );
  }
}
