// Silnik `smf-board`: publiczna lista wątków działu forum SMF (Bitcointalk) czytana z HTML
// — forum wyłączyło kanały RSS. Jeden dział to: strona listy wątków oraz pierwsze strony
// najwyżej 5 najnowszych wątków (posty z autorem, datą i treścią bez cytatów).
// Tempo: co najmniej 2 s między żądaniami, najwyżej 6 żądań na dział i około 40 na host na przebieg.

import type { ProfileAttributes } from '@olcys/core';
import { htmlToText } from '../html.ts';
import { SLOW_INTERVAL_MS, baseUrl, hostOf, postText, toIso } from './common.ts';
import type { EngineAdapter, MonitorPost, MonitorSourceConfig } from './common.ts';
import { attributeOf, looseDate, robotsPermit, selectAll } from './html-list.ts';

/** Najwyżej tyle wątków działu jest otwieranych w jednym przebiegu. */
const MAX_TOPICS = 5;
/** Łączny limit żądań do jednego hosta w przebiegu (lista działu + wątki, wszystkie działy razem). */
export const SMF_HOST_REQUEST_CAP = 40;
/** Najwyżej tyle żądań na dział w przebiegu (lista + wątki; pobranie robots.txt też się liczy). */
const MAX_REQUESTS = 6;
const ENCODING = 'iso-8859-1';

/** Numer działu: z pola `board` albo z adresu (`…board=142.0`). */
export function smfBoardId(source: MonitorSourceConfig): string | null {
  const fromField = source.board !== undefined ? String(source.board).trim() : '';
  const id = fromField || /[?;&]board=(\d+)/.exec(source.url ?? '')?.[1] || '';
  return /^\d{1,6}$/.test(id) ? id : null;
}

/** Adres bazowy forum (bez `index.php…`). */
function forumBase(source: MonitorSourceConfig): string {
  const url = new URL(baseUrl(source.url!));
  return `${url.origin}${url.pathname.replace(/\/index\.php$/i, '').replace(/\/+$/, '')}`;
}

export interface SmfTopic {
  id: string;
  title: string;
  url: string;
  sticky: boolean;
  author?: string;
  authorUrl?: string;
  /** Data ostatniego posta w wątku — tak podaje lista działu. */
  lastPostAt?: string;
}

/** Data w zapisie forum, także „Today at 07:18:30 AM" (czas forum przyjmujemy jako UTC). */
export function smfDate(text: string | undefined, now: Date = new Date()): string | undefined {
  if (!text) return undefined;
  const today = /\bToday\b[^0-9]*(\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?)/i.exec(text);
  if (today) return toIso(`${now.toISOString().slice(0, 10)} ${today[1]} UTC`);
  return looseDate(text);
}

/** Wątki z listy działu, w kolejności strony (od ostatnio aktywnych; przypięte na początku). */
export function parseSmfBoard(html: string, pageUrl: string, now: Date = new Date()): SmfTopic[] {
  const topics: SmfTopic[] = [];
  const seen = new Set<string>();
  for (const row of selectAll(html, 'tr')) {
    // Wiersz listy ma dokładnie jeden tytuł; wiersze zewnętrznych tabel układu zawierają wiele wątków naraz.
    const links = selectAll(row.inner, 'span[id^=msg_] a[href*=topic=]');
    if (links.length !== 1) continue;
    const href = attributeOf(links[0]!.open, 'href');
    const id = /topic=(\d+)/.exec(href ?? '')?.[1];
    const title = htmlToText(links[0]!.inner).replace(/\n/g, ' ').trim();
    if (!href || !id || !title || seen.has(id)) continue;
    seen.add(id);
    const starter = selectAll(row.inner, 'td a[href*=action=profile][title]')[0];
    const starterHref = starter ? attributeOf(starter.open, 'href') : undefined;
    const lastPost = selectAll(row.inner, 'td.lastpostcol')[0];
    const lastPostAt = smfDate(htmlToText(lastPost?.inner ?? ''), now);
    const author = starter ? htmlToText(starter.inner).trim() : '';
    topics.push({
      id,
      title,
      url: new URL(href, pageUrl).toString(),
      sticky: /show_sticky|stickyicon/i.test(row.inner),
      ...(author ? { author } : {}),
      ...(starterHref ? { authorUrl: new URL(starterHref, pageUrl).toString() } : {}),
      ...(lastPostAt ? { lastPostAt } : {}),
    });
  }
  return topics;
}

/** Posty z pierwszej strony wątku: autor, data, treść bez cytatów, bezpośredni adres posta. */
export function parseSmfTopic(html: string, pageUrl: string, fallbackTitle: string, now: Date = new Date()): MonitorPost[] {
  const posts: MonitorPost[] = [];
  const service = hostOf(pageUrl);
  // Każdy post zaczyna się komórką z danymi autora; treść jest w najbliższym <div class="post">.
  const starts = [...html.matchAll(/<td\b[^>]*\bclass\s*=\s*["'][^"']*\bposter_info\b[^"']*["'][^>]*>/gi)].map((match) => match.index!);
  starts.forEach((start, index) => {
    const chunk = html.slice(start, starts[index + 1] ?? html.length);
    const poster = selectAll(chunk, 'a[href*=action=profile]')[0];
    const author = poster ? htmlToText(poster.inner).trim() : '';
    const body = selectAll(chunk, 'div.post')[0];
    if (!author || !body) return;
    const subject = selectAll(chunk, 'div.subject a')[0] ?? selectAll(chunk, 'a[href*=#msg]')[0];
    const subjectHref = subject ? attributeOf(subject.open, 'href') : undefined;
    const messageId = /#msg(\d+)/.exec(subjectHref ?? '')?.[1] ?? /\bid\s*=\s*["']?(?:subject_|msg_?)(\d+)/i.exec(chunk)?.[1];
    if (!messageId) return;
    const topicId = /topic=(\d+)/.exec(subjectHref ?? pageUrl)?.[1];
    const header = selectAll(chunk, 'td.td_headerandpost')[0]?.inner ?? chunk;
    // Data stoi w nagłówku posta, przed treścią; bierzemy pierwszy blok „smalltext" z czytelną datą.
    const beforeBody = header.slice(0, Math.max(0, header.search(/<div\b[^>]*\bclass\s*=\s*["']post["']/i)));
    const published = selectAll(beforeBody || header, 'div.smalltext')
      .map((element) => smfDate(htmlToText(element.inner), now))
      .find(Boolean);
    const posterHref = attributeOf(poster!.open, 'href');
    // Pod danymi autora forum pokazuje ikonę „WWW" z adresem strony podanym w profilu.
    const info = selectAll(chunk, 'td.poster_info')[0]?.inner ?? '';
    const website = selectAll(info, 'a[href]').find((link) => /www_sm\.gif/i.test(link.inner));
    const websiteUrl = website ? attributeOf(website.open, 'href') : undefined;
    const urls = [posterHref ? new URL(posterHref, pageUrl).toString() : undefined, websiteUrl && /^https?:\/\//i.test(websiteUrl) ? websiteUrl : undefined].filter(
      (value): value is string => Boolean(value),
    );
    const profile: ProfileAttributes = urls.length > 0 ? { urls } : {};
    const text = postText(body.inner);
    if (!text) return;
    posts.push({
      url: `${new URL(pageUrl).origin}${new URL(pageUrl).pathname}?topic=${topicId ?? ''}.msg${messageId}#msg${messageId}`,
      title: (subject ? htmlToText(subject.inner).replace(/\n/g, ' ').trim() : '') || fallbackTitle,
      text,
      service,
      author,
      profile,
      ...(urls[1] ? { discovered: [{ type: 'profile_url' as const, value: urls[1] }] } : {}),
      ...(published ? { publishedAt: published } : {}),
    });
  });
  return posts;
}

export const smfBoardEngine: EngineAdapter = {
  accepts: [],
  intervalMs: SLOW_INTERVAL_MS,
  maxRequests: MAX_REQUESTS,
  describe: (source) =>
    `Dział forum SMF ${hostOf(source.url)} (board=${smfBoardId(source) ?? '?'}): po sprawdzeniu robots.txt publiczna lista wątków (index.php?board=<id>.0 — tytuły, autorzy, odnośniki) ` +
    `oraz pierwsze strony najwyżej ${MAX_TOPICS} ostatnio aktywnych, nieprzypiętych wątków (posty: autor, data, treść bez cytatów). ` +
    `Co najmniej 2 s między żądaniami, najwyżej 6 żądań na dział i około ${SMF_HOST_REQUEST_CAP} na host w jednym przebiegu.`,
  service: (source) => hostOf(source.url),
  problem: (source) => (!source.url || !hostOf(source.url) ? 'brak pola „url"' : smfBoardId(source) ? null : 'brak numeru działu („board" albo „board=<id>" w adresie)'),
  requestHost: (source) => hostOf(source.url),
  addressKey: (source) => `board:${hostOf(source.url)}:${smfBoardId(source)}`,

  async discover(run) {
    const board = smfBoardId(run.source)!;
    const boardUrl = `${forumBase(run.source)}/index.php?board=${board}.0`;
    const options = { minIntervalMs: run.intervalMs, encoding: ENCODING, allowedContentTypes: ['text/html'] };
    if (!(await robotsPermit(run, boardUrl))) return [];
    const page = await run.session.get(boardUrl, options);
    if (!page) return [];
    const topics = parseSmfBoard(page.text, page.url);

    // Budżet hosta dzielony po równo między działy tego forum w przebiegu: każdy dostaje listę, reszta idzie na wątki.
    const boards = Math.max(1, run.hostQueueSize ?? 1);
    const perBoard = Math.max(0, Math.min(MAX_TOPICS, Math.floor((SMF_HOST_REQUEST_CAP - boards) / boards)));
    const fresh = topics.filter((topic) => !topic.sticky).slice(0, Math.min(perBoard, MAX_REQUESTS - run.session.used));
    const opened = new Set<string>();
    const posts: MonitorPost[] = [];
    for (const topic of fresh) {
      const topicUrl = `${forumBase(run.source)}/index.php?topic=${topic.id}.0`;
      if (!(await robotsPermit(run, topicUrl))) break;
      const thread = await run.session.get(topicUrl, options);
      if (!thread) {
        if (run.session.refused) break;
        continue;
      }
      opened.add(topic.id);
      posts.push(...parseSmfTopic(thread.text, thread.url, topic.title));
    }
    // Wątki, których nie otwarto, zostają jako pozycje listy: tytuł przypisany autorowi wątku.
    for (const topic of topics) {
      if (opened.has(topic.id) || topic.sticky || !topic.author) continue;
      posts.push({
        url: topic.url,
        title: topic.title,
        text: topic.title,
        service: hostOf(boardUrl),
        author: topic.author,
        ...(topic.authorUrl ? { profile: { urls: [topic.authorUrl] } } : {}),
      });
    }
    return posts;
  },
};
