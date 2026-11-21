// Monitoring źródeł: wspólne typy i narzędzia adapterów silników.
// Adapter obsługuje SILNIK (RSS, Discourse, Reddit…), a nie pojedynczą stronę —
// nowe źródło to jeden wpis w config/monitor-sources.json, bez zmian w kodzie.

import { extractAddresses } from '@olcys/core';
import type { ConnectorContext, Identifier, IdentifierType, ProfileAttributes, SourceCategory, SourceDocument } from '@olcys/core';
import { findEnsNames, normalizeAddressText } from '../address-text.ts';
import { findEmails, htmlToText } from '../html.ts';
import type { HttpClient, HttpSession } from '../http.ts';
import { dedupeIdentifiers, isTechnicalEmail } from '../identity.ts';

export type MonitorEngine =
  | 'rss'
  | 'discourse'
  | 'reddit'
  | 'mastodon-tag'
  | 'telegram'
  | 'stackexchange'
  | 'hn'
  | 'lemmy'
  | 'smf-board'
  | 'html-list'
  | 'github-search';

/** Selektory silnika `html-list`: `tag`, `.klasa`, `tag.klasa`, `[atrybut*=wartość]`, oddzielone spacją (potomek). */
export interface HtmlListSelectors {
  /** Element jednego wątku na liście. */
  item: string;
  /** Odnośnik do wątku wewnątrz elementu (tekst odnośnika jest tytułem). */
  link: string;
  author?: string;
  date?: string;
}

/** Jeden wpis rejestru źródeł (config/monitor-sources.json). */
export interface MonitorSourceConfig {
  id: string;
  engine: MonitorEngine;
  label: string;
  /** Adres kanału RSS/Atom, forum Discourse albo strony z listą wątków. */
  url?: string;
  /** Host instancji Mastodona. */
  instance?: string;
  /** Numer działu (Bitcointalk i inne fora SMF: kanał RSS działu). */
  board?: string | number;
  /** Nazwa subreddita (bez `r/`). */
  sub?: string;
  /** Hashtag bez `#`. */
  tag?: string;
  /** Nazwa publicznego kanału Telegram. */
  channel?: string;
  /** Nazwa serwisu StackExchange (np. `bitcoin`). */
  site?: string;
  /** Fraza dla silników wyszukujących (HN, GitHub). */
  query?: string;
  /** Nazwa społeczności Lemmy (bez `!` i hosta). */
  community?: string;
  /** Data ostatniego ręcznego sprawdzenia źródła (RRRR-MM-DD) i liczba pozycji, które wtedy zwróciło. */
  verifiedAt?: string;
  verifiedItems?: number;
  selectors?: HtmlListSelectors;
  language?: string;
  region?: string;
  /** Domyślnie `forum_post`; ogłoszenia P2P → `sale_offer`. */
  category?: SourceCategory;
  /** Domyślnie włączone. */
  enabled?: boolean;
  /** Uwagi, w tym powód wyłączenia. */
  note?: string;
  /** Tani filtr wstępny: zwracaj tylko posty zawierające adres kryptowalutowy. */
  onlyWithAddresses?: boolean;
}

/** Post w postaci wspólnej dla wszystkich silników. */
export interface MonitorPost {
  url: string;
  title: string;
  text: string;
  /** Usługa pochodzenia posta (host forum, instancji). */
  service: string;
  author?: string;
  publishedAt?: string;
  profile?: ProfileAttributes;
  discovered?: Identifier[];
}

export interface EngineRun {
  source: MonitorSourceConfig;
  http: HttpClient;
  session: HttpSession;
  context: ConnectorContext;
  /** Minimalny odstęp między żądaniami do hosta tego źródła. */
  intervalMs: number;
  /** Ile źródeł tego samego hosta bierze udział w przebiegu — do dzielenia limitu żądań na host. */
  hostQueueSize?: number;
  githubToken?: string;
}

export interface EngineAdapter {
  /** Typy identyfikatorów, po których źródło da się przeszukać bez logowania. */
  accepts: IdentifierType[];
  /** Opis: co dokładnie jest odpytywane. */
  describe(source: MonitorSourceConfig): string;
  /** Wartość `service` łącznika. */
  service(source: MonitorSourceConfig): string;
  /** Powód, dla którego wpisu nie da się użyć (brak wymaganego pola); `null`, gdy wpis jest poprawny. */
  problem(source: MonitorSourceConfig): string | null;
  /** Odstęp między żądaniami; domyślnie 1 s. */
  intervalMs?: number;
  /** Limit żądań na źródło w jednym przebiegu; domyślnie 2. */
  maxRequests?: number;
  /** Host, do którego idzie pierwsze żądanie — według niego przebieg monitoringu układa kolejki. */
  requestHost(source: MonitorSourceConfig): string;
  /** Klucz do wykrywania powtórzonych wpisów rejestru (ten sam adres pod innym `id`). */
  addressKey(source: MonitorSourceConfig): string;
  discover(run: EngineRun, limit: number): Promise<MonitorPost[]>;
  search?(run: EngineRun, identifier: Identifier): Promise<MonitorPost[]>;
}

/** Jedno żądanie na źródło na przebieg; drugie tylko jako zapas (Discourse /posts.json → /latest.json, Reddit → old.reddit.com). */
export const MAX_REQUESTS_PER_RUN = 2;
/** Reddit i t.me: co najmniej 2 s między żądaniami do tego samego hosta. */
export const SLOW_INTERVAL_MS = 2000;
export const FORUM_INTERVAL_MS = 1000;
const MAX_TEXT_CHARS = 20_000;

export const hostOf = (value: string | undefined): string => {
  try {
    return new URL(/^https?:\/\//i.test(value ?? '') ? value! : `https://${value ?? ''}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Adres w postaci do porównań: bez schematu, „www.", końcowego ukośnika i wielkości liter w nazwie hosta. */
export const normalizedUrl = (value: string | undefined): string => {
  try {
    const url = new URL(/^https?:\/\//i.test(value ?? '') ? value! : `https://${value ?? ''}`);
    return `${url.hostname.toLowerCase().replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return (value ?? '').trim().toLowerCase();
  }
};

/**
 * Klucz działu forum SMF niezależny od silnika: ten sam dział podany jako kanał RSS,
 * lista HTML albo wpis `smf-board` to jedno źródło. `null`, gdy adres nie wskazuje działu.
 */
export const boardKey = (value: string | undefined): string | null => {
  const board = /[?;&]board=(\d+)/.exec(value ?? '')?.[1];
  return board && hostOf(value) ? `board:${hostOf(value)}:${board}` : null;
};

/** Adres bazowy bez końcowego ukośnika, ze schematem https, gdy go brak. */
export const baseUrl = (value: string): string => (/^https?:\/\//i.test(value) ? value : `https://${value}`).replace(/\/+$/, '');

/** Usuwa elementy o klasie zawierającej podane słowo oraz znaczniki o podanych nazwach — razem z zawartością. */
export function removeElements(html: string, tags: string[], classWord?: string): string {
  let out = html;
  for (let guard = 0; guard < 200; guard++) {
    const tagPattern = tags.length > 0 ? `<(${tags.join('|')})\\b[^>]*>` : null;
    const classPattern = classWord ? `<([a-zA-Z0-9]+)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*${classWord}[^"']*["'][^>]*>` : null;
    const open = new RegExp([tagPattern, classPattern].filter(Boolean).join('|'), 'i').exec(out);
    if (!open) break;
    const tag = (open[1] ?? open[2])!;
    const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    walker.lastIndex = open.index + open[0].length;
    let depth = 1;
    let end = out.length;
    for (let step = walker.exec(out); step; step = walker.exec(out)) {
      depth += step[1] ? -1 : 1;
      if (depth === 0) {
        end = step.index + step[0].length;
        break;
      }
    }
    out = `${out.slice(0, open.index)} ${out.slice(end)}`;
  }
  return out;
}

/** Treść posta bez cytatów innych osób (blockquote, bloki „quote" forów i Discourse). */
export function postText(html: string): string {
  return normalizeAddressText(htmlToText(removeElements(html, ['blockquote'], 'quote'))).slice(0, MAX_TEXT_CHARS);
}

/** Zamienia posty na dokumenty: najnowsze najpierw, bez powtórzeń adresów, do limitu. */
export function toDocuments(
  connectorId: string,
  source: MonitorSourceConfig,
  posts: MonitorPost[],
  limit: number,
  onlyWithAddresses: boolean,
  matched?: Identifier,
): SourceDocument[] {
  const seen = new Set<string>();
  const documents: SourceDocument[] = [];
  const sorted = [...posts].sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
  for (const post of sorted) {
    if (documents.length >= limit) break;
    const text = post.text.trim();
    if (!post.url || seen.has(post.url) || (!text && !post.title.trim())) continue;
    const body = text || post.title;
    if (onlyWithAddresses && extractAddresses(body).length === 0) continue;
    seen.add(post.url);
    const author = post.author?.trim().replace(/^@/, '') || undefined;
    const emails = findEmails(body)
      .filter((email) => !isTechnicalEmail(email))
      .map((value): Identifier => ({ type: 'email', value }));
    const ensNames = findEnsNames(body).map((value): Identifier => ({ type: 'ens_name', value }));
    const discovered = dedupeIdentifiers([...(post.discovered ?? []), ...emails, ...ensNames], undefined, [post.service]).slice(0, 8);
    documents.push({
      connectorId,
      service: post.service,
      url: post.url,
      title: post.title.trim() || body.slice(0, 80),
      text: body,
      fetchedAt: new Date().toISOString(),
      category: source.category ?? 'forum_post',
      // Wyszukiwanie po adresie zwraca posty cudzego autorstwa — o powiązaniu decyduje analiza.
      identityMatch: matched?.type === 'crypto_address' ? 'name_only' : 'exact_identifier',
      matchedIdentifier: matched ?? { type: 'nick', value: author ?? source.id },
      ...(author ? { author } : {}),
      ...(post.publishedAt ? { publishedAt: post.publishedAt } : {}),
      ...(author ? { profile: { handle: author, ...post.profile } } : {}),
      ...(discovered.length > 0 ? { discoveredIdentifiers: discovered } : {}),
    });
  }
  return documents;
}

/** Data w dowolnym zapisie → ISO 8601; `undefined`, gdy nie da się jej odczytać. */
export function toIso(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value * 1000 : Date.parse(value);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Nick z identyfikatora wyszukiwania (bez `@`). */
export const searchTerm = (identifier: Identifier): string => identifier.value.trim().replace(/^@/, '');
