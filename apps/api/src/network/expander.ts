// Kontrakt ekspandera: jeden moduł = jedna droga (byt → relacja). Ekspander deklaruje, co czyta,
// przez jakiego dostawcę, na jakiej podstawie prawnej (odwołanie do docs/ZRODLA-PODSTAWA-PRAWNA.md),
// ile kosztuje (liczba zapytań) i jakie relacje tworzy. Nic poza tym kontraktem nie wychodzi na zewnątrz.

import type { ChainProvider, Finding, NetworkRelation, ProfileCard, SourceConnector } from '@olcys/core';
import type { ActivityResolver } from '../analysis.ts';
import type { CapturedDocument } from '../analysis.ts';
import type { CorpusDocument } from '../storage.ts';
import type { OrganizationProvider } from './organizations.ts';
import type { RdapClient } from './rdap.ts';
import type { SanctionsProvider } from './sanctions.ts';
import type { Entity, ExpanderOutput, ExpansionStop, NetworkNode, RelationGroup } from './types.ts';

/** Wszystko, czego ekspander może użyć — wstrzykiwane, więc testy działają bez sieci. */
export interface ExpandContext {
  caseId: string;
  /** Łączniki źródeł użyte w ostatniej analizie sprawy (wybór analityka), bez monitoringu. */
  connectors: SourceConnector[];
  chainProviders: ChainProvider[];
  resolveActivity?: ActivityResolver;
  /** Adresy z teczki (z zapisaną aktywnością blockchain) — bez nowych zapytań. */
  findings: Finding[];
  profiles: ProfileCard[];
  /** Kopie treści dokumentów ostatniej analizy (łańcuch dowodowy). */
  documents: () => Promise<CapturedDocument[]>;
  /** Fraza w indeksie własnym (monitoring) — lokalnie, bez zapytań na zewnątrz. */
  corpusPhrase: (phrase: string, limit: number) => Promise<CorpusDocument[]>;
  corpusDocument: (url: string) => Promise<Omit<CorpusDocument, 'addresses'> | null>;
  /** Czy włączono źródła publiczne (ENABLE_LIVE) — warunek każdego zapytania wychodzącego na zewnątrz. */
  live: boolean;
  rdap?: RdapClient;
  organizations?: OrganizationProvider;
  sanctions: SanctionsProvider[];
  /** Węzły znane w chwili rozwijania (teczka, wcześniejsze rozwinięcia i bieżące) — do wzajemnych odnośników. */
  nodes: Map<string, NetworkNode>;
  /** Sprawa oparta wyłącznie na danych demonstracyjnych (piaskownica, laboratorium). */
  synthetic: boolean;
  /** Rezerwuje zapytanie w budżecie rozwinięcia; `false` — budżet wyczerpany. */
  reserve: () => boolean;
  now: () => Date;
  log: (message: string) => void;
  signal?: AbortSignal;
}

export interface Expander {
  id: string;
  group: RelationGroup;
  label: string;
  /** Co ekspander czyta (zdanie dla analityka). */
  reads: string;
  /** Łącznik / dostawca, przez który pyta. */
  provider: string;
  /** Odwołanie do rozdziału dokumentu o podstawie prawnej. */
  legalBasis: string;
  produces: NetworkRelation[];
  applies(entity: Entity): boolean;
  /** Szacunkowa liczba zapytań (0 = dane już w teczce albo sprawdzenie lokalne). */
  cost(entity: Entity, context: ExpandContext): number;
  /** Czy droga jest dostępna w tej konfiguracji; brak = zawsze. */
  unavailable?(entity: Entity, context: ExpandContext): ExpansionStop | null;
  run(entity: Entity, context: ExpandContext): Promise<ExpanderOutput>;
}

export const LEGAL = {
  existingConnectors: 'docs/ZRODLA-PODSTAWA-PRAWNA.md — łączniki źródeł użyte w analizie sprawy (rozdz. 2, 7, 8; ta sama droga i te same limity co w analizie)',
  dossier: 'dane już zapisane w teczce sprawy — bez nowych zapytań (rozdz. 4 dla danych blockchain)',
  chain: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 4 — publiczne dane blockchain przez dostawców modułu @olcys/chain',
  www: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 1 (wnioski: `live-www`) — jedna strona, robots.txt respektowany',
  rdap: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 10 „Rozwijanie sieci na żądanie” — RDAP (RFC 9082/9083/9224, rejestry domen)',
  registries: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 9 — rejestry organizacji (KRS, Wikidata, GLEIF) używane przez sieć organizacji',
  ofac: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 4 — OFAC SDN (kopia lokalna, sprawdzenie bez zapytań)',
  sanctions: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 4 i 10 — listy sankcyjne (OFAC SDN kopia lokalna; moduł oficjalnych list; dopasowanie lokalne)',
  local: 'przetwarzanie lokalne kopii treści zapisanych w analizie — bez nowych zapytań',
} as const;

/** Łącznik z danych demonstracyjnych (piaskownica, laboratorium) — wynik oznaczony jako syntetyczny. */
export const isSyntheticConnector = (id: string): boolean => id.startsWith('sandbox-') || id.startsWith('lab-');

/** Wywołuje łącznik z dziennikiem rozwinięcia; błąd łącznika nie przerywa rozwinięcia. */
export async function searchConnector(connector: SourceConnector, identifier: Parameters<SourceConnector['search']>[0], context: ExpandContext) {
  return connector.search(identifier, { log: (message) => context.log(`[${connector.id}] ${message}`), ...(context.signal ? { signal: context.signal } : {}) });
}
