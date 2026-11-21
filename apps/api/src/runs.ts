// Wykonywanie analiz spraw: tryb standardowy i głęboki, przebieg w tle z podglądem
// postępu oraz zapis wyniku. Analiza głęboka może trwać kilka minut, dlatego da się ją
// uruchomić bez czekania na odpowiedź i śledzić etap po etapie.

import { randomUUID } from 'node:crypto';
import type { AiAssistant, AnalysisRun, ChainProvider, ScoreRules, SourceConnector } from '@olcys/core';
import { runAnalysis } from './analysis.ts';
import type { ActivityResolver, AnalysisStage } from './analysis.ts';
import type { CaseSummary, Storage } from './storage.ts';

export type RunDepth = 'standard' | 'deep';

/** Limity analizy w obu trybach — jawne, pokazywane przez API. */
export const DEPTH_LIMITS: Record<RunDepth, { discoveryDepth: number; maxChainAddresses: number; requestTimeoutMs: number; totalTimeoutMs: number; concurrency: number }> = {
  standard: { discoveryDepth: 3, maxChainAddresses: 15, requestTimeoutMs: 20_000, totalTimeoutMs: 120_000, concurrency: 6 },
  // Tryb głęboki pyta setki różnych hostów — większa współbieżność nie obciąża żadnego z nich bardziej.
  deep: { discoveryDepth: 4, maxChainAddresses: 40, requestTimeoutMs: 45_000, totalTimeoutMs: 240_000, concurrency: 24 },
};

/** Wyszukiwarka obiegająca setki forów potrzebuje więcej czasu niż pojedyncze źródło. */
const CONNECTOR_TIMEOUTS: Record<string, number> = { 'deep-search': 60_000 };

/** Analiza zapisana w bazie: kontrakt `AnalysisRun` plus tryb, w którym ją wykonano. */
export type StoredRun = AnalysisRun & { depth?: RunDepth };

export interface RunProgress {
  runId: string;
  caseId: string;
  status: AnalysisRun['status'];
  depth: RunDepth;
  /** Etap: wyszukiwanie, wystąpienia adresów, blockchain, kontrahenci, model, ocena, zapis, koniec. */
  stage: AnalysisStage | 'saving' | 'done' | 'failed';
  /** Zakończone i zlecone dotąd zapytania do łączników (łącznik × identyfikator). */
  connectorsDone: number;
  connectorsTotal: number;
  documents: number;
  addresses: number;
  startedAt: string;
  updatedAt: string;
  error?: string;
}

export interface RunOptions {
  connectors: SourceConnector[];
  depth?: RunDepth;
}

export interface RunEngineDeps {
  storage: Storage;
  chainProviders: ChainProvider[];
  /** Dostawcy danych blockchain w trybie głębokim (dłuższe ścieżki środków); domyślnie ci sami. */
  deepChainProviders?: ChainProvider[];
  resolveActivity?: ActivityResolver;
  rules: ScoreRules;
  now: () => Date;
  ai?: AiAssistant;
  /** Normalizacja nietypowych zapisów adresów przed ich wykrywaniem. */
  normalizeText?: (text: string) => string;
  /** Nadpisanie limitów (testy). */
  limits?: Partial<(typeof DEPTH_LIMITS)[RunDepth]>;
  log?: (runId: string, message: string) => void;
  /** Wywoływane po zapisaniu zakończonej analizy. */
  onCompleted?: () => void;
}

export interface RunEngine {
  /** Zakłada analizę i liczy ją w tle; `done` kończy się po zapisie (błąd analizy odrzuca obietnicę). */
  start(caseSummary: CaseSummary, options: RunOptions): Promise<{ run: StoredRun; done: Promise<StoredRun> }>;
  /** Wykonuje analizę i czeka na wynik. */
  execute(caseSummary: CaseSummary, options: RunOptions): Promise<StoredRun>;
  /** Postęp analizy trwającej lub zakończonej w tym procesie. */
  progress(runId: string): RunProgress | undefined;
  /** Przerywa trwające analizy i czeka na ich zapis. */
  stop(): Promise<void>;
}

/** Ile zakończonych analiz pamiętamy z pełnym postępem. */
const KEPT_PROGRESS = 200;

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const { storage, now } = deps;
  const progress = new Map<string, RunProgress>();
  const running = new Set<Promise<unknown>>();
  const abort = new AbortController();

  const complete = async (run: StoredRun, caseSummary: CaseSummary, options: RunOptions, state: RunProgress): Promise<StoredRun> => {
    const depth = options.depth ?? 'standard';
    const limits = { ...DEPTH_LIMITS[depth], ...deps.limits };
    const update = (patch: Partial<RunProgress>) => Object.assign(state, patch, { updatedAt: now().toISOString() });
    try {
      const result = await runAnalysis({
        query: caseSummary.query,
        connectors: options.connectors,
        chainProviders: depth === 'deep' ? (deps.deepChainProviders ?? deps.chainProviders) : deps.chainProviders,
        resolveActivity: deps.resolveActivity,
        rules: deps.rules,
        now,
        ai: deps.ai,
        signal: abort.signal,
        discoveryDepth: limits.discoveryDepth,
        maxChainAddresses: limits.maxChainAddresses,
        timeoutMs: limits.requestTimeoutMs,
        connectorTimeouts: CONNECTOR_TIMEOUTS,
        normalizeText: deps.normalizeText,
        totalTimeoutMs: limits.totalTimeoutMs,
        concurrency: limits.concurrency,
        log: (message) => deps.log?.(run.id, message),
        onProgress: (step) => update(step),
      });
      update({ stage: 'saving' });
      run.findings = result.findings;
      run.log = result.log;
      run.status = 'completed';
      run.finishedAt = now().toISOString();
      await storage.saveRun(run);
      await storage.saveDocuments(run.id, result.documents);
      await storage.saveRunIntel(run.id, result.intel);
      update({ status: 'completed', stage: 'done', addresses: result.findings.length });
      deps.onCompleted?.();
      return run;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      run.status = 'failed';
      run.finishedAt = now().toISOString();
      run.log.push({ time: run.finishedAt, message: `Analiza przerwana błędem: ${message}` });
      await storage.saveRun(run);
      update({ status: 'failed', stage: 'failed', error: message });
      throw error;
    }
  };

  const start: RunEngine['start'] = async (caseSummary, options) => {
    const depth = options.depth ?? 'standard';
    const startedAt = now().toISOString();
    const run: StoredRun = {
      id: randomUUID(),
      caseId: caseSummary.id,
      startedAt,
      status: 'running',
      query: caseSummary.query,
      connectors: options.connectors.map((connector) => connector.id),
      findings: [],
      log: [],
      // Tryb standardowy nie dopisuje pola — zapis pozostaje zgodny z wcześniejszymi analizami.
      ...(depth === 'deep' ? { depth } : {}),
    };
    await storage.saveRun(run);
    const state: RunProgress = {
      runId: run.id,
      caseId: run.caseId,
      status: 'running',
      depth,
      stage: 'search',
      connectorsDone: 0,
      connectorsTotal: 0,
      documents: 0,
      addresses: 0,
      startedAt,
      updatedAt: startedAt,
    };
    progress.set(run.id, state);
    for (const id of [...progress.keys()].slice(0, Math.max(0, progress.size - KEPT_PROGRESS))) progress.delete(id);

    const done = complete(run, caseSummary, options, state);
    running.add(done);
    // Błąd obsługuje wywołujący (tryb synchroniczny) albo zostaje w zapisanej analizie (tryb w tle).
    void done.catch(() => {}).finally(() => running.delete(done));
    return { run: { ...run }, done };
  };

  return {
    start,
    execute: async (caseSummary, options) => (await start(caseSummary, options)).done,
    progress: (runId) => {
      const state = progress.get(runId);
      return state ? { ...state } : undefined;
    },
    async stop() {
      abort.abort();
      await Promise.allSettled([...running]);
    },
  };
}
