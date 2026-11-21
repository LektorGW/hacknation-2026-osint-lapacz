// Łączniki do publicznych źródeł Web2. Każdy łącznik wysyła wyłącznie zapytanie
// do swojego źródła — dane analizy nie trafiają nigdzie indziej.

import type { SourceConnector } from '@olcys/core';
import { createBitcointalkConnector } from './bitcointalk.ts';
import { createEnsConnector } from './ens.ts';
import { createFediverseConnector, loadFediverseInstances } from './fediverse.ts';
import { createGithubActivityConnector, createGithubConnector, createGithubGistsConnector } from './github.ts';
import { createGravatarConnector } from './gravatar.ts';
import { createHttpClient } from './http.ts';
import type { Fetcher } from './http.ts';
import { createKeybaseConnector } from './keybase.ts';
import { createBitcoinWhosWhoConnector, createGithubSearchConnector, createWalletExplorerConnector, createWaybackTwitterConnector } from './deep/extra.ts';
import { createDeepSearchConnector } from './deep/search.ts';
import { createMonitorConnectors, loadMonitorSources, mergeMonitorSources } from './monitor/index.ts';
import type { MonitorSourceConfig } from './monitor/index.ts';
import type { DeepSearchOptions } from './deep/search.ts';
import { createSandboxConnectors } from './sandbox.ts';
import { createTelegramConnector } from './telegram.ts';
import { createTorConnector } from './tor.ts';
import { createWaybackConnector } from './wayback.ts';
import { createWwwConnector } from './www.ts';

export { htmlToText } from './html.ts';
export { addressFromHref, findEnsNames, normalizeAddressText } from './address-text.ts';
export { deepTargets } from './deep/search.ts';
export type { DeepSearchOptions, DeepTarget } from './deep/search.ts';
export type { Fetcher } from './http.ts';
export {
  isLowRelevance,
  listMonitorConnectors,
  loadMonitorSources,
  mergeMonitorSources,
  monitorSourceCommunity,
  monitorSourceHost,
  runMonitorPass,
  summarizeMonitorSources,
  MONITOR_ENGINES,
  MONITOR_PREFIX,
} from './monitor/index.ts';
export type {
  HtmlListSelectors,
  MonitorConnector,
  MonitorDiscovery,
  MonitorEngine,
  MonitorPassOptions,
  MonitorPassResult,
  MonitorPassState,
  MonitorPassStatus,
  MonitorPassSummary,
  MonitorRegistry,
  MonitorSourceConfig,
  MonitorSourceOverride,
  MonitorSourcesSummary,
} from './monitor/index.ts';

export interface SourcesConfig {
  /** Adres piaskownicy (apps/sandbox); gdy podany, powstają łączniki fikcyjnych serwisów. */
  sandboxUrl?: string;
  /** Włącza łączniki do prawdziwych, publicznych serwisów. */
  enableLive?: boolean;
  /** Adres proxy HTTP Tora (HTTPTunnelPort), np. `http://127.0.0.1:8118`. */
  torProxyUrl?: string;
  /**
   * Opcjonalny token GitHub (bez uprawnień) podnoszący limit zapytań.
   * Trafia wyłącznie w nagłówku Authorization do api.github.com.
   */
  githubToken?: string;
  /** Instancje Mastodon sprawdzane dla samego nicka; domyślnie config/fediverse-instances.json. */
  fediverseInstances?: string[];
  /** Publiczne kanały Telegram przeglądane przy typowaniu; domyślnie config/telegram-channels.json (pusta lista). */
  telegramChannels?: string[];
  /**
   * Rejestr źródeł monitoringu; domyślnie (gdy `enableLive`) wszystkie pliki config/monitor-sources/*.json.
   * Każdy włączony wpis daje łącznik `mon-<id>` z metodą `discover`, domyślnie wyłączony w analizie osoby.
   */
  monitorSources?: MonitorSourceConfig[];
  /** Ustawienia łącznika `deep-search`: budżet czasu (domyślnie 45 s), liczba hostów naraz (12), limit czasu żądania (8 s), liczba serwisów StackExchange (4). */
  deepSearch?: DeepSearchOptions;
  /** Tani filtr wstępny monitoringu: `discover` zwraca tylko posty zawierające adres kryptowalutowy. */
  monitorOnlyWithAddresses?: boolean;
  /** Odbiorca komunikatów o błędach konfiguracji (np. niepoprawny wpis rejestru). */
  log?: (message: string) => void;
  /** Wyłącza ochronę przed hostami prywatnymi w łącznikach pobierających podany adres (wyłącznie testy). */
  allowPrivateHosts?: boolean;
  /** Zamiennik `fetch` dla łączników live — w testach atrapa z zapisanymi odpowiedziami. */
  fetcher?: Fetcher;
  /** Minimalny odstęp między żądaniami do jednego hosta w łącznikach live (domyślnie 400 ms). */
  minRequestIntervalMs?: number;
}

export function createLiveConnectors(config: SourcesConfig): SourceConnector[] {
  const http = createHttpClient({
    fetcher: config.fetcher,
    minIntervalMs: config.minRequestIntervalMs,
    allowPrivateHosts: config.allowPrivateHosts,
  });
  const github = { token: config.githubToken?.trim() || undefined };
  const instances = config.fediverseInstances ?? loadFediverseInstances().instances;
  const registry = registrySources(config);
  return [
    createKeybaseConnector(http),
    createEnsConnector(http),
    createGithubConnector(http, github),
    createGithubGistsConnector(http, github),
    createGithubActivityConnector(http, github),
    createGravatarConnector(http),
    createFediverseConnector(http, config.fediverseInstances ? { instances } : {}),
    createTelegramConnector(http, config.telegramChannels ? { channels: config.telegramChannels } : {}),
    createBitcointalkConnector(http),
    createWwwConnector(http, { skipHosts: instances }),
    createWaybackConnector(http),
    createWaybackTwitterConnector(http),
    createWalletExplorerConnector(http),
    createBitcoinWhosWhoConnector(http),
    createGithubSearchConnector(http, github),
    createDeepSearchConnector(http, registry, config.deepSearch),
    ...monitorConnectors(config, http, github.token, registry),
  ];
}

/** Rejestr źródeł: z konfiguracji albo z plików; czytany raz dla monitoringu i głębokiego wyszukiwania. */
function registrySources(config: SourcesConfig): MonitorSourceConfig[] {
  if (config.monitorSources) return mergeMonitorSources([{ file: 'rejestr', entries: config.monitorSources }]).sources;
  const registry = loadMonitorSources();
  for (const warning of registry.warnings) config.log?.(`Monitoring: ${warning}`);
  return registry.sources;
}

function monitorConnectors(config: SourcesConfig, http: ReturnType<typeof createHttpClient>, githubToken: string | undefined, sources: MonitorSourceConfig[]): SourceConnector[] {
  return createMonitorConnectors(http, sources, {
    ...(githubToken ? { githubToken } : {}),
    ...(config.monitorOnlyWithAddresses !== undefined ? { onlyWithAddresses: config.monitorOnlyWithAddresses } : {}),
    ...(config.log ? { log: config.log } : {}),
  });
}

export function createConnectors(config: SourcesConfig): SourceConnector[] {
  const connectors: SourceConnector[] = [];
  if (config.sandboxUrl) connectors.push(...createSandboxConnectors(config.sandboxUrl));
  if (config.enableLive) connectors.push(...createLiveConnectors(config));
  if (config.torProxyUrl) connectors.push(createTorConnector(config.torProxyUrl));
  return connectors;
}
