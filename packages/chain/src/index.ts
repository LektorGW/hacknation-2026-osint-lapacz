// Dane blockchain: dostawcy, klasyfikacja adresów, wskaźniki wypłat, wycena w PLN.

import { fileURLToPath } from 'node:url';
import type { ChainProvider } from '@olcys/core';
import type { ActivityOptions } from './activity.ts';
import { DEEP_HISTORY_REQUESTS, DEFAULT_HISTORY_REQUESTS } from './history.ts';
import type { HistoryOptions } from './history.ts';
import { createPoliteFetch } from './http.ts';
import type { FetchLike } from './http.ts';
import { BlockscoutProvider } from './providers/blockscout.ts';
import { EsploraProvider } from './providers/esplora.ts';
import { LabChainProvider } from './providers/lab.ts';
import { SandboxChainProvider } from './providers/sandbox.ts';
import { SolanaRpcProvider } from './providers/solana.ts';
import { TronGridProvider } from './providers/trongrid.ts';
import { DEFAULT_REQUEST_BUDGET } from './deposit.ts';
import { DEEP_FUNDING_BUDGET, DEFAULT_FUNDING_BUDGET } from './funding.ts';
import { DEEP_LINK_BUDGET, DEFAULT_LINK_BUDGET } from './links.ts';
import type { LinkOptions } from './links.ts';
import { BLOCKSCOUT_KEYED_API, EvmMultiChainProvider, FailoverProvider, createKeyedFetch, resolveEvmNetworks } from './networks.ts';
import { TronScanTagClient, WalletExplorerClient } from './party-labels.ts';
import { MarketRateSource, StaticRateSource } from './valuation.ts';

export * from './activity.ts';
export * from './cashout.ts';
export * from './cluster.ts';
export * from './deposit.ts';
export * from './funding.ts';
export * from './history.ts';
export * from './balances.ts';
export * from './labels.ts';
export * from './networks.ts';
export * from './links.ts';
export * from './ofac.ts';
export * from './offramps.ts';
export * from './party-labels.ts';
export * from './roundtrip.ts';
export * from './trace.ts';
export * from './valuation.ts';
export { ChainProviderError, DEFAULT_HOST_POLICIES, RequestBudget, USER_AGENT, createPoliteFetch, fetchJson, fromBaseUnits } from './http.ts';
export type { FetchLike, HostPolicy, ProviderErrorCode } from './http.ts';
export { BlockscoutProvider, parseBlockscoutParty } from './providers/blockscout.ts';
export { EsploraProvider } from './providers/esplora.ts';
export { LAB_LIMITATIONS, LabChainProvider } from './providers/lab.ts';
export { SandboxChainProvider } from './providers/sandbox.ts';
export { SOLANA_STABLECOINS, SolanaRpcProvider, solanaTransfers } from './providers/solana.ts';
export { TronGridProvider } from './providers/trongrid.ts';

export interface ChainConfig extends ActivityOptions, HistoryOptions {
  /** Adres środowiska demonstracyjnego; włącza dostawcę danych syntetycznych. */
  sandboxUrl?: string;
  /**
   * Adres laboratorium tożsamości (apps/identity-lab); włącza dostawcę sieci laboratoryjnej (adresy `lab1…`,
   * token LAB bez wartości — bez wyceny w PLN). Domyślnie wyłączony.
   */
  labUrl?: string;
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
  /**
   * Klucz API Blockscout (np. z `process.env.BLOCKSCOUT_API_KEY`). Gdy podany, sieci EVM obsługiwane przez
   * wspólne API idą przez `https://api.blockscout.com/<chainId>` (klucz w nagłówku `authorization`, limit 5 żądań/s),
   * a rejestr obejmuje też sieci dostępne tylko z kluczem. Bez klucza — publiczne instancje jak dotąd.
   * Wartość klucza nie trafia do adresów, błędów, ograniczeń ani dzienników.
   */
  blockscoutApiKey?: string;
  /**
   * Zakres użycia klucza: `required` (domyślnie) — klucz obsługuje sieci niedostępne bez niego (Arbitrum, Gnosis),
   * reszta idzie przez publiczne instancje, a wspólne API jest dla Ethereum zapasem; `all` — każda sieć obsługiwana
   * przez wspólne API idzie przez nie, a publiczna instancja Ethereum jest zapasem. Pomiar z 2026-11-21: wspólne API
   * odpowiada w 0,1–6 s, zrywa połączenia przy kilkunastu równoczesnych żądaniach i w trybie `all` analiza bywa
   * przerywana limitem czasu — dlatego domyślny jest tryb `required`.
   */
  blockscoutKeyScope?: 'all' | 'required';
  /** Limit czasu jednego żądania do eksploratorów EVM w ms; domyślnie 25 000. */
  evmTimeoutMs?: number;
  /** `false` wyłącza wykrywanie innych sieci EVM (zostaje sam Ethereum mainnet). */
  evmNetworks?: boolean;
  /** Ile innych sieci EVM (o największej aktywności adresu) analizować w pełni: domyślnie 0, w trybie głębokim 3. */
  maxExtraNetworks?: number;
  /** `false` wyłącza szukanie powiązanych adresów (innych adresów tej samej osoby). */
  findLinks?: boolean;
  /** Osobny budżet żądań na szukanie powiązań: domyślnie 12, w trybie głębokim 40. */
  linkBudget?: number;
  links?: LinkOptions;
  /** Osobny budżet żądań na pochodzenie środków (śledzenie wstecz): domyślnie 8, w trybie głębokim 16. */
  fundingBudget?: number;
  /** `false` wyłącza dostawcę Litecoin (litecoinspace.org). */
  litecoin?: boolean;
  /**
   * Adres węzła JSON-RPC Solana (własnego albo zakontraktowanego — np. z `process.env.SOLANA_RPC_URL`). Bez niego
   * adresy Solana nie są sprawdzane: publicznego węzła api.mainnet-beta.solana.com nie używamy (warunki w
   * docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. „Sieci blockchain: Litecoin, Solana”). Adres może zawierać klucz — nie trafia do opisów ani błędów.
   */
  solanaRpcUrl?: string;
  /** Ile najnowszych transakcji Solana rozpisać na przelewy: domyślnie 20, w trybie głębokim 60. */
  solanaMaxTransactions?: number;
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
  const apiKey = config.blockscoutApiKey?.trim() || undefined;
  const politeFetch = (config.politeFetch ?? !config.fetch) ? createPoliteFetch(rawFetch) : rawFetch;
  // Klucz doklejamy najbliżej sieci, po ograniczniku tempa: żadna warstwa wyżej go nie widzi.
  const fetchImpl = apiKey ? createKeyedFetch(politeFetch, apiKey).fetch : politeFetch;
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
  // Dostawca laboratoryjny obsługuje wyłącznie sieć `lab`, więc stoi pierwszy i nie zasłania pozostałych.
  if (config.labUrl) {
    providers.push(new LabChainProvider({ labUrl: config.labUrl, labels: config.labels, sanctions: config.sanctions, fetch: rawFetch }));
  }
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
      findLinks: config.findLinks ?? true,
      linkBudget: config.linkBudget ?? (deep ? DEEP_LINK_BUDGET : DEFAULT_LINK_BUDGET),
      links: config.links,
      fundingBudget: config.fundingBudget ?? (deep ? DEEP_FUNDING_BUDGET : DEFAULT_FUNDING_BUDGET),
      // Ustawienia domyślne dla wszystkich adresów; kontekst wywołania zmienia je dla pojedynczego adresu.
      history: {
        history: config.history,
        since: config.since,
        until: config.until,
        maxHistoryRequests: config.maxHistoryRequests ?? (deep ? DEEP_HISTORY_REQUESTS : DEFAULT_HISTORY_REQUESTS),
      },
      // Tryb głęboki: 10 największych wypływów (Bitcoin) / 12 kontrahentów (model kont) i do 4 gałęzi na transakcję.
      trace: { ...(deep ? { maxCandidates: 10 } : {}), ...config.trace },
    };
    // Jeden klient na serwis: wspólna pamięć podręczna i wspólny ogranicznik tempa.
    const walletExplorer = externalLabels
      ? new WalletExplorerClient({ fetch: fetchImpl, minIntervalMs: config.walletExplorerIntervalMs })
      : undefined;
    const tronScan = externalLabels ? new TronScanTagClient({ fetch: fetchImpl }) : undefined;
    const evmNetworks = resolveEvmNetworks(apiKey !== undefined).map((chain) =>
      // W zakresie `required` sieci z działającą publiczną instancją zostają przy niej.
      apiKey && config.blockscoutKeyScope !== 'all' && !chain.requiresKey ? (resolveEvmNetworks(false).find((item) => item.id === chain.id) ?? chain) : chain,
    );
    const keyedAll = apiKey !== undefined && config.blockscoutKeyScope === 'all';
    const evm = {
      ...live,
      balances: true,
      timeoutMs: config.evmTimeoutMs,
      ...(externalLabels ? { metadataUrl: keyedAll ? `${BLOCKSCOUT_KEYED_API}/services/metadata` : 'https://metadata.services.blockscout.com' } : {}),
    };
    // Ethereum: z kluczem są dwie drogi do tych samych danych (publiczna instancja ↔ wspólne API z kluczem);
    // gdy pierwsza zawiedzie, przez 10 minut pytamy od razu drugą.
    const routeChain = (keyed: boolean) => resolveEvmNetworks(keyed).find((item) => item.id === 'ethereum');
    const routeProvider = (keyed: boolean) =>
      new BlockscoutProvider({
        ...evm,
        chain: routeChain(keyed),
        metadataUrl: externalLabels ? (keyed ? `${BLOCKSCOUT_KEYED_API}/services/metadata` : 'https://metadata.services.blockscout.com') : undefined,
      });
    const publicRoute = 'publiczna instancja eth.blockscout.com';
    const keyedRoute = 'API Blockscout z kluczem (api.blockscout.com)';
    const ethereumProvider: ChainProvider = apiKey
      ? new FailoverProvider({
          primary: routeProvider(keyedAll),
          secondary: routeProvider(!keyedAll),
          primaryRoute: keyedAll ? keyedRoute : publicRoute,
          secondaryRoute: keyedAll ? publicRoute : keyedRoute,
        })
      : new BlockscoutProvider({ ...evm, chain: evmNetworks.find((item) => item.id === 'ethereum') });
    providers.push(
      new EsploraProvider({
        ...live,
        labelLookup: walletExplorer,
        id: 'esplora-blockstream',
        label: 'Blockstream Esplora (Bitcoin)',
        siteUrl: 'https://blockstream.info',
        testnetSiteUrl: 'https://blockstream.info/testnet',
        fallbackSiteUrl: 'https://mempool.space',
      }),
      new EsploraProvider({
        ...live,
        labelLookup: walletExplorer,
        id: 'esplora-mempool',
        label: 'mempool.space (Bitcoin)',
        siteUrl: 'https://mempool.space',
        testnetSiteUrl: 'https://mempool.space/testnet',
        fallbackSiteUrl: 'https://blockstream.info',
      }),
      // Ethereum mainnet + wykrywanie innych sieci EVM; w trybie głębokim pełna analiza sieci o największej aktywności.
      (config.evmNetworks ?? true)
        ? new EvmMultiChainProvider({
            main: ethereumProvider,
            createProvider: (chain) => new BlockscoutProvider({ ...evm, chain }),
            fetch: fetchImpl,
            maxExtraNetworks: config.maxExtraNetworks ?? (deep ? 3 : 0),
            networks: evmNetworks,
            // Wspólne API obsługuje 2 żądania naraz, więc sprawdzenie kilkunastu sieci trwa dłużej niż na publicznych instancjach.
            ...(keyedAll ? { discoveryTimeoutMs: 25_000 } : {}),
          })
        : ethereumProvider,
      new TronGridProvider({ ...live, labelLookup: tronScan, ...(externalLabels ? { tronScanUrl: 'https://apilist.tronscanapi.com' } : {}) }),
    );
    if (config.litecoin ?? true) {
      // Litecoin Space (Fundacja Litecoin): to samo API Esplora. Bez etykiet zewnętrznych (WalletExplorer obejmuje
      // tylko Bitcoin) i bez śledzenia dalszej drogi środków — zbiór etykiet nie zna adresów giełd w tej sieci,
      // więc dodatkowe zapytania nie mogłyby niczego rozpoznać. Klaster portfela i powiązane adresy — jak dla Bitcoina.
      providers.push(
        new EsploraProvider({
          ...live,
          network: 'litecoin',
          followDeposits: false,
          id: 'esplora-litecoinspace',
          label: 'Litecoin Space (Litecoin)',
          siteUrl: 'https://litecoinspace.org',
        }),
      );
    }
    const solanaRpcUrl = config.solanaRpcUrl?.trim();
    if (solanaRpcUrl) {
      providers.push(
        new SolanaRpcProvider({
          ...live,
          rpcUrl: solanaRpcUrl,
          maxTransactions: config.solanaMaxTransactions ?? (deep ? 60 : undefined),
          requestBudget: Math.max(live.requestBudget, (config.solanaMaxTransactions ?? (deep ? 60 : 20)) + 2),
        }),
      );
    }
  }
  return providers;
}
