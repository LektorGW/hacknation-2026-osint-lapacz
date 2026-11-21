// Cykliczny monitoring źródeł: narzędzie samo przegląda świeże publikacje (łączniki
// z metodą `discover`), ocenia związek z Polską i sygnały obrotu kryptowalutami,
// zapisuje trafienia, a autorów najwyżej ocenionych publikacji od razu analizuje.
//
// Zasady przebiegu:
// - błąd jednego źródła nie przerywa pozostałych (trafia do statusu źródła),
// - publikacja raz przejrzana nie jest oceniana ponownie (`monitor_seen`),
// - jedno trafienie na autora w serwisie — kolejne posty uzupełniają je o adresy,
// - naraz działa najwyżej jeden przebieg; harmonogram jest trwały (`monitor_config`).

import { randomUUID } from 'node:crypto';
import { extractAddresses } from '@olcys/core';
import type {
  ConnectorContext,
  DiscoveringConnector,
  Identifier,
  MonitorSourceStatus,
  MonitorStatus,
  SourceConnector,
  SourceDocument,
  WatchHit,
} from '@olcys/core';
import { mapLimit } from './concurrency.ts';
import { normalize } from './identity.ts';
import { SIGNAL_RULES, polishNexus, suspicion } from './signals.ts';
import type { Storage } from './storage.ts';
import { analyzeAuthor, canDiscover } from './sweep.ts';
import type { AuthorAnalysisParams } from './sweep.ts';

/** Podmienialne odliczanie czasu — testy sterują harmonogramem bez czekania. */
export interface MonitorTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface MonitorDeps extends Omit<AuthorAnalysisParams, 'signal' | 'now'> {
  storage: Storage;
  /** Źródła objęte monitoringiem; domyślnie wszystkie łączniki z metodą `discover`. */
  monitorConnectors?: SourceConnector[];
  now: () => Date;
  timers?: MonitorTimers;
  log?: (message: string, error?: unknown) => void;
}

export interface MonitorPatch {
  enabled?: boolean;
  everyMinutes?: number;
  autoAnalyzeThreshold?: number;
  /** Włączenie lub wyłączenie pojedynczych źródeł. */
  sources?: Record<string, boolean>;
}

interface SourceStats {
  lastRunAt?: string;
  lastError?: string;
  documentsSeen: number;
  hits: number;
}

/** Trwały stan monitoringu: ustawienia oraz statystyki źródeł. */
interface MonitorState {
  enabled: boolean;
  everyMinutes: number;
  autoAnalyzeThreshold: number;
  disabledSources: string[];
  lastRunAt?: string;
  sources: Record<string, SourceStats>;
}

export interface Monitor {
  status(): Promise<MonitorStatus>;
  /** Zmienia ustawienia; nieznane źródło zgłasza błąd `UnknownSourceError`. */
  configure(patch: MonitorPatch): Promise<MonitorStatus>;
  /** Wykonuje przebieg i zwraca nowe trafienia; gdy przebieg już trwa, dołącza do niego. */
  run(): Promise<WatchHit[]>;
  /** Analizuje autora trafienia (ręczne wymuszenie); `null`, gdy trafienia nie ma. */
  analyze(hitId: string): Promise<WatchHit | null>;
  /** Uruchamia harmonogram według zapisanych ustawień. */
  start(): Promise<void>;
  /** Zatrzymuje harmonogram i czeka na koniec trwającego przebiegu (przerywając analizy). */
  stop(): Promise<void>;
}

export class UnknownSourceError extends Error {}

/** Trafienie nie ma autora — nie ma kogo analizować. */
export class NoAuthorError extends Error {}

const DEFAULT_EVERY_MINUTES = 30;
const SOURCE_CONCURRENCY = 6;
const MIN_DELAY_MS = 1_000;
const MAX_QUERY_ADDRESSES = 10;

const defaultTimers: MonitorTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    // Harmonogram nie może utrzymywać procesu przy życiu.
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const sumOf = (hit: WatchHit) => hit.polishNexus.score + hit.suspicion.score;

/** Kolejność trafień: malejąco po sumie ocen, potem od najnowszych. */
export const compareHits = (a: WatchHit, b: WatchHit): number =>
  sumOf(b) - sumOf(a) || new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime() || a.id.localeCompare(b.id);

const authorOf = (doc: SourceDocument): string | undefined => {
  const author = (doc.profile?.handle ?? doc.author ?? '').trim().replace(/^@/, '');
  return author || undefined;
};

/** Jedno trafienie na autora w serwisie; publikacja bez autora jest trafieniem sama dla siebie. */
const dedupeKeyOf = (service: string, author: string | undefined, url: string): string =>
  author ? `${service.toLowerCase()}|${normalize(author)}` : url;

/** Klucz, pod którym trafienie jest zapisane (autor w serwisie albo adres publikacji). */
export const hitKey = (hit: WatchHit): string => dedupeKeyOf(hit.service, hit.author, hit.url);

export function createMonitor(deps: MonitorDeps): Monitor {
  const { storage, now } = deps;
  const timers = deps.timers ?? defaultTimers;
  const log = deps.log ?? (() => {});
  const sources = (deps.monitorConnectors ?? deps.connectors).filter(canDiscover);
  const thresholds = SIGNAL_RULES.thresholds;

  let current: Promise<WatchHit[]> | undefined;
  let timer: unknown;
  let nextRunAt: string | undefined;
  let stopped = false;
  let abort = new AbortController();

  const loadState = async (): Promise<MonitorState> => ({
    enabled: false,
    everyMinutes: DEFAULT_EVERY_MINUTES,
    autoAnalyzeThreshold: thresholds.autoAnalyzeDefault,
    disabledSources: [],
    sources: {},
    ...((await storage.getMonitorState<MonitorState>()) ?? {}),
  });

  // ---------- Harmonogram ----------

  const schedule = async (): Promise<void> => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
    nextRunAt = undefined;
    if (stopped) return;
    const state = await loadState();
    if (!state.enabled) return;
    const intervalMs = state.everyMinutes * 60_000;
    const base = state.lastRunAt ? new Date(state.lastRunAt).getTime() + intervalMs : now().getTime();
    const at = Math.max(now().getTime() + MIN_DELAY_MS, base);
    nextRunAt = new Date(at).toISOString();
    timer = timers.set(() => {
      timer = undefined;
      run().catch((error) => log('Cykliczny przebieg monitoringu nie powiódł się.', error));
    }, at - now().getTime());
  };

  // ---------- Analiza autora ----------

  const analyzeHit = async (hit: WatchHit): Promise<WatchHit> => {
    if (!hit.author) throw new NoAuthorError('Publikacja nie ma wskazanego autora — nie ma kogo analizować.');
    const identifiers: Identifier[] = [
      { type: 'nick', value: hit.author },
      // Adresy z publikacji są analizowane także wtedy, gdy wyszukiwanie po nicku ich nie zwróci.
      ...hit.addresses.slice(0, MAX_QUERY_ADDRESSES).map((item) => ({ type: 'crypto_address' as const, value: item.address })),
    ];
    // Analiza korzysta ze źródeł domyślnie włączonych oraz ze źródła, w którym publikację znaleziono.
    const connectors = deps.connectors.filter((connector) => connector.enabledByDefault || connector.id === hit.connectorId);
    const { lead, analysis } = await analyzeAuthor({ ...deps, connectors, now, signal: abort.signal }, hit.author, { identifiers });

    // Składnik monitoringu doliczany jawnie do priorytetu wskazania: związek z Polską.
    const bonus = thresholds.priorityPolishWeight * hit.polishNexus.score;
    const priority = Math.min(100, Math.round(lead.priority + bonus));
    const format = (value: number) => value.toLocaleString('pl-PL', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    lead.priorityReasons = [
      ...lead.priorityReasons,
      `Związek z Polską (składnik monitoringu): ${hit.polishNexus.score}/100 × ${thresholds.priorityPolishWeight.toLocaleString('pl-PL', { minimumFractionDigits: 2 })} = +${format(bonus)} pkt.`,
      `Priorytet wskazania z monitoringu: ${priority}/100 (priorytet analizy ${lead.priority} + składnik związku z Polską, najwyżej 100).`,
    ];
    lead.priority = priority;

    const updated: WatchHit = { ...hit, status: 'analyzed', lead };
    await storage.saveHit(updated, hitKey(hit));
    await storage.saveHitAnalysis(hit.id, analysis);
    return updated;
  };

  // ---------- Przebieg ----------

  const execute = async (): Promise<WatchHit[]> => {
    const state = await loadState();
    const enabled = sources.filter((source) => !state.disabledSources.includes(source.id));
    const startedAt = now().toISOString();

    const batches = await mapLimit(enabled, SOURCE_CONCURRENCY, async (source: DiscoveringConnector) => {
      const stats = (state.sources[source.id] ??= { documentsSeen: 0, hits: 0 });
      stats.lastRunAt = startedAt;
      const context: ConnectorContext = { signal: abort.signal, log: (message) => log(`[${source.id}] ${message}`) };
      try {
        const documents = await source.discover(context, thresholds.discoverLimitPerSource);
        delete stats.lastError;
        return { source, documents };
      } catch (error) {
        stats.lastError = errorText(error);
        log(`[${source.id}] Błąd pobierania publikacji — źródło pominięte w tym przebiegu.`, error);
        return { source, documents: [] as SourceDocument[] };
      }
    });

    // Trafienia dotknięte w tym przebiegu: klucz autora → trafienie i informacja, czy jest nowe.
    const touched = new Map<string, { hit: WatchHit; created: boolean }>();
    for (const { source, documents } of batches) {
      const unseen = new Set(await storage.filterUnseenUrls(documents.map((doc) => doc.url)));
      const stats = state.sources[source.id]!;
      for (const doc of documents) {
        if (!unseen.delete(doc.url)) continue;
        stats.documentsSeen++;
        const addresses = extractAddresses(doc.text).map((item) => ({ address: item.address, network: item.network }));
        const nexus = polishNexus(doc);
        const suspect = suspicion(doc);
        const signalled = nexus.score >= thresholds.hitPolishNexus && suspect.score >= thresholds.hitSuspicion;
        if (addresses.length === 0 && !signalled) continue;

        const author = authorOf(doc);
        const key = dedupeKeyOf(doc.service, author, doc.url);
        const known = touched.get(key) ?? (await storage.getHitByKey(key).then((hit) => (hit ? { hit, created: false } : undefined)));
        const candidate: WatchHit = {
          id: known?.hit.id ?? randomUUID(),
          detectedAt: now().toISOString(),
          connectorId: doc.connectorId,
          service: doc.service,
          url: doc.url,
          title: doc.title,
          ...(author ? { author } : {}),
          ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
          excerpt: (extractAddresses(doc.text)[0]?.context ?? doc.text).replace(/\s+/g, ' ').trim().slice(0, 300),
          language: nexus.language,
          addresses,
          polishNexus: { score: nexus.score, reasons: nexus.reasons },
          suspicion: suspect,
          status: 'new',
        };
        if (!known) {
          touched.set(key, { hit: candidate, created: true });
          stats.hits++;
          continue;
        }
        // Kolejny post tego samego autora: zostaje wyżej oceniona publikacja, adresy się sumują.
        const previous = known.hit;
        const lead = sumOf(candidate) > sumOf(previous) ? candidate : previous;
        const merged = [...previous.addresses];
        for (const item of addresses) {
          if (!merged.some((existing) => existing.address === item.address)) merged.push(item);
        }
        touched.set(key, {
          created: known.created,
          hit: {
            ...lead,
            id: previous.id,
            detectedAt: previous.detectedAt,
            addresses: merged,
            status: previous.status,
            ...(previous.lead ? { lead: previous.lead } : {}),
            ...(previous.caseId ? { caseId: previous.caseId } : {}),
          },
        });
      }
      await storage.markUrlsSeen(documents.map((doc) => doc.url), startedAt);
    }
    for (const [key, { hit }] of touched) await storage.saveHit(hit, key);

    // Automatyczna analiza autorów najwyżej ocenionych publikacji, z limitem na przebieg.
    const queue = [...touched.values()]
      .map((item) => item.hit)
      .filter((hit) => hit.status === 'new' && hit.author && sumOf(hit) >= state.autoAnalyzeThreshold)
      .sort(compareHits)
      .slice(0, thresholds.maxAutoAnalysesPerRun);
    const analyzed = new Map<string, WatchHit>();
    for (const hit of queue) {
      if (abort.signal.aborted) break;
      try {
        analyzed.set(hit.id, await analyzeHit(hit));
      } catch (error) {
        log(`Automatyczna analiza autora „${hit.author}” nie powiodła się.`, error);
      }
    }

    // Statystyki i czas przebiegu zapisujemy na aktualnych ustawieniach — mogły się zmienić w trakcie.
    const latest = await loadState();
    await storage.saveMonitorState({ ...latest, sources: state.sources, lastRunAt: startedAt });
    return [...touched.values()]
      .filter((item) => item.created)
      .map((item) => analyzed.get(item.hit.id) ?? item.hit)
      .sort(compareHits);
  };

  const run = (): Promise<WatchHit[]> => {
    current ??= execute().finally(() => {
      current = undefined;
      return schedule();
    });
    return current;
  };

  return {
    run,

    async status() {
      const state = await loadState();
      const hits = await storage.listHits();
      const sourceStatus: MonitorSourceStatus[] = sources.map((source) => {
        const stats = state.sources[source.id];
        return {
          connectorId: source.id,
          label: source.label,
          service: source.service,
          enabled: !state.disabledSources.includes(source.id),
          ...(stats?.lastRunAt ? { lastRunAt: stats.lastRunAt } : {}),
          ...(stats?.lastError ? { lastError: stats.lastError } : {}),
          documentsSeen: stats?.documentsSeen ?? 0,
          hits: stats?.hits ?? 0,
        };
      });
      return {
        enabled: state.enabled,
        everyMinutes: state.everyMinutes,
        autoAnalyzeThreshold: state.autoAnalyzeThreshold,
        ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        running: current !== undefined,
        sources: sourceStatus,
        totals: {
          documentsSeen: sourceStatus.reduce((sum, source) => sum + source.documentsSeen, 0),
          hits: hits.length,
          analyzed: hits.filter((hit) => hit.status === 'analyzed').length,
          newHits: hits.filter((hit) => hit.status === 'new').length,
        },
      };
    },

    async configure(patch) {
      const state = await loadState();
      const disabled = new Set(state.disabledSources);
      for (const [id, enabled] of Object.entries(patch.sources ?? {})) {
        if (!sources.some((source) => source.id === id)) throw new UnknownSourceError(`Nieznane źródło monitoringu: ${id}.`);
        if (enabled) disabled.delete(id);
        else disabled.add(id);
      }
      await storage.saveMonitorState({
        ...state,
        enabled: patch.enabled ?? state.enabled,
        everyMinutes: patch.everyMinutes ?? state.everyMinutes,
        autoAnalyzeThreshold: patch.autoAnalyzeThreshold ?? state.autoAnalyzeThreshold,
        disabledSources: [...disabled],
      });
      await schedule();
      return this.status();
    },

    async analyze(hitId) {
      const hit = await storage.getHit(hitId);
      return hit ? analyzeHit(hit) : null;
    },

    async start() {
      stopped = false;
      abort = new AbortController();
      await schedule();
    },

    async stop() {
      stopped = true;
      if (timer !== undefined) timers.clear(timer);
      timer = undefined;
      nextRunAt = undefined;
      abort.abort();
      // Trwający przebieg kończy się sam: przerwane analizy zgłaszają błąd i są pomijane.
      await current?.catch(() => {});
    },
  };
}
