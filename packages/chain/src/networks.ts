// Sieci EVM: ten sam adres działa na wielu sieciach, a wypłata na giełdę przez
// tańszą sieć jest niewidoczna, gdy patrzymy tylko na Ethereum mainnet.
// Rejestr (`data/evm-networks.json`) zawiera wyłącznie publiczne eksploratory
// o API Blockscout v2 potwierdzone na żywo. Typ `Network` w core ma dla EVM
// jedną wartość `ethereum`, dlatego przelewy z innych sieci mają
// `network: 'ethereum'` i pole dodatkowe `chain: '<id sieci>'`.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import type { BalanceEntry } from './balances.ts';
import { USER_AGENT } from './http.ts';
import type { FetchLike } from './http.ts';
import { createLabelSet } from './labels.ts';
import type { LabelSet } from './labels.ts';
import type { LinkedAddress } from './links.ts';

export interface EvmNetwork {
  /** Identyfikator w rejestrze, np. `optimism`; trafia do pola `chain`. */
  id: string;
  name: string;
  chainId: number;
  /** Symbol waluty natywnej (ETH na większości sieci warstwy 2). */
  nativeAsset: string;
  /** Adres API Blockscout v2 (bez końcowego ukośnika). */
  apiUrl: string;
  /** Adres eksploratora dla ludzi. */
  explorerUrl: string;
  /** Kontrakty stablecoinów potwierdzone na żywo. */
  stablecoins: { symbol: string; address: string; holders?: number }[];
  /** Sieć dostępna tylko przez API Blockscout z kluczem; bez klucza jest pomijana. */
  requiresKey?: boolean;
  /** `false`: API z kluczem nie obsługuje tej sieci na planie darmowym — zawsze publiczna instancja. */
  keyedApi?: boolean;
  note?: string;
}

/** Adres wspólnego API Blockscout z kluczem: `https://api.blockscout.com/<chainId>/api/v2/…`. */
export const BLOCKSCOUT_KEYED_API = 'https://api.blockscout.com';
export const BLOCKSCOUT_KEYED_HOST = 'api.blockscout.com';

/**
 * Sieci do użycia przy danej konfiguracji: bez klucza — tylko publiczne instancje; z kluczem — wszystkie sieci,
 * a te obsługiwane przez API z kluczem idą przez `api.blockscout.com/<chainId>`.
 */
export function resolveEvmNetworks(hasKey: boolean, networks: EvmNetwork[] = [...loadEvmNetworks().networks, ...loadEvmNetworks().keyed]): EvmNetwork[] {
  return networks
    .filter((chain) => hasKey || !chain.requiresKey)
    .map((chain) => (hasKey && chain.keyedApi !== false ? { ...chain, apiUrl: `${BLOCKSCOUT_KEYED_API}/${chain.chainId}` } : chain));
}

/** Zużycie API z kluczem — do raportowania; nie zawiera klucza. */
export interface KeyedApiUsage {
  calls: number;
  /** Ostatnia wartość nagłówka `x-credits-remaining`. */
  creditsRemaining?: number;
}

/**
 * Dokleja klucz API do żądań kierowanych do `api.blockscout.com` — w NAGŁÓWKU `authorization`, nigdy w adresie,
 * żeby klucz nie trafił do komunikatów błędów, ograniczeń ani dzienników. Inne hosty dostają żądanie bez zmian.
 */
export function createKeyedFetch(fetchImpl: FetchLike, apiKey: string): { fetch: FetchLike; usage: KeyedApiUsage } {
  const usage: KeyedApiUsage = { calls: 0 };
  const mask = (text: string) => text.split(apiKey).join('***');
  const keyed: FetchLike = async (input, init) => {
    let host = '';
    try {
      host = new URL(input).host;
    } catch {
      // Adres niepoprawny — obsłuży go właściwy `fetch`.
    }
    if (host !== BLOCKSCOUT_KEYED_HOST) return fetchImpl(input, init);
    usage.calls += 1;
    try {
      const response = await fetchImpl(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), authorization: `Bearer ${apiKey}` } });
      const credits = Number(response.headers.get('x-credits-remaining'));
      if (Number.isFinite(credits) && response.headers.get('x-credits-remaining') !== null) usage.creditsRemaining = credits;
      return response;
    } catch (error) {
      // Na wszelki wypadek: komunikat błędu sieci nigdy nie może zawierać klucza.
      if (error instanceof Error) error.message = mask(error.message);
      throw error;
    }
  };
  return { fetch: keyed, usage };
}

export interface EvmNetworkRegistry {
  verifiedAt?: string;
  /** Sieci z publiczną instancją działającą bez klucza. */
  networks: EvmNetwork[];
  /** Sieci dostępne wyłącznie przez API Blockscout z kluczem. */
  keyed: EvmNetwork[];
  /** Sieci sprawdzone i niedostępne bez klucza — z powodem. */
  unavailable: { id: string; name: string; host: string; reason: string }[];
}

let registry: EvmNetworkRegistry | undefined;

export function loadEvmNetworks(): EvmNetworkRegistry {
  if (registry) return registry;
  const path = fileURLToPath(new URL('../data/evm-networks.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<EvmNetworkRegistry>;
  const networks = (parsed.networks ?? []).filter(
    (item) => typeof item.id === 'string' && typeof item.apiUrl === 'string' && typeof item.nativeAsset === 'string' && Array.isArray(item.stablecoins),
  );
  const keyed = (parsed.keyed ?? []).filter((item) => typeof item.id === 'string' && typeof item.nativeAsset === 'string' && Array.isArray(item.stablecoins));
  registry = { ...(parsed.verifiedAt ? { verifiedAt: parsed.verifiedAt } : {}), networks, keyed, unavailable: parsed.unavailable ?? [] };
  return registry;
}

export function getEvmNetwork(id: string): EvmNetwork | undefined {
  const all = loadEvmNetworks();
  return all.networks.find((item) => item.id === id) ?? all.keyed.find((item) => item.id === id);
}

/**
 * Zbiór etykiet dla sieci innej niż Ethereum mainnet: tylko kontrakty stablecoinów tej sieci.
 * Etykiety adresów z Ethereum NIE są przenoszone — ten sam adres na innej sieci może mieć innego właściciela
 * (dotyczy kontraktów), a etykiety giełd bierzemy ze znaczników eksploratora tej sieci.
 */
export function chainLabelSet(chain: EvmNetwork): LabelSet {
  return createLabelSet(
    chain.stablecoins.map((coin) => ({
      network: 'ethereum' as const,
      address: coin.address,
      label: `${coin.symbol}: kontrakt tokena w sieci ${chain.name}`,
      addressClass: 'smart_contract' as const,
      asset: coin.symbol,
    })),
    `rejestr sieci EVM OŁCyŚ (packages/chain/data/evm-networks.json, sieć ${chain.name})`,
  );
}

/** Obecność adresu w jednej sieci EVM. */
export interface NetworkPresence {
  networkId: string;
  name: string;
  /** Liczba transakcji wysłanych z adresu lub na adres w tej sieci. */
  txCount: number;
  /** Liczba transferów tokenów z udziałem adresu. */
  tokenTransfers: number;
  /** Saldo waluty natywnej; brak, gdy nie udało się go pobrać. */
  balance?: number;
  nativeAsset: string;
  /** Daty skrajnych pobranych przelewów — tylko dla sieci, które przeanalizowano. */
  firstSeen?: string;
  lastSeen?: string;
  /** Strona adresu w eksploratorze tej sieci. */
  explorerUrl: string;
}

export interface DiscoverOptions {
  fetch?: FetchLike;
  networks?: EvmNetwork[];
  /** Łączny budżet czasu na wszystkie sieci. */
  timeoutMs?: number;
}

export const DISCOVERY_TIMEOUT_MS = 8000;

/**
 * Sprawdza, w których sieciach EVM z rejestru adres ma jakąkolwiek aktywność: jedno żądanie na sieć
 * (liczniki adresu), współbieżnie, w budżecie czasu ~8 s; dla sieci z aktywnością drugie żądanie o saldo.
 * Do eksploratorów trafia wyłącznie adres.
 */
export async function discoverNetworks(
  address: string,
  context: ConnectorContext,
  options: DiscoverOptions = {},
): Promise<{ networks: NetworkPresence[]; limitations: string[] }> {
  const fetchImpl = options.fetch ?? fetch;
  const networks = options.networks ?? resolveEvmNetworks(false);
  const deadline = AbortSignal.timeout(options.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
  const failed: string[] = [];
  const getJson = async <T>(url: string): Promise<T> => {
    const response = await fetchImpl(url, { signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  };

  const found = await Promise.all(
    networks.map(async (chain): Promise<NetworkPresence | undefined> => {
      const base = `${chain.apiUrl}/api/v2/addresses/${encodeURIComponent(address)}`;
      try {
        const counters = await getJson<{ transactions_count?: string; token_transfers_count?: string }>(`${base}/counters`);
        const txCount = Number(counters.transactions_count ?? 0) || 0;
        const tokenTransfers = Number(counters.token_transfers_count ?? 0) || 0;
        if (txCount === 0 && tokenTransfers === 0) return undefined;
        let balance: number | undefined;
        try {
          const info = await getJson<{ coin_balance?: string | null }>(base);
          if (info.coin_balance != null) balance = Number(BigInt(info.coin_balance) / 10n ** 10n) / 1e8;
        } catch {
          // Saldo jest dodatkiem — sama obecność w sieci wynika z liczników.
        }
        return {
          networkId: chain.id,
          name: chain.name,
          txCount,
          tokenTransfers,
          ...(balance !== undefined ? { balance } : {}),
          nativeAsset: chain.nativeAsset,
          explorerUrl: `${chain.explorerUrl}/address/${address}`,
        };
      } catch (error) {
        if (context.signal?.aborted) throw error;
        // 404 = eksplorator nie zna adresu, czyli brak aktywności w tej sieci.
        if (error instanceof Error && error.message === 'HTTP 404') return undefined;
        failed.push(`${chain.name} (${deadline.aborted ? 'brak odpowiedzi w budżecie czasu' : error instanceof Error ? error.message : String(error)})`);
        return undefined;
      }
    }),
  );
  const limitations: string[] = [];
  if (failed.length > 0) limitations.push(`Sieci EVM: nie udało się sprawdzić ${failed.length} z ${networks.length} sieci — ${failed.join(', ')}. Aktywność w tych sieciach pozostaje nieznana.`);
  // Sieci niedostępne w tej konfiguracji: bez klucza cała lista, z kluczem — bez tych, które właśnie sprawdziliśmy.
  const unavailable = loadEvmNetworks().unavailable.filter((item) => !networks.some((chain) => chain.id === item.id));
  if (unavailable.length > 0) {
    limitations.push(
      `Sieci EVM: sprawdzono ${networks.length} sieci dostępnych w tej konfiguracji. NIE sprawdzono: ${unavailable.map((item) => item.name).join(', ')} ` +
        '— brak dostępu bez klucza, płatny plan API albo blokada (szczegóły w data/evm-networks.json). Wypłaty przez te sieci pozostają niewidoczne.',
    );
  }
  return { networks: found.filter((item): item is NetworkPresence => item !== undefined).sort((a, b) => b.txCount + b.tokenTransfers - (a.txCount + a.tokenTransfers)), limitations };
}

/** Wynik analizy adresu EVM z polami dodatkowymi (poza kontraktem core). */
export type MultiChainActivity = ChainActivity & {
  networks?: NetworkPresence[];
  balances?: BalanceEntry[];
  linkedAddresses?: LinkedAddress[];
  openQuestions?: string[];
};

export interface MultiChainConfig {
  /** Dostawca Ethereum mainnet. */
  main: ChainProvider;
  /** Tworzy dostawcę dla innej sieci z rejestru (te same ustawienia co dla Ethereum). */
  createProvider(chain: EvmNetwork): ChainProvider;
  fetch?: FetchLike;
  networks?: EvmNetwork[];
  /** Ile innych sieci (o największej aktywności) analizujemy w pełni; 0 = samo wykrywanie. */
  maxExtraNetworks?: number;
  discoveryTimeoutMs?: number;
}

/**
 * Dostawca dla adresów EVM: analiza Ethereum mainnet + wykrycie innych sieci, w których adres jest używany.
 * W trybie głębokim sieci o największej liczbie transakcji przechodzą tę samą analizę wypływów, etykiet
 * i ścieżek; ich przelewy, wskaźniki i ścieżki trafiają do wspólnego wyniku z polem `chain`.
 */
export class EvmMultiChainProvider implements ChainProvider {
  id: string;
  label: string;
  config: MultiChainConfig;

  constructor(config: MultiChainConfig) {
    this.config = config;
    this.id = config.main.id;
    this.label = config.main.label;
  }

  supports(network: Network, address: string): boolean {
    return this.config.main.supports(network, address);
  }

  // Ustawienia dostawcy Ethereum są widoczne także przez dostawcę wielosieciowego (te same obowiązują w innych sieciach).
  private get mainSettings(): Record<string, unknown> {
    return this.config.main as unknown as Record<string, unknown>;
  }

  get options(): unknown {
    return this.mainSettings.options;
  }

  get requestBudget(): unknown {
    return this.mainSettings.requestBudget;
  }

  get linkBudget(): unknown {
    return this.mainSettings.linkBudget;
  }

  get findLinks(): unknown {
    return this.mainSettings.findLinks;
  }

  get history(): unknown {
    return this.mainSettings.history;
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<MultiChainActivity> {
    const all = this.config.networks ?? resolveEvmNetworks(false);
    const others = all.filter((chain) => chain.id !== 'ethereum');
    // Analiza Ethereum startuje pierwsza (jej żądania są pierwsze w kolejce ogranicznika tempa);
    // wykrywanie sieci biegnie równolegle i nie wydłuża analizy.
    const mainRun = this.config.main.getActivity(network, address, context);
    mainRun.catch(() => undefined);
    const discovery = discoverNetworks(address, context, { fetch: this.config.fetch, networks: all, timeoutMs: this.config.discoveryTimeoutMs }).catch((error: unknown) => {
      if (context.signal?.aborted) throw error;
      return { networks: [] as NetworkPresence[], limitations: [`Sieci EVM: wykrywanie sieci nie powiodło się — ${error instanceof Error ? error.message : String(error)}`] };
    });
    const main = (await mainRun) as MultiChainActivity;
    const everywhere = await discovery;
    // Liczniki Ethereum z eksploratora (cała historia); gdy ich brak — liczby z pobranych przelewów.
    const counted = everywhere.networks.find((item) => item.networkId === 'ethereum');
    const discovered = { networks: everywhere.networks.filter((item) => item.networkId !== 'ethereum'), limitations: everywhere.limitations };

    const ethereum = all.find((chain) => chain.id === 'ethereum');
    const networks: NetworkPresence[] = [
      {
        networkId: 'ethereum',
        name: ethereum?.name ?? 'Ethereum',
        txCount: counted?.txCount ?? main.profile.txCount,
        tokenTransfers: counted?.tokenTransfers ?? main.transfers.filter((item) => item.asset !== main.profile.nativeAsset).length,
        balance: main.profile.balance,
        nativeAsset: main.profile.nativeAsset,
        ...(main.profile.firstSeen ? { firstSeen: main.profile.firstSeen } : {}),
        ...(main.profile.lastSeen ? { lastSeen: main.profile.lastSeen } : {}),
        explorerUrl: `${ethereum?.explorerUrl ?? 'https://eth.blockscout.com'}/address/${address}`,
      },
      ...discovered.networks,
    ];
    const result: MultiChainActivity = {
      ...main,
      transfers: [...main.transfers],
      cashOuts: [...main.cashOuts],
      cashOutPlnByYear: { ...main.cashOutPlnByYear },
      limitations: [...main.limitations, ...discovered.limitations],
      networks,
    };
    if (discovered.networks.length > 0) {
      result.limitations.push(
        `Sieci EVM: adres jest używany także w ${discovered.networks.length} innych sieciach (${discovered.networks.map((item) => `${item.name}: ${item.txCount} transakcji, ${item.tokenTransfers} transferów tokenów`).join('; ')}). ` +
          'Liczba transakcji i przelewy w profilu dotyczą sieci Ethereum, chyba że przelew ma pole `chain`.',
      );
    }

    const limit = this.config.maxExtraNetworks ?? 0;
    const selected = discovered.networks.slice(0, limit);
    for (const presence of selected) {
      const chain = others.find((item) => item.id === presence.networkId)!;
      let extra: MultiChainActivity;
      try {
        extra = (await this.config.createProvider(chain).getActivity(network, address, context)) as MultiChainActivity;
      } catch (error) {
        if (context.signal?.aborted) throw error;
        result.limitations.push(`[${chain.name}] Nie udało się przeanalizować tej sieci: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (extra.profile.firstSeen) presence.firstSeen = extra.profile.firstSeen;
      if (extra.profile.lastSeen) presence.lastSeen = extra.profile.lastSeen;
      result.transfers.push(...extra.transfers);
      result.cashOuts.push(...extra.cashOuts);
      if (extra.trails?.length) result.trails = [...(result.trails ?? []), ...extra.trails];
      if (extra.balances?.length) result.balances = [...(result.balances ?? []), ...extra.balances];
      if (extra.linkedAddresses?.length) result.linkedAddresses = [...(result.linkedAddresses ?? []), ...extra.linkedAddresses].sort((a, b) => b.strength - a.strength);
      if (extra.openQuestions?.length) result.openQuestions = [...(result.openQuestions ?? []), ...extra.openQuestions];
      for (const [year, value] of Object.entries(extra.cashOutPlnByYear)) {
        result.cashOutPlnByYear[year] = Math.round(((result.cashOutPlnByYear[year] ?? 0) + value) * 100) / 100;
      }
      // Każde ograniczenie z innej sieci nosi jej nazwę.
      result.limitations.push(...extra.limitations.map((item) => `[${chain.name}] ${item}`));
    }
    if (selected.length > 0) {
      result.transfers.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      result.cashOuts.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
      result.limitations.push(
        `Sieci EVM: pełną analizę (wypływy, etykiety, ścieżki) wykonano dla Ethereum oraz ${selected.map((item) => item.name).join(', ')}; ` +
          'przelewy, wskaźniki i ścieżki z tych sieci mają pole `chain` i odnośnik do właściwego eksploratora. Sumy PLN obejmują wszystkie przeanalizowane sieci.',
      );
    }
    if (discovered.networks.length > selected.length) {
      result.limitations.push(
        `Sieci EVM: bez pełnej analizy pozostały ${discovered.networks.slice(limit).map((item) => item.name).join(', ')} ` +
          `(${limit === 0 ? 'analiza innych sieci działa w trybie głębokim' : `limit ${limit} dodatkowych sieci`}) — wypłaty przez te sieci nie są ujęte.`,
      );
    }
    return result;
  }
}
