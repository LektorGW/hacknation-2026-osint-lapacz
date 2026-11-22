// Łącznik ogólny WWW: pobiera publiczną stronę wskazaną adresem (identyfikator `profile_url`) — stronę
// osobistą albo profil w serwisie bez własnego łącznika. Szanuje robots.txt i nie zagląda pod adresy prywatne.
//
// Ze strony głównej witryny łącznik czyta też kilka podstron tej samej witryny, których nazwa wskazuje
// „o mnie”, kontakt, projekty albo wsparcie (najwyżej 4, bez parametrów zapytania, robots.txt sprawdzany
// dla każdej). Każda podstrona to osobny dokument.
//
// Konta zadeklarowane na stronie (odnośniki, rel="me", schema.org `sameAs`, znaczniki OpenGraph/Twitter,
// ikony w stopce) wracają jako identyfikatory `profile_url` — także w serwisach, których narzędzie NIE pobiera
// (LinkedIn, X, Instagram, Facebook, YouTube, TikTok, Discord…). Takie identyfikatory mają adnotację
// `note` = „nieobsługiwany (deklaracja na stronie, bez pobierania)”, a ten łącznik nigdy ich nie pobiera.

import type { Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, findMeta, findPhones, findRelMeLinks, findTitle, htmlToText } from './html.ts';
import type { HttpClient, HttpResult } from './http.ts';
import { dedupeIdentifiers, discoveredField, isTechnicalEmail, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-www';
const LABEL = 'Strona WWW';
const MAX_TEXT_CHARS = 200_000;
const MAX_DISCOVERED = 24;
/** Najwyżej tyle podstron tej samej witryny czytanych ze strony głównej. */
export const MAX_EXTRA_PAGES = 4;
/** Najwyżej tyle e-maili z samej treści strony (poza mailto: i schema.org). */
const MAX_TEXT_EMAILS = 5;
const CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml'];
/** Człon nazwy z nagłówka User-Agent, po którym robots.txt może nas wskazać. */
const ROBOTS_TOKEN = 'olcys-research';

/** Adnotacja identyfikatora konta w serwisie, którego narzędzie nie pobiera. */
export const DECLARED_ONLY_NOTE = 'nieobsługiwany (deklaracja na stronie, bez pobierania)';

/** Serwisy z własnym łącznikiem — tu pomijane, żeby jedna strona nie dawała dwóch dokumentów. */
const DEDICATED_HOSTS = ['github.com', 'gist.github.com', 'keybase.io', 't.me', 'gravatar.com', 'bitcointalk.org', 'web.archive.org'];

const NOT_PROFILE_PATH =
  /^\/(?:share|sharer|intent|login|signup|search|hashtag|explore|about|privacy|terms|home|watch|sponsors|p|reel|reels|status|i|settings|help|legal|policies|pages|groups|events|jobs|feed|tos|directory|topics|marketplace|results|discover|trending|tag|tags|dialog|plugins|embed)\b/i;

const one = (re: RegExp) => (path: string) => re.exec(path)?.[1] ?? null;
const SIMPLE = /^\/([A-Za-z0-9_.-]{2,40})$/;

interface ProfileHost {
  hosts: string[];
  /** Czy narzędzie ma łącznik tego serwisu (konto jest sprawdzane dalej w analizie). */
  supported: boolean;
  handle: (path: string, url: URL) => string | null;
}

/** Katalog serwisów profilowych: odnośnik ze strony podmiotu do nich to prawdopodobnie jego konto. */
const PROFILE_HOSTS: ProfileHost[] = [
  // Serwisy z łącznikiem (konto sprawdzane w kolejnym kroku analizy).
  { hosts: ['github.com', 'gitlab.com', 'codeberg.org'], supported: true, handle: one(/^\/([A-Za-z0-9_.-]{1,39})(?:\/[^/]+)?$/) },
  { hosts: ['keybase.io', 'gravatar.com', 'warpcast.com', 'keyoxide.org'], supported: true, handle: one(SIMPLE) },
  { hosts: ['t.me', 'telegram.me'], supported: true, handle: one(/^\/([A-Za-z0-9_]{4,32})$/) },
  { hosts: ['bsky.app'], supported: true, handle: one(/^\/profile\/([A-Za-z0-9_.:-]+)$/) },
  { hosts: ['npmjs.com'], supported: true, handle: one(/^\/~([A-Za-z0-9_.-]+)$/) },
  { hosts: ['pypi.org'], supported: true, handle: one(/^\/user\/([A-Za-z0-9_.-]+)$/) },
  { hosts: ['crates.io'], supported: true, handle: one(/^\/users\/([A-Za-z0-9_-]+)$/) },
  { hosts: ['bitcointalk.org'], supported: true, handle: (_path, url) => (/action=profile/.test(url.search) ? (/u=(\d+)/.exec(url.search)?.[1] ?? 'profil') : null) },
  // Serwisy bez łącznika: konto tylko jako deklaracja strony, bez pobierania (rozdz. 5 dokumentu o podstawie prawnej).
  { hosts: ['linkedin.com', 'pl.linkedin.com'], supported: false, handle: (path) => /^\/((?:in|company|pub)\/[^/]+)/.exec(path)?.[1] ?? null },
  { hosts: ['twitter.com', 'x.com', 'mobile.twitter.com'], supported: false, handle: one(/^\/([A-Za-z0-9_]{1,15})$/) },
  { hosts: ['instagram.com'], supported: false, handle: one(/^\/([A-Za-z0-9_.]{1,30})$/) },
  { hosts: ['facebook.com', 'fb.com', 'm.facebook.com', 'pl-pl.facebook.com'], supported: false, handle: one(/^\/([A-Za-z0-9.-]{2,50})$/) },
  { hosts: ['youtube.com', 'm.youtube.com'], supported: false, handle: one(/^\/(@[A-Za-z0-9_.-]+|c\/[A-Za-z0-9_.-]+|channel\/[A-Za-z0-9_-]+|user\/[A-Za-z0-9_.-]+)$/) },
  { hosts: ['tiktok.com'], supported: false, handle: one(/^\/(@[A-Za-z0-9_.]+)$/) },
  { hosts: ['threads.net', 'threads.com'], supported: false, handle: one(/^\/(@[A-Za-z0-9_.]+)$/) },
  { hosts: ['medium.com'], supported: false, handle: one(/^\/(@[A-Za-z0-9_.-]+)$/) },
  { hosts: ['reddit.com', 'old.reddit.com'], supported: false, handle: (path) => /^\/(?:u|user)\/([A-Za-z0-9_-]+)$/.exec(path)?.[1] ?? null },
  { hosts: ['discord.gg'], supported: false, handle: one(/^\/([A-Za-z0-9-]{2,32})$/) },
  {
    hosts: ['discord.com'],
    supported: false,
    handle: (path) => {
      const code = /^\/invite\/([A-Za-z0-9-]{2,32})$/.exec(path)?.[1];
      return code ? `invite/${code}` : null;
    },
  },
  { hosts: ['stackoverflow.com'], supported: false, handle: one(/^\/users\/(\d+(?:\/[A-Za-z0-9_-]+)?)$/) },
  { hosts: ['wykop.pl'], supported: false, handle: one(/^\/ludzie\/([A-Za-z0-9_-]+)$/) },
  { hosts: ['snapchat.com'], supported: false, handle: one(/^\/add\/([A-Za-z0-9_.-]+)$/) },
  {
    hosts: ['twitch.tv', 'pinterest.com', 'pl.pinterest.com', 'patreon.com', 'ko-fi.com', 'buymeacoffee.com', 'behance.net', 'dribbble.com', 'soundcloud.com', 'vk.com', 'huggingface.co', 'tumblr.com'],
    supported: false,
    handle: one(SIMPLE),
  },
];

const HOST_INDEX = new Map(PROFILE_HOSTS.flatMap((entry) => entry.hosts.map((host) => [host, entry] as const)));

/** Konto zadeklarowane na stronie: serwis, nazwa konta i adres w postaci kanonicznej. */
export interface DeclaredAccount {
  host: string;
  handle: string;
  url: string;
  supported: boolean;
}

/** Identyfikator odkryty z adnotacją (analiza może ją przenieść do teczki). */
export interface AnnotatedIdentifier extends Identifier {
  note?: string;
  declaredAccount?: { host: string; handle: string };
}

/** Czy narzędzie nie pobiera kont z tego hosta (deklaracja na stronie wystarcza). */
export function isDeclaredOnlyHost(host: string): boolean {
  const entry = HOST_INDEX.get(host.toLowerCase().replace(/^www\./, ''));
  return entry !== undefined && !entry.supported;
}

/**
 * Konto w serwisie profilowym wskazane adresem; `null`, gdy adres nie wygląda na profil (udostępnianie,
 * wpis, wyszukiwanie, strona tej samej witryny). Profil Fediwersum (`https://instancja/@nick`) — obsługiwany.
 */
export function declaredAccountOf(href: string, pageHost?: string): DeclaredAccount | null {
  const url = parseHttpUrl(href);
  if (!url) return null;
  const host = serviceOf(url);
  if (pageHost && host === pageHost) return null;
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || NOT_PROFILE_PATH.test(path)) return null;
  const entry = HOST_INDEX.get(host);
  if (!entry) {
    const fedi = /^\/(@[A-Za-z0-9_]+)$/.exec(path);
    return fedi ? { host, handle: fedi[1]!, url: `https://${url.host}${path}`, supported: true } : null;
  }
  const handle = entry.handle(path, url);
  if (!handle) return null;
  // Konto bez łącznika: adres bez parametrów i kotwicy (np. `?hl=pl`, `utm_*`) — jeden identyfikator na konto.
  return { host, handle, url: entry.supported ? url.toString() : `https://${host}${path}`, supported: entry.supported };
}

/** Identyfikator `profile_url` dla odnośnika; konto w serwisie bez łącznika dostaje adnotację. */
function profileIdentifier(href: string, pageHost: string, requireCatalog: boolean): AnnotatedIdentifier | null {
  const account = declaredAccountOf(href, pageHost);
  if (account && !account.supported) {
    return { type: 'profile_url', value: account.url, note: DECLARED_ONLY_NOTE, declaredAccount: { host: account.host, handle: account.handle } };
  }
  if (requireCatalog && !account) return null;
  const url = parseHttpUrl(href);
  if (!url || serviceOf(url) === pageHost) return null;
  return profileUrlIdentifier(href);
}

const unique = (values: (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];

const normalizePhone = (value: string): string => value.replace(/[^\d+]/g, '');

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---------- E-maile zapisane w postaci zaciemnionej ----------

const AT = String.raw`\s*[\[\(\{<]\s*(?:at|małpa|malpa|@)\s*[\]\)\}>]\s*`;
const DOT = String.raw`(?:\s*[\[\(\{<]\s*(?:dot|kropka|\.)\s*[\]\)\}>]\s*|\.)`;
const OBFUSCATED = new RegExp(String.raw`([A-Za-z0-9][A-Za-z0-9._%+-]*)${AT}([A-Za-z0-9-]+(?:${DOT}[A-Za-z0-9-]+)*${DOT}[A-Za-z]{2,})(?![A-Za-z0-9])`, 'giu');
const DOT_FORM = new RegExp(DOT, 'giu');

/**
 * E-maile zapisane z zaciemnieniem: „imie [at] domena [dot] pl”, „imie (małpa) domena (kropka) pl”.
 * Zachowawczo: „at” i „dot” muszą być w nawiasach — samo „imie at domena dot pl” nie jest odczytywane.
 */
export function findObfuscatedEmails(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(OBFUSCATED)) {
    const email = `${match[1]}@${match[2]!.replace(DOT_FORM, '.')}`.toLowerCase();
    if (/^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(email)) found.push(email);
  }
  return [...new Set(found)];
}

// ---------- schema.org (JSON-LD) ----------

export interface JsonLdPerson {
  name?: string;
  emails: string[];
  phones: string[];
  location?: string;
  sameAs: string[];
  image?: string;
  description?: string;
}

function jsonLdBlocks(html: string): unknown[] {
  const parsed: unknown[] = [];
  const blocks = html.match(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const block of blocks) {
    try {
      parsed.push(JSON.parse(block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '')));
    } catch {
      // Uszkodzony blok pomijamy.
    }
  }
  return parsed;
}

/** Pierwsza osoba (schema.org `Person`) opisana na stronie w blokach JSON-LD. */
export function findJsonLdPerson(html: string): JsonLdPerson | null {
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const list = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).map(text).filter((item): item is string => item !== undefined);
  const isPerson = (node: Record<string, unknown>) => list(node['@type']).includes('Person');

  const visit = (node: unknown, depth: number): Record<string, unknown> | null => {
    if (!node || typeof node !== 'object' || depth > 4) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = visit(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    if (isPerson(record)) return record;
    // Osoba bywa zagnieżdżona: w @graph albo jako autor / główny temat strony.
    for (const key of ['@graph', 'mainEntity', 'author', 'about']) {
      const hit = visit(record[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  for (const parsed of jsonLdBlocks(html)) {
    const person = visit(parsed, 0);
    if (!person) continue;
    const address = person.address;
    const location =
      text(address) ??
      (address && typeof address === 'object'
        ? [(address as Record<string, unknown>).addressLocality, (address as Record<string, unknown>).addressRegion, (address as Record<string, unknown>).addressCountry]
            .map(text)
            .filter(Boolean)
            .join(', ') || undefined
        : undefined);
    const image = text(person.image) ?? text((person.image as Record<string, unknown> | undefined)?.url);
    return {
      ...(text(person.name) ? { name: text(person.name)! } : {}),
      emails: list(person.email).map((email) => email.replace(/^mailto:/i, '').toLowerCase()).filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)),
      phones: list(person.telephone),
      ...(location ? { location } : {}),
      sameAs: list(person.sameAs).filter((href) => /^https?:\/\//i.test(href)),
      ...(image && /^https?:\/\//i.test(image) ? { image } : {}),
      ...(text(person.description) ? { description: text(person.description)! } : {}),
    };
  }
  return null;
}

/** Wszystkie adresy `sameAs` z bloków JSON-LD (osoba, organizacja, strona profilu). */
export function findJsonLdSameAs(html: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    for (const value of Array.isArray(record.sameAs) ? record.sameAs : [record.sameAs]) {
      if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) found.push(value.trim());
    }
    for (const [key, value] of Object.entries(record)) if (key !== 'sameAs' && value && typeof value === 'object') visit(value, depth + 1);
  };
  for (const parsed of jsonLdBlocks(html)) visit(parsed, 0);
  return [...new Set(found)];
}

/** Konta wskazane w znacznikach <meta> (Twitter Cards, OpenGraph) i w <link rel="me">. */
export function findMetaProfiles(html: string): string[] {
  const found: string[] = [];
  for (const name of ['twitter:site', 'twitter:creator']) {
    const value = findMeta(html, name)?.trim();
    const handle = value ? /^@?([A-Za-z0-9_]{1,15})$/.exec(value)?.[1] : undefined;
    if (handle) found.push(`https://x.com/${handle}`);
    else if (value && /^https?:\/\//i.test(value)) found.push(value);
  }
  for (const name of ['article:author', 'og:see_also', 'profile:username']) {
    const value = findMeta(html, name)?.trim();
    if (value && /^https?:\/\//i.test(value)) found.push(value);
  }
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["'][^"']*\bme\b[^"']*["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (href) found.push(href.replace(/&amp;/g, '&'));
  }
  return [...new Set(found)];
}

/** Odnośniki <a> z widocznym napisem (do wyboru podstron „o mnie”, „kontakt”…). */
export function findAnchors(html: string): { href: string; text: string }[] {
  const anchors: { href: string; text: string }[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(match[1]!)?.[1];
    if (!href) continue;
    const label = /\b(?:aria-label|title)\s*=\s*["']([^"']+)["']/i.exec(match[1]!)?.[1] ?? '';
    anchors.push({ href: href.replace(/&amp;/g, '&'), text: `${htmlToText(match[2]!)} ${label}`.replace(/\s+/g, ' ').trim() });
  }
  return anchors;
}

/** Słowa w adresie albo napisie odnośnika wskazujące podstronę wartą przeczytania. */
const SUBPAGE_WORDS = /(?:^|[^a-z])(about|about-me|aboutme|o-mnie|omnie|o-nas|onas|kontakt|contact|projekty|projects|portfolio|donate|donations|darowizna|wsparcie|wesprzyj|support|sponsor|sponsors)(?:$|[^a-z])/i;
const FILE_EXTENSION = /\.(?!html?$|php$|aspx?$)[a-z0-9]{2,5}$/i;

/**
 * Podstrony tej samej witryny warte przeczytania (o mnie, kontakt, projekty, portfolio, wsparcie):
 * ten sam host, bez parametrów zapytania, bez plików; najwyżej `limit`, w kolejności na stronie.
 */
export function pickSubpages(html: string, pageUrl: string, limit = MAX_EXTRA_PAGES): string[] {
  const base = new URL(pageUrl);
  const picked: string[] = [];
  for (const anchor of findAnchors(html)) {
    if (picked.length >= limit) break;
    let target: URL;
    try {
      target = new URL(anchor.href, base);
    } catch {
      continue;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') continue;
    if (target.hostname.toLowerCase() !== base.hostname.toLowerCase() || target.port !== base.port) continue;
    if (target.search || FILE_EXTENSION.test(target.pathname)) continue;
    target.hash = '';
    const path = target.pathname.replace(/\/+$/, '') || '/';
    if (path === (base.pathname.replace(/\/+$/, '') || '/') || path.split('/').filter(Boolean).length > 3) continue;
    if (!SUBPAGE_WORDS.test(safeDecode(path).toLowerCase()) && !SUBPAGE_WORDS.test(anchor.text.toLowerCase())) continue;
    const value = target.toString();
    if (!picked.includes(value)) picked.push(value);
  }
  return picked;
}

// ---------- robots.txt ----------

interface RobotsRule {
  allow: boolean;
  pattern: string;
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

/**
 * Czy robots.txt pozwala pobrać ścieżkę. Bierzemy grupę wskazującą nas z nazwy,
 * a gdy jej nie ma — grupę `*`. Wygrywa najdłuższa pasująca reguła; remis rozstrzyga Allow.
 */
export function robotsAllows(robotsTxt: string, path: string): boolean {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      lastWasAgent = false;
      // Puste Disallow oznacza „wszystko wolno".
      if (value) current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const named = groups.filter((group) => group.agents.some((agent) => agent !== '*' && ROBOTS_TOKEN.includes(agent)));
  const chosen = named.length > 0 ? named : groups.filter((group) => group.agents.includes('*'));
  let best: RobotsRule | null = null;
  for (const rule of chosen.flatMap((group) => group.rules)) {
    if (!ruleMatches(rule.pattern, path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

// ---------- Odczyt jednej strony ----------

interface PageReading {
  text: string;
  title: string;
  isHtml: boolean;
  person: JsonLdPerson | null;
  emails: string[];
  phones: string[];
  discovered: Identifier[];
  links: string[];
  declared: DeclaredAccount[];
  author?: string;
  ogTitle?: string;
  description?: string;
  modified?: string;
}

function readPage(page: HttpResult, url: URL, service: string, identifier: Identifier): PageReading | null {
  const isHtml = page.contentType !== 'text/plain';
  const text = (isHtml ? htmlToText(page.text) : page.text).slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) return null;
  const title = (isHtml && findTitle(page.text)) || url.toString();

  const absolutize = (href: string): string | null => {
    try {
      return new URL(href, page.url).toString();
    } catch {
      return null;
    }
  };
  const absolute = (list: string[]) => list.map(absolutize).filter((href): href is string => href !== null);
  const hrefs = isHtml ? findLinks(page.text) : [];
  const person = isHtml ? findJsonLdPerson(page.text) : null;

  // E-maile i telefony: odnośniki mailto:/tel:, dane schema.org, treść strony (także zapis zaciemniony) i „tel. …".
  const textEmails = unique([...findEmails(text), ...findObfuscatedEmails(text)]).filter((email) => !isTechnicalEmail(email)).slice(0, MAX_TEXT_EMAILS);
  const emails = unique([
    ...hrefs.filter((href) => /^mailto:/i.test(href)).map((href) => findEmails(safeDecode(href))[0]),
    ...(person?.emails ?? []),
    ...textEmails,
  ]).filter((email) => !isTechnicalEmail(email));
  const phones = unique([
    ...hrefs.filter((href) => /^tel:/i.test(href)).map((href) => normalizePhone(href.slice(4))),
    ...(person?.phones ?? []).map(normalizePhone),
    ...findPhones(text),
  ]);

  // Inne profile: jawne deklaracje (rel="me", sameAs, <link rel="me">) przyjmujemy z każdego hosta;
  // znaczniki Twitter/OpenGraph i zwykłe odnośniki (także ikony w stopce) — tylko do serwisów profilowych.
  const explicit = isHtml ? absolute([...findRelMeLinks(page.text), ...findJsonLdSameAs(page.text), ...(person?.sameAs ?? [])]) : [];
  const fromMeta = isHtml ? absolute(findMetaProfiles(page.text)) : [];
  const anchors = absolute(hrefs);
  const discovered: Identifier[] = emails.map((value): Identifier => ({ type: 'email', value }));
  for (const href of explicit) {
    const item = profileIdentifier(href, service, false);
    if (item) discovered.push(item);
  }
  for (const href of [...fromMeta, ...anchors]) {
    const item = profileIdentifier(href, service, true);
    if (item) discovered.push(item);
  }
  const found = dedupeIdentifiers(discovered, identifier, [service]).slice(0, MAX_DISCOVERED);
  const declared = found
    .map((item) => (item.type === 'profile_url' ? declaredAccountOf(item.value, service) : null))
    .filter((item): item is DeclaredAccount => item !== null);

  const metaAuthor = (isHtml && findMeta(page.text, 'author')) || undefined;
  const ogTitle = (isHtml && findMeta(page.text, 'og:title')) || undefined;
  const description = (isHtml && (findMeta(page.text, 'description') ?? findMeta(page.text, 'og:description'))) || undefined;
  const modified = isHtml ? (findMeta(page.text, 'article:modified_time') ?? findMeta(page.text, 'article:published_time')) : null;
  const author = person?.name ?? metaAuthor;
  return {
    text,
    title,
    isHtml,
    person,
    emails,
    phones,
    discovered: found,
    links: found.filter((item) => item.type === 'profile_url').map((item) => item.value),
    declared,
    ...(author ? { author } : {}),
    ...(ogTitle ? { ogTitle } : {}),
    ...(description ? { description } : {}),
    ...(modified && !Number.isNaN(Date.parse(modified)) ? { modified: new Date(modified).toISOString() } : {}),
  };
}

export interface WwwConfig {
  /** Dodatkowe hosty obsługiwane przez inne łączniki (np. instancje Fediwersum). */
  skipHosts?: string[];
  /** Najwyżej tyle podstron tej samej witryny (domyślnie 4; 0 wyłącza). */
  extraPages?: number;
}

export function createWwwConnector(http: HttpClient, config: WwwConfig = {}): SourceConnector {
  const skipHosts = new Set([...DEDICATED_HOSTS, ...(config.skipHosts ?? [])]);
  const extraPages = Math.max(0, Math.min(MAX_EXTRA_PAGES, config.extraPages ?? MAX_EXTRA_PAGES));

  return {
    id: ID,
    service: 'www',
    label: LABEL,
    description:
      'Publiczna strona pod podanym adresem http(s): sprawdzenie robots.txt, następnie pobranie strony (tylko text/html i text/plain, ' +
      'do 1 MB, najwyżej 3 przekierowania). Ze strony głównej witryny — także najwyżej 4 podstrony tej samej witryny wskazane odnośnikami ' +
      '„o mnie”, „kontakt”, „projekty”, „portfolio”, „wsparcie” (bez parametrów zapytania, robots.txt sprawdzany dla każdej; każda to osobny dokument). ' +
      'Dane właściciela: <meta name="author">, og:title, opis osoby schema.org (JSON-LD), odnośniki mailto:/tel:, e-maile w treści (także zapis ' +
      '„imie [at] domena [dot] pl”). Inne konta: rel="me", sameAs, znaczniki Twitter/OpenGraph i odnośniki do serwisów profilowych. Konta w serwisach, ' +
      'których narzędzie nie pobiera (LinkedIn, X, Instagram, Facebook, YouTube, TikTok, Discord…), są tylko deklaracją strony — nigdy nie są pobierane. ' +
      'Adresy prywatne i lokalne są odrzucane; serwisy z własnym łącznikiem są pomijane. Najwyżej 6 żądań na identyfikator.',
    accepts: ['profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const url = parseHttpUrl(identifier.value);
      if (!url) return [];
      const service = serviceOf(url);
      if (skipHosts.has(service) || skipHosts.has(url.hostname.toLowerCase())) return [];
      if (isDeclaredOnlyHost(service)) {
        context.log(`${LABEL}: ${service} — serwis ${DECLARED_ONLY_NOTE}; strony nie pobrano.`);
        return [];
      }
      url.hash = '';
      const session = http.session(context, { label: LABEL, limit: 2 + extraPages });

      const robots = await session.get(`${url.origin}/robots.txt`, {
        publicOnly: true,
        quietMissing: true,
        maxBytes: 200_000,
      });
      // Odpowiedź HTML pod /robots.txt to strona błędu, nie reguły.
      const rules = robots && robots.contentType !== 'text/html' ? robots.text : null;
      if (rules !== null && !robotsAllows(rules, `${url.pathname}${url.search}`)) {
        context.log(`${LABEL}: ${service} — robots.txt nie pozwala na pobranie ${url.pathname}; pominięto.`);
        return [];
      }
      if (!robots && (session.refused || session.lastStatus === 0 || session.lastStatus >= 500)) {
        // Odmowa, błąd serwera lub brak połączenia: nie wiemy, czy wolno — nie pobieramy.
        return [];
      }

      const fetchPage = (target: string) =>
        session.get(target, {
          publicOnly: true,
          allowedContentTypes: CONTENT_TYPES,
          headers: { Accept: 'text/html, text/plain;q=0.9' },
        });
      const page = await fetchPage(url.toString());
      if (!page) return [];
      const home = readPage(page, url, service, identifier);
      if (!home) {
        context.log(`${LABEL}: ${url} — strona bez treści tekstowej (prawdopodobnie wymaga JavaScriptu).`);
        return [];
      }

      // Strona nie ma „konta"; właścicielem jest osoba z danych strony, a bez nich — host.
      const owner = home.author ?? service;
      const fetchedAt = new Date().toISOString();
      const documentOf = (reading: PageReading, pageUrl: string, displayName: string | undefined): SourceDocument => {
        const person = reading.person;
        const profile: ProfileAttributes = {
          ...(displayName ? { displayName } : {}),
          ...(reading.emails.length > 0 ? { emails: reading.emails } : {}),
          ...(reading.phones.length > 0 ? { phones: reading.phones } : {}),
          urls: [pageUrl, ...reading.links],
          ...(person?.location ? { location: person.location } : {}),
          ...(person?.image ? { avatarUrl: person.image } : {}),
          ...((person?.description ?? reading.description) ? { bio: person?.description ?? reading.description } : {}),
        };
        return {
          connectorId: ID,
          service,
          url: pageUrl,
          title: `${reading.title} (${service})`,
          text: reading.text,
          fetchedAt,
          author: owner,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile,
          ...discoveredField(reading.discovered),
          ...(reading.modified ? { publishedAt: reading.modified } : {}),
        };
      };

      const documents: SourceDocument[] = [documentOf(home, url.toString(), home.author ?? home.ogTitle)];
      const declared = [...home.declared];

      // Podstrony tylko ze strony głównej witryny: „o mnie”, kontakt, projekty, portfolio, wsparcie.
      const isHome = (url.pathname === '/' || url.pathname === '') && !url.search;
      const subpages = isHome && home.isHtml && extraPages > 0 ? pickSubpages(page.text, page.url, extraPages) : [];
      for (const target of subpages) {
        const targetUrl = new URL(target);
        if (rules !== null && !robotsAllows(rules, targetUrl.pathname)) {
          context.log(`${LABEL}: ${service} — robots.txt nie pozwala na pobranie ${targetUrl.pathname}; podstronę pominięto.`);
          continue;
        }
        const subpage = await fetchPage(target);
        if (!subpage) continue;
        const reading = readPage(subpage, targetUrl, service, identifier);
        if (!reading) continue;
        // Podstrona tej samej witryny należy do tego samego właściciela — ta sama karta profilu.
        documents.push(documentOf(reading, targetUrl.toString(), home.author ?? home.ogTitle));
        for (const item of reading.declared) if (!declared.some((known) => known.url === item.url)) declared.push(item);
      }

      const unsupported = declared.filter((item) => !item.supported);
      if (unsupported.length > 0) {
        context.log(`${LABEL}: ${service} — strona deklaruje konta: ${unsupported.map((item) => `${item.host}/${item.handle}`).join(', ')} (${DECLARED_ONLY_NOTE}).`);
      }
      const discoveredCount = new Set(documents.flatMap((doc) => (doc.discoveredIdentifiers ?? []).map((item) => `${item.type}:${item.value}`))).size;
      context.log(
        `${LABEL}: ${url} — pobrano (${home.text.length} znaków${documents.length > 1 ? `, podstron: ${documents.length - 1}` : ''}, odkrytych identyfikatorów: ${discoveredCount}).`,
      );
      return documents;
    },
  };
}
