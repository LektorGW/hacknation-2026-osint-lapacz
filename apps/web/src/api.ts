// Warstwa dostępu do API zgodna z kontraktem z docs/ARCHITEKTURA.md.
// W trybie demo (`?demo=1` lub VITE_DEMO=1) dane pochodzą z `demo-backend.ts`.
import type { AnalysisRun, Identifier, RunDiff, ScoreRules, SourceConnector, SubjectQuery } from '@olcys/core';

export type ConnectorInfo = Pick<
  SourceConnector,
  'id' | 'service' | 'label' | 'description' | 'accepts' | 'enabledByDefault'
>;

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

export type Replacement = RunDiff['replacedAddresses'][number];

export interface Backend {
  listConnectors(): Promise<ConnectorInfo[]>;
  getRules(): Promise<ScoreRules>;
  listCases(): Promise<CaseSummary[]>;
  createCase(name: string, identifiers: Identifier[]): Promise<CaseSummary>;
  getCase(caseId: string): Promise<CaseSummary>;
  startRun(caseId: string, connectors: string[]): Promise<AnalysisRun>;
  getRun(runId: string): Promise<AnalysisRun>;
  getDiff(caseId: string, from: string, to: string): Promise<RunDiff>;
  getReplacements(runId: string): Promise<Replacement[]>;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: { Accept: 'application/json', ...init?.headers } });
  } catch {
    throw new ApiError(UNAVAILABLE, 0);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(errorFromBody(body, response.status), response.status);
  if (body === null) {
    throw new ApiError('Usługa analizy zwróciła odpowiedź w nieoczekiwanym formacie.', response.status);
  }
  return body as T;
}

const post = <T>(path: string, payload: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const enc = encodeURIComponent;

const httpBackend: Backend = {
  listConnectors: () => request('/api/connectors'),
  getRules: () => request('/api/rules'),
  listCases: () => request('/api/cases'),
  createCase: (name, identifiers) => post('/api/cases', { name, identifiers }),
  getCase: (caseId) => request(`/api/cases/${enc(caseId)}`),
  startRun: (caseId, connectors) => post(`/api/cases/${enc(caseId)}/runs`, { connectors }),
  getRun: (runId) => request(`/api/runs/${enc(runId)}`),
  getDiff: (caseId, from, to) => request(`/api/cases/${enc(caseId)}/diff?from=${enc(from)}&to=${enc(to)}`),
  // Trasa jest opcjonalna: jej brak (404) oznacza po prostu brak podmian.
  getReplacements: async (runId) => {
    try {
      const result = await request<unknown>(`/api/runs/${enc(runId)}/replacements`);
      return Array.isArray(result) ? (result as Replacement[]) : [];
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return [];
      throw error;
    }
  },
};

// Dane demo ładowane są leniwie, żeby nie trafiały do głównej paczki.
const backend: Promise<Backend> = isDemo
  ? import('./demo-backend.ts').then((module) => module.demoBackend)
  : Promise.resolve(httpBackend);

export const api: Backend = {
  listConnectors: () => backend.then((b) => b.listConnectors()),
  getRules: () => backend.then((b) => b.getRules()),
  listCases: () => backend.then((b) => b.listCases()),
  createCase: (name, identifiers) => backend.then((b) => b.createCase(name, identifiers)),
  getCase: (caseId) => backend.then((b) => b.getCase(caseId)),
  startRun: (caseId, connectors) => backend.then((b) => b.startRun(caseId, connectors)),
  getRun: (runId) => backend.then((b) => b.getRun(runId)),
  getDiff: (caseId, from, to) => backend.then((b) => b.getDiff(caseId, from, to)),
  getReplacements: (runId) => backend.then((b) => b.getReplacements(runId)),
};

export const reportHtmlUrl = (runId: string) => `/api/runs/${enc(runId)}/report.html`;
export const reportJsonUrl = (runId: string) => `/api/runs/${enc(runId)}/report.json`;

export function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Wystąpił nieoczekiwany błąd.';
}
