// Rozdzielenie trybów pracy: DEMO (dane wbudowane w interfejs), SANDBOX (źródła i blockchain
// piaskownicy — dane syntetyczne) i LIVE (publiczne źródła). Czyste funkcje bez DOM.

export type AppMode = 'demo' | 'sandbox' | 'live' | 'unknown';

export interface ModeInfo {
  mode: AppMode;
  /** Krótka nazwa na znaczku. */
  short: string;
  /** Pełny opis widoczny obok nazwy. */
  description: string;
}

export const MODE_INFO: Record<AppMode, ModeInfo> = {
  demo: { mode: 'demo', short: 'DEMO', description: 'dane przykładowe wbudowane w interfejs, nie pochodzą ze źródeł' },
  sandbox: { mode: 'sandbox', short: 'SANDBOX', description: 'źródła i blockchain piaskownicy (dane syntetyczne)' },
  live: { mode: 'live', short: 'LIVE', description: 'publiczne źródła' },
  unknown: { mode: 'unknown', short: 'TRYB NIEUSTALONY', description: 'tryb nieustalony — usługa analizy nie podała, skąd pochodzą dane' },
};

/** Pełny napis znaczka trybu. */
export const modeText = (info: ModeInfo): string => (info.mode === 'unknown' ? 'tryb nieustalony' : `${info.short} — ${info.description}`);

/**
 * Tryb aplikacji. Wbudowany zastępnik API zawsze oznacza DEMO — bez względu na to, co odpowiada usługa.
 * W pozostałych przypadkach decyduje wyłącznie pole `mode` z `GET /api/health`; każda inna
 * odpowiedź (brak pola, nieznana wartość, błąd) to „tryb nieustalony” — nigdy nie zgadujemy LIVE.
 */
export function resolveMode(demoBackend: boolean, health: unknown): ModeInfo {
  if (demoBackend) return MODE_INFO.demo;
  const raw = (health as { mode?: unknown } | null | undefined)?.mode;
  const mode = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (mode === 'live' || mode === 'sandbox') return MODE_INFO[mode];
  return MODE_INFO.unknown;
}

// ---------- Tryb danych analiz (przełącznik usługi: GET/PUT /api/settings/data-mode) ----------

/** Tryb danych nowych analiz: dane syntetyczne, prawdziwe źródła publiczne albo oba naraz. Niezależny od DEMO. */
export type DataMode = 'synthetic' | 'live' | 'both';

export const DATA_MODES: readonly DataMode[] = ['synthetic', 'live', 'both'];

export const DATA_MODE_SHORT: Record<DataMode, string> = { synthetic: 'Syntetyczne', live: 'Prawdziwe', both: 'Oba' };

export const DATA_MODE_DESCRIPTION: Record<DataMode, string> = {
  synthetic: 'dane syntetyczne z piaskownicy i laboratorium — bez zapytań do prawdziwych serwisów',
  live: 'prawdziwe źródła publiczne w internecie',
  both: 'prawdziwe źródła publiczne oraz dane syntetyczne (oznaczone)',
};

/** Dlaczego tryb jest niedostępny — co ustawić przy uruchomieniu serwera. */
export const DATA_MODE_UNAVAILABLE: Record<DataMode, string> = {
  synthetic: 'Niedostępne: uruchom serwer z piaskownicą (SANDBOX_URL) albo laboratorium (LAB_URL).',
  live: 'Niedostępne: uruchom serwer z ENABLE_LIVE=1.',
  both: 'Niedostępne: wymaga piaskownicy (SANDBOX_URL) i ENABLE_LIVE=1 jednocześnie.',
};

/** Ostrzeżenie przed włączeniem prawdziwych źródeł. */
export const LIVE_CONFIRMATION = 'Nowe analizy będą odpytywać publiczne źródła w internecie.';

export interface DataModeStatus {
  current: DataMode;
  available: Record<DataMode, boolean>;
}

export const parseDataMode = (value: unknown): DataMode | undefined =>
  typeof value === 'string' && (DATA_MODES as readonly string[]).includes(value) ? (value as DataMode) : undefined;

/** Stan przełącznika z `GET /api/health` (`dataMode`, `dataModesAvailable`); starsza usługa go nie podaje — `null`. */
export function dataModeStatus(health: unknown): DataModeStatus | null {
  const body = (health ?? {}) as { dataMode?: unknown; dataModesAvailable?: Record<string, unknown> };
  const current = parseDataMode(body.dataMode);
  if (!current) return null;
  const flags = body.dataModesAvailable ?? {};
  const available = Object.fromEntries(DATA_MODES.map((mode) => [mode, flags[mode] === true || mode === current])) as Record<DataMode, boolean>;
  return { current, available };
}

/** Czy zmiana trybu włącza prawdziwe źródła, których dotąd nie było — wtedy interfejs prosi o potwierdzenie. */
export const needsLiveConfirmation = (from: DataMode, to: DataMode): boolean => from === 'synthetic' && to !== 'synthetic';

/** Znacznik analizy na listach: SANDBOX (dane syntetyczne) albo LIVE; brak dla analiz sprzed przełącznika. */
export function runDataModeTag(run: { dataMode?: unknown } | undefined): 'SANDBOX' | 'LIVE' | undefined {
  const mode = parseDataMode(run?.dataMode);
  return mode ? (mode === 'synthetic' ? 'SANDBOX' : 'LIVE') : undefined;
}

/** Łączniki działające bez sieci (indeks własny, migawki rejestrów) — należą do każdego trybu, jak w usłudze. */
const LOCAL_CONNECTORS = new Set(['corpus', 'rejestry-publiczne', 'listy-sankcyjne']);

/** Czy łącznik weźmie udział w analizie w danym trybie (ta sama reguła co w usłudze: apps/api/src/data-mode.ts). */
export function connectorInDataMode(id: string, mode: DataMode): boolean {
  if (mode === 'both' || LOCAL_CONNECTORS.has(id)) return true;
  const synthetic = SYNTHETIC_CONNECTOR_PREFIXES.some((prefix) => id.startsWith(prefix));
  return mode === 'synthetic' ? synthetic : !synthetic;
}

/** Przedrostki identyfikatorów łączników piaskownicy i laboratorium (packages/sources: sandbox.ts, lab.ts). */
const SYNTHETIC_CONNECTOR_PREFIXES = ['sandbox-', 'lab-'];
/** Końcówki nazw usług syntetycznych: `<serwis>.sandbox`, `<portal>.lab.test`. */
const SYNTHETIC_SERVICE = /(^|\.)(sandbox|lab\.test)$/i;

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

export interface SourceRef {
  connectorId?: string;
  service?: string;
  url?: string;
  network?: string;
}

/**
 * Czy ślad pochodzi z łącznika piaskownicy lub laboratorium (dane syntetyczne).
 * `syntheticConnectors` to identyfikatory oznaczone przez usługę w `GET /api/health`, jeśli je podaje.
 */
export function isSyntheticSource(source: SourceRef, syntheticConnectors: ReadonlySet<string> = new Set()): boolean {
  const connector = source.connectorId?.toLowerCase();
  if (connector && (syntheticConnectors.has(connector) || SYNTHETIC_CONNECTOR_PREFIXES.some((prefix) => connector.startsWith(prefix)))) return true;
  if (source.service && SYNTHETIC_SERVICE.test(source.service.trim())) return true;
  if (source.network === 'lab') return true;
  const host = source.url ? hostOf(source.url) : undefined;
  // Lokalny eksplorator lub serwis (piaskownica na localhost) nigdy nie jest źródłem publicznym.
  return host !== undefined && (SYNTHETIC_SERVICE.test(host) || LOCAL_HOSTS.has(host));
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
const SYNTHETIC_WORDING = /sandbox|piaskownic|syntetyczn|laborator/i;

/** Czy dane blockchain adresu pochodzą z eksploratora piaskownicy albo sieci laboratoryjnej. */
export function isSyntheticChain(chain: { profile?: { network?: string; classificationSource?: string }; transfers?: { explorerUrl?: string }[] } | undefined, network?: string): boolean {
  if (network === 'lab' || chain?.profile?.network === 'lab') return true;
  if (!chain) return false;
  if (chain.profile?.classificationSource && SYNTHETIC_WORDING.test(chain.profile.classificationSource)) return true;
  return (chain.transfers ?? []).some((item) => item.explorerUrl !== undefined && isSyntheticSource({ url: item.explorerUrl }));
}

/**
 * Identyfikatory łączników oznaczonych przez usługę jako syntetyczne. Kształt odpowiedzi może się różnić,
 * więc czytamy ostrożnie: tablica `{ id, synthetic | mode | kind }` albo słownik `id → flaga/tryb`.
 */
export function syntheticConnectorIds(health: unknown): Set<string> {
  const result = new Set<string>();
  // `GET /api/health` podaje listy `sources` i `chainProviders` z polami `kind` i `demo`.
  const body = (health ?? {}) as { connectors?: unknown; sources?: unknown; chainProviders?: unknown };
  const lists = [body.sources, body.chainProviders].filter(Array.isArray).flat();
  const connectors = lists.length > 0 ? [...lists, ...(Array.isArray(body.connectors) ? body.connectors : [])] : body.connectors;
  const synthetic = (value: unknown): boolean => {
    if (value === true) return true;
    if (typeof value === 'string') return ['sandbox', 'lab', 'synthetic'].includes(value.toLowerCase());
    if (value && typeof value === 'object') {
      const item = value as Record<string, unknown>;
      return item.synthetic === true || item.demo === true || synthetic(item.mode) || synthetic(item.kind) || synthetic(item.origin);
    }
    return false;
  };
  if (Array.isArray(connectors)) {
    for (const item of connectors) {
      const id = (item as { id?: unknown } | null)?.id;
      if (typeof id === 'string' && synthetic(item)) result.add(id.toLowerCase());
    }
  } else if (connectors && typeof connectors === 'object') {
    for (const [id, value] of Object.entries(connectors)) if (synthetic(value)) result.add(id.toLowerCase());
  }
  return result;
}
