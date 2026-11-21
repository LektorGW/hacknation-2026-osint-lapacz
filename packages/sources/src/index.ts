// Łączniki do publicznych źródeł Web2. Każdy łącznik wysyła wyłącznie zapytanie
// do swojego źródła — dane analizy nie trafiają nigdzie indziej.

import type { SourceConnector } from '@olcys/core';
import { createBitcointalkConnector } from './bitcointalk.ts';
import { createEnsConnector } from './ens.ts';
import { createFediverseConnector, loadFediverseInstances } from './fediverse.ts';
import { createGithubConnector, createGithubGistsConnector } from './github.ts';
import { createGravatarConnector } from './gravatar.ts';
import { createHttpClient } from './http.ts';
import type { Fetcher } from './http.ts';
import { createKeybaseConnector } from './keybase.ts';
import { createSandboxConnectors } from './sandbox.ts';
import { createTelegramConnector } from './telegram.ts';
import { createTorConnector } from './tor.ts';
import { createWaybackConnector } from './wayback.ts';
import { createWwwConnector } from './www.ts';

export { htmlToText } from './html.ts';
export type { Fetcher } from './http.ts';

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
  return [
    createKeybaseConnector(http),
    createEnsConnector(http),
    createGithubConnector(http, github),
    createGithubGistsConnector(http, github),
    createGravatarConnector(http),
    createFediverseConnector(http, config.fediverseInstances ? { instances } : {}),
    createTelegramConnector(http, config.telegramChannels ? { channels: config.telegramChannels } : {}),
    createBitcointalkConnector(http),
    createWwwConnector(http, { skipHosts: instances }),
    createWaybackConnector(http),
  ];
}

export function createConnectors(config: SourcesConfig): SourceConnector[] {
  const connectors: SourceConnector[] = [];
  if (config.sandboxUrl) connectors.push(...createSandboxConnectors(config.sandboxUrl));
  if (config.enableLive) connectors.push(...createLiveConnectors(config));
  if (config.torProxyUrl) connectors.push(createTorConnector(config.torProxyUrl));
  return connectors;
}
