// Rozbiór oficjalnych plików list ryzyka do wspólnej postaci migawki (`RiskListEntry`).
// Bez zewnętrznego parsera XML — pliki mają stałą, udokumentowaną strukturę (jak `packages/chain/src/ofac.ts`).
// Zostawiamy wyłącznie pola potrzebne do dopasowania: nazwy, aliasy, rodzaj, program, daty, państwa,
// identyfikatory (w tym adresy kryptowalutowe) i odnośnik do wpisu. Statki i statki powietrzne są pomijane.

import { extractAddresses } from '@olcys/core';
// Moduł list ryzyka w `@olcys/core` (do czasu dopisania eksportu w packages/core/src/index.ts — import względny).
import { countryCode, foldText } from '../../../core/src/sanctions/index.ts';
import type { JurisdictionEntry, RiskListEntry } from '../../../core/src/sanctions/index.ts';
import { htmlToText } from '../html.ts';

// ---------- Wspólne ----------

export function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const tagValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => decodeXml(match[1]!)).filter(Boolean);

const firstTag = (xml: string, tag: string): string | undefined => tagValues(xml, tag)[0];

const attributes = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) out[match[1]!] = decodeXml(match[2]!);
  return out;
};

const unique = <T>(items: T[]): T[] => [...new Set(items)];

/** Usuwa puste pola, żeby migawka była mała. */
export function compactEntry(entry: RiskListEntry): RiskListEntry {
  const out: RiskListEntry = { id: entry.id, type: entry.type, names: entry.names };
  const optional = ['weakNames', 'programmes', 'listedOn', 'delistedOn', 'birthDates', 'countries', 'ids', 'crypto', 'unRef', 'url', 'note'] as const;
  for (const key of optional) {
    const value = entry[key];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** Nazwy bez powtórzeń po złożeniu (wielkość liter, znaki diakrytyczne), w kolejności wystąpienia. */
export function dedupeNames(names: string[], skip: string[] = []): string[] {
  const seen = new Set(skip.map(foldText));
  const out: string[] = [];
  for (const name of names) {
    const clean = name.replace(/\s+/g, ' ').trim();
    const key = foldText(clean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

const MONTHS_EN: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** Data urodzenia z listy OFAC: „01 Jan 1961”, „Jan 1961”, „1961”, „circa 1961”, „1960 to 1962”. */
export function parseOfacDate(value: string): string[] {
  const text = value.trim().toLowerCase().replace(/^circa\s+/, '');
  const range = /^(\d{4})\s*to\s*(\d{4})$/.exec(text);
  if (range) {
    const from = Number(range[1]);
    const to = Number(range[2]);
    if (to < from || to - from > 10) return [];
    return Array.from({ length: to - from + 1 }, (_, index) => String(from + index));
  }
  const full = /^(\d{1,2})\s+([a-z]{3})[a-z]*\s+(\d{4})$/.exec(text);
  if (full && MONTHS_EN[full[2]!]) return [`${full[3]}-${MONTHS_EN[full[2]!]}-${full[1]!.padStart(2, '0')}`];
  const month = /^([a-z]{3})[a-z]*\s+(\d{4})$/.exec(text);
  if (month && MONTHS_EN[month[1]!]) return [`${month[2]}-${MONTHS_EN[month[1]!]}`];
  const year = /^(\d{4})$/.exec(text);
  return year ? [year[1]!] : [];
}

// ---------- OFAC SDN (SDN.XML) ----------

/** Rodzaje identyfikatorów OFAC, które NIE są numerami (informacje o sankcjach, cechy statków itd.). */
const OFAC_NON_IDENTIFIER =
  /^(Secondary sanctions risk|Gender|Organization Established Date|Additional Sanctions Information|Organization Type|Target Type|Transactions Prohibited|Executive Order|Vessel|Aircraft|MMSI|Other Vessel|Digital Currency Address|Effective Date|Listing Date|Nationality of Registration|Citizenship|Former Vessel|CAATSA|Equity Ticker|ISIN|Issuer Name|Phone Number|Kuwaiti Citizenship|Previous Aircraft|IFCA Determination|Sanctions Information)/i;

const ofacName = (xml: string): string => {
  const first = firstTag(xml, 'firstName');
  const last = firstTag(xml, 'lastName');
  return [first, last].filter(Boolean).join(' ');
};

export interface ParsedList {
  publishedAt?: string;
  entries: RiskListEntry[];
}

/**
 * Wpisy listy SDN z nazwami, aliasami (silnymi i słabymi), programami, datami urodzenia, państwami
 * i identyfikatorami. Adresy kryptowalutowe NIE są tu powielane — dostarcza je istniejąca kopia
 * `packages/chain/data/ofac-addresses.json` (`packages/chain/src/ofac.ts`), dołączana przy wczytaniu.
 */
export function parseOfacSdn(xml: string): ParsedList {
  const published = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(xml)?.[1]?.trim();
  const usDate = published ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(published) : null;
  const entries: RiskListEntry[] = [];
  for (const block of xml.split('<sdnEntry>').slice(1)) {
    const body = block.slice(0, block.indexOf('</sdnEntry>'));
    const sdnType = firstTag(body, 'sdnType') ?? '';
    if (sdnType === 'Vessel' || sdnType === 'Aircraft') continue;
    const uid = firstTag(body, 'uid');
    if (!uid) continue;
    const head = body.slice(0, Math.max(0, body.search(/<(programList|idList|akaList|addressList|nationalityList|citizenshipList|dateOfBirthList|placeOfBirthList)>/)) || body.length);
    const primary = ofacName(head);
    if (!primary) continue;
    const strong: string[] = [];
    const weak: string[] = [];
    for (const aka of body.match(/<aka>[\s\S]*?<\/aka>/g) ?? []) {
      const first = firstTag(aka, 'firstName');
      const last = firstTag(aka, 'lastName');
      // Alias osoby zapisany „NAZWISKO, Imię” w polu lastName.
      const name = first ? `${first} ${last ?? ''}` : (last ?? '').replace(/^([^,]+),\s*(.+)$/, '$2 $1');
      if (!name.trim()) continue;
      if (firstTag(aka, 'category') === 'weak') weak.push(name);
      else strong.push(name);
    }
    const names = dedupeNames([primary, ...strong]);
    const weakNames = dedupeNames(weak, names);
    const countries = unique(
      [...tagValues(body, 'country'), ...(body.match(/<placeOfBirth>[^<]*<\/placeOfBirth>/g) ?? []).map((item) => decodeXml(item.replace(/<[^>]+>/g, '')).split(',').at(-1) ?? '')]
        .map((name) => countryCode(name))
        .filter((code): code is string => Boolean(code)),
    );
    const birthDates = unique(tagValues(body, 'dateOfBirth').flatMap(parseOfacDate));
    const ids: { kind: string; value: string }[] = [];
    for (const id of body.match(/<id>[\s\S]*?<\/id>/g) ?? []) {
      const kind = firstTag(id, 'idType');
      const value = firstTag(id, 'idNumber');
      if (!kind || !value || OFAC_NON_IDENTIFIER.test(kind)) continue;
      ids.push({ kind, value });
    }
    entries.push(
      compactEntry({
        id: uid,
        type: sdnType === 'Individual' ? 'person' : sdnType === 'Entity' ? 'organization' : 'unknown',
        names,
        weakNames,
        programmes: unique(tagValues(body.slice(body.indexOf('<programList>')), 'program')),
        birthDates,
        countries,
        ids,
      }),
    );
  }
  return { ...(usDate ? { publishedAt: `${usDate[3]}-${usDate[1]}-${usDate[2]}` } : {}), entries };
}

// ---------- Unia Europejska: skonsolidowana lista sankcji finansowych (FSF, XML 1.1) ----------

/** Wpisy listy FSF: nazwy we wszystkich językach (w tym cyrylica), program, daty, obywatelstwo, dokumenty. */
export function parseEuFsf(xml: string): ParsedList {
  const generated = /generationDate="([^"]+)"/.exec(xml)?.[1];
  const entries: RiskListEntry[] = [];
  for (const block of xml.split('<sanctionEntity ').slice(1)) {
    const body = block.slice(0, block.indexOf('</sanctionEntity>'));
    const own = attributes(body.slice(0, body.indexOf('>')));
    const reference = own.euReferenceNumber || own.logicalId;
    if (!reference) continue;
    const subject = attributes(/<subjectType [^>]*>/.exec(body)?.[0] ?? '');
    const type = subject.code === 'person' ? 'person' : subject.code === 'enterprise' ? 'organization' : 'unknown';
    const aliasTags = body.match(/<nameAlias [^>]*>/g) ?? [];
    const strong: string[] = [];
    const weak: string[] = [];
    for (const tag of aliasTags) {
      const alias = attributes(tag);
      const name = alias.wholeName || [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' ');
      if (!name) continue;
      if (alias.strong === 'false') weak.push(name);
      else strong.push(name);
    }
    // Najpierw zapisy łacinką (nazwa pokazywana analitykowi), potem cyrylica i inne alfabety.
    const latinFirst = (items: string[]) => [...items].sort((a, b) => Number(/[^\u0000-ɏ\s\p{P}]/u.test(a)) - Number(/[^\u0000-ɏ\s\p{P}]/u.test(b)));
    const names = dedupeNames(latinFirst(strong.length > 0 ? strong : weak));
    if (names.length === 0) continue;
    const weakNames = strong.length > 0 ? dedupeNames(weak, names) : [];
    const regulations = (body.match(/<regulation [^>]*>[\s\S]*?<\/regulation>/g) ?? []).map((item) => ({
      ...attributes(/<regulation [^>]*>/.exec(item)![0]),
      url: firstTag(item, 'publicationUrl'),
    }));
    const countries = unique(
      [...(body.match(/<(citizenship|address|birthdate) [^>]*>/g) ?? [])]
        .map((tag) => attributes(tag))
        .map((item) => (item.countryIso2Code && item.countryIso2Code !== '00' ? item.countryIso2Code : countryCode(item.countryDescription)))
        .filter((code): code is string => Boolean(code) && code !== '00'),
    );
    const birthDates = unique(
      (body.match(/<birthdate [^>]*>/g) ?? [])
        .map((tag) => attributes(tag))
        .map((item) =>
          item.birthdate
            ? item.birthdate
            : item.year
              ? [
                  item.year,
                  item.monthOfYear ? item.monthOfYear.padStart(2, '0') : undefined,
                  item.monthOfYear && item.dayOfMonth ? item.dayOfMonth.padStart(2, '0') : undefined,
                ]
                  .filter(Boolean)
                  .join('-')
              : '',
        )
        .filter((date) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(date)),
    );
    const ids = (body.match(/<identification [^>]*>/g) ?? [])
      .map((tag) => attributes(tag))
      .filter((item) => item.number)
      .map((item) => ({ kind: item.identificationTypeDescription || item.identificationTypeCode || 'identyfikator', value: item.number! }));
    const remarks = tagValues(body, 'remark').join(' ');
    entries.push(
      compactEntry({
        id: reference,
        type,
        names,
        weakNames,
        programmes: unique(regulations.map((item) => item.programme).filter((item): item is string => Boolean(item))),
        ...(own.designationDate ? { listedOn: own.designationDate } : {}),
        birthDates,
        countries,
        ids,
        crypto: cryptoFromText(remarks),
        ...(own.unitedNationId ? { unRef: own.unitedNationId } : {}),
        ...(regulations[0]?.url ? { url: regulations[0].url } : {}),
      }),
    );
  }
  return { ...(generated ? { publishedAt: generated.slice(0, 10) } : {}), entries };
}

// ---------- Wielka Brytania: UK Sanctions List (FCDO, XML) ----------

const ukDate = (value: string | undefined): string | undefined => {
  const match = value ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim()) : null;
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
};

/** Data urodzenia UK: „22/05/1972” → `1972-05-22`, „dd/05/1972” → `1972-05`, „dd/mm/1945” → `1945`. */
export function parseUkBirthDate(value: string): string | undefined {
  const match = /^(\d{2}|dd)\/(\d{2}|mm)\/(\d{4})$/i.exec(value.trim());
  if (!match) return undefined;
  if (/^\d{2}$/.test(match[1]!) && /^\d{2}$/.test(match[2]!)) return `${match[3]}-${match[2]}-${match[1]}`;
  if (/^\d{2}$/.test(match[2]!)) return `${match[3]}-${match[2]}`;
  return match[3];
}

/** Adresy kryptowalutowe z tekstu listy („ETH: 0x…”, „USDT: T…”); oznaczenie waluty z etykiety przed adresem. */
export function cryptoFromText(text: string): { asset: string; address: string }[] {
  if (!text) return [];
  const out: { asset: string; address: string }[] = [];
  for (const found of extractAddresses(text)) {
    const before = text.slice(Math.max(0, found.index - 20), found.index);
    const label = /([A-Z][A-Z0-9]{1,9})\s*[:\-]?\s*$/.exec(before)?.[1];
    const fallback = found.network === 'ethereum' ? 'ETH' : found.network === 'tron' ? 'TRX' : 'XBT';
    out.push({ asset: label ?? fallback, address: found.raw });
  }
  return out;
}

/** Wpisy UK Sanctions List: nazwy (Name1–Name6), nazwy w innych alfabetach, reżim, daty, państwa, numery. */
export function parseUkSanctions(xml: string): ParsedList {
  const generated = ukDate(firstTag(xml, 'DateGenerated'));
  const entries: RiskListEntry[] = [];
  for (const block of xml.split('<Designation>').slice(1)) {
    const body = block.slice(0, block.indexOf('</Designation>'));
    const kind = firstTag(body, 'IndividualEntityShip');
    if (kind === 'Ship') continue;
    const id = firstTag(body, 'UniqueID');
    if (!id) continue;
    const strong: string[] = [];
    const weak: string[] = [];
    for (const name of body.match(/<Name>[\s\S]*?<\/Name>/g) ?? []) {
      const parts = ['Name1', 'Name2', 'Name3', 'Name4', 'Name5', 'Name6'].map((tag) => firstTag(name, tag)).filter(Boolean);
      const full = parts.join(' ');
      if (!full) continue;
      const nameType = (firstTag(name, 'NameType') ?? '').toLowerCase();
      if (nameType.startsWith('primary name') && !nameType.includes('variation')) strong.unshift(full);
      else if ((firstTag(name, 'AliasStrength') ?? '').toLowerCase().startsWith('low')) weak.push(full);
      else strong.push(full);
    }
    const nonLatin = tagValues(body, 'NameNonLatinScript');
    const names = dedupeNames([...strong, ...nonLatin]);
    if (names.length === 0) continue;
    const countries = unique(
      [...tagValues(body, 'Nationality'), ...tagValues(body, 'AddressCountry'), ...tagValues(body, 'CountryOfBirth')]
        .map((name) => countryCode(name))
        .filter((code): code is string => Boolean(code)),
    );
    const birthDates = unique(tagValues(body, 'DOB').map(parseUkBirthDate).filter((date): date is string => Boolean(date)));
    const ids = [
      ...tagValues(body, 'PassportNumber').map((value) => ({ kind: 'Passport', value })),
      ...tagValues(body, 'NationalIdentifierNumber').map((value) => ({ kind: 'National identifier', value })),
      ...tagValues(body, 'BusinessRegistrationNumber').map((value) => ({ kind: 'Business registration number', value })),
      ...tagValues(body, 'EmailAddress').map((value) => ({ kind: 'Email', value })),
    ];
    entries.push(
      compactEntry({
        id,
        type: kind === 'Individual' ? 'person' : kind === 'Entity' ? 'organization' : 'unknown',
        names,
        weakNames: dedupeNames(weak, names),
        programmes: tagValues(body, 'RegimeName'),
        ...(ukDate(firstTag(body, 'DateDesignated')) ? { listedOn: ukDate(firstTag(body, 'DateDesignated')) } : {}),
        birthDates,
        countries,
        ids,
        crypto: cryptoFromText(firstTag(body, 'OtherInformation') ?? ''),
        ...(firstTag(body, 'UNReferenceNumber') ? { unRef: firstTag(body, 'UNReferenceNumber') } : {}),
      }),
    );
  }
  return { ...(generated ? { publishedAt: generated } : {}), entries };
}

// ---------- MSWiA: lista osób i podmiotów objętych sankcjami (ustawa z 13.04.2022) ----------

const MONTHS_PL: Record<string, string> = {
  stycznia: '01', lutego: '02', marca: '03', kwietnia: '04', maja: '05', czerwca: '06',
  lipca: '07', sierpnia: '08', wrzesnia: '09', pazdziernika: '10', listopada: '11', grudnia: '12',
};

/** „urodzony 5 października 1973 r.” → `1973-10-05`; sam rok „ur. 1973” → `1973`. */
export function parsePolishBirthDates(text: string): string[] {
  const folded = foldText(text);
  const out: string[] = [];
  for (const match of folded.matchAll(/(\d{1,2}) ([a-z]+) (\d{4})/g)) {
    const month = MONTHS_PL[match[2]!];
    if (month) out.push(`${match[3]}-${month}-${match[1]!.padStart(2, '0')}`);
  }
  for (const match of text.matchAll(/\b(\d{2})\.(\d{2})\.(\d{4})\b/g)) out.push(`${match[3]}-${match[2]}-${match[1]}`);
  if (out.length === 0) {
    const year = /\bur(?:odzon[ya])?\.?\s+(?:w\s+)?(\d{4})\b/i.exec(text);
    if (year) out.push(year[1]!);
  }
  return unique(out);
}

const CITIZENSHIP_STEMS: [RegExp, string][] = [
  [/rosyjsk|federacji rosyjskiej|rosji/, 'RU'],
  [/bialorusk|republiki bialorus|bialorusi/, 'BY'],
  [/ukrainsk|ukrainy/, 'UA'],
  [/polsk|polski\b/, 'PL'],
  [/kazachsk/, 'KZ'],
  [/cypryjsk|cypr/, 'CY'],
  [/litewsk|litwa|litwie/, 'LT'],
  [/izraelsk/, 'IL'],
  [/gruzinsk/, 'GE'],
  [/armensk/, 'AM'],
  [/niemieck/, 'DE'],
  [/lotewsk|lotwa/, 'LV'],
];

/** Państwa z opisu tożsamości („obywatel rosyjski”, „w Wilnie (Litwa)”, siedziba w Polsce). */
export function polishCountries(text: string): string[] {
  const folded = foldText(text);
  const out: string[] = [];
  for (const [pattern, code] of CITIZENSHIP_STEMS) if (pattern.test(folded)) out.push(code);
  // Polski adres (kod pocztowy NN-NNN) albo numery polskich rejestrów.
  if (/\b\d{2}-\d{3}\b/.test(text) || /\b(KRS|NIP|REGON|PESEL)\b/.test(text)) out.push('PL');
  return unique(out);
}

/** Numery z opisu: PESEL, NIP, KRS, REGON, paszport. */
export function polishIdentifiers(text: string): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  const patterns: [string, RegExp][] = [
    ['PESEL', /PESEL[:\s]*(\d{11})/gi],
    ['NIP', /NIP[:\s]*((?:PL)?[\d\s-]{10,13})/gi],
    ['KRS', /KRS[:\s]*(\d{10})/gi],
    ['REGON', /REGON[:\s]*(\d{9}(?:\d{5})?)/gi],
    ['Paszport', /paszport[a-z]*[^\d\n]{0,20}([A-Z0-9]{6,12})/gi],
  ];
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = match[1]!.replace(/[\s-]/g, '');
      if (value.length >= 6 && !out.some((item) => item.kind === kind && item.value === value)) out.push({ kind, value });
    }
  }
  return out;
}

/** Środki sankcyjne w skrócie (jako „programy” wpisu). */
function polishMeasures(text: string): string[] {
  const folded = foldText(text);
  const out: string[] = [];
  if (folded.includes('zamrozenie')) out.push('zamrożenie środków finansowych i zasobów gospodarczych');
  if (folded.includes('niepozadany') || folded.includes('niepozadan')) out.push('wpis do wykazu cudzoziemców, których pobyt w RP jest niepożądany');
  if (folded.includes('wykluczenie z postepowania') || folded.includes('zamowienia publicznego')) out.push('wykluczenie z postępowania o udzielenie zamówienia publicznego');
  return out;
}

/** Nazwa z komórki: „BELOV Alexey (BELOV Alexy)” → dwie nazwy. */
export function splitPolishNames(cell: string): string[] {
  const line = cell.replace(/\s+/g, ' ').trim();
  const out = [line.replace(/\s*\([^)]*\)\s*/g, ' ').trim()];
  for (const match of line.matchAll(/\(([^)]+)\)/g)) {
    const inner = match[1]!.trim();
    // Nawias z adnotacją, nie z nazwą (np. „(dawniej …)”) — bierzemy treść po słowie kluczowym.
    const cleaned = inner.replace(/^(dawniej|obecnie|inaczej|też|tez|także|takze|wcześniej|wczesniej|aka|a\.k\.a\.)\s*:?\s*/i, '');
    if (/[A-Za-zА-Яа-я]{2,}/.test(cleaned)) out.push(cleaned);
  }
  return dedupeNames(out.filter(Boolean));
}

const polishDate = (text: string): string | undefined => {
  const match = /(\d{2})\.(\d{2})\.(\d{4})/.exec(text);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
};

/**
 * Tabele „Osoby” i „Podmioty” ze strony gov.pl MSWiA. Wiersz: nazwa, dane identyfikacyjne, uzasadnienie,
 * środki, data umieszczenia na liście, data wykreślenia. Uzasadnienia nie przechowujemy (tylko środki).
 */
export function parseMswiaList(html: string, page: string): ParsedList {
  const version = /Lista osób i podmiotów objętych sankcjami\s*\d+\.\d+\s*(\d{2}\.\d{2}\.\d{4})/.exec(htmlToText(html).replace(/\n/g, ' '));
  const entries: RiskListEntry[] = [];
  const sections: { type: 'person' | 'organization'; html: string }[] = [];
  const people = html.indexOf('>Osoby</h3>');
  const companies = html.indexOf('>Podmioty</h3>');
  const end = html.indexOf('>Materiały</h3>');
  if (people >= 0) sections.push({ type: 'person', html: html.slice(people, companies > people ? companies : end > 0 ? end : undefined) });
  if (companies >= 0) sections.push({ type: 'organization', html: html.slice(companies, end > companies ? end : undefined) });
  const seen = new Map<string, number>();
  for (const section of sections) {
    // Dzielimy po `<tr`, więc wiersz tabeli zewnętrznej (z zagnieżdżoną tabelą) nie ma własnych komórek.
    for (const chunk of section.html.split(/<tr\b/i).slice(1)) {
      const row = chunk.slice(0, chunk.search(/<\/tr>/i) >= 0 ? chunk.search(/<\/tr>/i) : chunk.length);
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => htmlToText(cell[1]!));
      if (cells.length < 5) continue;
      const [nameCell, identity, , measures, listed, delisted] = cells;
      if (!nameCell || /Nazwisko i imię|Nazwa podmiotu/i.test(nameCell)) continue;
      const names = splitPolishNames(nameCell);
      if (names.length === 0) continue;
      // Identyfikator z nazwy (lista nie nadaje numerów) — stały mimo dopisywania wierszy w środku tabeli.
      const prefix = section.type === 'person' ? 'osoba' : 'podmiot';
      const slug = `${prefix}:${foldText(names[0]!).replace(/ /g, '-').slice(0, 60)}`;
      const count = (seen.get(slug) ?? 0) + 1;
      seen.set(slug, count);
      entries.push(
        compactEntry({
          id: count === 1 ? slug : `${slug}-${count}`,
          type: section.type,
          names,
          programmes: ['ustawa z 13.04.2022 o przeciwdziałaniu wspieraniu agresji na Ukrainę', ...polishMeasures(measures ?? '')],
          ...(polishDate(listed ?? '') ? { listedOn: polishDate(listed ?? '') } : {}),
          ...(polishDate(delisted ?? '') ? { delistedOn: polishDate(delisted ?? '') } : {}),
          birthDates: section.type === 'person' ? parsePolishBirthDates(identity ?? '') : [],
          countries: polishCountries(identity ?? ''),
          ids: polishIdentifiers(identity ?? ''),
          url: `${page}#${encodeURIComponent(names[0]!)}`,
        }),
      );
    }
  }
  return { ...(version ? { publishedAt: polishDate(version[1]!) } : {}), entries };
}

// ---------- UE: państwa trzecie wysokiego ryzyka (rozporządzenie delegowane 2016/1675, EUR-Lex) ----------

const ROMAN_CATEGORIES: Record<string, string> = {
  I: 'plan działania z FATF (wzmożone monitorowanie)',
  II: 'oświadczenie publiczne FATF, pomoc techniczna',
  III: 'oświadczenie publiczne FATF — wezwanie do działań (ciągłe i znaczne ryzyko)',
  IV: 'członkostwo w FATF zawieszone',
};

/**
 * Załącznik rozporządzenia delegowanego (UE) 2016/1675 w wersji skonsolidowanej (HTML z EUR-Lex):
 * sekcje I–IV z tabelą „Nr | Państwo trzecie wysokiego ryzyka”. Nazwy polskie → kody ISO.
 */
export function parseEuHighRiskCountries(html: string): { jurisdictions: JurisdictionEntry[]; unknown: string[] } {
  const text = htmlToText(html).replace(/\n/g, ' ');
  const annex = text.slice(Math.max(0, text.indexOf('ZAŁĄCZNIK')));
  const jurisdictions: JurisdictionEntry[] = [];
  const unknown: string[] = [];
  const sections = [...annex.matchAll(/\b(I|II|III|IV)\.\s+Państwa trzecie wysokiego ryzyka/g)];
  sections.forEach((section, position) => {
    const from = section.index!;
    const to = sections[position + 1]?.index ?? annex.length;
    const body = annex.slice(from, to);
    const table = body.slice(body.indexOf('Nr Państwo trzecie wysokiego ryzyka') + 'Nr Państwo trzecie wysokiego ryzyka'.length);
    // Nazwa może zawierać pojedynczy ukośnik („Mjanma/Birma”); „//” i „▼” to znaczniki strony EUR-Lex.
    for (const match of table.matchAll(/(?:^|\s)(\d{1,2})\s+((?:[^\d▼/]|\/(?!\/))+?)(?=\s+\d{1,2}\s+|\s*▼|\s*\/\/|\s*$)/g)) {
      const name = match[2]!.trim();
      if (!name || name.length > 60) continue;
      const code = countryCode(name) ?? countryCode(name.replace(/\s*\(.*\)$/, ''));
      if (!code) {
        unknown.push(name);
        continue;
      }
      jurisdictions.push({ country: code, name, category: `${section[1]}. ${ROMAN_CATEGORIES[section[1]!] ?? ''}`.trim() });
    }
  });
  return { jurisdictions, unknown };
}
