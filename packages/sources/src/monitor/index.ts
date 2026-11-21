// Monitoring: łączniki tworzone z rejestru źródeł (config/monitor-sources/*.json)
// oraz oszczędny przebieg po wszystkich źródłach. Każdy wpis rejestru to jedno
// źródło obsługiwane przez adapter silnika.

import { readdirSync, readFileSync } from 'node:fs';
import type { ConnectorContext, DiscoveringConnector, SourceConnector, SourceDocument } from '@olcys/core';
import { errorMessage } from '../http.ts';
import type { HttpClient } from '../http.ts';
import { githubSearchEngine, hnEngine, lemmyEngine, mastodonTagEngine, stackExchangeEngine, telegramEngine } from './apis.ts';
import { FORUM_INTERVAL_MS, MAX_REQUESTS_PER_RUN, toDocuments } from './common.ts';
import type { EngineAdapter, EngineRun, MonitorEngine, MonitorSourceConfig } from './common.ts';
import { discourseEngine } from './discourse.ts';
import { htmlListEngine } from './html-list.ts';
import { redditEngine } from './reddit.ts';
import { rssEngine } from './rss.ts';
import { smfBoardEngine } from './smf.ts';

export type { HtmlListSelectors, MonitorEngine, MonitorSourceConfig } from './common.ts';

/** Katalog rejestru: każdy plik `*.json` to tablica wpisów. */
const REGISTRY_DIR = new URL('../../config/monitor-sources/', import.meta.url);

export const MONITOR_ENGINES: Record<MonitorEngine, EngineAdapter> = {
  rss: rssEngine,
  discourse: discourseEngine,
  reddit: redditEngine,
  'mastodon-tag': mastodonTagEngine,
  telegram: telegramEngine,
  stackexchange: stackExchangeEngine,
  hn: hnEngine,
  lemmy: lemmyEngine,
  'smf-board': smfBoardEngine,
  'html-list': htmlListEngine,
  'github-search': githubSearchEngine,
};

/** Przedrostek identyfikatorów łączników monitoringu. */
export const MONITOR_PREFIX = 'mon-';
/** Ile postów zwraca `discover`, gdy wywołujący nie poda sensownego limitu. */
const MAX_DISCOVER = 100;
const MAX_SEARCH = 25;
const CATEGORIES = ['cryptographic_proof', 'own_profile', 'sale_offer', 'settlement_message', 'forum_post', 'mass_comment'];

export interface MonitorRegistry {
  /** Poprawne wpisy bez powtórzeń (także wyłączone — do zestawień). */
  sources: MonitorSourceConfig[];
  /** Ostrzeżenia: nieczytelne pliki, błędne i powtórzone wpisy. */
  warnings: string[];
  /** Pliki, z których zbudowano rejestr. */
  files: string[];
}

/**
 * Nadpisanie wpisu z innego pliku rejestru: `{ "id": "…", "override": true, "enabled": false, "note": "powód" }`.
 * Pozwala wyłączyć albo poprawić cudzy wpis bez edytowania cudzego pliku.
 */
export interface MonitorSourceOverride {
  id: string;
  override: true;
  enabled?: boolean;
  note?: string;
  label?: string;
  category?: MonitorSourceConfig['category'];
}

/** Sprawdza jeden wpis; zwraca powód odrzucenia albo `null`. */
function entryProblem(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'wpis nie jest obiektem';
  const source = entry as MonitorSourceConfig;
  if (typeof source.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(source.id)) return 'brak lub niepoprawne pole „id"';
  if (typeof source.label !== 'string' || !source.label.trim()) return 'brak pola „label"';
  const engine = MONITOR_ENGINES[source.engine];
  if (!engine) return `nieznany silnik „${String(source.engine)}"`;
  if (source.category !== undefined && !CATEGORIES.includes(source.category)) return `nieznana kategoria „${String(source.category)}"`;
  for (const field of ['url', 'instance', 'sub', 'tag', 'channel', 'site', 'query', 'community'] as const) {
    if (source[field] !== undefined && typeof source[field] !== 'string') return `pole „${field}" nie jest tekstem`;
  }
  return engine.problem(source);
}

/** Scala wpisy z wielu plików: odrzuca błędne oraz powtórzone po `id` i po znormalizowanym adresie. */
export function mergeMonitorSources(groups: { file: string; entries: unknown[] }[]): { sources: MonitorSourceConfig[]; warnings: string[] } {
  const sources: MonitorSourceConfig[] = [];
  const warnings: string[] = [];
  const ids = new Map<string, string>();
  const addresses = new Map<string, string>();
  const overrides: { name: string; patch: MonitorSourceOverride }[] = [];
  for (const { file, entries } of groups) {
    entries.forEach((entry, index) => {
      const name = `${file}#${index + 1}${typeof (entry as MonitorSourceConfig)?.id === 'string' ? ` („${(entry as MonitorSourceConfig).id}")` : ''}`;
      // Wpis-nadpisanie nie jest źródłem: zmienia pola wpisu o tym samym `id` z dowolnego pliku.
      if (entry && typeof entry === 'object' && (entry as MonitorSourceOverride).override === true) {
        if (typeof (entry as MonitorSourceOverride).id === 'string') overrides.push({ name, patch: entry as MonitorSourceOverride });
        else warnings.push(`${name}: pominięto — nadpisanie bez pola „id".`);
        return;
      }
      const problem = entryProblem(entry);
      if (problem) {
        warnings.push(`${name}: pominięto — ${problem}.`);
        return;
      }
      const source = entry as MonitorSourceConfig;
      const id = source.id.toLowerCase();
      const address = MONITOR_ENGINES[source.engine].addressKey(source);
      if (ids.has(id)) {
        warnings.push(`${name}: pominięto — „id" powtórzone (pierwsze wystąpienie: ${ids.get(id)}).`);
        return;
      }
      if (addresses.has(address)) {
        // Wyłączony odpowiednik źródła, które już jest w rejestrze (np. niedziałający kanał RSS tego samego działu), znika bez ostrzeżenia.
        if (source.enabled === false) return;
        warnings.push(`${name}: pominięto — to samo źródło co ${addresses.get(address)}.`);
        return;
      }
      ids.set(id, name);
      addresses.set(address, name);
      sources.push(source);
    });
  }
  for (const { name, patch } of overrides) {
    const at = sources.findIndex((source) => source.id.toLowerCase() === patch.id.toLowerCase());
    if (at < 0) {
      warnings.push(`${name}: nadpisanie pominięto — w rejestrze nie ma wpisu o tym „id".`);
      continue;
    }
    const changed: MonitorSourceConfig = { ...sources[at]! };
    if (typeof patch.enabled === 'boolean') changed.enabled = patch.enabled;
    if (typeof patch.note === 'string') changed.note = patch.note;
    if (typeof patch.label === 'string' && patch.label.trim()) changed.label = patch.label;
    if (typeof patch.category === 'string' && CATEGORIES.includes(patch.category)) changed.category = patch.category;
    sources[at] = changed;
  }
  return { sources, warnings };
}

/**
 * Czyta rejestr: wszystkie pliki `*.json` z katalogu (każdy to tablica wpisów albo `{ "sources": [...] }`).
 * `core.json` ma pierwszeństwo przy powtórzeniach, pozostałe pliki idą alfabetycznie.
 */
export function loadMonitorSources(directory: URL = REGISTRY_DIR): MonitorRegistry {
  const warnings: string[] = [];
  let files: string[];
  try {
    files = readdirSync(directory)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort((a, b) => Number(b === 'core.json') - Number(a === 'core.json') || a.localeCompare(b));
  } catch (error) {
    return { sources: [], warnings: [`nie można odczytać katalogu rejestru: ${errorMessage(error)}`], files: [] };
  }
  const groups: { file: string; entries: unknown[] }[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(new URL(file, directory), 'utf8').replace(/^﻿/, '')) as unknown;
      const entries = Array.isArray(parsed) ? parsed : (parsed as { sources?: unknown[] } | null)?.sources;
      if (!Array.isArray(entries)) {
        warnings.push(`${file}: pominięto — plik nie zawiera tablicy wpisów.`);
        continue;
      }
      groups.push({ file, entries });
    } catch (error) {
      warnings.push(`${file}: pominięto — ${errorMessage(error)}.`);
    }
  }
  const merged = mergeMonitorSources(groups);
  return { sources: merged.sources, warnings: [...warnings, ...merged.warnings], files: groups.map((group) => group.file) };
}

export interface MonitorOptions {
  githubToken?: string;
  /** Tani filtr wstępny dla wszystkich źródeł: tylko posty zawierające adres kryptowalutowy. */
  onlyWithAddresses?: boolean;
  /** Dziennik problemów z rejestrem — zgłaszanych raz, przy tworzeniu łączników. */
  log?: (message: string) => void;
}

/** Wynik jednego źródła w przebiegu monitoringu. */
export interface MonitorDiscovery {
  documents: SourceDocument[];
  /** Liczba postów odczytanych ze źródła (przed limitem i filtrem). */
  posts: number;
  /** Źródło odmówiło (403/429) albo jego host odmówił wcześniej w tym przebiegu. */
  refused: boolean;
  /** Liczba wykonanych żądań. */
  requests: number;
  /** Wpisy dziennika tego źródła. */
  messages: string[];
}

/** Stan wspólny dla źródeł jednego przebiegu. */
export interface MonitorPassState {
  /** Hosty, które odmówiły w tym przebiegu. */
  refusedHosts?: Set<string>;
  /** Ile źródeł tego samego hosta bierze udział w przebiegu. */
  hostQueueSize?: number;
}

/** Łącznik monitoringu: zwykły `DiscoveringConnector` z danymi potrzebnymi do układania przebiegu. */
export interface MonitorConnector extends DiscoveringConnector {
  source: MonitorSourceConfig;
  /** Host pierwszego żądania — źródła tego samego hosta idą w jednej kolejce. */
  requestHost: string;
  discoverDetailed(context: ConnectorContext, limit: number, pass?: MonitorPassState): Promise<MonitorDiscovery>;
}

/** Tworzy po jednym łączniku dla każdego włączonego wpisu rejestru (wpisy błędne i powtórzone są pomijane z ostrzeżeniem). */
export function createMonitorConnectors(http: HttpClient, sources: MonitorSourceConfig[], options: MonitorOptions = {}): MonitorConnector[] {
  const merged = mergeMonitorSources([{ file: 'rejestr', entries: sources }]);
  // Ostrzeżenia rejestru zgłasza ten, kto go wczytał; tu trafiają już scalone wpisy.
  return merged.sources.filter((source) => source.enabled !== false).map((source) => createConnector(http, source, MONITOR_ENGINES[source.engine], options));
}

function createConnector(http: HttpClient, source: MonitorSourceConfig, engine: EngineAdapter, options: MonitorOptions): MonitorConnector {
  const id = `${MONITOR_PREFIX}${source.id}`;
  const onlyWithAddresses = source.onlyWithAddresses ?? options.onlyWithAddresses ?? false;
  const start = (context: ConnectorContext, pass: MonitorPassState = {}): EngineRun => ({
    source,
    http,
    context,
    session: http.session(context, { label: source.label, limit: engine.maxRequests ?? MAX_REQUESTS_PER_RUN, ...(pass.refusedHosts ? { refusedHosts: pass.refusedHosts } : {}) }),
    ...(pass.hostQueueSize ? { hostQueueSize: pass.hostQueueSize } : {}),
    intervalMs: engine.intervalMs ?? FORUM_INTERVAL_MS,
    ...(options.githubToken ? { githubToken: options.githubToken } : {}),
  });
  const tags = [source.language && `język: ${source.language}`, source.region && `region: ${source.region}`].filter(Boolean).join(', ');

  async function discoverDetailed(context: ConnectorContext, limit: number, pass?: MonitorPassState): Promise<MonitorDiscovery> {
    const wanted = Math.max(1, Math.min(Math.floor(limit) || MAX_DISCOVER, MAX_DISCOVER));
    const messages: string[] = [];
    const logging: ConnectorContext = {
      ...context,
      log: (message) => {
        messages.push(message);
        context.log(message);
      },
    };
    const run = start(logging, pass);
    try {
      const posts = await engine.discover(run, wanted);
      const documents = toDocuments(id, source, posts, wanted, onlyWithAddresses);
      context.log(`${source.label}: świeżych publikacji: ${posts.length}, zwrócono: ${documents.length}${onlyWithAddresses ? ' (tylko z adresami)' : ''}.`);
      return { documents, posts: posts.length, refused: run.session.refused, requests: run.session.used, messages };
    } catch (error) {
      logging.log(`${source.label}: błąd pobierania świeżych publikacji: ${errorMessage(error)}`);
      return { documents: [], posts: 0, refused: run.session.refused, requests: run.session.used, messages };
    }
  }

  return {
    id,
    source,
    requestHost: engine.requestHost(source),
    service: engine.service(source),
    label: source.label,
    description: `${engine.describe(source)}${tags ? ` [${tags}]` : ''}`,
    accepts: engine.search ? engine.accepts : [],
    // Źródła monitoringu nie biorą udziału w zwykłej analizie osoby, dopóki analityk ich nie włączy.
    enabledByDefault: false,

    async search(identifier, context): Promise<SourceDocument[]> {
      if (!engine.search || !engine.accepts.includes(identifier.type)) return [];
      try {
        const posts = await engine.search(start(context), identifier);
        const documents = toDocuments(id, source, posts, MAX_SEARCH, false, identifier);
        context.log(`${source.label}: „${identifier.value}" — dokumentów: ${documents.length}.`);
        return documents;
      } catch (error) {
        context.log(`${source.label}: błąd wyszukiwania „${identifier.value}": ${errorMessage(error)}`);
        return [];
      }
    },

    discoverDetailed,
    discover: async (context, limit) => (await discoverDetailed(context, limit)).documents,
  };
}

/** Łączniki monitoringu (z rejestru źródeł) spośród wszystkich utworzonych łączników. */
export function listMonitorConnectors(connectors: SourceConnector[]): MonitorConnector[] {
  return connectors.filter(
    (connector): connector is MonitorConnector => connector.id.startsWith(MONITOR_PREFIX) && typeof (connector as MonitorConnector).discoverDetailed === 'function',
  );
}

// ---------- Zestawienie rejestru ----------

export interface MonitorSourcesSummary {
  /** Liczba wpisów rejestru (włączonych i wyłączonych). */
  entries: number;
  /** Liczba wpisów włączonych. */
  enabledEntries: number;
  /** Odrębne hosty wśród włączonych źródeł (Reddit i Telegram to po jednym hoście; Mastodon i Lemmy — host instancji). */
  hosts: number;
  /** Odrębne społeczności wśród włączonych źródeł: host forum, subreddit, kanał, społeczność Lemmy na instancji. */
  communities: number;
  /** To samo po odjęciu wpisów oznaczonych w `note` jako „niska trafność" / „niższa trafność". */
  relevantEntries: number;
  relevantHosts: number;
  relevantCommunities: number;
  byEngine: Record<string, number>;
  byLanguage: Record<string, number>;
  byRegion: Record<string, number>;
}

/** Wpis oznaczony przez badacza jako mało trafny (ogólne forum, powtórzony strumień federowanego hashtagu). */
export const isLowRelevance = (source: MonitorSourceConfig): boolean => /ni(?:ska|[zż]sza)\s+trafno[sś][cć]/i.test(source.note ?? '');

/** Host źródła: dla forów i kanałów host strony, dla Reddita i Telegrama jeden wspólny, dla Mastodona i Lemmy — instancja. */
export function monitorSourceHost(source: MonitorSourceConfig): string {
  return MONITOR_ENGINES[source.engine]?.service(source) ?? '';
}

/** Społeczność źródła: subreddit, kanał Telegram, społeczność Lemmy na instancji; dla pozostałych — host. */
export function monitorSourceCommunity(source: MonitorSourceConfig): string {
  const host = monitorSourceHost(source);
  if (source.engine === 'reddit') return `${host}/r/${(source.sub ?? '').toLowerCase()}`;
  if (source.engine === 'telegram') return `${host}/${(source.channel ?? '').replace(/^@/, '').toLowerCase()}`;
  if (source.engine === 'lemmy') return `${host}/c/${(source.community ?? '').toLowerCase()}`;
  return host;
}

/**
 * Trzy liczby do pokazania w API: wpisy, odrębne hosty i odrębne społeczności (dwie ostatnie wśród
 * źródeł włączonych), oraz rozkład wpisów włączonych według silnika, języka i regionu.
 * Żeby policzyć to samo dla źródeł, które odpowiedziały w próbie, wystarczy przekazać ich podzbiór.
 */
export function summarizeMonitorSources(sources: MonitorSourceConfig[]): MonitorSourcesSummary {
  const enabled = sources.filter((source) => source.enabled !== false && MONITOR_ENGINES[source.engine]);
  const relevant = enabled.filter((source) => !isLowRelevance(source));
  const count = (key: (source: MonitorSourceConfig) => string): Record<string, number> => {
    const totals: Record<string, number> = {};
    for (const source of enabled) totals[key(source)] = (totals[key(source)] ?? 0) + 1;
    return Object.fromEntries(Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  };
  return {
    entries: sources.length,
    enabledEntries: enabled.length,
    hosts: new Set(enabled.map(monitorSourceHost).filter(Boolean)).size,
    communities: new Set(enabled.map(monitorSourceCommunity).filter(Boolean)).size,
    relevantEntries: relevant.length,
    relevantHosts: new Set(relevant.map(monitorSourceHost).filter(Boolean)).size,
    relevantCommunities: new Set(relevant.map(monitorSourceCommunity).filter(Boolean)).size,
    byEngine: count((source) => source.engine),
    byLanguage: count((source) => source.language?.toLowerCase() ?? 'nieokreślony'),
    byRegion: count((source) => source.region ?? 'nieokreślony'),
  };
}

// ---------- Przebieg monitoringu ----------

export interface MonitorPassOptions {
  /** Limit postów na źródło (domyślnie 20). */
  limit?: number;
  /** Ile hostów jest odpytywanych jednocześnie (domyślnie 8); źródła jednego hosta zawsze idą po kolei. */
  concurrency?: number;
  /** Łączny budżet czasu przebiegu w ms (domyślnie 10 minut); po jego upływie reszta źródeł jest pomijana. */
  budgetMs?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Wywoływane po każdym źródle — np. do zapisu wyników na bieżąco. */
  onResult?: (result: MonitorPassResult) => void;
}

export type MonitorPassStatus = 'ok' | 'empty' | 'refused' | 'skipped_refused_host' | 'skipped_budget' | 'error';

export interface MonitorPassResult {
  connectorId: string;
  source: MonitorSourceConfig;
  status: MonitorPassStatus;
  documents: SourceDocument[];
  posts: number;
  requests: number;
  durationMs: number;
  /** Wpisy dziennika źródła (powody pustego wyniku). */
  messages: string[];
}

export interface MonitorPassSummary {
  startedAt: string;
  durationMs: number;
  results: MonitorPassResult[];
  /** Hosty, które odmówiły w tym przebiegu — reszta ich kolejki została pominięta. */
  refusedHosts: string[];
}

/**
 * Jeden przebieg `discover` po wszystkich źródłach: kolejka na host (odstępy pilnuje ogranicznik tempa),
 * ograniczona liczba hostów naraz, przerwanie kolejki hosta po odmowie i łączny budżet czasu.
 */
export async function runMonitorPass(connectors: SourceConnector[], options: MonitorPassOptions = {}): Promise<MonitorPassSummary> {
  const monitors = listMonitorConnectors(connectors);
  const limit = options.limit ?? 20;
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const budgetMs = options.budgetMs ?? 10 * 60 * 1000;
  const started = Date.now();
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const refusedHosts = new Set<string>();
  const results: MonitorPassResult[] = [];

  // Kolejki per host; hosty o najdłuższych kolejkach startują pierwsze, bo to one wyznaczają czas przebiegu.
  const queues = new Map<string, MonitorConnector[]>();
  for (const connector of monitors) queues.set(connector.requestHost, [...(queues.get(connector.requestHost) ?? []), connector]);
  const hosts = [...queues.keys()].sort((a, b) => queues.get(b)!.length - queues.get(a)!.length);

  const record = (result: MonitorPassResult) => {
    results.push(result);
    options.onResult?.(result);
  };
  const skipped = (connector: MonitorConnector, status: MonitorPassStatus, message: string): MonitorPassResult => ({
    connectorId: connector.id,
    source: connector.source,
    status,
    documents: [],
    posts: 0,
    requests: 0,
    durationMs: 0,
    messages: [message],
  });

  async function runHost(host: string): Promise<void> {
    for (const connector of queues.get(host)!) {
      if (signal.aborted) {
        record(skipped(connector, 'skipped_budget', 'pominięto — wyczerpany budżet czasu przebiegu'));
        continue;
      }
      // Po odmowie hosta nie wysyłamy do niego już nic w tym przebiegu; silniki z hostem zapasowym (Reddit) próbują tylko zapasu.
      if (refusedHosts.has(host) && connector.source.engine !== 'reddit') {
        record(skipped(connector, 'skipped_refused_host', `pominięto — host ${host} odmówił wcześniej w tym przebiegu`));
        continue;
      }
      const before = Date.now();
      const found = await connector.discoverDetailed({ signal, log: () => undefined }, limit, { refusedHosts, hostQueueSize: queues.get(host)!.length });
      const status: MonitorPassStatus =
        found.documents.length > 0
          ? 'ok'
          : found.refused
            ? found.requests === 0
              ? 'skipped_refused_host'
              : 'refused'
            : signal.aborted
              ? 'skipped_budget'
              : found.messages.length > 0
                ? 'error'
                : 'empty';
      record({
        connectorId: connector.id,
        source: connector.source,
        status,
        documents: found.documents,
        posts: found.posts,
        requests: found.requests,
        durationMs: Date.now() - before,
        messages: found.messages,
      });
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, hosts.length) }, async () => {
      while (next < hosts.length) await runHost(hosts[next++]!);
    }),
  );

  const summary: MonitorPassSummary = { startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, results, refusedHosts: [...refusedHosts] };
  options.log?.(
    `Monitoring: przebieg zakończony — źródeł ${results.length}, z publikacjami ${results.filter((result) => result.status === 'ok').length}, ` +
      `dokumentów ${results.reduce((sum, result) => sum + result.documents.length, 0)}, czas ${Math.round(summary.durationMs / 1000)} s.`,
  );
  return summary;
}
