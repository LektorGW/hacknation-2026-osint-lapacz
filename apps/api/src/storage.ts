// Zapis spraw, analiz i kopii treści dokumentów w PostgreSQL.
// Ten sam SQL działa na dwóch sterownikach: PGlite (wbudowany, bez instalacji bazy)
// oraz `pg` (zewnętrzny serwer wskazany przez DATABASE_URL).

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AnalysisRun, AnalystDecision, SubjectQuery, Sweep, WatchHit } from '@olcys/core';
import type { CapturedDocument } from './analysis.ts';
import type { RunIntel } from './intel.ts';

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
export type DecisionRecord = AnalystDecision & { author: string };

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
  /** Decyzje sprawy w kolejności podejmowania. */
  listDecisions(caseId: string): Promise<DecisionRecord[]>;
  /** Zwraca `false`, gdy sprawa nie ma takiej decyzji. */
  deleteDecision(caseId: string, decisionId: string): Promise<boolean>;
  saveSweep(sweep: Sweep): Promise<void>;
  getSweep(id: string): Promise<Sweep | null>;
  listSweeps(): Promise<Sweep[]>;
  saveLeadAnalysis(sweepId: string, leadId: string, analysis: LeadAnalysis): Promise<void>;
  getLeadAnalysis(sweepId: string, leadId: string): Promise<LeadAnalysis | null>;
  /** Ustawienia i statystyki monitoringu (jeden dokument JSON); `null` przed pierwszym zapisem. */
  getMonitorState<T>(): Promise<T | null>;
  saveMonitorState(state: unknown): Promise<void>;
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
  close(): Promise<void>;
}

/** PGlite: `dataDir` wskazuje katalog danych; bez niego baza żyje tylko w pamięci. */
export async function createPgliteDriver(dataDir?: string): Promise<SqlDriver> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  return {
    async query(sql, params) {
      const result = await db.query<Record<string, unknown>>(sql, params);
      return result.rows;
    },
    close: () => db.close(),
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
      }));
    },

    async deleteDecision(caseId, decisionId) {
      const rows = await driver.query('DELETE FROM decisions WHERE case_id = $1 AND id = $2 RETURNING id', [caseId, decisionId]);
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

    async filterUnseenUrls(urls) {
      const unseen: string[] = [];
      for (const url of new Set(urls)) {
        const rows = await driver.query('SELECT 1 FROM monitor_seen WHERE url = $1', [url]);
        if (rows.length === 0) unseen.push(url);
      }
      return unseen;
    },

    async markUrlsSeen(urls, seenAt) {
      for (const url of new Set(urls)) {
        await driver.query('INSERT INTO monitor_seen (url, seen_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [url, seenAt]);
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

    close: () => driver.close(),
  };
}
