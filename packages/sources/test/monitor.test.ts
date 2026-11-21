// Monitoring źródeł: każdy silnik na zapisanych przykładowych odpowiedziach
// (kształt zgodny z prawdziwymi API, dane fikcyjne), rejestr i przebieg.
// `fetch` jest atrapą — żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { IdentifierType, SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import type { Fetcher } from '../src/http.ts';
import {
  createConnectors,
  listMonitorConnectors,
  loadMonitorSources,
  mergeMonitorSources,
  runMonitorPass,
  summarizeMonitorSources,
} from '../src/index.ts';
import type { MonitorSourceConfig } from '../src/index.ts';
import { looseDate, selectAll } from '../src/monitor/html-list.ts';
import { parseFeed } from '../src/monitor/rss.ts';
import { parseSmfBoard, parseSmfTopic, smfDate } from '../src/monitor/smf.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
}

function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string>; at: number }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, at: Date.now() });
    const route = routes[url];
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object';
    return new Response(isJson ? JSON.stringify(route.body) : ((route.body ?? '') as string), {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8') },
    });
  };
  return { fetcher, calls };
}

function setup(sources: MonitorSourceConfig[], routes: Record<string, Route>, extra: { githubToken?: string; monitorOnlyWithAddresses?: boolean } = {}) {
  const { fetcher, calls } = mockFetch(routes);
  const warnings: string[] = [];
  const connectors = createConnectors({
    enableLive: true,
    fetcher,
    minRequestIntervalMs: 0,
    allowPrivateHosts: true,
    monitorSources: sources,
    log: (message) => void warnings.push(message),
    ...extra,
  });
  const monitors = listMonitorConnectors(connectors);
  const logs: string[] = [];
  const context = { log: (message: string) => void logs.push(message) };
  const discover = (id: string, limit = 50): Promise<SourceDocument[]> => monitors.find((connector) => connector.id === `mon-${id}`)!.discover(context, limit);
  const search = (id: string, type: IdentifierType, value: string): Promise<SourceDocument[]> =>
    monitors.find((connector) => connector.id === `mon-${id}`)!.search({ type, value }, context);
  return { connectors, monitors, calls, logs, warnings, discover, search };
}

const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);

/** Wspólne sprawdzenie każdego dokumentu z `discover`. */
function assertDiscovered(documents: SourceDocument[], connectorId: string) {
  for (const document of documents) {
    assert.equal(document.connectorId, connectorId);
    assert.equal(document.identityMatch, 'exact_identifier');
    assert.ok(document.url.startsWith('http'), document.url);
    assert.ok(document.text.length > 0);
    if (document.author) {
      assert.deepEqual(document.matchedIdentifier, { type: 'nick', value: document.author });
      assert.equal(document.profile!.handle, document.author);
    }
  }
}

// ---------- RSS / Atom ----------

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel><title>Forum Krypto — Giełda</title><link>https://forum.example/</link>
<item>
  <title><![CDATA[Sprzedam 0,5 BTC — Gdańsk]]></title>
  <link>https://forum.example/viewtopic.php?t=12&amp;p=345#p345</link>
  <dc:creator><![CDATA[kupiec_gd]]></dc:creator>
  <pubDate>Tue, 10 Nov 2026 18:30:00 +0000</pubDate>
  <content:encoded><![CDATA[<blockquote><p>cudzy cytat z adresem ${ADDR.namesakeBtc}</p></blockquote>
    <div class="quotecontent">drugi cytat</div>
    <p>Sprzedam za gotówkę. Zaliczka na ${ADDR.kacperBtc}, kontakt: kupiec@poczta.example</p>]]></content:encoded>
</item>
<item>
  <title>Pytanie o podatki &amp; PIT-38</title>
  <link>https://forum.example/viewtopic.php?t=13</link>
  <author>ktos@poczta.example (Anna Nowa)</author>
  <pubDate>Mon, 09 Nov 2026 08:00:00 +0000</pubDate>
  <description>&lt;p&gt;Czy z wymiany P2P składa się PIT-38?&lt;/p&gt;</description>
</item>
<item><title>Bez autora</title><link>https://forum.example/viewtopic.php?t=14</link><description>Treść bez podpisu</description></item>
<item><title>Bez adresu</title><description>pominięty</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>najnowsze wpisy : kryptowaluty</title>
<entry>
  <author><name>/u/hodler_pl</name><uri>https://www.reddit.com/user/hodler_pl</uri></author>
  <content type="html">&lt;div class="md"&gt;&lt;p&gt;Gdzie wymieniacie USDT? Mój portfel: ${ADDR.hubertTron}&lt;/p&gt;&lt;/div&gt;</content>
  <id>t3_abc</id>
  <link href="https://www.reddit.com/r/kryptowaluty/comments/abc/gdzie_wymieniacie/" />
  <updated>2026-11-11T12:00:00+00:00</updated><published>2026-11-11T11:59:00+00:00</published>
  <title>Gdzie wymieniacie USDT?</title>
</entry>
<entry>
  <author><name>Blog Autor</name></author>
  <link rel="self" href="https://blog.example/feed/1"/><link rel="alternate" type="text/html" href="https://blog.example/wpis-1"/>
  <summary>Krótka zajawka</summary><updated>2026-11-01T00:00:00Z</updated><title>Wpis pierwszy</title>
</entry>
</feed>`;

describe('silnik rss', () => {
  const source: MonitorSourceConfig = { id: 'forum-rss', engine: 'rss', label: 'Forum Krypto', url: 'https://forum.example/feed.php', language: 'pl', category: 'sale_offer' };

  test('RSS 2.0: autor, data, treść bez cytatów, bezpośredni adres posta', async () => {
    const { discover, calls } = setup([source], { 'https://forum.example/feed.php': { body: RSS, type: 'application/rss+xml; charset=utf-8' } });
    const documents = await discover('forum-rss');
    assert.deepEqual(calls.map((call) => call.url), ['https://forum.example/feed.php']);
    assert.equal(documents.length, 3);
    assertDiscovered(documents, 'mon-forum-rss');
    const [offer, question, anonymous] = documents as [SourceDocument, SourceDocument, SourceDocument];
    assert.equal(offer.url, 'https://forum.example/viewtopic.php?t=12&p=345#p345');
    assert.equal(offer.title, 'Sprzedam 0,5 BTC — Gdańsk');
    assert.equal(offer.author, 'kupiec_gd');
    assert.equal(offer.service, 'forum.example');
    assert.equal(offer.category, 'sale_offer');
    assert.equal(offer.publishedAt, '2026-11-10T18:30:00.000Z');
    // Adres z cytatu innej osoby nie może zostać przypisany autorowi posta.
    assert.deepEqual(addressesOf(offer), [ADDR.kacperBtc]);
    assert.doesNotMatch(offer.text, /cytat/);
    assert.deepEqual(offer.discoveredIdentifiers, [{ type: 'email', value: 'kupiec@poczta.example' }]);
    assert.equal(question.author, 'Anna Nowa');
    assert.equal(question.title, 'Pytanie o podatki & PIT-38');
    assert.equal(question.text, 'Czy z wymiany P2P składa się PIT-38?');
    // Post bez autora zostaje (wyboru dokonuje API), ale bez profilu.
    assert.equal(anonymous.author, undefined);
    assert.equal(anonymous.profile, undefined);
  });

  test('Atom: autor w zapisie Reddita, odnośnik alternate, profil autora', () => {
    const posts = parseFeed(ATOM, 'x.example');
    assert.equal(posts.length, 2);
    assert.equal(posts[0]!.author, 'hodler_pl');
    assert.equal(posts[0]!.url, 'https://www.reddit.com/r/kryptowaluty/comments/abc/gdzie_wymieniacie/');
    assert.equal(posts[0]!.publishedAt, '2026-11-11T11:59:00.000Z');
    assert.deepEqual(posts[0]!.profile, { urls: ['https://www.reddit.com/user/hodler_pl'] });
    assert.match(posts[0]!.text, new RegExp(ADDR.hubertTron));
    assert.equal(posts[1]!.url, 'https://blog.example/wpis-1');
    assert.equal(posts[1]!.text, 'Krótka zajawka');
  });

  test('błąd serwera i odmowa: pusty wynik z wpisem w dzienniku; filtr „tylko z adresami"', async () => {
    for (const status of [500, 403, 429]) {
      const { discover, logs } = setup([source], { 'https://forum.example/feed.php': { status } });
      assert.deepEqual(await discover('forum-rss'), []);
      assert.match(logs.join('\n'), new RegExp(`kod ${status}`));
    }
    const filtered = setup([{ ...source, onlyWithAddresses: true }], { 'https://forum.example/feed.php': { body: RSS, type: 'text/xml' } });
    assert.deepEqual((await filtered.discover('forum-rss')).map((document) => document.author), ['kupiec_gd']);
    const global = setup([source], { 'https://forum.example/feed.php': { body: RSS, type: 'text/xml' } }, { monitorOnlyWithAddresses: true });
    assert.equal((await global.discover('forum-rss')).length, 1);
  });
});

// ---------- Discourse ----------

describe('silnik discourse', () => {
  const source: MonitorSourceConfig = { id: 'dsc', engine: 'discourse', label: 'Forum Discourse', url: 'https://forum.projekt.example/' };
  const post = (id: number, username: string, cooked: string, number = 1) => ({
    id,
    username,
    name: `Imię ${username}`,
    avatar_template: '/user_avatar/forum.projekt.example/x/{size}/1_2.png',
    created_at: `2026-11-1${id}T10:00:00.000Z`,
    cooked,
    post_number: number,
    topic_id: 77,
    topic_slug: 'wymiana-p2p',
    topic_title: 'Wymiana P2P',
  });

  test('/posts.json: jedno żądanie, posty z autorem, profilem i treścią bez cytatów', async () => {
    const { discover, calls } = setup([source], {
      'https://forum.projekt.example/posts.json': {
        body: {
          latest_posts: [
            post(1, 'ala', `<p>Mój adres: ${ADDR.kacperEth}</p>`),
            post(2, 'olek', `<aside class="quote no-group" data-username="ala"><blockquote><p>Mój adres: ${ADDR.kacperEth}</p></blockquote></aside><p>Dzięki, wysłane.</p>`, 2),
          ],
        },
      },
    });
    const documents = await discover('dsc');
    assert.deepEqual(calls.map((call) => call.url), ['https://forum.projekt.example/posts.json']);
    assertDiscovered(documents, 'mon-dsc');
    const [reply, original] = documents as [SourceDocument, SourceDocument];
    assert.equal(reply.author, 'olek');
    assert.equal(reply.url, 'https://forum.projekt.example/t/wymiana-p2p/77/2');
    assert.equal(reply.text, 'Dzięki, wysłane.');
    assert.deepEqual(addressesOf(reply), []);
    assert.deepEqual(addressesOf(original), [ADDR.kacperEth]);
    assert.deepEqual(original.profile, {
      handle: 'ala',
      displayName: 'Imię ala',
      urls: ['https://forum.projekt.example/u/ala'],
      avatarUrl: 'https://forum.projekt.example/user_avatar/forum.projekt.example/x/120/1_2.png',
    });
    assert.equal(original.title, 'Wymiana P2P');
    assert.equal(original.category, 'forum_post');
  });

  test('bez /posts.json: lista wątków z /latest.json przypisana autorom wątków (drugie i ostatnie żądanie)', async () => {
    const { discover, calls } = setup([source], {
      'https://forum.projekt.example/posts.json': { status: 404 },
      'https://forum.projekt.example/latest.json': {
        body: {
          users: [{ id: 5, username: 'ala', name: 'Ala', avatar_template: 'https://cdn.example/a/{size}.png' }],
          topic_list: { topics: [{ id: 90, title: 'Nowy wątek', slug: 'nowy-watek', created_at: '2026-11-15T09:00:00.000Z', excerpt: 'Zajawka wątku', posters: [{ user_id: 5 }] }] },
        },
      },
    });
    const documents = await discover('dsc');
    assert.equal(calls.length, 2);
    assert.equal(documents.length, 1);
    assert.equal(documents[0]!.url, 'https://forum.projekt.example/t/nowy-watek/90/1');
    assert.equal(documents[0]!.author, 'ala');
    assert.equal(documents[0]!.text, 'Zajawka wątku');
    assert.equal(documents[0]!.profile!.avatarUrl, 'https://cdn.example/a/120.png');
  });

  test('wyszukiwanie: po adresie (posty cudzego autorstwa) i po nicku z danymi profilu', async () => {
    const hit = (username: string, blurb: string) => ({ id: 9, username, name: null, created_at: '2026-10-01T00:00:00.000Z', blurb, post_number: 3, topic_id: 77 });
    const routes = {
      [`https://forum.projekt.example/search.json?q=${ADDR.kacperEth}`]: {
        body: { posts: [hit('ala', `...mój adres: ${ADDR.kacperEth} dzięki`), hit('ktos', 'zajawka bez adresu')], topics: [{ id: 77, title: 'Wymiana P2P', slug: 'wymiana-p2p' }] },
      },
      'https://forum.projekt.example/u/ala.json': {
        body: { user: { id: 5, username: 'ala', name: 'Alicja Testowa', location: 'Kraków', website: 'ala.example', bio_excerpt: 'Handluję.', created_at: '2020-01-01T00:00:00.000Z' } },
      },
      'https://forum.projekt.example/search.json?q=%40ala': { body: { posts: [hit('ala', 'post Ali'), hit('inna', 'cudzy post')], topics: [] } },
    };
    const byAddress = setup([source], routes);
    const found = await byAddress.search('dsc', 'crypto_address', ADDR.kacperEth);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.author, 'ala');
    assert.equal(found[0]!.identityMatch, 'name_only');
    assert.equal(found[0]!.matchedIdentifier.type, 'crypto_address');
    assert.equal(found[0]!.url, 'https://forum.projekt.example/t/wymiana-p2p/77/3');

    const byNick = setup([source], routes);
    const posts = await byNick.search('dsc', 'nick', '@ala');
    assert.equal(byNick.calls.length, 2);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.identityMatch, 'exact_identifier');
    assert.equal(posts[0]!.profile!.displayName, 'Alicja Testowa');
    assert.equal(posts[0]!.profile!.location, 'Kraków');
    assert.deepEqual(posts[0]!.profile!.urls, ['https://forum.projekt.example/u/ala', 'https://ala.example/']);
    assert.equal(posts[0]!.profile!.createdAt, '2020-01-01T00:00:00.000Z');
    assert.deepEqual(await byNick.search('dsc', 'nick', 'nieznany'), []);
  });
});

// ---------- Reddit ----------

describe('silnik reddit', () => {
  const source: MonitorSourceConfig = { id: 'r-krypto', engine: 'reddit', label: 'r/kryptowaluty', sub: 'kryptowaluty', language: 'pl' };
  const WWW = 'https://www.reddit.com/r/kryptowaluty/new/.rss';
  const OLD = 'https://old.reddit.com/r/kryptowaluty/new/.rss';

  test('kanał Atom subreddita: jedno żądanie, service reddit.com', async () => {
    const { discover, calls } = setup([source], { [WWW]: { body: ATOM, type: 'application/atom+xml; charset=UTF-8' } });
    const documents = await discover('r-krypto');
    assert.deepEqual(calls.map((call) => call.url), [WWW]);
    assertDiscovered(documents, 'mon-r-krypto');
    assert.equal(documents[0]!.author, 'hodler_pl');
    assert.equal(documents[0]!.service, 'reddit.com');
    assert.deepEqual(addressesOf(documents[0]!), [ADDR.hubertTron]);
  });

  test('429 na www.reddit.com: jedna próba zapasowa na old.reddit.com, bez ponawiania', async () => {
    const { discover, calls, logs } = setup([source], { [WWW]: { status: 429 }, [OLD]: { body: ATOM, type: 'application/atom+xml' } });
    assert.equal((await discover('r-krypto')).length, 2);
    assert.deepEqual(calls.map((call) => call.url), [WWW, OLD]);
    assert.match(logs.join('\n'), /kod 429/);

    const both = setup([source], { [WWW]: { status: 429 }, [OLD]: { status: 403 } });
    assert.deepEqual(await both.discover('r-krypto'), []);
    assert.equal(both.calls.length, 2);
  });

  test('wyszukiwanie w obrębie subreddita: po adresie i po autorze', async () => {
    const thing = (author: string, selftext: string, id: string) => ({ kind: 't3', data: { author, title: `Wpis ${id}`, selftext, permalink: `/r/kryptowaluty/comments/${id}/x/`, created_utc: 1_790_000_000 } });
    const addressUrl = `https://www.reddit.com/r/kryptowaluty/search.json?q=${encodeURIComponent(`"${ADDR.kacperBtc}"`)}&restrict_sr=1&sort=new&limit=25&raw_json=1`;
    const authorUrl = 'https://www.reddit.com/r/kryptowaluty/search.json?q=author%3Ahodler_pl&restrict_sr=1&sort=new&limit=25&raw_json=1';
    const { search } = setup([source], {
      [addressUrl]: { body: { data: { children: [thing('ktos1', `wpłać na ${ADDR.kacperBtc}`, 'a1'), thing('ktos2', 'przybliżone trafienie', 'a2'), thing('[deleted]', ADDR.kacperBtc, 'a3')] } } },
      [authorUrl]: { body: { data: { children: [thing('hodler_pl', 'mój wpis', 'b1'), thing('inny', 'nie mój', 'b2')] } } },
    });
    const byAddress = await search('r-krypto', 'crypto_address', ADDR.kacperBtc);
    assert.deepEqual(byAddress.map((document) => document.author), ['ktos1']);
    assert.equal(byAddress[0]!.identityMatch, 'name_only');
    assert.equal(byAddress[0]!.url, 'https://www.reddit.com/r/kryptowaluty/comments/a1/x/');
    const byAuthor = await search('r-krypto', 'nick', 'hodler_pl');
    assert.deepEqual(byAuthor.map((document) => document.author), ['hodler_pl']);
    assert.deepEqual(byAuthor[0]!.profile, { handle: 'hodler_pl', urls: ['https://www.reddit.com/user/hodler_pl'] });
  });
});

// ---------- Mastodon, Lemmy, StackExchange, HN, Telegram, GitHub ----------

describe('silniki API', () => {
  test('mastodon-tag: wpisy z osi czasu hashtagu, autor z innej instancji, boty pominięte', async () => {
    const status = (acct: string, url: string, bot = false) => ({
      id: '1',
      created_at: '2026-11-12T08:00:00.000Z',
      url: `${url}/111`,
      content: `<p>Sprzedam <a href="https://x.example/tags/bitcoin" class="mention hashtag">#<span>bitcoin</span></a>, portfel ${ADDR.kacperBtc}</p>`,
      account: {
        username: acct.split('@')[0],
        acct,
        display_name: 'Jan Kowalski',
        url,
        avatar: 'https://cdn.example/a.png',
        note: '<p>Trader z Wrocławia</p>',
        created_at: '2021-05-05T00:00:00.000Z',
        bot,
        fields: [
          { name: 'WWW', value: '<a href="https://jan.example" rel="me">jan.example</a>', verified_at: '2023-01-01T00:00:00.000Z' },
          { name: 'Inne', value: '<a href="https://inne.example">inne</a>', verified_at: null },
        ],
      },
    });
    const { discover, calls } = setup([{ id: 'masto', engine: 'mastodon-tag', label: '#kryptowaluty', instance: 'pl.example', tag: 'kryptowaluty' }], {
      'https://pl.example/api/v1/timelines/tag/kryptowaluty?limit=20': {
        body: [status('jan', 'https://pl.example/@jan'), status('ola@inna.example', 'https://inna.example/@ola'), status('robot', 'https://pl.example/@robot', true)],
      },
    });
    const documents = await discover('masto');
    assert.equal(calls.length, 1);
    assertDiscovered(documents, 'mon-masto');
    assert.deepEqual(documents.map((document) => document.author), ['jan', 'ola@inna.example']);
    assert.deepEqual(documents.map((document) => document.service), ['pl.example', 'inna.example']);
    assert.deepEqual(addressesOf(documents[0]!), [ADDR.kacperBtc]);
    assert.deepEqual(documents[0]!.profile, {
      handle: 'jan',
      displayName: 'Jan Kowalski',
      urls: ['https://pl.example/@jan', 'https://jan.example', 'https://inne.example'],
      avatarUrl: 'https://cdn.example/a.png',
      bio: 'Trader z Wrocławia',
      createdAt: '2021-05-05T00:00:00.000Z',
    });
    assert.deepEqual(documents[0]!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://jan.example/' }]);
  });

  test('lemmy: wpisy społeczności, cytaty Markdown pominięte, autor z innej instancji jako nick@host', async () => {
    const view = (name: string, actor: string, body: string, id: number) => ({
      post: { id, name: `Wpis ${id}`, body, ap_id: `https://lemmy.example/post/${id}`, published: `2026-11-0${id}T10:00:00.000000Z` },
      creator: { name, display_name: 'Ola', actor_id: actor, avatar: 'https://cdn.example/o.png', bio: 'bio', published: '2023-06-01T00:00:00.000000Z', bot_account: false },
    });
    const { discover, calls } = setup([{ id: 'lem', engine: 'lemmy', label: 'Lemmy: bitcoin', instance: 'lemmy.example', community: 'bitcoin' }], {
      'https://lemmy.example/api/v3/post/list?community_name=bitcoin&sort=New&limit=20': {
        body: {
          posts: [
            view('ola', 'https://lemmy.example/u/ola', `> cudzy adres ${ADDR.namesakeBtc}\nMój adres: ${ADDR.kacperBtc}`, 1),
            view('zdalny', 'https://inna.example/u/zdalny', 'Witam', 2),
          ],
        },
      },
    });
    const documents = await discover('lem');
    assert.equal(calls.length, 1);
    assertDiscovered(documents, 'mon-lem');
    assert.deepEqual(documents.map((document) => document.author), ['zdalny@inna.example', 'ola']);
    assert.deepEqual(addressesOf(documents[1]!), [ADDR.kacperBtc]);
    assert.equal(documents[1]!.url, 'https://lemmy.example/post/1');
    assert.equal(documents[1]!.publishedAt, '2026-11-01T10:00:00.000Z');
    assert.deepEqual(documents[1]!.profile, {
      handle: 'ola',
      displayName: 'Ola',
      urls: ['https://lemmy.example/u/ola'],
      avatarUrl: 'https://cdn.example/o.png',
      bio: 'bio',
      createdAt: '2023-06-01T00:00:00.000Z',
    });
  });

  test('stackexchange: najnowsze pytania z treścią; wyszukiwanie po adresie i po nazwie użytkownika', async () => {
    const question = (id: number, name: string, body: string) => ({
      question_id: id,
      title: `Pytanie ${id} &amp; reszta`,
      body,
      link: `https://bitcoin.stackexchange.com/questions/${id}/x`,
      creation_date: 1_790_000_000 + id,
      owner: { display_name: name, link: `https://bitcoin.stackexchange.com/users/${id}/${name}`, profile_image: 'https://cdn.example/p.png', user_id: id },
    });
    const source: MonitorSourceConfig = { id: 'se', engine: 'stackexchange', label: 'Bitcoin SE', site: 'bitcoin' };
    const listUrl = 'https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&site=bitcoin&filter=withbody&pagesize=20';
    const { discover, search, calls } = setup([source], {
      [listUrl]: { body: { items: [question(1, 'ala', `<p>Wysłałam na <code>${ADDR.kacperBtc}</code></p>`), question(2, 'olek', '<p>Jak działa mempool?</p>'), { question_id: 3, title: 'bez autora', body: 'x' }] } },
      [`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${ADDR.kacperBtc}&site=bitcoin&pagesize=20&filter=withbody`]: {
        body: { items: [question(1, 'ala', `<p>Wysłałam na ${ADDR.kacperBtc}</p>`), question(4, 'ktos', '<p>trafienie przybliżone</p>')] },
      },
      'https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&inname=ala&site=bitcoin&pagesize=20': {
        body: { items: [{ display_name: 'Alan', user_id: 8 }, { display_name: 'Ala', user_id: 1, link: 'https://bitcoin.stackexchange.com/users/1/ala', location: 'Pozna&#324;, Poland', website_url: 'https://ala.example', creation_date: 1_600_000_000 }] },
      },
      'https://api.stackexchange.com/2.3/users/1/posts?order=desc&sort=creation&site=bitcoin&pagesize=20&filter=withbody': {
        body: { items: [{ post_id: 55, post_type: 'answer', body: '<p>Odpowiedź Ali</p>', creation_date: 1_700_000_000 }] },
      },
    });
    const documents = await discover('se');
    assert.equal(calls.length, 1);
    assertDiscovered(documents, 'mon-se');
    assert.deepEqual(documents.map((document) => document.author), ['olek', 'ala']);
    assert.equal(documents[1]!.title, 'Pytanie 1 & reszta');
    assert.equal(documents[1]!.service, 'bitcoin.stackexchange.com');
    assert.deepEqual(addressesOf(documents[1]!), [ADDR.kacperBtc]);
    assert.deepEqual(documents[1]!.profile, { handle: 'ala', urls: ['https://bitcoin.stackexchange.com/users/1/ala'], avatarUrl: 'https://cdn.example/p.png' });

    const byAddress = await search('se', 'crypto_address', ADDR.kacperBtc);
    assert.deepEqual(byAddress.map((document) => document.author), ['ala']);
    assert.equal(byAddress[0]!.identityMatch, 'name_only');

    const byNick = await search('se', 'nick', 'ala');
    assert.equal(byNick.length, 1);
    assert.equal(byNick[0]!.url, 'https://bitcoin.stackexchange.com/a/55');
    assert.equal(byNick[0]!.profile!.location, 'Poznań, Poland');
    assert.deepEqual(byNick[0]!.profile!.urls, ['https://bitcoin.stackexchange.com/users/1/ala', 'https://ala.example/']);
  });

  test('hn: najnowsze komentarze dla frazy; wyszukiwanie po adresie i po autorze', async () => {
    const hit = (id: string, author: string, text: string) => ({ objectID: id, author, created_at: `2026-11-0${id}T00:00:00Z`, story_title: 'Wątek o BTC', comment_text: text });
    const source: MonitorSourceConfig = { id: 'hn', engine: 'hn', label: 'HN: donate BTC', query: 'donate BTC' };
    const { discover, search, calls } = setup([source], {
      'https://hn.algolia.com/api/v1/search_by_date?query=donate%20BTC&tags=comment&hitsPerPage=20': {
        body: { hits: [hit('1', 'pg_fan', `<p>You can donate BTC to ${ADDR.kacperBtc}</p>`), hit('2', 'other', 'no address &amp; nothing'), { objectID: '3', comment_text: 'bez autora' }] },
      },
      [`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(`"${ADDR.kacperBtc}"`)}&tags=(story,comment)&hitsPerPage=30`]: { body: { hits: [hit('1', 'pg_fan', `donate to ${ADDR.kacperBtc}`)] } },
      'https://hn.algolia.com/api/v1/search_by_date?tags=author_pg_fan&hitsPerPage=30': { body: { hits: [hit('4', 'pg_fan', 'another comment')] } },
    });
    const documents = await discover('hn');
    assert.equal(calls.length, 1);
    assertDiscovered(documents, 'mon-hn');
    assert.deepEqual(documents.map((document) => document.author), ['other', 'pg_fan']);
    assert.equal(documents[1]!.url, 'https://news.ycombinator.com/item?id=1');
    assert.equal(documents[0]!.text, 'no address & nothing');
    assert.deepEqual(documents[1]!.profile, { handle: 'pg_fan', urls: ['https://news.ycombinator.com/user?id=pg_fan'] });
    assert.equal((await search('hn', 'crypto_address', ADDR.kacperBtc))[0]!.identityMatch, 'name_only');
    assert.equal((await search('hn', 'login', 'pg_fan'))[0]!.url, 'https://news.ycombinator.com/item?id=4');
  });

  test('telegram: wszystkie wiadomości z podglądu kanału, autor = kanał', async () => {
    const page = `<html><body><div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span>Kantor Kanał</span></div>
      <div class="tgme_channel_info_description">Wymiana. <a href="https://kantor.example/">strona</a></div></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="kantor_kanal/7"><div class="tgme_widget_message_text">Kurs dnia 3,60</div>
        <time datetime="2026-11-10T08:00:00+00:00"></time></div></div>
      <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="kantor_kanal/8"><div class="tgme_widget_message_text">Wpłaty na ${ADDR.hubertTron}</div>
        <time datetime="2026-11-11T08:00:00+00:00"></time></div></div></body></html>`;
    const { discover, logs } = setup(
      [
        { id: 'tg', engine: 'telegram', label: 'Telegram: kantor', channel: '@kantor_kanal', category: 'sale_offer' },
        { id: 'tg-brak', engine: 'telegram', label: 'Telegram: brak', channel: 'nie_kanal_1' },
      ],
      { 'https://t.me/s/kantor_kanal': { body: page }, 'https://t.me/s/nie_kanal_1': { body: '<html><body>profil</body></html>' } },
    );
    const documents = await discover('tg');
    assertDiscovered(documents, 'mon-tg');
    assert.deepEqual(documents.map((document) => document.url), ['https://t.me/kantor_kanal/8', 'https://t.me/kantor_kanal/7']);
    assert.equal(documents[0]!.author, 'kantor_kanal');
    assert.equal(documents[0]!.category, 'sale_offer');
    assert.deepEqual(documents[0]!.profile, { handle: 'kantor_kanal', displayName: 'Kantor Kanał', urls: ['https://t.me/kantor_kanal', 'https://kantor.example/'], bio: 'Wymiana. strona' });
    assert.deepEqual(await discover('tg-brak'), []);
    assert.match(logs.join('\n'), /nie jest kanałem z publicznym podglądem/);
  });

  test('github-search: bez tokenu żadnego żądania; z tokenem nagłówek tylko do api.github.com', async () => {
    const source: MonitorSourceConfig = { id: 'gh', engine: 'github-search', label: 'GitHub: donate', query: 'donate BTC' };
    const url = 'https://api.github.com/search/issues?q=donate%20BTC&sort=created&order=desc&per_page=30';
    const routes = { [url]: { body: { items: [{ html_url: 'https://github.com/a/b/issues/1', title: 'Donate', body: `BTC: ${ADDR.kacperBtc}`, created_at: '2026-11-01T00:00:00Z', user: { login: 'dev1', avatar_url: 'https://cdn.example/d.png', html_url: 'https://github.com/dev1' } }] } } };
    const without = setup([source], routes);
    assert.deepEqual(await without.discover('gh'), []);
    assert.equal(without.calls.length, 0);
    assert.match(without.logs.join('\n'), /ustaw GITHUB_TOKEN/);
    const withToken = setup([source], routes, { githubToken: 'ghp_tajny' });
    const documents = await withToken.discover('gh');
    assert.equal(documents[0]!.author, 'dev1');
    assert.deepEqual(addressesOf(documents[0]!), [ADDR.kacperBtc]);
    assert.equal(withToken.calls[0]!.headers.Authorization, 'Bearer ghp_tajny');
  });
});

// ---------- html-list ----------

describe('silnik html-list', () => {
  const html = `<html><body><table>
    <tr><td class="windowbg3"><span id="msg_1"><a href="https://forum2.example/index.php?topic=101.0">Sprzedam ETH za gotówkę</a></span>
        <small><a href="https://forum2.example/index.php?topic=101.20">2</a></small></td>
      <td class="windowbg2" width="14%"><a href="/index.php?action=profile;u=7" title="View the profile of ktos_7">ktos_7</a></td>
      <td class="windowbg2 lastpostcol"><span class="smalltext">April 13, 2026, 07:18:30 AM<br />by <a href="/index.php?action=profile;u=9">inny</a></span></td></tr>
    <tr><td class="windowbg3"><span id="msg_2"><a href="/index.php?topic=102.0">Kupię BTC &amp; USDT</a></span></td>
      <td class="windowbg2"><a href="/index.php?action=profile;u=8" title="View the profile of ola">ola</a></td>
      <td class="windowbg2 lastpostcol"><span class="smalltext">nieczytelna data</span></td></tr>
    <tr><td>wiersz bez odnośnika do wątku</td></tr></table></body></html>`;
  const source: MonitorSourceConfig = {
    id: 'lista',
    engine: 'html-list',
    label: 'Forum 2 — giełda',
    url: 'https://forum2.example/index.php?board=5.0',
    selectors: { item: 'tr', link: 'span a[href*=topic=]', author: 'td.windowbg2 a[href*=action=profile][title]', date: 'td.lastpostcol span.smalltext' },
    category: 'sale_offer',
  };

  test('selektory: znacznik, klasa, atrybut, potomek', () => {
    assert.equal(selectAll(html, 'tr').length, 3);
    assert.equal(selectAll(html, 'span a[href*=topic=]').length, 2);
    assert.deepEqual(selectAll(html, 'td.lastpostcol a').map((element) => element.inner), ['inny']);
    assert.equal(selectAll(html, 'td.windowbg2.lastpostcol').length, 2);
    assert.equal(selectAll(html, 'a[title^=View]').length, 2);
    assert.equal(selectAll(html, '[id=msg_2] a')[0]!.inner, 'Kupię BTC &amp; USDT');
    assert.equal(looseDate('April 13, 2026, 07:18:30 AM by ktoś'), '2026-04-13T07:18:30.000Z');
    assert.equal(looseDate('nieczytelna data'), undefined);
  });

  test('robots.txt, potem lista: tytuły, autorzy z profilem, daty', async () => {
    const { discover, calls } = setup([source], {
      'https://forum2.example/robots.txt': { body: 'User-agent: *\nDisallow: /admin/', type: 'text/plain' },
      'https://forum2.example/index.php?board=5.0': { body: html },
    });
    const documents = await discover('lista');
    assert.deepEqual(calls.map((call) => call.url), ['https://forum2.example/robots.txt', 'https://forum2.example/index.php?board=5.0']);
    assertDiscovered(documents, 'mon-lista');
    assert.equal(documents.length, 2);
    const first = documents.find((document) => document.author === 'ktos_7')!;
    assert.equal(first.url, 'https://forum2.example/index.php?topic=101.0');
    assert.equal(first.title, 'Sprzedam ETH za gotówkę');
    assert.equal(first.publishedAt, '2026-04-13T07:18:30.000Z');
    assert.deepEqual(first.profile, { handle: 'ktos_7', urls: ['https://forum2.example/index.php?action=profile;u=7'] });
    const second = documents.find((document) => document.author === 'ola')!;
    assert.equal(second.title, 'Kupię BTC & USDT');
    assert.equal(second.publishedAt, undefined);
    // Reguły robots.txt są pamiętane na hosta — drugi przebieg to jedno żądanie.
    await discover('lista');
    assert.equal(calls.length, 3);
  });

  test('zakaz w robots.txt: strona nie jest pobierana', async () => {
    const blocked: MonitorSourceConfig = { ...source, id: 'zakaz', url: 'https://zakaz.example/forum/lista' };
    const { discover, calls, logs } = setup([blocked], {
      'https://zakaz.example/robots.txt': { body: 'User-agent: *\nDisallow: /forum/', type: 'text/plain' },
      'https://zakaz.example/forum/lista': { body: html },
    });
    assert.deepEqual(await discover('zakaz'), []);
    assert.equal(calls.length, 1);
    assert.match(logs.join('\n'), /robots\.txt nie pozwala/);
  });
});

// ---------- smf-board (Bitcointalk) ----------

describe('silnik smf-board', () => {
  const BASE = 'https://smf.example';
  // Fragmenty odwzorowują prawdziwy układ stron Bitcointalk (SMF 1.1); dane są fikcyjne.
  const row = (topic: number, title: string, starter: string, userId: number, sticky = false) => `
    <tr>
      <td class="windowbg2 leftimg" valign="middle" align="center" width="5%"><img src="${BASE}/Themes/custom1/images/topic/normal_post.gif" alt="" /></td>
      <td class="windowbg3" valign="middle" >
        ${sticky ? `<img src="${BASE}/Themes/custom1/images/icons/show_sticky.gif" align="right" alt="" id="stickyicon${topic}" style="margin: 0;" />` : ''}
        <span id="msg_${topic}9"><a href="${BASE}/index.php?topic=${topic}.0">${title}</a></span>
        <small id="pages${topic}9">&#171; <a href="${BASE}/index.php?topic=${topic}.0">1</a> <a href="${BASE}/index.php?topic=${topic}.20">2</a> &#187;</small>
      </td>
      <td class="windowbg2" valign="middle" width="14%"><a href="${BASE}/index.php?action=profile;u=${userId}" title="View the profile of ${starter}">${starter}</a></td>
      <td class="windowbg3" valign="middle" width="4%" align="center">12</td>
      <td class="windowbg2 lastpostcol" valign="middle" width="22%">
        <a href="${BASE}/index.php?topic=${topic}.msg777#new"><img src="${BASE}/Themes/custom1/images/icons/last_post.gif" alt="Last post" /></a>
        <span class="smalltext">April 13, 2026, 07:18:30 AM<br />by <a href="${BASE}/index.php?action=profile;u=99">ostatni</a></span>
      </td>
    </tr>`;
  const boardHtml = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1" /></head><body>
    <table><tr><td><table class="bordercolor">
      ${row(100, 'Regulamin działu', 'moderator', 1, true)}
      ${row(201, 'Sprzedam 0,3 BTC &#8212; Krak&#243;w, got&#243;wka', 'kupiec_krk', 7)}
      ${row(202, 'Kupi&#281; USDT', 'ola_usdt', 8)}
      ${row(203, 'Trzeci wątek', 'trzeci', 9)}
    </table></td></tr></table></body></html>`;
  const post = (topic: number, message: number, author: string, userId: number, subject: string, date: string, body: string, www = '') => `
    <td valign="top" width="16%" rowspan="2" style="overflow: hidden;" class="poster_info">
      <b><a href="${BASE}/index.php?action=profile;u=${userId}" title="View the profile of ${author}">${author}</a></b>
      <div class="smalltext"> Legendary<br /><span class="smalltext"> Online</span><br /><br /> Activity: 4074<br /> Merit: 13668<br />
        <a href="${BASE}/index.php?action=profile;u=${userId}"><img src="${BASE}/Themes/custom1/images/icons/profile_sm.gif" alt="View Profile" /></a>
        ${www ? `<a href="${www}" title="strona"><img src="${BASE}/Themes/custom1/images/www_sm.gif" alt="WWW" border="0" /></a>` : ''}<br /></div>
    </td>
    <td valign="top" width="85%" height="100%" style="padding: 2px;" class="td_headerandpost">
      <table width="100%" border="0"><tr>
        <td valign="middle" width="26"><a href="${BASE}/index.php?topic=${topic}.msg${message}#msg${message}"><img src="${BASE}/Themes/custom1/images/post/xx.gif" alt="" /></a></td>
        <td valign="middle"><div style="font-weight: bold;" class="subject" id="subject_${message}"><a href="${BASE}/index.php?topic=${topic}.msg${message}#msg${message}">${subject}</a></div>
          <div class="smalltext">${date}</div></td>
        <td align="right" class="td_buttons"><a class="message_number" href="${BASE}/index.php?topic=${topic}.msg${message}#msg${message}">#1</a></td>
      </tr></table>
      <hr width="100%" size="1" class="hrcolor" />
      <div class="post">${body}</div>
    </td>`;
  const topicHtml = (topic: number) => `<html><body><table><tr>
    ${post(topic, 5001, 'kupiec_krk', 7, 'Sprzedam 0,3 BTC', 'November 19, 2026, 09:27:06 AM', `Sprzedam za got&#243;wk&#281; w Krakowie.<br />Zaliczka na ${ADDR.kacperBtc}`, 'https://kupiec.example/')}
    </tr><tr>
    ${post(topic, 5002, 'pytajacy', 12, 'Re: Sprzedam 0,3 BTC', 'November 19, 2026, 10:00:00 AM', `<div class="quoteheader"><a href="#">Quote from: kupiec_krk</a></div><div class="quote">Zaliczka na ${ADDR.kacperBtc}</div>Czy aktualne?`)}
    </tr></table></body></html>`;

  test('parser listy działu: tytuły, autorzy, daty, wątki przypięte', () => {
    const topics = parseSmfBoard(boardHtml, `${BASE}/index.php?board=142.0`);
    assert.deepEqual(topics.map((topic) => topic.id), ['100', '201', '202', '203']);
    assert.deepEqual(topics.map((topic) => topic.sticky), [true, false, false, false]);
    assert.equal(topics[1]!.title, 'Sprzedam 0,3 BTC — Kraków, gotówka');
    assert.equal(topics[1]!.url, `${BASE}/index.php?topic=201.0`);
    assert.equal(topics[1]!.author, 'kupiec_krk');
    assert.equal(topics[1]!.authorUrl, `${BASE}/index.php?action=profile;u=7`);
    assert.equal(topics[1]!.lastPostAt, '2026-04-13T07:18:30.000Z');
    assert.equal(smfDate('Today at 07:18:30 AM', new Date('2026-11-21T12:00:00Z')), '2026-11-21T07:18:30.000Z');
  });

  test('parser wątku: posty z autorem, datą, treścią bez cytatów, adresem posta i stroną WWW autora', () => {
    const posts = parseSmfTopic(topicHtml(201), `${BASE}/index.php?topic=201.0`, 'tytuł zapasowy');
    assert.equal(posts.length, 2);
    const [offer, reply] = posts as [(typeof posts)[number], (typeof posts)[number]];
    assert.equal(offer.author, 'kupiec_krk');
    assert.equal(offer.url, `${BASE}/index.php?topic=201.msg5001#msg5001`);
    assert.equal(offer.title, 'Sprzedam 0,3 BTC');
    assert.equal(offer.publishedAt, '2026-11-19T09:27:06.000Z');
    assert.equal(offer.text, `Sprzedam za gotówkę w Krakowie.\nZaliczka na ${ADDR.kacperBtc}`);
    assert.deepEqual(offer.profile, { urls: [`${BASE}/index.php?action=profile;u=7`, 'https://kupiec.example/'] });
    assert.deepEqual(offer.discovered, [{ type: 'profile_url', value: 'https://kupiec.example/' }]);
    // Adres z cytatu nie jest przypisywany odpowiadającemu.
    assert.equal(reply.author, 'pytajacy');
    assert.equal(reply.text, 'Czy aktualne?');
    assert.deepEqual(reply.profile, { urls: [`${BASE}/index.php?action=profile;u=12`] });
  });

  const source = (board: number): MonitorSourceConfig => ({ id: `smf-${board}`, engine: 'smf-board', label: `Forum SMF — dział ${board}`, url: `${BASE}/index.php?board=${board}.0`, language: 'pl', category: 'sale_offer' });
  const routes = (boards: number[]) => {
    const table: Record<string, Route> = { [`${BASE}/robots.txt`]: { body: 'Sitemap: https://smf.example/sitemap.php\n', type: 'text/plain' } };
    for (const board of boards) table[`${BASE}/index.php?board=${board}.0`] = { body: boardHtml, type: 'text/html; charset=ISO-8859-1' };
    for (const topic of [201, 202, 203]) table[`${BASE}/index.php?topic=${topic}.0`] = { body: topicHtml(topic), type: 'text/html; charset=ISO-8859-1' };
    return table;
  };

  test('discover: lista działu i pierwsze strony najnowszych nieprzypiętych wątków, najwyżej 6 żądań na dział', async () => {
    const { discover, calls } = setup([source(142)], routes([142]));
    const documents = await discover('smf-142', 100);
    // robots.txt + lista + 3 wątki (przypięty pominięty)
    assert.deepEqual(calls.map((call) => call.url.replace(BASE, '')), ['/robots.txt', '/index.php?board=142.0', '/index.php?topic=201.0', '/index.php?topic=202.0', '/index.php?topic=203.0']);
    assertDiscovered(documents, 'mon-smf-142');
    assert.equal(documents.length, 6);
    assert.ok(documents.every((document) => document.category === 'sale_offer' && document.service === 'smf.example'));
    const offer = documents.find((document) => document.url.endsWith('topic=201.msg5001#msg5001'))!;
    assert.deepEqual(addressesOf(offer), [ADDR.kacperBtc]);
    assert.deepEqual(offer.profile, { handle: 'kupiec_krk', urls: [`${BASE}/index.php?action=profile;u=7`, 'https://kupiec.example/'] });
    assert.deepEqual(offer.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kupiec.example/' }]);
    assert.ok(!documents.some((document) => document.title === 'Regulamin działu'));
  });

  test('przebieg: limit żądań hosta dzielony między działy (lista zawsze, wątki według budżetu)', async () => {
    const boards = Array.from({ length: 20 }, (_, index) => 300 + index);
    const { connectors, calls } = setup(boards.map(source), routes(boards));
    const pass = await runMonitorPass(connectors, { limit: 50 });
    assert.ok(pass.results.every((result) => result.status === 'ok'));
    // 20 działów: 20 list + po 1 wątku = 40 żądań (+ jedno robots.txt, pamiętane z poprzedniego testu albo pobrane raz).
    const pages = calls.filter((call) => !call.url.endsWith('/robots.txt'));
    assert.equal(pages.length, 40);
    assert.equal(pages.filter((call) => call.url.includes('?board=')).length, 20);
    assert.ok(calls.filter((call) => call.url.endsWith('/robots.txt')).length <= 1);
    assert.ok(pass.results.every((result) => result.requests <= 6));
    // Wątki nieotwarte zostają na liście jako tytuły przypisane autorom.
    const first = pass.results[0]!;
    assert.ok(first.documents.some((document) => document.title === 'Kupię USDT' && document.author === 'ola_usdt'));
  });

  test('rejestr: wyłączony kanał RSS tego samego działu znika bez ostrzeżenia; włączony duplikat jest zgłaszany', () => {
    const merged = mergeMonitorSources([
      { file: 'core.json', entries: [source(142)] },
      {
        file: 'badacz.json',
        entries: [
          { id: 'rss-b142', engine: 'rss', label: 'ten sam dział przez RSS', url: `${BASE}/index.php?type=rss;action=.xml;board=142;limit=20`, enabled: false, note: 'HTTP 400' },
          { id: 'html-b142', engine: 'html-list', label: 'ten sam dział przez HTML', url: `${BASE}/index.php?board=142.0`, selectors: { item: 'tr', link: 'a' } },
          { id: 'rss-b5', engine: 'rss', label: 'inny dział', url: `${BASE}/index.php?type=rss;action=.xml;board=5`, enabled: false },
        ],
      },
    ]);
    assert.deepEqual(merged.sources.map((item) => item.id), ['smf-142', 'rss-b5']);
    assert.equal(merged.warnings.length, 1);
    assert.match(merged.warnings[0]!, /html-b142.*to samo źródło co core\.json#1/);
  });
});

// ---------- Rejestr ----------

describe('rejestr źródeł', () => {
  test('katalog plików: scalanie, pierwszeństwo core.json, duplikaty po id i po adresie, błędne wpisy z ostrzeżeniem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olcys-rejestr-'));
    try {
      writeFileSync(
        join(dir, 'core.json'),
        JSON.stringify([
          { id: 'forum-a', engine: 'discourse', label: 'Forum A (core)', url: 'https://forum-a.example' },
          { id: 'r-bitcoin', engine: 'reddit', label: 'r/Bitcoin', sub: 'Bitcoin' },
        ]),
      );
      writeFileSync(
        join(dir, 'a-badacz.json'),
        JSON.stringify([
          { id: 'forum-a-inaczej', engine: 'discourse', label: 'Forum A drugi raz', url: 'http://www.forum-a.example/' },
          { id: 'r-bitcoin', engine: 'reddit', label: 'powtórzone id', sub: 'btc' },
          { id: 'r-bitcoin-2', engine: 'reddit', label: 'ten sam subreddit', sub: 'bitcoin' },
          { id: 'tg-1', engine: 'telegram', label: 'Kanał', channel: 'kanal_jeden', enabled: false, note: 'brak podglądu' },
          { id: 'zly-silnik', engine: 'gopher', label: 'x', url: 'https://x.example' },
          { id: 'bez-url', engine: 'rss', label: 'bez adresu' },
          { id: 'zla kategoria', engine: 'hn', label: 'x', query: 'q' },
          { id: 'kat', engine: 'hn', label: 'x', query: 'q', category: 'plotka' },
          { id: 'lem-1', engine: 'lemmy', label: 'Lemmy', instance: 'lemmy.example', community: 'bitcoin', verifiedAt: '2026-11-21', verifiedItems: 20 },
          'nie obiekt',
        ]),
      );
      writeFileSync(join(dir, 'b-obiekt.json'), JSON.stringify({ sources: [{ id: 'masto-1', engine: 'mastodon-tag', label: '#btc', instance: 'pl.example', tag: 'bitcoin', language: 'pl', region: 'PL' }] }));
      writeFileSync(join(dir, 'zepsuty.json'), '{ to nie jest JSON');
      writeFileSync(join(dir, 'STATUS.md'), '# nie jest plikiem rejestru');

      const registry = loadMonitorSources(pathToFileURL(`${dir}/`));
      assert.deepEqual(registry.files, ['core.json', 'a-badacz.json', 'b-obiekt.json']);
      assert.deepEqual(registry.sources.map((source) => source.id), ['forum-a', 'r-bitcoin', 'tg-1', 'lem-1', 'masto-1']);
      assert.equal(registry.sources[0]!.label, 'Forum A (core)');
      const warnings = registry.warnings.join('\n');
      assert.equal(registry.warnings.length, 9);
      assert.match(warnings, /wpis nie jest obiektem/);
      assert.match(warnings, /zepsuty\.json: pominięto/);
      assert.match(warnings, /forum-a-inaczej.*to samo źródło co core\.json#1/);
      assert.match(warnings, /a-badacz\.json#2.*„id" powtórzone/);
      assert.match(warnings, /r-bitcoin-2.*to samo źródło/);
      assert.match(warnings, /nieznany silnik „gopher"/);
      assert.match(warnings, /bez-url.*brak pola „url"/);
      assert.match(warnings, /niepoprawne pole „id"/);
      assert.match(warnings, /nieznana kategoria „plotka"/);

      const summary = summarizeMonitorSources(registry.sources);
      assert.equal(summary.entries, 5);
      assert.equal(summary.enabledEntries, 4);
      assert.equal(summary.hosts, 4);
      assert.equal(summary.communities, 4);
      assert.deepEqual(summary.byEngine, { discourse: 1, lemmy: 1, 'mastodon-tag': 1, reddit: 1 });
      assert.deepEqual(summary.byLanguage, { nieokreślony: 3, pl: 1 });
      assert.equal(summary.relevantEntries, 4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('trzy liczby: hosty, społeczności, wpisy — Reddit i Telegram to jeden host, wiele społeczności', () => {
    const sources: MonitorSourceConfig[] = [
      { id: 'a', engine: 'reddit', label: 'a', sub: 'Bitcoin' },
      { id: 'b', engine: 'reddit', label: 'b', sub: 'ethereum' },
      { id: 'c', engine: 'telegram', label: 'c', channel: 'kanal_a' },
      { id: 'd', engine: 'telegram', label: 'd', channel: 'kanal_b' },
      { id: 'e', engine: 'html-list', label: 'e', url: 'https://forum.example/board=1', selectors: { item: 'tr', link: 'a' } },
      { id: 'f', engine: 'rss', label: 'f', url: 'https://www.forum.example/feed' },
      { id: 'g', engine: 'lemmy', label: 'g', instance: 'lemmy.example', community: 'btc' },
      { id: 'h', engine: 'lemmy', label: 'h', instance: 'lemmy.example', community: 'eth' },
      { id: 'i', engine: 'mastodon-tag', label: 'i', instance: 'm.example', tag: 'btc' },
      { id: 'j', engine: 'mastodon-tag', label: 'j', instance: 'm.example', tag: 'eth' },
      { id: 'k', engine: 'stackexchange', label: 'k', site: 'bitcoin', enabled: false },
    ];
    const summary = summarizeMonitorSources(sources);
    assert.equal(summary.entries, 11);
    assert.equal(summary.enabledEntries, 10);
    // reddit.com, t.me, forum.example, lemmy.example, m.example
    assert.equal(summary.hosts, 5);
    // 2 subreddity + 2 kanały + forum + 2 społeczności Lemmy + instancja Mastodona
    assert.equal(summary.communities, 8);
    assert.deepEqual([summary.relevantEntries, summary.relevantHosts, summary.relevantCommunities], [10, 5, 8]);

    // Po odjęciu wpisów oznaczonych jako mało trafne (zapis z polskimi znakami albo bez).
    const marked = sources.map((source) =>
      source.id === 'i' || source.id === 'j'
        ? { ...source, note: 'Niska trafność: ogólny strumień federowanego hashtagu.' }
        : source.id === 'b'
          ? { ...source, note: 'nizsza trafnosc — subreddit ogólny' }
          : source,
    );
    const filtered = summarizeMonitorSources(marked);
    assert.deepEqual([filtered.enabledEntries, filtered.hosts, filtered.communities], [10, 5, 8]);
    assert.deepEqual([filtered.relevantEntries, filtered.relevantHosts, filtered.relevantCommunities], [7, 4, 6]);
  });

  test('rejestr z repozytorium wczytuje się bez błędnych wpisów w core.json; łączniki mon-* są domyślnie wyłączone', () => {
    const registry = loadMonitorSources();
    assert.ok(registry.files.includes('core.json'));
    assert.ok(registry.sources.length >= 10);
    assert.deepEqual(registry.warnings.filter((warning) => warning.startsWith('core.json')), []);
    assert.equal(mergeMonitorSources([{ file: 'x', entries: registry.sources }]).warnings.length, 0);

    const connectors = createConnectors({ enableLive: true, minRequestIntervalMs: 0 });
    const monitors = listMonitorConnectors(connectors);
    assert.equal(monitors.length, registry.sources.filter((source) => source.enabled !== false).length);
    for (const connector of monitors) {
      assert.match(connector.id, /^mon-/);
      assert.equal(connector.enabledByDefault, false);
      assert.ok(connector.description.length > 60);
      assert.ok(connector.requestHost.length > 0);
    }
    assert.equal(new Set(connectors.map((connector) => connector.id)).size, connectors.length);
    assert.deepEqual(listMonitorConnectors(createConnectors({ enableLive: true, monitorSources: [] })), []);
    assert.deepEqual(listMonitorConnectors(createConnectors({ sandboxUrl: 'http://127.0.0.1:9' })), []);
  });
});

// ---------- Przebieg ----------

describe('przebieg monitoringu', () => {
  const reddit = (sub: string): MonitorSourceConfig => ({ id: `r-${sub}`, engine: 'reddit', label: `r/${sub}`, sub });
  const feed = (id: string, host: string): MonitorSourceConfig => ({ id, engine: 'rss', label: id, url: `https://${host}/feed/${id}` });

  test('kolejka na host; odmowa hosta kończy jego kolejkę, Reddit przechodzi na host zapasowy', async () => {
    const { connectors, calls } = setup([reddit('aaa'), reddit('bbb'), reddit('ccc'), feed('f1', 'jeden.example'), feed('f2', 'jeden.example'), feed('f3', 'dwa.example'), feed('f4', 'trzy.example')], {
      'https://www.reddit.com/r/aaa/new/.rss': { status: 429 },
      'https://old.reddit.com/r/aaa/new/.rss': { body: ATOM, type: 'application/atom+xml' },
      'https://old.reddit.com/r/bbb/new/.rss': { body: ATOM, type: 'application/atom+xml' },
      'https://old.reddit.com/r/ccc/new/.rss': { status: 429 },
      'https://jeden.example/feed/f1': { status: 403 },
      'https://jeden.example/feed/f2': { body: RSS, type: 'text/xml' },
      'https://dwa.example/feed/f3': { body: RSS, type: 'text/xml' },
      'https://trzy.example/feed/f4': { body: '<rss><channel></channel></rss>', type: 'text/xml' },
    });
    const seen: string[] = [];
    const pass = await runMonitorPass(connectors, { limit: 10, concurrency: 2, onResult: (result) => void seen.push(result.source.id) });
    const status = Object.fromEntries(pass.results.map((result) => [result.source.id, result.status]));
    assert.deepEqual(status, {
      'r-aaa': 'ok',
      'r-bbb': 'ok',
      'r-ccc': 'refused',
      f1: 'refused',
      f2: 'skipped_refused_host',
      f3: 'ok',
      f4: 'empty',
    });
    assert.equal(seen.length, 7);
    // Po 429 na www.reddit.com kolejne subreddity nie pytają już tego hosta.
    assert.equal(calls.filter((call) => call.url.startsWith('https://www.reddit.com/')).length, 1);
    assert.equal(calls.filter((call) => call.url.startsWith('https://jeden.example/')).length, 1);
    assert.deepEqual([...pass.refusedHosts].sort(), ['jeden.example', 'old.reddit.com', 'www.reddit.com']);
    assert.equal(pass.results.find((result) => result.source.id === 'f3')!.documents.length, 3);
    assert.equal(pass.results.find((result) => result.source.id === 'f2')!.requests, 0);
    assert.ok(pass.results.every((result) => result.requests <= 2));
  });

  test('budżet czasu: po jego upływie reszta źródeł jest pomijana', async () => {
    const slow: Fetcher = async (_url, init) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 80);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('przerwano', 'AbortError'));
        });
      });
      return new Response(RSS, { status: 200, headers: { 'content-type': 'text/xml' } });
    };
    const connectors = createConnectors({
      enableLive: true,
      fetcher: slow,
      minRequestIntervalMs: 0,
      monitorSources: ['a', 'b', 'c', 'd', 'e'].map((id) => feed(id, 'wolny.example')),
    });
    const pass = await runMonitorPass(connectors, { budgetMs: 200, concurrency: 1 });
    const statuses = pass.results.map((result) => result.status);
    assert.equal(statuses.length, 5);
    assert.equal(statuses[0], 'ok');
    assert.ok(statuses.filter((status) => status === 'skipped_budget').length >= 2, statuses.join(','));
    assert.ok(pass.durationMs < 1500);
  });
});
