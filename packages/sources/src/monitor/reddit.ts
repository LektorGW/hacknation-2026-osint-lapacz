// Silnik `reddit`: publiczne listy subreddita bez logowania. Reddit często odmawia
// automatom (429/403) — po odmowie nie ponawiamy; kolejne próby idą do kanału Atom
// (`.rss`) na www.reddit.com, a potem na old.reddit.com. Odstęp między żądaniami: 2 s.

import type { Identifier } from '@olcys/core';
import { htmlToText } from '../html.ts';
import { parseJson } from '../http.ts';
import { SLOW_INTERVAL_MS, searchTerm, toIso } from './common.ts';
import type { EngineAdapter, EngineRun, MonitorPost } from './common.ts';
import { parseFeed } from './rss.ts';

const SERVICE = 'reddit.com';
const SUB = /^[A-Za-z0-9_]{2,21}$/;

interface RedditThing {
  kind?: string;
  data?: {
    author?: string;
    title?: string;
    selftext?: string;
    body?: string;
    permalink?: string;
    created_utc?: number;
    link_title?: string;
    subreddit?: string;
  };
}

interface RedditListing {
  data?: { children?: RedditThing[] };
}

function fromListing(listing: RedditListing | null): MonitorPost[] {
  const posts: MonitorPost[] = [];
  for (const thing of listing?.data?.children ?? []) {
    const data = thing.data;
    if (!data?.permalink || !data.author || data.author === '[deleted]' || data.author === 'AutoModerator') continue;
    const published = toIso(data.created_utc);
    posts.push({
      url: `https://www.reddit.com${data.permalink}`,
      title: htmlToText(data.title ?? data.link_title ?? ''),
      text: htmlToText(data.selftext ?? data.body ?? '') || htmlToText(data.title ?? ''),
      service: SERVICE,
      author: data.author,
      profile: { urls: [`https://www.reddit.com/user/${data.author}`] },
      ...(published ? { publishedAt: published } : {}),
    });
  }
  return posts;
}

const get = (run: EngineRun, url: string, accept: string) =>
  run.session.get(url, { headers: { Accept: accept }, minIntervalMs: run.intervalMs, quietMissing: true });

export const redditEngine: EngineAdapter = {
  accepts: ['nick', 'login', 'crypto_address'],
  intervalMs: SLOW_INTERVAL_MS,
  requestHost: () => 'www.reddit.com',
  addressKey: (source) => `r/${(source.sub ?? '').toLowerCase()}`,
  describe: (source) =>
    `Subreddit r/${source.sub}: najnowsze wpisy z publicznego kanału Atom https://www.reddit.com/r/${source.sub}/new/.rss (zapas: old.reddit.com). ` +
    'Wyszukiwanie w obrębie subreddita (search.json, restrict_sr=1) po adresie albo autorze. ' +
    'Jedno żądanie na przebieg (drugie tylko jako zapas), co najmniej 2 s odstępu; po odmowie (429/403) bez ponawiania.',
  service: () => SERVICE,
  problem: (source) => (source.sub && SUB.test(source.sub) ? null : 'brak lub niepoprawne pole „sub"'),

  async discover(run) {
    const sub = run.source.sub!;
    // Po odmowie (429/403) sesja nie wyśle już nic do tego samego hosta — zostaje old.reddit.com.
    for (const host of ['www.reddit.com', 'old.reddit.com']) {
      const feed = await get(run, `https://${host}/r/${sub}/new/.rss`, 'application/atom+xml, application/xml;q=0.9');
      const posts = feed ? parseFeed(feed.text, SERVICE).map((post) => ({ ...post, service: SERVICE })) : [];
      if (posts.length > 0) return posts;
      // Pusty, ale poprawny kanał oznacza pusty subreddit — zapas jest tylko na wypadek odmowy lub błędu.
      if (feed) return [];
    }
    return [];
  },

  async search(run, identifier: Identifier) {
    const sub = run.source.sub!;
    const term = searchTerm(identifier);
    const byAddress = identifier.type === 'crypto_address';
    if (!byAddress && !/^[A-Za-z0-9_-]{3,20}$/.test(term)) return [];
    const query = byAddress ? `"${term}"` : `author:${term}`;
    const response = await get(
      run,
      `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=25&raw_json=1`,
      'application/json',
    );
    const posts = response ? fromListing(parseJson<RedditListing>(response.text)) : [];
    // Wyszukiwarka dopasowuje przybliżenie — zostają tylko wpisy naprawdę zawierające adres albo napisane przez tego autora.
    return posts.filter((post) => (byAddress ? `${post.title}\n${post.text}`.includes(term) : post.author?.toLowerCase() === term.toLowerCase()));
  },
};
