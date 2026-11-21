// Silnik `rss`: dowolny kanał RSS 2.0 / Atom — fora phpBB, SMF, vBulletin, XenForo,
// blogi, subreddity (`.rss`). Dla forów SMF (np. Bitcointalk) wystarczy podać `board`.

import { htmlToText } from '../html.ts';
import { baseUrl, boardKey, hostOf, normalizedUrl, postText, toIso } from './common.ts';
import type { EngineAdapter, MonitorPost, MonitorSourceConfig } from './common.ts';

/** Zawartość pierwszego elementu o podanej nazwie; rozwija CDATA i jednokrotnie dekoduje encje XML. */
function element(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(xml);
  if (!match) return undefined;
  const raw = match[1]!.trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(raw);
  if (cdata) return cdata[1]!;
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&');
}

const plain = (value: string | undefined): string => htmlToText(value ?? '').replace(/\n/g, ' ').trim();

/** Adres wpisu Atom: odnośnik `rel="alternate"` albo pierwszy z atrybutem `href`. */
function atomLink(entry: string): string | undefined {
  const links = entry.match(/<link\b[^>]*>/gi) ?? [];
  const href = (tag: string) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.replace(/&amp;/g, '&');
  const alternate = links.find((tag) => /\brel\s*=\s*["']alternate["']/i.test(tag)) ?? links.find((tag) => !/\brel\s*=/i.test(tag)) ?? links[0];
  return alternate ? href(alternate) : undefined;
}

/** Autor z RSS: `dc:creator`, a w polu `author` także zapis „adres@poczty (Nazwa)". */
function rssAuthor(item: string): string | undefined {
  const creator = plain(element(item, 'dc:creator'));
  if (creator) return creator;
  const author = plain(element(item, 'author'));
  if (!author) return undefined;
  const named = /\(([^)]+)\)\s*$/.exec(author);
  return named ? named[1]!.trim() : author.includes('@') ? undefined : author;
}

/** Rozbiera kanał RSS 2.0 albo Atom na posty. */
export function parseFeed(xml: string, fallbackService: string): MonitorPost[] {
  const posts: MonitorPost[] = [];
  const serviceOf = (url: string) => hostOf(url) || fallbackService;

  for (const item of xml.match(/<item\b[\s\S]*?<\/item\s*>/gi) ?? []) {
    const link = plain(element(item, 'link')) || plain(element(item, 'guid'));
    if (!/^https?:\/\//i.test(link)) continue;
    const rawAuthor = rssAuthor(item);
    // Kanały Discourse podpisują wpis jako „@nick Imię Nazwisko".
    const handleAndName = /^@(\S+)\s+(.+)$/.exec(rawAuthor ?? '');
    const author = handleAndName ? handleAndName[1]! : rawAuthor;
    posts.push({
      url: link,
      title: plain(element(item, 'title')),
      text: postText(element(item, 'content:encoded') ?? element(item, 'description') ?? ''),
      service: serviceOf(link),
      ...(author ? { author } : {}),
      ...(handleAndName ? { profile: { displayName: handleAndName[2]!.trim() } } : {}),
      ...(toIso(element(item, 'pubDate') ?? element(item, 'dc:date')) ? { publishedAt: toIso(element(item, 'pubDate') ?? element(item, 'dc:date'))! } : {}),
    });
  }

  for (const entry of xml.match(/<entry\b[\s\S]*?<\/entry\s*>/gi) ?? []) {
    const link = atomLink(entry);
    if (!link || !/^https?:\/\//i.test(link)) continue;
    const authorBlock = /<author\b[^>]*>([\s\S]*?)<\/author\s*>/i.exec(entry)?.[1] ?? '';
    // Reddit zapisuje autora jako „/u/nick".
    const author = plain(element(authorBlock, 'name')).replace(/^\/?u\//, '') || undefined;
    const profileUrl = plain(element(authorBlock, 'uri'));
    const published = toIso(element(entry, 'published') ?? element(entry, 'updated'));
    posts.push({
      url: link,
      title: plain(element(entry, 'title')),
      text: postText(element(entry, 'content') ?? element(entry, 'summary') ?? ''),
      service: serviceOf(link),
      ...(author ? { author } : {}),
      ...(published ? { publishedAt: published } : {}),
      ...(author && /^https?:\/\//i.test(profileUrl) ? { profile: { urls: [profileUrl] } } : {}),
    });
  }
  return posts;
}

/** Adres kanału: podany wprost albo kanał działu forum SMF (`board`). */
export function feedUrl(source: MonitorSourceConfig): string | null {
  if (!source.url) return null;
  if (source.board === undefined || source.board === '') return source.url;
  return `${baseUrl(source.url)}/index.php?type=rss;action=.xml;board=${encodeURIComponent(String(source.board))};limit=50`;
}

export const rssEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Kanał RSS/Atom ${feedUrl(source) ?? '(brak adresu)'} — najnowsze wpisy z tytułem, treścią, autorem i datą. Jedno żądanie na przebieg; bez wyszukiwania.`,
  service: (source) => hostOf(source.url),
  problem: (source) => (source.url && hostOf(source.url) ? null : 'brak pola „url"'),
  requestHost: (source) => hostOf(feedUrl(source) ?? ''),
  addressKey: (source) => boardKey(feedUrl(source) ?? '') ?? `rss|${normalizedUrl(feedUrl(source) ?? '')}`,

  async discover(run) {
    const url = feedUrl(run.source)!;
    const response = await run.session.get(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8' },
      minIntervalMs: run.intervalMs,
    });
    return response ? parseFeed(response.text, hostOf(url)) : [];
  },
};
