// Imię i nazwisko jako jedyny trop: kandydaci nicków i domen, wyszukiwarki kont (GitHub, Mastodon, Bluesky)
// oraz domeny osobiste. `fetch` i DNS są atrapami — żadnych połączeń z internetem. Dane fikcyjne.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import type { Fetcher } from '../src/http.ts';
import { createConnectors } from '../src/index.ts';
import type { SourcesConfig } from '../src/index.ts';
import {
  CONNECTOR_STOP_PREFIX,
  DOMAIN_CANDIDATE_REASON,
  NAME_DOMAINS_ID,
  NAME_SEARCH_REASON,
  displayNameMatch,
  domainCandidates,
  foldName,
  nickCandidates,
  textContainsName,
} from '../src/name-candidates.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
}

function setup(routes: Record<string, Route>, config: Partial<SourcesConfig> = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object';
    return new Response(isJson ? JSON.stringify(route.body) : (route.body as string), {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8') },
    });
  };
  const logs: string[] = [];
  const connectors = createConnectors({ enableLive: true, fetcher, minRequestIntervalMs: 0, allowPrivateHosts: true, fediverseInstances: ['mastodon.example', 'drugi.example'], monitorSources: [], nostrRelays: [], ...config });
  const run = (id: string, type: IdentifierType, value: string): Promise<SourceDocument[]> => {
    const connector = connectors.find((item) => item.id === id) as SourceConnector;
    assert.ok(connector, `brak łącznika ${id}`);
    assert.ok(connector.accepts.includes(type), `${id} nie przyjmuje ${type}`);
    return connector.search({ type, value }, { log: (message) => void logs.push(message) });
  };
  return { calls, logs, run };
}

describe('kandydaci z imienia i nazwiska', () => {
  test('nicki: typowe polskie wzorce, bez znaków diakrytycznych, najwyżej 8, stała kolejność', () => {
    assert.deepEqual(nickCandidates('Jan Kowalski'), ['jankowalski', 'jan.kowalski', 'jan_kowalski', 'jan-kowalski', 'jkowalski', 'kowalskijan', 'kowalskij', 'kowalski.jan']);
    assert.deepEqual(nickCandidates('Łukasz Żółć').slice(0, 5), ['lukaszzolc', 'lukasz.zolc', 'lukasz_zolc', 'lukasz-zolc', 'lzolc']);
    assert.ok(nickCandidates('Tomasz Przykładny').includes('tprzykladny'));
    assert.deepEqual(nickCandidates('Tomasz Przykładny'), nickCandidates('Tomasz Przykładny'));
    assert.ok(nickCandidates('Jan Kowalski').length <= 8);
    assert.deepEqual(nickCandidates('Jan'), []);
  });

  test('nicki: nazwisko dwuczłonowe sklejone, w wariancie z łącznikiem — z łącznikiem; drugie imię pominięte', () => {
    const nicks = nickCandidates('Anna Kowalska-Nowak');
    assert.equal(nicks[0], 'annakowalskanowak');
    assert.ok(nicks.includes('anna-kowalska-nowak'));
    assert.ok(nicks.includes('akowalskanowak'));
    assert.equal(nickCandidates('Anna Maria Kowalska')[0], 'annakowalska');
  });

  test('domeny: wzorce osobiste przed samym nazwiskiem, każdy w .pl i .com, potem .dev i .eu; najwyżej 12', () => {
    const domains = domainCandidates('Jan Kowalski');
    assert.deepEqual(domains, [
      'jankowalski.pl',
      'jankowalski.com',
      'jan-kowalski.pl',
      'jan-kowalski.com',
      'jkowalski.pl',
      'jkowalski.com',
      'kowalskijan.pl',
      'kowalskijan.com',
      'kowalski.pl',
      'kowalski.com',
      'jankowalski.dev',
      'jankowalski.eu',
    ]);
    assert.ok(domainCandidates('Łukasz Żółć').includes('lukaszzolc.pl'));
  });

  test('zgodność nazwy: bez znaków diakrytycznych i bez względu na kolejność słów', () => {
    assert.equal(foldName('Łukasz Żółć'), 'lukasz zolc');
    assert.equal(displayNameMatch('Kowalski Jan', 'Jan Kowalski'), 'exact');
    assert.equal(displayNameMatch('jan kowalski', 'Jan Kowalski'), 'exact');
    assert.equal(displayNameMatch('Lukasz Zolc', 'Łukasz Żółć'), 'exact');
    assert.equal(displayNameMatch('Jan Piotr Kowalski', 'Jan Kowalski'), 'contains');
    assert.equal(displayNameMatch('Anna Kowalska Nowak', 'Anna Kowalska-Nowak'), 'exact');
    assert.equal(displayNameMatch('Janusz Kowalski', 'Jan Kowalski'), null);
    assert.equal(displayNameMatch(undefined, 'Jan Kowalski'), null);
    assert.equal(textContainsName('Witaj! Nazywam się Kowalski, Jan Kowalski.', 'Jan Kowalski'), true);
    assert.equal(textContainsName('Kowalski Sp. z o.o.', 'Jan Kowalski'), false);
  });
});

describe('wyszukiwarki kont po imieniu i nazwisku', () => {
  const user = (login: string, name: string, extra: object = {}) => ({
    login,
    html_url: `https://github.com/${login}`,
    name,
    bio: null,
    company: null,
    location: null,
    blog: null,
    email: null,
    twitter_username: null,
    created_at: '2020-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  });

  test('GitHub: /search/users z „in:name”, profile 5 pierwszych, dokładna zgodność najpierw, inna nazwa odrzucona', async () => {
    const search = `https://api.github.com/search/users?q=${encodeURIComponent('"Jan Kowalski" in:name')}&per_page=5`;
    const logins = ['jk-dev', 'kowalski-jan', 'janek-k', 'jkowalski', 'inny-jan'];
    const { calls, logs, run } = setup({
      [search]: { body: { total_count: 42, items: logins.map((login) => ({ login })) } },
      'https://api.github.com/users/jk-dev': { body: user('jk-dev', 'Jan Piotr Kowalski') },
      'https://api.github.com/users/kowalski-jan': { body: user('kowalski-jan', 'Kowalski Jan', { blog: 'kowalski.example', email: 'jan@kowalski.example' }) },
      'https://api.github.com/users/janek-k': { body: user('janek-k', 'Janusz Kowalski') },
      'https://api.github.com/users/jkowalski': { body: user('jkowalski', 'Jan Kowalski') },
      'https://api.github.com/users/inny-jan': { body: user('inny-jan', 'Jan Kowalski') },
    });
    const docs = await run('live-github', 'full_name', 'Jan Kowalski');

    assert.equal(calls[0], search);
    assert.equal(calls.length, 6);
    assert.deepEqual(docs.map((doc) => doc.author), ['kowalski-jan', 'jkowalski', 'inny-jan', 'jk-dev']);
    for (const doc of docs) {
      assert.equal(doc.identityMatch, 'name_only');
      assert.equal(doc.category, 'own_profile');
      assert.equal(doc.identityNote, NAME_SEARCH_REASON);
      assert.equal(doc.matchedIdentifier.type, 'full_name');
    }
    assert.deepEqual(docs[0]!.discoveredIdentifiers?.map((item) => item.type).sort(), ['email', 'profile_url']);
    assert.ok(logs.some((line) => line.includes('pominięto 37 dalszych wyników') && line.includes('odrzuconych (inna nazwa wyświetlana) 1')));
  });

  test('GitHub: pojedyncze słowo nie uruchamia wyszukiwarki', async () => {
    const { calls, run } = setup({});
    assert.deepEqual(await run('live-github', 'full_name', 'Kowalski'), []);
    assert.equal(calls.length, 0);
  });

  test('Mastodon: /api/v2/search?type=accounts bez resolve, konta z innych instancji raz, limit 5', async () => {
    const account = (username: string, display_name: string, acct = username) => ({
      username,
      acct,
      display_name,
      note: '<p>Opis</p>',
      url: acct.includes('@') ? `https://${acct.split('@')[1]}/@${username}` : `https://mastodon.example/@${username}`,
      fields: [],
    });
    const query = (host: string) => `https://${host}/api/v2/search?q=${encodeURIComponent('Jan Kowalski')}&type=accounts&limit=10`;
    const many = Array.from({ length: 6 }, (_, index) => account(`jan${index}`, 'Jan Kowalski'));
    const { calls, logs, run } = setup({
      [query('mastodon.example')]: { body: { accounts: [account('kowalski_jan', 'Kowalski Jan 🚲'), account('janek', 'Janek K'), ...many.slice(0, 3)] } },
      [query('drugi.example')]: { body: { accounts: [account('kowalski_jan', 'Kowalski Jan 🚲', 'kowalski_jan@mastodon.example'), ...many.slice(3)] } },
    });
    const docs = await run('live-fediverse', 'full_name', 'Jan Kowalski');

    assert.deepEqual(calls, [query('mastodon.example'), query('drugi.example')]);
    assert.ok(calls.every((url) => !url.includes('resolve') && !url.includes('offset')));
    assert.equal(docs.length, 5);
    assert.ok(docs.every((doc) => doc.identityMatch === 'name_only' && doc.identityNote === NAME_SEARCH_REASON));
    assert.equal(docs.filter((doc) => doc.author === 'kowalski_jan').length, 1);
    assert.ok(logs.some((line) => line.includes('pominięto 2 dalszych wyników') && line.includes('odrzuconych (inna nazwa wyświetlana) 1')));
  });

  test('Bluesky: searchActors, jedno żądanie, tylko pasująca nazwa wyświetlana', async () => {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.actor.searchActors?q=${encodeURIComponent('Jan Kowalski')}&limit=25`;
    const { calls, run } = setup({
      [url]: {
        body: {
          actors: [
            { did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', handle: 'jankowalski.bsky.social', displayName: 'Jan Kowalski', description: 'Strona: https://kowalski.example' },
            { did: 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb', handle: 'jk.example', displayName: 'Jan Kowalczyk' },
            { did: 'did:plc:cccccccccccccccccccccccc', handle: 'kowalski.example', displayName: 'Kowalski Jan' },
          ],
        },
      },
    });
    const docs = await run('live-bluesky', 'full_name', 'Jan Kowalski');
    assert.deepEqual(calls, [url]);
    assert.deepEqual(docs.map((doc) => doc.author), ['jankowalski.bsky.social', 'kowalski.example']);
    assert.ok(docs.every((doc) => doc.identityMatch === 'name_only'));
    assert.ok(docs[0]!.discoveredIdentifiers?.some((item) => item.value.startsWith('https://kowalski.example')));
  });

  test('Keybase nie przyjmuje imienia i nazwiska (brak udokumentowanej wyszukiwarki)', () => {
    const connectors = createConnectors({ enableLive: true, fetcher: async () => new Response(''), monitorSources: [], nostrRelays: [] });
    assert.equal(connectors.find((item) => item.id === 'live-keybase')!.accepts.includes('full_name'), false);
  });
});

describe('domeny osobiste z imienia i nazwiska', () => {
  test('DNS → najwyżej 4 strony główne (robots.txt) → przyjęta tylko strona z imieniem i nazwiskiem', async () => {
    // Kolejność sprawdzania: jankowalski.pl, jankowalski.com, …, jkowalski.pl, jkowalski.com, …, kowalski.pl.
    const existing = new Set(['jankowalski.pl', 'kowalski.pl', 'jkowalski.pl', 'jankowalski.com', 'jkowalski.com']);
    const asked: string[] = [];
    const html = (body: string) => ({ body: `<html><head><title>Strona</title></head><body>${body}</body></html>` });
    const { calls, logs, run } = setup(
      {
        'https://jankowalski.pl/robots.txt': { body: 'User-agent: *\nDisallow:', type: 'text/plain' },
        'https://jankowalski.pl/': html('<h1>Kowalski Jan</h1><p>Programista. <a href="mailto:kontakt@jankowalski.example">napisz</a> <a rel="me" href="https://github.com/jk-dev">GitHub</a> BTC: 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa</p>'),
        'https://kowalski.pl/': html('<h1>Kowalski i Synowie — hurtownia</h1>'),
        'https://jkowalski.pl/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' },
        'https://jkowalski.pl/': html('<h1>Jan Kowalski</h1>'),
        'https://jankowalski.com/': html('<p>Jan Kowalski — fotografia</p>'),
        'https://jkowalski.com/': html('<p>Jan Kowalski</p>'),
      },
      {
        nameDomainExists: async (domain) => {
          asked.push(domain);
          return existing.has(domain);
        },
      },
    );
    const docs = await run(NAME_DOMAINS_ID, 'full_name', 'Jan Kowalski');

    assert.equal(asked.length, 12);
    // Czwarta istniejąca domena to ostatnia pobrana; piątej (kowalski.pl — sama nazwa, strona firmy) nie pobieramy.
    assert.ok(!calls.some((url) => url.startsWith('https://kowalski.pl')));
    // robots.txt zabrania — strony nie pobrano.
    assert.ok(!calls.includes('https://jkowalski.pl/'));
    assert.deepEqual(docs.map((doc) => doc.url), ['https://jankowalski.pl/', 'https://jankowalski.com/', 'https://jkowalski.com/']);
    for (const doc of docs) {
      assert.equal(doc.connectorId, NAME_DOMAINS_ID);
      assert.equal(doc.category, 'own_profile');
      assert.equal(doc.identityMatch, 'name_only');
      assert.equal(doc.identityNote, DOMAIN_CANDIDATE_REASON);
      assert.deepEqual(doc.matchedIdentifier, { type: 'full_name', value: 'Jan Kowalski' });
    }
    assert.ok(docs[0]!.discoveredIdentifiers?.some((item) => item.type === 'email' && item.value === 'kontakt@jankowalski.example'));
    assert.ok(docs[0]!.discoveredIdentifiers?.some((item) => item.value === 'https://github.com/jk-dev'));
    const stop = logs.find((line) => line.startsWith(CONNECTOR_STOP_PREFIX))!;
    assert.match(stop, /sprawdzono w DNS 12 \(limit 12\), istnieje 5, pobrano stron 4 \(limit 4\), przyjęto 3, pominięto istniejących domen 1/);
    // Strona firmy bez imienia i nazwiska byłaby odrzucona — sprawdzamy osobno z jedną istniejącą domeną.
    const firm = setup({ 'https://kowalski.pl/': html('<h1>Kowalski i Synowie — hurtownia</h1>') }, { nameDomainExists: async (domain) => domain === 'kowalski.pl' });
    assert.deepEqual(await firm.run(NAME_DOMAINS_ID, 'full_name', 'Jan Kowalski'), []);
    assert.ok(firm.logs.some((line) => line.includes('odrzuconych (strona bez imienia i nazwiska) 1')));
  });

  test('bez atrapy DNS przy atrapie fetch żadna domena nie jest sprawdzana w prawdziwym DNS', async () => {
    const { calls, run } = setup({});
    assert.deepEqual(await run(NAME_DOMAINS_ID, 'full_name', 'Jan Kowalski'), []);
    assert.equal(calls.length, 0);
  });
});
