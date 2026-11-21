// Łącznik `web-search`: pytanie do OFICJALNEGO API wyszukiwarki internetowej, która ma własny
// indeks i pozwala w regulaminie na zapytania automatyczne oraz przechowanie wyników.
// Wynikiem jest wyłącznie fragment z wyszukiwarki (tytuł, opis, adres strony) — łącznik
// NIE pobiera wskazanych stron. Treść zapytania (identyfikator podmiotu) opuszcza system
// i trafia do dostawcy wyszukiwarki, dlatego łącznik działa tylko po świadomym włączeniu
// zmiennymi środowiskowymi. Podstawa prawna każdego dostawcy: docs/ZRODLA-PODSTAWA-PRAWNA.md.

import { validateAddress } from '@olcys/core';
import type { ConnectorContext, Identifier, IdentifierType, IdentityMatch, SourceConnector, SourceDocument } from '@olcys/core';
import { normalizeAddressText } from '../address-text.ts';
import type { HttpClient, HttpSession } from '../http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, sameHandle, serviceOf } from '../identity.ts';

export const WEB_SEARCH_ID = 'web-search';
const LABEL = 'Wyszukiwarka internetowa (API)';
/** Oznaczenie w treści każdego dokumentu — analityk i raport widzą, że to nie jest pełna strona. */
export const SNIPPET_NOTICE = 'Fragment z wyszukiwarki, nie pełna treść strony';

/** Jedno trafienie tak, jak zwraca je API wyszukiwarki. */
export interface WebSearchResult {
  url: string;
  title: string;
  snippet: string;
  /** Data publikacji lub modyfikacji strony, jeśli wyszukiwarka ją podaje (ISO 8601). */
  publishedAt?: string;
}

export interface WebSearchRequest {
  /** Gotowe zapytanie: fraza w cudzysłowie i ewentualne słowo kontekstu. */
  query: string;
  count: number;
  /** Sesja HTTP łącznika: limit żądań, tempo i obsługa odmów; dostawca nie używa innego klienta. */
  session: HttpSession;
  context: ConnectorContext;
}

/**
 * Dostawca wyników wyszukiwania. Nowego dostawcę wolno dodać dopiero po sprawdzeniu regulaminu
 * (zapytania automatyczne, przechowywanie wyników, odpowiedzialność za treść stron) i dopisaniu
 * go do docs/ZRODLA-PODSTAWA-PRAWNA.md.
 */
export interface WebSearchProvider {
  id: string;
  /** Nazwa pokazywana analitykowi. */
  label: string;
  /** Host, do którego trafia treść zapytania. */
  host: string;
  /** Minimalny odstęp między zapytaniami do dostawcy (limit z jego regulaminu lub dokumentacji). */
  minIntervalMs: number;
  /** Warunki korzystania z wyników dopisywane do każdego dokumentu (licencja, podanie źródła). */
  terms: string;
  /** `null`, gdy zapytanie się nie powiodło (powód jest już w dzienniku). */
  search(request: WebSearchRequest): Promise<WebSearchResult[] | null>;
}

export interface WebSearchOptions {
  /** Najwyżej tyle zapytań do jednego dostawcy dla jednego identyfikatora (domyślnie 3). */
  maxQueriesPerIdentifier?: number;
  /** Liczba wyników jednego zapytania (domyślnie 10). */
  resultsPerQuery?: number;
  /** Dzienny limit zapytań do jednego dostawcy w tym procesie (domyślnie 200) — ochrona budżetu klucza. */
  maxQueriesPerDay?: number;
  /**
   * Hosty, które narzędzie i tak wolno mu odpytywać własnymi łącznikami; adres wyniku z takiego hosta
   * wraca jako identyfikator `profile_url`, żeby właściwy łącznik pobrał stronę na własnych zasadach.
   */
  followHosts?: string[];
  /** Zegar do testów dziennego limitu. */
  now?: () => Date;
}

const DEFAULT_MAX_QUERIES = 3;
const DEFAULT_RESULTS = 10;
const DEFAULT_DAILY = 200;
/** Hosty obsługiwane przez istniejące łączniki live (GitHub, Keybase, Telegram, Gravatar, Bitcointalk). */
export const DEFAULT_FOLLOW_HOSTS = ['github.com', 'gist.github.com', 'keybase.io', 't.me', 'telegram.me', 'gravatar.com', 'bitcointalk.org'];
/** Serwisy, w których pierwszy człon ścieżki jest nazwą konta. */
const HANDLE_HOSTS = ['github.com', 'gitlab.com', 'keybase.io', 't.me', 'telegram.me', 'x.com', 'twitter.com', 'farcaster.xyz', 'warpcast.com'];

/** Słowa kontekstu kryptowalutowego dopisywane do imienia i nazwiska — każde w osobnym zapytaniu. */
const NAME_CONTEXT = ['bitcoin', 'kryptowaluty', 'ethereum', 'adres portfela BTC'];
/** Dla nicka najpierw sama fraza, potem kontekst. */
const NICK_CONTEXT = ['', 'bitcoin', 'kryptowaluty'];

const EMAIL = /^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/;

const quote = (phrase: string): string => `"${phrase.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;

export interface WebQueryPlan {
  /** Dokładna fraza, która musi wystąpić w tytule, fragmencie albo adresie wyniku. */
  phrase: string;
  queries: string[];
}

/**
 * Zapytania dla identyfikatora; `null`, gdy identyfikator nie nadaje się do wyszukiwarki
 * (za krótki nick, pojedyncze słowo zamiast imienia i nazwiska, niepoprawny adres).
 */
export function buildWebQueries(identifier: Identifier, maxQueries = DEFAULT_MAX_QUERIES): WebQueryPlan | null {
  const cap = Math.max(1, maxQueries);
  const raw = identifier.value.trim();
  switch (identifier.type) {
    case 'crypto_address': {
      if (!validateAddress(raw)) return null;
      return { phrase: raw, queries: [quote(raw)] };
    }
    case 'email': {
      const email = raw.toLowerCase();
      if (!EMAIL.test(email)) return null;
      return { phrase: email, queries: [quote(email)] };
    }
    case 'full_name': {
      const name = raw.replace(/\s+/g, ' ');
      // Samo imię albo samo nazwisko daje wyłącznie przypadkowe trafienia.
      if (name.split(' ').filter((word) => word.length >= 2).length < 2 || name.length > 80) return null;
      return { phrase: name, queries: NAME_CONTEXT.slice(0, cap).map((term) => `${quote(name)} ${term}`) };
    }
    case 'nick':
    case 'login':
    case 'messenger_id': {
      const handle = cleanHandle(raw);
      // Krótkie nazwy i nazwy ze spacjami są zbyt pospolite, żeby fraza cokolwiek znaczyła.
      if (!/^[\p{L}\p{N}._-]{5,40}$/u.test(handle)) return null;
      return { phrase: handle, queries: NICK_CONTEXT.slice(0, cap).map((term) => (term ? `${quote(handle)} ${term}` : quote(handle))) };
    }
    default:
      return null;
  }
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** Czy wynik naprawdę zawiera szukaną frazę (dopasowanie dokładne, bez rozróżniania wielkości liter). */
export function resultMentions(result: WebSearchResult, phrase: string, type: IdentifierType): boolean {
  const haystack = `${result.title}\n${result.snippet}\n${result.url}`;
  if (type === 'crypto_address') {
    const normalized = normalizeAddressText(haystack);
    // Adresy z mieszaną wielkością liter (Base58, suma kontrolna EVM) porównujemy bez zmiany liter tylko dla EVM.
    return /^0x/i.test(phrase) ? normalized.toLowerCase().includes(phrase.toLowerCase()) : normalized.includes(phrase);
  }
  const text = fold(haystack);
  const wanted = fold(phrase);
  if (type === 'full_name' || type === 'email') return text.includes(wanted);
  // Nick jako całe słowo: „satoshi" nie pasuje do „satoshi2".
  const at = text.indexOf(wanted);
  if (at < 0) return false;
  const boundary = /[\p{L}\p{N}_]/u;
  for (let index = at; index >= 0; index = text.indexOf(wanted, index + 1)) {
    const before = text[index - 1] ?? ' ';
    const after = text[index + wanted.length] ?? ' ';
    if (!boundary.test(before) && !boundary.test(after)) return true;
  }
  return false;
}

/** Czy adres wyniku jest stroną profilu dokładnie tego konta (np. github.com/<nick>). */
export function isProfileOfHandle(url: URL, handle: string): boolean {
  if (!HANDLE_HOSTS.includes(serviceOf(url))) return false;
  const segments = url.pathname.split('/').filter(Boolean);
  return segments.length === 1 && sameHandle(decodeURIComponent(segments[0]!), handle);
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createWebSearchConnector(http: HttpClient, providers: WebSearchProvider[], options: WebSearchOptions = {}): SourceConnector {
  const maxQueries = options.maxQueriesPerIdentifier ?? DEFAULT_MAX_QUERIES;
  const count = options.resultsPerQuery ?? DEFAULT_RESULTS;
  const dailyLimit = options.maxQueriesPerDay ?? DEFAULT_DAILY;
  const followHosts = options.followHosts ?? DEFAULT_FOLLOW_HOSTS;
  const now = options.now ?? (() => new Date());
  const active = providers.length > 0;
  const used = new Map<string, { day: string; count: number }>();

  /** Rezerwuje jedno zapytanie z dziennego limitu dostawcy; `false`, gdy limit jest wyczerpany. */
  function reserve(provider: WebSearchProvider): boolean {
    const day = dayKey(now());
    const entry = used.get(provider.id);
    if (!entry || entry.day !== day) {
      used.set(provider.id, { day, count: 1 });
      return true;
    }
    if (entry.count >= dailyLimit) return false;
    entry.count += 1;
    return true;
  }

  const providerList = providers.map((provider) => `${provider.label} (${provider.host})`).join(', ');
  const description = active
    ? `UWAGA: treść zapytania (identyfikator podmiotu) jest wysyłana do zewnętrznego dostawcy wyszukiwarki: ${providerList}. ` +
      'Łącznik pyta oficjalne API wyszukiwarki z własnym indeksem i zwraca wyłącznie fragmenty z wyszukiwarki (tytuł, opis, adres strony) — ' +
      'wskazanych stron nie pobiera. Zapytania: adres kryptowalutowy i e-mail — dokładna fraza w cudzysłowie (1 zapytanie); imię i nazwisko — ' +
      `fraza w cudzysłowie z jednym słowem kontekstu na zapytanie (${NAME_CONTEXT.join(', ')}); nick, login, komunikator (od 5 znaków) — sama fraza, ` +
      `potem z kontekstem (${NICK_CONTEXT.filter(Boolean).join(', ')}). Najwyżej ${maxQueries} zapytania na identyfikator na dostawcę, ${count} wyników na zapytanie, ` +
      `${dailyLimit} zapytań dziennie na dostawcę. Zostają tylko wyniki zawierające dokładnie szukaną frazę. Dopasowanie tożsamości zawsze najsłabsze ` +
      '(„tylko nazwa"), chyba że wynik jest stroną profilu o nazwie równej nickowi („ten sam nick"). Wyniki nie są powtarzalne — indeks wyszukiwarki zmienia się w czasie.'
    : 'WYŁĄCZONY — brak skonfigurowanego dostawcy. Łącznik wysyłałby treść zapytania (identyfikator podmiotu) do zewnętrznej wyszukiwarki, ' +
      'więc działa tylko po świadomym podaniu klucza: MARGINALIA_API_KEY (Marginalia Search) albo MOJEEK_API_KEY razem z MOJEEK_STORAGE_RIGHTS=1 (Mojeek, plan z prawem przechowywania wyników).';

  return {
    id: WEB_SEARCH_ID,
    service: 'wyszukiwarka',
    label: LABEL,
    description,
    accepts: ['full_name', 'nick', 'login', 'email', 'crypto_address', 'messenger_id'],
    enabledByDefault: active,

    async search(identifier, context) {
      if (!active) {
        context.log(`${LABEL}: wyłączony — brak skonfigurowanego dostawcy. Źródło pominięte.`);
        return [];
      }
      const plan = buildWebQueries(identifier, maxQueries);
      if (!plan) return [];
      const type = identifier.type;
      const documents = new Map<string, SourceDocument>();

      for (const provider of providers) {
        const session = http.session(context, {
          label: `${LABEL} — ${provider.label}`,
          limit: maxQueries,
          refusalMessage: (status) => `${LABEL} — ${provider.label}: odmowa lub limit zapytań (kod ${status}); nie ponawiam.`,
        });
        let kept = 0;
        let asked = 0;
        for (const query of plan.queries) {
          if (context.signal?.aborted || session.refused) break;
          if (!reserve(provider)) {
            context.log(`${LABEL} — ${provider.label}: wyczerpano dzienny limit ${dailyLimit} zapytań; pomijam.`);
            break;
          }
          asked += 1;
          const results = await provider.search({ query, count, session, context });
          if (!results) continue;
          for (const result of results.slice(0, count)) {
            const url = /^https?:\/\//i.test(result.url) ? parseHttpUrl(result.url) : null;
            if (!url || !resultMentions(result, plan.phrase, type)) continue;
            const key = url.toString();
            if (documents.has(key)) continue;
            documents.set(key, toDocument(result, url, provider, query, identifier, plan.phrase, followHosts));
            kept += 1;
          }
        }
        // Do dziennika trafia liczba zapytań i wyników — nigdy klucz API.
        context.log(`${LABEL} — ${provider.label}: ${asked} zapytań do ${provider.host}, ${kept} wyników z frazą „${plan.phrase}".`);
      }
      return [...documents.values()];
    },
  };
}

function toDocument(
  result: WebSearchResult,
  url: URL,
  provider: WebSearchProvider,
  query: string,
  identifier: Identifier,
  phrase: string,
  followHosts: string[],
): SourceDocument {
  const type = identifier.type;
  const host = serviceOf(url);
  const handleQuery = type === 'nick' || type === 'login' || type === 'messenger_id';
  const profileOfHandle = handleQuery && isProfileOfHandle(url, phrase);
  const identityMatch: IdentityMatch = profileOfHandle ? 'same_handle' : 'name_only';

  // Adres wyniku wraca jako identyfikator tylko dla hostów, które narzędzie odpytuje własnymi łącznikami,
  // i tylko gdy nie grozi to pomyleniem osób: strona z szukanym adresem/e-mailem albo profil o tej samej nazwie.
  const follow = followHosts.includes(host) && (type === 'crypto_address' || type === 'email' || profileOfHandle);
  const discovered: Identifier[] = follow ? [{ type: 'profile_url', value: url.toString() }] : [];

  const text = [
    `${SNIPPET_NOTICE} (dostawca: ${provider.label}, ${provider.host}; zapytanie: ${query}).`,
    'Strona nie została pobrana ani sprawdzona — przed użyciem jako dowód trzeba ją obejrzeć pod podanym adresem.',
    `Tytuł: ${result.title || '(brak)'}`,
    `Adres strony: ${url.toString()}`,
    `Fragment: ${result.snippet || '(brak)'}`,
    `Warunki dostawcy: ${provider.terms}`,
  ].join('\n');

  return {
    connectorId: WEB_SEARCH_ID,
    // Ślad pochodzi ze wskazanej strony; wyszukiwarka jest tylko pośrednikiem i nie liczy się jako niezależne źródło.
    service: host,
    url: url.toString(),
    title: `[fragment z wyszukiwarki: ${provider.label}] ${result.title || url.toString()}`.slice(0, 300),
    text,
    fetchedAt: new Date().toISOString(),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
    category: 'forum_post',
    identityMatch,
    matchedIdentifier: identifier,
    ...(profileOfHandle ? { author: phrase, profile: { handle: phrase, urls: [url.toString()] } } : {}),
    ...discoveredField(dedupeIdentifiers(discovered, identifier)),
  };
}
