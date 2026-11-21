// Obserwowane sprawy: automatyczne ponawianie analizy spraw zaznaczonych przez analityka („Monitoruj”).
// Harmonogram jest zapisany w bazie (przetrwa ponowne uruchomienie usługi); każda sprawa ma własny
// odstęp i tryb analizy. Zmiany między analizami liczy istniejące porównanie analiz (diff.ts).

import type { MonitorTimers } from './monitor.ts';
import type { RunDepth } from './runs.ts';
import type { Storage } from './storage.ts';

/** Odstępy do wyboru w interfejsie (minuty): co godzinę, co 6 godzin, codziennie. API przyjmuje 1–10080. */
export const WATCH_INTERVALS = [60, 360, 1440] as const;
export const DEFAULT_WATCH_MINUTES = 360;
/** Tryb ponawianych analiz: głęboki, jak domyślnie w interfejsie. */
export const DEFAULT_WATCH_DEPTH: RunDepth = 'deep';
/** Po ponownym uruchomieniu usługi zaległe analizy startują z opóźnieniem, kolejno co minutę. */
const CATCH_UP_DELAY_MS = 2 * 60_000;
const CATCH_UP_STEP_MS = 60_000;
const CONFIG_KEY = 'case-watch';

export interface WatchEntry {
  everyMinutes: number;
  depth: RunDepth;
  /** Od kiedy sprawa jest obserwowana. */
  since: string;
  nextRunAt: string;
  /** Ostatnia analiza uruchomiona przez obserwację (harmonogram albo „Odśwież teraz”). */
  lastRunId?: string;
  lastStartedAt?: string;
  /** Błąd ostatniej próby uruchomienia analizy. */
  lastError?: string;
}

export interface CaseWatchDeps {
  storage: Pick<Storage, 'getConfig' | 'saveConfig'>;
  now: () => Date;
  timers?: MonitorTimers;
  /** Uruchamia analizę sprawy w tle; `null`, gdy sprawy już nie ma. */
  startRun(caseId: string, depth: RunDepth): Promise<{ id: string; status: string } | null>;
  /** Czy analiza o podanym identyfikatorze wciąż trwa. */
  isRunning(runId: string): boolean;
  log?: (message: string, error?: unknown) => void;
}

export interface CaseWatch {
  /** Wczytuje zapisany harmonogram i ustawia odliczanie. */
  start(): Promise<void>;
  stop(): void;
  get(caseId: string): WatchEntry | undefined;
  list(): [string, WatchEntry][];
  set(caseId: string, settings: { everyMinutes: number; depth?: RunDepth }): Promise<WatchEntry>;
  remove(caseId: string): Promise<boolean>;
  /** „Odśwież teraz”: analiza od razu, kolejna po pełnym odstępie. `null` — sprawa nie jest obserwowana. */
  refresh(caseId: string): Promise<{ id: string; status: string } | null>;
  /** Czy obserwowana sprawa ma trwającą analizę uruchomioną przez obserwację. */
  isRunning(caseId: string): boolean;
}

const defaultTimers: MonitorTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    // Harmonogram nie może utrzymywać procesu przy życiu.
    handle.unref();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class WatchBusyError extends Error {}

export function createCaseWatch(deps: CaseWatchDeps): CaseWatch {
  const { storage, now } = deps;
  const timers = deps.timers ?? defaultTimers;
  const log = deps.log ?? (() => {});
  const entries = new Map<string, WatchEntry>();
  const handles = new Map<string, unknown>();
  let stopped = false;

  const persist = () => storage.saveConfig(CONFIG_KEY, Object.fromEntries(entries));
  const later = (minutes: number, from = now()) => new Date(from.getTime() + minutes * 60_000).toISOString();

  const disarm = (caseId: string) => {
    const handle = handles.get(caseId);
    if (handle !== undefined) timers.clear(handle);
    handles.delete(caseId);
  };

  const arm = (caseId: string) => {
    disarm(caseId);
    const entry = entries.get(caseId);
    if (!entry || stopped) return;
    const delay = Math.max(1000, new Date(entry.nextRunAt).getTime() - now().getTime());
    handles.set(
      caseId,
      timers.set(() => {
        handles.delete(caseId);
        tick(caseId).catch((error) => log('Automatyczna analiza obserwowanej sprawy nie powiodła się.', error));
      }, delay),
    );
  };

  const running = (entry: WatchEntry | undefined) => entry?.lastRunId !== undefined && deps.isRunning(entry.lastRunId);

  /** Uruchamia analizę i zapisuje jej identyfikator; błąd zostaje przy wpisie, harmonogram trwa dalej. */
  const launch = async (caseId: string, entry: WatchEntry) => {
    try {
      const handle = await deps.startRun(caseId, entry.depth);
      if (!handle) {
        // Sprawy już nie ma — obserwacja wygasa.
        entries.delete(caseId);
        disarm(caseId);
        await persist();
        return null;
      }
      entry.lastRunId = handle.id;
      entry.lastStartedAt = now().toISOString();
      delete entry.lastError;
      return handle;
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  };

  const tick = async (caseId: string) => {
    const entry = entries.get(caseId);
    if (!entry || stopped) return;
    entry.nextRunAt = later(entry.everyMinutes);
    try {
      if (running(entry)) log(`Obserwowana sprawa ${caseId}: poprzednia analiza jeszcze trwa — ten przebieg pominięto.`);
      else await launch(caseId, entry);
    } finally {
      if (entries.has(caseId)) {
        await persist();
        arm(caseId);
      }
    }
  };

  return {
    async start() {
      const saved = (await storage.getConfig<Record<string, WatchEntry>>(CONFIG_KEY)) ?? {};
      let overdue = 0;
      for (const [caseId, entry] of Object.entries(saved)) {
        if (!entry || !Number.isFinite(entry.everyMinutes)) continue;
        // Analizy przerwane wyłączeniem usługi nie trwają — zostaje tylko informacja o ostatnim uruchomieniu.
        if (new Date(entry.nextRunAt).getTime() <= now().getTime()) {
          entry.nextRunAt = new Date(now().getTime() + CATCH_UP_DELAY_MS + overdue * CATCH_UP_STEP_MS).toISOString();
          overdue += 1;
        }
        entries.set(caseId, { ...entry, depth: entry.depth ?? DEFAULT_WATCH_DEPTH });
      }
      if (overdue > 0) await persist();
      for (const caseId of entries.keys()) arm(caseId);
    },
    stop() {
      stopped = true;
      for (const caseId of [...handles.keys()]) disarm(caseId);
    },
    get: (caseId) => entries.get(caseId),
    list: () => [...entries.entries()],
    async set(caseId, settings) {
      const previous = entries.get(caseId);
      const entry: WatchEntry = {
        ...previous,
        everyMinutes: settings.everyMinutes,
        depth: settings.depth ?? previous?.depth ?? DEFAULT_WATCH_DEPTH,
        since: previous?.since ?? now().toISOString(),
        nextRunAt: later(settings.everyMinutes),
      };
      entries.set(caseId, entry);
      await persist();
      arm(caseId);
      return entry;
    },
    async remove(caseId) {
      const existed = entries.delete(caseId);
      disarm(caseId);
      if (existed) await persist();
      return existed;
    },
    async refresh(caseId) {
      const entry = entries.get(caseId);
      if (!entry) return null;
      if (running(entry)) throw new WatchBusyError('Analiza tej sprawy już trwa — poczekaj na jej zakończenie.');
      try {
        return await launch(caseId, entry);
      } finally {
        if (entries.has(caseId)) {
          entry.nextRunAt = later(entry.everyMinutes);
          await persist();
          arm(caseId);
        }
      }
    },
    isRunning: (caseId) => running(entries.get(caseId)),
  };
}
