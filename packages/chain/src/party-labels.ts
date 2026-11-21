// Publiczne etykiety adresów z serwisów zewnętrznych: WalletExplorer (Bitcoin)
// i TronScan (Tron). Do serwisu trafia wyłącznie sprawdzany adres.

import type { Network } from '@olcys/core';
import type { RawTransfer } from './activity.ts';
import { ChainProviderError, fetchJson } from './http.ts';
import type { FetchLike, RequestBudget } from './http.ts';
import type { LabelSet } from './labels.ts';

/** Źródło etykiet pojedynczych adresów. */
export interface LabelLookup {
  /** Nazwa źródła, trafia do `classificationSource`. */
  sourceName: string;
  /** Etykieta adresu albo `undefined`, gdy źródło jej nie ma. Błędy sieci są zgłaszane wyjątkiem. */
  lookup(address: string, signal?: AbortSignal): Promise<string | undefined>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Wykonuje zadania jedno po drugim, z minimalnym odstępem między startami. */
function createThrottle(minIntervalMs: number): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<unknown> = Promise.resolve();
  let lastStart = 0;
  return (task) => {
    const run = queue.then(async () => {
      const wait = lastStart + minIntervalMs - Date.now();
      if (minIntervalMs > 0 && wait > 0) await sleep(wait);
      lastStart = Date.now();
      return task();
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

export interface WalletExplorerConfig {
  fetch?: FetchLike;
  apiUrl?: string;
  /** Odstęp między żądaniami; serwis prosi o umiarkowane tempo — domyślnie 1 żądanie na sekundę. */
  minIntervalMs?: number;
  /** Identyfikator narzędzia wymagany przez API (parametr `caller`); nie zawiera danych analizy. */
  caller?: string;
}

/**
 * WalletExplorer.com grupuje adresy Bitcoin w portfele (wspólne wydawanie środków)
 * i części portfeli nadaje nazwy, np. `Binance.com`, `Kraken.com`. Nazwa dotyczy
 * całego portfela, więc obejmuje także indywidualne adresy wpłat klientów giełdy.
 * Przypisanie adresu do portfela jest heurystyką serwisu, nie pewnikiem.
 */
export class WalletExplorerClient implements LabelLookup {
  sourceName = 'WalletExplorer';
  fetchImpl: FetchLike;
  apiUrl: string;
  caller: string;
  private throttle: <T>(task: () => Promise<T>) => Promise<T>;
  private cache = new Map<string, string | undefined>();

  constructor(config: WalletExplorerConfig = {}) {
    this.fetchImpl = config.fetch ?? fetch;
    this.apiUrl = (config.apiUrl ?? 'https://www.walletexplorer.com').replace(/\/+$/, '');
    this.caller = config.caller ?? 'OLCyS-research';
    this.throttle = createThrottle(config.minIntervalMs ?? 1000);
  }

  async lookup(address: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.cache.has(address)) return this.cache.get(address);
    const body = await this.throttle(() =>
      fetchJson<{ found?: boolean; label?: string; wallet_id?: string }>(
        this.fetchImpl,
        `${this.apiUrl}/api/1/address-lookup?address=${encodeURIComponent(address)}&caller=${encodeURIComponent(this.caller)}`,
        { source: this.sourceName, signal },
      ),
    );
    // Portfel bez nazwy (samo `wallet_id`) nic nie mówi o właścicielu.
    const label = body.found === true && typeof body.label === 'string' && body.label.trim() !== '' ? body.label.trim() : undefined;
    this.cache.set(address, label);
    return label;
  }
}

export interface TronScanConfig {
  fetch?: FetchLike;
  apiUrl?: string;
  minIntervalMs?: number;
}

/**
 * Publiczne znaczniki adresów z TronScan (`/api/account/tag`), np. `Binance-Hot 2`.
 * Punkt `accountv2` wymaga klucza (HTTP 401), ten działa bez niego; dla adresów
 * kontraktów zwraca komunikat „Contracts are not supported yet”.
 */
export class TronScanTagClient implements LabelLookup {
  sourceName = 'TronScan';
  fetchImpl: FetchLike;
  apiUrl: string;
  private throttle: <T>(task: () => Promise<T>) => Promise<T>;
  private cache = new Map<string, string | undefined>();

  constructor(config: TronScanConfig = {}) {
    this.fetchImpl = config.fetch ?? fetch;
    this.apiUrl = (config.apiUrl ?? 'https://apilist.tronscanapi.com').replace(/\/+$/, '');
    this.throttle = createThrottle(config.minIntervalMs ?? 250);
  }

  async lookup(address: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.cache.has(address)) return this.cache.get(address);
    const body = await this.throttle(() =>
      fetchJson<{ publicTag?: string; blueTag?: string; greyTag?: string; redTag?: string }>(
        this.fetchImpl,
        `${this.apiUrl}/api/account/tag?address=${encodeURIComponent(address)}`,
        { source: this.sourceName, signal },
      ),
    );
    const tag = [body.publicTag, body.blueTag, body.greyTag, body.redTag].find(
      (value) => typeof value === 'string' && value.trim() !== '',
    );
    const label = tag?.trim();
    this.cache.set(address, label);
    return label;
  }
}

/** Adres, o który można zapytać serwis etykiet (pomija opisy typu „nieustalony”). */
export function isQueryableAddress(address: string): boolean {
  return /^[A-Za-z0-9]{20,}$/.test(address);
}

export interface PartyLabelRequest {
  lookup: LabelLookup;
  network: Network;
  address: string;
  /** Przelewy badanego adresu; rozpoznane etykiety kontrahentów są do nich dopisywane. */
  transfers: RawTransfer[];
  labels: LabelSet;
  budget: RequestBudget;
  /** Ilu kontrahentów najwyżej sprawdzamy. */
  maxCounterparties?: number;
  /** Ile żądań zostawić na dalsze kroki analizy (adresy pośrednie). */
  reserve?: number;
  signal?: AbortSignal;
  limitations: string[];
}

export const MAX_LABELLED_COUNTERPARTIES = 10;

/**
 * Pyta serwis etykiet o badany adres i o kontrahentów (najpierw odbiorcy
 * największych przelewów wychodzących — to oni decydują o wskaźnikach wypłat).
 * Zwraca etykietę badanego adresu; etykiety kontrahentów dopisuje do przelewów.
 */
export async function lookupPartyLabels(request: PartyLabelRequest): Promise<string | undefined> {
  const { lookup, network, address, transfers, labels, budget, limitations } = request;
  const max = request.maxCounterparties ?? MAX_LABELLED_COUNTERPARTIES;
  const reserve = request.reserve ?? 0;
  const source = lookup.sourceName;

  const ordered = [...transfers].sort(
    (a, b) => Number(b.direction === 'out') - Number(a.direction === 'out') || b.amount - a.amount,
  );
  const pending: string[] = [];
  for (const transfer of ordered) {
    const party = transfer.counterparty;
    if (pending.includes(party) || party === address || !isQueryableAddress(party)) continue;
    if (transfer.counterpartyLabel || transfer.counterpartyClass || labels.lookup(network, party)) continue;
    pending.push(party);
  }

  let subjectLabel: string | undefined;
  let checked = 0;
  let stoppedBy: string | undefined;
  const queue = [...(labels.lookup(network, address) ? [] : [address]), ...pending.slice(0, max)];
  for (const party of queue) {
    const isSubject = party === address;
    if (budget.remaining <= (isSubject ? 0 : reserve) || !budget.take()) {
      stoppedBy = 'wyczerpano budżet żądań na jedną analizę adresu';
      break;
    }
    let label: string | undefined;
    try {
      label = await lookup.lookup(party, request.signal);
    } catch (error) {
      if (request.signal?.aborted) throw error;
      const reason = error instanceof ChainProviderError ? error.message : `${source}: ${String(error)}`;
      stoppedBy = `błąd serwisu — ${reason}`;
      break;
    }
    if (isSubject) {
      subjectLabel = label;
      continue;
    }
    checked += 1;
    if (!label) continue;
    for (const transfer of transfers) {
      if (transfer.counterparty !== party) continue;
      transfer.counterpartyLabel = label;
      transfer.counterpartyLabelSource = source;
    }
  }

  const skipped = pending.length - checked;
  if (skipped > 0) {
    const why = stoppedBy ?? `limit ${max} kontrahentów`;
    limitations.push(
      `${source}: sprawdzono etykiety ${checked} z ${pending.length} kontrahentów (${why}). ` +
        'Przelewy do pozostałych mogły nie zostać rozpoznane jako wypłaty.',
    );
  } else if (stoppedBy) {
    limitations.push(`${source}: nie sprawdzono etykiety badanego adresu (${stoppedBy}).`);
  }
  return subjectLabel;
}
