// Wspólne elementy tras HTTP: zależności aplikacji, schematy parametrów, błąd z kodem
// HTTP i kontekst przekazywany modułom z trasami. Osobny moduł, żeby `app.ts`
// i moduły tras nie importowały się nawzajem.

import { readFileSync } from 'node:fs';
import type { AnalysisRun, ChainProvider, Identifier, ScoreRules, SourceConnector } from '@olcys/core';
import type { ActivityResolver } from './analysis.ts';
import type { DossierView } from './dossier.ts';
import type { ConnectorInfo } from './report.ts';
import type { ExternalServiceMatcher } from './services.ts';
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
  now?: () => Date;
  /** Włącza log serwera (domyślnie wyłączony, żeby nie zaśmiecać testów). */
  logger?: boolean;
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
  selectConnectors(ids?: string[]): SourceConnector[];
  executeRun(caseSummary: CaseSummary, connectorIds?: string[]): Promise<AnalysisRun>;
  /** Sprawdza i porządkuje identyfikatory z żądania. */
  cleanIdentifiers(identifiers: Identifier[]): Identifier[];
  /** Teczka analizy z pamięci podręcznej albo złożona od nowa. */
  loadDossier(run: AnalysisRun): Promise<DossierView>;
  /** Unieważnia teczki po zmianie, która może wpłynąć na wynik (decyzja, nowa analiza). */
  invalidateDossiers(): void;
}

/** Błąd z kodem HTTP i komunikatem dla analityka. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
