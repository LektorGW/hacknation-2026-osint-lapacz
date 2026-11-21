// Łączniki katalogu search/: wyszukiwarka internetowa przez oficjalne API (`web-search`),
// Farcaster (`live-farcaster`) i lokalne rejestry publiczne (`rejestry-publiczne`).
// Podstawa prawna każdej drogi dostępu: docs/ZRODLA-PODSTAWA-PRAWNA.md.

import type { SourceConnector } from '@olcys/core';
import { createHttpClient } from '../http.ts';
import type { Fetcher } from '../http.ts';
import { createFarcasterConnector } from './farcaster.ts';
import { createMarginaliaProvider, createMojeekProvider } from './providers.ts';
import { createRegistriesConnector } from './registries.ts';
import type { RegistryData } from './registries.ts';
import { createWebSearchConnector } from './web-search.ts';
import type { WebSearchOptions, WebSearchProvider } from './web-search.ts';

export { createFarcasterConnector, FARCASTER_ID } from './farcaster.ts';
export type { FarcasterOptions } from './farcaster.ts';
export { createMarginaliaProvider, createMojeekProvider } from './providers.ts';
export { createRegistriesConnector, REGISTRIES_ID } from './registries.ts';
export type { RegistryData } from './registries.ts';
export { buildWebQueries, createWebSearchConnector, SNIPPET_NOTICE, WEB_SEARCH_ID } from './web-search.ts';
export type { WebSearchOptions, WebSearchProvider, WebSearchRequest, WebSearchResult } from './web-search.ts';

export interface SearchConfig {
  /** Klucz Marginalia Search (wartość `public` to klucz wspólny). Trafia wyłącznie w nagłówku do api2.marginalia-search.com. */
  marginaliaApiKey?: string;
  /** Klucz Mojeek Search API. Trafia wyłącznie do www.mojeek.com. */
  mojeekApiKey?: string;
  /** Potwierdzenie, że klucz Mojeek jest z planu z prawem przechowywania wyników; bez tego dostawca nie powstaje. */
  mojeekStorageRights?: boolean;
  /** Ustawienia łącznika `web-search` (limity zapytań, hosty, których adresy wracają jako identyfikatory). */
  webSearch?: WebSearchOptions;
  /** Adres własnego węzła Snapchain dla łącznika Farcaster. */
  farcasterHubUrl?: string;
  /** Dane rejestrów zamiast migawek z plików (testy). */
  registryData?: RegistryData;
}

export interface SearchRuntime {
  /** Źródła w internecie; bez tego powstaje tylko lokalny łącznik rejestrów. */
  enableLive?: boolean;
  fetcher?: Fetcher;
  minRequestIntervalMs?: number;
  allowPrivateHosts?: boolean;
  log?: (message: string) => void;
}

const flag = (value: string | undefined): boolean => /^(1|true|yes)$/i.test(value?.trim() ?? '');

/** Konfiguracja ze zmiennych środowiskowych; puste wartości oznaczają „nie skonfigurowano". */
export function searchConfigFromEnv(env: Record<string, string | undefined>): SearchConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  return {
    marginaliaApiKey: value('MARGINALIA_API_KEY'),
    mojeekApiKey: value('MOJEEK_API_KEY'),
    mojeekStorageRights: flag(env.MOJEEK_STORAGE_RIGHTS),
    farcasterHubUrl: value('FARCASTER_HUB_URL'),
  };
}

/** Dostawcy wyszukiwarki, dla których podano klucz i spełniono warunek regulaminu. */
export function webSearchProviders(config: SearchConfig, log?: (message: string) => void): WebSearchProvider[] {
  const providers: WebSearchProvider[] = [];
  if (config.marginaliaApiKey) providers.push(createMarginaliaProvider({ apiKey: config.marginaliaApiKey }));
  if (config.mojeekApiKey && config.mojeekStorageRights) providers.push(createMojeekProvider({ apiKey: config.mojeekApiKey }));
  else if (config.mojeekApiKey) {
    log?.('Wyszukiwarka internetowa: podano MOJEEK_API_KEY bez MOJEEK_STORAGE_RIGHTS=1 — regulamin Mojeek pozwala przechowywać wyniki tylko w planie z prawem przechowywania, dostawca pominięty.');
  }
  return providers;
}

/**
 * Łączniki tego katalogu. Rejestry publiczne działają lokalnie, więc powstają zawsze;
 * Farcaster i wyszukiwarka internetowa tylko przy włączonych źródłach w internecie.
 */
export function createSearchConnectors(config: SearchConfig = {}, runtime: SearchRuntime = {}): SourceConnector[] {
  const connectors: SourceConnector[] = [createRegistriesConnector(config.registryData ? { data: config.registryData } : {})];
  if (!runtime.enableLive) return connectors;
  const http = createHttpClient({ fetcher: runtime.fetcher, minIntervalMs: runtime.minRequestIntervalMs, allowPrivateHosts: runtime.allowPrivateHosts });
  connectors.push(createFarcasterConnector(http, config.farcasterHubUrl ? { hubUrl: config.farcasterHubUrl } : {}));
  connectors.push(createWebSearchConnector(http, webSearchProviders(config, runtime.log), config.webSearch));
  return connectors;
}
