// Kandydaci z imienia i nazwiska: typowe nicki i domeny osobiste, które analiza może sprawdzić,
// gdy analityk podał wyłącznie imię i nazwisko. To ZGADYWANIE — konto albo strona o takiej nazwie
// może należeć do imiennika, więc każdy wynik jest słaby („zgodne tylko imię i nazwisko”), dopóki
// nie potwierdzi go drugi identyfikator sprawy. Listy są małe i deterministyczne (ta sama kolejność
// przy każdym uruchomieniu), a sprawdzanie ma twarde limity.

import { Resolver } from 'node:dns/promises';
import type { ConnectorContext, Identifier, SourceConnector, SourceDocument } from '@olcys/core';

/** Najwyżej tyle nicków powstaje z jednego imienia i nazwiska. */
export const MAX_NICK_CANDIDATES = 8;
/** Najwyżej tyle domen sprawdzamy w DNS dla jednego imienia i nazwiska. */
export const MAX_DOMAIN_CHECKS = 12;
/** Najwyżej tyle stron głównych istniejących domen pobieramy. */
export const MAX_DOMAIN_FETCHES = 4;

/** Przesłanka dla konta znalezionego po nicku wygenerowanym z imienia i nazwiska. */
export const NICK_CANDIDATE_REASON = 'konto o nazwie wygenerowanej z imienia i nazwiska — możliwy imiennik';
/** Przesłanka dla strony w domenie wygenerowanej z imienia i nazwiska. */
export const DOMAIN_CANDIDATE_REASON = 'strona w domenie wygenerowanej z imienia i nazwiska — możliwy imiennik';
/** Przesłanka dla profilu znalezionego wyszukiwarką kont po imieniu i nazwisku. */
export const NAME_SEARCH_REASON = 'konto znalezione wyszukiwarką kont po imieniu i nazwisku — możliwy imiennik';

/**
 * Wpis dziennika łącznika zaczynający się od tego przedrostka analiza zapisuje także jako powód
 * zatrzymania (limit łącznika) — analityk widzi, ile sprawdzono i ile pominięto.
 */
export const CONNECTOR_STOP_PREFIX = 'Powód zatrzymania: ';

const FOLD: Record<string, string> = { ł: 'l', Ł: 'l', ø: 'o', Ø: 'o', ß: 'ss', đ: 'd', Đ: 'd', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe' };

/** Małe litery bez znaków diakrytycznych (Łukasz → lukasz, Żółć → zolc). */
export function foldName(value: string): string {
  return value
    .replace(/[łŁøØßđĐæÆœŒ]/g, (char) => FOLD[char] ?? char)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Słowa nazwy po złożeniu znaków; łącznik w nazwisku dwuczłonowym rozdziela słowa. */
export function nameTokens(value: string): string[] {
  return foldName(value)
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter(Boolean);
}

/**
 * Zgodność nazwy wyświetlanej z imieniem i nazwiskiem, bez znaków diakrytycznych i bez względu na kolejność słów:
 * `exact` — te same słowa, `contains` — wszystkie słowa imienia i nazwiska plus inne (np. drugie imię), `null` — brak zgodności.
 */
export function displayNameMatch(displayName: string | undefined, fullName: string): 'exact' | 'contains' | null {
  const wanted = [...new Set(nameTokens(fullName))];
  if (!displayName || wanted.length < 2) return null;
  const have = new Set(nameTokens(displayName));
  if (!wanted.every((token) => have.has(token))) return null;
  return have.size === wanted.length ? 'exact' : 'contains';
}

/** Czy tekst (np. strona główna) zawiera wszystkie słowa imienia i nazwiska jako osobne słowa. */
export function textContainsName(text: string, fullName: string): boolean {
  const wanted = [...new Set(nameTokens(fullName))];
  if (wanted.length < 2) return false;
  const words = new Set(nameTokens(text));
  return wanted.every((token) => words.has(token));
}

/** Imię (pierwsze słowo) i nazwisko (ostatnie słowo, z łącznikiem dwuczłonowego) po złożeniu znaków. */
function nameParts(fullName: string): { first: string; last: string; lastPlain: string } | null {
  const words = foldName(fullName)
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  if (words.length < 2) return null;
  const first = words[0]!.replace(/-/g, '');
  const last = words.at(-1)!;
  const lastPlain = last.replace(/-/g, '');
  if (first.length < 2 || lastPlain.length < 2) return null;
  return { first, last, lastPlain };
}

const NICK = /^[a-z0-9][a-z0-9._-]{1,38}$/;

/**
 * Typowe polskie wzorce nicków: imięnazwisko, imię.nazwisko, imię_nazwisko, imię-nazwisko, inazwisko,
 * nazwiskoimię, nazwiskoi, nazwisko.imię — po złożeniu znaków diakrytycznych, najwyżej 8, stała kolejność.
 * Nazwisko dwuczłonowe („Kowalska-Nowak”) jest sklejane, a w wariancie z łącznikiem zachowuje łącznik.
 */
export function nickCandidates(fullName: string): string[] {
  const parts = nameParts(fullName);
  if (!parts) return [];
  const { first, last, lastPlain } = parts;
  const all = [
    `${first}${lastPlain}`,
    `${first}.${lastPlain}`,
    `${first}_${lastPlain}`,
    `${first}-${last}`,
    `${first[0]}${lastPlain}`,
    `${lastPlain}${first}`,
    `${lastPlain}${first[0]}`,
    `${lastPlain}.${first}`,
  ];
  return [...new Set(all)].filter((nick) => NICK.test(nick)).slice(0, MAX_NICK_CANDIDATES);
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRIMARY_TLDS = ['pl', 'com'];
const OTHER_TLDS = ['dev', 'eu', 'io', 'net'];

/**
 * Domeny osobiste: imięnazwisko, imię-nazwisko, inazwisko, nazwiskoimię, nazwisko — każdy wzorzec w .pl i .com,
 * potem imięnazwisko w .dev, .eu, .io, .net; najwyżej 12, stała kolejność.
 */
export function domainCandidates(fullName: string): string[] {
  const parts = nameParts(fullName);
  if (!parts) return [];
  const { first, last, lastPlain } = parts;
  // Wzorce osobiste przed samym nazwiskiem (domena z samym nazwiskiem to często firma rodzinna); każdy wzorzec w .pl, potem .com.
  const labels = [`${first}${lastPlain}`, `${first}-${last}`, `${first[0]}${lastPlain}`, `${lastPlain}${first}`, lastPlain].filter((label) => LABEL.test(label));
  const unique = [...new Set(labels)];
  const domains = [
    ...unique.flatMap((label) => PRIMARY_TLDS.map((tld) => `${label}.${tld}`)),
    ...OTHER_TLDS.map((tld) => `${unique[0]}.${tld}`),
  ];
  return [...new Set(domains)].slice(0, MAX_DOMAIN_CHECKS);
}

// ---------- Łącznik: domeny osobiste z imienia i nazwiska ----------

/** Czy nazwa domeny ma adres w DNS; `false` przy braku wpisu albo błędzie. */
export type DomainExists = (domain: string, signal?: AbortSignal) => Promise<boolean>;

const DNS_TIMEOUT_MS = 3_000;
/** Limit czasu jednej strony głównej (robots.txt + strona) — całość mieści się w limicie zapytania analizy. */
const PAGE_TIMEOUT_MS = 8_000;

// Zapytania DNS przez c-ares (`Resolver`), a nie `lookup`: `lookup` zajmuje wątki puli libuv (domyślnie 4), które
// w trakcie analizy są potrzebne łącznikom pobierającym strony.
const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });

const systemDomainExists: DomainExists = async (domain) => {
  for (const query of [() => resolver.resolve4(domain), () => resolver.resolve6(domain)]) {
    try {
      if ((await query()).length > 0) return true;
    } catch {
      // Brak rekordu tego typu albo błąd — sprawdzamy następny typ.
    }
  }
  return false;
};

export interface NameDomainsOptions {
  /** Sprawdzenie istnienia domeny; domyślnie systemowy resolver DNS (node:dns). */
  domainExists?: DomainExists | undefined;
  maxChecks?: number;
  maxFetches?: number;
}

export const NAME_DOMAINS_ID = 'live-domeny-osobiste';

/**
 * Strona osobista bez wyszukiwarki: domeny wygenerowane z imienia i nazwiska → sprawdzenie w DNS → strona główna
 * pobrana łącznikiem `live-www` (robots.txt, jedna strona) → przyjęta tylko, gdy zawiera imię i nazwisko.
 */
export function createNameDomainsConnector(www: SourceConnector, options: NameDomainsOptions = {}): SourceConnector {
  const exists = options.domainExists ?? systemDomainExists;
  const maxChecks = Math.min(options.maxChecks ?? MAX_DOMAIN_CHECKS, MAX_DOMAIN_CHECKS);
  const maxFetches = Math.min(options.maxFetches ?? MAX_DOMAIN_FETCHES, MAX_DOMAIN_FETCHES);
  const label = 'Domeny osobiste z imienia i nazwiska';
  return {
    id: NAME_DOMAINS_ID,
    service: 'www',
    label,
    description:
      `Imię i nazwisko → najwyżej ${maxChecks} domen osobistych (imięnazwisko, imię-nazwisko, inazwisko, nazwiskoimię, nazwisko; ` +
      'każdy wzorzec w .pl i .com, potem imięnazwisko w .dev i .eu) sprawdzanych w DNS (systemowy resolver — nazwa domeny trafia do serwera DNS). ' +
      `Strona główna najwyżej ${maxFetches} istniejących domen jest pobierana łącznikiem „Strona WWW” (najpierw robots.txt, jedna strona, bez podstron). ` +
      'Strona jest przyjmowana tylko wtedy, gdy zawiera imię i nazwisko (bez znaków diakrytycznych, w dowolnej kolejności) — i nadal jako ' +
      '„zgodne tylko imię i nazwisko” (możliwy imiennik), dopóki nie potwierdzi jej drugi identyfikator sprawy.',
    accepts: ['full_name'],
    enabledByDefault: true,

    async search(identifier: Identifier, context: ConnectorContext): Promise<SourceDocument[]> {
      if (identifier.type !== 'full_name') return [];
      const domains = domainCandidates(identifier.value).slice(0, maxChecks);
      if (domains.length === 0) return [];
      const checks = await Promise.all(domains.map(async (domain) => ((await exists(domain, context.signal)) ? domain : null)));
      const existing = checks.filter((domain): domain is string => domain !== null);
      const documents: SourceDocument[] = [];
      let rejected = 0;
      // Strony pobieramy równolegle, każdą z własnym limitem czasu — wolny serwer nie zabiera czasu pozostałym.
      const chosen = context.signal?.aborted ? [] : existing.slice(0, maxFetches);
      const fetched = chosen.length;
      const results = await Promise.all(
        chosen.map((domain) => {
          const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(PAGE_TIMEOUT_MS)]) : AbortSignal.timeout(PAGE_TIMEOUT_MS);
          return www.search({ type: 'profile_url', value: `https://${domain}/` }, { signal, log: context.log }).catch(() => [] as SourceDocument[]);
        }),
      );
      for (const pages of results) {
        for (const page of pages) {
          const haystack = [page.title, page.text, page.profile?.displayName ?? ''].join('\n');
          if (!textContainsName(haystack, identifier.value)) {
            rejected++;
            continue;
          }
          documents.push({
            ...page,
            connectorId: NAME_DOMAINS_ID,
            category: 'own_profile',
            identityMatch: 'name_only',
            identityNote: DOMAIN_CANDIDATE_REASON,
            matchedIdentifier: identifier,
          });
        }
      }
      const skipped = Math.max(0, existing.length - maxFetches);
      context.log(
        `${label}: „${identifier.value}” — domen sprawdzonych w DNS ${domains.length}, istniejących ${existing.length}` +
          (existing.length > 0 ? ` (${existing.join(', ')})` : '') +
          `, pobranych stron ${fetched}, przyjętych ${documents.length}` +
          (rejected > 0 ? `, odrzuconych (strona bez imienia i nazwiska) ${rejected}` : '') +
          (skipped > 0 ? `; pominięto ${skipped} dalszych istniejących domen (limit ${maxFetches} stron)` : '') +
          '.',
      );
      context.log(
        `${CONNECTOR_STOP_PREFIX}domeny osobiste z imienia i nazwiska „${identifier.value}”: sprawdzono w DNS ${domains.length} (limit ${maxChecks}), ` +
          `istnieje ${existing.length}, pobrano stron ${fetched} (limit ${maxFetches}), przyjęto ${documents.length}` +
          (skipped > 0 ? `, pominięto istniejących domen ${skipped}` : '') +
          '.',
      );
      return documents;
    },
  };
}
