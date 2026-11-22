// Głębokie wyszukiwanie, wyszukiwarka GitHuba, serwisy wiedzy o adresach i normalizacja
// zapisu adresów — na zapisanych przykładowych odpowiedziach (dane fikcyjne), bez internetu.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { IdentifierType, SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import type { Fetcher } from '../src/http.ts';
import { addressFromHref, createConnectors, deepTargets, findEnsNames, htmlToText, mergeMonitorSources, normalizeAddressText } from '../src/index.ts';
import type { MonitorSourceConfig, SourcesConfig } from '../src/index.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
  delayMs?: number;
}

function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string>; startedAt: number; finishedAt: number }[] = [];
  let active = 0;
  let peak = 0;
  const fetcher: Fetcher = async (url, init) => {
    const call = { url, headers: init.headers, startedAt: Date.now(), finishedAt: 0 };
    calls.push(call);
    active += 1;
    peak = Math.max(peak, active);
    try {
      const route = routes[url];
      if (route?.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, route.delayMs);
          init.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new DOMException('przerwano', 'TimeoutError'));
          });
        });
      }
      if (!route) return new Response('{"errors":["nie ma"]}', { status: 404, headers: { 'content-type': 'application/json' } });
      const isJson = typeof route.body === 'object';
      return new Response(isJson ? JSON.stringify(route.body) : ((route.body ?? '') as string), {
        status: route.status ?? 200,
        headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8') },
      });
    } finally {
      active -= 1;
      call.finishedAt = Date.now();
    }
  };
  return { fetcher, calls, peak: () => peak };
}

function setup(sources: MonitorSourceConfig[], routes: Record<string, Route>, extra: Partial<SourcesConfig> = {}) {
  const mock = mockFetch(routes);
  const connectors = createConnectors({ enableLive: true, fetcher: mock.fetcher, minRequestIntervalMs: 0, allowPrivateHosts: true, monitorSources: sources, ...extra });
  const logs: string[] = [];
  const run = (id: string, type: IdentifierType, value: string): Promise<SourceDocument[]> =>
    connectors.find((connector) => connector.id === id)!.search({ type, value }, { log: (message) => void logs.push(message) });
  return { ...mock, connectors, logs, run };
}

const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);
const by = (documents: SourceDocument[], service: string) => documents.filter((document) => document.service === service);

// ---------- Normalizacja zapisu adresów ----------

describe('adresy w nietypowych zapisach', () => {
  const btc = ADDR.kacperBtc;
  const eth = ADDR.kacperEth;
  const tron = ADDR.hubertTron;
  const found = (text: string) => extractAddresses(normalizeAddressText(text)).map((item) => item.address);

  test('adres rozbity odstępami, łamaniem wiersza i znakami niewidocznymi', () => {
    assert.deepEqual(found(`Wpłaty: ${btc.slice(0, 8)} ${btc.slice(8, 20)}\n${btc.slice(20)} — dzięki`), [btc]);
    assert.deepEqual(found(`ETH (${eth.slice(0, 10)} ${eth.slice(10, 26)} ${eth.slice(26)}).`), [eth]);
    assert.deepEqual(found(`${tron.slice(0, 5)}​${tron.slice(5, 17)}­${tron.slice(17)}`), [tron]);
    assert.equal(normalizeAddressText(`a ${btc.slice(0, 8)} ${btc.slice(8)}, b`), `a ${btc}, b`);
    // Pusty wiersz rozdziela akapity — przez niego nie sklejamy; zwykły tekst zostaje bez zmian.
    assert.deepEqual(found(`${btc.slice(0, 8)}\n\n${btc.slice(8)}`), []);
    const prose = 'Sprzedam 1000 sztuk po 3500 zł, tel. 500 000 201. Kod 0xdead beef, numer 1234 5678 9012 3456.';
    assert.equal(normalizeAddressText(prose), prose);
  });

  test('encje HTML, odnośniki płatności i odnośniki do eksploratorów bloków', () => {
    const entities = [...btc].map((char) => `&#${char.codePointAt(0)};`).join('');
    assert.deepEqual(found(`adres ${entities}`), [btc]);
    assert.deepEqual(found(`bitcoin:${btc}?amount=0.1`), [btc]);
    assert.equal(addressFromHref(`bitcoin:${btc}?amount=0.1&label=x`), btc);
    assert.equal(addressFromHref(`ethereum:${eth}@1`), eth);
    assert.equal(addressFromHref(`https://etherscan.io/address/${eth}#code`), eth);
    assert.equal(addressFromHref(`https://blockchair.com/bitcoin/address/${btc}`), btc);
    assert.equal(addressFromHref(`https://tronscan.org/#/address/${tron}`), tron);
    assert.equal(addressFromHref(`https://mempool.space/pl/address/${btc}`), btc);
    assert.equal(addressFromHref(`https://blockstream.info/address/${btc}`), btc);
    assert.equal(addressFromHref(`https://sklep.example/address/${btc}`), null);
    assert.equal(addressFromHref(`https://etherscan.io/address/0x1234`), null);
    assert.equal(addressFromHref('mailto:ktos@poczta.example'), null);
  });

  test('Litecoin i Solana: odnośniki płatności, eksploratory i sklejanie rozbitego adresu', () => {
    const ltc = 'LbNzkvEjayzxfvfJMXcDnVboRL3QmyorVR';
    const ltcBech = 'ltc1q0yws8mlw9pkhyu5e99232u50tfs8t5pm6gj8g3';
    const sol = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    assert.equal(addressFromHref(`litecoin:${ltc}?amount=1`), ltc);
    assert.equal(addressFromHref(`https://litecoinspace.org/address/${ltcBech}`), ltcBech);
    assert.deepEqual(found(`LTC: ${ltc.slice(0, 9)} ${ltc.slice(9)}`), [ltc]);
    assert.deepEqual(found(`${ltcBech.slice(0, 12)} ${ltcBech.slice(12)}`), [ltcBech]);
    // Solana z odnośnika: tekst dostaje słowo wskazujące sieć, więc adres jest przyjmowany.
    assert.equal(addressFromHref(`solana:${sol}?amount=1`), sol);
    assert.equal(addressFromHref(`https://solscan.io/account/${sol}`), sol);
    assert.deepEqual(found(`Wpłać: <solana:${sol}?amount=1>`.replace(/[<>]/g, ' ')), [sol]);
    assert.deepEqual(extractAddresses(htmlToText(`<a href="https://explorer.solana.com/address/${sol}">wesprzyj</a>`)).map((item) => item.network), ['solana']);
    // Adres Solana nie powstaje ze sklejenia słów — ten format nie ma sumy kontrolnej.
    // (początek „T…” wygląda jak adres Tron, więc normalizacja próbuje sklejać — i nie może przyjąć wyniku Solana).
    const solT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    assert.equal(normalizeAddressText(`SOL ${solT.slice(0, 20)} ${solT.slice(20)}`), `SOL ${solT.slice(0, 20)} ${solT.slice(20)}`);
  });

  test('htmlToText zachowuje adres z atrybutu href, gdy widoczny napis go nie zawiera', () => {
    const html = `<p>Wesprzyj: <a href="bitcoin:${btc}?amount=0.01">kliknij tutaj</a> albo <a class="x" href='https://etherscan.io/address/${eth}'>portfel ETH</a>,
      <a href="https://example.org/">zwykły odnośnik</a></p>`;
    const text = htmlToText(html);
    assert.deepEqual(extractAddresses(text).map((item) => item.address).sort(), [btc, eth].sort());
    assert.match(text, /kliknij tutaj/);
    assert.doesNotMatch(text, /example\.org/);
    // Adres rozbity znacznikami formatowania i <wbr> skleja się już w htmlToText; rozbity elementami — w normalizacji.
    assert.deepEqual(found(htmlToText(`<p>${btc.slice(0, 10)}<wbr>${btc.slice(10, 20)}<b>${btc.slice(20)}</b></p>`)), [btc]);
    assert.deepEqual(found(htmlToText(`<p><span>${eth.slice(0, 12)}</span><span>${eth.slice(12)}</span></p>`)), [eth]);
  });

  test('nazwy ENS w treści', () => {
    assert.deepEqual(findEnsNames('Pisz na kacper.eth albo Pay.Kacper.ETH; nie: plik.ethereum, ktos@poczta.eth, https://x.example/a.eth'), ['kacper.eth', 'pay.kacper.eth']);
    assert.deepEqual(findEnsNames('bez nazw'), []);
  });
});

// ---------- Rejestr: nadpisania ----------

describe('rejestr: nadpisania wpisów z innych plików', () => {
  test('core.json wyłącza cudzy wpis po id, nie stając się źródłem; nieznane id daje ostrzeżenie', () => {
    const merged = mergeMonitorSources([
      {
        file: 'core.json',
        entries: [
          { id: 'forum-b', override: true, enabled: false, note: 'HTTP 403' },
          { id: 'nie-ma-takiego', override: true, enabled: false },
          { override: true, enabled: false },
        ],
      },
      {
        file: 'badacz.json',
        entries: [
          { id: 'forum-a', engine: 'discourse', label: 'A', url: 'https://a.example' },
          { id: 'Forum-B', engine: 'discourse', label: 'B', url: 'https://b.example', note: 'sprawdzone' },
        ],
      },
    ]);
    assert.deepEqual(merged.sources.map((source) => [source.id, source.enabled !== false, source.note]), [
      ['forum-a', true, undefined],
      ['Forum-B', false, 'HTTP 403'],
    ]);
    assert.equal(merged.warnings.length, 2);
    assert.match(merged.warnings.join('\n'), /nie-ma-takiego.*nie ma wpisu/);
    assert.match(merged.warnings.join('\n'), /nadpisanie bez pola „id"/);
  });
});

// ---------- Głębokie wyszukiwanie ----------

const REGISTRY: MonitorSourceConfig[] = [
  { id: 'd-pl', engine: 'discourse', label: 'Forum PL', url: 'https://forum-pl.example', language: 'pl' },
  { id: 'd-en', engine: 'discourse', label: 'Forum EN', url: 'https://forum-en.example/' },
  { id: 'd-en-2', engine: 'rss', label: 'ten sam host jako RSS', url: 'https://forum-en.example/latest.rss' },
  { id: 'd-off', engine: 'discourse', label: 'wyłączone', url: 'https://off.example', enabled: false },
  { id: 'l-1', engine: 'lemmy', label: 'Lemmy a', instance: 'lemmy.example', community: 'bitcoin' },
  { id: 'l-2', engine: 'lemmy', label: 'Lemmy b', instance: 'lemmy.example', community: 'krypto' },
  { id: 'm-1', engine: 'mastodon-tag', label: 'Masto', instance: 'masto.example', tag: 'bitcoin' },
  { id: 'se-1', engine: 'stackexchange', label: 'Bitcoin SE', site: 'bitcoin' },
  { id: 'hn-1', engine: 'hn', label: 'HN a', query: 'btc' },
  { id: 'hn-2', engine: 'hn', label: 'HN b', query: 'eth' },
];

describe('głębokie wyszukiwanie — cele', () => {
  test('po jednym celu na host; polskie pierwsze; wyłączone i silniki bez wyszukiwarki pominięte', () => {
    const targets = deepTargets(REGISTRY);
    assert.deepEqual(targets.map((target) => `${target.kind}:${target.kind === 'stackexchange' ? target.base : target.host}`), [
      'discourse:forum-pl.example',
      'discourse:forum-en.example',
      'lemmy:lemmy.example',
      'mastodon:masto.example',
      'hn:hn.algolia.com',
      'stackexchange:bitcoin',
    ]);
    const many = Array.from({ length: 9 }, (_, index): MonitorSourceConfig => ({ id: `s${index}`, engine: 'stackexchange', label: `SE ${index}`, site: ['law', 'tor', 'ethereum', 'bitcoin', 'money', 'crypto', 'monero', 'security', 'economics'][index]! }));
    assert.deepEqual(deepTargets(many, 4).map((target) => target.base), ['bitcoin', 'ethereum', 'monero', 'crypto']);
  });
});

describe('głębokie wyszukiwanie — adres', () => {
  const address = ADDR.kacperBtc;
  const quoted = encodeURIComponent(`"${address}"`);
  const routes: Record<string, Route> = {
    [`https://forum-pl.example/search.json?q=${address}`]: {
      body: {
        posts: [
          { id: 1, username: 'kupiec', name: 'Jan Kupiec', avatar_template: '/a/{size}.png', created_at: '2026-01-02T10:00:00.000Z', blurb: `...zaliczka na ${address} dzięki...`, post_number: 4, topic_id: 9 },
          { id: 2, username: 'ofiara', name: null, created_at: '2026-02-02T10:00:00.000Z', blurb: `wysłałem na ${address.slice(0, 12)} ${address.slice(12)} i cisza`, post_number: 7, topic_id: 9 },
          { id: 3, username: 'przypadek', blurb: 'trafienie przybliżone bez adresu', post_number: 1, topic_id: 10 },
        ],
        topics: [{ id: 9, title: 'Sprzedam koparkę', slug: 'sprzedam-koparke' }],
      },
    },
    [`https://forum-en.example/search.json?q=${address}`]: { status: 429, body: { errors: ['slow down'] } },
    [`https://lemmy.example/api/v3/search?q=${address}&type_=All&listing_type=All&limit=20`]: {
      body: {
        posts: [{ post: { id: 5, name: 'Donate', body: `BTC: ${address}`, ap_id: 'https://lemmy.example/post/5', published: '2026-03-03T00:00:00Z' }, creator: { name: 'ola', actor_id: 'https://lemmy.example/u/ola', display_name: 'Ola' } }],
        comments: [
          { comment: { id: 8, content: `to oszust, adres ${address}`, ap_id: 'https://inna.example/comment/8', published: '2026-03-04T00:00:00Z' }, creator: { name: 'zdalny', actor_id: 'https://inna.example/u/zdalny' }, post: { name: 'Donate' } },
          { comment: { id: 9, content: 'bez adresu' }, creator: { name: 'x', actor_id: 'https://lemmy.example/u/x' } },
        ],
      },
    },
    [`https://api.stackexchange.com/2.3/search/excerpts?order=desc&sort=relevance&q=${address}&site=bitcoin&pagesize=10`]: {
      body: { items: [{ item_type: 'question', question_id: 100, title: 'Gdzie moje &amp; BTC?' }, { item_type: 'answer', answer_id: 200, question_id: 100, title: 'Gdzie moje &amp; BTC?' }] },
    },
    'https://api.stackexchange.com/2.3/posts/100;200?site=bitcoin&filter=withbody&pagesize=10': {
      body: {
        items: [
          { post_id: 100, post_type: 'question', body: `<p>Wysłałem na <code>${address}</code></p>`, link: 'https://bitcoin.stackexchange.com/q/100', creation_date: 1_780_000_000, owner: { display_name: 'pytający', link: 'https://bitcoin.stackexchange.com/users/1/p', location: 'Gda&#324;sk' } },
          { post_id: 200, post_type: 'answer', body: '<blockquote><p>' + address + '</p></blockquote><p>To adres giełdy.</p>', link: 'https://bitcoin.stackexchange.com/a/200', owner: { display_name: 'ekspert' } },
        ],
      },
    },
    [`https://hn.algolia.com/api/v1/search_by_date?query=${quoted}&tags=(story,comment)&hitsPerPage=30`]: {
      body: { hits: [{ objectID: '77', author: 'hn_user', created_at: '2025-05-05T00:00:00Z', story_title: 'Donations', comment_text: `<p>see <a href="https://mempool.space/address/${address}">this</a></p>` }] },
    },
  };

  test('wszystkie wyszukiwarki, wszyscy autorzy; dokładne wystąpienie adresu; błąd hosta nie przerywa', async () => {
    const { run, calls, logs } = setup(REGISTRY, routes);
    const documents = await run('deep-search', 'crypto_address', address);
    // Mastodon nie ma publicznego wyszukiwania treści — żadnego żądania; StackExchange: dwa żądania; pozostałe po jednym.
    assert.equal(calls.length, 6);
    assert.ok(!calls.some((call) => call.url.includes('masto.example') || call.url.includes('off.example')));
    assert.deepEqual(
      documents.map((document) => `${document.service}|${document.author}`).sort(),
      ['bitcoin.stackexchange.com|pytający', 'forum-pl.example|kupiec', 'forum-pl.example|ofiara', 'inna.example|zdalny@inna.example', 'lemmy.example|ola', 'news.ycombinator.com|hn_user'].sort(),
    );
    for (const document of documents) {
      assert.equal(document.connectorId, 'deep-search');
      assert.equal(document.identityMatch, 'name_only');
      assert.equal(document.matchedIdentifier.type, 'crypto_address');
      assert.equal(document.category, 'forum_post');
      assert.ok(addressesOf(document).includes(address), document.url);
      assert.equal(document.profile!.handle, document.author);
    }
    const [kupiec] = by(documents, 'forum-pl.example').filter((document) => document.author === 'kupiec');
    assert.equal(kupiec!.url, 'https://forum-pl.example/t/sprzedam-koparke/9/4');
    assert.equal(kupiec!.title, 'Sprzedam koparkę');
    assert.equal(kupiec!.publishedAt, '2026-01-02T10:00:00.000Z');
    assert.deepEqual(kupiec!.profile, { handle: 'kupiec', displayName: 'Jan Kupiec', urls: ['https://forum-pl.example/u/kupiec'], avatarUrl: 'https://forum-pl.example/a/120.png' });
    const [question] = by(documents, 'bitcoin.stackexchange.com');
    assert.equal(question!.title, 'Gdzie moje & BTC?');
    assert.equal(question!.profile!.location, 'Gdańsk');

    const journal = logs.join('\n');
    assert.match(journal, /znaleziono w Forum PL \(forum-pl\.example\) — dokumentów: 2, autorzy: kupiec, ofiara/);
    assert.match(journal, /hostów 6: odpowiedziało 4, z trafieniami 4, odmówiło 1, błędów 0, pominiętych po wyczerpaniu budżetu czasu 0; dokumentów 6, autorów 6/);
    assert.match(journal, /odmowa \(kod 429\) ×1/);
  });

  test('współbieżność z limitem, limit czasu żądania i łączny budżet czasu', async () => {
    const forums = Array.from({ length: 10 }, (_, index): MonitorSourceConfig => ({ id: `f${index}`, engine: 'discourse', label: `Forum ${index}`, url: `https://f${index}.example` }));
    const slowRoutes: Record<string, Route> = {};
    for (let index = 0; index < 10; index++) {
      slowRoutes[`https://f${index}.example/search.json?q=${address}`] = {
        delayMs: index === 3 ? 2000 : 60,
        body: { posts: [{ username: `autor${index}`, blurb: `adres ${address}`, post_number: 1, topic_id: 1 }], topics: [] },
      };
    }
    const limited = setup(forums, slowRoutes, { deepSearch: { concurrency: 3, requestTimeoutMs: 300, budgetMs: 5000 } });
    const documents = await limited.run('deep-search', 'crypto_address', address);
    assert.equal(limited.peak(), 3);
    // Host f3 przekroczył limit czasu żądania — reszta wyników jest kompletna.
    assert.equal(documents.length, 9);
    assert.ok(!documents.some((document) => document.author === 'autor3'));
    assert.match(limited.logs.join('\n'), /odpowiedziało 9, z trafieniami 9, odmówiło 0, błędów 1/);
    assert.match(limited.logs.join('\n'), /limit czasu ×1/);

    const budget = setup(forums, slowRoutes, { deepSearch: { concurrency: 1, requestTimeoutMs: 300, budgetMs: 150 } });
    const started = Date.now();
    const partial = await budget.run('deep-search', 'crypto_address', address);
    assert.ok(Date.now() - started < 1500);
    assert.ok(partial.length >= 1 && partial.length <= 3, `dokumentów ${partial.length}`);
    assert.ok(budget.calls.length <= 4);
    assert.match(budget.logs.join('\n'), /pominiętych po wyczerpaniu budżetu czasu [6-9]/);
  });
});

describe('głębokie wyszukiwanie — nick i nazwisko', () => {
  const discourseUser = { id: 5, username: 'Kupiec_GD', name: 'Jan Kupiec', avatar_template: 'https://cdn.example/{size}.png', location: 'Gdańsk', website: 'kupiec.example', bio_excerpt: 'Handluję <b>BTC</b>', created_at: '2019-09-09T00:00:00.000Z' };
  const routes: Record<string, Route> = {
    'https://forum-pl.example/u/kupiec_gd.json': { body: { user: discourseUser } },
    'https://forum-pl.example/search.json?q=%40kupiec_gd': {
      body: {
        posts: [
          { username: 'Kupiec_GD', name: 'Jan Kupiec', created_at: '2026-01-01T00:00:00.000Z', blurb: `Mój adres to ${ADDR.kacperBtc}, pay.kupiec.eth`, post_number: 2, topic_id: 3 },
          { username: 'inny', blurb: '@kupiec_gd dzięki', post_number: 3, topic_id: 3 },
        ],
        topics: [{ id: 3, title: 'Wymiana', slug: 'wymiana' }],
      },
    },
    'https://lemmy.example/api/v3/user?username=kupiec_gd&limit=20': {
      body: {
        person_view: { person: { name: 'kupiec_gd', display_name: 'Kupiec', actor_id: 'https://lemmy.example/u/kupiec_gd', bio: 'bio', published: '2023-01-01T00:00:00Z' } },
        posts: [{ post: { id: 1, name: 'Mój wpis', body: 'treść', ap_id: 'https://lemmy.example/post/1' }, creator: { name: 'kupiec_gd', actor_id: 'https://lemmy.example/u/kupiec_gd' } }],
        comments: [],
      },
    },
    'https://masto.example/api/v1/accounts/lookup?acct=kupiec_gd': {
      body: { username: 'kupiec_gd', display_name: 'Jan K.', note: `<p>BTC: ${ADDR.kacperBtc}</p>`, url: 'https://masto.example/@kupiec_gd', created_at: '2022-02-02T00:00:00.000Z', fields: [{ name: 'WWW', value: '<a href="https://kupiec.example">x</a>', verified_at: '2023-01-01T00:00:00Z' }] },
    },
    'https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&inname=kupiec_gd&site=bitcoin&pagesize=20': {
      body: { items: [{ display_name: 'kupiec_gd_fan', link: 'https://bitcoin.stackexchange.com/users/2/x' }, { display_name: 'Kupiec_GD', link: 'https://bitcoin.stackexchange.com/users/1/kupiec-gd', location: 'Gdansk', creation_date: 1_600_000_000 }] },
    },
    'https://hn.algolia.com/api/v1/search_by_date?tags=author_kupiec_gd&hitsPerPage=30': { body: { hits: [{ objectID: '5', author: 'kupiec_gd', created_at: '2024-01-01T00:00:00Z', story_title: 'T', comment_text: 'komentarz' }] } },
  };

  test('dokładna zgodność nazwy konta, profil w doc.profile, druga faza: wypowiedzi konta na forum', async () => {
    const { run, calls, logs } = setup(REGISTRY, routes);
    const documents = await run('deep-search', 'nick', '@kupiec_gd');
    // 6 hostów w pierwszej fazie (forum-en odpowiada 404) + jedno żądanie drugiej fazy na forum z kontem.
    assert.equal(calls.length, 7);
    assert.ok(documents.every((document) => document.identityMatch === 'exact_identifier'));
    const profile = documents.find((document) => document.url === 'https://forum-pl.example/u/Kupiec_GD')!;
    assert.equal(profile.category, 'own_profile');
    assert.deepEqual(profile.profile, {
      handle: 'Kupiec_GD',
      displayName: 'Jan Kupiec',
      urls: ['https://forum-pl.example/u/Kupiec_GD', 'https://kupiec.example/'],
      location: 'Gdańsk',
      avatarUrl: 'https://cdn.example/120.png',
      bio: 'Handluję BTC',
      createdAt: '2019-09-09T00:00:00.000Z',
    });
    assert.deepEqual(profile.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kupiec.example/' }]);
    const post = documents.find((document) => document.url === 'https://forum-pl.example/t/wymiana/3/2')!;
    assert.deepEqual(addressesOf(post), [ADDR.kacperBtc]);
    assert.deepEqual(post.discoveredIdentifiers, [{ type: 'ens_name', value: 'pay.kupiec.eth' }]);
    assert.ok(!documents.some((document) => document.author === 'inny' || document.author === 'kupiec_gd_fan'));
    assert.deepEqual(
      [...new Set(documents.map((document) => document.service))].sort(),
      ['bitcoin.stackexchange.com', 'forum-pl.example', 'lemmy.example', 'masto.example', 'news.ycombinator.com'],
    );
    const masto = by(documents, 'masto.example')[0]!;
    assert.deepEqual(addressesOf(masto), [ADDR.kacperBtc]);
    assert.equal(masto.profile!.displayName, 'Jan K.');
    assert.equal(by(documents, 'lemmy.example').length, 2);
    assert.equal(by(documents, 'bitcoin.stackexchange.com')[0]!.profile!.location, 'Gdansk');
    assert.match(logs.join('\n'), /wypowiedzi konta „kupiec_gd" na forum forum-pl\.example — dokumentów: 1/);
  });

  test('imię i nazwisko: tylko konta o dokładnie takiej nazwie, powiązanie słabe', async () => {
    const { run } = setup(REGISTRY, {
      'https://forum-pl.example/search.json?q=%22Jan%20Kupiec%22': { body: { posts: [], users: [discourseUser, { username: 'jk2', name: 'Jan Kupiecki' }] } },
      'https://masto.example/api/v2/search?q=Jan%20Kupiec&type=accounts&limit=5': { body: { accounts: [{ username: 'jan', display_name: 'JAN KUPIEC', url: 'https://masto.example/@jan' }, { username: 'jk', display_name: 'Jan Kupiec Fan' }] } },
      'https://api.stackexchange.com/2.3/users?order=desc&sort=reputation&inname=Jan%20Kupiec&site=bitcoin&pagesize=20': { body: { items: [] } },
    });
    const documents = await run('deep-search', 'full_name', 'Jan Kupiec');
    assert.deepEqual(documents.map((document) => `${document.service}|${document.author}`).sort(), ['forum-pl.example|Kupiec_GD', 'masto.example|jan']);
    assert.ok(documents.every((document) => document.identityMatch === 'name_only' && document.category === 'own_profile'));
  });

  test('pusty rejestr i zbyt krótka fraza: żadnego żądania', async () => {
    const empty = setup([], {});
    assert.deepEqual(await empty.run('deep-search', 'nick', 'ktokolwiek'), []);
    assert.match(empty.logs.join('\n'), /rejestr źródeł jest pusty/);
    const short = setup(REGISTRY, {});
    assert.deepEqual(await short.run('deep-search', 'nick', 'ab'), []);
    assert.equal(empty.calls.length + short.calls.length, 0);
    const deep = short.connectors.find((connector) => connector.id === 'deep-search')!;
    assert.equal(deep.enabledByDefault, false);
    assert.deepEqual(deep.accepts, ['nick', 'login', 'email', 'crypto_address', 'full_name', 'ens_name']);
  });
});

// ---------- GitHub: wyszukiwanie w treści ----------

describe('GitHub — wyszukiwanie w treści', () => {
  const address = ADDR.kacperBtc;
  const q = encodeURIComponent(`"${address}"`);
  const API = 'https://api.github.com';
  const owner = (login: string) => ({ login, avatar_url: `https://cdn.example/${login}.png`, html_url: `https://github.com/${login}` });
  const codeItem = (login: string, repo: string, path: string, fragment: string, fork = false) => ({
    name: path.split('/').at(-1),
    path,
    html_url: `https://github.com/${login}/${repo}/blob/main/${path}`,
    repository: { name: repo, full_name: `${login}/${repo}`, owner: owner(login), fork },
    text_matches: [{ fragment }],
  });

  test('adres: kod (fragmenty), zgłoszenia i commity — trzy zapytania, wszyscy autorzy', async () => {
    const { run, calls } = setup(
      [],
      {
        [`${API}/search/code?q=${q}&per_page=30`]: {
          body: {
            items: [
              codeItem('kacper-gh', 'kacper-gh', 'README.md', `## Wesprzyj\nBTC: ${address}`),
              codeItem('kacper-gh', 'wentyl', '.github/FUNDING.yml', `custom: ["${address}"]`),
              codeItem('lista-oszustw', 'baza', 'data/addresses.csv', `scam,${address},2025`),
              codeItem('kopia', 'kopia', 'README.md', `BTC: ${address}`, true),
              codeItem('bez-fragmentu', 'x', 'a.txt', 'fragment bez adresu'),
            ],
          },
        },
        [`${API}/search/issues?q=${q}&per_page=30`]: {
          body: { items: [{ html_url: 'https://github.com/a/b/issues/7', title: 'Zwrot', body: `${'x'.repeat(2000)} proszę o zwrot na ${address} dziękuję`, created_at: '2026-01-01T00:00:00Z', user: owner('klient1') }] },
        },
        [`${API}/search/commits?q=${q}&per_page=30`]: {
          body: { items: [{ html_url: 'https://github.com/a/b/commit/abc', commit: { message: `Add donation address ${address}`, author: { name: 'Kacper T', email: 'k@poczta.example', date: '2025-06-06T00:00:00Z' } }, author: owner('kacper-gh'), repository: { full_name: 'a/b' } }] },
        },
      },
      { githubToken: 'ghp_tajny' },
    );
    const documents = await run('live-github-search', 'crypto_address', address);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.headers.Authorization === 'Bearer ghp_tajny' && new URL(call.url).host === 'api.github.com'));
    assert.equal(calls[0]!.headers.Accept, 'application/vnd.github.text-match+json');
    assert.deepEqual(
      documents.map((document) => [document.author, document.category]),
      [
        ['kacper-gh', 'own_profile'],
        ['kacper-gh', 'own_profile'],
        ['lista-oszustw', 'forum_post'],
        ['kopia', 'forum_post'],
        ['klient1', 'forum_post'],
        ['kacper-gh', 'forum_post'],
      ],
    );
    for (const document of documents) {
      assert.equal(document.service, 'github.com');
      assert.equal(document.identityMatch, 'name_only');
      assert.deepEqual(addressesOf(document), [address]);
      assert.equal(document.profile!.handle, document.author);
    }
    assert.ok(documents[4]!.text.length < 1400);
    assert.equal(documents[5]!.publishedAt, '2025-06-06T00:00:00Z');
  });

  test('adres: README zwykłego repozytorium (przykład użycia) to wypowiedź, nie profil właściciela', async () => {
    const { run } = setup(
      [],
      {
        [`${API}/search/code?q=${q}&per_page=30`]: {
          body: {
            items: [
              codeItem('biblioteka-eth', 'sdk', 'README.md', `const balance = await getBalance("${address}")`),
              codeItem('autor', 'narzedzie', 'docs/SUPPORT.md', `BTC: ${address}`),
              codeItem('autor', 'narzedzie', 'DONATE.md', `BTC: ${address}`),
            ],
          },
        },
        [`${API}/search/issues?q=${q}&per_page=30`]: { body: { items: [] } },
        [`${API}/search/commits?q=${q}&per_page=30`]: { body: { items: [] } },
      },
      { githubToken: 'ghp_tajny' },
    );
    const documents = await run('live-github-search', 'crypto_address', address);
    assert.deepEqual(
      documents.map((document) => [document.author, document.url.split('/').at(-1), document.category]),
      [
        ['biblioteka-eth', 'README.md', 'forum_post'],
        ['autor', 'SUPPORT.md', 'own_profile'],
        ['autor', 'DONATE.md', 'own_profile'],
      ],
    );
  });

  test('e-mail: autor commitów i konto z publicznym adresem; nick: dokładny login', async () => {
    const email = 'kacper@poczta.example';
    const commit = (login: string | null, name: string, mail: string) => ({ html_url: 'https://github.com/a/b/commit/1', commit: { message: 'x', author: { name, email: mail, date: '2026-02-02T00:00:00Z' } }, author: login ? owner(login) : null, repository: { full_name: 'a/b' } });
    const { run, calls } = setup(
      [],
      {
        [`${API}/search/commits?q=${encodeURIComponent(`author-email:${email}`)}&sort=author-date&order=desc&per_page=30`]: { body: { items: [commit('kacper-gh', 'Kacper Testowy', email), commit('kacper-gh', 'Kacper Testowy', 'Kacper@Poczta.example'), commit('obcy', 'Obcy', 'inny@poczta.example')] } },
        [`${API}/search/users?q=${encodeURIComponent(`${email} in:email`)}&per_page=5`]: { body: { items: [owner('kacper-gh')] } },
        [`${API}/search/users?q=${encodeURIComponent('kacper-gh in:login')}&per_page=10`]: { body: { items: [owner('kacper-gh-bot'), owner('Kacper-GH')] } },
      },
      { githubToken: 'ghp_tajny' },
    );
    const byEmail = await run('live-github-search', 'email', ' Kacper@Poczta.example ');
    assert.equal(calls.length, 2);
    assert.equal(byEmail.length, 1);
    assert.equal(byEmail[0]!.author, 'kacper-gh');
    assert.equal(byEmail[0]!.identityMatch, 'exact_identifier');
    assert.deepEqual(byEmail[0]!.profile, { handle: 'kacper-gh', urls: ['https://github.com/kacper-gh'], avatarUrl: 'https://cdn.example/kacper-gh.png', displayName: 'Kacper Testowy', emails: [email] });
    assert.match(byEmail[0]!.text, /Liczba commitów w wynikach: 2/);
    const byNick = await run('live-github-search', 'nick', 'kacper-gh');
    assert.deepEqual(byNick.map((document) => document.author), ['Kacper-GH']);
  });

  test('bez tokenu żadnego żądania; 403, 422 i 429 kończą pustym wynikiem z wpisem w dzienniku', async () => {
    const without = setup([], {});
    assert.deepEqual(await without.run('live-github-search', 'crypto_address', address), []);
    assert.equal(without.calls.length, 0);
    assert.match(without.logs.join('\n'), /ustaw GITHUB_TOKEN/);
    assert.equal(without.connectors.find((connector) => connector.id === 'live-github-search')!.enabledByDefault, false);
    for (const status of [403, 429]) {
      const refused = setup([], { [`${API}/search/code?q=${q}&per_page=30`]: { status, body: { message: 'rate limit' } } }, { githubToken: 't' });
      assert.deepEqual(await refused.run('live-github-search', 'crypto_address', address), []);
      // Po odmowie kolejne zapytania nie są wysyłane.
      assert.equal(refused.calls.length, 1);
      assert.match(refused.logs.join('\n'), new RegExp(`kod ${status}`));
    }
    const invalid = setup([], { [`${API}/search/code?q=${q}&per_page=30`]: { status: 422, body: { message: 'Validation Failed' } } }, { githubToken: 't' });
    assert.deepEqual(await invalid.run('live-github-search', 'crypto_address', address), []);
    assert.match(invalid.logs.join('\n'), /kod 422/);
    assert.equal(invalid.connectors.find((connector) => connector.id === 'live-github-search')!.enabledByDefault, true);
  });
});

// ---------- Serwisy wiedzy o adresach ----------

describe('serwisy wiedzy o adresach Bitcoin', () => {
  const address = ADDR.kacperBtc;
  const walletPage = (name: string) => `<!DOCTYPE html><html><title>${address} [WalletExplorer.com]</title>
    <h2>Address ${address}<div class="walletnote">part of wallet <span class="wallet_renamer_item" data-wallet-id="00aa"><a href="/wallet/${encodeURIComponent(name)}"><span class="wallet_color"></span><span class="wallet_name">${name}</span></a></span></div></h2></html>`;

  test('WalletExplorer: portfel nazwany daje dokument z nazwą jako kandydatem na właściciela; bez nazwy — nic', async () => {
    const named = setup([], { [`https://www.walletexplorer.com/address/${address}`]: { body: walletPage('Bursztyn.example') } });
    const [document] = await named.run('live-walletexplorer', 'crypto_address', address);
    assert.equal(document!.author, 'Bursztyn.example');
    assert.equal(document!.service, 'walletexplorer.com');
    assert.equal(document!.identityMatch, 'name_only');
    assert.deepEqual(addressesOf(document!), [address]);
    assert.deepEqual(document!.profile, { handle: 'Bursztyn.example', urls: ['https://www.walletexplorer.com/wallet/Bursztyn.example'] });

    const unnamed = setup([], { [`https://www.walletexplorer.com/address/${address}`]: { body: walletPage('[022c1bcdb3]') } });
    assert.deepEqual(await unnamed.run('live-walletexplorer', 'crypto_address', address), []);
    assert.match(unnamed.logs.join('\n'), /portfel bez nazwy/);
    // Adresy innych sieci nie są wysyłane.
    assert.deepEqual(await unnamed.run('live-walletexplorer', 'crypto_address', ADDR.kacperEth), []);
    assert.equal(unnamed.calls.length, 1);
  });

  test('BitcoinWhosWho: ostrzeżenie o oszustwach i strony z wystąpieniami adresu; dokument bez autora', async () => {
    const page = (alert: string, rows: string) => `<html><body><h3 class="page-header"> BITCOIN ADDRESS REPORT
      <span class="top_scam_alert" id="top_scam_alert_green"${alert === 'None' ? '' : ' style="display: none;"'}>Scam Alert: None</span>
      <span class="top_scam_alert" id="top_scam_alert_red"${alert === 'None' ? ' style="display: none;"' : ''}>${alert === 'None' ? '' : alert}</span></h3>
      <div class="collapse" id="url_bitcoin_found_table">
        <div class="row bootstrap_grid_header"><div class="col-md-1">Date Found</div><div class="col-md-2">Description</div><div class="col-md-5">Website URL</div></div>
        ${rows}
      </div></body></html>`;
    const row = (date: string, description: string, url: string) =>
      `<div class="row row_even"><div class="col-md-1">${date}</div><div class="col-md-2">${description}</div><div class="col-md-2"></div><div class="col-md-5"><a href="${url}">${url}</a></div></div>`;
    const url = `https://www.bitcoinwhoswho.com/address/${address}`;
    const seen = setup([], { [url]: { body: page('None', row('28 Oct 22', 'Wesprzyj projekt', 'https://projekt.example/donate') + row('01 Jan 23', '', 'https://forum.example/t/1')) } });
    const [document] = await seen.run('live-bitcoinwhoswho', 'crypto_address', address);
    assert.equal(document!.author, undefined);
    assert.equal(document!.service, 'bitcoinwhoswho.com');
    assert.match(document!.text, /Ostrzeżenie o oszustwach: Scam Alert: None/);
    assert.match(document!.text, /- 28 Oct 22: https:\/\/projekt\.example\/donate — Wesprzyj projekt/);
    assert.match(document!.text, /- 01 Jan 23: https:\/\/forum\.example\/t\/1/);
    assert.deepEqual(addressesOf(document!), [address]);

    const flagged = setup([], { [url]: { body: page('Scam Alert: 3 reports', '') } });
    assert.match((await flagged.run('live-bitcoinwhoswho', 'crypto_address', address))[0]!.text, /Scam Alert: 3 reports/);
    const nothing = setup([], { [url]: { body: page('None', '') } });
    assert.deepEqual(await nothing.run('live-bitcoinwhoswho', 'crypto_address', address), []);
    const blocked = setup([], { [url]: { status: 403 } });
    assert.deepEqual(await blocked.run('live-bitcoinwhoswho', 'crypto_address', address), []);
    assert.match(blocked.logs.join('\n'), /kod 403/);
  });

  test('archiwalne kopie profilu Twitter/X o nazwie równej nickowi', async () => {
    const cdx = `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original&filter=statuscode:200&collapse=digest&limit=200&url=${encodeURIComponent('twitter.com/kacper_tw')}`;
    const { run, calls } = setup([], {
      [cdx]: { body: [['timestamp', 'original'], ['20200101000000', 'https://twitter.com/kacper_tw']] },
      'https://web.archive.org/web/20200101000000id_/https://twitter.com/kacper_tw': { body: `<html><body><p class="bio">Programista. BTC: ${ADDR.kacperBtc}</p></body></html>` },
    });
    const [document] = await run('live-wayback-twitter', 'nick', '@kacper_tw');
    assert.equal(calls.length, 2);
    assert.equal(document!.connectorId, 'live-wayback-twitter');
    assert.equal(document!.service, 'twitter.com');
    assert.equal(document!.author, 'kacper_tw');
    assert.equal(document!.archivedAt, '2020-01-01T00:00:00Z');
    assert.deepEqual(document!.matchedIdentifier, { type: 'nick', value: '@kacper_tw' });
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.deepEqual(await run('live-wayback-twitter', 'nick', 'za-dlugi-albo-zly-nick'), []);
  });
});
