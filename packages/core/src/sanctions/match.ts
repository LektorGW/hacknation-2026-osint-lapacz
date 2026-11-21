// Dopasowanie osób, organizacji, identyfikatorów i adresów kryptowalutowych do oficjalnych list ryzyka
// (listy sankcyjne, ostrzeżenia publiczne, państwa trzecie wysokiego ryzyka). Funkcje są czyste
// i deterministyczne: listy przekazuje wywołujący (migawki wczytuje `@olcys/sources`).
//
// Zasada dowodowa: zgodność samej nazwy NIE oznacza tożsamości (imiennicy). Dopasowanie po nazwie jest
// „silne” dopiero wtedy, gdy zgadza się co najmniej jedna dodatkowa cecha (państwo, data urodzenia,
// identyfikator), a nic nie jest sprzeczne. Zgodność identyfikatora albo adresu kryptowalutowego jest
// faktem o liście („ten identyfikator figuruje na liście”), nie ustaleniem, kto nim dysponuje.

import {
  countryCode,
  cryptoAddressKey,
  foldText,
  identifierVariants,
  isDistinctiveToken,
  isEvmAddress,
  nameTokens,
  skeleton,
  tokenSimilarity,
} from './text.ts';

// ---------- Kształt list ----------

/** Identyfikator listy w migawkach. */
export type RiskListId = 'ofac-sdn' | 'ue-fsf' | 'uk-sanctions' | 'mswia' | 'knf' | 'ue-wysokie-ryzyko' | (string & {});

export type RiskEntryType = 'person' | 'organization' | 'unknown';

/** Jeden wpis listy w postaci wspólnej dla wszystkich źródeł. */
export interface RiskListEntry {
  /** Identyfikator wpisu na liście (np. `36` w OFAC, `EU.27.28` w UE, `RUS0627` w UK). */
  id: string;
  type: RiskEntryType;
  /** Nazwy: pierwsza to nazwa główna, dalej aliasy dobrej jakości i zapisy w innych alfabetach. */
  names: string[];
  /** Aliasy słabej jakości („weak a.k.a.”, „Low quality a.k.a.”) — dopasowanie zawsze słabe. */
  weakNames?: string[];
  /** Program lub reżim sankcyjny (np. `SDGT`, `RUS`, `The Russia (Sanctions) (EU Exit) Regulations 2019`). */
  programmes?: string[];
  /** Data umieszczenia na liście (ISO 8601, sama data). */
  listedOn?: string;
  /** Data wykreślenia (wpis historyczny). */
  delistedOn?: string;
  /** Daty urodzenia: `RRRR`, `RRRR-MM` albo `RRRR-MM-DD`. */
  birthDates?: string[];
  /** Państwa (ISO 3166-1 alfa-2): obywatelstwo, adres, siedziba, miejsce urodzenia. */
  countries?: string[];
  /** Identyfikatory urzędowe: rodzaj i numer (paszport, NIP, KRS, numer rejestrowy, e-mail, strona). */
  ids?: { kind: string; value: string }[];
  /** Adresy kryptowalutowe podane na liście. */
  crypto?: { asset: string; address: string }[];
  /** Numer referencyjny wpisu Rady Bezpieczeństwa ONZ, jeśli wpis pochodzi z listy ONZ. */
  unRef?: string;
  /** Adres do sprawdzenia wpisu (strona wpisu albo akt prawny). */
  url?: string;
  /** Krótka uwaga z listy (np. funkcja osoby, kategoria ostrzeżenia KNF). */
  note?: string;
}

/** Lista państw wysokiego ryzyka: wpis to państwo, nie osoba. */
export interface JurisdictionEntry {
  country: string;
  name: string;
  category: string;
}

export interface RiskListSnapshot {
  list: RiskListId;
  /** Nazwa listy pokazywana analitykowi. */
  label: string;
  /** Kto prowadzi listę. */
  authority: string;
  /** Adres pliku lub strony, z której zbudowano migawkę. */
  source: string;
  /** Strona listy do ręcznego sprawdzenia. */
  page: string;
  /** Szablon adresu wpisu z `{id}` — gdy wpis nie ma własnego `url` (mniejsza migawka). */
  entryUrl?: string;
  /** Czas pobrania (ISO 8601). */
  retrievedAt: string;
  /** Data publikacji / stan listy podany przez źródło. */
  publishedAt?: string;
  /** Licencja lub podstawa ponownego wykorzystania. */
  licence: string;
  /** `sanctions` — lista sankcyjna; `warning` — ostrzeżenia (nie sankcje); `jurisdiction` — państwa. */
  kind: 'sanctions' | 'warning' | 'jurisdiction';
  entries: RiskListEntry[];
  jurisdictions?: JurisdictionEntry[];
}

// ---------- Zapytanie i wynik ----------

export interface RiskListQuery {
  name?: string;
  aliases?: string[];
  /** Rodzaj węzła: osoba nie jest porównywana z wpisami organizacji i odwrotnie. */
  type?: 'person' | 'organization';
  /** Państwo (kod ISO albo nazwa polska / angielska). */
  country?: string;
  /** Data urodzenia `RRRR-MM-DD`, `RRRR-MM` albo `RRRR`. */
  birthDate?: string;
  identifiers?: { kind: string; value: string }[];
  cryptoAddresses?: string[];
}

export type RiskMatchStrength = 'exact_identifier' | 'exact_name' | 'fuzzy_name';

export interface RiskListMatch {
  list: RiskListId;
  listLabel: string;
  listKind: RiskListSnapshot['kind'];
  entryId: string;
  entryName: string;
  entryType: RiskEntryType;
  strength: RiskMatchStrength;
  /** `strong` — identyfikator albo nazwa potwierdzona drugą cechą bez sprzeczności; `weak` — wszystko inne. */
  confidence: 'strong' | 'weak';
  /** Podobieństwo nazwy 0–100 (100 dla identyfikatora i pełnej zgodności). */
  score: number;
  /** Co dokładnie się zgodziło: nazwa z listy albo wartość identyfikatora / adresu. */
  matchedOn: string;
  programmes: string[];
  listedOn?: string;
  delistedOn?: string;
  /** Cechy zgodne z zapytaniem (państwo, data urodzenia, identyfikator). */
  corroboration: string[];
  /** Cechy sprzeczne z zapytaniem. */
  conflicts: string[];
  reasons: string[];
  unRef?: string;
  url?: string;
  page: string;
  retrievedAt: string;
  /** Obowiązkowe zastrzeżenie dla analityka. */
  caveat: string;
}

export interface JurisdictionRisk {
  list: RiskListId;
  listLabel: string;
  country: string;
  name: string;
  category: string;
  page: string;
  retrievedAt: string;
}

export interface RiskListResult {
  matches: RiskListMatch[];
  /** Państwo z zapytania na liście państw wysokiego ryzyka (informacyjnie, nie dotyczy osoby). */
  jurisdictions: JurisdictionRisk[];
  /** Uwagi o samym sprawdzeniu (np. nazwa zbyt krótka do porównania). */
  notes: string[];
  /** Listy, w których sprawdzono, z datą migawki. */
  checked: { list: RiskListId; label: string; retrievedAt: string; entries: number }[];
}

export const NAME_MATCH_CAVEAT =
  'Zgodność nazwy NIE oznacza tożsamości — na listach są imiennicy i podmioty o podobnych nazwach. ' +
  'Dopasowanie jest silne tylko przy zgodnej drugiej cesze (państwo, data urodzenia, identyfikator) i braku sprzeczności; ' +
  'przed jakimkolwiek działaniem potwierdź wpis w aktualnej wersji listy u jej wydawcy.';

export const IDENTIFIER_MATCH_CAVEAT =
  'Identyfikator figuruje na liście — to fakt o liście, nie ustalenie, kto dziś dysponuje tym identyfikatorem. ' +
  'Migawka może być nieaktualna: potwierdź wpis w aktualnej wersji listy u jej wydawcy.';

export const WARNING_LIST_CAVEAT =
  'Lista ostrzeżeń publicznych KNF nie jest listą sankcyjną: wpis oznacza zawiadomienie o podejrzeniu przestępstwa, a nie ustalenie winy.';

// ---------- Indeks ----------

interface IndexedName {
  entry: number;
  /** Nazwa w oryginalnym zapisie. */
  original: string;
  tokens: string[];
  key: string;
  skeletonKey: string;
  skeletons: string[];
  weak: boolean;
}

interface IndexedList {
  snapshot: RiskListSnapshot;
  names: IndexedName[];
  /** słowo (złożone albo szkielet) → numery nazw */
  byToken: Map<string, number[]>;
  byIdentifier: Map<string, number[]>;
  byCrypto: Map<string, { entry: number; asset: string; address: string }[]>;
}

export interface RiskListIndex {
  lists: IndexedList[];
}

const sortedKey = (tokens: string[]): string => [...tokens].sort().join(' ');

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
};

/** Buduje indeks wyszukiwania; listy zachowują kolejność (wynik jest deterministyczny). */
export function buildRiskIndex(snapshots: RiskListSnapshot[]): RiskListIndex {
  const lists: IndexedList[] = [];
  for (const snapshot of snapshots) {
    const names: IndexedName[] = [];
    const byToken = new Map<string, number[]>();
    const byIdentifier = new Map<string, number[]>();
    const byCrypto = new Map<string, { entry: number; asset: string; address: string }[]>();
    snapshot.entries.forEach((entry, entryIndex) => {
      const seen = new Set<string>();
      const add = (original: string, weak: boolean) => {
        const tokens = nameTokens(original);
        if (tokens.length === 0) return;
        const key = sortedKey(tokens);
        if (seen.has(key)) return;
        seen.add(key);
        const skeletons = tokens.map(skeleton);
        const position = names.length;
        names.push({ entry: entryIndex, original, tokens, key, skeletonKey: sortedKey(skeletons), skeletons, weak });
        for (const token of new Set([...tokens, ...skeletons])) if (isDistinctiveToken(token)) pushTo(byToken, token, position);
      };
      for (const name of entry.names) add(name, false);
      for (const name of entry.weakNames ?? []) add(name, true);
      for (const id of entry.ids ?? []) {
        for (const variant of identifierVariants(id.value)) if (variant.length >= 6) pushTo(byIdentifier, variant, entryIndex);
      }
      for (const item of entry.crypto ?? []) pushTo(byCrypto, cryptoAddressKey(item.address), { entry: entryIndex, ...item });
    });
    lists.push({ snapshot, names, byToken, byIdentifier, byCrypto });
  }
  return { lists };
}

// ---------- Porównanie nazw ----------

/** Najkrótsza nazwa porównywana w ogóle (litery i cyfry bez spacji). */
export const MIN_NAME_CHARS = 4;
/** Najkrótsza nazwa porównywana w przybliżeniu. */
export const MIN_FUZZY_CHARS = 10;
/** Próg podobieństwa każdego słowa w dopasowaniu przybliżonym. */
export const FUZZY_TOKEN_THRESHOLD = 0.8;
/** Próg średniego podobieństwa nazwy w dopasowaniu przybliżonym. */
export const FUZZY_NAME_THRESHOLD = 0.9;

interface NameComparison {
  strength: 'exact_name' | 'fuzzy_name';
  score: number;
  reason: string;
}

interface PreparedName {
  original: string;
  tokens: string[];
  key: string;
  skeletons: string[];
  skeletonKey: string;
  chars: number;
  fuzzyAllowed: boolean;
}

function prepareName(original: string): PreparedName | { tooShort: string } | null {
  const tokens = nameTokens(original);
  if (tokens.length === 0) return null;
  const distinctive = tokens.filter(isDistinctiveToken);
  const chars = tokens.join('').length;
  if (distinctive.length === 0) return { tooShort: `„${original}” składa się wyłącznie ze słów ogólnych — nie porównano z listami.` };
  if (chars < MIN_NAME_CHARS || (tokens.length === 1 && chars < 5)) {
    return { tooShort: `„${original}” jest zbyt krótkie do porównania z listami (najmniej ${MIN_NAME_CHARS} znaki, jedno słowo — 5).` };
  }
  const skeletons = tokens.map(skeleton);
  const fuzzyAllowed = distinctive.length >= 2 && distinctive.every((token) => token.length >= 3) && distinctive.join('').length >= MIN_FUZZY_CHARS;
  return { original, tokens, key: sortedKey(tokens), skeletons, skeletonKey: sortedKey(skeletons), chars, fuzzyAllowed };
}

/** Słowa jednej nazwy zawarte w drugiej (z krotnością); zwraca nadmiarowe słowa dłuższej. */
function subsetRemainder(small: string[], large: string[]): string[] | null {
  const pool = [...large];
  for (const token of small) {
    const at = pool.indexOf(token);
    if (at < 0) return null;
    pool.splice(at, 1);
  }
  return pool;
}

/** Najlepsze dopasowanie słów zapytania do różnych słów wpisu (zachłannie, deterministycznie). */
function alignTokens(query: string[], entry: string[]): { average: number; minimum: number; unmatched: number } | null {
  const used = new Set<number>();
  let weighted = 0;
  let weights = 0;
  let minimum = 1;
  for (const token of [...query].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
    let best = -1;
    let bestSimilarity = 0;
    entry.forEach((candidate, index) => {
      if (used.has(index) || candidate[0] !== token[0]) return;
      const similarity = tokenSimilarity(token, candidate);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = index;
      }
    });
    if (best < 0) return null;
    used.add(best);
    weighted += bestSimilarity * token.length;
    weights += token.length;
    minimum = Math.min(minimum, bestSimilarity);
  }
  return { average: weights === 0 ? 0 : weighted / weights, minimum, unmatched: entry.length - used.size };
}

function compareNames(query: PreparedName, name: IndexedName, entryType: RiskEntryType): NameComparison | null {
  if (query.key === name.key) {
    const sameOrder = query.tokens.join(' ') === name.tokens.join(' ');
    return { strength: 'exact_name', score: 100, reason: sameOrder ? 'nazwa zgodna po ujednoliceniu zapisu (wielkość liter, znaki diakrytyczne, alfabet)' : 'nazwa zgodna przy innej kolejności słów' };
  }
  // Imię odojcowskie albo drugie imię: wpis „Evgeny Vasilievich REVENKO”, zapytanie „Evgeny Revenko”.
  if (entryType !== 'organization' && query.tokens.length >= 2 && name.tokens.length >= 2) {
    const extraInEntry = subsetRemainder(query.tokens, name.tokens);
    if (extraInEntry && extraInEntry.length === 1) {
      return { strength: 'exact_name', score: 95, reason: `zgodne wszystkie słowa zapytania; wpis zawiera dodatkowo „${extraInEntry[0]}” (np. imię odojcowskie lub drugie imię)` };
    }
    const extraInQuery = subsetRemainder(name.tokens, query.tokens);
    if (extraInQuery && extraInQuery.length === 1) {
      return { strength: 'exact_name', score: 95, reason: `zgodne wszystkie słowa wpisu; zapytanie zawiera dodatkowo „${extraInQuery[0]}”` };
    }
  }
  if (!query.fuzzyAllowed) return null;
  if (query.skeletonKey === name.skeletonKey) {
    return { strength: 'fuzzy_name', score: 97, reason: 'nazwa zgodna po ujednoliceniu wariantów transliteracji (np. ch/kh/cz, w/v, j/y)' };
  }
  const distinctiveQuery = query.skeletons.filter((token, index) => isDistinctiveToken(query.tokens[index]!));
  const alignment = alignTokens(distinctiveQuery, name.skeletons);
  if (!alignment) return null;
  // Wpis może mieć najwyżej jedno słowo więcej (imię odojcowskie) — tylko gdy każde słowo zapytania zgadza się
  // w szkielecie dokładnie; tolerancja literówek i dodatkowe słowo naraz to już zbyt luźne dopasowanie.
  // Organizacja — nigdy dodatkowego słowa.
  const allowedExtra = entryType === 'organization' || alignment.minimum < 1 ? 0 : 1;
  if (alignment.unmatched > allowedExtra + (query.tokens.length - distinctiveQuery.length)) return null;
  if (alignment.minimum < FUZZY_TOKEN_THRESHOLD || alignment.average < FUZZY_NAME_THRESHOLD) return null;
  return {
    strength: 'fuzzy_name',
    score: Math.round(alignment.average * 100),
    reason: `nazwa podobna (podobieństwo ${Math.round(alignment.average * 100)}%, każde słowo co najmniej ${Math.round(alignment.minimum * 100)}%)`,
  };
}

// ---------- Cechy dodatkowe ----------

/** Zgodność dat: `full` — ten sam dzień, `year` — zgodny tylko rok lub miesiąc, `conflict` — sprzeczne. */
function compareBirthDate(query: string | undefined, dates: string[] | undefined): 'full' | 'year' | 'conflict' | 'unknown' {
  if (!query || !dates || dates.length === 0) return 'unknown';
  const wanted = query.trim().slice(0, 10);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(wanted)) return 'unknown';
  let best: 'full' | 'year' | 'conflict' = 'conflict';
  for (const date of dates) {
    const shorter = date.length <= wanted.length ? date : wanted;
    const longer = date.length <= wanted.length ? wanted : date;
    if (!longer.startsWith(shorter)) continue;
    if (date.length === 10 && wanted.length === 10) return 'full';
    best = 'year';
  }
  return best;
}

interface Attributes {
  corroboration: string[];
  conflicts: string[];
}

function compareAttributes(query: RiskListQuery, entry: RiskListEntry, queryCountry: string | undefined, idHits: string[]): Attributes {
  const corroboration: string[] = [];
  const conflicts: string[] = [];
  if (queryCountry && entry.countries && entry.countries.length > 0) {
    if (entry.countries.includes(queryCountry)) corroboration.push(`państwo zgodne (${queryCountry})`);
    else conflicts.push(`państwo niezgodne: zapytanie ${queryCountry}, wpis ${entry.countries.join(', ')}`);
  }
  const birth = compareBirthDate(query.birthDate, entry.birthDates);
  if (birth === 'full') corroboration.push(`data urodzenia zgodna (${query.birthDate})`);
  else if (birth === 'year') corroboration.push(`zgodny rok / miesiąc urodzenia (wpis: ${entry.birthDates!.join(', ')})`);
  else if (birth === 'conflict') conflicts.push(`data urodzenia sprzeczna: zapytanie ${query.birthDate}, wpis ${entry.birthDates!.join(', ')}`);
  for (const hit of idHits) corroboration.push(`identyfikator zgodny (${hit})`);
  return { corroboration, conflicts };
}

// ---------- Dopasowanie ----------

export interface MatchOptions {
  /** Najwięcej dopasowań w wyniku (domyślnie 25). */
  limit?: number;
  /** Czy pomijać wpisy wykreślone (domyślnie nie — są oznaczone jako historyczne). */
  skipDelisted?: boolean;
}

/** Adres wpisu: własny albo z szablonu listy. */
function entryUrl(snapshot: RiskListSnapshot, entry: RiskListEntry): string | undefined {
  return entry.url ?? snapshot.entryUrl?.replace('{id}', encodeURIComponent(entry.id));
}

function baseMatch(list: IndexedList, entry: RiskListEntry): Omit<RiskListMatch, 'strength' | 'confidence' | 'score' | 'matchedOn' | 'corroboration' | 'conflicts' | 'reasons' | 'caveat'> {
  const snapshot = list.snapshot;
  const url = entryUrl(snapshot, entry);
  return {
    list: snapshot.list,
    listLabel: snapshot.label,
    listKind: snapshot.kind,
    entryId: entry.id,
    entryName: entry.names[0] ?? entry.weakNames?.[0] ?? entry.note ?? entry.id,
    entryType: entry.type,
    programmes: entry.programmes ?? [],
    ...(entry.listedOn ? { listedOn: entry.listedOn } : {}),
    ...(entry.delistedOn ? { delistedOn: entry.delistedOn } : {}),
    ...(entry.unRef ? { unRef: entry.unRef } : {}),
    ...(url ? { url } : {}),
    page: snapshot.page,
    retrievedAt: snapshot.retrievedAt,
  };
}

function caveatFor(list: IndexedList, strength: RiskMatchStrength): string {
  const base = strength === 'exact_identifier' ? IDENTIFIER_MATCH_CAVEAT : NAME_MATCH_CAVEAT;
  return list.snapshot.kind === 'warning' ? `${WARNING_LIST_CAVEAT} ${base}` : base;
}

const STRENGTH_ORDER: Record<RiskMatchStrength, number> = { exact_identifier: 0, exact_name: 1, fuzzy_name: 2 };

/**
 * Sprawdza osobę lub organizację w listach ryzyka. Kolejność wyników: identyfikator, pełna nazwa,
 * nazwa przybliżona; w każdej grupie najpierw dopasowania silne. Bez list (pusty indeks) — pusty wynik.
 */
export function matchRiskLists(query: RiskListQuery, index: RiskListIndex, options: MatchOptions = {}): RiskListResult {
  const notes: string[] = [];
  const queryCountry = countryCode(query.country);
  if (query.country && !queryCountry) notes.push(`Nie rozpoznano państwa „${query.country}” — pominięto je w porównaniu.`);

  const prepared: PreparedName[] = [];
  for (const raw of [query.name, ...(query.aliases ?? [])]) {
    if (!raw || !raw.trim()) continue;
    const name = prepareName(raw);
    if (!name) continue;
    if ('tooShort' in name) notes.push(name.tooShort);
    else if (!prepared.some((item) => item.key === name.key)) prepared.push(name);
  }

  const queryIds = new Map<string, string>();
  for (const id of query.identifiers ?? []) {
    for (const variant of identifierVariants(id.value)) if (variant.length >= 6) queryIds.set(variant, `${id.kind} ${id.value}`);
  }

  const matches: RiskListMatch[] = [];
  for (const list of index.lists) {
    const entries = list.snapshot.entries;
    // Wpis → najlepsze dopasowanie w tej liście.
    const best = new Map<number, RiskListMatch>();
    const keep = (entryIndex: number, match: RiskListMatch) => {
      const current = best.get(entryIndex);
      if (
        !current ||
        STRENGTH_ORDER[match.strength] < STRENGTH_ORDER[current.strength] ||
        (match.strength === current.strength && match.score > current.score)
      ) {
        best.set(entryIndex, match);
      }
    };
    const typeClash = (entry: RiskListEntry) => query.type !== undefined && entry.type !== 'unknown' && entry.type !== query.type;

    // Identyfikatory na liście, które pojawiły się w zapytaniu — dla każdego wpisu.
    const idHitsByEntry = new Map<number, string[]>();
    for (const [value, label] of queryIds) {
      for (const entryIndex of list.byIdentifier.get(value) ?? []) pushTo(idHitsByEntry, entryIndex, label);
    }

    for (const [entryIndex, hits] of idHitsByEntry) {
      const entry = entries[entryIndex]!;
      if (options.skipDelisted && entry.delistedOn) continue;
      const attributes = compareAttributes({ ...query, identifiers: [] }, entry, queryCountry, []);
      keep(entryIndex, {
        ...baseMatch(list, entry),
        strength: 'exact_identifier',
        confidence: 'strong',
        score: 100,
        matchedOn: hits[0]!,
        corroboration: attributes.corroboration,
        conflicts: attributes.conflicts,
        reasons: [`identyfikator z zapytania figuruje we wpisie: ${hits.join('; ')}`, ...(entry.delistedOn ? [`wpis wykreślony z listy ${entry.delistedOn} — dopasowanie historyczne`] : [])],
        caveat: caveatFor(list, 'exact_identifier'),
      });
    }

    for (const address of query.cryptoAddresses ?? []) {
      const key = cryptoAddressKey(address);
      for (const hit of list.byCrypto.get(key) ?? []) {
        const entry = entries[hit.entry]!;
        if (options.skipDelisted && entry.delistedOn) continue;
        const evm = isEvmAddress(address);
        keep(hit.entry, {
          ...baseMatch(list, entry),
          strength: 'exact_identifier',
          confidence: 'strong',
          score: 100,
          matchedOn: hit.address,
          corroboration: [],
          conflicts: [],
          reasons: [
            `adres ${address} figuruje na liście jako adres ${hit.asset} podmiotu „${entry.names[0] ?? entry.id}”`,
            evm
              ? 'adres EVM porównano bez rozróżniania wielkości liter; ta sama postać adresu występuje we wszystkich sieciach zgodnych z Ethereum — sprawdź, której sieci dotyczy wpis'
              : 'adres porównano dokładnie (z rozróżnieniem wielkości liter)',
            ...(entry.delistedOn ? [`wpis wykreślony z listy ${entry.delistedOn} — dopasowanie historyczne`] : []),
          ],
          caveat: caveatFor(list, 'exact_identifier'),
        });
      }
    }

    for (const name of prepared) {
      const candidates = new Set<number>();
      for (const token of new Set([...name.tokens, ...name.skeletons])) {
        if (!isDistinctiveToken(token)) continue;
        for (const position of list.byToken.get(token) ?? []) candidates.add(position);
      }
      for (const position of [...candidates].sort((a, b) => a - b)) {
        const indexed = list.names[position]!;
        const entry = entries[indexed.entry]!;
        if (typeClash(entry) || (options.skipDelisted && entry.delistedOn)) continue;
        const comparison = compareNames(name, indexed, entry.type);
        if (!comparison) continue;
        const attributes = compareAttributes(query, entry, queryCountry, idHitsByEntry.get(indexed.entry) ?? []);
        const supporting = attributes.corroboration.length;
        const strong =
          !indexed.weak &&
          attributes.conflicts.length === 0 &&
          !entry.delistedOn &&
          ((comparison.strength === 'exact_name' && supporting >= 1) || (comparison.strength === 'fuzzy_name' && supporting >= 2));
        const reasons = [
          `${comparison.reason}: „${name.original}” ~ „${indexed.original}”`,
          ...(indexed.weak ? ['alias słabej jakości według wydawcy listy — dopasowanie zawsze słabe'] : []),
          ...(supporting === 0 ? ['brak drugiej cechy (państwo, data urodzenia, identyfikator) — możliwy imiennik'] : []),
          ...(comparison.strength === 'fuzzy_name' && supporting === 1 ? ['nazwa przybliżona z jedną cechą zgodną — za mało na dopasowanie silne'] : []),
          ...(entry.delistedOn ? [`wpis wykreślony z listy ${entry.delistedOn} — dopasowanie historyczne`] : []),
        ];
        keep(indexed.entry, {
          ...baseMatch(list, entry),
          strength: comparison.strength,
          confidence: strong ? 'strong' : 'weak',
          score: comparison.score,
          matchedOn: indexed.original,
          corroboration: attributes.corroboration,
          conflicts: attributes.conflicts,
          reasons,
          caveat: caveatFor(list, comparison.strength),
        });
      }
    }
    matches.push(...best.values());
  }

  matches.sort(
    (a, b) =>
      STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] ||
      (a.confidence === b.confidence ? 0 : a.confidence === 'strong' ? -1 : 1) ||
      b.score - a.score ||
      a.list.localeCompare(b.list) ||
      a.entryId.localeCompare(b.entryId),
  );

  return {
    matches: matches.slice(0, options.limit ?? 25),
    jurisdictions: jurisdictionRisk(query.country, index),
    notes,
    checked: index.lists.map((list) => ({
      list: list.snapshot.list,
      label: list.snapshot.label,
      retrievedAt: list.snapshot.retrievedAt,
      entries: list.snapshot.entries.length + (list.snapshot.jurisdictions?.length ?? 0),
    })),
  };
}

/** Państwo na liście państw wysokiego ryzyka — informacja o jurysdykcji, nie o osobie. */
export function jurisdictionRisk(country: string | undefined, index: RiskListIndex): JurisdictionRisk[] {
  const code = countryCode(country);
  if (!code) return [];
  const out: JurisdictionRisk[] = [];
  for (const list of index.lists) {
    for (const item of list.snapshot.jurisdictions ?? []) {
      if (item.country !== code) continue;
      out.push({
        list: list.snapshot.list,
        listLabel: list.snapshot.label,
        country: item.country,
        name: item.name,
        category: item.category,
        page: list.snapshot.page,
        retrievedAt: list.snapshot.retrievedAt,
      });
    }
  }
  return out;
}

/** Trafienie adresu kryptowalutowego w listach (bez nazwy i innych cech). */
export interface RiskAddressHit {
  address: string;
  list: RiskListId;
  listLabel: string;
  entryId: string;
  entryName: string;
  asset: string;
  url?: string;
  page: string;
  retrievedAt: string;
}

/** Sprawdza adresy kryptowalutowe we wszystkich listach; adresy EVM bez rozróżniania wielkości liter. */
export function findListedAddresses(addresses: string[], index: RiskListIndex): RiskAddressHit[] {
  const out: RiskAddressHit[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = cryptoAddressKey(address);
    for (const list of index.lists) {
      for (const hit of list.byCrypto.get(key) ?? []) {
        const entry = list.snapshot.entries[hit.entry]!;
        const dedupe = `${key}|${list.snapshot.list}|${entry.id}|${hit.asset}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        const url = entryUrl(list.snapshot, entry);
        out.push({
          address,
          list: list.snapshot.list,
          listLabel: list.snapshot.label,
          entryId: entry.id,
          entryName: entry.names[0] ?? entry.id,
          asset: hit.asset,
          ...(url ? { url } : {}),
          page: list.snapshot.page,
          retrievedAt: list.snapshot.retrievedAt,
        });
      }
    }
  }
  return out;
}

/** Postać nazwy do wyświetlenia w uzasadnieniu (złożona, bez form prawnych). */
export const displayFold = (value: string): string => nameTokens(value).join(' ') || foldText(value);
