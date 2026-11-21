// Trasy cyklu życia sprawy, dziennika audytu, retencji i stanu zabezpieczeń:
//   POST   /api/cases/:id/close            — zamknięcie z powodem (sprawa tylko do odczytu),
//   POST   /api/cases/:id/reopen           — przywrócenie (ponownie otwarta),
//   POST   /api/cases/:id/archive          — archiwum ZIP (pobranie); w bazie zostaje skrót SHA-256 i metadane,
//   GET    /api/cases/:id/archive/latest   — ostatnie archiwum (z pamięci procesu albo z OLCYS_ARCHIVE_DIR),
//   GET    /api/cases/:id/links            — powiązania z innymi sprawami (czy można usunąć),
//   DELETE /api/cases/:id                  — usunięcie zamkniętej, niepowiązanej sprawy; body `{ confirm: "<nazwa sprawy>" }`,
//   GET    /api/audit?caseId=              — dziennik audytu,
//   GET    /api/retention/preview          — co usunęłoby zadanie retencji i dlaczego (bez zmian w bazie),
//   GET    /api/security/status            — token, szyfrowanie migawki, retencja, katalog archiwów.
// Rejestruje też dwa haki: blokadę zmian w zamkniętej sprawie (409) i audyt zmian / pobrań z innych tras.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AnalysisRun } from '@olcys/core';
import { buildCaseArchive, loadStoredArchive, storeArchive } from './archive.ts';
import type { BuiltArchive } from './archive.ts';
import { HttpError, TOOL_VERSION, idParams } from './http-common.ts';
import type { RouteContext } from './http-common.ts';
import { CASE_STATUS_LABEL, collectLinkData, findCaseLinks, linkedMessage } from './lifecycle.ts';
import type { CaseLink } from './lifecycle.ts';
import { assessRetention, createRetentionJob } from './retention.ts';
import type { RetentionItem, RetentionPreview } from './retention.ts';
import { isInternalRequest } from './security.ts';
import type { SecurityOptions } from './security.ts';
import type { CaseSummary, CaseTombstone } from './storage.ts';

/** Narzędzie nie ma kont użytkowników — wykonawca czynności jest stały. */
export const AUDIT_ACTOR = 'analityk';

export interface LifecycleOptions {
  /** Retencja zamkniętych spraw w dniach; brak = wyłączona (domyślnie). */
  retentionDays?: number;
  /** Katalog na pliki archiwów; brak = plik archiwum nie jest przechowywany na serwerze. */
  archiveDir?: string;
  /** Podmiana odliczania czasu zadania retencji (testy). */
  retentionTimers?: { set(callback: () => void, delayMs: number): unknown; clear(handle: unknown): void };
}

export interface LifecycleDeps {
  /** Obserwacja sprawy — wyłączana przy zamknięciu i usunięciu. */
  watch: { get(caseId: string): unknown; remove(caseId: string): Promise<boolean> };
  security: SecurityOptions;
  options: LifecycleOptions;
}

/** Trasy dozwolone dla zamkniętej sprawy mimo metody zmieniającej dane. */
const ALLOWED_WHEN_CLOSED = new Set([
  'POST /api/cases/:id/close',
  'POST /api/cases/:id/reopen',
  'POST /api/cases/:id/archive',
  'DELETE /api/cases/:id',
  'DELETE /api/cases/:id/schedule',
]);

/** Zmiany i pobrania z innych tras zapisywane w dzienniku audytu (bez danych osobowych). */
const AUDITED: Record<string, { action: string; details?: (body: Record<string, unknown>, payload: Record<string, unknown> | null) => { target?: string; details: Record<string, unknown> } }> = {
  'POST /api/cases/:id/decisions': {
    action: 'decyzja.dodana',
    details: (body, payload) => ({ target: String(payload?.id ?? ''), details: { cel: body.target, decyzja: body.decision } }),
  },
  'DELETE /api/cases/:id/decisions/:decisionId': { action: 'decyzja.wycofana' },
  'POST /api/cases/:id/service-replies': {
    action: 'odpowiedz-uslugi.dodana',
    details: (_body, payload) => ({ target: String(payload?.id ?? ''), details: { usluga: payload?.serviceId } }),
  },
  'DELETE /api/cases/:id/service-replies/:replyId': { action: 'odpowiedz-uslugi.wycofana' },
  'POST /api/cases/:id/network/expand': {
    action: 'siec.rozwinieta',
    details: (body, payload) => ({
      target: String((payload?.expansion as { id?: string } | undefined)?.id ?? ''),
      details: { relacje: body.relations ?? [], glebokosc: body.depth ?? 1, dodane: payload?.added ?? null },
    }),
  },
  'DELETE /api/cases/:id/network/expand/:expansionId': { action: 'siec.rozwiniecie-wycofane' },
  'GET /api/cases/:id/export/:file': { action: 'eksport.pobrany' },
  'GET /api/runs/:id/report.html': { action: 'raport.pobrany' },
  'GET /api/runs/:id/report.json': { action: 'raport.pobrany' },
  'GET /api/runs/:id/service-request/:file': { action: 'material-zapytania.pobrany' },
};

/** Identyfikatory wpisów z parametrów trasy (techniczne, nie dane osobowe). */
const PARAM_TARGETS = ['decisionId', 'replyId', 'expansionId', 'file'];

export function registerLifecycleRoutes(app: FastifyInstance, context: RouteContext, deps: LifecycleDeps): { performDelete: (summary: CaseSummary, mode: CaseTombstone['mode']) => Promise<CaseTombstone> } {
  const { storage, now, requireCase } = context;
  const { options } = deps;
  /** Ostatnie archiwa w pamięci procesu (do pobrania tuż po utworzeniu, gdy brak OLCYS_ARCHIVE_DIR). */
  const recent = new Map<string, BuiltArchive>();

  const audit = async (action: string, caseId: string | undefined, target: string | undefined, details: Record<string, unknown>) => {
    try {
      await storage.addAudit({ at: now().toISOString(), actor: AUDIT_ACTOR, action, ...(caseId ? { caseId } : {}), ...(target ? { target } : {}), details });
    } catch (error) {
      app.log.error({ err: error }, `Nie udało się zapisać wpisu audytu (${action}).`);
    }
  };

  // ---------- Hak: zamknięta sprawa jest tylko do odczytu ----------

  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return;
    const url = request.routeOptions.url ?? '';
    if (!url.startsWith('/api/cases/:id/') || ALLOWED_WHEN_CLOSED.has(`${request.method} ${url}`)) return;
    const id = (request.params as { id?: string }).id;
    if (!id) return;
    const found = await storage.getCase(id);
    if (found && found.status !== 'open') {
      return reply.code(409).send({
        error: `Sprawa jest ${CASE_STATUS_LABEL[found.status]} — tylko do odczytu. Przywróć ją („Przywróć”), aby uruchamiać analizy, zapisywać decyzje lub rozwijać sieć.`,
      });
    }
  });

  // ---------- Hak: audyt zmian i pobrań z innych tras ----------

  app.addHook('onSend', async (request, reply, payload) => {
    const key = `${request.method} ${request.routeOptions.url ?? ''}`;
    const rule = AUDITED[key];
    if (!rule || reply.statusCode >= 300 || isInternalRequest(request)) return payload;
    const params = request.params as Record<string, string>;
    let parsed: Record<string, unknown> | null = null;
    if (typeof payload === 'string' && rule.details) {
      try {
        parsed = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    let caseId = key.startsWith(`${request.method} /api/cases/`) ? params.id : undefined;
    if (!caseId && params.id) caseId = (await storage.getRun(params.id).catch(() => null))?.caseId;
    const fromParams = PARAM_TARGETS.map((name) => params[name]).find(Boolean);
    const extra = rule.details?.((request.body ?? {}) as Record<string, unknown>, parsed);
    const query = request.query as { run?: string };
    await audit(rule.action, caseId, extra?.target || fromParams || (key.startsWith(`${request.method} /api/runs/`) ? params.id : undefined), {
      ...(extra?.details ?? {}),
      ...(key.includes('/export/') ? { plik: params.file, ...(query.run ? { analiza: query.run } : {}) } : {}),
      ...(key.includes('/report.') ? { plik: key.endsWith('.html') ? 'raport.html' : 'raport.json' } : {}),
    });
    return payload;
  });

  // ---------- Powiązania ----------

  const relatedFor = async (_summary: CaseSummary, run: AnalysisRun): Promise<string[]> => {
    const dossier = await context.loadDossier(run);
    return dossier.relatedPersons.map((person) => person.caseId).filter((id): id is string => Boolean(id));
  };

  const linksOf = async (caseId: string): Promise<CaseLink[]> => {
    const all = await collectLinkData(storage, { relatedFor, withRelated: new Set([caseId]) });
    const target = all.find((item) => item.caseId === caseId);
    return target ? findCaseLinks(target, all) : [];
  };

  app.get<{ Params: { id: string } }>('/api/cases/:id/links', { schema: { params: idParams } }, async (request) => {
    const summary = await requireCase(request.params.id);
    const links = await linksOf(summary.id);
    const blocking = links.some((link) => link.blocking);
    return {
      caseId: summary.id,
      status: summary.status,
      links,
      blocking,
      deletable: summary.status !== 'open' && !blocking,
      ...(blocking ? { message: linkedMessage(links) } : {}),
    };
  });

  // ---------- Zamknięcie i przywrócenie ----------

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/api/cases/:id/close',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 } } },
      },
    },
    async (request) => {
      const summary = await requireCase(request.params.id);
      if (summary.status !== 'open') throw new HttpError(409, `Sprawa jest już ${CASE_STATUS_LABEL[summary.status]}.`);
      const reason = request.body.reason.trim();
      if (!reason) throw new HttpError(400, 'Podaj powód zamknięcia sprawy.');
      const running = summary.runs.some((run) => run.status === 'running' && context.runs.progress(run.id)?.status === 'running');
      if (running) throw new HttpError(409, 'W tej sprawie trwa analiza — poczekaj na jej koniec, zanim zamkniesz sprawę.');
      // Zamknięta sprawa nie jest już obserwowana: automatyczne analizy zmieniałyby materiał tylko do odczytu.
      const watched = deps.watch.get(summary.id) !== undefined;
      if (watched) await deps.watch.remove(summary.id);
      await storage.setCaseStatus(summary.id, { status: 'closed', closedAt: now().toISOString(), closedReason: reason });
      // Powód zamknięcia może zawierać dane osobowe — w audycie zostaje tylko jego długość.
      await audit('sprawa.zamknieta', summary.id, undefined, { dlugoscPowodu: reason.length, wylaczonoObserwacje: watched });
      context.invalidateDossiers();
      return requireCase(summary.id);
    },
  );

  app.post<{ Params: { id: string } }>('/api/cases/:id/reopen', { schema: { params: idParams } }, async (request) => {
    const summary = await requireCase(request.params.id);
    if (summary.status === 'open') throw new HttpError(409, 'Sprawa jest już otwarta.');
    await storage.setCaseStatus(summary.id, { status: 'open', closedAt: null, closedReason: null });
    await audit('sprawa.przywrocona', summary.id, undefined, { poprzedniStan: summary.status });
    context.invalidateDossiers();
    return requireCase(summary.id);
  });

  // ---------- Archiwum ----------

  const archiveName = (summary: CaseSummary, digest: string) => `olcys-archiwum-${summary.id.replace(/[^A-Za-z0-9-]/g, '').slice(0, 36)}-${digest.slice(0, 12)}.zip`;

  app.post<{ Params: { id: string } }>('/api/cases/:id/archive', { schema: { params: idParams } }, async (request, reply) => {
    const summary = await requireCase(request.params.id);
    if (summary.status === 'open') throw new HttpError(409, 'Najpierw zamknij sprawę — archiwum powstaje z materiału, który już się nie zmienia.');
    const generatedAt = now().toISOString();
    const archive = await buildCaseArchive({ app, storage, summary, toolVersion: TOOL_VERSION, rules: context.rules, generatedAt });
    if (options.archiveDir) archive.meta.storedAs = storeArchive(options.archiveDir, archive);
    await storage.recordCaseArchive(summary.id, { at: generatedAt, sha256: archive.sha256, meta: archive.meta });
    recent.delete(summary.id);
    recent.set(summary.id, archive);
    while (recent.size > 5) recent.delete(recent.keys().next().value!);
    await audit('sprawa.zarchiwizowana', summary.id, archive.sha256, {
      bajty: archive.meta.bytes,
      pliki: archive.meta.files,
      naSerwerze: Boolean(archive.meta.storedAs),
      liczby: archive.manifest.counts,
    });
    context.invalidateDossiers();
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${archiveName(summary, archive.sha256)}"`)
      .header('X-Olcys-Archive-Sha256', archive.sha256)
      .send(archive.zip);
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id/archive/latest', { schema: { params: idParams } }, async (request, reply) => {
    const summary = await requireCase(request.params.id);
    if (!summary.archiveSha256) throw new HttpError(404, 'Sprawa nie ma jeszcze archiwum — użyj „Archiwizuj i pobierz”.');
    let zip: Buffer | null = recent.get(summary.id)?.sha256 === summary.archiveSha256 ? recent.get(summary.id)!.zip : null;
    if (!zip && options.archiveDir && summary.archive?.storedAs) {
      try {
        zip = loadStoredArchive(options.archiveDir, summary.archive.storedAs, summary.archiveSha256);
      } catch (error) {
        throw new HttpError(500, error instanceof Error ? error.message : 'Nie udało się odczytać archiwum.');
      }
    }
    if (!zip) {
      throw new HttpError(404, 'Plik archiwum nie jest przechowywany na serwerze (brak OLCYS_ARCHIVE_DIR albo serwer uruchomiono ponownie). W bazie jest tylko jego skrót SHA-256 — utwórz nowe archiwum przyciskiem „Archiwizuj i pobierz”.');
    }
    await audit('archiwum.pobrane', summary.id, summary.archiveSha256, {});
    return reply
      .type('application/zip')
      .header('Content-Disposition', `attachment; filename="${archiveName(summary, summary.archiveSha256)}"`)
      .header('X-Olcys-Archive-Sha256', summary.archiveSha256)
      .send(zip);
  });

  // ---------- Usunięcie ----------

  const performDelete = async (summary: CaseSummary, mode: CaseTombstone['mode']): Promise<CaseTombstone> => {
    if (deps.watch.get(summary.id) !== undefined) await deps.watch.remove(summary.id);
    const tombstone = await storage.deleteCase(summary.id, { deletedAt: now().toISOString(), mode });
    if (!tombstone) throw new HttpError(404, 'Nie znaleziono sprawy.');
    recent.delete(summary.id);
    context.invalidateDossiers();
    await audit(mode === 'retencja' ? 'sprawa.usunieta-retencja' : 'sprawa.usunieta', summary.id, undefined, {
      tryb: mode,
      poprzedniStan: summary.status,
      archiwumSha256: tombstone.archiveSha256 ?? null,
      liczby: tombstone.counts,
    });
    // Usunięcie musi przetrwać ponowne uruchomienie — migawka od razu, nie za minutę.
    await storage.flush();
    return tombstone;
  };

  app.delete<{ Params: { id: string }; Body: { confirm: string } }>(
    '/api/cases/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', required: ['confirm'], additionalProperties: false, properties: { confirm: { type: 'string', minLength: 1, maxLength: 300 } } },
      },
    },
    async (request, reply) => {
      const summary = await requireCase(request.params.id);
      if (request.body.confirm.trim() !== summary.name.trim()) {
        throw new HttpError(400, 'Potwierdzenie nie zgadza się z nazwą sprawy — wpisz dokładną nazwę sprawy, aby ją usunąć.');
      }
      if (summary.status === 'open') throw new HttpError(409, 'Usunąć można tylko sprawę zamkniętą lub zarchiwizowaną — najpierw ją zamknij.');
      if (summary.runs.some((run) => run.status === 'running' && context.runs.progress(run.id)?.status === 'running')) {
        throw new HttpError(409, 'W tej sprawie trwa analiza — poczekaj na jej koniec.');
      }
      const links = await linksOf(summary.id);
      if (links.some((link) => link.blocking)) {
        await audit('sprawa.usuniecie-odmowa', summary.id, undefined, { powod: 'powiazania', sprawy: links.filter((link) => link.blocking).map((link) => link.caseId) });
        return reply.code(409).send({ error: linkedMessage(links), links });
      }
      const tombstone = await performDelete(summary, 'reczne');
      return { deleted: true, tombstone };
    },
  );

  // ---------- Dziennik audytu ----------

  app.get<{ Querystring: { caseId?: string; limit?: number } }>(
    '/api/audit',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { caseId: { type: 'string', minLength: 1, maxLength: 64 }, limit: { type: 'integer', minimum: 1, maximum: 5000 } },
        },
      },
    },
    async (request) => ({ entries: await storage.listAudit({ caseId: request.query.caseId, limit: request.query.limit ?? 500 }) }),
  );

  // ---------- Retencja ----------

  const preview = async (): Promise<RetentionPreview> => {
    const cases = (await storage.listCases()).filter((item) => item.status !== 'open');
    const at = now();
    if (cases.length === 0) {
      return { enabled: options.retentionDays !== undefined, ...(options.retentionDays !== undefined ? { days: options.retentionDays } : {}), generatedAt: at.toISOString(), items: [] };
    }
    const all = await collectLinkData(storage, { relatedFor, withRelated: new Set(cases.map((item) => item.id)) });
    const items: RetentionItem[] = cases.map((summary) => {
      const target = all.find((item) => item.caseId === summary.id);
      return assessRetention(summary, target ? findCaseLinks(target, all) : [], options.retentionDays, at);
    });
    return { enabled: options.retentionDays !== undefined, ...(options.retentionDays !== undefined ? { days: options.retentionDays } : {}), generatedAt: at.toISOString(), items };
  };

  app.get('/api/retention/preview', async () => preview());

  const retention = createRetentionJob({
    days: options.retentionDays,
    now,
    preview,
    remove: async (item) => {
      const summary = await storage.getCase(item.caseId);
      // Stan mógł się zmienić od podglądu — ponowna ocena tuż przed usunięciem.
      if (!summary) return;
      const recheck = assessRetention(summary, await linksOf(summary.id), options.retentionDays, now());
      if (!recheck.eligible) {
        app.log.info(`Retencja: sprawa ${summary.id} pominięta — warunki przestały być spełnione.`);
        return;
      }
      await performDelete(summary, 'retencja');
      app.log.info(`Retencja: usunięto sprawę ${summary.id} (archiwum ${summary.archiveSha256?.slice(0, 16)}…).`);
    },
    log: (message, error) => (error ? app.log.error({ err: error }, message) : app.log.info(message)),
    ...(options.retentionTimers ? { timers: options.retentionTimers } : {}),
  });
  retention.start();
  app.addHook('preClose', () => retention.stop());

  // ---------- Stan zabezpieczeń ----------

  app.get('/api/security/status', async () => ({
    tokenRequired: Boolean(deps.security.apiToken),
    snapshotEncrypted: storage.encryptedAtRest(),
    retention: { enabled: options.retentionDays !== undefined, ...(options.retentionDays !== undefined ? { days: options.retentionDays } : {}) },
    archiveStoredOnServer: Boolean(options.archiveDir),
    corsOrigins: deps.security.corsOrigins ?? [],
    rateLimitPerMinute: deps.security.rateLimitPerMinute ?? null,
  }));

  return { performDelete };
}
