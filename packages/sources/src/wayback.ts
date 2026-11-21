// Łącznik Wayback Machine: archiwalne wersje publicznej strony — profilu GitHub
// o podanym loginie albo dowolnego publicznego adresu. Pozwala zobaczyć adresy,
// które były na stronie wcześniej (podmiana lub usunięcie adresu).

import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { htmlToText } from './html.ts';
import { parseJson, staticHostProblem } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, parseHttpUrl, serviceOf } from './identity.ts';

const ID = 'live-wayback';
const LABEL = 'Wayback Machine';
const CDX = 'https://web.archive.org/cdx/search/cdx';

/** Zapytanie CDX i trzy kopie (najstarsza, środkowa, najnowsza) mieszczą się w limicie 4 żądań. */
const MAX_REQUESTS = 4;
const MAX_SNAPSHOTS = MAX_REQUESTS - 1;
const MAX_TEXT_CHARS = 200_000;
/** Serwisy, w których pierwszy człon ścieżki to nazwa konta. */
const ACCOUNT_HOSTS = ['github.com', 'gitlab.com', 'twitter.com', 'x.com', 'keybase.io', 't.me', 'gravatar.com'];
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `20240512031400` → `2024-05-12T03:14:00Z`. */
function timestampToIso(timestamp: string): string {
  const t = timestamp.padEnd(14, '0');
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:${t.slice(12, 14)}Z`;
}

/** Równomiernie rozłożony wybór: zawsze pierwszy i ostatni element. */
export function pickSpread<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const picked = new Set<T>();
  for (let i = 0; i < count; i++) picked.add(items[Math.round((i * (items.length - 1)) / (count - 1))]!);
  return [...picked];
}

interface Target {
  /** Adres bez schematu — w takiej postaci przyjmuje go CDX. */
  query: string;
  service: string;
  author: string;
  /** Nazwa konta, jeśli adres wskazuje profil w znanym serwisie. */
  handle?: string;
  /** Adres oryginału — strona wskazana jako należąca do podmiotu. */
  original: string;
  what: string;
}

function targetFor(identifier: Identifier): Target | null {
  if (identifier.type !== 'profile_url') {
    const login = cleanHandle(identifier.value);
    if (!GITHUB_LOGIN.test(login)) return null;
    return {
      query: `github.com/${login}`,
      service: 'github.com',
      author: login,
      handle: login,
      original: `https://github.com/${login}`,
      what: `Profil GitHub ${login}`,
    };
  }
  const url = parseHttpUrl(identifier.value);
  // Archiwum ma kopie tylko publicznych stron — adresów lokalnych nawet nie wysyłamy.
  if (!url || staticHostProblem(url.hostname)) return null;
  const service = serviceOf(url);
  if (service === 'web.archive.org') return null;
  const path = `${url.pathname}${url.search}`.replace(/\/$/, '');
  const segments = url.pathname.split('/').filter(Boolean);
  const firstSegment = segments[0] ?? '';
  // Nazwa konta ze ścieżki tylko tam, gdzie pierwszy człon ścieżki na pewno jest kontem.
  const handle = ACCOUNT_HOSTS.includes(service) || (segments.length === 1 && firstSegment.startsWith('@')) ? cleanHandle(firstSegment) : '';
  return {
    query: `${url.host}${path}`,
    service,
    // Dla adresu profilu autorem jest nazwa konta ze ścieżki; dla strony — jej host.
    author: handle || service,
    ...(handle ? { handle } : {}),
    original: url.toString(),
    what: `${url.host}${path}`,
  };
}

export function createWaybackConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    // Kopia archiwalna nie jest niezależnym źródłem — dokumenty dostają `service` oryginału.
    service: 'web.archive.org',
    label: LABEL,
    description:
      'Archiwalne kopie strony z Wayback Machine (CDX API web.archive.org/cdx/search/cdx): dla loginu — profil github.com/<login>, ' +
      'dla adresu profilu — dokładnie ta strona. Tylko kopie z kodem 200 o różnej treści; pobierane najwyżej ' +
      `${MAX_SNAPSHOTS} kopie rozłożone w czasie (najstarsza, środkowa, najnowsza), z datami zapisu. Najwyżej ${MAX_REQUESTS} żądania na identyfikator.`,
    accepts: ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const target = targetFor(identifier);
      if (!target) return [];
      const session = http.session(context, { label: LABEL, limit: MAX_REQUESTS });

      const cdxUrl =
        `${CDX}?output=json&fl=timestamp,original&filter=statuscode:200&collapse=digest&limit=200` +
        `&url=${encodeURIComponent(target.query)}`;
      const cdx = await session.get(cdxUrl);
      if (!cdx) return [];
      // Pierwszy wiersz odpowiedzi CDX to nagłówek kolumn.
      const rows = (parseJson<string[][]>(cdx.text) ?? []).slice(1).filter((row) => /^\d{4,14}$/.test(row?.[0] ?? '') && row[1]);

      const documents: SourceDocument[] = [];
      for (const [timestamp, original] of pickSpread(rows, MAX_SNAPSHOTS)) {
        // Sufiks `id_` zwraca stronę w oryginalnej postaci, bez paska narzędzi archiwum.
        const page = await session.get(`https://web.archive.org/web/${timestamp}id_/${original}`, {
          allowedContentTypes: ['text/html', 'text/plain', 'application/xhtml+xml'],
        });
        if (!page) {
          if (session.refused) break;
          continue;
        }
        const archivedAt = timestampToIso(timestamp!);
        const text = (page.contentType === 'text/plain' ? page.text : htmlToText(page.text)).slice(0, MAX_TEXT_CHARS);
        if (!text.trim()) continue;
        documents.push({
          connectorId: ID,
          service: target.service,
          url: `https://web.archive.org/web/${timestamp}/${original}`,
          title: `${target.what} — kopia z ${archivedAt.slice(0, 10)}`,
          text,
          fetchedAt: new Date().toISOString(),
          author: target.author,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { ...(target.handle ? { handle: target.handle } : {}), urls: [target.original] },
          archivedAt,
        });
      }
      context.log(`${LABEL}: „${target.what}" — kopii w indeksie: ${rows.length}, pobranych: ${documents.length}.`);
      return documents;
    },
  };
}
