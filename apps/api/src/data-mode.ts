// Tryb danych analiz: dane syntetyczne (piaskownica, laboratorium tożsamości), prawdziwe źródła
// publiczne albo oba naraz. Ustawienie jest trwałe (zapisane w bazie) i zmienia się bez restartu
// serwera — dotyczy NOWYCH analiz; wcześniejsze zachowują tryb, w którym je wykonano.
//
// Podział łączników i dostawców danych blockchain po identyfikatorze:
//  - syntetyczne: `sandbox-*` (piaskownica, w tym `sandbox-explorer`) i `lab-*` (laboratorium, w tym `lab-chain`);
//  - lokalne: indeks własny i migawki rejestrów — działają bez sieci, więc są w każdym trybie;
//  - prawdziwe: wszystko pozostałe (źródła w internecie, eksploratory, Tor).

import { HttpError } from './http-common.ts';
import type { Storage } from './storage.ts';

export type DataMode = 'synthetic' | 'live' | 'both';

export const DATA_MODES: readonly DataMode[] = ['synthetic', 'live', 'both'];

/** Rodzina źródła: syntetyczne, lokalne (bez sieci, w każdym trybie) albo prawdziwe publiczne. */
export type SourceFamily = 'synthetic' | 'local' | 'live';

/** Łączniki działające wyłącznie na danych lokalnych: indeks własny, migawki rejestrów publicznych, listy sankcyjne. */
export const LOCAL_SOURCE_IDS: ReadonlySet<string> = new Set(['corpus', 'rejestry-publiczne', 'listy-sankcyjne']);

/** Klucz dokumentu ustawień w bazie (tabela ustawień dokumentowych, `getConfig`/`saveConfig`). */
export const DATA_MODE_CONFIG_ID = 'data-mode';

export const DATA_MODE_LABELS: Record<DataMode, string> = {
  synthetic: 'Dane syntetyczne (piaskownica i laboratorium) — bez zapytań do prawdziwych serwisów.',
  live: 'Prawdziwe źródła publiczne w internecie.',
  both: 'Prawdziwe źródła publiczne oraz dane syntetyczne — wyniki ze źródeł syntetycznych są oznaczone.',
};

export function sourceFamily(id: string): SourceFamily {
  if (id.startsWith('sandbox-') || id.startsWith('lab-')) return 'synthetic';
  if (LOCAL_SOURCE_IDS.has(id)) return 'local';
  return 'live';
}

/** Czy łącznik albo dostawca o danym identyfikatorze należy do trybu. Źródła lokalne należą do każdego. */
export function inDataMode(id: string, mode: DataMode): boolean {
  const family = sourceFamily(id);
  if (family === 'local' || mode === 'both') return true;
  return family === mode;
}

/** Zostawia tylko łączniki lub dostawców należących do trybu (kolejność bez zmian). */
export function filterByDataMode<T extends { id: string }>(items: readonly T[], mode: DataMode): T[] {
  return items.filter((item) => inDataMode(item.id, mode));
}

export function parseDataMode(value: unknown): DataMode | null {
  return typeof value === 'string' && (DATA_MODES as readonly string[]).includes(value) ? (value as DataMode) : null;
}

/** Które rodziny danych są zarejestrowane w tym uruchomieniu serwera. */
export interface DataModeAvailability {
  synthetic: boolean;
  live: boolean;
}

export function dataModeAvailability(ids: Iterable<string>): DataModeAvailability {
  const result = { synthetic: false, live: false };
  for (const id of ids) {
    const family = sourceFamily(id);
    if (family === 'synthetic') result.synthetic = true;
    if (family === 'live') result.live = true;
  }
  return result;
}

export function isDataModeAvailable(mode: DataMode, available: DataModeAvailability): boolean {
  if (mode === 'both') return available.synthetic && available.live;
  return available[mode];
}

/**
 * Tryb bez zapisanego ustawienia — taki sam wybór źródeł jak przed wprowadzeniem przełącznika:
 * obie rodziny zarejestrowane → oba; tylko prawdziwe → prawdziwe; w pozostałych przypadkach syntetyczne.
 */
export function defaultDataMode(available: DataModeAvailability): DataMode {
  if (available.synthetic && available.live) return 'both';
  if (available.live) return 'live';
  return 'synthetic';
}

/** Dlaczego tryb jest niedostępny — komunikat dla analityka i operatora. */
export function unavailableReason(mode: DataMode, available: DataModeAvailability): string | undefined {
  const missing: string[] = [];
  if ((mode === 'synthetic' || mode === 'both') && !available.synthetic) {
    missing.push('dane syntetyczne wymagają piaskownicy (SANDBOX_URL) albo laboratorium tożsamości (LAB_URL)');
  }
  if ((mode === 'live' || mode === 'both') && !available.live) {
    missing.push('prawdziwe źródła wymagają uruchomienia serwera z ENABLE_LIVE=1');
  }
  return missing.length > 0 ? `Tryb niedostępny: ${missing.join('; ')}.` : undefined;
}

/** Tryb analizy wykonanej przed wprowadzeniem przełącznika — odczytany z listy użytych łączników. */
export function dataModeFromConnectorIds(ids: readonly string[]): DataMode {
  const available = dataModeAvailability(ids);
  return available.live ? (available.synthetic ? 'both' : 'live') : 'synthetic';
}

/** Znacznik do list: SANDBOX dla danych syntetycznych, LIVE, gdy analiza pytała prawdziwe źródła. */
export function dataModeTag(mode: DataMode): 'SANDBOX' | 'LIVE' {
  return mode === 'synthetic' ? 'SANDBOX' : 'LIVE';
}

/** Zapisany dokument ustawienia. */
export interface StoredDataMode {
  dataMode: DataMode;
  updatedAt: string;
  updatedBy?: string;
}

export interface DataModeState {
  /** Tryb obowiązujący dla nowych analiz. */
  current(): DataMode;
  /** Zapisane ustawienie (także takie, którego to uruchomienie nie obsłuży); `null` przed pierwszą zmianą. */
  stored(): StoredDataMode | null;
  available(): DataModeAvailability;
  defaultMode(): DataMode;
  /** Zmienia tryb i zapisuje go w bazie; tryb niedostępny w tym uruchomieniu to błąd. */
  set(mode: DataMode, by?: string): Promise<StoredDataMode>;
  /** Tryb dla jednej analizy: z żądania (sprawdzony) albo bieżący. */
  resolve(requested?: unknown): DataMode;
}

/** Błąd wyboru trybu — odpowiedź 400 z komunikatem dla analityka. */
export class DataModeError extends HttpError {
  constructor(message: string) {
    super(400, message);
  }
}

/**
 * Stan przełącznika: wczytuje zapisane ustawienie z bazy. Gdy zapisany tryb nie jest dostępny
 * w tym uruchomieniu (np. serwer wystartował bez ENABLE_LIVE), obowiązuje tryb domyślny, a zapis zostaje.
 */
export async function createDataModeState(params: {
  storage: Pick<Storage, 'getConfig' | 'saveConfig'>;
  ids: Iterable<string>;
  now: () => Date;
}): Promise<DataModeState> {
  const available = dataModeAvailability(params.ids);
  const fallback = defaultDataMode(available);
  let stored: StoredDataMode | null = null;
  try {
    const raw = await params.storage.getConfig<StoredDataMode>(DATA_MODE_CONFIG_ID);
    const mode = parseDataMode(raw?.dataMode);
    if (raw && mode) stored = { ...raw, dataMode: mode };
  } catch {
    // Brak zapisu nie blokuje startu — obowiązuje tryb domyślny.
  }
  const current = (): DataMode => (stored && isDataModeAvailable(stored.dataMode, available) ? stored.dataMode : fallback);
  return {
    current,
    stored: () => (stored ? { ...stored } : null),
    available: () => ({ ...available }),
    defaultMode: () => fallback,
    async set(mode, by) {
      const reason = unavailableReason(mode, available);
      if (reason) throw new DataModeError(reason);
      const next: StoredDataMode = { dataMode: mode, updatedAt: params.now().toISOString(), ...(by ? { updatedBy: by } : {}) };
      await params.storage.saveConfig(DATA_MODE_CONFIG_ID, next);
      stored = next;
      return { ...next };
    },
    resolve(requested) {
      if (requested === undefined || requested === null) return current();
      const mode = parseDataMode(requested);
      if (!mode) throw new DataModeError(`Nieznany tryb danych „${String(requested)}”. Dozwolone: ${DATA_MODES.join(', ')}.`);
      // Tryb bieżący jest zawsze dozwolony — także domyślny przy braku obu rodzin źródeł.
      if (mode === current()) return mode;
      const reason = unavailableReason(mode, available);
      if (reason) throw new DataModeError(reason);
      return mode;
    },
  };
}
