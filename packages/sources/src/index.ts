// Łączniki do publicznych źródeł Web2. Każdy łącznik wysyła wyłącznie zapytanie
// do swojego źródła — dane analizy nie trafiają nigdzie indziej.

import type { ConnectorContext, Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { createBitcointalkConnector } from './bitcointalk.ts';
import { createBlueskyConnector } from './bluesky.ts';
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
import { createLabConnectors } from './lab.ts';
import { createNostrConnector } from './nostr.ts';
import type { NostrRelayQuery } from './nostr.ts';
import { createOpenPgpConnector } from './openpgp.ts';
import { applyOwnershipProofsToAll } from './proof-text.ts';
import { createCeidgConnector, createKrsConnector, createVatWhitelistConnector, withRegistryIdentifiers } from './registry.ts';
import { createSandboxConnectors } from './sandbox.ts';
import { createSearchConnectors } from './search/index.ts';
import type { SearchConfig } from './search/index.ts';
import { createTelegramConnector } from './telegram.ts';
import { createTorConnector } from './tor.ts';
import { createWaybackConnector } from './wayback.ts';
import { createWwwConnector } from './www.ts';

export { htmlToText } from './html.ts';
export { addressFromHref, findEnsNames, normalizeAddressText } from './address-text.ts';
export { applyOwnershipProofs, applyOwnershipProofsToAll, findOwnershipProofs, publisherNamedIn, proofUrl, PROOF_NOTE_PREFIX, PROOF_URL_PARAM } from './proof-text.ts';
export type { OwnershipProof, ProofFormat } from './proof-text.ts';
export { findRegistryNumbers, isValidNip, isValidNrb, registryIdentifier, registryNumber, withRegistryIdentifiers } from './registry.ts';
export type { CeidgOptions, RegistryNumber } from './registry.ts';
export { createSearchConnectors, searchConfigFromEnv } from './search/index.ts';
export type { SearchConfig, WebSearchProvider } from './search/index.ts';
export { deepTargets } from './deep/search.ts';
export type { DeepSearchOptions, DeepTarget } from './deep/search.ts';
export type { Fetcher } from './http.ts';
export { LAB_PORTALS, LAB_PREFIX, createLabConnectors } from './lab.ts';
export type { LabConnectorOptions, LabPortal } from './lab.ts';
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
  /**
   * Adres laboratorium tożsamości (apps/identity-lab, np. `http://127.0.0.1:8787`); gdy podany, powstają
   * łączniki `lab-*` do 27 portali laboratorium. To symulacja lokalna na danych syntetycznych — domyślnie wyłączona.
   */
  labUrl?: string;
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
  /**
   * Przekaźniki Nostr (wss://…), z których łącznik `live-nostr` może pobrać profil konta. Domyślnie ze zmiennej
   * NOSTR_RELAYS (lista po przecinku); bez niej odczyt z przekaźników jest wyłączony i działa samo NIP-05 (HTTP).
   */
  nostrRelays?: string[];
  /** Zamiennik zapytania do przekaźnika Nostr (wyłącznie testy). */
  nostrRelayQuery?: NostrRelayQuery;
  /**
   * Czy numery NIP / KRS podane wprost w publikacjach z prawdziwych serwisów mają trafiać do łączników rejestrów
   * (`live-vat-whitelist`, `live-krs`) jako identyfikatory odkryte. Domyślnie tak; dane piaskownicy i laboratorium
   * nigdy nie uruchamiają zapytań do prawdziwych rejestrów.
   */
  discoverRegistryNumbers?: boolean;
  /**
   * Token JWT API v3 Hurtowni danych CEIDG (dane.biznes.gov.pl), wydawany po rejestracji Profilem Zaufanym.
   * Domyślnie ze zmiennej CEIDG_API_TOKEN; bez tokenu łącznik `live-ceidg` nie powstaje.
   */
  ceidgToken?: string;
  /** Łączniki katalogu search/: wyszukiwarka internetowa (klucze), Farcaster, rejestry publiczne. */
  search?: SearchConfig;
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
  const nostrRelays = config.nostrRelays ?? (process.env.NOSTR_RELAYS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  // Token CEIDG nigdy nie trafia do dziennika ani do treści śladu — tylko w nagłówku Authorization.
  const ceidgToken = (config.ceidgToken ?? process.env.CEIDG_API_TOKEN ?? '').trim() || undefined;
  const connectors: SourceConnector[] = [
    createKeybaseConnector(http),
    createEnsConnector(http),
    createGithubConnector(http, github),
    createGithubGistsConnector(http, github),
    createGithubActivityConnector(http, github),
    createGravatarConnector(http),
    createFediverseConnector(http, config.fediverseInstances ? { instances } : {}),
    createTelegramConnector(http, config.telegramChannels ? { channels: config.telegramChannels } : {}),
    createBitcointalkConnector(http),
    createBlueskyConnector(http),
    createNostrConnector(http, { relays: nostrRelays, ...(config.nostrRelayQuery ? { relayQuery: config.nostrRelayQuery } : {}) }),
    createOpenPgpConnector(http),
    createVatWhitelistConnector(http),
    createKrsConnector(http),
    ...(ceidgToken ? [createCeidgConnector(http, { token: ceidgToken })] : []),
    createWwwConnector(http, { skipHosts: instances }),
    createWaybackConnector(http),
    createWaybackTwitterConnector(http),
    createWalletExplorerConnector(http),
    createBitcoinWhosWhoConnector(http),
    createGithubSearchConnector(http, github),
    createDeepSearchConnector(http, registry, config.deepSearch),
    ...monitorConnectors(config, http, github.token, registry),
  ];
  if (config.discoverRegistryNumbers === false) return connectors;
  // Numer NIP / KRS podany wprost we własnej publikacji prowadzi do urzędowego rejestru (tylko wyszukiwanie osoby, nie monitoring).
  return connectors.map((connector) => {
    if (connector.id.startsWith('mon-')) return connector;
    const search = connector.search.bind(connector);
    return Object.assign(connector, { search: async (identifier: Identifier, context: ConnectorContext) => (await search(identifier, context)).map(withRegistryIdentifiers) });
  });
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

/**
 * Każdy łącznik przepuszcza swoje dokumenty przez weryfikację podpisanych wiadomości (proof-text.ts):
 * ważny dowód wymieniający konto publikujące daje dodatkowy dokument `cryptographic_proof`,
 * a podpis nieważny albo skopiowany — tylko uwagę w treści. Weryfikacja jest lokalna (bez sieci).
 */
function withOwnershipProofs<T extends SourceConnector>(connector: T): T {
  const wrapped = { ...connector } as T & {
    discover?: (context: ConnectorContext, limit: number) => Promise<SourceDocument[]>;
    discoverDetailed?: (context: ConnectorContext, limit: number, pass?: unknown) => Promise<{ documents: SourceDocument[] }>;
  };
  wrapped.search = async (identifier, context) => applyOwnershipProofsToAll(await connector.search(identifier, context));
  const { discover, discoverDetailed } = connector as typeof wrapped;
  if (typeof discover === 'function') wrapped.discover = async (context, limit) => applyOwnershipProofsToAll(await discover.call(connector, context, limit));
  if (typeof discoverDetailed === 'function') {
    wrapped.discoverDetailed = async (context, limit, pass) => {
      const result = await discoverDetailed.call(connector, context, limit, pass);
      return { ...result, documents: applyOwnershipProofsToAll(result.documents) };
    };
  }
  return wrapped;
}

export function createConnectors(config: SourcesConfig): SourceConnector[] {
  const connectors: SourceConnector[] = [];
  if (config.sandboxUrl) connectors.push(...createSandboxConnectors(config.sandboxUrl));
  if (config.labUrl) connectors.push(...createLabConnectors(config.labUrl, config.fetcher ? { fetcher: config.fetcher } : {}));
  if (config.enableLive) connectors.push(...createLiveConnectors(config));
  if (config.torProxyUrl) connectors.push(createTorConnector(config.torProxyUrl));
  // Katalog search/: rejestry publiczne (lokalnie, zawsze), Farcaster i wyszukiwarka internetowa (tylko z `enableLive`).
  connectors.push(
    ...createSearchConnectors(config.search ?? {}, {
      enableLive: config.enableLive,
      fetcher: config.fetcher,
      minRequestIntervalMs: config.minRequestIntervalMs,
      allowPrivateHosts: config.allowPrivateHosts,
      log: config.log,
    }),
  );
  return connectors.map(withOwnershipProofs);
}
