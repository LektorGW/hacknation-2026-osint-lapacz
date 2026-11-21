// Model bytów i zapisów rozwijania sieci na żądanie („Rozwiń” w grafie śledczym).
//
// Każdy węzeł grafu da się przełożyć na BYT o stałym kluczu (ten sam identyfikator co węzeł teczki:
// `id:email:…`, `addr:sieć:adres`, `profile:serwis|nazwa`, `source:URL`, `org:…`, `person:…`), a byt —
// rozwinąć ekspanderami w to, co wolno z niego legalnie wyprowadzić. Wynik rozwinięcia jest ZAPISEM
// (tabela `network_expansions`): kto, kiedy, co rozwinął, jakie źródła odpowiedziały, z jakimi dowodami.

import type { ClaimStatus, EvidenceRef, GraphEdge, GraphNode, NetworkRelation } from '@olcys/core';

/** Rodzaje bytów rozwijanej sieci. */
export type EntityKind = 'subject' | 'person' | 'organization' | 'account' | 'identifier' | 'crypto_address' | 'service' | 'document';

/** Rodzaj identyfikatora — szerszy niż wejście analityka (telefon, domena, adres strony). */
export type IdentifierKind = 'email' | 'phone' | 'nick' | 'domain' | 'url' | 'messenger' | 'name' | 'ens';

/** Grupy relacji pokazywane analitykowi jako pola wyboru przy „Rozwiń”. */
export type RelationGroup = 'accounts' | 'flows' | 'organizations' | 'sanctions' | 'publications';

export const RELATION_GROUPS: { id: RelationGroup; label: string }[] = [
  { id: 'accounts', label: 'konta i identyfikatory' },
  { id: 'flows', label: 'adresy i przepływy' },
  { id: 'organizations', label: 'organizacje i role' },
  { id: 'sanctions', label: 'listy sankcyjne' },
  { id: 'publications', label: 'publikacje' },
];

/** Dodatkowe dane bytu potrzebne do kolejnych rozwinięć (np. atrybuty konta z jego publikacji). */
export interface EntityMeta {
  service?: string;
  handle?: string;
  displayName?: string;
  emails?: string[];
  phones?: string[];
  urls?: string[];
  /** Adresy kryptowalutowe opublikowane przez konto (`sieć:adres`). */
  addresses?: string[];
  network?: string;
  address?: string;
  domain?: string;
  registry?: { krs?: string; lei?: string; wikidata?: string; nip?: string };
  /** Dane syntetyczne (piaskownica, laboratorium) — nigdy nie trafiają do prawdziwych rejestrów. */
  synthetic?: boolean;
  /** Byt figuruje na liście sankcyjnej / ryzyka (wpis źródłowy). */
  sanctioned?: { list: string; entryId: string; synthetic?: boolean };
}

export interface Entity {
  /** Stały klucz = identyfikator węzła grafu. */
  key: string;
  kind: EntityKind;
  label: string;
  identifierKind?: IdentifierKind;
  /** Wartość do zapytań: e-mail, telefon, nick, adres, URL, nazwa organizacji. */
  value?: string;
  url?: string;
  meta: EntityMeta;
}

/** Węzeł sieci: węzeł grafu + pochodzenie z rozwinięcia. */
export interface NetworkNode extends GraphNode {
  entityKind?: EntityKind;
  meta?: EntityMeta;
  /** Rozwinięcie, które dodało węzeł (brak = węzeł teczki). */
  expansionId?: string;
  /** Odległość w krokach rozwijania od węzła teczki (0 = teczka). */
  depth?: number;
  /** Węzeł był już w sieci przed tym rozwinięciem (zapis go tylko potwierdza). */
  known?: boolean;
  /** Opis powiązania z podmiotem sprawy (bezpiecznik „winy przez skojarzenie”). */
  link?: { level: 'documented' | 'distant' | 'circumstantial' | 'none'; label: string; summary: string; strength: number; hypotheses: number };
}

/** Relacja sieci: krawędź grafu + relacja z katalogu, siła i czas pozyskania. */
export interface NetworkEdge extends GraphEdge {
  relation?: NetworkRelation;
  /** Siła 0–1 (iloczyn w ścieżce, zanik na hipotezach). */
  strength?: number;
  expansionId?: string;
  expander?: string;
  /** Czas pozyskania dowodu (ISO 8601). */
  retrievedAt?: string;
  caveat?: string;
}

/** Powód zatrzymania rozwinięcia — jak `intel.expansion.stops` w analizie. */
export interface ExpansionStop {
  reason: 'budget' | 'depth_limit' | 'not_applicable' | 'not_live' | 'no_provider' | 'duplicate' | 'source_error' | 'node_limit' | 'no_results' | 'time_limit';
  detail: string;
  expander?: string;
  skipped?: number;
}

export interface ExpansionSourceError {
  source: string;
  expander: string;
  message: string;
}

/** Ekspander użyty w rozwinięciu: co czytał, przez kogo, na jakiej podstawie, ile kosztował. */
export interface ExpanderRun {
  expander: string;
  label: string;
  entity: string;
  provider: string;
  legalBasis: string;
  requests: number;
  nodes: number;
  edges: number;
  /** Krok rozwinięcia (1 = byt wskazany przez analityka). */
  hop: number;
}

/** Zapis rozwinięcia — trwały, z możliwością wycofania (wpis zostaje w audycie). */
export interface ExpansionRecord {
  id: string;
  caseId: string;
  nodeId: string;
  /** Grupy relacji wskazane przez analityka (puste = wszystkie dostępne). */
  relations: RelationGroup[];
  depth: number;
  budget: { limit: number; used: number };
  startedAt: string;
  finishedAt: string;
  requestedBy: string;
  results: { nodes: NetworkNode[]; edges: NetworkEdge[]; runs: ExpanderRun[] };
  stops: ExpansionStop[];
  sourceErrors: ExpansionSourceError[];
  /** Analiza, której teczka była podstawą (dla odtworzenia). */
  runId?: string;
  withdrawnAt?: string;
  withdrawnBy?: string;
}

/** Wynik jednego ekspandera dla jednego bytu. */
export interface ExpanderOutput {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  errors?: ExpansionSourceError[];
  notes?: ExpansionStop[];
  requests: number;
}

/** Krawędź-szkic: status i siła z katalogu relacji, jeśli nie podano jawnie. */
export interface EdgeDraft {
  from: string;
  to: string;
  relation: NetworkRelation;
  kind?: GraphEdge['kind'];
  status?: ClaimStatus;
  strength?: number;
  label?: string;
  explanation: string;
  evidence: EvidenceRef[];
  retrievedAt: string;
  layer?: 'identity' | 'chain';
}
