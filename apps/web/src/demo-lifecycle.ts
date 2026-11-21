// Cykl życia sprawy w trybie demo (w pamięci karty): zamknięcie, przywrócenie, archiwum, powiązania,
// usunięcie i dziennik audytu — te same zasady co w usłudze analizy, bez zapisu czegokolwiek na serwerze.

import { ApiError } from './api.ts';
import type { AuditEntry, Backend, CaseArchive, CaseLink, CaseSummary } from './api.ts';
import type { RawRun } from './demo-data.ts';

type StoredCase = Omit<CaseSummary, 'runs'>;

export interface DemoLifecycleState {
  cases: StoredCase[];
  runs: RawRun[];
  /** Wszystkie wpisy sprawy (decyzje, odpowiedzi usług itp.) do usunięcia razem ze sprawą. */
  owned: { caseId: string }[][];
  /** Obserwowane sprawy. */
  watched: Map<string, unknown>;
  summarize: (stored: StoredCase) => CaseSummary;
}

const STATUS_LABEL = { open: 'otwarta', closed: 'zamknięta', archived: 'zarchiwizowana' } as const;

/** Rzuca 409, gdy sprawa nie jest otwarta — jak blokada w usłudze analizy. */
export function ensureOpen(stored: StoredCase): void {
  const status = stored.status ?? 'open';
  if (status !== 'open') {
    throw new ApiError(`Sprawa jest ${STATUS_LABEL[status]} — tylko do odczytu. Przywróć ją („Przywróć”), aby uruchamiać analizy, zapisywać decyzje lub rozwijać sieć.`, 409);
  }
}

async function sha256Hex(data: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

export function createDemoLifecycle(state: DemoLifecycleState): Pick<
  Backend,
  'closeCase' | 'reopenCase' | 'archiveCase' | 'getCaseLinks' | 'deleteCase' | 'getSecurityStatus' | 'getRetentionPreview' | 'listAudit'
> {
  const audit: AuditEntry[] = [];
  const note = (action: string, caseId: string, details: Record<string, unknown> = {}) =>
    audit.push({ seq: audit.length + 1, at: new Date().toISOString(), actor: 'analityk (demo)', action, caseId, details });

  const find = (caseId: string): StoredCase => {
    const found = state.cases.find((item) => item.id === caseId);
    if (!found) throw new ApiError('Nie znaleziono: sprawa.', 404);
    return found;
  };

  const keysOf = (caseId: string) => {
    const stored = find(caseId);
    const latest = state.runs.filter((run) => run.caseId === caseId && run.status === 'completed').at(-1);
    return {
      addresses: new Set((latest?.findings ?? []).map((finding) => finding.address.toLowerCase())),
      identifiers: new Set(stored.query.identifiers.map((item) => `${item.type}:${item.value.trim().toLowerCase()}`)),
    };
  };

  const linksOf = (caseId: string): CaseLink[] => {
    const own = keysOf(caseId);
    const links: CaseLink[] = [];
    for (const other of state.cases) {
      if (other.id === caseId) continue;
      const theirs = keysOf(other.id);
      const reasons = [
        { kind: 'adres', label: 'wspólny adres kryptowalutowy', values: [...own.addresses].filter((value) => theirs.addresses.has(value)).slice(0, 5) },
        { kind: 'identyfikator', label: 'wspólny identyfikator', values: [...own.identifiers].filter((value) => theirs.identifiers.has(value)).slice(0, 5) },
      ].filter((reason) => reason.values.length > 0);
      const status = other.status ?? 'open';
      if (reasons.length > 0) links.push({ caseId: other.id, caseName: other.name, status, blocking: status === 'open', reasons });
    }
    return links.sort((a, b) => Number(b.blocking) - Number(a.blocking));
  };

  return {
    closeCase: async (caseId, reason) => {
      const stored = find(caseId);
      if ((stored.status ?? 'open') !== 'open') throw new ApiError(`Sprawa jest już ${STATUS_LABEL[stored.status!]}.`, 409);
      if (!reason.trim()) throw new ApiError('Podaj powód zamknięcia sprawy.', 400);
      Object.assign(stored, { status: 'closed', closedAt: new Date().toISOString(), closedReason: reason.trim() });
      state.watched.delete(caseId);
      note('sprawa.zamknieta', caseId, { dlugoscPowodu: reason.trim().length });
      return state.summarize(stored);
    },
    reopenCase: async (caseId) => {
      const stored = find(caseId);
      if ((stored.status ?? 'open') === 'open') throw new ApiError('Sprawa jest już otwarta.', 409);
      const previous = stored.status;
      Object.assign(stored, { status: 'open', closedAt: undefined, closedReason: undefined });
      note('sprawa.przywrocona', caseId, { poprzedniStan: previous });
      return state.summarize(stored);
    },
    archiveCase: async (caseId): Promise<CaseArchive> => {
      const stored = find(caseId);
      if ((stored.status ?? 'open') === 'open') throw new ApiError('Najpierw zamknij sprawę — archiwum powstaje z materiału, który już się nie zmienia.', 409);
      const content = JSON.stringify(
        {
          uwaga: 'DEMO — archiwum przykładowe złożone w przeglądarce; prawdziwe archiwum (ZIP z manifestem i kopiami dowodów) tworzy usługa analizy.',
          sprawa: state.summarize(stored),
          analizy: state.runs.filter((run) => run.caseId === caseId),
        },
        null,
        2,
      );
      const sha256 = await sha256Hex(content);
      Object.assign(stored, { status: 'archived', archivedAt: new Date().toISOString(), archiveSha256: sha256 });
      note('sprawa.zarchiwizowana', caseId, { bajty: content.length });
      return { blob: new Blob([content], { type: 'application/json' }), fileName: `olcys-archiwum-DEMO-${caseId}.json`, sha256 };
    },
    getCaseLinks: async (caseId) => {
      const stored = find(caseId);
      const links = linksOf(caseId);
      const blocking = links.some((link) => link.blocking);
      const status = stored.status ?? 'open';
      return { caseId, status, links, blocking, deletable: status !== 'open' && !blocking };
    },
    deleteCase: async (caseId, confirm) => {
      const stored = find(caseId);
      if (confirm.trim() !== stored.name.trim()) throw new ApiError('Potwierdzenie nie zgadza się z nazwą sprawy — wpisz dokładną nazwę sprawy, aby ją usunąć.', 400);
      if ((stored.status ?? 'open') === 'open') throw new ApiError('Usunąć można tylko sprawę zamkniętą lub zarchiwizowaną — najpierw ją zamknij.', 409);
      const links = linksOf(caseId);
      const blocking = links.filter((link) => link.blocking);
      if (blocking.length > 0) {
        const message = `Nie można usunąć — sprawa jest powiązana z: ${blocking.map((link) => `„${link.caseName}” (${link.reasons.map((reason) => reason.label).join(', ')})`).join('; ')}.`;
        throw new ApiError(message, 409, { error: message, links });
      }
      state.cases.splice(state.cases.indexOf(stored), 1);
      for (let index = state.runs.length - 1; index >= 0; index--) if (state.runs[index]!.caseId === caseId) state.runs.splice(index, 1);
      for (const list of state.owned) for (let index = list.length - 1; index >= 0; index--) if (list[index]!.caseId === caseId) list.splice(index, 1);
      state.watched.delete(caseId);
      note('sprawa.usunieta', caseId, { tryb: 'reczne' });
    },
    getSecurityStatus: async () => ({
      tokenRequired: false,
      snapshotEncrypted: false,
      retention: { enabled: false },
      archiveStoredOnServer: false,
      corsOrigins: [],
      rateLimitPerMinute: null,
    }),
    getRetentionPreview: async () => ({
      enabled: false,
      generatedAt: new Date().toISOString(),
      items: state.cases
        .filter((item) => (item.status ?? 'open') !== 'open')
        .map((item) => ({
          caseId: item.id,
          caseName: item.name,
          status: item.status!,
          ...(item.closedAt ? { closedAt: item.closedAt } : {}),
          ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}),
          eligible: false,
          reasons: ['Tryb demo: retencja jest wyłączona — nic nie jest usuwane automatycznie.'],
          blockingLinks: linksOf(item.id)
            .filter((link) => link.blocking)
            .map((link) => ({ caseId: link.caseId, caseName: link.caseName, kinds: link.reasons.map((reason) => reason.label) })),
        })),
    }),
    listAudit: async (caseId) => audit.filter((entry) => !caseId || entry.caseId === caseId),
  };
}
