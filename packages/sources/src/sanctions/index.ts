// Oficjalne listy ryzyka: listy sankcyjne (OFAC SDN, UE, Wielka Brytania, MSWiA), lista ostrzeżeń
// publicznych KNF i unijna lista państw trzecich wysokiego ryzyka. Sprawdzenie działa w całości LOKALNIE,
// na migawkach z katalogu data/ (odświeżanie: `node packages/sources/src/sanctions/odswiez.ts`) — nazwa,
// identyfikator ani adres nie opuszczają systemu. Podstawa prawna każdej listy: docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 9.
//
// To jedyna droga, którą narzędzie „dochodzi” do organizacji przestępczych i podmiotów objętych sankcjami:
// z list urzędowych, z zastrzeżeniem, że zgodność nazwy nie jest ustaleniem tożsamości.

import { readFileSync } from 'node:fs';
import type { GraphEdge, GraphNode, Identifier, SourceConnector, SourceDocument } from '@olcys/core';
// Moduł list ryzyka w `@olcys/core` (do czasu dopisania eksportu w packages/core/src/index.ts — import względny).
import {
  buildRiskIndex,
  findListedAddresses,
  matchRiskLists as matchInIndex,
} from '../../../core/src/sanctions/index.ts';
import type {
  MatchOptions,
  RiskAddressHit,
  RiskListEntry,
  RiskListIndex,
  RiskListMatch,
  RiskListQuery,
  RiskListResult,
  RiskListSnapshot,
} from '../../../core/src/sanctions/index.ts';
import type { KnfSnapshot } from '../search/registries.ts';
import { KNF_PAGE } from '../search/registries.ts';
import { compactEntry, dedupeNames } from './parse.ts';

export type {
  JurisdictionRisk,
  MatchOptions,
  RiskAddressHit,
  RiskListEntry,
  RiskListId,
  RiskListIndex,
  RiskListMatch,
  RiskListQuery,
  RiskListResult,
  RiskListSnapshot,
  RiskMatchStrength,
} from '../../../core/src/sanctions/index.ts';
export { IDENTIFIER_MATCH_CAVEAT, NAME_MATCH_CAVEAT, WARNING_LIST_CAVEAT, buildRiskIndex } from '../../../core/src/sanctions/index.ts';

export const RISK_LISTS_ID = 'listy-sankcyjne';
const LABEL = 'Listy sankcyjne i ostrzeżenia (OFAC, UE, UK, MSWiA, KNF)';

/** Pliki migawek w katalogu data/ (tworzy je `odswiez.ts`). */
export const SNAPSHOT_FILES = {
  'ofac-sdn': 'ofac-sdn.json',
  'ue-fsf': 'ue-fsf.json',
  'uk-sanctions': 'uk-sanctions.json',
  mswia: 'mswia.json',
  'ue-wysokie-ryzyko': 'ue-panstwa-wysokiego-ryzyka.json',
} as const;

const DATA_DIR = new URL('./data/', import.meta.url);
/** Istniejąca kopia adresów kryptowalutowych OFAC (packages/chain, odświeża `scripts/update-ofac.ts`). */
const OFAC_ADDRESSES_FILE = new URL('../../../chain/data/ofac-addresses.json', import.meta.url);
/** Istniejąca migawka listy ostrzeżeń KNF (łącznik `rejestry-publiczne`). */
const KNF_FILE = new URL('../search/data/knf-ostrzezenia.json', import.meta.url);

function readJson<T>(url: URL): T | undefined {
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

// ---------- OFAC: adresy kryptowalutowe z istniejącej kopii ----------

interface OfacAddressesFile {
  source?: string;
  fetchedAt?: string;
  addresses: { address: string; asset: string; entity: string }[];
}

/**
 * Dołącza adresy kryptowalutowe z `packages/chain/data/ofac-addresses.json` do wpisów SDN po nazwie
 * podmiotu (ta sama lista, ten sam zapis nazwy). Adres bez pasującego wpisu dostaje osobny wpis.
 */
export function attachOfacAddresses(snapshot: RiskListSnapshot, file: OfacAddressesFile | undefined): RiskListSnapshot {
  if (!file || !Array.isArray(file.addresses) || file.addresses.length === 0) return snapshot;
  const byName = new Map<string, number>();
  snapshot.entries.forEach((entry, index) => {
    const key = entry.names[0]?.toUpperCase();
    if (key && !byName.has(key)) byName.set(key, index);
  });
  const entries = snapshot.entries.map((entry) => ({ ...entry }));
  const orphans = new Map<string, RiskListEntry>();
  for (const item of file.addresses) {
    const index = byName.get(item.entity.toUpperCase());
    const crypto = { asset: item.asset, address: item.address };
    if (index !== undefined) {
      entries[index]!.crypto = [...(entries[index]!.crypto ?? []), crypto];
      continue;
    }
    const orphan = orphans.get(item.entity) ?? { id: `adres:${item.entity}`, type: 'unknown' as const, names: [item.entity], crypto: [] };
    orphan.crypto!.push(crypto);
    orphans.set(item.entity, orphan);
  }
  return { ...snapshot, entries: [...entries, ...orphans.values()] };
}

// ---------- KNF: ponowne użycie migawki łącznika `rejestry-publiczne` ----------

/** Nazwa wpisu KNF bez dopisków „z siedzibą w …”; nazwa w nawiasie „(obecnie – …)” jako alias. */
export function knfNames(nazwa: string): string[] {
  const line = nazwa
    .split('\n')[0]!
    .replace(/[„”"]/g, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
  // Bez `\b` — po „ą” granica słowa w wyrażeniu bez flagi `u` nie działa.
  const withoutSeat = line.replace(/(?:,\s*|\s+)(?:z siedzibą|z siedzibą przy|prowadząc[ay]|administrator)(?:\s|,|$).*$/i, '').trim();
  const aliases = [...withoutSeat.matchAll(/\((?:obecnie|dawniej|nazwa handlowa)\s*[-–:]?\s*([^)]+)\)/gi)].map((match) => match[1]!.trim());
  const base = withoutSeat.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  // Długie opisy („Platforma inwestycyjna posługująca się adresem …”) nie są nazwą — zostają tylko domeny.
  const names = base.split(' ').length <= 12 ? [base, ...aliases] : aliases;
  return dedupeNames(names);
}

function knfIdentifiers(text: string): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  for (const match of text.matchAll(/\b(KRS|NIP|REGON)[:\s]*([\d\s-]{6,17})/gi)) {
    let value = match[2]!.replace(/[\s-]/g, '');
    if (match[1]!.toUpperCase() === 'KRS' && value.length < 10) value = value.padStart(10, '0');
    out.push({ kind: match[1]!.toUpperCase(), value });
  }
  return out;
}

const knfDomains = (text: string): { kind: string; value: string }[] =>
  [...new Set([...text.matchAll(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b/gi)].map((match) => match[1]!.toLowerCase()))]
    .filter((domain) => !/^(sp|z|o|s)\.[a-z]$/.test(domain))
    .map((value) => ({ kind: 'domena', value }));

/** Lista ostrzeżeń KNF jako lista ryzyka (rodzaj `warning`, nie sankcje). */
export function knfRiskList(knf: KnfSnapshot): RiskListSnapshot {
  const entries: RiskListEntry[] = [];
  knf.wpisy.forEach((entry, index) => {
    const names = knfNames(entry.nazwa);
    const ids = [...knfIdentifiers(entry.identyfikatory), ...knfDomains(entry.nazwa)];
    if (names.length === 0 && ids.length === 0) return;
    const description = entry.nazwa.split('\n')[0]!.slice(0, 120);
    entries.push(
      compactEntry({
        id: `${index + 1}`,
        type: 'unknown',
        // Opis zamiast nazwy (np. „Platforma inwestycyjna posługująca się adresem …”) — nie jest porównywany jako nazwa.
        names,
        programmes: [entry.sekcja.slice(0, 160)],
        ids,
        url: `${knf.strona}#${index + 1}`,
        note: names.length > 0 ? (entry.prokuratura ? `prokuratura: ${entry.prokuratura}` : '') : description,
      }),
    );
  });
  return {
    list: 'knf',
    label: 'Lista ostrzeżeń publicznych KNF',
    authority: 'Komisja Nadzoru Finansowego',
    source: knf.strona || KNF_PAGE,
    page: knf.strona || KNF_PAGE,
    retrievedAt: knf.pobrano,
    licence: 'nota prawna KNF: wykorzystanie z podaniem źródła',
    kind: 'warning',
    entries,
  };
}

// ---------- Wczytanie ----------

export interface RiskListsOptions {
  /** Migawki zamiast plików z katalogu data/ (testy). */
  snapshots?: RiskListSnapshot[];
  /** Czy dołączyć listę ostrzeżeń KNF z migawki łącznika `rejestry-publiczne` (domyślnie tak). */
  includeKnf?: boolean;
}

export interface LoadedRiskLists {
  index: RiskListIndex;
  snapshots: RiskListSnapshot[];
  /** Listy, których migawki brakuje. */
  missing: string[];
}

/** Wczytuje migawki z dysku (bez sieci). Brakująca migawka nie jest błędem — trafia do `missing`. */
export function loadRiskLists(options: RiskListsOptions = {}): LoadedRiskLists {
  if (options.snapshots) return { index: buildRiskIndex(options.snapshots), snapshots: options.snapshots, missing: [] };
  const snapshots: RiskListSnapshot[] = [];
  const missing: string[] = [];
  for (const [list, file] of Object.entries(SNAPSHOT_FILES)) {
    let snapshot = readJson<RiskListSnapshot>(new URL(file, DATA_DIR));
    if (!snapshot || !Array.isArray(snapshot.entries)) {
      missing.push(list);
      continue;
    }
    if (list === 'ofac-sdn') snapshot = attachOfacAddresses(snapshot, readJson<OfacAddressesFile>(OFAC_ADDRESSES_FILE));
    snapshots.push(snapshot);
  }
  if (options.includeKnf !== false) {
    const knf = readJson<KnfSnapshot>(KNF_FILE);
    if (knf && Array.isArray(knf.wpisy)) snapshots.push(knfRiskList(knf));
    else missing.push('knf');
  }
  return { index: buildRiskIndex(snapshots), snapshots, missing };
}

let defaultLists: LoadedRiskLists | undefined;

/** Migawki wczytane raz na proces (kilka sekund przy pierwszym wywołaniu, potem z pamięci). */
export function getDefaultRiskLists(): LoadedRiskLists {
  defaultLists ??= loadRiskLists();
  return defaultLists;
}

/** Sprawdza osobę lub organizację we wszystkich listach (domyślnie w migawkach z dysku). */
export function matchRiskLists(query: RiskListQuery, lists: LoadedRiskLists = getDefaultRiskLists(), options: MatchOptions = {}): RiskListResult {
  return matchInIndex(query, lists.index, options);
}

// ---------- Pomocnicze API dla teczki i sieci powiązań ----------

/** Węzeł sieci powiązań do sprawdzenia: osoba albo organizacja z cechami ustalonymi w sprawie. */
export interface RiskNodeInput {
  id: string;
  kind: 'person' | 'organization';
  name: string;
  aliases?: string[];
  country?: string;
  birthDate?: string;
  identifiers?: { kind: string; value: string }[];
  cryptoAddresses?: string[];
}

export interface RiskNodeFlag {
  nodeId: string;
  /** Odznaka na węźle grafu: „lista sankcyjna” albo „ostrzeżenie KNF”. */
  badge: 'lista sankcyjna' | 'ostrzeżenie KNF';
  /**
   * `source_fact` — identyfikator albo adres węzła figuruje na liście (fakt o liście);
   * `hypothesis` — zgodność nazwy (silna albo słaba) do weryfikacji przez analityka.
   */
  status: 'source_fact' | 'hypothesis';
  confidence: 'strong' | 'weak';
  /** Jedno zdanie dla analityka. */
  summary: string;
  matches: RiskListMatch[];
  caveat: string;
}

export interface CheckNodesOptions extends MatchOptions {
  lists?: LoadedRiskLists;
  /** Czy zwracać także dopasowania słabe (sama nazwa). Domyślnie tak — z odznaką, ale statusem hipotezy. */
  includeWeak?: boolean;
}

/**
 * Sprawdza osoby i organizacje z sieci powiązań. Zwraca tylko węzły z co najmniej jednym dopasowaniem,
 * w kolejności wejścia. Wynik nie zmienia wskaźników sprawy — to informacja do weryfikacji.
 */
export function checkNetworkNodes(nodes: RiskNodeInput[], options: CheckNodesOptions = {}): RiskNodeFlag[] {
  const lists = options.lists ?? getDefaultRiskLists();
  const flags: RiskNodeFlag[] = [];
  for (const node of nodes) {
    const result = matchInIndex(
      {
        name: node.name,
        type: node.kind,
        ...(node.aliases ? { aliases: node.aliases } : {}),
        ...(node.country ? { country: node.country } : {}),
        ...(node.birthDate ? { birthDate: node.birthDate } : {}),
        ...(node.identifiers ? { identifiers: node.identifiers } : {}),
        ...(node.cryptoAddresses ? { cryptoAddresses: node.cryptoAddresses } : {}),
      },
      lists.index,
      { limit: options.limit ?? 5, ...(options.skipDelisted ? { skipDelisted: true } : {}) },
    );
    const matches = options.includeWeak === false ? result.matches.filter((match) => match.confidence === 'strong') : result.matches;
    const top = matches[0];
    if (!top) continue;
    const sanction = matches.find((match) => match.listKind === 'sanctions');
    const lead = sanction ?? top;
    const fact = lead.strength === 'exact_identifier';
    flags.push({
      nodeId: node.id,
      badge: sanction ? 'lista sankcyjna' : 'ostrzeżenie KNF',
      status: fact ? 'source_fact' : 'hypothesis',
      confidence: lead.confidence,
      summary: fact
        ? `${lead.matchedOn} figuruje na liście: ${lead.listLabel}, wpis ${lead.entryId} („${lead.entryName}”).`
        : `Nazwa „${node.name}” ${lead.strength === 'exact_name' ? 'zgodna' : 'podobna'} z wpisem ${lead.listLabel} ${lead.entryId} („${lead.entryName}”) — ` +
          (lead.confidence === 'strong' ? `potwierdza ją: ${lead.corroboration.join('; ')}.` : 'bez drugiej zgodnej cechy: możliwy imiennik.'),
      matches,
      caveat: lead.caveat,
    });
  }
  return flags;
}

/** Flaga adresu kryptowalutowego z listy — status `source_fact` (fakt o liście). */
export interface RiskAddressFlag extends RiskAddressHit {
  status: 'source_fact';
  /** Np. „adres na liście sankcyjnej OFAC SDN”. */
  label: string;
  caveat: string;
}

/**
 * Hak dla danych blockchain: każdy adres sprawy lub sieci (badany adres, kontrahenci, adresy klastra)
 * porównany z adresami kryptowalutowymi list (OFAC — z kopii w packages/chain, UK — z treści wpisów).
 * Adresy EVM bez rozróżniania wielkości liter, pozostałe dokładnie.
 */
export function riskListAddressFlags(addresses: string[], lists: LoadedRiskLists = getDefaultRiskLists()): RiskAddressFlag[] {
  return findListedAddresses(addresses, lists.index).map((hit) => ({
    ...hit,
    status: 'source_fact' as const,
    label: `adres na liście sankcyjnej ${hit.listLabel}`,
    caveat:
      `Adres figuruje na liście (${hit.listLabel}, wpis ${hit.entryId}: „${hit.entryName}”, waluta ${hit.asset}; migawka z ${hit.retrievedAt.slice(0, 10)}). ` +
      'To fakt o liście, nie ustalenie, kto dziś dysponuje adresem; potwierdź w aktualnej wersji listy.',
  }));
}

// ---------- Graf teczki: węzły wpisów list i krawędzie trafień ----------

/** Węzeł wpisu listy w kształcie węzła grafu teczki / sieci (`meta.sanctioned` jak w apps/api/src/network). */
export type RiskGraphNode = GraphNode & { meta: { sanctioned: { list: string; entryId: string } } };

/** Krawędź węzeł sprawy → wpis listy (`relation` jak w `NetworkRelation` z `@olcys/core`). */
export type RiskGraphEdge = GraphEdge & { relation: 'sanctions_hit' | 'sanctions_name_match'; strength: number };

export interface RiskGraphOptions {
  lists?: LoadedRiskLists;
  /** Czy dodawać do grafu słabe dopasowania nazwy (domyślnie nie — imiennicy zaśmiecaliby graf). */
  includeWeak?: boolean;
  /** Cechy węzłów osób / organizacji ustalone w sprawie (państwo, data urodzenia, numery) — klucz: id węzła. */
  attributes?: Record<string, Pick<RiskNodeInput, 'country' | 'birthDate' | 'identifiers' | 'aliases'>>;
}

export interface RiskGraphResult {
  nodes: RiskGraphNode[];
  edges: RiskGraphEdge[];
  /** Odznaki dla istniejących węzłów grafu: id węzła → opis trafienia. */
  badges: Record<string, { badge: 'lista sankcyjna' | 'ostrzeżenie KNF'; status: 'source_fact' | 'hypothesis'; confidence: 'strong' | 'weak'; summary: string; caveat: string }>;
}

/** Adres z identyfikatora węzła `addr:<sieć>:<adres>`. */
const addressOfNode = (node: GraphNode): string | undefined => (node.kind === 'address' && node.id.startsWith('addr:') ? node.id.split(':').slice(2).join(':') || undefined : undefined);

/** E-mail z identyfikatora węzła `id:email:<adres>`. */
const emailOfNode = (node: GraphNode): string | undefined => (node.kind === 'identifier' && /^id:email:/i.test(node.id) ? node.id.slice('id:email:'.length) : undefined);

/**
 * Sprawdza węzły grafu teczki (adresy, e-maile, organizacje, osoby) i zwraca węzły wpisów list z krawędziami
 * `sanctions_hit` (identyfikator — fakt o liście) albo `sanctions_name_match` (nazwa — hipoteza). Wpis listy jest
 * osobnym węzłem: trafienie dotyczy WYŁĄCZNIE bytu z listy; węzeł sprawy dostaje tylko odznakę i krawędź.
 */
export function riskListGraph(graph: { nodes: GraphNode[] }, options: RiskGraphOptions = {}): RiskGraphResult {
  const lists = options.lists ?? getDefaultRiskLists();
  const nodes = new Map<string, RiskGraphNode>();
  const edges: RiskGraphEdge[] = [];
  const badges: RiskGraphResult['badges'] = {};
  const entryNode = (match: { list: string; listLabel: string; entryId: string; entryName: string; entryType?: string; url?: string; page: string }): string => {
    const id = `sankcje:${match.list}:${match.entryId}`;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: match.entryType === 'person' ? 'person' : 'organization',
        label: match.entryName,
        sublabel: `wpis na liście: ${match.listLabel}`,
        status: 'source_fact',
        url: match.url ?? match.page,
        meta: { sanctioned: { list: match.listLabel, entryId: match.entryId } },
      });
    }
    return id;
  };

  for (const node of graph.nodes) {
    const address = addressOfNode(node);
    if (address) {
      for (const hit of findListedAddresses([address], lists.index)) {
        const target = entryNode({ ...hit, entryType: 'organization' });
        // Ten sam wpis z kilkoma walutami (np. ETH i USDT pod jednym adresem EVM) — jedna krawędź.
        if (edges.some((edge) => edge.id === `sankcje:${node.id}->${target}`)) continue;
        const caveat = `Adres figuruje na liście (${hit.listLabel}, wpis ${hit.entryId}) — fakt o liście, nie ustalenie, kto dziś dysponuje adresem.`;
        edges.push({
          id: `sankcje:${node.id}->${target}`,
          from: node.id,
          to: target,
          kind: 'documented_by',
          label: `adres na liście sankcyjnej ${hit.listLabel}`,
          relation: 'sanctions_hit',
          strength: 1,
          weight: 100,
          status: 'source_fact',
          explanation: caveat,
          evidence: [
            { kind: 'address', value: address },
            { kind: 'url', value: hit.url ?? hit.page },
            { kind: 'attribute', value: `${hit.listLabel}: ${hit.entryId} (${hit.asset}), migawka ${hit.retrievedAt.slice(0, 10)}` },
          ],
          layer: 'identity',
        });
        badges[node.id] = { badge: 'lista sankcyjna', status: 'source_fact', confidence: 'strong', summary: `adres na liście sankcyjnej ${hit.listLabel}`, caveat };
      }
      continue;
    }
    const email = emailOfNode(node);
    const kind = node.kind === 'person' || node.kind === 'organization' ? node.kind : undefined;
    if (!kind && !email) continue;
    const attributes = options.attributes?.[node.id];
    const [flag] = checkNetworkNodes(
      [
        {
          id: node.id,
          kind: kind ?? 'person',
          name: kind ? node.label : '',
          ...(attributes?.aliases ? { aliases: attributes.aliases } : {}),
          ...(attributes?.country ? { country: attributes.country } : {}),
          ...(attributes?.birthDate ? { birthDate: attributes.birthDate } : {}),
          identifiers: [...(attributes?.identifiers ?? []), ...(email ? [{ kind: 'e-mail', value: email }] : [])],
        },
      ],
      { lists, includeWeak: options.includeWeak ?? false, limit: 3 },
    );
    if (!flag) continue;
    for (const match of flag.matches) {
      if (match.confidence === 'weak' && !options.includeWeak) continue;
      const target = entryNode(match);
      if (edges.some((edge) => edge.id === `sankcje:${node.id}->${target}`)) continue;
      const fact = match.strength === 'exact_identifier';
      edges.push({
        id: `sankcje:${node.id}->${target}`,
        from: node.id,
        to: target,
        kind: 'documented_by',
        label: fact ? `identyfikator na liście ${match.listLabel}` : `nazwa ${match.strength === 'exact_name' ? 'zgodna' : 'podobna'} z wpisem ${match.listLabel}`,
        relation: fact ? 'sanctions_hit' : 'sanctions_name_match',
        strength: fact ? 1 : match.confidence === 'strong' ? 0.6 : 0.3,
        weight: fact ? 100 : match.score,
        status: fact ? 'source_fact' : 'hypothesis',
        ...(fact ? {} : { inferred: true }),
        explanation: `${match.reasons.join('; ')}. ${match.caveat}`,
        evidence: [
          { kind: 'url', value: match.url ?? match.page },
          { kind: 'attribute', value: `${match.listLabel}: ${match.entryId} — ${match.matchedOn}` },
        ],
        layer: 'identity',
      });
    }
    badges[node.id] = { badge: flag.badge, status: flag.status, confidence: flag.confidence, summary: flag.summary, caveat: flag.caveat };
  }
  return { nodes: [...nodes.values()], edges, badges };
}

// ---------- Zgodność z adapterem ekspandera „listy-sankcyjne” (apps/api/src/network/sanctions.ts) ----------

/** Wejście adaptera `discoverSanctionsModules`: nazwy, adresy z siecią, identyfikatory jako tekst. */
export interface ScreenSanctionsInput {
  names?: string[];
  addresses?: { network?: string; address: string }[];
  /** E-mail, „NIP 1234567890”, „KRS 0000123456”, numer paszportu… */
  identifiers?: string[];
  type?: 'person' | 'organization';
  country?: string;
  birthDate?: string;
}

/** Wiersz wyniku w kształcie czytanym przez adapter (`list`, `entryId`, `entryName`, `type`, `match`, `matchedValue`, `url`). */
export interface ScreenSanctionsRow {
  /** Nazwa listy dla analityka. */
  list: string;
  listId: string;
  listKind: RiskListSnapshot['kind'];
  entryId: string;
  entryName: string;
  type: 'person' | 'organization' | 'unknown';
  /** `exact_identifier` — fakt o liście; `exact_name` / `fuzzy_name` — hipoteza (możliwy imiennik). */
  match: RiskListMatch['strength'];
  confidence: RiskListMatch['confidence'];
  matchedValue: string;
  url?: string;
  listDate: string;
  programs: string[];
  reasons: string[];
  caveat: string;
}

/**
 * Sprawdzenie bytu sieci we wszystkich listach naraz — funkcja wykrywana przez ekspander „listy-sankcyjne”
 * (`discoverSanctionsModules` szuka eksportu `screenSanctions` w `@olcys/sources`). Lokalnie, bez sieci.
 */
export function screenSanctions(input: ScreenSanctionsInput, lists: LoadedRiskLists = getDefaultRiskLists()): ScreenSanctionsRow[] {
  const names = (input.names ?? []).filter((name) => name && name.trim());
  const result = matchInIndex(
    {
      ...(names[0] ? { name: names[0] } : {}),
      ...(names.length > 1 ? { aliases: names.slice(1) } : {}),
      ...(input.type ? { type: input.type } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.birthDate ? { birthDate: input.birthDate } : {}),
      identifiers: (input.identifiers ?? []).map((value) => identifierFromValue(value) ?? { kind: 'identyfikator', value }),
      cryptoAddresses: (input.addresses ?? []).map((item) => item.address),
    },
    lists.index,
    { limit: 10 },
  );
  return result.matches.map((match) => ({
    list: match.listLabel,
    listId: match.list,
    listKind: match.listKind,
    entryId: match.entryId,
    entryName: match.entryName,
    type: match.entryType,
    match: match.strength,
    confidence: match.confidence,
    matchedValue: match.matchedOn,
    ...(match.url ? { url: match.url } : {}),
    listDate: match.retrievedAt.slice(0, 10),
    programs: match.programmes,
    reasons: match.reasons,
    caveat: match.caveat,
  }));
}

// ---------- Łącznik (sprawdzenie lokalne, jak `rejestry-publiczne`) ----------

const LIST_SERVICE: Record<string, string> = {
  'ofac-sdn': 'ofac.treasury.gov',
  'ue-fsf': 'europa.eu',
  'uk-sanctions': 'gov.uk',
  mswia: 'gov.pl',
  knf: 'knf.gov.pl',
};

const MAX_DOCUMENTS = 10;

/** Numer rejestrowy podany jako identyfikator: „NIP 9492254431”, „KRS 0000965303”, „PESEL …”. */
function identifierFromValue(value: string): { kind: string; value: string } | undefined {
  const match = /^(NIP|KRS|REGON|PESEL|paszport|passport)[\s:]*([A-Z0-9\s-]{6,20})$/i.exec(value.trim());
  return match ? { kind: match[1]!.toUpperCase(), value: match[2]!.replace(/[\s-]/g, '') } : undefined;
}

export interface RiskListsConnectorOptions {
  lists?: LoadedRiskLists;
}

/**
 * Łącznik `listy-sankcyjne`: imię i nazwisko, nazwa organizacji albo numer (NIP, KRS, PESEL, paszport)
 * sprawdzane lokalnie w migawkach list. Adresów kryptowalutowych łącznik nie przyjmuje — dokument
 * z adresem zostałby potraktowany jak publikacja adresu przez podmiot; adresy sprawdza `riskListAddressFlags`.
 */
export function createRiskListsConnector(options: RiskListsConnectorOptions = {}): SourceConnector {
  let lists = options.lists;
  return {
    id: RISK_LISTS_ID,
    service: 'listy-sankcyjne',
    label: LABEL,
    description:
      'Sprawdzenie LOKALNE (zapytanie nie opuszcza systemu) w migawkach oficjalnych list: OFAC SDN (Departament Skarbu USA), ' +
      'skonsolidowana lista sankcji finansowych UE, UK Sanctions List (FCDO), lista osób i podmiotów objętych sankcjami MSWiA ' +
      '(ustawa z 13.04.2022) i lista ostrzeżeń publicznych KNF. Parametry: numer (NIP, KRS, REGON, PESEL, paszport) — zgodność dokładna; ' +
      'nazwa — zgodność po ujednoliceniu zapisu (wielkość liter, znaki diakrytyczne, cyrylica → łacinka, kolejność słów, forma prawna) ' +
      'albo podobieństwo co najmniej 90% (tylko nazwy z co najmniej dwóch słów, razem 10 znaków). Nick — tylko zgodność pełna. ' +
      `Najwyżej ${MAX_DOCUMENTS} wpisów. Zgodność samej nazwy NIE oznacza tożsamości (imiennicy); data migawki jest w treści każdego wpisu.`,
    accepts: ['full_name', 'nick'],
    enabledByDefault: true,

    async search(identifier: Identifier, context) {
      lists ??= getDefaultRiskLists();
      if (lists.missing.length > 0) context.log(`${LABEL}: brak migawki — ${lists.missing.join(', ')}.`);
      const id = identifierFromValue(identifier.value);
      const query: RiskListQuery = id ? { identifiers: [id] } : { name: identifier.value };
      const result = matchInIndex(query, lists.index, { limit: MAX_DOCUMENTS });
      for (const note of result.notes) context.log(`${LABEL}: ${note}`);
      const matches = identifier.type === 'nick' ? result.matches.filter((match) => match.strength !== 'fuzzy_name') : result.matches;
      const fetchedAt = new Date().toISOString();
      const documents: SourceDocument[] = matches.map((match) => ({
        connectorId: RISK_LISTS_ID,
        service: LIST_SERVICE[match.list] ?? 'listy-sankcyjne',
        url: match.url ?? match.page,
        title: `${match.listLabel}: ${match.entryName} (wpis ${match.entryId})`,
        fetchedAt,
        ...(match.listedOn ? { publishedAt: `${match.listedOn}T00:00:00.000Z` } : {}),
        category: 'forum_post' as const,
        identityMatch: match.strength === 'exact_identifier' ? ('exact_identifier' as const) : ('name_only' as const),
        matchedIdentifier: identifier,
        text: [
          `Wpis na oficjalnej liście — ${match.listLabel}. Migawka lokalna pobrana ${match.retrievedAt.slice(0, 10)}; lista: ${match.page}.`,
          `Rodzaj dopasowania: ${match.strength === 'exact_identifier' ? 'identyfikator' : match.strength === 'exact_name' ? 'pełna zgodność nazwy' : 'nazwa podobna'}` +
            ` (${match.confidence === 'strong' ? 'silne' : 'słabe'}, ${match.score}%).`,
          ...match.reasons.map((reason) => `Uzasadnienie: ${reason}.`),
          `Wpis: ${match.entryName} (${match.entryType === 'person' ? 'osoba' : match.entryType === 'organization' ? 'podmiot' : 'rodzaj nieokreślony'})`,
          match.programmes.length > 0 ? `Program / podstawa: ${match.programmes.join('; ')}` : '',
          match.listedOn ? `Data umieszczenia na liście: ${match.listedOn}` : '',
          match.delistedOn ? `Data wykreślenia: ${match.delistedOn}` : '',
          match.unRef ? `Numer wpisu Rady Bezpieczeństwa ONZ: ${match.unRef}` : '',
          `Zastrzeżenie: ${match.caveat}`,
        ]
          .filter(Boolean)
          .join('\n'),
      }));
      context.log(`${LABEL}: „${identifier.value}” — ${documents.length} wpisów (sprawdzenie lokalne).`);
      return documents;
    },
  };
}
