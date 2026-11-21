// Wspólne kontrakty między modułami: źródła Web2, dane blockchain, analiza, raport.
// Moduły komunikują się wyłącznie przez te typy, dzięki czemu nowe źródło lub
// nową sieć dodaje się bez zmian w pozostałych częściach.

import type { Network } from './addresses.ts';
import type { AddressClass, Evidence, IdentityMatch, ScoreResult, SourceCategory } from './score.ts';

// ---------- Wejście analityka ----------

export type IdentifierType = 'full_name' | 'nick' | 'login' | 'email' | 'messenger_id' | 'crypto_address' | 'profile_url' | 'ens_name';

export interface Identifier {
  type: IdentifierType;
  value: string;
}

export interface SubjectQuery {
  identifiers: Identifier[];
}

// ---------- Źródła Web2 ----------

/** Dokument pobrany z publicznego źródła — surowy ślad OSINT. */
export interface SourceDocument {
  connectorId: string;
  /** Usługa pochodzenia, np. `github.com`. Wyznacza niezależność źródeł. */
  service: string;
  url: string;
  title: string;
  /** Treść tekstowa, w której szukamy adresów. */
  text: string;
  /** Czas pobrania (ISO 8601). */
  fetchedAt: string;
  /** Data publikacji treści, jeśli źródło ją podaje (ISO 8601). */
  publishedAt?: string;
  /** Autor lub właściciel profilu, tak jak podaje źródło. */
  author?: string;
  category: SourceCategory;
  identityMatch: IdentityMatch;
  /** Identyfikator, przez który dokument został odnaleziony. */
  matchedIdentifier: Identifier;
  /**
   * Inne identyfikatory tej samej osoby ujawnione w dokumencie (np. link do
   * innego profilu). Analiza może je wykorzystać do kolejnego kroku wyszukiwania.
   */
  discoveredIdentifiers?: Identifier[];
  /** Dla wersji archiwalnych: czas zapisania kopii (ISO 8601). */
  archivedAt?: string;
  /** Atrybuty profilu autora, jeśli źródło je ujawnia. */
  profile?: ProfileAttributes;
}

export interface ConnectorContext {
  signal?: AbortSignal;
  /** Zapis do dziennika analizy — widoczny dla analityka. */
  log(message: string): void;
}

/** Łącznik do jednego publicznego źródła. */
export interface SourceConnector {
  id: string;
  service: string;
  /** Nazwa pokazywana analitykowi. */
  label: string;
  /** Opis: co i w jaki sposób jest przeszukiwane (parametry wyszukiwania). */
  description: string;
  /** Typy identyfikatorów, po których źródło umie szukać. */
  accepts: IdentifierType[];
  /** Czy łącznik jest domyślnie włączony. */
  enabledByDefault: boolean;
  search(identifier: Identifier, context: ConnectorContext): Promise<SourceDocument[]>;
}

// ---------- Dane blockchain (Web3) ----------

export interface AddressProfile {
  address: string;
  network: Network;
  addressClass: AddressClass;
  /** Publiczna etykieta, np. `Kraken: Hot Wallet`. */
  label?: string;
  /** Skąd pochodzi klasyfikacja (nazwa zbioru etykiet lub API). */
  classificationSource: string;
  isContract: boolean;
  txCount: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Sumy w jednostce podstawowej waluty sieci (BTC, ETH, TRX). */
  totalReceived: number;
  totalSent: number;
  balance: number;
  nativeAsset: string;
}

export interface Transfer {
  txid: string;
  /** Czas transakcji (ISO 8601). */
  time: string;
  direction: 'in' | 'out';
  counterparty: string;
  counterpartyClass: AddressClass;
  counterpartyLabel?: string;
  asset: string;
  amount: number;
  /** Adres w publicznym eksploratorze, do weryfikacji przez analityka. */
  explorerUrl: string;
}

export type CashOutKind =
  | 'exchange_deposit'
  | 'p2p_service'
  | 'payment_gateway'
  | 'crypto_card'
  | 'stablecoin_swap';

/** Wskaźnik możliwego wyjścia do walut tradycyjnych. */
export interface CashOutIndicator {
  kind: CashOutKind;
  txid: string;
  time: string;
  asset: string;
  amount: number;
  counterparty: string;
  counterpartyLabel?: string;
  /** Szacunkowa wartość w PLN po kursie z dnia transakcji; brak, gdy nie ma kursu. */
  valuePln?: number;
  /** Jak policzono wartość: kurs, źródło kursu, data. */
  valuation?: string;
  explanation: string;
  explorerUrl: string;
}

export interface ChainActivity {
  profile: AddressProfile;
  transfers: Transfer[];
  cashOuts: CashOutIndicator[];
  /** Suma szacunkowych wypłat w PLN w podziale na lata podatkowe. */
  cashOutPlnByYear: Record<string, number>;
  /** Opis ograniczeń danych, np. limit liczby pobranych transakcji. */
  limitations: string[];
}

/** Dostawca danych o jednej lub kilku sieciach. */
export interface ChainProvider {
  id: string;
  label: string;
  supports(network: Network, address: string): boolean;
  getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity>;
}

// ---------- Wynik analizy ----------

/** Ślad wraz z zapisaną kopią treści — podstawa łańcucha dowodowego. */
export interface StoredEvidence extends Evidence {
  title: string;
  author?: string;
  publishedAt?: string;
  archivedAt?: string;
  /** Fragment tekstu z adresem. */
  excerpt: string;
  /** SHA-256 pobranej treści. */
  contentHash: string;
  connectorId: string;
  matchedIdentifier: Identifier;
}

/** Jedno powiązanie podmiot–adres z uzasadnieniem. */
export interface Finding {
  address: string;
  network: Network;
  checksumVerified: boolean;
  evidence: StoredEvidence[];
  confidence: ScoreResult;
  chain?: ChainActivity;
  /** Liczba innych, niepowiązanych tożsamości publikujących ten sam adres. */
  unrelatedPublishers: number;
}

export interface AnalysisRun {
  id: string;
  caseId: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed';
  query: SubjectQuery;
  /** Łączniki użyte w tej analizie. */
  connectors: string[];
  findings: Finding[];
  /** Dziennik przebiegu: co przeszukano, co znaleziono, jakie były błędy. */
  log: { time: string; message: string }[];
}

/** Różnice między dwiema analizami tego samego podmiotu. */
export interface RunDiff {
  fromRunId: string;
  toRunId: string;
  addedAddresses: string[];
  removedAddresses: string[];
  scoreChanges: { address: string; from: number; to: number }[];
  /** Podmiany adresu w tym samym miejscu publikacji. */
  replacedAddresses: { url: string; from: string; to: string }[];
}

// ---------- Atrybuty profilu i typowanie ----------

/** Dane o profilu ujawnione przez samo źródło — podstawa łączenia profili w jedną osobę. */
export interface ProfileAttributes {
  /** Nazwa konta w serwisie (bez `@`). */
  handle?: string;
  displayName?: string;
  emails?: string[];
  phones?: string[];
  /** Strony i inne profile wskazane przez właściciela. */
  urls?: string[];
  location?: string;
  avatarUrl?: string;
  bio?: string;
  /** Data założenia konta (ISO 8601). */
  createdAt?: string;
}

/** Łącznik, który potrafi sam wskazać świeże publikacje z adresami (np. nowe oferty P2P). */
export interface DiscoveringConnector extends SourceConnector {
  /** Zwraca ostatnie publiczne publikacje bez podawania identyfikatora osoby. */
  discover(context: ConnectorContext, limit: number): Promise<SourceDocument[]>;
}

// ---------- Teczka podmiotu ----------

export type Decision = 'confirmed' | 'rejected';

/** Decyzja analityka o profilu lub adresie; zmienia wynik i zostaje w rejestrze. */
export interface AnalystDecision {
  id: string;
  caseId: string;
  target: 'profile' | 'address';
  /** Profil: `service|handle` albo URL; adres: `network:address`. */
  key: string;
  decision: Decision;
  note?: string;
  decidedAt: string;
}

/** Jeden profil w serwisie wraz z oceną, czy należy do badanego podmiotu. */
export interface ProfileCard {
  id: string;
  service: string;
  url: string;
  handle?: string;
  attributes: ProfileAttributes;
  identityMatch: IdentityMatch;
  identityReasons: string[];
  /** Pewność 0–100, że profil należy do podmiotu. */
  identityScore: number;
  /** Adresy opublikowane w tym profilu (`network:address`). */
  addresses: string[];
  evidenceIds: string[];
  decision?: Decision;
}

export type RelationKind =
  /** Ten sam adres publikuje także inna osoba. */
  | 'shared_address'
  /** Bezpośredni przelew między adresem podmiotu a adresem innej osoby. */
  | 'transacted'
  /** Wspólny kontrahent (ten sam serwis lub adres pośredni). */
  | 'common_counterparty'
  /** Wspólna cecha profili: e-mail, telefon, strona. */
  | 'shared_attribute';

/** Inna osoba powiązana z badanym podmiotem. */
export interface RelatedPerson {
  id: string;
  handle: string;
  services: string[];
  relations: { kind: RelationKind; via: string; description: string }[];
  /** Siła powiązania 0–100. */
  strength: number;
  profileUrls: string[];
}

export type GraphNodeKind = 'subject' | 'identifier' | 'profile' | 'address' | 'service' | 'person';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  sublabel?: string;
  /** Wynik 0–100 dla węzłów ocenianych (profil: tożsamość, adres: Wskaźnik Pewności). */
  score?: number;
  excluded?: boolean;
  /** Odnośnik do źródła lub eksploratora. */
  url?: string;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'has_identifier' | 'found_profile' | 'links_to' | 'publishes' | 'transfer' | 'cash_out' | 'related';
  label?: string;
  /** Waga 0–100: siła dowodu albo względna wartość przepływu. */
  weight?: number;
  /** Wnioskowanie narzędzia, a nie fakt ze źródła. */
  inferred?: boolean;
}

export interface TimelineEvent {
  time: string;
  kind: 'publication' | 'transfer_in' | 'transfer_out' | 'cash_out' | 'address_replaced' | 'account_created';
  title: string;
  detail?: string;
  address?: string;
  valuePln?: number;
  url?: string;
  layer: 'fact' | 'calculation' | 'inference';
}

/** Zbiorczy obraz podmiotu dla analityka — jedna odpowiedź API na cały ekran sprawy. */
export interface Dossier {
  caseId: string;
  runId: string;
  generatedAt: string;
  subject: {
    name: string;
    /** Imiona, nazwiska i nazwy wyświetlane znalezione w profilach. */
    knownNames: string[];
    identifiers: { identifier: Identifier; origin: 'analyst' | 'discovered'; sourceUrl?: string }[];
  };
  /** Kandydaci na rzeczywistą osobę, malejąco po prawdopodobieństwie; pierwszy to ustalenie główne. */
  persons: PersonCandidate[];
  profiles: ProfileCard[];
  findings: Finding[];
  relatedPersons: RelatedPerson[];
  /** Giełdy, portfele i inne usługi powiązane z podmiotem — sedno teczki. */
  serviceLinks: ServiceLink[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  timeline: TimelineEvent[];
  totals: {
    linkedAddresses: number;
    excludedAddresses: number;
    topScore: number;
    cashOutPlnByYear: Record<string, number>;
    /** Priorytet sprawy 0–100: pewność powiązania × skala szacowanych wypłat. */
    priority: number;
    priorityReasons: string[];
  };
  decisions: AnalystDecision[];
  /** Najważniejsze ustalenia jednym zdaniem każde — do przeczytania w minutę. */
  keyFindings: { text: string; layer: 'fact' | 'calculation' | 'inference' }[];
}

// ---------- Typowanie podmiotów ----------

/** Podmiot wytypowany przez przegląd źródeł, bez wcześniejszego wskazania przez analityka. */
export interface Lead {
  id: string;
  handle: string;
  services: string[];
  profileUrls: string[];
  addresses: { address: string; network: Network; score: number }[];
  topScore: number;
  cashOutPlnByYear: Record<string, number>;
  cashOutPlnTotal: number;
  /** Priorytet 0–100 i jego uzasadnienie. */
  priority: number;
  priorityReasons: string[];
  /** Sprawa założona z tego wskazania, jeśli już istnieje. */
  caseId?: string;
}

export interface Sweep {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'completed' | 'failed';
  connectors: string[];
  documentsScanned: number;
  leads: Lead[];
  log: { time: string; message: string }[];
}

// ---------- Powiązania podmiotu z giełdami, portfelami i innymi usługami ----------

export type ServiceKind = 'exchange' | 'p2p' | 'payment_gateway' | 'crypto_card' | 'wallet' | 'defi' | 'mixer' | 'other';

export type ServiceLinkBasis =
  /** Przelew z adresu podmiotu na adres usługi. */
  | 'transfer_out'
  /** Przelew z adresu usługi na adres podmiotu (np. wypłata z giełdy — źródło środków). */
  | 'transfer_in'
  /** Przelew przez prawdopodobny indywidualny adres wpłat w usłudze (wnioskowanie). */
  | 'deposit_address'
  /** Podmiot wymienia usługę w publicznej treści (nazwa, konto, oferta). */
  | 'web_mention'
  /** Odnośnik polecający lub profil podmiotu w usłudze. */
  | 'account_link';

/**
 * Jedna usługa (giełda, portfel, serwis P2P, bramka), z którą powiązany jest podmiot.
 * To odpowiedź na pytanie analityka: „do kogo skierować zapytanie i o co zapytać”.
 */
export interface ServiceLink {
  id: string;
  /** Nazwa usługi, np. `Binance`. */
  name: string;
  kind: ServiceKind;
  networks: Network[];
  basis: ServiceLinkBasis[];
  /** Siła powiązania 0–100 z jawnych przesłanek. */
  strength: number;
  reasons: string[];
  /** Czy powiązanie opiera się wyłącznie na wnioskowaniu narzędzia. */
  inferredOnly: boolean;
  firstSeen?: string;
  lastSeen?: string;
  transfersOut: number;
  transfersIn: number;
  /** Szacunkowa wartość przelewów do usługi w PLN. */
  outPln?: number;
  inPln?: number;
  transfers: {
    txid: string;
    time: string;
    direction: 'in' | 'out';
    asset: string;
    amount: number;
    valuePln?: number;
    /** Adres podmiotu biorący udział w przelewie. */
    subjectAddress: string;
    /** Adres po stronie usługi (portfel zbiorczy albo adres wpłat). */
    serviceAddress: string;
    /** Adres pośredni, jeśli powiązanie wynika z wnioskowania o adresie wpłat. */
    viaAddress?: string;
    explorerUrl: string;
  }[];
  /** Wzmianki i konta w publicznych treściach. */
  mentions: { url: string; excerpt: string; evidenceId?: string }[];
  /**
   * Dane, które pozwolą usłudze zidentyfikować konto klienta: adresy wpłat,
   * identyfikatory transakcji z datami i kwotami, nazwy kont.
   */
  requestHints: string[];
}

// ---------- Ustalenie rzeczywistej osoby ----------

/**
 * Kandydat na rzeczywistą osobę stojącą za identyfikatorami — wynik automatycznego
 * łączenia profili, bez udziału analityka. Kilku kandydatów oznacza, że ślady mogą
 * należeć do różnych osób (np. imiennicy albo ten sam nick u dwóch osób).
 */
export interface PersonCandidate {
  id: string;
  /** Najbardziej prawdopodobne imię i nazwisko; brak, gdy źródła go nie ujawniają. */
  fullName?: string;
  /** Inne zapisy nazwy spotkane w profilach. */
  nameVariants: string[];
  /** Prawdopodobieństwo 0–100, że to osoba, której dotyczy sprawa. */
  probability: number;
  reasons: string[];
  /** Cechy ustalone ze źródeł wraz z liczbą niezależnych potwierdzeń. */
  attributes: {
    kind: 'email' | 'phone' | 'location' | 'website' | 'handle' | 'organization' | 'registry_entry';
    value: string;
    /** Usługi, w których cecha wystąpiła. */
    sources: string[];
  }[];
  /** Profile zaliczone do tej osoby (`ProfileCard.id`). */
  profileIds: string[];
  /** Adresy przypisane tej osobie (`network:address`) z łącznym prawdopodobieństwem. */
  addresses: { key: string; probability: number }[];
}

// ---------- Monitoring źródeł ----------

/** Ocena 0–100 z jawnymi przesłankami. */
export interface ScoredSignal {
  score: number;
  reasons: string[];
}

/**
 * Publikacja wychwycona przez cykliczny przegląd źródeł: zawiera adres kryptowalutowy
 * i sygnały, że może dotyczyć obrotu krypto przez osobę związaną z Polską.
 */
export interface WatchHit {
  id: string;
  detectedAt: string;
  connectorId: string;
  service: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  excerpt: string;
  /** Rozpoznany język treści (kod ISO 639-1) lub `und`. */
  language: string;
  addresses: { address: string; network: Network }[];
  /** Związek z Polską: język, PLN, polskie miasta, numery +48, BLIK, polskie banki i serwisy. */
  polishNexus: ScoredSignal;
  /** Sygnały obrotu wymagającego uwagi: sprzedaż za gotówkę, duże kwoty, oferta bez weryfikacji. */
  suspicion: ScoredSignal;
  status: 'new' | 'analyzed' | 'dismissed';
  /** Wynik automatycznej analizy autora, jeśli została wykonana. */
  lead?: Lead;
  caseId?: string;
}

export interface MonitorSourceStatus {
  connectorId: string;
  label: string;
  service: string;
  enabled: boolean;
  lastRunAt?: string;
  lastError?: string;
  documentsSeen: number;
  hits: number;
}

export interface MonitorStatus {
  enabled: boolean;
  everyMinutes: number;
  /** Od jakiej sumy ocen (związek z Polską i sygnały obrotu) autor jest analizowany automatycznie. */
  autoAnalyzeThreshold: number;
  lastRunAt?: string;
  nextRunAt?: string;
  running: boolean;
  sources: MonitorSourceStatus[];
  totals: { documentsSeen: number; hits: number; analyzed: number; newHits: number };
}
