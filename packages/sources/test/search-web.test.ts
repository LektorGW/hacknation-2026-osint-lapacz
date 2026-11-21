// Łącznik `web-search` i jego dostawcy — na zapisanych przykładowych odpowiedziach (dane fikcyjne), bez internetu.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { IdentifierType, SourceDocument } from '@olcys/core';
import { createHttpClient } from '../src/http.ts';
import type { Fetcher } from '../src/http.ts';
import { createSearchConnectors, searchConfigFromEnv, webSearchProviders } from '../src/search/index.ts';
import { createMarginaliaProvider, createMojeekProvider, parseMarginalia, parseMojeek } from '../src/search/providers.ts';
import { buildWebQueries, createWebSearchConnector, isProfileOfHandle, resultMentions, SNIPPET_NOTICE } from '../src/search/web-search.ts';
import type { WebSearchProvider, WebSearchResult } from '../src/search/web-search.ts';

const BTC = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ETH = '0x52908400098527886E0F7030069857D2E4169EE7';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Atrapa `fetch`: odpowiedź wybiera funkcja na podstawie adresu; brak odpowiedzi = 404. */
function mockFetch(respond: (url: URL) => { status?: number; body: object | string } | undefined) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = respond(new URL(url));
    if (!route) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return new Response(body, { status: route.status ?? 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  return { fetcher, calls };
}

function fakeProvider(results: (query: string) => WebSearchResult[] | null, id = 'atrapa'): WebSearchProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    id,
    label: 'Atrapa',
    host: 'szukaj.example',
    minIntervalMs: 0,
    terms: 'warunki testowe',
    queries,
    async search({ query }) {
      queries.push(query);
      return results(query);
    },
  };
}

function run(provider: WebSearchProvider | WebSearchProvider[], options = {}) {
  const http = createHttpClient({ fetcher: mockFetch(() => undefined).fetcher, minIntervalMs: 0 });
  const connector = createWebSearchConnector(http, Array.isArray(provider) ? provider : [provider], options);
  const logs: string[] = [];
  const search = (type: IdentifierType, value: string): Promise<SourceDocument[]> => connector.search({ type, value }, { log: (message) => void logs.push(message) });
  return { connector, logs, search };
}

describe('web-search: budowanie zapytań', () => {
  test('adres kryptowalutowy i e-mail to jedna dokładna fraza w cudzysłowie', () => {
    assert.deepEqual(buildWebQueries({ type: 'crypto_address', value: BTC }), { phrase: BTC, queries: [`"${BTC}"`] });
    assert.deepEqual(buildWebQueries({ type: 'email', value: ' Jan.Testowy@Example.org ' }), { phrase: 'jan.testowy@example.org', queries: ['"jan.testowy@example.org"'] });
  });

  test('imię i nazwisko: fraza w cudzysłowie z jednym słowem kontekstu na zapytanie, do limitu', () => {
    const plan = buildWebQueries({ type: 'full_name', value: 'Jan  Testowy' }, 3);
    assert.deepEqual(plan?.queries, ['"Jan Testowy" bitcoin', '"Jan Testowy" kryptowaluty', '"Jan Testowy" ethereum']);
    assert.equal(buildWebQueries({ type: 'full_name', value: 'Jan Testowy' }, 50)?.queries.length, 4);
  });

  test('nick: najpierw sama fraza, potem z kontekstem', () => {
    assert.deepEqual(buildWebQueries({ type: 'nick', value: '@krypto_janek' }, 2)?.queries, ['"krypto_janek"', '"krypto_janek" bitcoin']);
  });

  test('odrzuca niepoprawny adres, pojedyncze słowo jako imię i nazwisko, krótki nick i nieobsługiwane typy', () => {
    assert.equal(buildWebQueries({ type: 'crypto_address', value: '1BoatSLRHtKNngkdXEeobR76b53LETtpyX' }), null);
    assert.equal(buildWebQueries({ type: 'full_name', value: 'Testowy' }), null);
    assert.equal(buildWebQueries({ type: 'nick', value: 'jan' }), null);
    assert.equal(buildWebQueries({ type: 'nick', value: 'jan testowy' }), null);
    assert.equal(buildWebQueries({ type: 'email', value: 'to nie e-mail' }), null);
    assert.equal(buildWebQueries({ type: 'profile_url', value: 'https://example.org' }), null);
  });

  test('cudzysłów w wartości nie wychodzi poza frazę', () => {
    assert.deepEqual(buildWebQueries({ type: 'full_name', value: 'Jan "Hak" Testowy' }, 1)?.queries, ['"Jan Hak Testowy" bitcoin']);
  });
});

describe('web-search: dopasowanie wyników', () => {
  const result = (snippet: string, url = 'https://forum.example/watek/1', title = 'Wątek'): WebSearchResult => ({ url, title, snippet });

  test('nick musi wystąpić jako całe słowo', () => {
    assert.equal(resultMentions(result('pisze krypto_janek: wpłaty na adres'), 'krypto_janek', 'nick'), true);
    assert.equal(resultMentions(result('pisze krypto_janek2: wpłaty'), 'krypto_janek', 'nick'), false);
    assert.equal(resultMentions(result('nic tu nie ma', 'https://github.com/Krypto_Janek'), 'krypto_janek', 'nick'), true);
  });

  test('adres EVM bez rozróżniania wielkości liter, adres Bitcoin dokładnie', () => {
    assert.equal(resultMentions(result(`donate: ${ETH.toLowerCase()}`), ETH, 'crypto_address'), true);
    assert.equal(resultMentions(result(`donate: ${BTC.toLowerCase()}`), BTC, 'crypto_address'), false);
    assert.equal(resultMentions(result(`donate: ${BTC}`), BTC, 'crypto_address'), true);
  });

  test('strona profilu o nazwie równej nickowi', () => {
    assert.equal(isProfileOfHandle(new URL('https://github.com/Krypto_Janek'), 'krypto_janek'), true);
    assert.equal(isProfileOfHandle(new URL('https://github.com/krypto_janek/repo'), 'krypto_janek'), false);
    assert.equal(isProfileOfHandle(new URL('https://forum.example/krypto_janek'), 'krypto_janek'), false);
  });
});

describe('web-search: łącznik', () => {
  test('bez dostawcy jest wyłączony, mówi o tym w opisie i niczego nie wysyła', async () => {
    const { connector, logs, search } = run([]);
    assert.equal(connector.enabledByDefault, false);
    assert.match(connector.description, /^WYŁĄCZONY/);
    assert.match(connector.description, /MARGINALIA_API_KEY/);
    assert.deepEqual(await search('nick', 'krypto_janek'), []);
    assert.match(logs[0]!, /wyłączony/);
  });

  test('opis nazywa dostawcę, do którego trafia treść zapytania', () => {
    const { connector } = run(fakeProvider(() => []));
    assert.equal(connector.enabledByDefault, true);
    assert.match(connector.description, /treść zapytania \(identyfikator podmiotu\) jest wysyłana do zewnętrznego dostawcy wyszukiwarki: Atrapa \(szukaj\.example\)/);
    assert.match(connector.description, /stron nie pobiera/);
  });

  test('wynik to fragment z wyszukiwarki: najsłabsza kategoria, „tylko nazwa", oznaczenie w treści i tytule', async () => {
    const provider = fakeProvider(() => [
      { url: 'https://forum.example/watek/7', title: 'Sprzedam BTC', snippet: `Jan Testowy przyjmuje wpłaty na ${BTC}`, publishedAt: '2026-01-02T00:00:00.000Z' },
      { url: 'https://inne.example/a', title: 'Bez związku', snippet: 'Ktoś inny pisze o bitcoinie' },
      { url: 'javascript:alert(1)', title: 'Jan Testowy', snippet: 'Jan Testowy' },
    ]);
    const { search } = run(provider, { maxQueriesPerIdentifier: 1 });
    const documents = await search('full_name', 'Jan Testowy');
    assert.equal(documents.length, 1);
    const [document] = documents;
    assert.equal(document!.connectorId, 'web-search');
    assert.equal(document!.service, 'forum.example');
    assert.equal(document!.url, 'https://forum.example/watek/7');
    assert.equal(document!.category, 'forum_post');
    assert.equal(document!.identityMatch, 'name_only');
    assert.equal(document!.publishedAt, '2026-01-02T00:00:00.000Z');
    assert.ok(document!.text.startsWith(`${SNIPPET_NOTICE} (dostawca: Atrapa, szukaj.example; zapytanie: "Jan Testowy" bitcoin).`));
    assert.match(document!.text, /Strona nie została pobrana/);
    assert.match(document!.text, new RegExp(BTC));
    assert.match(document!.title, /^\[fragment z wyszukiwarki: Atrapa\]/);
    assert.equal(document!.discoveredIdentifiers, undefined);
    assert.deepEqual(provider.queries, ['"Jan Testowy" bitcoin']);
  });

  test('limit zapytań na identyfikator i brak powtórzeń tego samego adresu strony', async () => {
    const provider = fakeProvider(() => [{ url: 'https://forum.example/watek/7', title: 'Wątek', snippet: 'pisze krypto_janek o BTC' }]);
    const { search, logs } = run(provider, { maxQueriesPerIdentifier: 2 });
    const documents = await search('nick', 'krypto_janek');
    assert.equal(provider.queries.length, 2);
    assert.equal(documents.length, 1);
    assert.match(logs.at(-1)!, /2 zapytań do szukaj\.example, 1 wyników/);
  });

  test('profil o nazwie równej nickowi: „ten sam nick" i adres profilu jako identyfikator tylko dla obsługiwanych hostów', async () => {
    const provider = fakeProvider(() => [
      { url: 'https://github.com/krypto_janek', title: 'krypto_janek · GitHub', snippet: 'Profil' },
      { url: 'https://x.com/krypto_janek', title: 'krypto_janek', snippet: 'Profil X' },
      { url: 'https://github.com/ktos/repo', title: 'repo', snippet: 'dziękuję krypto_janek za pomoc' },
    ]);
    const { search } = run(provider, { maxQueriesPerIdentifier: 1 });
    const documents = await search('nick', 'krypto_janek');
    const byUrl = Object.fromEntries(documents.map((document) => [document.url, document]));
    assert.equal(byUrl['https://github.com/krypto_janek']!.identityMatch, 'same_handle');
    assert.deepEqual(byUrl['https://github.com/krypto_janek']!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://github.com/krypto_janek' }]);
    // x.com nie jest hostem, który narzędzie wolno mu odpytywać — bez identyfikatora do dalszego pobrania.
    assert.equal(byUrl['https://x.com/krypto_janek']!.identityMatch, 'same_handle');
    assert.equal(byUrl['https://x.com/krypto_janek']!.discoveredIdentifiers, undefined);
    assert.equal(byUrl['https://github.com/ktos/repo']!.identityMatch, 'name_only');
    assert.equal(byUrl['https://github.com/ktos/repo']!.discoveredIdentifiers, undefined);
  });

  test('zapytanie o adres: strona z obsługiwanego hosta wraca jako identyfikator, wynik bez adresu odpada', async () => {
    const provider = fakeProvider(() => [
      { url: 'https://gist.github.com/ktos/abc', title: 'donate.md', snippet: `BTC: ${BTC}` },
      { url: 'https://blog.example/wpis', title: 'Wpis', snippet: `Wsparcie: ${BTC}` },
      { url: 'https://blog.example/inny', title: 'Inny', snippet: 'adres podobny 1BoatSLRHtKNngkdXEeobR76b53LETtpyX' },
    ]);
    const { search } = run(provider);
    const documents = await search('crypto_address', BTC);
    assert.deepEqual(provider.queries, [`"${BTC}"`]);
    assert.equal(documents.length, 2);
    assert.ok(documents.every((document) => document.identityMatch === 'name_only'));
    assert.deepEqual(documents[0]!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://gist.github.com/ktos/abc' }]);
    assert.equal(documents[1]!.discoveredIdentifiers, undefined);
  });

  test('dzienny limit zapytań dostawcy zatrzymuje kolejne zapytania i odnawia się następnego dnia', async () => {
    const provider = fakeProvider(() => []);
    let today = new Date('2026-11-21T10:00:00Z');
    const { search, logs } = run(provider, { maxQueriesPerIdentifier: 1, maxQueriesPerDay: 2, now: () => today });
    await search('nick', 'krypto_janek');
    await search('nick', 'krypto_janek');
    await search('nick', 'krypto_janek');
    assert.equal(provider.queries.length, 2);
    assert.ok(logs.some((line) => /wyczerpano dzienny limit 2 zapytań/.test(line)));
    today = new Date('2026-11-22T00:00:01Z');
    await search('nick', 'krypto_janek');
    assert.equal(provider.queries.length, 3);
  });

  test('nieudane zapytanie dostawcy nie przerywa pozostałych dostawców', async () => {
    const broken = fakeProvider(() => null, 'zepsuty');
    const working = fakeProvider(() => [{ url: 'https://forum.example/1', title: 'Wątek', snippet: 'kontakt: jan.testowy@example.org' }], 'dobry');
    const { search } = run([broken, working]);
    const documents = await search('email', 'Jan.Testowy@example.org');
    assert.equal(documents.length, 1);
    assert.equal(documents[0]!.identityMatch, 'name_only');
  });
});

describe('web-search: dostawcy', () => {
  test('Marginalia: klucz tylko w nagłówku do api2.marginalia-search.com, wyniki z pól url/title/description', async () => {
    const mock = mockFetch((url) =>
      url.host === 'api2.marginalia-search.com'
        ? { body: { license: 'CC-BY-NC-SA 4.0', query: url.searchParams.get('query'), results: [{ url: 'https://blog.example/wpis', title: 'Wpis', description: `krypto_janek: ${BTC}` }, { title: 'bez adresu' }] } }
        : undefined,
    );
    const http = createHttpClient({ fetcher: mock.fetcher, minIntervalMs: 0 });
    const connector = createWebSearchConnector(http, [createMarginaliaProvider({ apiKey: 'tajny-klucz-m' })], { maxQueriesPerIdentifier: 1 });
    const logs: string[] = [];
    const documents = await connector.search({ type: 'nick', value: 'krypto_janek' }, { log: (message) => void logs.push(message) });
    assert.equal(mock.calls.length, 1);
    const call = new URL(mock.calls[0]!.url);
    assert.equal(call.origin + call.pathname, 'https://api2.marginalia-search.com/search');
    assert.equal(call.searchParams.get('query'), '"krypto_janek"');
    assert.equal(mock.calls[0]!.headers['API-Key'], 'tajny-klucz-m');
    assert.ok(!mock.calls[0]!.url.includes('tajny-klucz-m'));
    assert.equal(documents.length, 1);
    assert.match(documents[0]!.text, /CC BY-NC-SA 4\.0/);
    assert.ok(!logs.join('\n').includes('tajny-klucz-m'));
    assert.ok(!documents[0]!.text.includes('tajny-klucz-m'));
  });

  test('Marginalia: odmowa 429 kończy zapytania bez ponawiania', async () => {
    const mock = mockFetch(() => ({ status: 429, body: 'QPM Limit Exceeded' }));
    const http = createHttpClient({ fetcher: mock.fetcher, minIntervalMs: 0 });
    const connector = createWebSearchConnector(http, [createMarginaliaProvider({ apiKey: 'public' })]);
    const logs: string[] = [];
    const documents = await connector.search({ type: 'full_name', value: 'Jan Testowy' }, { log: (message) => void logs.push(message) });
    assert.deepEqual(documents, []);
    assert.equal(mock.calls.length, 1);
    assert.ok(logs.some((line) => /odmowa lub limit zapytań \(kod 429\); nie ponawiam/.test(line)));
  });

  test('Mojeek: parametry zapytania, data publikacji i klucz poza dziennikiem', async () => {
    const mock = mockFetch((url) =>
      url.host === 'www.mojeek.com'
        ? { body: { response: { status: 'OK', head: { results: 1 }, results: [{ url: 'https://forum.example/watek/3', title: 'Oferta', desc: `Jan Testowy, wpłaty ${ETH}`, pdate: 1767225600 }] } } }
        : undefined,
    );
    const http = createHttpClient({ fetcher: mock.fetcher, minIntervalMs: 0 });
    const connector = createWebSearchConnector(http, [createMojeekProvider({ apiKey: 'tajny-klucz-x' })], { maxQueriesPerIdentifier: 1 });
    const logs: string[] = [];
    const documents = await connector.search({ type: 'full_name', value: 'Jan Testowy' }, { log: (message) => void logs.push(message) });
    const call = new URL(mock.calls[0]!.url);
    assert.equal(call.origin + call.pathname, 'https://www.mojeek.com/search');
    assert.equal(call.searchParams.get('q'), '"Jan Testowy" bitcoin');
    assert.equal(call.searchParams.get('fmt'), 'json');
    assert.equal(call.searchParams.get('api_key'), 'tajny-klucz-x');
    assert.equal(documents.length, 1);
    assert.equal(documents[0]!.publishedAt, '2026-01-01T00:00:00.000Z');
    assert.ok(!logs.join('\n').includes('tajny-klucz-x'));
    assert.ok(!JSON.stringify(documents).includes('tajny-klucz-x'));
  });

  test('Mojeek: błąd w polu status trafia do dziennika, bez wyników', async () => {
    const mock = mockFetch(() => ({ body: { response: { status: 'ERROR: Daily Limit Reached' } } }));
    const http = createHttpClient({ fetcher: mock.fetcher, minIntervalMs: 0 });
    const connector = createWebSearchConnector(http, [createMojeekProvider({ apiKey: 'k' })], { maxQueriesPerIdentifier: 1 });
    const logs: string[] = [];
    assert.deepEqual(await connector.search({ type: 'email', value: 'jan@example.org' }, { log: (message) => void logs.push(message) }), []);
    assert.ok(logs.some((line) => /Mojeek: ERROR: Daily Limit Reached/.test(line)));
  });

  test('rozbiór odpowiedzi jest odporny na nieoczekiwany kształt', () => {
    assert.deepEqual(parseMarginalia(null), []);
    assert.deepEqual(parseMarginalia({ results: 'x' }), []);
    assert.equal(parseMojeek({}).error, 'odpowiedź bez pola „response"');
    assert.deepEqual(parseMojeek({ response: { status: 'OK' } }), { results: [] });
  });
});

describe('web-search: konfiguracja ze zmiennych środowiskowych', () => {
  test('bez kluczy nie powstaje żaden dostawca', () => {
    assert.deepEqual(webSearchProviders(searchConfigFromEnv({})), []);
    assert.deepEqual(webSearchProviders(searchConfigFromEnv({ MARGINALIA_API_KEY: '  ' })), []);
  });

  test('Mojeek wymaga potwierdzenia planu z prawem przechowywania wyników', () => {
    const logs: string[] = [];
    assert.deepEqual(webSearchProviders(searchConfigFromEnv({ MOJEEK_API_KEY: 'k' }), (message) => void logs.push(message)), []);
    assert.match(logs[0]!, /MOJEEK_STORAGE_RIGHTS=1/);
    assert.ok(!logs[0]!.includes('"k"'));
    const providers = webSearchProviders(searchConfigFromEnv({ MOJEEK_API_KEY: 'k', MOJEEK_STORAGE_RIGHTS: '1', MARGINALIA_API_KEY: 'public' }));
    assert.deepEqual(providers.map((provider) => provider.id), ['marginalia', 'mojeek']);
  });

  test('createSearchConnectors: bez źródeł w internecie tylko lokalne rejestry; z nimi także Farcaster i wyszukiwarka (wyłączona bez klucza)', () => {
    assert.deepEqual(createSearchConnectors({}, {}).map((connector) => connector.id), ['rejestry-publiczne']);
    const live = createSearchConnectors({}, { enableLive: true });
    assert.deepEqual(live.map((connector) => connector.id), ['rejestry-publiczne', 'live-farcaster', 'web-search']);
    assert.equal(live.find((connector) => connector.id === 'web-search')!.enabledByDefault, false);
    const keyed = createSearchConnectors({ marginaliaApiKey: 'public' }, { enableLive: true });
    assert.equal(keyed.find((connector) => connector.id === 'web-search')!.enabledByDefault, true);
  });
});
