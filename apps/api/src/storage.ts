// Zapis spraw, analiz i kopii treści dokumentów w PostgreSQL.
// Ten sam SQL działa na dwóch sterownikach: PGlite (wbudowany, bez instalacji bazy)
// oraz `pg` (zewnętrzny serwer wskazany przez DATABASE_URL).

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AnalysisRun, AnalystDecision, ProfileAttributes, SourceCategory, SubjectQuery, Sweep, WatchHit } from '@olcys/core';
import type { CapturedDocument } from './analysis.ts';
import type { RunIntel } from './intel.ts';
import type { ServiceReply } from './service-reply.ts';

export interface RunSummary {
  id: string;
  startedAt: string;
  status: string;
  findingCount: number;
  topScore: number;
}

export interface CaseSummary {
  id: string;
  name: string;
  createdAt: string;
  query: SubjectQuery;
  runs: RunSummary[];
}

/** Decyzja analityka wraz z autorem (na razie stałym — narzędzie nie ma kont użytkowników). */
export type DecisionRecord = AnalystDecision & {
  author: string;
  /** Czas wycofania decyzji (ISO 8601). Wycofana decyzja zostaje w rejestrze, ale nie wpływa na wynik. */
  withdrawnAt?: string;
  /** Kto wycofał decyzję. */
  withdrawnBy?: string;
};

/** Ostatnia zakończona analiza sprawy — do zestawień między sprawami. */
export interface LatestRun {
  caseId: string;
  caseName: string;
  run: AnalysisRun;
}

/** Analiza wykonana w przeglądzie źródeł, gotowa do zapisania jako pierwsza analiza sprawy. */
export interface LeadAnalysis {
  query: SubjectQuery;
  connectors: string[];
  startedAt: string;
  finishedAt: string;
  findings: AnalysisRun['findings'];
  log: AnalysisRun['log'];
  documents: CapturedDocument[];
  intel: RunIntel;
}

/** Publikacja w indeksie własnym (`corpus`) wraz z adresami wykrytymi w treści. */
export interface CorpusDocument {
  url: string;
  service: string;
  connectorId: string;
  author?: string;
  publishedAt?: string;
  fetchedAt: string;
  title: string;
  text: string;
  contentHash: string;
  category: SourceCategory;
  profile?: ProfileAttributes;
  addresses: { network: string; address: string }[];
}

/** Zapytanie do indeksu: dokładny adres, dokładny autor albo fraza w treści. */
export type CorpusQuery = { address: string } | { author: string } | { phrase: string };

export interface CorpusStats {
  documents: number;
  addresses: number;
  services: number;
  oldestFetchedAt?: string;
  newestFetchedAt?: string;
}

/** Minimalny wspólny interfejs sterowników bazy. */
export interface SqlDriver {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface Storage {
  migrate(): Promise<void>;
  createCase(name: string, query: SubjectQuery, createdAt: string): Promise<CaseSummary>;
  listCases(): Promise<CaseSummary[]>;
  getCase(id: string): Promise<CaseSummary | null>;
  updateCaseQuery(id: string, query: SubjectQuery): Promise<void>;
  /** Zapisuje analizę; ponowny zapis tego samego `id` nadpisuje (np. zmiana statusu). */
  saveRun(run: AnalysisRun): Promise<void>;
  getRun(id: string): Promise<AnalysisRun | null>;
  saveDocuments(runId: string, documents: CapturedDocument[]): Promise<void>;
  listDocuments(runId: string): Promise<CapturedDocument[]>;
  saveRunIntel(runId: string, intel: RunIntel): Promise<void>;
  getRunIntel(runId: string): Promise<RunIntel | null>;
  /** Ostatnia zakończona analiza każdej sprawy. */
  listLatestRuns(): Promise<LatestRun[]>;
  addDecision(decision: DecisionRecord): Promise<void>;
  /** Decyzje sprawy w kolejności podejmowania — łącznie z wycofanymi (`withdrawnAt`), bo rejestr jest śladem audytowym. */
  listDecisions(caseId: string): Promise<DecisionRecord[]>;
  /**
   * Wycofuje decyzję: wpis zostaje w rejestrze z czasem i autorem wycofania, ale przestaje wpływać na wynik.
   * Zwraca `false`, gdy sprawa nie ma takiej decyzji albo decyzja jest już wycofana.
   */
  deleteDecision(caseId: string, decisionId: string, withdrawal?: { at?: string; by?: string }): Promise<boolean>;
  /** Zapisuje odpowiedź usługi (dokument spoza OSINT wprowadzony przez analityka). */
  addServiceReply(reply: ServiceReply): Promise<void>;
  /** Odpowiedzi usług w sprawie w kolejności wprowadzania — łącznie z wycofanymi (ślad audytowy). */
  listServiceReplies(caseId: string): Promise<ServiceReply[]>;
  /** Wycofuje odpowiedź: wpis zostaje z czasem i autorem wycofania. `false`, gdy nie ma takiej obowiązującej odpowiedzi. */
  withdrawServiceReply(caseId: string, replyId: string, withdrawal?: { at?: string; by?: string }): Promise<boolean>;
  saveSweep(sweep: Sweep): Promise<void>;
  getSweep(id: string): Promise<Sweep | null>;
  listSweeps(): Promise<Sweep[]>;
  saveLeadAnalysis(sweepId: string, leadId: string, analysis: LeadAnalysis): Promise<void>;
  getLeadAnalysis(sweepId: string, leadId: string): Promise<LeadAnalysis | null>;
  /** Ustawienia i statystyki monitoringu (jeden dokument JSON); `null` przed pierwszym zapisem. */
  getMonitorState<T>(): Promise<T | null>;
  saveMonitorState(state: unknown): Promise<void>;
  /** Inny dokument ustawień (JSON) pod kluczem, np. obserwowane sprawy; `null` przed pierwszym zapisem. */
  getConfig<T>(id: string): Promise<T | null>;
  saveConfig(id: string, data: unknown): Promise<void>;
  /** Z podanych adresów zwraca te, których monitoring jeszcze nie widział. */
  filterUnseenUrls(urls: string[]): Promise<string[]>;
  markUrlsSeen(urls: string[], seenAt: string): Promise<void>;
  /** Zapisuje trafienie; `dedupeKey` (autor w serwisie) gwarantuje jedno trafienie na autora. */
  saveHit(hit: WatchHit, dedupeKey: string): Promise<void>;
  getHit(id: string): Promise<WatchHit | null>;
  getHitByKey(dedupeKey: string): Promise<WatchHit | null>;
  listHits(): Promise<WatchHit[]>;
  saveHitAnalysis(id: string, analysis: LeadAnalysis): Promise<void>;
  getHitAnalysis(id: string): Promise<LeadAnalysis | null>;
  /** Dopisuje publikacje do indeksu; znane adresy URL są pomijane. */
  saveCorpusDocuments(documents: CorpusDocument[]): Promise<void>;
  searchCorpus(query: CorpusQuery, limit: number): Promise<CorpusDocument[]>;
  /** Publikacja z indeksu po adresie URL (bez listy adresów kryptowalutowych). */
  getCorpusDocument(url: string): Promise<Omit<CorpusDocument, 'addresses'> | null>;
  /** Usuwa publikacje starsze niż `olderThan` oraz najstarsze ponad `maxRows`; zwraca liczbę usuniętych. */
  pruneCorpus(olderThan: string, maxRows: number): Promise<number>;
  corpusStats(): Promise<CorpusStats>;
  /** Czy baza odpowiada. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** PGlite: `dataDir` wskazuje katalog danych; bez niego baza żyje tylko w pamięci. */
export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (!dataDir) {
    const memory = new PGlite();
    await memory.waitReady;
    return {
      async query(sql, params) {
        return (await memory.query<Record<string, unknown>>(sql, params)).rows;
      },
      close: () => memory.close(),
    };
  }

  // Katalog roboczy PGlite w systemie Windows nie otwiera się ponownie po zamknięciu procesu,
  // dlatego trwałym zapisem jest MIGAWKA całej bazy (plik obok katalogu danych): zapisywana
  // co minutę i przy zamknięciu. Każde uruchomienie dostaje świeży katalog roboczy wczytany
  // z migawki; stare katalogi robocze są sprzątane, o ile system na to pozwala.
  const snapshotFile = `${dataDir}.migawka.tar.gz`;
  mkdirSync(dataDir, { recursive: true });
  for (const entry of readdirSync(dataDir)) {
    try {
      rmSync(join(dataDir, entry), { recursive: true, force: true });
    } catch {
      // Zablokowany przez inny proces — zostaje do następnego uruchomienia.
    }
  }
  const workDir = join(dataDir, `sesja-${Date.now()}`);
  const open = async (options?: { loadDataDir: Blob }) => {
    const instance = new PGlite(workDir, options);
    await instance.waitReady;
    return instance;
  };

  let db: Awaited<ReturnType<typeof open>>;
  if (existsSync(snapshotFile)) {
    db = await open({ loadDataDir: new Blob([readFileSync(snapshotFile)]) });
  } else {
    db = await open();
  }

  let writing: Promise<void> = Promise.resolve();
  const snapshot = () => {
    // Zapis przez plik tymczasowy: przerwany zapis nie niszczy poprzedniej migawki.
    writing = writing
      .then(async () => {
        const dump = await db.dumpDataDir('gzip');
        const temporary = `${snapshotFile}.tmp`;
        writeFileSync(temporary, Buffer.from(await dump.arrayBuffer()));
        renameSync(temporary, snapshotFile);
      })
      .catch((error) => console.warn(`Migawka bazy nie powiodła się: ${error instanceof Error ? error.message : error}`));
    return writing;
  };
  const timer = setInterval(snapshot, 60_000);
  timer.unref();

  return {
    async query(sql, params) {
      return (await db.query<Record<string, unknown>>(sql, params)).rows;
    },
    async close() {
      clearInterval(timer);
      await snapshot();
      await db.close();
    },
  };
}

export async function createPgDriver(connectionString: string): Promise<SqlDriver> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString });
  return {
    async query(sql, params) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    close: () => pool.end(),
  };
}

export function createDriverFromEnv(env: NodeJS.ProcessEnv): Promise<SqlDriver> {
  if (env.DATABASE_URL) return createPgDriver(env.DATABASE_URL);
  return createPgliteDriver(env.OLCYS_DATA_DIR ?? './data/pg');
}

const SCHEMA_SQL = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const CHUNK = 200;

/** Dzieli listę na paczki — zapytania z listą wartości mają ograniczoną liczbę parametrów. */
function chunks<T>(items: T[], size: number): T[][] {
  const parts: T[][] = [];
  for (let index = 0; index < items.length; index += size) parts.push(items.slice(index, index + size));
  return parts;
}

/** `$n, $n+1, …` dla `count` parametrów; `casts` dopisuje rzutowanie do wskazanych pozycji (od zera). */
const placeholders = (count: number, start: number, casts: Record<number, string> = {}): string =>
  Array.from({ length: count }, (_, index) => `$${start + index}${casts[index] ?? ''}`).join(', ');

/** Nazwa autora do porównań: bez `@`, małe litery. */
const authorKey = (author: string): string => author.trim().replace(/^@/, '').toLowerCase();

const toIso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
const optional = (value: unknown): string | undefined => (value == null ? undefined : String(value));

function toRunSummary(row: Record<string, unknown>): RunSummary {
  return {
    id: String(row.id),
    startedAt: toIso(row.started_at),
    status: String(row.status),
    findingCount: Number(row.finding_count),
    topScore: Number(row.top_score),
  };
}

export function createStorage(driver: SqlDriver): Storage {
  const toCase = (row: Record<string, unknown>, runs: RunSummary[]): CaseSummary => ({
    id: String(row.id),
    name: String(row.name),
    createdAt: toIso(row.created_at),
    query: row.query as SubjectQuery,
    runs,
  });

  return {
    async migrate() {
      // Sterowniki przyjmują jedno polecenie na zapytanie, więc plik dzielimy na polecenia.
      const statements = SCHEMA_SQL.replace(/^\s*--.*$/gm, '')
        .split(/;\s*$/m)
        .map((statement) => statement.trim())
        .filter(Boolean);
      for (const statement of statements) await driver.query(statement);
    },

    async createCase(name, query, createdAt) {
      const id = randomUUID();
      await driver.query('INSERT INTO cases (id, name, created_at, query) VALUES ($1, $2, $3, $4::jsonb)', [
        id,
        name,
        createdAt,
        JSON.stringify(query),
      ]);
      return { id, name, createdAt, query, runs: [] };
    },

    async listCases() {
      const cases = await driver.query('SELECT id, name, created_at, query FROM cases ORDER BY created_at DESC, id');
      const runs = await driver.query(
        'SELECT id, case_id, started_at, status, finding_count, top_score FROM runs ORDER BY started_at, id',
      );
      return cases.map((row) =>
        toCase(row, runs.filter((run) => run.case_id === row.id).map(toRunSummary)),
      );
    },

    async getCase(id) {
      const [row] = await driver.query('SELECT id, name, created_at, query FROM cases WHERE id = $1', [id]);
      if (!row) return null;
      const runs = await driver.query(
        'SELECT id, started_at, status, finding_count, top_score FROM runs WHERE case_id = $1 ORDER BY started_at, id',
        [id],
      );
      return toCase(row, runs.map(toRunSummary));
    },

    async updateCaseQuery(id, query) {
      await driver.query('UPDATE cases SET query = $2::jsonb WHERE id = $1', [id, JSON.stringify(query)]);
    },

    async saveRun(run) {
      // Najwyższy wynik liczymy bez adresów wykluczonych (te mają 0%).
      const topScore = Math.max(0, ...run.findings.map((finding) => finding.confidence.score));
      await driver.query(
        `INSERT INTO runs (id, case_id, started_at, finished_at, status, finding_count, top_score, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           finished_at = EXCLUDED.finished_at, status = EXCLUDED.status,
           finding_count = EXCLUDED.finding_count, top_score = EXCLUDED.top_score, result = EXCLUDED.result`,
        [
          run.id,
          run.caseId,
          run.startedAt,
          run.finishedAt ?? null,
          run.status,
          run.findings.length,
          topScore,
          JSON.stringify(run),
        ],
      );
    },

    async getRun(id) {
      const [row] = await driver.query('SELECT result FROM runs WHERE id = $1', [id]);
      return row ? (row.result as AnalysisRun) : null;
    },

    async saveDocuments(runId, documents) {
      for (const doc of documents) {
        await driver.query(
          `INSERT INTO documents
             (run_id, content_hash, url, title, service, connector_id, author, published_at, archived_at, fetched_at, content)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT DO NOTHING`,
          [
            runId,
            doc.contentHash,
            doc.url,
            doc.title,
            doc.service,
            doc.connectorId,
            doc.author ?? null,
            doc.publishedAt ?? null,
            doc.archivedAt ?? null,
            doc.fetchedAt,
            doc.text,
          ],
        );
      }
    },

    async listDocuments(runId) {
      const rows = await driver.query('SELECT * FROM documents WHERE run_id = $1 ORDER BY fetched_at, url', [runId]);
      return rows.map((row) => ({
        contentHash: String(row.content_hash),
        url: String(row.url),
        title: String(row.title),
        service: String(row.service),
        connectorId: String(row.connector_id),
        author: optional(row.author),
        publishedAt: optional(row.published_at),
        archivedAt: optional(row.archived_at),
        fetchedAt: toIso(row.fetched_at),
        text: String(row.content),
      }));
    },

    async saveRunIntel(runId, intel) {
      await driver.query('UPDATE runs SET intel = $2::jsonb WHERE id = $1', [runId, JSON.stringify(intel)]);
    },

    async getRunIntel(runId) {
      const [row] = await driver.query('SELECT intel FROM runs WHERE id = $1', [runId]);
      return row?.intel ? (row.intel as RunIntel) : null;
    },

    async listLatestRuns() {
      const rows = await driver.query(
        `SELECT DISTINCT ON (r.case_id) r.case_id, c.name, r.result
           FROM runs r JOIN cases c ON c.id = r.case_id
          WHERE r.status = 'completed'
          ORDER BY r.case_id, r.started_at DESC, r.id DESC`,
      );
      return rows.map((row) => ({ caseId: String(row.case_id), caseName: String(row.name), run: row.result as AnalysisRun }));
    },

    async addDecision(decision) {
      await driver.query(
        `INSERT INTO decisions (id, case_id, target, target_key, decision, note, author, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          decision.id,
          decision.caseId,
          decision.target,
          decision.key,
          decision.decision,
          decision.note ?? null,
          decision.author,
          decision.decidedAt,
        ],
      );
    },

    async listDecisions(caseId) {
      const rows = await driver.query('SELECT * FROM decisions WHERE case_id = $1 ORDER BY seq', [caseId]);
      return rows.map((row) => ({
        id: String(row.id),
        caseId: String(row.case_id),
        target: String(row.target) as DecisionRecord['target'],
        key: String(row.target_key),
        decision: String(row.decision) as DecisionRecord['decision'],
        ...(row.note == null ? {} : { note: String(row.note) }),
        decidedAt: toIso(row.decided_at),
        author: String(row.author),
        ...(row.withdrawn_at == null ? {} : { withdrawnAt: toIso(row.withdrawn_at), withdrawnBy: String(row.withdrawn_by ?? 'analityk') }),
      }));
    },

    async deleteDecision(caseId, decisionId, withdrawal = {}) {
      const rows = await driver.query(
        'UPDATE decisions SET withdrawn_at = $3, withdrawn_by = $4 WHERE case_id = $1 AND id = $2 AND withdrawn_at IS NULL RETURNING id',
        [caseId, decisionId, withdrawal.at ?? new Date().toISOString(), withdrawal.by ?? 'analityk'],
      );
      return rows.length > 0;
    },

    async addServiceReply(reply) {
      await driver.query(
        `INSERT INTO service_replies (id, case_id, service_name, service_id, reference, received_at, recorded_at, recorded_by, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [reply.id, reply.caseId, reply.serviceName, reply.serviceId, reply.reference, reply.receivedAt, reply.recordedAt, reply.recordedBy, JSON.stringify(reply.payload)],
      );
    },

    async listServiceReplies(caseId) {
      const rows = await driver.query('SELECT * FROM service_replies WHERE case_id = $1 ORDER BY seq', [caseId]);
      return rows.map((row) => ({
        id: String(row.id),
        caseId: String(row.case_id),
        serviceName: String(row.service_name),
        serviceId: String(row.service_id),
        reference: String(row.reference),
        receivedAt: toIso(row.received_at),
        recordedAt: toIso(row.recorded_at),
        recordedBy: String(row.recorded_by),
        payload: row.payload as ServiceReply['payload'],
        ...(row.withdrawn_at == null ? {} : { withdrawnAt: toIso(row.withdrawn_at), withdrawnBy: String(row.withdrawn_by ?? 'analityk') }),
      }));
    },

    async withdrawServiceReply(caseId, replyId, withdrawal = {}) {
      const rows = await driver.query(
        'UPDATE service_replies SET withdrawn_at = $3, withdrawn_by = $4 WHERE case_id = $1 AND id = $2 AND withdrawn_at IS NULL RETURNING id',
        [caseId, replyId, withdrawal.at ?? new Date().toISOString(), withdrawal.by ?? 'analityk'],
      );
      return rows.length > 0;
    },

    async saveSweep(sweep) {
      await driver.query(
        `INSERT INTO sweeps (id, started_at, result) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (id) DO UPDATE SET result = EXCLUDED.result`,
        [sweep.id, sweep.startedAt, JSON.stringify(sweep)],
      );
    },

    async getSweep(id) {
      const [row] = await driver.query('SELECT result FROM sweeps WHERE id = $1', [id]);
      return row ? (row.result as Sweep) : null;
    },

    async listSweeps() {
      const rows = await driver.query('SELECT result FROM sweeps ORDER BY started_at DESC, id');
      return rows.map((row) => row.result as Sweep);
    },

    async saveLeadAnalysis(sweepId, leadId, analysis) {
      await driver.query(
        `INSERT INTO sweep_leads (sweep_id, lead_id, analysis) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (sweep_id, lead_id) DO UPDATE SET analysis = EXCLUDED.analysis`,
        [sweepId, leadId, JSON.stringify(analysis)],
      );
    },

    async getLeadAnalysis(sweepId, leadId) {
      const [row] = await driver.query('SELECT analysis FROM sweep_leads WHERE sweep_id = $1 AND lead_id = $2', [sweepId, leadId]);
      return row ? (row.analysis as LeadAnalysis) : null;
    },

    async getMonitorState<T>() {
      const [row] = await driver.query("SELECT data FROM monitor_config WHERE id = 'monitor'");
      return row ? (row.data as T) : null;
    },

    async saveMonitorState(state) {
      await driver.query(
        `INSERT INTO monitor_config (id, data) VALUES ('monitor', $1::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [JSON.stringify(state)],
      );
    },

    // Ta sama tabela co ustawienia monitoringu: jeden wiersz JSON na rodzaj ustawień.
    async getConfig<T>(id: string) {
      const [row] = await driver.query('SELECT data FROM monitor_config WHERE id = $1', [`config:${id}`]);
      return row ? (row.data as T) : null;
    },

    async saveConfig(id, data) {
      await driver.query(
        `INSERT INTO monitor_config (id, data) VALUES ($1, $2::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [`config:${id}`, JSON.stringify(data)],
      );
    },

    async filterUnseenUrls(urls) {
      const unique = [...new Set(urls)];
      const seen = new Set<string>();
      for (const part of chunks(unique, CHUNK)) {
        const rows = await driver.query(`SELECT url FROM monitor_seen WHERE url IN (${placeholders(part.length, 1)})`, part);
        for (const row of rows) seen.add(String(row.url));
      }
      return unique.filter((url) => !seen.has(url));
    },

    async markUrlsSeen(urls, seenAt) {
      for (const part of chunks([...new Set(urls)], CHUNK)) {
        const values = part.map((_, index) => `($${index + 2}, $1)`).join(', ');
        await driver.query(`INSERT INTO monitor_seen (url, seen_at) VALUES ${values} ON CONFLICT DO NOTHING`, [seenAt, ...part]);
      }
    },

    async saveHit(hit, dedupeKey) {
      await driver.query(
        `INSERT INTO monitor_hits (id, dedupe_key, detected_at, data) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
        [hit.id, dedupeKey, hit.detectedAt, JSON.stringify(hit)],
      );
    },

    async getHit(id) {
      const [row] = await driver.query('SELECT data FROM monitor_hits WHERE id = $1', [id]);
      return row ? (row.data as WatchHit) : null;
    },

    async getHitByKey(dedupeKey) {
      const [row] = await driver.query('SELECT data FROM monitor_hits WHERE dedupe_key = $1', [dedupeKey]);
      return row ? (row.data as WatchHit) : null;
    },

    async listHits() {
      const rows = await driver.query('SELECT data FROM monitor_hits ORDER BY detected_at DESC, id');
      return rows.map((row) => row.data as WatchHit);
    },

    async saveHitAnalysis(id, analysis) {
      await driver.query('UPDATE monitor_hits SET analysis = $2::jsonb WHERE id = $1', [id, JSON.stringify(analysis)]);
    },

    async getHitAnalysis(id) {
      const [row] = await driver.query('SELECT analysis FROM monitor_hits WHERE id = $1', [id]);
      return row?.analysis ? (row.analysis as LeadAnalysis) : null;
    },

    async saveCorpusDocuments(documents) {
      // Przy powtórzonym adresie URL zostaje pierwsza publikacja.
      const unique = [...new Map([...documents].reverse().map((doc) => [doc.url, doc])).values()].reverse();
      // Wiersze wstawiamy paczkami — monitoring dopisuje tysiące publikacji na cykl.
      for (const part of chunks(unique, 50)) {
        const columns = 12;
        const values = part.map((_, row) => `(${placeholders(columns, row * columns + 1, { 11: '::jsonb' })})`).join(', ');
        await driver.query(
          `INSERT INTO corpus (url, service, connector_id, author, author_key, published_at, fetched_at, title, content, content_hash, category, profile)
           VALUES ${values} ON CONFLICT (url) DO NOTHING`,
          part.flatMap((doc) => [
            doc.url,
            doc.service,
            doc.connectorId,
            doc.author ?? null,
            doc.author ? authorKey(doc.author) : null,
            doc.publishedAt ?? null,
            doc.fetchedAt,
            doc.title,
            // PostgreSQL nie przyjmuje znaku NUL w tekście.
            doc.text.replaceAll('\u0000', ''),
            doc.contentHash,
            doc.category,
            doc.profile ? JSON.stringify(doc.profile) : null,
          ]),
        );
        const addresses = part.flatMap((doc) => doc.addresses.map((item) => [doc.url, item.network, item.address]));
        for (const rows of chunks(addresses, 200)) {
          const tuples = rows.map((_, row) => `(${placeholders(3, row * 3 + 1)})`).join(', ');
          await driver.query(`INSERT INTO corpus_addresses (url, network, address) VALUES ${tuples} ON CONFLICT DO NOTHING`, rows.flat());
        }
      }
    },

    async searchCorpus(query, limit) {
      const where =
        'address' in query
          ? 'url IN (SELECT url FROM corpus_addresses WHERE address = $1)'
          : 'author' in query
            ? 'author_key = $1'
            : "content ILIKE '%' || $1 || '%' ESCAPE '\\'";
      const value =
        'address' in query ? query.address : 'author' in query ? authorKey(query.author) : query.phrase.replace(/[\\%_]/g, (char) => `\\${char}`);
      const rows = await driver.query(`SELECT * FROM corpus WHERE ${where} ORDER BY fetched_at DESC, url LIMIT $2`, [value, limit]);
      if (rows.length === 0) return [];
      const urls = rows.map((row) => String(row.url));
      const addressRows = await driver.query(
        `SELECT url, network, address FROM corpus_addresses WHERE url IN (${placeholders(urls.length, 1)}) ORDER BY address`,
        urls,
      );
      return rows.map((row) => ({
        url: String(row.url),
        service: String(row.service),
        connectorId: String(row.connector_id),
        ...(row.author == null ? {} : { author: String(row.author) }),
        ...(row.published_at == null ? {} : { publishedAt: String(row.published_at) }),
        fetchedAt: toIso(row.fetched_at),
        title: String(row.title),
        text: String(row.content),
        contentHash: String(row.content_hash),
        category: String(row.category) as SourceCategory,
        ...(row.profile == null ? {} : { profile: row.profile as ProfileAttributes }),
        addresses: addressRows.filter((item) => item.url === row.url).map((item) => ({ network: String(item.network), address: String(item.address) })),
      }));
    },

    async getCorpusDocument(url) {
      const [row] = await driver.query('SELECT * FROM corpus WHERE url = $1', [url]);
      if (!row) return null;
      return {
        url: String(row.url),
        service: String(row.service),
        connectorId: String(row.connector_id),
        ...(row.author == null ? {} : { author: String(row.author) }),
        ...(row.published_at == null ? {} : { publishedAt: String(row.published_at) }),
        fetchedAt: toIso(row.fetched_at),
        title: String(row.title),
        text: String(row.content),
        contentHash: String(row.content_hash),
        category: String(row.category) as SourceCategory,
        ...(row.profile == null ? {} : { profile: row.profile as ProfileAttributes }),
      };
    },

    async pruneCorpus(olderThan, maxRows) {
      const old = await driver.query('DELETE FROM corpus WHERE fetched_at < $1 RETURNING url', [olderThan]);
      const excess = await driver.query(
        `DELETE FROM corpus WHERE url IN (SELECT url FROM corpus ORDER BY fetched_at DESC, url OFFSET $1) RETURNING url`,
        [maxRows],
      );
      return old.length + excess.length;
    },

    async corpusStats() {
      const [row] = await driver.query(
        `SELECT COUNT(*) AS documents, COUNT(DISTINCT service) AS services, MIN(fetched_at) AS oldest, MAX(fetched_at) AS newest FROM corpus`,
      );
      const [addresses] = await driver.query('SELECT COUNT(DISTINCT address) AS total FROM corpus_addresses');
      return {
        documents: Number(row?.documents ?? 0),
        addresses: Number(addresses?.total ?? 0),
        services: Number(row?.services ?? 0),
        ...(row?.oldest == null ? {} : { oldestFetchedAt: toIso(row.oldest) }),
        ...(row?.newest == null ? {} : { newestFetchedAt: toIso(row.newest) }),
      };
    },

    async ping() {
      try {
        await driver.query('SELECT 1');
        return true;
      } catch {
        return false;
      }
    },

    close: () => driver.close(),
  };
}
