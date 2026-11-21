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
  Network,
  MonitorSourceStatus,
  MonitorStatus,
  SourceConnector,
  SourceDocument,
  TextInsight,
  WatchHit,
} from '@olcys/core';
import { AI_RULES } from './ai-rules.ts';
import { mapLimit } from './concurrency.ts';
import { pruneCorpus, toCorpusDocument } from './corpus.ts';
import type { CorpusSettings } from './corpus.ts';
import { normalize } from './identity.ts';
import { indexKnownAddresses, knownFor, markKnown } from './known-addresses.ts';
import type { KnownAddress } from './known-addresses.ts';
import type { ServiceLabel } from './explain.ts';
import { shortAddress } from './format.ts';
import { decideHit, evaluatePublication } from './monitor-rules.ts';
import type { Evaluation, HitBasis, Publication } from './monitor-rules.ts';
import { SIGNAL_RULES, isCryptoAsset, isGovernanceForum } from './signals.ts';
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
  /** Przechowywanie indeksu publikacji; bez tego pobrane publikacje nie są zapisywane. */
  corpus?: CorpusSettings;
  /** Zbiór publicznych etykiet adresów — do odsiewania adresów kontraktów i usług. */
  addressLabels?: ServiceLabel[];
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
  /** Limit automatycznych analiz na przebieg. */
  maxAutoAnalyses?: number;
  /** Limit publikacji czytanych przez model językowy na przebieg. */
  maxAiPublications?: number;
}

/** Liczby jednego przebiegu — pokazują, co odsiały reguły i dlaczego czegoś nie przeanalizowano. */
export interface MonitorRunStats {
  at: string;
  /** Nowe publikacje przejrzane w przebiegu. */
  documents: number;
  /** W tym z adresem kryptowalutowym. */
  withAddress: number;
  /** Publikacje po wstępnym filtrze (adres albo oferta obrotu kryptowalutą). */
  candidates: number;
  /** Publikacje przeczytane przez model językowy. */
  aiRead: number;
  /** Adresy odsiane jako kontrakty lub adresy usług. */
  contractsFiltered: number;
  /** Nowe trafienia. */
  hits: number;
  analyzed: number;
  /** Trafienia bez automatycznej analizy, z powodem. */
  skipped: { noAuthorNoAddress: number; limit: number; belowThreshold: number };
}

/** Stan monitoringu z rozbiciem liczb (lokalne rozszerzenie `MonitorStatus`). */
export type MonitorStatusView = MonitorStatus & {
  maxAutoAnalyses: number;
  maxAiPublications: number;
  totals: MonitorStatus['totals'] & { dismissed: number; lastRun?: MonitorRunStats };
};

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
  maxAutoAnalyses?: number;
  maxAiPublications?: number;
  lastRun?: MonitorRunStats;
}

export interface Monitor {
  status(): Promise<MonitorStatusView>;
  /** Przelicza zapisane trafienia bieżącymi regułami; niespełniające kryteriów oznacza jako odrzucone. */
  recheck(): Promise<{ checked: number; kept: number; dismissed: number }>;
  /** Zmienia ustawienia; nieznane źródło zgłasza błąd `UnknownSourceError`. */
  configure(patch: MonitorPatch): Promise<MonitorStatusView>;
  /** Wykonuje przebieg i zwraca nowe trafienia; gdy przebieg już trwa, dołącza do niego. */
  run(): Promise<WatchHit[]>;
  /** Analizuje autora trafienia (ręczne wymuszenie); `null`, gdy trafienia nie ma. */
  analyze(hitId: string): Promise<WatchHit | null>;
  /** Uruchamia harmonogram według zapisanych ustawień. */
  start(): Promise<void>;
  /** Zatrzymuje harmonogram i czeka na koniec trwającego przebiegu (przerywając analizy). */
  stop(): Promise<void>;
}

/** Trafienie z odczytem modelu językowego (lokalne rozszerzenie kontraktu `WatchHit`). */
export type MonitorHit = WatchHit & {
  /** Adresy z publikacji już przypisane podmiotom innych spraw — mocny trop, analiza autora bez względu na próg. */
  knownFromCases?: KnownAddress[];
  /** Która część definicji trafienia jest spełniona. */
  basis?: HitBasis;
  /** Dlaczego publikacja jest trafieniem (albo dlaczego przestała nim być po zmianie reguł). */
  hitReason?: string;
  /** Dlaczego trafienia nie przeanalizowano automatycznie. */
  autoAnalysis?: string;
  /** Powód odrzucenia przy ponownym przeliczeniu reguł. */
  dismissReason?: string;
  /** Tłumaczenie treści na polski, gdy publikacja jest w innym języku (z modelu). */
  translationPl?: string;
  insight?: TextInsight;
};

/**
 * Łączy odczyt modelu z ocenami z reguł: związek z Polską to większa z dwóch ocen (z przesłankami
 * obu), a oferta odczytana przez model uzupełnia sygnały obrotu. Wszystko, co pochodzi z modelu,
 * jest tak oznaczone.
 */
export function mergeInsight(hit: WatchHit, insight: TextInsight): MonitorHit {
  const source = `Model ${insight.model}`;
  const merged: MonitorHit = { ...hit, insight };
  if (insight.polishNexus) {
    merged.polishNexus = {
      score: Math.max(hit.polishNexus.score, insight.polishNexus.score),
      reasons: [...hit.polishNexus.reasons, ...insight.polishNexus.reasons.map((reason) => `${source}: ${reason}`)],
    };
  }
  // Oferta z modelu uzupełnia sygnały tylko, gdy dotyczy kryptowaluty (aktywo z listy kryptowalut).
  if (insight.offer && isCryptoAsset(insight.offer.asset)) {
    const { offer } = insight;
    const side = { sell: 'sprzedaż', buy: 'kupno', exchange: 'wymiana', accepts_payment: 'przyjmowanie płatności' }[offer.side];
    const details = [
      offer.amount !== undefined ? `kwota ${offer.amount.toLocaleString('pl-PL')}${offer.currency ? ` ${offer.currency}` : offer.asset ? ` ${offer.asset}` : ''}` : offer.asset,
      offer.paymentMethods.length > 0 ? `płatność: ${offer.paymentMethods.join(', ')}` : undefined,
      offer.location ? `miejscowość: ${offer.location}` : undefined,
    ].filter(Boolean);
    // Punkty za ofertę dolicza się tylko wtedy, gdy reguły same jej nie wykryły.
    const missed = !hit.suspicion.reasons.some((reason) => reason.startsWith('Oferta kupna'));
    const points = missed ? SIGNAL_RULES.suspicionWeights.tradeOffer! : 0;
    merged.suspicion = {
      score: Math.min(100, hit.suspicion.score + points),
      reasons: [...hit.suspicion.reasons, `${source}: oferta (${side})${details.length > 0 ? ` — ${details.join('; ')}` : ''}${insight.quote ? `. Cytat: „${insight.quote}”` : ''}${points > 0 ? ` (+${points})` : ''}`],
    };
  }
  if (hit.language === 'und' && insight.language) merged.language = insight.language;
  if (insight.translationPl) merged.translationPl = insight.translationPl;
  return merged;
}

export class UnknownSourceError extends Error {}

/** Trafienie nie ma ani autora, ani adresu — nie ma czego analizować. */
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
  const normalizeText = deps.normalizeText ?? ((text: string) => text);
  const extract = (text: string) => extractAddresses(normalizeText(text));

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
    if (!hit.author && hit.addresses.length === 0) throw new NoAuthorError('Publikacja nie ma wskazanego autora ani adresu — nie ma czego analizować.');
    // Bez autora analizujemy sam adres: sprawa adresu, bez wskazywania osoby.
    const subject = hit.author ?? `adres ${shortAddress(hit.addresses[0]!.address)}`;
    const identifiers: Identifier[] = [
      ...(hit.author ? [{ type: 'nick' as const, value: hit.author }] : []),
      // Adresy z publikacji są analizowane także wtedy, gdy wyszukiwanie po nicku ich nie zwróci.
      ...hit.addresses.slice(0, MAX_QUERY_ADDRESSES).map((item) => ({ type: 'crypto_address' as const, value: item.address })),
    ];
    // Analiza korzysta ze źródeł domyślnie włączonych oraz ze źródła, w którym publikację znaleziono.
    const connectors = deps.connectors.filter((connector) => connector.enabledByDefault || connector.id === hit.connectorId);
    const { lead, analysis } = await analyzeAuthor({ ...deps, connectors, now, signal: abort.signal }, subject, { identifiers });

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

    const updated: WatchHit = { ...hit, status: 'analyzed', lead: markKnown(lead, (hit as MonitorHit).knownFromCases ?? []) };
    await storage.saveHit(updated, hitKey(hit));
    await storage.saveHitAnalysis(hit.id, analysis);
    return updated;
  };

  // ---------- Odsiewanie adresów kontraktów ----------

  const labelled = new Map((deps.addressLabels ?? []).map((item) => [item.address.toLowerCase(), item]));
  /**
   * Adresy, które nie są adresami osób: oznaczone w zbiorze etykiet jako kontrakt lub usługa albo —
   * dla publikacji z forów zarządzania, w ramach małego budżetu zapytań — wskazane jako kontrakt
   * przez dostawcę danych blockchain. Adres, który autor podaje jako własny, nie jest sprawdzany.
   */
  const findContracts = async (items: { service: string; connectorId: string; evaluation: Evaluation; insight?: TextInsight }[]): Promise<Set<string>> => {
    const contracts = new Set<string>();
    const toCheck: { address: string; network: string }[] = [];
    for (const { service, connectorId, evaluation, insight } of items) {
      for (const item of evaluation.addresses) {
        const key = item.address.toLowerCase();
        const label = labelled.get(key);
        if (label && label.addressClass !== 'private' && label.addressClass !== 'unknown') contracts.add(key);
        // U dostawcy sprawdzamy adresy EVM z forów zarządzania oraz te, które byłyby trafieniem tylko
        // dzięki związkowi z Polską (kontrakt tokena z polskiego wpisu to nie adres osoby).
        else if (
          /^0x/i.test(item.address) &&
          insight?.ownership !== 'own_address' &&
          (isGovernanceForum(service, connectorId) || (evaluation.ownership === undefined && evaluation.polishNexus.score >= thresholds.hitPolishNexus)) &&
          !toCheck.some((known) => known.address === item.address)
        ) {
          toCheck.push(item);
        }
      }
    }
    const resolve = deps.resolveActivity;
    if (!resolve || deps.chainProviders.length === 0) return contracts;
    await mapLimit(toCheck.slice(0, thresholds.contractCheckBudgetPerRun), 4, async (item) => {
      if (abort.signal.aborted) return;
      try {
        const activity = await resolve(deps.chainProviders, item.network as Network, item.address, { signal: abort.signal, log: () => {} });
        if (activity?.profile.isContract || activity?.profile.addressClass === 'smart_contract') contracts.add(item.address.toLowerCase());
      } catch {
        // Brak odpowiedzi dostawcy: adres zostaje, rozstrzygną pozostałe reguły.
      }
    });
    return contracts;
  };

  // ---------- Ponowne przeliczenie zapisanych trafień ----------

  const recheck = async (): Promise<{ checked: number; kept: number; dismissed: number }> => {
    const pending = (await storage.listHits()).filter((hit) => hit.status === 'new') as MonitorHit[];
    const prepared: { hit: MonitorHit; evaluation: Evaluation; publication: Publication }[] = [];
    for (const hit of pending) {
      // Pełna treść jest w indeksie publikacji; starsze trafienia oceniamy z zapisanego fragmentu.
      const stored = await storage.getCorpusDocument(hit.url);
      const publication: Publication = stored
        ? { connectorId: stored.connectorId, service: stored.service, url: stored.url, title: stored.title, text: stored.text, author: hit.author, profile: stored.profile }
        : { connectorId: hit.connectorId, service: hit.service, url: hit.url, title: hit.title, text: hit.excerpt, author: hit.author };
      const found = stored ? extract(stored.text).map((item) => ({ address: item.address, network: item.network as string })) : [];
      const addresses = [...found, ...hit.addresses.filter((item) => !found.some((known) => known.address === item.address))];
      prepared.push({ hit, publication, evaluation: evaluatePublication(publication, addresses) });
    }
    const contracts = await findContracts(prepared.map(({ hit, evaluation }) => ({ service: hit.service, connectorId: hit.connectorId, evaluation, insight: hit.insight })));
    let dismissed = 0;
    for (const { hit, evaluation } of prepared) {
      const decision = decideHit(evaluation, hit.insight, contracts);
      const base: MonitorHit = { ...hit, polishNexus: evaluation.polishNexus, suspicion: evaluation.suspicion, addresses: decision.addresses as WatchHit['addresses'], hitReason: decision.reason };
      const updated: MonitorHit = decision.hit
        ? { ...(hit.insight ? mergeInsight(base, hit.insight) : base), basis: decision.basis }
        : { ...base, status: 'dismissed', dismissReason: `Nie spełnia kryteriów po zmianie reguł: ${decision.reason}` };
      if (!decision.hit) dismissed++;
      await storage.saveHit(updated, hitKey(hit));
    }
    log(`Ponowne przeliczenie trafień: sprawdzono ${pending.length}, odrzucono ${dismissed}.`);
    return { checked: pending.length, kept: pending.length - dismissed, dismissed };
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

    // ---------- Ocena publikacji regułami; do dalszej oceny idą tylko te po wstępnym filtrze ----------
    const stats: MonitorRunStats = { at: startedAt, documents: 0, withAddress: 0, candidates: 0, aiRead: 0, contractsFiltered: 0, hits: 0, analyzed: 0, skipped: { noAuthorNoAddress: 0, limit: 0, belowThreshold: 0 } };
    const candidates: { doc: SourceDocument; evaluation: Evaluation; sourceId: string }[] = [];
    for (const { source, documents } of batches) {
      const unseen = new Set(await storage.filterUnseenUrls(documents.map((doc) => doc.url)));
      const fresh: SourceDocument[] = [];
      for (const doc of documents) {
        if (!unseen.delete(doc.url)) continue;
        fresh.push(doc);
        state.sources[source.id]!.documentsSeen++;
        stats.documents++;
        const evaluation = evaluatePublication({ ...doc, author: authorOf(doc) }, extract(doc.text).map((item) => ({ address: item.address, network: item.network })));
        if (evaluation.addresses.length > 0) stats.withAddress++;
        if (evaluation.candidate) candidates.push({ doc, evaluation, sourceId: source.id });
      }
      // Każda nowa publikacja trafia do indeksu własnego — także ta, która nie jest trafieniem.
      if (deps.corpus) await storage.saveCorpusDocuments(fresh.map((doc) => toCorpusDocument(doc, normalizeText)));
      await storage.markUrlsSeen(documents.map((doc) => doc.url), startedAt);
    }
    stats.candidates = candidates.length;
    const weight = (item: { evaluation: Evaluation }) => item.evaluation.polishNexus.score + item.evaluation.suspicion.score;
    candidates.sort((a, b) => weight(b) - weight(a) || Number(b.evaluation.addresses.length > 0) - Number(a.evaluation.addresses.length > 0));

    // Model językowy (opcjonalny) czyta tylko publikacje po wstępnym filtrze, najwyżej ocenione najpierw —
    // reszta jest oceniana wyłącznie regułami. To trzyma koszt modelu w ryzach.
    const insights = new Map<string, TextInsight>();
    if (deps.ai) {
      const { ai } = deps;
      await mapLimit(candidates.slice(0, state.maxAiPublications ?? thresholds.maxAiPublicationsPerRun), AI_RULES.concurrency, async ({ doc, evaluation }) => {
        if (abort.signal.aborted) return;
        try {
          const insight = await ai.analyzePublication({ text: doc.text, address: evaluation.addresses[0]?.address, author: authorOf(doc), title: doc.title });
          if (insight) insights.set(doc.url, insight);
        } catch (error) {
          log(`Odczyt publikacji ${doc.url} przez model nie powiódł się — zostają oceny z reguł.`, error);
        }
      });
      stats.aiRead = insights.size;
    }

    const contracts = await findContracts(candidates.map(({ doc, evaluation }) => ({ service: doc.service, connectorId: doc.connectorId, evaluation, insight: insights.get(doc.url) })));
    stats.contractsFiltered = contracts.size;

    // Trafienia dotknięte w tym przebiegu: klucz autora → trafienie i informacja, czy jest nowe.
    const touched = new Map<string, { hit: WatchHit; created: boolean }>();
    for (const { doc, evaluation, sourceId } of candidates) {
      const insight = insights.get(doc.url);
      const decision = decideHit(evaluation, insight, contracts);
      if (!decision.hit) continue;

      const author = authorOf(doc);
      const key = dedupeKeyOf(doc.service, author, doc.url);
      const known = touched.get(key) ?? (await storage.getHitByKey(key).then((hit) => (hit ? { hit, created: false } : undefined)));
      const base: MonitorHit = {
        id: known?.hit.id ?? randomUUID(),
        detectedAt: now().toISOString(),
        connectorId: doc.connectorId,
        service: doc.service,
        url: doc.url,
        title: doc.title,
        ...(author ? { author } : {}),
        ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
        excerpt: (extract(doc.text)[0]?.context ?? doc.text).replace(/\s+/g, ' ').trim().slice(0, 300),
        language: evaluation.language,
        addresses: decision.addresses as WatchHit['addresses'],
        polishNexus: evaluation.polishNexus,
        suspicion: evaluation.suspicion,
        status: 'new',
        basis: decision.basis,
        hitReason: decision.reason,
      };
      const candidate = insight ? mergeInsight(base, insight) : base;
      if (!known) {
        touched.set(key, { hit: candidate, created: true });
        state.sources[sourceId]!.hits++;
        stats.hits++;
        continue;
      }
      // Kolejny post tego samego autora: zostaje wyżej oceniona publikacja, adresy się sumują.
      const previous = known.hit;
      const lead = sumOf(candidate) > sumOf(previous) ? candidate : previous;
      const merged = [...previous.addresses];
      for (const item of candidate.addresses) {
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

    // Adres znany z innej sprawy: mocny trop, analiza bez względu na próg i w pierwszej kolejności.
    const known = indexKnownAddresses(await storage.listLatestRuns());
    for (const [key, item] of touched) {
      const matches = knownFor(known, item.hit.addresses.map((entry) => entry.address), item.hit.caseId);
      if (matches.length === 0) continue;
      touched.set(key, { ...item, hit: { ...item.hit, knownFromCases: matches } as MonitorHit });
      log(`Trafienie „${item.hit.author ?? item.hit.url}”: adres znany ze sprawy „${matches[0]!.caseName}”.`);
    }

    // ---------- Automatyczna analiza: najpierw adres znany, potem trafienia z adresem, od najwyżej ocenionych ----------
    const isKnown = (hit: WatchHit) => ((hit as MonitorHit).knownFromCases?.length ?? 0) > 0;
    const fresh = [...touched.entries()].filter(([, item]) => item.hit.status === 'new');
    const eligible: [string, { hit: WatchHit; created: boolean }][] = [];
    for (const [key, item] of fresh) {
      const { hit } = item;
      if (!isKnown(hit) && sumOf(hit) < state.autoAnalyzeThreshold) {
        stats.skipped.belowThreshold++;
        touched.set(key, { ...item, hit: { ...hit, autoAnalysis: `Bez automatycznej analizy: suma ocen ${sumOf(hit)} poniżej progu ${state.autoAnalyzeThreshold}.` } as MonitorHit });
      } else if (!hit.author && hit.addresses.length === 0) {
        stats.skipped.noAuthorNoAddress++;
        touched.set(key, { ...item, hit: { ...hit, autoAnalysis: 'Bez automatycznej analizy: publikacja nie ma autora ani adresu.' } as MonitorHit });
      } else eligible.push([key, item]);
    }
    eligible.sort(
      ([, a], [, b]) => Number(isKnown(b.hit)) - Number(isKnown(a.hit)) || Number(b.hit.addresses.length > 0) - Number(a.hit.addresses.length > 0) || compareHits(a.hit, b.hit),
    );
    const limit = state.maxAutoAnalyses ?? thresholds.maxAutoAnalysesPerRun;
    for (const [key, item] of eligible.slice(limit)) {
      stats.skipped.limit++;
      touched.set(key, { ...item, hit: { ...item.hit, autoAnalysis: `Bez automatycznej analizy: limit ${limit} analiz na przebieg.` } as MonitorHit });
    }
    for (const [key, { hit }] of touched) await storage.saveHit(hit, key);

    const analyzed = new Map<string, WatchHit>();
    for (const [, { hit }] of eligible.slice(0, limit)) {
      if (abort.signal.aborted) break;
      try {
        analyzed.set(hit.id, await analyzeHit(touched.get(hitKey(hit))?.hit ?? hit));
        stats.analyzed++;
      } catch (error) {
        log(`Automatyczna analiza trafienia „${hit.author ?? hit.url}” nie powiodła się.`, error);
      }
    }

    if (deps.corpus) {
      const removed = await pruneCorpus(storage, deps.corpus, now());
      if (removed > 0) log(`Indeks publikacji: usunięto ${removed} wpisów ponad okres przechowywania lub limit.`);
    }

    // Statystyki i czas przebiegu zapisujemy na aktualnych ustawieniach — mogły się zmienić w trakcie.
    const latest = await loadState();
    await storage.saveMonitorState({ ...latest, sources: state.sources, lastRunAt: startedAt, lastRun: stats });
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
    recheck,

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
        maxAutoAnalyses: state.maxAutoAnalyses ?? thresholds.maxAutoAnalysesPerRun,
        maxAiPublications: state.maxAiPublications ?? thresholds.maxAiPublicationsPerRun,
        ...(state.lastRunAt ? { lastRunAt: state.lastRunAt } : {}),
        ...(nextRunAt ? { nextRunAt } : {}),
        running: current !== undefined,
        sources: sourceStatus,
        totals: {
          documentsSeen: sourceStatus.reduce((sum, source) => sum + source.documentsSeen, 0),
          hits: hits.length,
          analyzed: hits.filter((hit) => hit.status === 'analyzed').length,
          newHits: hits.filter((hit) => hit.status === 'new').length,
          dismissed: hits.filter((hit) => hit.status === 'dismissed').length,
          ...(state.lastRun ? { lastRun: state.lastRun } : {}),
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
        ...(patch.maxAutoAnalyses !== undefined ? { maxAutoAnalyses: patch.maxAutoAnalyses } : {}),
        ...(patch.maxAiPublications !== undefined ? { maxAiPublications: patch.maxAiPublications } : {}),
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
