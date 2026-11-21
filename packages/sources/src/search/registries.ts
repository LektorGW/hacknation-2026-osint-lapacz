// Łącznik `rejestry-publiczne`: sprawdzenie nazwy, NIP/KRS/REGON albo domeny w trzech publicznych
// rejestrach związanych z obrotem kryptoaktywami. Działa w całości LOKALNIE, na migawkach
// opublikowanych danych (katalog data/) — zapytanie nie opuszcza systemu.
//   • Rejestr działalności w zakresie walut wirtualnych (Dyrektor IAS w Katowicach, gov.pl),
//   • Lista ostrzeżeń publicznych KNF (knf.gov.pl; wymagane podanie źródła),
//   • Tymczasowy rejestr MiCA dostawców usług w zakresie kryptoaktywów — CASP (ESMA).
// Wynik to „wpis w rejestrze publicznym", a nie publikacja podmiotu: nie zawiera adresów
// kryptowalutowych, służy do klasyfikacji kontrahenta i powiązania nazwy lub NIP z działalnością krypto.
// Podstawa prawna i sposób odświeżania: docs/ZRODLA-PODSTAWA-PRAWNA.md.

import { readFileSync } from 'node:fs';
import type { Identifier, IdentityMatch, SourceConnector, SourceDocument } from '@olcys/core';
import { htmlToText } from '../html.ts';
import { parseHttpUrl, serviceOf } from '../identity.ts';

export const REGISTRIES_ID = 'rejestry-publiczne';
const LABEL = 'Rejestry publiczne (waluty wirtualne, ostrzeżenia KNF, CASP)';
const MAX_PER_REGISTRY = 10;

const RDWW_URL = new URL('./data/rdww.json', import.meta.url);
const KNF_URL = new URL('./data/knf-ostrzezenia.json', import.meta.url);
const ESMA_URL = new URL('./data/esma-casp.json', import.meta.url);

export const KNF_PAGE = 'https://www.knf.gov.pl/dla_konsumenta/ostrzezenia_publiczne';
export const ESMA_CSV = 'https://www.esma.europa.eu/sites/default/files/2024-12/CASPS.csv';
const ESMA_PAGE = 'https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica';

// ---------- Kształt migawek ----------

export interface RdwwEntry {
  numer: string;
  dataWpisu: string;
  nazwa: string;
  nip: string;
  krs?: string;
  uslugi?: string[];
  wykreslony?: boolean;
  zawieszenie?: string;
}

export interface RdwwSnapshot {
  zrodlo: string;
  strona: string;
  plik: string;
  stanNa: string;
  wpisy: RdwwEntry[];
}

export interface KnfEntry {
  /** Tytuł tabeli, np. „Zawiadomienia o podejrzeniu popełnienia przestępstwa z art. 178 ustawy o obrocie…". */
  sekcja: string;
  lp: string;
  nazwa: string;
  identyfikatory: string;
  prokuratura: string;
  orzeczenia: string;
  informacje: string;
}

export interface KnfSnapshot {
  zrodlo: string;
  strona: string;
  pobrano: string;
  wpisy: KnfEntry[];
}

export interface CaspEntry {
  organ: string;
  kraj: string;
  nazwa: string;
  lei?: string;
  nazwaHandlowa?: string;
  adres?: string;
  strona?: string;
  dataZezwolenia?: string;
  dataKonca?: string;
  uslugi?: string;
  /** Kraje, w których podmiot świadczy usługi (kody ISO rozdzielone `|`). */
  kraje?: string;
}

export interface CaspSnapshot {
  zrodlo: string;
  strona: string;
  plik: string;
  pobrano: string;
  wpisy: CaspEntry[];
}

export interface RegistryData {
  rdww?: RdwwSnapshot;
  knf?: KnfSnapshot;
  casp?: CaspSnapshot;
}

// ---------- Rozbiór opublikowanych danych (do odświeżania migawek) ----------

const cellText = (html: string): string =>
  htmlToText(html)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();

/** Rozbiera stronę listy ostrzeżeń publicznych KNF: każda tabela ma tytuł w akapicie nad nią i wiersze po 6 komórek. */
export function parseKnfWarnings(html: string): KnfEntry[] {
  const entries: KnfEntry[] = [];
  const tables = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  for (let table = tables.exec(html); table; table = tables.exec(html)) {
    const before = html.slice(Math.max(0, table.index - 3000), table.index);
    const headings = [...before.matchAll(/<p\b[^>]*>([^<]{10,})<\/p>/gi)];
    const sekcja = cellText(headings.at(-1)?.[1] ?? '');
    for (const row of table[1]!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cellText(cell[1]!));
      if (cells.length < 6 || !cells[1]) continue;
      entries.push({
        sekcja,
        lp: cells[0]!.replace(/[\s.]+$/, ''),
        nazwa: cells[1]!,
        identyfikatory: cells[2]!,
        prokuratura: cells[3]!,
        orzeczenia: cells[4]!,
        informacje: cells[5]!,
      });
    }
  }
  return entries;
}

/** Wiersze pliku CSV z polami w cudzysłowach (RFC 4180). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = csv.replace(/^﻿/, '');
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
    } else field += char;
  }
  row.push(field);
  if (row.some((value) => value !== '')) rows.push(row);
  return rows;
}

/** Rozbiera plik CASPS.csv tymczasowego rejestru MiCA prowadzonego przez ESMA. */
export function parseEsmaCasps(csv: string): CaspEntry[] {
  const [header, ...rows] = parseCsv(csv);
  if (!header) return [];
  const column = (name: string) => header.indexOf(name);
  const at = {
    organ: column('ae_competentAuthority'),
    kraj: column('ae_homeMemberState'),
    nazwa: column('ae_lei_name'),
    lei: column('ae_lei'),
    nazwaHandlowa: column('ae_commercial_name'),
    adres: column('ae_address'),
    strona: column('ae_website'),
    dataZezwolenia: column('ac_authorisationNotificationDate'),
    dataKonca: column('ac_authorisationEndDate'),
    uslugi: column('ac_serviceCode'),
    kraje: column('ac_serviceCode_cou'),
  };
  if (at.nazwa < 0) return [];
  const entries: CaspEntry[] = [];
  for (const row of rows) {
    const value = (index: number) => (index >= 0 ? (row[index] ?? '').trim() : '');
    const nazwa = value(at.nazwa);
    if (!nazwa) continue;
    const entry: CaspEntry = { organ: value(at.organ), kraj: value(at.kraj), nazwa };
    for (const key of ['lei', 'nazwaHandlowa', 'adres', 'strona', 'dataZezwolenia', 'dataKonca', 'uslugi', 'kraje'] as const) {
      const text = value(at[key]);
      if (text) entry[key] = text;
    }
    entries.push(entry);
  }
  return entries;
}

// ---------- Dopasowanie ----------

/** Małe litery bez znaków diakrytycznych, znaki inne niż litery i cyfry zamienione na spacje. */
export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const LEGAL_FORMS = [
  'prosta spolka akcyjna',
  'spolka z ograniczona odpowiedzialnoscia',
  'spolka komandytowo akcyjna',
  'spolka komandytowa',
  'spolka akcyjna',
  'spolka jawna',
  'spolka cywilna',
  'sp z o o',
  'sp k',
  'sp j',
  'p s a',
  's k a',
  's a',
  's c',
  'w likwidacji',
  'w upadlosci',
  'w organizacji',
];

/** Nazwa bez formy prawnej: „Binance Poland sp. z o.o." i „BINANCE POLAND SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ" dają to samo. */
export function coreName(value: string): string {
  let name = ` ${normalizeName(value)} `;
  for (const form of LEGAL_FORMS) name = name.split(` ${form} `).join(' ');
  return name.replace(/\s+/g, ' ').trim();
}

const containsPhrase = (haystack: string, phrase: string): boolean => ` ${haystack} `.includes(` ${phrase} `);

const sameTokens = (a: string, b: string): boolean => {
  const left = a.split(' ').sort().join(' ');
  return left !== '' && left === b.split(' ').sort().join(' ');
};

export type RegistryQuery =
  | { kind: 'number'; digits: string }
  | { kind: 'domain'; host: string }
  | { kind: 'name'; core: string };

/** Rozpoznaje, czego szukać: numeru (NIP, KRS, REGON), domeny czy nazwy. `null` — wartość zbyt ogólna. */
export function registryQuery(identifier: Identifier): RegistryQuery | null {
  const raw = identifier.value.trim();
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(raw);
    return url ? { kind: 'domain', host: serviceOf(url) } : null;
  }
  const digits = raw.replace(/^(?:PL|NIP|KRS|REGON)[\s:]*/i, '').replace(/[\s-]/g, '');
  if (/^\d{9,10}$|^\d{14}$/.test(digits)) return { kind: 'number', digits };
  // Same cyfry o innej długości nie są ani numerem rejestrowym, ani nazwą.
  if (/^\d+$/.test(digits)) return null;
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(raw)) return { kind: 'domain', host: raw.toLowerCase().replace(/^www\./, '') };
  const core = coreName(raw);
  // Jedno krótkie słowo pasowałoby do przypadkowych wpisów.
  if (core.length < 5 || (identifier.type === 'full_name' && core.split(' ').length < 2)) return null;
  return { kind: 'name', core };
}

const hostIn = (text: string, host: string): boolean => {
  const lower = text.toLowerCase();
  for (let at = lower.indexOf(host); at >= 0; at = lower.indexOf(host, at + 1)) {
    const before = lower[at - 1] ?? ' ';
    const after = lower[at + host.length] ?? ' ';
    // „bit.pl" nie może pasować do „orbit.pl"; subdomena „www." jest dozwolona.
    const subdomain = before === '.' && !lower.slice(0, at).endsWith('www.');
    const longerDomain = after === '.' && /[a-z0-9]/.test(lower[at + host.length + 1] ?? ' ');
    if (!/[a-z0-9-]/.test(before) && !/[a-z0-9-]/.test(after) && !subdomain && !longerDomain) return true;
  }
  return false;
};

interface Hit<T> {
  entry: T;
  how: string;
  exact: boolean;
}

export function matchRdww(entries: RdwwEntry[], query: RegistryQuery): Hit<RdwwEntry>[] {
  // Rejestr nie zawiera domen, ale firmy bywają wpisane pod nazwą równą domenie („CINKCIARZ.PL sp. z o.o.").
  const wanted = query.kind === 'domain' ? coreName(query.host) : query.kind === 'name' ? query.core : '';
  const hits: Hit<RdwwEntry>[] = [];
  for (const entry of entries) {
    if (query.kind === 'number') {
      if (entry.nip === query.digits) hits.push({ entry, how: `NIP ${entry.nip}`, exact: true });
      else if (entry.krs === query.digits) hits.push({ entry, how: `numer KRS ${entry.krs}`, exact: true });
      continue;
    }
    const core = coreName(entry.nazwa);
    if (core === wanted || sameTokens(core, wanted)) hits.push({ entry, how: 'nazwa zgodna po pominięciu formy prawnej', exact: false });
    else if (query.kind === 'name' && core.startsWith(`${wanted} `)) hits.push({ entry, how: 'nazwa wpisu zaczyna się od szukanej nazwy', exact: false });
  }
  return hits;
}

export function matchKnf(entries: KnfEntry[], query: RegistryQuery): Hit<KnfEntry>[] {
  const hits: Hit<KnfEntry>[] = [];
  for (const entry of entries) {
    if (query.kind === 'number') {
      const numbers = entry.identyfikatory.replace(/[^\d\s]/g, ' ').split(/\s+/);
      if (numbers.includes(query.digits)) hits.push({ entry, how: `numer ${query.digits} w kolumnie identyfikatorów`, exact: true });
    } else if (query.kind === 'domain') {
      if (hostIn(entry.nazwa, query.host)) hits.push({ entry, how: `domena ${query.host} wymieniona we wpisie`, exact: true });
    } else if (containsPhrase(coreName(entry.nazwa), query.core)) {
      hits.push({ entry, how: 'szukana nazwa występuje w nazwie podmiotu', exact: false });
    }
  }
  return hits;
}

export function matchCasp(entries: CaspEntry[], query: RegistryQuery): Hit<CaspEntry>[] {
  if (query.kind === 'number') return [];
  const hits: Hit<CaspEntry>[] = [];
  for (const entry of entries) {
    if (query.kind === 'domain') {
      if (entry.strona && hostIn(entry.strona, query.host)) hits.push({ entry, how: `domena ${query.host} podana w rejestrze jako strona podmiotu`, exact: true });
      continue;
    }
    const names = [entry.nazwa, entry.nazwaHandlowa ?? ''].map(coreName).filter(Boolean);
    if (names.some((name) => name === query.core)) hits.push({ entry, how: 'nazwa lub nazwa handlowa zgodna', exact: false });
    else if (names.some((name) => name.startsWith(`${query.core} `))) hits.push({ entry, how: 'nazwa wpisu zaczyna się od szukanej nazwy', exact: false });
  }
  return hits;
}

// ---------- Dokumenty ----------

const SERVICE_NAMES: Record<string, string> = {
  wymiana_na_srodki_platnicze: 'wymiana pomiędzy walutami wirtualnymi i środkami płatniczymi',
  wymiana_miedzy_walutami: 'wymiana pomiędzy walutami wirtualnymi',
  posrednictwo: 'pośrednictwo w wymianie',
  prowadzenie_rachunkow: 'prowadzenie rachunków walut wirtualnych',
};

function readSnapshot<T>(url: URL): T | undefined {
  try {
    return JSON.parse(readFileSync(url, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

let sharedSnapshots: RegistryData | undefined;

/**
 * Migawki rejestrów z katalogu data/ (wczytywane raz). Poza łącznikiem służą do rozpoznania, czy usługa
 * NAZWANA w treści ma wpis w RDWW albo w rejestrze MiCA — wyłącznie nazwy, bez adresów.
 */
export function loadRegistrySnapshots(): RegistryData {
  sharedSnapshots ??= { rdww: readSnapshot<RdwwSnapshot>(RDWW_URL), knf: readSnapshot<KnfSnapshot>(KNF_URL), casp: readSnapshot<CaspSnapshot>(ESMA_URL) };
  return sharedSnapshots;
}

export interface RegistriesOptions {
  /** Dane zamiast migawek z katalogu data/ (testy). */
  data?: RegistryData;
}

export function createRegistriesConnector(options: RegistriesOptions = {}): SourceConnector {
  let loaded: RegistryData | undefined = options.data;
  const data = (): RegistryData => {
    loaded ??= { rdww: readSnapshot<RdwwSnapshot>(RDWW_URL), knf: readSnapshot<KnfSnapshot>(KNF_URL), casp: readSnapshot<CaspSnapshot>(ESMA_URL) };
    return loaded;
  };

  return {
    id: REGISTRIES_ID,
    service: 'rejestry-publiczne',
    label: LABEL,
    description:
      'Sprawdzenie LOKALNE (zapytanie nie opuszcza systemu) w migawkach trzech opublikowanych rejestrów: Rejestr działalności w zakresie walut wirtualnych ' +
      '(IAS Katowice, gov.pl), lista ostrzeżeń publicznych KNF (knf.gov.pl) i tymczasowy rejestr MiCA dostawców usług w zakresie kryptoaktywów (ESMA). ' +
      'Parametry: 10 cyfr — NIP lub numer KRS (9 albo 14 cyfr — REGON, tylko lista KNF), dopasowanie dokładne; nazwa — zgodność po pominięciu formy prawnej, ' +
      'wielkości liter i znaków diakrytycznych albo początek nazwy wpisu (lista KNF: nazwa jako całe słowa w opisie podmiotu); domena lub adres strony — ' +
      `domena wymieniona we wpisie KNF albo podana w rejestrze ESMA. Najwyżej ${MAX_PER_REGISTRY} wpisów z każdego rejestru. Wynik to wpis w rejestrze publicznym ` +
      '(dopasowanie po nazwie = „tylko nazwa", możliwa zbieżność nazw), bez adresów kryptowalutowych; data migawki jest w treści każdego wpisu.',
    accepts: ['full_name', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const query = registryQuery(identifier);
      if (!query) return [];
      const { rdww, knf, casp } = data();
      const fetchedAt = new Date().toISOString();
      const match = (exact: boolean): IdentityMatch => (exact ? 'exact_identifier' : 'name_only');
      const base = { connectorId: REGISTRIES_ID, fetchedAt, category: 'forum_post' as const, matchedIdentifier: identifier };
      const documents: SourceDocument[] = [];

      for (const hit of rdww ? matchRdww(rdww.wpisy, query).slice(0, MAX_PER_REGISTRY) : []) {
        const entry = hit.entry;
        documents.push({
          ...base,
          service: 'gov.pl',
          url: `${rdww!.strona}#${entry.numer}`,
          title: `Rejestr działalności w zakresie walut wirtualnych: ${entry.nazwa} (${entry.numer})`,
          publishedAt: `${entry.dataWpisu}T00:00:00.000Z`,
          identityMatch: match(hit.exact),
          text: [
            `Wpis w rejestrze publicznym — ${rdww!.zrodlo}. Migawka lokalna, stan na ${rdww!.stanNa} (plik: ${rdww!.plik}).`,
            `Podstawa dopasowania: ${hit.how}.${hit.exact ? '' : ' Zgodna jest tylko nazwa — możliwa zbieżność nazw.'}`,
            `Numer w rejestrze: ${entry.numer}; data wpisu: ${entry.dataWpisu}`,
            `Nazwa: ${entry.nazwa}`,
            `NIP: ${entry.nip}${entry.krs ? `; KRS: ${entry.krs}` : ''}`,
            `Rodzaj usług: ${(entry.uslugi ?? []).map((key) => SERVICE_NAMES[key] ?? key).join('; ') || 'brak danych w migawce'}`,
            `Status: ${entry.wykreslony ? 'wykreślony z rejestru' : 'wpis bez adnotacji o wykreśleniu'}${entry.zawieszenie ? `; zawieszenie: ${entry.zawieszenie}` : ''}`,
            'Wpis nie jest zezwoleniem na świadczenie usług w zakresie kryptoaktywów (CASP) w rozumieniu rozporządzenia MiCA.',
          ].join('\n'),
        });
      }

      for (const hit of knf ? matchKnf(knf.wpisy, query).slice(0, MAX_PER_REGISTRY) : []) {
        const entry = hit.entry;
        const section = knf!.wpisy.findIndex((item) => item.sekcja === entry.sekcja);
        documents.push({
          ...base,
          service: 'knf.gov.pl',
          url: `${knf!.strona}#${section}-${entry.lp}`,
          title: `Lista ostrzeżeń publicznych KNF: ${entry.nazwa.split('\n')[0]!.slice(0, 160)}`,
          identityMatch: match(hit.exact),
          text: [
            `Wpis w rejestrze publicznym — ${knf!.zrodlo}. Źródło: ${knf!.strona} (migawka lokalna pobrana ${knf!.pobrano.slice(0, 10)}).`,
            `Podstawa dopasowania: ${hit.how}.${hit.exact ? '' : ' Zgodna jest tylko nazwa — możliwa zbieżność nazw.'}`,
            `Tabela: ${entry.sekcja}`,
            `Podmiot (lp. ${entry.lp}): ${entry.nazwa}`,
            `Numer identyfikujący: ${entry.identyfikatory}`,
            `Właściwa prokuratura: ${entry.prokuratura}`,
            `Wzmianki o prawomocnych orzeczeniach: ${entry.orzeczenia}`,
            `Informacje istotne: ${entry.informacje}`,
            'Wpis na liście oznacza złożenie zawiadomienia o podejrzeniu popełnienia przestępstwa, a nie ustalenie winy.',
          ].join('\n'),
        });
      }

      for (const hit of casp ? matchCasp(casp.wpisy, query).slice(0, MAX_PER_REGISTRY) : []) {
        const entry = hit.entry;
        documents.push({
          ...base,
          service: 'esma.europa.eu',
          url: `${casp!.strona}#${entry.lei ?? encodeURIComponent(entry.nazwa)}`,
          title: `Rejestr MiCA (ESMA), dostawca usług w zakresie kryptoaktywów: ${entry.nazwa}`,
          identityMatch: match(hit.exact),
          text: [
            `Wpis w rejestrze publicznym — ${casp!.zrodlo}. Migawka lokalna pobrana ${casp!.pobrano.slice(0, 10)} (plik: ${casp!.plik}).`,
            `Podstawa dopasowania: ${hit.how}.${hit.exact ? '' : ' Zgodna jest tylko nazwa — możliwa zbieżność nazw.'}`,
            `Nazwa: ${entry.nazwa}${entry.nazwaHandlowa ? `; nazwa handlowa: ${entry.nazwaHandlowa}` : ''}`,
            `LEI: ${entry.lei ?? 'brak'}; państwo macierzyste: ${entry.kraj}; organ: ${entry.organ}`,
            entry.strona && `Strona: ${entry.strona}`,
            entry.adres && `Adres siedziby: ${entry.adres}`,
            `Zezwolenie od: ${entry.dataZezwolenia ?? 'brak danych'}${entry.dataKonca ? `; koniec: ${entry.dataKonca}` : ''}`,
            entry.uslugi && `Usługi: ${entry.uslugi}`,
            entry.kraje && `Państwa świadczenia usług: ${entry.kraje}${entry.kraje.split('|').includes('PL') ? ' (w tym Polska)' : ''}`,
          ]
            .filter(Boolean)
            .join('\n'),
        });
      }

      const missing = [!rdww && 'rejestr walut wirtualnych', !knf && 'lista KNF', !casp && 'rejestr ESMA'].filter(Boolean);
      if (missing.length > 0) context.log(`${LABEL}: brak migawki — ${missing.join(', ')}.`);
      context.log(`${LABEL}: „${identifier.value}" — ${documents.length} wpisów (sprawdzenie lokalne).`);
      return documents;
    },
  };
}

export { ESMA_PAGE };
