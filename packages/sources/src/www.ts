// Łącznik ogólny WWW: pobiera jedną publiczną stronę wskazaną adresem
// (identyfikator `profile_url`) — stronę osobistą albo profil w serwisie bez
// własnego łącznika. Szanuje robots.txt, nie podąża za odnośnikami i nie
// zagląda pod adresy prywatne.

import type { Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, findMeta, findPhones, findRelMeLinks, findTitle, htmlToText } from './html.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-www';
const LABEL = 'Strona WWW';
const MAX_TEXT_CHARS = 200_000;
const MAX_DISCOVERED = 10;
const CONTENT_TYPES = ['text/html', 'text/plain', 'application/xhtml+xml'];
/** Człon nazwy z nagłówka User-Agent, po którym robots.txt może nas wskazać. */
const ROBOTS_TOKEN = 'olcys-research';

/** Serwisy z własnym łącznikiem — tu pomijane, żeby jedna strona nie dawała dwóch dokumentów. */
const DEDICATED_HOSTS = ['github.com', 'gist.github.com', 'keybase.io', 't.me', 'telegram.me', 'gravatar.com', 'bitcointalk.org', 'web.archive.org'];

/** Serwisy profilowe: odnośnik do nich ze strony podmiotu to prawdopodobnie jego inny profil. */
const PROFILE_HOSTS = [
  'github.com',
  'gitlab.com',
  'twitter.com',
  'x.com',
  'keybase.io',
  't.me',
  'gravatar.com',
  'bitcointalk.org',
  'reddit.com',
  'linkedin.com',
  'facebook.com',
  'instagram.com',
  'youtube.com',
  'medium.com',
  'mastodon.social',
];
const NOT_PROFILE_PATH = /^\/(?:share|sharer|intent|login|signup|search|hashtag|explore|about|privacy|terms|home|watch|sponsors)\b/i;

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

function looksLikeProfile(href: string, pageHost: string): boolean {
  const url = parseHttpUrl(href);
  if (!url) return false;
  const host = serviceOf(url);
  if (host === pageHost) return false;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0 || NOT_PROFILE_PATH.test(url.pathname)) return false;
  // Profile Fediwersum mają postać https://instancja/@nick.
  if (parts.length === 1 && /^@[A-Za-z0-9_]+$/.test(parts[0]!)) return true;
  if (!PROFILE_HOSTS.includes(host)) return false;
  if (host === 'bitcointalk.org') return /action=profile/.test(url.search);
  return parts.length <= 2;
}

export interface WwwConfig {
  /** Dodatkowe hosty obsługiwane przez inne łączniki (np. instancje Fediwersum). */
  skipHosts?: string[];
}

export function createWwwConnector(http: HttpClient, config: WwwConfig = {}): SourceConnector {
  const skipHosts = new Set([...DEDICATED_HOSTS, ...(config.skipHosts ?? [])]);

  return {
    id: ID,
    service: 'www',
    label: LABEL,
    description:
      'Jedna publiczna strona pod podanym adresem http(s): sprawdzenie robots.txt (reguły Disallow dla „*"), następnie pobranie strony ' +
      '(tylko text/html i text/plain, do 1 MB, najwyżej 3 przekierowania). Z treści powstaje tekst, a odnośniki rel="me" i odnośniki ' +
      'do znanych serwisów profilowych wskazują inne profile. Adresy prywatne i lokalne są odrzucane; serwisy z własnym łącznikiem są pomijane. ' +
      'Najwyżej 2 żądania na identyfikator.',
    accepts: ['profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const url = parseHttpUrl(identifier.value);
      if (!url) return [];
      const service = serviceOf(url);
      if (skipHosts.has(service) || skipHosts.has(url.hostname.toLowerCase())) return [];
      url.hash = '';
      const session = http.session(context, { label: LABEL });

      const robots = await session.get(`${url.origin}/robots.txt`, {
        publicOnly: true,
        quietMissing: true,
        maxBytes: 200_000,
      });
      if (robots) {
        // Odpowiedź HTML pod /robots.txt to strona błędu, nie reguły.
        if (robots.contentType !== 'text/html' && !robotsAllows(robots.text, `${url.pathname}${url.search}`)) {
          context.log(`${LABEL}: ${service} — robots.txt nie pozwala na pobranie ${url.pathname}; pominięto.`);
          return [];
        }
      } else if (session.refused || session.lastStatus === 0 || session.lastStatus >= 500) {
        // Odmowa, błąd serwera lub brak połączenia: nie wiemy, czy wolno — nie pobieramy.
        return [];
      }

      const page = await session.get(url.toString(), {
        publicOnly: true,
        allowedContentTypes: CONTENT_TYPES,
        headers: { Accept: 'text/html, text/plain;q=0.9' },
      });
      if (!page) return [];

      const isHtml = page.contentType !== 'text/plain';
      const text = (isHtml ? htmlToText(page.text) : page.text).slice(0, MAX_TEXT_CHARS);
      if (!text.trim()) {
        context.log(`${LABEL}: ${url} — strona bez treści tekstowej (prawdopodobnie wymaga JavaScriptu).`);
        return [];
      }
      const title = (isHtml && findTitle(page.text)) || url.toString();

      const discovered: Identifier[] = [];
      if (isHtml) {
        const absolutize = (href: string): string | null => {
          try {
            return new URL(href, page.url).toString();
          } catch {
            return null;
          }
        };
        const all = (hrefs: string[]) => hrefs.map(absolutize).filter((href): href is string => href !== null);
        const relMe = all(findRelMeLinks(page.text));
        const others = all(findLinks(page.text)).filter((href) => looksLikeProfile(href, service));
        for (const absolute of [...relMe, ...others]) {
          if (/^mailto:/i.test(absolute)) {
            const email = findEmails(decodeURIComponent(absolute))[0];
            if (email) discovered.push({ type: 'email', value: email });
            continue;
          }
          const found = profileUrlIdentifier(absolute);
          if (found) discovered.push(found);
        }
      }

      const found = dedupeIdentifiers(discovered, identifier).slice(0, MAX_DISCOVERED);
      const author = (isHtml && findMeta(page.text, 'author')) || undefined;
      const description = (isHtml && findMeta(page.text, 'description')) || undefined;
      const emails = found.filter((item) => item.type === 'email').map((item) => item.value);
      const phones = findPhones(text);
      const links = found.filter((item) => item.type === 'profile_url').map((item) => item.value);
      // Strona nie ma „konta"; profil opisuje jej właściciela tym, co sam na niej podał.
      const profile: ProfileAttributes = {
        ...(author ? { displayName: author } : {}),
        ...(emails.length > 0 ? { emails } : {}),
        ...(phones.length > 0 ? { phones } : {}),
        urls: [url.toString(), ...links],
        ...(description ? { bio: description } : {}),
      };

      const document: SourceDocument = {
        connectorId: ID,
        service,
        url: url.toString(),
        title: `${title} (${service})`,
        text,
        fetchedAt: new Date().toISOString(),
        // Strona nie podaje autora w ustandaryzowany sposób; gdy brak znacznika, właścicielem jest host.
        author: author ?? service,
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile,
        ...discoveredField(found),
      };
      const modified = isHtml ? findMeta(page.text, 'article:modified_time') ?? findMeta(page.text, 'article:published_time') : null;
      if (modified && !Number.isNaN(Date.parse(modified))) document.publishedAt = new Date(modified).toISOString();

      context.log(`${LABEL}: ${url} — pobrano (${text.length} znaków, odkrytych identyfikatorów: ${document.discoveredIdentifiers?.length ?? 0}).`);
      return [document];
    },
  };
}
