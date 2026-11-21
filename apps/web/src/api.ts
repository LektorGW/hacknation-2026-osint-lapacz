// Warstwa dostępu do API zgodna z kontraktem z docs/ARCHITEKTURA.md.
// W trybie demo (`?demo=1` lub VITE_DEMO=1) dane pochodzą z `demo-backend.ts`.
import type {
  AnalysisRun,
  AnalystDecision,
  Decision,
  Dossier,
  Identifier,
  IdentifierType,
  MonitorStatus,
  RunDiff,
  ScoreRules,
  SourceConnector,
  SubjectQuery,
  Sweep,
  WatchHit,
} from '@olcys/core';
import { authHeaders, requestToken } from './auth.ts';
import { dossierFromRun } from './dossier.ts';
import type { AiStatus, CorpusStats, Depth, FullDossier, Period, RunProgress } from './proof.ts';
import { detectIdentifierType, normalizeIdentifier, suggestCaseName } from './identify.ts';
import type { RecheckResult } from './monitor.ts';
import { serviceLinksFromFindings } from './services.ts';
import type { ServiceReply, ServiceReplyBody, ServiceReplySample } from './service-reply.ts';
import type { CaseStat, StatsSummary } from './stats.ts';
import type { ExpandRequest, ExpandResult, NetworkPlan, NetworkView } from './graph/network.ts';
import type { DataMode } from './mode.ts';

/**
 * Tryb analiz uruchamianych z interfejsu: domyślnie głęboki. Usługa analizy bez podanego trybu
 * liczy standardowo, dlatego interfejs zawsze wysyła tryb jawnie.
 */
export const DEFAULT_DEPTH: Depth = 'deep';

export type ConnectorInfo = Pick<
  SourceConnector,
  'id' | 'service' | 'label' | 'description' | 'accepts' | 'enabledByDefault'
> & {
  /** Czy łącznik potrafi sam wskazać świeże publikacje (przegląd źródeł); pole opcjonalne. */
  discovers?: boolean;
  /** Źródło działa wyłącznie z kluczem API (pole opcjonalne — starsza usługa go nie podaje). */
  requiresKey?: boolean;
  /** Klucz jest ustawiony w konfiguracji usługi; wartości klucza usługa nigdy nie podaje. */
  keyConfigured?: boolean;
  /** Nazwy zmiennych środowiskowych z kluczem, np. GITHUB_TOKEN. */
  keyEnv?: string[];
};

export interface RunSummary {
  id: string;
  startedAt: string;
  status: string;
  findingCount: number;
  topScore: number;
  /** Tryb danych analizy (znacznik SANDBOX/LIVE); analizy sprzed przełącznika go nie mają. */
  dataMode?: DataMode;
}

export interface CaseSummary {
  id: string;
  name: string;
  createdAt: string;
  query: SubjectQuery;
  runs: RunSummary[];
  /** Sprawa obserwowana („Monitoruj”): analiza ponawiana automatycznie. */
  schedule?: { everyMinutes: number; nextRunAt: string };
  /** Stan sprawy; brak pola = starsza usługa (sprawa otwarta). */
  status?: CaseStatus;
  closedAt?: string;
  closedReason?: string;
  archivedAt?: string;
  archiveSha256?: string;
}

/** Stan sprawy: otwarta, zamknięta (tylko do odczytu), zarchiwizowana. */
export type CaseStatus = 'open' | 'closed' | 'archived';

/** Powiązanie sprawy z inną sprawą — blokuje usunięcie, gdy druga sprawa jest otwarta. */
export interface CaseLink {
  caseId: string;
  caseName: string;
  status: CaseStatus;
  blocking: boolean;
  reasons: { kind: string; label: string; values: string[] }[];
}

export interface CaseLinks {
  caseId: string;
  status: CaseStatus;
  links: CaseLink[];
  blocking: boolean;
  deletable: boolean;
  message?: string;
}

export interface AuditEntry {
  seq?: number;
  at: string;
  actor: string;
  action: string;
  caseId?: string;
  target?: string;
  details: Record<string, unknown>;
}

export interface RetentionItem {
  caseId: string;
  caseName: string;
  status: CaseStatus;
  closedAt?: string;
  archivedAt?: string;
  ageDays?: number;
  eligible: boolean;
  reasons: string[];
  blockingLinks: { caseId: string; caseName: string; kinds: string[] }[];
}

export interface RetentionPreview {
  enabled: boolean;
  days?: number;
  generatedAt: string;
  items: RetentionItem[];
}

export interface SecurityStatus {
  tokenRequired: boolean;
  snapshotEncrypted: boolean;
  retention: { enabled: boolean; days?: number };
  archiveStoredOnServer: boolean;
  corsOrigins: string[];
  rateLimitPerMinute: number | null;
}

/** Pobrane archiwum sprawy (ZIP) ze skrótem SHA-256 zapisanym w bazie. */
export interface CaseArchive {
  blob: Blob;
  fileName: string;
  sha256: string;
}

/** Przelew do giełdy lub usługi, którego nie było w poprzedniej analizie. */
export interface CashOutChange {
  address: string;
  network: string;
  txid: string;
  time: string;
  kind: string;
  counterparty: string;
  counterpartyLabel?: string;
  asset: string;
  amount: number;
  valuePln?: number;
  explorerUrl?: string;
}

export interface WatchRunBrief {
  id: string;
  startedAt: string;
  status: string;
  findingCount: number;
  topScore: number;
}

/** Obserwowana sprawa: harmonogram, ostatnia analiza i zmiany względem poprzedniej. */
export interface WatchedCase {
  caseId: string;
  name: string;
  everyMinutes: number;
  depth: Depth;
  since: string;
  nextRunAt: string;
  running: boolean;
  runningRunId?: string;
  lastError?: string;
  lastRun?: WatchRunBrief;
  compared?: { from: WatchRunBrief; to: WatchRunBrief };
  changes?: { diff: RunDiff; newCashOuts: CashOutChange[] };
}

export interface WatchList {
  intervals: number[];
  defaultDepth: Depth;
  items: WatchedCase[];
}

/** Ustawienia obserwacji sprawy; `null` wyłącza obserwację. */
export type WatchSettings = { everyMinutes: number; depth?: Depth } | null;

export type Replacement = RunDiff['replacedAddresses'][number];

export interface Overview {
  cases: number;
  runs: number;
  linkedAddresses: number;
  cashOutPlnByYear: Record<string, number>;
  topCases: {
    caseId: string;
    name: string;
    priority: number;
    topScore: number;
    cashOutPlnTotal: number;
    /** Nazwy powiązanych giełd i usług — pole opcjonalne. */
    services?: string[];
  }[];
  /** Stan cyklicznego przeglądu źródeł — pole opcjonalne. */
  monitor?: { enabled: boolean; lastRunAt?: string; newHits: number };
  /** Liczby każdej sprawy z zakończoną analizą (bez limitu „top 10”) — pole opcjonalne. */
  caseStats?: CaseStat[];
  /** Wskaźniki skuteczności (średnia pewność, trafienia, skuteczność) — pole opcjonalne. */
  stats?: StatsSummary;
  /** Zestawienie policzone w interfejsie z listy spraw (starsza wersja usługi). */
  approximate?: boolean;
}

/** Cel decyzji; `evidence` cofa wpływ modelu językowego na pojedynczy ślad. */
export type DecisionTarget = AnalystDecision['target'] | 'evidence';

export interface DecisionInput {
  target: DecisionTarget;
  key: string;
  decision: Decision;
  note?: string;
}

export interface MonitorSettings {
  enabled?: boolean;
  everyMinutes?: number;
  autoAnalyzeThreshold?: number;
  /** Limit automatycznych analiz autorów na przebieg (0–200). */
  maxAutoAnalyses?: number;
  /** Limit publikacji czytanych przez model językowy na przebieg (0–2000). */
  maxAiPublications?: number;
  sources?: Record<string, boolean>;
}

/** Tryb i okres analizy; okres zawęża historię blockchain i publikacje. */
export interface RunOptions {
  depth?: Depth;
  period?: Period;
  /** Tryb danych tylko dla tej analizy; bez pola obowiązuje ustawienie usługi. */
  dataMode?: DataMode;
}

/** Stan przełącznika trybu danych (`GET /api/settings/data-mode`). */
export interface DataModeSetting {
  dataMode: DataMode;
  tag: 'SANDBOX' | 'LIVE';
  label: string;
  defaultMode: DataMode;
  modes: Record<DataMode, { available: boolean; label: string; reason?: string }>;
  updatedAt?: string;
  storedDataMode?: DataMode;
  note?: string;
}

export interface RunHandle {
  id: string;
  status: string;
}

export interface QuickResult {
  case: CaseSummary;
  dossier?: Dossier;
  /** Analiza uruchomiona w tle (odpowiedź 202) — postęp pod `getProgress`. */
  run?: RunHandle;
}

export interface Backend {
  listConnectors(): Promise<ConnectorInfo[]>;
  getRules(): Promise<ScoreRules>;
  /** Opis składników priorytetu; `null`, gdy usługa nie udostępnia tej trasy. */
  getPriorityRules(): Promise<unknown | null>;
  listCases(): Promise<CaseSummary[]>;
  createCase(name: string, identifiers: Identifier[]): Promise<CaseSummary>;
  getCase(caseId: string): Promise<CaseSummary>;
  addIdentifiers(caseId: string, identifiers: Identifier[]): Promise<CaseSummary>;
  /** Uruchamia analizę w tle, jeśli usługa to potrafi; starsza odpowiada dopiero po zakończeniu. */
  startRun(caseId: string, connectors?: string[], options?: RunOptions): Promise<RunHandle>;
  /** Postęp analizy; `null`, gdy usługa nie udostępnia tej trasy. */
  getProgress(runId: string): Promise<RunProgress | null>;
  getAi(): Promise<AiStatus | null>;
  getCorpusStats(): Promise<CorpusStats | null>;
  getRun(runId: string): Promise<AnalysisRun>;
  getDiff(caseId: string, from: string, to: string): Promise<RunDiff>;
  getReplacements(runId: string): Promise<Replacement[]>;
  /** Teczka z usługi; `null`, gdy trasa nie istnieje (starsza wersja usługi). */
  getCaseDossier(caseId: string): Promise<Dossier | null>;
  getRunDossier(runId: string): Promise<Dossier | null>;
  addDecision(caseId: string, input: DecisionInput): Promise<AnalystDecision>;
  removeDecision(caseId: string, decisionId: string): Promise<void>;
  getOverview(): Promise<Overview>;
  startSweep(connectors: string[], limit: number): Promise<Sweep>;
  listSweeps(): Promise<Sweep[]>;
  getSweep(sweepId: string): Promise<Sweep>;
  createCaseFromLead(sweepId: string, leadId: string): Promise<CaseSummary>;
  getMonitor(): Promise<MonitorStatus>;
  updateMonitor(settings: MonitorSettings): Promise<MonitorStatus>;
  runMonitor(): Promise<{ status: MonitorStatus; newHits: number }>;
  /** Przelicza zapisane trafienia bieżącymi regułami; niespełniające kryteriów stają się odrzucone. */
  recheckMonitor(): Promise<RecheckResult>;
  listHits(limit: number): Promise<WatchHit[]>;
  analyzeHit(hitId: string): Promise<WatchHit>;
  dismissHit(hitId: string): Promise<WatchHit>;
  createCaseFromHit(hitId: string): Promise<CaseSummary>;
  /** Ustalenie jednym wywołaniem; `null`, gdy trasa nie istnieje. */
  quick(value: string, type: IdentifierType, options?: RunOptions): Promise<QuickResult | null>;
  /** Czy usługa wystawia „Materiał do zapytania” dla usługi powiązanej z podmiotem. */
  hasServiceRequest(runId: string, serviceId: string): Promise<boolean>;
  /** Zapisuje odpowiedź usługi (dokument spoza OSINT); usługa analizy maskuje identyfikator klienta i numer rachunku. */
  addServiceReply(caseId: string, body: ServiceReplyBody): Promise<ServiceReply>;
  /** Wycofuje odpowiedź usługi — wpis zostaje w rejestrze, wynik wraca do stanu sprzed odpowiedzi. */
  withdrawServiceReply(caseId: string, replyId: string): Promise<void>;
  /** Przykładowa, syntetyczna odpowiedź z piaskownicy — pobierana przez usługę analizy, nigdy wprost z przeglądarki. */
  getServiceReplySample(caseId: string, serviceId: string, variant?: 'inna-osoba'): Promise<ServiceReplySample>;
  /** Obserwacja sprawy („Monitoruj”): włączenie z odstępem i trybem albo wyłączenie (`null`). */
  setWatch(caseId: string, settings: WatchSettings): Promise<CaseSummary>;
  /** Obserwowane sprawy ze zmianami; `null`, gdy usługa nie udostępnia tej trasy (wymaga nowszej wersji). */
  listWatched(): Promise<WatchList | null>;
  /** „Odśwież teraz”: analiza obserwowanej sprawy od razu, w tle. */
  refreshWatched(caseId: string): Promise<RunHandle>;
  /** Sieć sprawy (teczka + rozwinięcia) i historia rozwinięć; `null`, gdy usługa nie zna tej trasy albo sprawa nie ma analizy. */
  getNetwork(caseId: string): Promise<NetworkView | null>;
  /** Dostępne drogi rozwinięcia węzła (grupy relacji, koszt, podstawa prawna); `null` bez tej trasy. */
  getNetworkPlan(caseId: string, nodeId: string): Promise<NetworkPlan | null>;
  /** „Rozwiń”: uruchamia ekspandery dla węzła i zapisuje rozwinięcie. */
  expandNetwork(caseId: string, request: ExpandRequest): Promise<ExpandResult>;
  /** Wycofuje rozwinięcie — wpis zostaje w historii (audyt). */
  withdrawExpansion(caseId: string, expansionId: string): Promise<void>;
  /** Zamyka sprawę z powodem — sprawa staje się tylko do odczytu. */
  closeCase(caseId: string, reason: string): Promise<CaseSummary>;
  /** Przywraca zamkniętą lub zarchiwizowaną sprawę. */
  reopenCase(caseId: string): Promise<CaseSummary>;
  /** Tworzy archiwum zamkniętej sprawy (ZIP z manifestem) do pobrania. */
  archiveCase(caseId: string): Promise<CaseArchive>;
  /** Powiązania sprawy z innymi sprawami (czy można ją usunąć). */
  getCaseLinks(caseId: string): Promise<CaseLinks>;
  /** Usuwa zamkniętą, niepowiązaną sprawę; `confirm` = dokładna nazwa sprawy. */
  deleteCase(caseId: string, confirm: string): Promise<void>;
  /** Stan zabezpieczeń usługi; `null`, gdy usługa nie zna tej trasy. */
  getSecurityStatus(): Promise<SecurityStatus | null>;
  /** Podgląd retencji (co zostałoby usunięte i dlaczego); `null` bez tej trasy. */
  getRetentionPreview(): Promise<RetentionPreview | null>;
  /** Dziennik audytu (całość albo jednej sprawy); `null` bez tej trasy. */
  listAudit(caseId?: string): Promise<AuditEntry[] | null>;
  /** Tryb danych nowych analiz; `null`, gdy usługa nie ma przełącznika (starsza wersja, tryb DEMO). */
  getDataMode(): Promise<DataModeSetting | null>;
  /** Przełącza tryb danych bez restartu usługi — od następnej analizy. */
  setDataMode(mode: DataMode): Promise<DataModeSetting>;
}

export class ApiError extends Error {
  readonly status: number;
  /** Pełna treść odpowiedzi z błędem (np. lista powiązanych spraw przy odmowie usunięcia). */
  readonly body?: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const isDemo =
  new URLSearchParams(location.search).get('demo') === '1' || import.meta.env.VITE_DEMO === '1';

const UNAVAILABLE = 'Brak połączenia z usługą analizy (API). Sprawdź, czy serwer działa na porcie 4000.';

/** Wyciąga komunikat z odpowiedzi `{ error }`; gdy go brak — opis na podstawie kodu HTTP. */
function errorFromBody(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === 'string' && error) return error;
  const nested = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof nested === 'string' && nested) return nested;
  if (status === 404) return 'Nie znaleziono żądanego zasobu (HTTP 404).';
  // Proxy Vite odpowiada 500 bez treści JSON, gdy API nie działa.
  if (body === null && status >= 500) return UNAVAILABLE;
  return `Usługa analizy zwróciła błąd (HTTP ${status}).`;
}

async function send(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...authHeaders(), ...init?.headers } });
  } catch {
    throw new ApiError(UNAVAILABLE, 0);
  }
  const body: unknown = await response.json().catch(() => null);
  // Usługa z włączonym tokenem: okno logowania prosi o token.
  if (response.status === 401) requestToken();
  if (!response.ok) throw new ApiError(errorFromBody(body, response.status), response.status, body);
  return { status: response.status, body };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { status, body } = await send(path, init);
  if (body === null) throw new ApiError('Usługa analizy zwróciła odpowiedź w nieoczekiwanym formacie.', status);
  return body as T;
}

const post = <T>(path: string, payload: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const missingRoute = (error: unknown) => error instanceof ApiError && [404, 405, 501].includes(error.status);

/** Trasa opcjonalna: jej brak daje wartość zastępczą zamiast błędu. */
async function optional<T, F>(promise: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await promise;
  } catch (error) {
    if (missingRoute(error)) return fallback;
    throw error;
  }
}

/** Trasa z etapu 2: jej brak zgłaszamy czytelnie jako funkcję niedostępną. */
async function feature<T>(name: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (missingRoute(error)) {
      throw new ApiError(`${name}: funkcja niedostępna w tej wersji usługi analizy.`, (error as ApiError).status);
    }
    throw error;
  }
}

const enc = encodeURIComponent;

async function overviewFromCases(): Promise<Overview> {
  const cases = await httpBackend.listCases();
  return {
    cases: cases.length,
    runs: cases.reduce((total, item) => total + item.runs.length, 0),
    linkedAddresses: cases.reduce((total, item) => total + (item.runs.at(-1)?.findingCount ?? 0), 0),
    cashOutPlnByYear: {},
    topCases: cases
      .map((item) => {
        const topScore = item.runs.at(-1)?.topScore ?? 0;
        return { caseId: item.id, name: item.name, priority: topScore, topScore, cashOutPlnTotal: 0 };
      })
      .sort((a, b) => b.priority - a.priority),
    approximate: true,
  };
}

/** Archiwum sprawy: odpowiedź binarna (ZIP), nazwa pliku i skrót SHA-256 z nagłówków. */
async function downloadArchive(caseId: string): Promise<CaseArchive> {
  let response: Response;
  try {
    response = await fetch(`/api/cases/${enc(caseId)}/archive`, { method: 'POST', headers: { Accept: 'application/zip', ...authHeaders() } });
  } catch {
    throw new ApiError(UNAVAILABLE, 0);
  }
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 401) requestToken();
    throw new ApiError(errorFromBody(body, response.status), response.status, body);
  }
  const disposition = response.headers.get('Content-Disposition') ?? '';
  const fileName = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `olcys-archiwum-${caseId}.zip`;
  return { blob: await response.blob(), fileName, sha256: response.headers.get('X-Olcys-Archive-Sha256') ?? '' };
}

const httpBackend: Backend = {
  listConnectors: () => request('/api/connectors'),
  getRules: () => request('/api/rules'),
  getPriorityRules: () => optional(request<unknown>('/api/priority-rules'), null),
  listCases: () => request('/api/cases'),
  createCase: (name, identifiers) => post('/api/cases', { name, identifiers }),
  getCase: (caseId) => request(`/api/cases/${enc(caseId)}`),
  addIdentifiers: (caseId, identifiers) =>
    feature('Dopisanie identyfikatorów', post(`/api/cases/${enc(caseId)}/identifiers`, { identifiers })),
  startRun: (caseId, connectors, options = {}) =>
    post(`/api/cases/${enc(caseId)}/runs`, { ...(connectors ? { connectors } : {}), depth: options.depth ?? DEFAULT_DEPTH, ...(options.period ? { period: options.period } : {}), ...(options.dataMode ? { dataMode: options.dataMode } : {}), async: true }),
  getProgress: (runId) => optional(request<RunProgress>(`/api/runs/${enc(runId)}/progress`), null),
  getAi: () => optional(request<AiStatus>('/api/ai'), null),
  getCorpusStats: () => optional(request<CorpusStats>('/api/corpus/stats'), null),
  getRun: (runId) => request(`/api/runs/${enc(runId)}`),
  getDiff: (caseId, from, to) => request(`/api/cases/${enc(caseId)}/diff?from=${enc(from)}&to=${enc(to)}`),
  getReplacements: async (runId) => {
    const result = await optional(request<unknown>(`/api/runs/${enc(runId)}/replacements`), []);
    return Array.isArray(result) ? (result as Replacement[]) : [];
  },
  getCaseDossier: (caseId) => optional(request<Dossier>(`/api/cases/${enc(caseId)}/dossier`), null),
  getRunDossier: (runId) => optional(request<Dossier>(`/api/runs/${enc(runId)}/dossier`), null),
  addDecision: (caseId, input) => feature('Decyzje analityka', post(`/api/cases/${enc(caseId)}/decisions`, input)),
  removeDecision: async (caseId, decisionId) => {
    await feature('Decyzje analityka', send(`/api/cases/${enc(caseId)}/decisions/${enc(decisionId)}`, { method: 'DELETE' }));
  },
  getOverview: async () => (await optional(request<Overview>('/api/overview'), null)) ?? overviewFromCases(),
  startSweep: (connectors, limit) => feature('Przegląd źródeł', post('/api/sweeps', { connectors, limit })),
  listSweeps: () => feature('Przegląd źródeł', request('/api/sweeps')),
  getSweep: (sweepId) => feature('Przegląd źródeł', request(`/api/sweeps/${enc(sweepId)}`)),
  createCaseFromLead: (sweepId, leadId) =>
    feature('Założenie sprawy ze wskazania', post(`/api/sweeps/${enc(sweepId)}/leads/${enc(leadId)}/case`, {})),
  getMonitor: () => feature('Monitoring', request('/api/monitor')),
  updateMonitor: (settings) =>
    feature('Monitoring', request('/api/monitor', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) })),
  runMonitor: () => feature('Monitoring', post('/api/monitor/run', {})),
  recheckMonitor: () => feature('Przeliczenie trafień', post('/api/monitor/recheck', {})),
  listHits: (limit) => feature('Monitoring', request(`/api/monitor/hits?limit=${limit}`)),
  analyzeHit: (hitId) => feature('Analiza autora trafienia', post(`/api/monitor/hits/${enc(hitId)}/analyze`, {})),
  dismissHit: (hitId) => feature('Odrzucenie trafienia', post(`/api/monitor/hits/${enc(hitId)}/dismiss`, {})),
  createCaseFromHit: (hitId) => feature('Założenie sprawy z trafienia', post(`/api/monitor/hits/${enc(hitId)}/case`, {})),
  quick: (value, type, options = {}) =>
    optional(post<QuickResult>('/api/quick', { value, type, depth: options.depth ?? DEFAULT_DEPTH, ...(options.period ? { period: options.period } : {}), ...(options.dataMode ? { dataMode: options.dataMode } : {}), async: true }), null),
  hasServiceRequest: async (runId, serviceId) => {
    try {
      const response = await fetch(serviceRequestUrl(runId, serviceId), { method: 'HEAD' });
      return response.ok;
    } catch {
      return false;
    }
  },
  addServiceReply: (caseId, body) => feature('Odpowiedzi usług', post(`/api/cases/${enc(caseId)}/service-replies`, body)),
  withdrawServiceReply: async (caseId, replyId) => {
    await feature('Odpowiedzi usług', send(`/api/cases/${enc(caseId)}/service-replies/${enc(replyId)}`, { method: 'DELETE' }));
  },
  getServiceReplySample: (caseId, serviceId, variant) =>
    request(`/api/cases/${enc(caseId)}/service-replies/sandbox-sample?service=${enc(serviceId)}${variant ? `&variant=${enc(variant)}` : ''}`),
  // Tryb wysyłany tylko, gdy różni się od domyślnego trybu obserwacji (głębokiego) — starsza usługa nie zna tego pola.
  setWatch: (caseId, settings) =>
    feature(
      'Monitorowanie spraw',
      settings
        ? post<CaseSummary>(`/api/cases/${enc(caseId)}/schedule`, { everyMinutes: settings.everyMinutes, ...(settings.depth && settings.depth !== 'deep' ? { depth: settings.depth } : {}) })
        : request<CaseSummary>(`/api/cases/${enc(caseId)}/schedule`, { method: 'DELETE' }),
    ),
  listWatched: () => optional(request<WatchList>('/api/watch'), null),
  refreshWatched: (caseId) => feature('Odświeżenie obserwowanej sprawy', post(`/api/cases/${enc(caseId)}/schedule/run`, {})),
  getNetwork: (caseId) => withoutAnalysis(optional(request<NetworkView>(`/api/cases/${enc(caseId)}/network`), null)),
  getNetworkPlan: (caseId, nodeId) => withoutAnalysis(optional(request<NetworkPlan>(`/api/cases/${enc(caseId)}/network/plan?nodeId=${enc(nodeId)}`), null)),
  expandNetwork: (caseId, body) => feature('Rozwijanie sieci', post(`/api/cases/${enc(caseId)}/network/expand`, body)),
  withdrawExpansion: async (caseId, expansionId) => {
    await feature('Rozwijanie sieci', send(`/api/cases/${enc(caseId)}/network/expand/${enc(expansionId)}`, { method: 'DELETE' }));
  },
  closeCase: (caseId, reason) => feature('Zamknięcie sprawy', post(`/api/cases/${enc(caseId)}/close`, { reason })),
  reopenCase: (caseId) => feature('Przywrócenie sprawy', post(`/api/cases/${enc(caseId)}/reopen`, {})),
  archiveCase: (caseId) => feature('Archiwum sprawy', downloadArchive(caseId)),
  getCaseLinks: (caseId) => feature('Powiązania sprawy', request(`/api/cases/${enc(caseId)}/links`)),
  deleteCase: async (caseId, confirm) => {
    await feature(
      'Usunięcie sprawy',
      send(`/api/cases/${enc(caseId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm }) }),
    );
  },
  getSecurityStatus: () => optional(request<SecurityStatus>('/api/security/status'), null),
  getRetentionPreview: () => optional(request<RetentionPreview>('/api/retention/preview'), null),
  listAudit: async (caseId) => {
    const result = await optional(request<{ entries: AuditEntry[] }>(`/api/audit${caseId ? `?caseId=${enc(caseId)}` : ''}`), null);
    return result ? result.entries : null;
  },
  getDataMode: () => optional(request<DataModeSetting>('/api/settings/data-mode'), null),
  setDataMode: (mode) =>
    feature(
      'Przełączanie trybu danych',
      request<DataModeSetting>('/api/settings/data-mode', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataMode: mode }) }),
    ),
};

/** Sprawa bez zakończonej analizy (409) nie ma jeszcze sieci — to stan, nie błąd. */
async function withoutAnalysis<T>(promise: Promise<T | null>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return null;
    throw error;
  }
}

// Dane demo ładowane są leniwie, żeby nie trafiały do głównej paczki.
const backend: Promise<Backend> = isDemo
  ? import('./demo-backend.ts').then((module) => module.demoBackend)
  : Promise.resolve(httpBackend);

export const api = new Proxy({} as Backend, {
  get:
    (_, method: keyof Backend) =>
    (...args: unknown[]) =>
      backend.then((resolved) => (resolved[method] as (...input: unknown[]) => unknown)(...args)),
});

/**
 * Stan usługi analizy (`GET /api/health`) — źródło znaczka trybu LIVE / SANDBOX.
 * Tryb demo nie pyta usługi: jego dane są wbudowane w interfejs. Błąd daje `null` („tryb nieustalony”),
 * nigdy dane zastępcze.
 */
export async function fetchHealth(): Promise<unknown | null> {
  if (isDemo) return null;
  try {
    return (await send('/api/health')).body;
  } catch {
    return null;
  }
}

export const reportHtmlUrl = (runId: string) => `/api/runs/${enc(runId)}/report.html`;
export const reportJsonUrl = (runId: string) => `/api/runs/${enc(runId)}/report.json`;
export const serviceRequestUrl = (runId: string, serviceId: string) =>
  `/api/runs/${enc(runId)}/service-request/${enc(serviceId)}.html`;

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Wystąpił nieoczekiwany błąd.';
}

// ---------- Operacje złożone ----------

export interface DossierView {
  dossier: FullDossier;
  summary: CaseSummary;
  /** Teczka zbudowana w interfejsie z samej analizy — starsza wersja usługi. */
  simplified: boolean;
}

/** Uzupełnia pola, których starsze wersje usługi nie zwracają. */
function complete(dossier: Dossier): FullDossier {
  const partial = dossier as Partial<FullDossier>;
  return {
    ...dossier,
    // Usługa zapisuje brak wyceny jako null; w interfejsie brak wartości to undefined.
    serviceLinks: (partial.serviceLinks ?? serviceLinksFromFindings(dossier.findings)).map((link) => ({
      ...link,
      outPln: link.outPln ?? undefined,
      inPln: link.inPln ?? undefined,
      transfers: link.transfers.map((item) => ({ ...item, valuePln: item.valuePln ?? undefined, viaAddress: item.viaAddress ?? undefined })),
    })),
    persons: partial.persons ?? [],
    relatedPersons: partial.relatedPersons ?? [],
    decisions: partial.decisions ?? [],
    keyFindings: partial.keyFindings ?? [],
    timeline: partial.timeline ?? [],
    cashOutProof: partial.cashOutProof ?? [],
    explanations: partial.explanations ?? [],
    unconfirmedAddresses: partial.unconfirmedAddresses ?? [],
    linkedIdentities: partial.linkedIdentities ?? [],
    mentions: partial.mentions ?? [],
    // Brak pola = starsza usługa bez rejestru odpowiedzi usług; formularz nie jest wtedy pokazywany.
    ...(Array.isArray(partial.serviceReplies) ? { serviceReplies: partial.serviceReplies } : {}),
    graph: { nodes: partial.graph?.nodes ?? [], edges: partial.graph?.edges ?? [] },
  };
}

/** Teczka sprawy (ostatnia zakończona analiza) albo wskazanej analizy; ze starszym API — składana lokalnie. */
export async function loadDossier(source: { caseId: string } | { runId: string }): Promise<DossierView | { summary: CaseSummary }> {
  let run: AnalysisRun | undefined;
  let summary: CaseSummary;
  if ('runId' in source) {
    run = await api.getRun(source.runId);
    summary = await api.getCase(run.caseId);
  } else {
    summary = await api.getCase(source.caseId);
    if (!summary.runs.some((item) => item.status === 'completed')) return { summary };
  }
  const fromApi = 'runId' in source ? await api.getRunDossier(source.runId) : await api.getCaseDossier(summary.id);
  if (fromApi) return { dossier: complete(fromApi), summary, simplified: false };

  run ??= await api.getRun(summary.runs.filter((item) => item.status === 'completed').at(-1)!.id);
  const replacements = await api.getReplacements(run.id).catch(() => []);
  return { dossier: dossierFromRun(run, { name: summary.name, replacements }), summary, simplified: true };
}

/** „Kogo sprawdzić?”: sprawa, analiza i teczka z jednego identyfikatora. */
const periods = new Map<string, Promise<Period | undefined>>();

/**
 * Okres wskazany przy uruchomieniu analizy. Analizy uruchomione w tej karcie znamy od razu;
 * dla pozostałych pytamy usługę najwyżej raz i zapamiętujemy odpowiedź.
 */
export function runPeriod(runId: string): Promise<Period | undefined> {
  let known = periods.get(runId);
  if (!known) {
    known = api.getRun(runId).then(
      (run) => (run as { period?: Period }).period,
      () => undefined,
    );
    periods.set(runId, known);
  }
  return known;
}

const POLL_MS = 1500;

/** Czeka na zakończenie analizy w tle, przekazując kolejne stany postępu. */
export async function trackRun(runId: string, onProgress: (progress: RunProgress) => void): Promise<void> {
  for (;;) {
    const progress = await api.getProgress(runId);
    if (!progress) {
      // Usługa bez trasy postępu: wystarczy stan samej analizy.
      const run = await api.getRun(runId);
      if (run.status === 'failed') throw new ApiError('Analiza zakończyła się błędem — szczegóły w dzienniku analizy.', 500);
      if (run.status !== 'running') return;
    } else {
      onProgress(progress);
      if (progress.status === 'failed') throw new ApiError(progress.error ?? 'Analiza zakończyła się błędem.', 500);
      if (progress.status === 'completed') return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** Analiza istniejącej sprawy z ekranem postępu; obsługuje też odpowiedź synchroniczną starszej usługi. */
export async function runAnalysis(
  caseId: string,
  connectors: string[] | undefined,
  options: RunOptions,
  onProgress: (progress: RunProgress) => void,
): Promise<void> {
  const run = await api.startRun(caseId, connectors, options);
  periods.set(run.id, Promise.resolve(options.period));
  if (run.status === 'running') await trackRun(run.id, onProgress);
  else if (run.status === 'failed') throw new ApiError('Analiza zakończyła się błędem — szczegóły w dzienniku analizy.', 500);
}

/** „Kogo sprawdzić?”: sprawa, analiza i teczka z jednego identyfikatora. */
export async function quickCheck(
  raw: string,
  type: IdentifierType,
  options: RunOptions,
  onProgress: (progress: RunProgress) => void,
): Promise<CaseSummary> {
  const identifier = normalizeIdentifier(type, raw);
  const quick = await api.quick(identifier.value, type, options);
  if (quick) {
    if (quick.run) periods.set(quick.run.id, Promise.resolve(options.period));
    if (quick.run?.status === 'running') await trackRun(quick.run.id, onProgress);
    return quick.case;
  }
  const created = await api.createCase(suggestCaseName(identifier), [identifier]);
  await runAnalysis(created.id, undefined, options, onProgress);
  return created;
}
