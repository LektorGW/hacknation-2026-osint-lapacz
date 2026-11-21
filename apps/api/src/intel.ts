// Materiał wywiadowczy analizy: wszystko, czego nie mieści `AnalysisRun`, a co jest
// potrzebne do złożenia teczki bez ponownego odpytywania źródeł — widziane profile
// (także bez adresów), ścieżka odkrywania identyfikatorów i publikacje innych osób.
// Typy lokalne dla API; zapisywane obok analizy w kolumnie `runs.intel`.

import type { Identifier, IdentityMatch, ProfileAttributes, SourceCategory } from '@olcys/core';
import type { IdentityAssessment } from './identity.ts';
import type { ServiceMention } from './services.ts';

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
  /** Wzmianki o giełdach, portfelach i innych usługach w treści dokumentu podmiotu. */
  serviceMentions?: ServiceMention[];
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

/** Porównanie stylu wypowiedzi dwóch profili przez model językowy — słaba przesłanka. */
export interface AuthorComparison {
  /** Identyfikatory profili (`ProfileCard.id`). */
  a: string;
  b: string;
  /** Na ile (0–100) wypowiedzi mógł napisać ten sam autor. */
  likelihood: number;
  reasons: string[];
  model: string;
}

/** Identyfikator wymieniany w publikacjach innych osób — wzmianki, nie profile podmiotu. */
export interface MentionSummary {
  identifier: Identifier;
  documents: number;
  authors: number;
  services: number;
  /** Zbieranie wzmianek przerwano po przekroczeniu progu — liczby są dolnym oszacowaniem („co najmniej”). */
  atLeast?: boolean;
}

export interface RunIntel {
  version: 1;
  discoveryDepth: number;
  sightings: Sighting[];
  trail: DiscoveryStep[];
  /** Kontrahenci bez etykiety sprawdzeni w źródłach (`network:address`). */
  checkedCounterparties: string[];
  /** Wyniki porównań autorów dla par profili o wiązaniu „możliwym, ale niepotwierdzonym”. */
  authorComparisons?: AuthorComparison[];
  /** Analiza przerwana limitem czasu — wynik częściowy. */
  partial?: boolean;
  /** Wzmianki o identyfikatorach podmiotu w publikacjach innych autorów (nieprzypisane podmiotowi). */
  mentions?: MentionSummary[];
}

export const sightingKey = (item: { url: string; archivedAt?: string }): string => `${item.url}|${item.archivedAt ?? ''}`;

export const addressKey = (item: { network: string; address: string }): string => `${item.network}:${item.address}`;
