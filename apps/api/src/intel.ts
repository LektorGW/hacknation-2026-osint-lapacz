// Materiał wywiadowczy analizy: wszystko, czego nie mieści `AnalysisRun`, a co jest
// potrzebne do złożenia teczki bez ponownego odpytywania źródeł — widziane profile
// (także bez adresów), ścieżka odkrywania identyfikatorów i publikacje innych osób.
// Typy lokalne dla API; zapisywane obok analizy w kolumnie `runs.intel`.

import type { Identifier, IdentityMatch, ProfileAttributes, SourceCategory } from '@olcys/core';
import type { IdentityAssessment } from './identity.ts';
import type { PivotLead } from './pivot.ts';
import type { BeneficiaryAttribution } from './beneficiary.ts';
import type { OrganizationNetwork } from './org-network.ts';
import type { ServiceMention } from './services.ts';
import type { FiatSignalHit } from './fiat-signals.ts';
import type { BusinessTextSignals } from './business.ts';

export type SightingRole =
  /** Dokument przypisany badanemu podmiotowi (z oceną tożsamości). */
  | 'subject'
  /** Inny autor publikujący adres podmiotu. */
  | 'co_publisher'
  /** Autor publikujący adres, który jest kontrahentem adresu podmiotu. */
  | 'counterparty_publisher'
  /** Publikacja innej tożsamości znaleziona przez pętlę rozszerzania (wspólna cecha, powiązany adres). */
  | 'linked_identity';

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
  /** Sygnały działalności gospodarczej z pełnej treści (wskaźnik D); dla dokumentów rejestrów — dane podmiotu. */
  businessText?: BusinessTextSignals;
  /** Oznaki wyjścia do walut tradycyjnych w treści dokumentu podmiotu (wskaźnik C, Web2) — tylko dla roli `subject`. */
  fiatSignals?: FiatSignalHit[];
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
  /** Dlaczego identyfikatora nie użyto do dalszego wyszukiwania (brak pola = użyto). */
  stopReason?: StopReason;
}

/** Powód zatrzymania rozszerzania analizy w danym miejscu — jawny, do pokazania analitykowi. */
export type StopReason =
  /** Osiągnięto limit głębokości (kroków) — dalsze tropy nie były rozwijane. */
  | 'depth_limit'
  /** Osiągnięto limit liczby identyfikatorów w analizie. */
  | 'identifier_limit'
  /** Wyczerpano budżet zapytań do źródeł i dostawców danych blockchain. */
  | 'request_budget'
  /** Limit zapytań na etap (np. kosztowne wyszukiwarki, zapytania na krok rozszerzania). */
  | 'query_limit'
  /** Limit czasu całej analizy. */
  | 'time_limit'
  /** Naturalny koniec: nie ma już nowych tropów do sprawdzenia. */
  | 'no_new_leads'
  /** Sprawdzono tylko największych kontrahentów — grafu nie rozwijamy po wszystkich. */
  | 'counterparty_limit'
  /** Limit liczby adresów z analizą blockchain. */
  | 'chain_address_limit'
  /** Trop pochodzi ze słabo przypisanego albo mało wiarygodnego źródła — nie był rozwijany. */
  | 'low_reliability'
  /** Analizę przerwano z zewnątrz (zamknięcie usługi). */
  | 'aborted'
  /** Źródło albo dostawca danych nie odpowiedział — ta część wyniku jest niepełna. */
  | 'source_error';

export interface ExpansionStop {
  /** Etap analizy: `search`, `occurrences`, `chain`, `counterparties`, `pivot`. */
  stage: string;
  reason: StopReason;
  /** Zdanie dla analityka: co zatrzymano i dlaczego. */
  detail: string;
  /** Ile tropów, zapytań albo adresów pominięto z tego powodu. */
  skipped?: number;
}

/**
 * Kontrola rozszerzania analizy: obowiązujące limity, zużycie budżetu zapytań, pominięte powtórzenia,
 * powody zatrzymania i parametry potrzebne do powtórzenia analizy.
 */
export interface ExpansionReport {
  /** Limity faktycznie zastosowane w tej analizie. */
  limits: {
    discoveryDepth: number;
    maxIdentifiers: number;
    maxRequests: number;
    maxCounterparties: number;
    maxChainAddresses: number;
    pivotSteps: number;
    pivotQueriesPerStep: number;
    pivotMinLinkStrength: number;
    maxBroadDiscovered: number;
    maxBroadAddresses: number;
    maxBroadCounterparties: number;
    mentionStopAuthors: number;
    requestTimeoutMs: number;
    totalTimeoutMs: number;
    concurrency: number;
  };
  /** Zapytania faktycznie wysłane: do łączników (łącznik × identyfikator) i do dostawców danych blockchain; `budget` to limit łączny. */
  requests: { connectors: number; chain: number; budget: number };
  /** Łączna liczba pominiętych powtórzeń (zapytania + identyfikatory + treści). */
  duplicatesSkipped: number;
  /** Powtórzenia według rodzaju: to samo zapytanie łącznik × identyfikator, ten sam identyfikator wskazany ponownie, ta sama treść pod innym adresem. */
  duplicates: { queries: number; identifiers: number; documents: number };
  /** Zasada wiarygodności źródeł zastosowana przy rozwijaniu identyfikatorów. */
  reliability: { lowReliabilityCategories: SourceCategory[]; weakMatches: IdentityMatch[]; weakFollowSteps: number };
  /** Powody zatrzymania w stałej kolejności etapów. */
  stops: ExpansionStop[];
  /** Parametry do powtórzenia analizy: wejście, okres, źródła w kolejności odpytywania, skrót reguł oceny. */
  run: {
    startedAt: string;
    finishedAt: string;
    identifiers: Identifier[];
    period?: { from?: string; to?: string };
    /** Identyfikatory łączników w kolejności odpytywania. */
    connectors: string[];
    /** Identyfikatory dostawców danych blockchain w kolejności prób. */
    chainProviders: string[];
    /** SHA-256 reguł Wskaźnika Pewności (pierwsze 16 znaków) — ta sama wartość = te same reguły. */
    rulesHash: string;
    /** Czy w analizie brał udział model językowy (jego odczyty nie są powtarzalne co do litery). */
    ai?: string;
  };
}

/** Źródło albo dostawca danych, który nie odpowiedział — wynik jest w tej części niepełny, niczego nie uzupełniano. */
export interface SourceError {
  /** Łącznik źródła (dla błędów wyszukiwania). */
  connectorId?: string;
  /** Dostawca danych blockchain (dla błędów analizy łańcucha). */
  providerId?: string;
  /** Etap analizy, w którym wystąpił błąd. */
  stage: string;
  /** Pierwszy komunikat błędu. */
  message: string;
  /** Ile zapytań do tego źródła nie powiodło się w tym etapie. */
  count: number;
  /** Adresy, dla których nie ma danych blockchain (`network:address`). */
  addresses?: string[];
  /** Błąd zgłosiło samo źródło w dzienniku i zwróciło to, co zdążyło pobrać (zapytanie formalnie się powiodło). */
  reported?: boolean;
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
  /** Adnotacja, np. „adres występuje w publicznych zestawieniach adresów”. */
  note?: string;
}

/** Czas jednej fazy analizy (kolejne kroki wyszukiwania są osobnymi wpisami `search-N`). */
export interface StageTiming {
  stage: string;
  ms: number;
}

/** Jedno zapytanie łącznik × identyfikator — do wskazania najwolniejszych źródeł. */
export interface QueryTiming {
  connectorId: string;
  identifier: Identifier;
  ms: number;
  documents: number;
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
  /** Tropy pętli rozszerzania: inne tożsamości i adresy powiązane, ze ścieżką dojścia. */
  pivot?: PivotLead[];
  /** Pomiar czasu: fazy analizy w kolejności wykonania. */
  timings?: StageTiming[];
  /** Dziesięć najwolniejszych zapytań łącznik × identyfikator. */
  slowestQueries?: QueryTiming[];
  /** Wzmianki o identyfikatorach podmiotu w publikacjach innych autorów (nieprzypisane podmiotowi). */
  mentions?: MentionSummary[];
  /** Kontrola rozszerzania: limity, budżet zapytań, powtórzenia, powody zatrzymania, parametry do powtórzenia. */
  expansion?: ExpansionReport;
  /** Źródła i dostawcy danych, którzy nie odpowiedzieli (pole obecne tylko, gdy coś zawiodło). */
  sourceErrors?: SourceError[];
  /**
   * Beneficjenci adresów cytowanych przez wielu autorów (czyj to adres zbiórki lub płatności), z oceną i wynikiem
   * sprawdzenia strony organizacji. Brak pola = analiza sprzed tego etapu (teczka liczy wtedy z cytatów przy adresach).
   */
  beneficiaries?: BeneficiaryAttribution[];
  /** Sieć organizacji z rejestrów publicznych (osoby w rolach, podmioty powiązane) — tylko gdy wskazano organizację. */
  organizationNetwork?: OrganizationNetwork;
}

export const sightingKey = (item: { url: string; archivedAt?: string }): string => `${item.url}|${item.archivedAt ?? ''}`;

export const addressKey = (item: { network: string; address: string }): string => `${item.network}:${item.address}`;
