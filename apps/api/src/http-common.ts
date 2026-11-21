// Wspólne elementy tras HTTP: zależności aplikacji, schematy parametrów, błąd z kodem
// HTTP i kontekst przekazywany modułom z trasami. Osobny moduł, żeby `app.ts`
// i moduły tras nie importowały się nawzajem.

import { readFileSync } from 'node:fs';
import type { AiAssistant, AnalysisRun, ChainProvider, Identifier, ScoreRules, SourceConnector } from '@olcys/core';
import type { AiUsage } from './ai-rules.ts';
import type { ActivityResolver } from './analysis.ts';
import type { CorpusSettings } from './corpus.ts';
import type { DEPTH_LIMITS, RunDepth, RunEngine, RunPeriod } from './runs.ts';
import type { DossierView } from './dossier.ts';
import type { ServiceLabel } from './explain.ts';
import type { ConnectorInfo } from './report.ts';
import type { Monitor, MonitorTimers } from './monitor.ts';
import type { ExternalServiceMatcher } from './services.ts';
import type { ConfiguredKeys } from './source-keys.ts';
import type { CaseSummary, Storage } from './storage.ts';

export interface AppDeps {
  storage: Storage;
  connectors: SourceConnector[];
  chainProviders: ChainProvider[];
  /** Strategia wyboru dostawcy danych blockchain; bez niej analiza używa własnej, prostej. */
  resolveActivity?: ActivityResolver;
  rules?: ScoreRules;
  /** Rozpoznawanie usług po etykiecie adresu (np. `matchService` z `@olcys/chain`); bez niego działa lista lokalna. */
  matchService?: ExternalServiceMatcher;
  /** Dostawcy danych blockchain dla analizy głębokiej (dłuższe ścieżki środków); domyślnie `chainProviders`. */
  deepChainProviders?: ChainProvider[];
  /** Model językowy (opcjonalny). Bez niego wszystko liczą same reguły. */
  ai?: AiAssistant | null;
  /** Asystent do streszczeń (np. z dłuższym limitem czasu); domyślnie `ai`. */
  summaryAi?: AiAssistant | null;
  /** Model działa na tej samej maszynie — fakty do streszczenia nie muszą być anonimizowane. */
  aiLocal?: boolean;
  /** Publicznie oznaczone adresy usług (zbiór etykiet modułu danych blockchain) — do wyjaśnienia „to nazwa serwisu”. */
  serviceLabels?: ServiceLabel[];
  /** Normalizacja nietypowych zapisów adresów w treści przed ich wykrywaniem. */
  normalizeText?: (text: string) => string;
  /** Przechowywanie indeksu publikacji: liczba dni i limit wierszy. */
  corpus?: Partial<CorpusSettings>;
  /** Nadpisanie limitów analizy (testy). */
  runLimits?: Partial<(typeof DEPTH_LIMITS)[RunDepth]>;
  /** Źródła objęte cyklicznym monitoringiem; domyślnie wszystkie łączniki z metodą `discover`. */
  monitorConnectors?: SourceConnector[];
  /** Podmiana odliczania czasu harmonogramu monitoringu (testy). */
  monitorTimers?: MonitorTimers;
  /** Podmiana odliczania czasu obserwowanych spraw (testy). */
  watchTimers?: MonitorTimers;
  /** Które klucze API źródeł są ustawione (bez wartości); bez tego o kluczu świadczy sam łącznik. */
  configuredKeys?: ConfiguredKeys;
  now?: () => Date;
  /** Adres piaskownicy (dane demonstracyjne). Tylko gdy jest ustawiony, API udostępnia przykładową, syntetyczną odpowiedź usługi. */
  sandboxUrl?: string;
  /** Podmiana `fetch` dla zapytań do piaskownicy (testy). */
  fetch?: typeof fetch;
  /** Włącza log serwera (domyślnie wyłączony, żeby nie zaśmiecać testów). */
  logger?: boolean;
  /** Rozwijanie sieci na żądanie: dostawcy RDAP, rejestrów organizacji i list sankcyjnych (testy); domyślnie z konfiguracji usługi. */
  network?: import('./network/routes.ts').NetworkDeps;
  /** Token API, dozwolone adresy interfejsu (CORS) i limit kosztownych żądań; domyślnie bez tokenu. */
  security?: import('./security.ts').SecurityOptions;
  /** Retencja zamkniętych spraw (domyślnie wyłączona) i katalog archiwów. */
  lifecycle?: import('./lifecycle-routes.ts').LifecycleOptions;
}

export const TOOL_VERSION: string = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
).version;

export const IDENTIFIER_TYPES = ['full_name', 'nick', 'login', 'email', 'messenger_id', 'crypto_address', 'profile_url', 'ens_name'];

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

export const identifierItems = {
  type: 'object',
  required: ['type', 'value'],
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: IDENTIFIER_TYPES },
    value: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const;

/** Zależności i pomocnicze funkcje wspólne dla modułów z trasami. */
export interface RouteContext {
  storage: Storage;
  connectors: SourceConnector[];
  deps: AppDeps;
  rules: ScoreRules;
  now: () => Date;
  requireCase(id: string): Promise<CaseSummary>;
  requireRun(id: string): Promise<AnalysisRun>;
  connectorInfo(): ConnectorInfo[];
  /** Łączniki wskazane w żądaniu albo domyślnie włączone; nieznany identyfikator to błąd 400. */
  selectConnectors(ids?: string[], depth?: RunDepth): SourceConnector[];
  executeRun(caseSummary: CaseSummary, connectorIds?: string[], depth?: RunDepth, period?: RunPeriod): Promise<AnalysisRun>;
  runs: RunEngine;
  /** Model językowy z licznikiem wywołań; `undefined`, gdy nie jest skonfigurowany. */
  ai?: { assistant: AiAssistant; usage: AiUsage };
  corpusSettings: CorpusSettings;
  /** Sprawdza i porządkuje identyfikatory z żądania. */
  cleanIdentifiers(identifiers: Identifier[]): Identifier[];
  /** Teczka analizy z pamięci podręcznej albo złożona od nowa. */
  loadDossier(run: AnalysisRun): Promise<DossierView>;
  /** Unieważnia teczki po zmianie, która może wpłynąć na wynik (decyzja, nowa analiza). */
  invalidateDossiers(): void;
  monitor: Monitor;
}

/** Błąd z kodem HTTP i komunikatem dla analityka. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
