// Materiał wywiadowczy analizy: wszystko, czego nie mieści `AnalysisRun`, a co jest
// potrzebne do złożenia teczki bez ponownego odpytywania źródeł — widziane profile
// (także bez adresów), ścieżka odkrywania identyfikatorów i publikacje innych osób.
// Typy lokalne dla API; zapisywane obok analizy w kolumnie `runs.intel`.

import type { Identifier, IdentityMatch, ProfileAttributes, SourceCategory } from '@olcys/core';
import type { IdentityAssessment } from './identity.ts';

export type SightingRole =
  /** Dokument przypisany badanemu podmiotowi (z oceną tożsamości). */
  | 'subject'
  /** Inny autor publikujący adres podmiotu. */
  | 'co_publisher'
  /** Autor publikujący adres, który jest kontrahentem adresu podmiotu. */
  | 'counterparty_publisher';

/** Jeden dokument widziany w analizie, sprowadzony do danych o profilu autora. */
export interface Sighting {
  url: string;
  service: string;
  connectorId: string;
  title: string;
  author?: string;
  publishedAt?: string;
  archivedAt?: string;
  fetchedAt: string;
  category: SourceCategory;
  profile?: ProfileAttributes;
  matchedIdentifier: Identifier;
  discoveredIdentifiers: Identifier[];
  identity: IdentityAssessment;
  /** Krok wyszukiwania, w którym dokument znaleziono (0 = identyfikator analityka). */
  step: number;
  /** Adresy w treści (`network:address`). */
  addresses: string[];
  role: SightingRole;
}

/** Wpis „ścieżki dojścia”: który profil wskazał który identyfikator. */
export interface DiscoveryStep {
  identifier: Identifier;
  /** Krok, w którym identyfikator byłby wyszukiwany (1 = wskazany przez profil znaleziony wprost). */
  step: number;
  sourceUrl: string;
  sourceService: string;
  /** Identyfikator, po którym odnaleziono profil wskazujący. */
  via: Identifier;
  match: IdentityMatch;
  /** Czy identyfikator został użyty do dalszego wyszukiwania (limit głębokości i liczby). */
  followed: boolean;
}

export interface RunIntel {
  version: 1;
  discoveryDepth: number;
  sightings: Sighting[];
  trail: DiscoveryStep[];
  /** Kontrahenci bez etykiety sprawdzeni w źródłach (`network:address`). */
  checkedCounterparties: string[];
}

export const sightingKey = (item: { url: string; archivedAt?: string }): string => `${item.url}|${item.archivedAt ?? ''}`;

export const addressKey = (item: { network: string; address: string }): string => `${item.network}:${item.address}`;
