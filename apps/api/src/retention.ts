// Retencja zamkniętych spraw (OLCYS_RETENTION_DAYS_CLOSED). Domyślnie WYŁĄCZONA: bez tej zmiennej
// nic nie jest usuwane automatycznie, więc aktualizacja narzędzia nigdy nie kasuje istniejących danych.
//
// Sprawa jest usuwana przez zadanie retencji wyłącznie, gdy jednocześnie:
//  - jest ZARCHIWIZOWANA (archiwum utworzone po zamknięciu — kopia materiału istnieje),
//  - od zamknięcia minęło co najmniej N dni,
//  - nie łączy się z żadną otwartą sprawą.
// Sprawy otwartej, zamkniętej bez archiwum ani powiązanej zadanie nigdy nie usuwa. Podgląd (`preview`)
// pokazuje każdą zamkniętą sprawę z decyzją i powodem — bez żadnych zmian w bazie.

import type { CaseLink } from './lifecycle.ts';
import type { CaseStatus, CaseSummary } from './storage.ts';

export const DAY_MS = 24 * 3_600_000;

/** Liczba dni z OLCYS_RETENTION_DAYS_CLOSED; `undefined` = retencja wyłączona. Wartość nieprawidłowa = błąd startu. */
export function retentionDaysFromEnv(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const days = Number(text);
  if (!Number.isInteger(days) || days < 1 || days > 36_500) {
    throw new Error('OLCYS_RETENTION_DAYS_CLOSED musi być liczbą całkowitą dni (1–36500); brak zmiennej wyłącza retencję.');
  }
  return days;
}

export interface RetentionItem {
  caseId: string;
  caseName: string;
  status: CaseStatus;
  closedAt?: string;
  archivedAt?: string;
  /** Dni od zamknięcia. */
  ageDays?: number;
  /** Czy zadanie retencji usunęłoby sprawę przy najbliższym przebiegu. */
  eligible: boolean;
  /** Powody (dlaczego tak / dlaczego nie). */
  reasons: string[];
  /** Powiązania z otwartymi sprawami (blokują usunięcie). */
  blockingLinks: { caseId: string; caseName: string; kinds: string[] }[];
}

export interface RetentionPreview {
  enabled: boolean;
  days?: number;
  generatedAt: string;
  items: RetentionItem[];
}

/** Ocena jednej sprawy według reguł retencji. */
export function assessRetention(summary: CaseSummary, links: CaseLink[], days: number | undefined, now: Date): RetentionItem {
  const reasons: string[] = [];
  const blocking = links.filter((link) => link.blocking);
  const closedAt = summary.closedAt ? new Date(summary.closedAt) : undefined;
  const ageDays = closedAt ? Math.floor((now.getTime() - closedAt.getTime()) / DAY_MS) : undefined;
  const archivedAfterClose = Boolean(summary.archivedAt && closedAt && new Date(summary.archivedAt).getTime() >= closedAt.getTime());
  let eligible = true;
  if (days === undefined) {
    eligible = false;
    reasons.push('Retencja jest wyłączona (brak OLCYS_RETENTION_DAYS_CLOSED) — nic nie jest usuwane automatycznie.');
  }
  if (summary.status === 'open') {
    eligible = false;
    reasons.push('Sprawa jest otwarta.');
  } else if (summary.status !== 'archived' || !archivedAfterClose) {
    eligible = false;
    reasons.push('Sprawa nie ma archiwum utworzonego po zamknięciu — zadanie nigdy nie usuwa spraw bez archiwum.');
  } else {
    reasons.push(`Archiwum z ${summary.archivedAt} (SHA-256 ${summary.archiveSha256?.slice(0, 16) ?? '?'}…).`);
  }
  if (days !== undefined && summary.status !== 'open') {
    if (ageDays === undefined) {
      eligible = false;
      reasons.push('Brak daty zamknięcia.');
    } else if (ageDays < days) {
      eligible = false;
      reasons.push(`Zamknięta ${ageDays} dni temu — próg retencji to ${days} dni.`);
    } else {
      reasons.push(`Zamknięta ${ageDays} dni temu (próg ${days} dni).`);
    }
  }
  if (blocking.length > 0) {
    eligible = false;
    reasons.push(`Powiązana z otwartymi sprawami: ${blocking.map((link) => `„${link.caseName}”`).join(', ')}.`);
  }
  if (eligible) reasons.push('Spełnia wszystkie warunki — zostanie usunięta przy najbliższym przebiegu zadania retencji.');
  return {
    caseId: summary.id,
    caseName: summary.name,
    status: summary.status,
    ...(summary.closedAt ? { closedAt: summary.closedAt } : {}),
    ...(summary.archivedAt ? { archivedAt: summary.archivedAt } : {}),
    ...(ageDays !== undefined ? { ageDays } : {}),
    eligible,
    reasons,
    blockingLinks: blocking.map((link) => ({ caseId: link.caseId, caseName: link.caseName, kinds: link.reasons.map((reason) => reason.label) })),
  };
}

export interface RetentionJobDeps {
  days: number | undefined;
  now: () => Date;
  /** Podgląd: każda zamknięta / zarchiwizowana sprawa z oceną. */
  preview: () => Promise<RetentionPreview>;
  /** Usuwa sprawę (z audytem i zapisem migawki) — wywoływane tylko dla spraw `eligible`. */
  remove: (item: RetentionItem) => Promise<void>;
  log: (message: string, error?: unknown) => void;
  timers?: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
  /** Odstęp przebiegów (domyślnie doba) i opóźnienie pierwszego przebiegu po starcie. */
  everyMs?: number;
  firstDelayMs?: number;
}

/** Codzienne zadanie retencji. Przy wyłączonej retencji nic nie planuje. */
export function createRetentionJob(deps: RetentionJobDeps) {
  const timers = deps.timers ?? {
    set(callback: () => void, delayMs: number) {
      const handle = setTimeout(callback, delayMs);
      handle.unref();
      return handle;
    },
    clear(handle: unknown) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
  let handle: unknown;
  let stopped = false;
  let running: Promise<{ deleted: string[]; skipped: number }> | undefined;

  const runOnce = async (): Promise<{ deleted: string[]; skipped: number }> => {
    if (deps.days === undefined) return { deleted: [], skipped: 0 };
    const preview = await deps.preview();
    const deleted: string[] = [];
    for (const item of preview.items.filter((entry) => entry.eligible)) {
      if (stopped) break;
      try {
        await deps.remove(item);
        deleted.push(item.caseId);
      } catch (error) {
        deps.log(`Retencja: nie udało się usunąć sprawy ${item.caseId}.`, error);
      }
    }
    deps.log(`Retencja: przebieg zakończony — usunięto ${deleted.length} spraw(y), pominięto ${preview.items.length - deleted.length} (próg ${deps.days} dni).`);
    return { deleted, skipped: preview.items.length - deleted.length };
  };

  const schedule = (delay: number) => {
    if (stopped || deps.days === undefined) return;
    handle = timers.set(() => {
      running = runOnce()
        .catch((error) => {
          deps.log('Retencja: przebieg nie powiódł się.', error);
          return { deleted: [], skipped: 0 };
        })
        .finally(() => schedule(deps.everyMs ?? DAY_MS));
    }, delay);
  };

  return {
    start() {
      if (deps.days === undefined) {
        deps.log('Retencja zamkniętych spraw: wyłączona (brak OLCYS_RETENTION_DAYS_CLOSED).');
        return;
      }
      deps.log(`Retencja zamkniętych spraw: włączona — zarchiwizowane, niepowiązane sprawy zamknięte ponad ${deps.days} dni są usuwane raz na dobę.`);
      schedule(deps.firstDelayMs ?? 10 * 60_000);
    },
    async stop() {
      stopped = true;
      if (handle !== undefined) timers.clear(handle);
      await running;
    },
    runOnce,
  };
}
