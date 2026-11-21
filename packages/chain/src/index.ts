// Dane blockchain: dostawcy, klasyfikacja adresów, wskaźniki wypłat, wycena w PLN.

import { fileURLToPath } from 'node:url';
import type { ChainProvider } from '@olcys/core';
import type { ActivityOptions } from './activity.ts';
import { createPoliteFetch } from './http.ts';
import type { FetchLike } from './http.ts';
import { BlockscoutProvider } from './providers/blockscout.ts';
import { EsploraProvider } from './providers/esplora.ts';
import { SandboxChainProvider } from './providers/sandbox.ts';
import { TronGridProvider } from './providers/trongrid.ts';
import { DEFAULT_REQUEST_BUDGET } from './deposit.ts';
import { TronScanTagClient, WalletExplorerClient } from './party-labels.ts';
import { MarketRateSource, StaticRateSource } from './valuation.ts';

export * from './activity.ts';
export * from './cashout.ts';
export * from './cluster.ts';
export * from './deposit.ts';
export * from './labels.ts';
export * from './ofac.ts';
export * from './party-labels.ts';
export * from './trace.ts';
export * from './valuation.ts';
export { ChainProviderError, DEFAULT_HOST_POLICIES, RequestBudget, USER_AGENT, createPoliteFetch, fetchJson, fromBaseUnits } from './http.ts';
export type { FetchLike, HostPolicy, ProviderErrorCode } from './http.ts';
export { BlockscoutProvider, parseBlockscoutParty } from './providers/blockscout.ts';
export { EsploraProvider } from './providers/esplora.ts';
export { SandboxChainProvider } from './providers/sandbox.ts';
export { TronGridProvider } from './providers/trongrid.ts';

export interface ChainConfig extends ActivityOptions {
  /** Adres środowiska demonstracyjnego; włącza dostawcę danych syntetycznych. */
  sandboxUrl?: string;
  /** Zgoda na zapytania do publicznych API w internecie. */
  enableLive?: boolean;
  /** Podmiana `fetch`, używana w testach. */
  fetch?: FetchLike;
  /**
   * Plik pamięci podręcznej kursów; domyślnie `data/cache/rates.json` w module.
   * `false` wyłącza zapis na dysk (kursy są wtedy pamiętane tylko w procesie).
   */
  rateCacheFile?: string | false;
  /**
   * Głębokość analizy na żywo: `standard` — budżet 15 żądań na adres; `deep` — 40 żądań,
   * więcej badanych przelewów wychodzących (śledzenie do 4 kroków w obu trybach).
   */
  depth?: 'standard' | 'deep';
  /** Łączny budżet żądań do publicznych API na analizę jednego adresu; nadpisuje wartość z `depth`. */
  requestBudget?: number;
  /** `false` wyłącza etykiety z serwisów zewnętrznych (WalletExplorer, TronScan). */
  externalLabels?: boolean;
  /** Odstęp między żądaniami do WalletExplorer w ms (domyślnie 1000). */
  walletExplorerIntervalMs?: number;
  /**
   * Ograniczanie tempa i ponawianie po 429 dla hostów z `DEFAULT_HOST_POLICIES` (TronScan, TronGrid).
   * Domyślnie włączone dla prawdziwego `fetch`, wyłączone, gdy `fetch` podmieniono (testy).
   */
  politeFetch?: boolean;
}

/** Budżet żądań na adres w trybie `depth: 'deep'`. */
export const DEEP_REQUEST_BUDGET = 40;
export const DEFAULT_RATE_CACHE_FILE = fileURLToPath(new URL('../data/cache/rates.json', import.meta.url));

/**
 * Dostawcy w kolejności prób: najpierw sandbox, potem publiczne API.
 * Używaj z `getActivityFromProviders`, które przechodzi do kolejnego dostawcy,
 * gdy poprzedni nie zna adresu lub jest niedostępny.
 *
 * Przy `enableLive` wycena korzysta z kursów rynkowych (`MarketRateSource`:
 * Binance × NBP); tabela przykładowa jest wtedy tylko zapasem na wypadek błędu
 * sieci i każde jej użycie jest oznaczone w opisie wyceny. Bez `enableLive`
 * (tryb bez sieci) używana jest sama tabela przykładowa — również oznaczona.
 */
export function createChainProviders(config: ChainConfig = {}): ChainProvider[] {
  const rawFetch = config.fetch ?? fetch;
  const fetchImpl = (config.politeFetch ?? !config.fetch) ? createPoliteFetch(rawFetch) : rawFetch;
  // Z podmienionym `fetch` (testy) nie zapisujemy niczego na dysk, chyba że plik podano wprost.
  const cacheFile =
    config.rateCacheFile === false ? undefined : (config.rateCacheFile ?? (config.fetch ? undefined : DEFAULT_RATE_CACHE_FILE));
  const rateSource =
    config.rateSource ??
    (config.enableLive
      ? new MarketRateSource({ fetch: fetchImpl, fallback: new StaticRateSource(), cacheFile })
      : new StaticRateSource());
  const shared = {
    labels: config.labels,
    rateSource,
    cashOut: config.cashOut,
    sanctions: config.sanctions,
    deposit: config.deposit,
    trace: config.trace,
    fetch: fetchImpl,
  };

  const providers: ChainProvider[] = [];
  if (config.sandboxUrl) {
    providers.push(new SandboxChainProvider({ ...shared, sandboxUrl: config.sandboxUrl }));
  }
  if (config.enableLive) {
    const externalLabels = config.externalLabels ?? true;
    const deep = config.depth === 'deep';
    const live = {
      ...shared,
      requestBudget: config.requestBudget ?? (deep ? DEEP_REQUEST_BUDGET : DEFAULT_REQUEST_BUDGET),
      followDeposits: true,
      extraOutgoing: deep,
      trace: { ...(deep ? { maxCandidates: 12 } : {}), ...config.trace },
    };
    // Jeden klient na serwis: wspólna pamięć podręczna i wspólny ogranicznik tempa.
    const walletExplorer = externalLabels
      ? new WalletExplorerClient({ fetch: fetchImpl, minIntervalMs: config.walletExplorerIntervalMs })
      : undefined;
    const tronScan = externalLabels ? new TronScanTagClient({ fetch: fetchImpl }) : undefined;
    providers.push(
      new EsploraProvider({
        ...live,
        labelLookup: walletExplorer,
        id: 'esplora-blockstream',
        label: 'Blockstream Esplora (Bitcoin)',
        siteUrl: 'https://blockstream.info',
        testnetSiteUrl: 'https://blockstream.info/testnet',
      }),
      new EsploraProvider({
        ...live,
        labelLookup: walletExplorer,
        id: 'esplora-mempool',
        label: 'mempool.space (Bitcoin)',
        siteUrl: 'https://mempool.space',
        testnetSiteUrl: 'https://mempool.space/testnet',
      }),
      new BlockscoutProvider({ ...live, ...(externalLabels ? { metadataUrl: 'https://metadata.services.blockscout.com' } : {}) }),
      new TronGridProvider({ ...live, labelLookup: tronScan, ...(externalLabels ? { tronScanUrl: 'https://apilist.tronscanapi.com' } : {}) }),
    );
  }
  return providers;
}
