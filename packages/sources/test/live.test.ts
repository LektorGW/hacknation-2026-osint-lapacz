// Łączniki do prawdziwych serwisów sprawdzane na zapisanych przykładowych
// odpowiedziach (kształt zgodny z prawdziwymi API, dane fikcyjne).
// `fetch` jest atrapą — żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { DiscoveringConnector, Identifier, IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import { innerByClass } from '../src/html.ts';
import { createHttpClient, isPrivateAddress, publicHostProblem, USER_AGENT } from '../src/http.ts';
import type { Fetcher } from '../src/http.ts';
import { dedupeIdentifiers } from '../src/identity.ts';
import { createConnectors } from '../src/index.ts';
import type { SourcesConfig } from '../src/index.ts';
import { createTorConnector } from '../src/tor.ts';
import { robotsAllows } from '../src/www.ts';

interface Route {
  status?: number;
  body?: string | Uint8Array | object;
  type?: string;
  headers?: Record<string, string>;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  redirect: string;
}

/** Atrapa `fetch`: odpowiada z tabeli adresów, nieznane adresy dostają 404. */
function mockFetch(routes: Record<string, Route | (() => never)>) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect });
    const route = routes[url];
    if (typeof route === 'function') return route();
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object' && !(route.body instanceof Uint8Array);
    const body = isJson ? JSON.stringify(route.body) : ((route.body ?? '') as string | Uint8Array);
    const status = route.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : body, {
      status,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'), ...route.headers },
    });
  };
  return { fetcher, calls };
}

function setup(routes: Record<string, Route | (() => never)>, config: Partial<SourcesConfig> = {}) {
  const { fetcher, calls } = mockFetch(routes);
  const logs: string[] = [];
  const connectors = createConnectors({
    enableLive: true,
    fetcher,
    minRequestIntervalMs: 0,
    allowPrivateHosts: true,
    fediverseInstances: ['mastodon.example', 'pl.example'],
    monitorSources: [],
    ...config,
  });
  const context = { log: (message: string) => void logs.push(message) };
  const run = (id: string, type: IdentifierType, value: string): Promise<SourceDocument[]> => {
    const connector = connectors.find((item) => item.id === id) as SourceConnector;
    assert.ok(connector, `brak łącznika ${id}`);
    assert.ok(connector.accepts.includes(type), `${id} nie przyjmuje ${type}`);
    return connector.search({ type, value }, context);
  };
  return { connectors, calls, logs, run };
}

const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);
const context = () => {
  const logs: string[] = [];
  return { logs, log: (message: string) => void logs.push(message) };
};

// ---------- Wspólny klient HTTP ----------

describe('klient HTTP', () => {
  test('nagłówek User-Agent, limit 4 żądań na wyszukiwanie i wpis w dzienniku', async () => {
    const { fetcher, calls } = mockFetch({ 'https://a.example/x': { body: 'ok' } });
    const ctx = context();
    const session = createHttpClient({ fetcher, minIntervalMs: 0 }).session(ctx, { label: 'Test' });
    for (let i = 0; i < 4; i++) assert.equal((await session.get('https://a.example/x'))?.text, 'ok');
    assert.equal(await session.get('https://a.example/x'), null);
    assert.equal(calls.length, 4);
    assert.equal(calls[0]!.headers['User-Agent'], 'OLCyS-research/0.1 (hackathon KAS; kontakt przez organizatora)');
    assert.equal(USER_AGENT, calls[0]!.headers['User-Agent']);
    assert.match(ctx.logs.join('\n'), /wyczerpano limit 4 żądań/);
  });

  test('403 i 429 kończą pracę z hostem; 404 i wyjątek dają pusty wynik, nigdy wyjątek', async () => {
    const { fetcher, calls } = mockFetch({
      'https://a.example/403': { status: 403 },
      'https://a.example/ok': { body: 'ok' },
      'https://b.example/429': { status: 429 },
      'https://c.example/boom': () => {
        throw new Error('ECONNRESET');
      },
      'https://c.example/timeout': () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      },
    });
    const ctx = context();
    const session = createHttpClient({ fetcher, minIntervalMs: 0 }).session(ctx, { label: 'Test', limit: 10 });
    assert.equal(await session.get('https://a.example/403'), null);
    assert.equal(session.refused, true);
    // Po odmowie kolejne żądanie do tego hosta w ogóle nie wychodzi.
    assert.equal(await session.get('https://a.example/ok'), null);
    assert.equal(calls.length, 1);
    assert.equal(await session.get('https://b.example/429'), null);
    assert.equal(await session.get('https://c.example/brak'), null);
    assert.equal(session.lastStatus, 404);
    assert.equal(await session.get('https://c.example/boom'), null);
    assert.equal(session.lastStatus, 0);
    assert.equal(await session.get('https://c.example/timeout'), null);
    const journal = ctx.logs.join('\n');
    assert.match(journal, /kod 403/);
    assert.match(journal, /kod 429/);
    assert.match(journal, /kod 404/);
    assert.match(journal, /ECONNRESET/);
    assert.match(journal, /limit czasu/);
  });

  test('ogranicznik tempa: odstęp między żądaniami do jednego hosta, inne hosty bez czekania', async () => {
    const { fetcher } = mockFetch({ 'https://a.example/': { body: 'a' }, 'https://b.example/': { body: 'b' } });
    const client = createHttpClient({ fetcher, minIntervalMs: 80 });
    const ctx = context();
    const started = Date.now();
    await client.get('https://a.example/', ctx);
    await client.get('https://b.example/', ctx);
    const afterDifferentHosts = Date.now() - started;
    await client.get('https://a.example/', ctx);
    const afterSameHost = Date.now() - started;
    assert.ok(afterDifferentHosts < 60, `różne hosty czekały ${afterDifferentHosts} ms`);
    assert.ok(afterSameHost >= 70, `ten sam host po ${afterSameHost} ms`);
  });

  test('dekodowanie: nagłówek, znacznik meta, kodowanie domyślne łącznika; limit rozmiaru', async () => {
    const latin = Uint8Array.from(Buffer.from('<p>Zürich café</p>', 'latin1'));
    const latin2 = Uint8Array.from([...Buffer.from('<meta charset="iso-8859-2"><p>'), 0xbf, 0xf3, 0xb3, 0xe6, ...Buffer.from('</p>')]);
    const { fetcher } = mockFetch({
      'https://a.example/header': { body: latin, type: 'text/html; charset=ISO-8859-1' },
      'https://a.example/meta': { body: latin2, type: 'text/html' },
      'https://a.example/fallback': { body: latin, type: 'text/html' },
      'https://a.example/big': { body: 'x'.repeat(5000), type: 'text/plain' },
    });
    const client = createHttpClient({ fetcher, minIntervalMs: 0 });
    const ctx = context();
    assert.match((await client.get('https://a.example/header', ctx)).text, /Zürich café/);
    assert.match((await client.get('https://a.example/meta', ctx)).text, /żółć/);
    assert.match((await client.get('https://a.example/fallback', ctx, { encoding: 'iso-8859-1' })).text, /Zürich café/);
    assert.equal((await client.get('https://a.example/big', ctx, { maxBytes: 1000 })).text.length, 1000);
    const wrongType = await client.get('https://a.example/big', ctx, { allowedContentTypes: ['text/html'] });
    assert.equal(wrongType.ok, false);
    assert.match(wrongType.rejected ?? '', /typ treści/);
  });

  test('ochrona przed adresami prywatnymi: literały, DNS, przekierowania', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '185.174.155.52', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);

    const lookup = async (host: string) => [{ address: host === 'wewn.example' ? '10.0.0.5' : '93.184.216.34' }];
    assert.match((await publicHostProblem('localhost', lookup)) ?? '', /nie jest publiczną nazwą/);
    assert.match((await publicHostProblem('wewn.example', lookup)) ?? '', /niepubliczny/);
    assert.equal(await publicHostProblem('zewn.example', lookup), null);

    const { fetcher, calls } = mockFetch({
      'https://zewn.example/start': { status: 302, headers: { location: 'http://wewn.example/admin' } },
      'https://zewn.example/petla': { status: 301, headers: { location: '/petla' } },
      'https://zewn.example/dalej': { status: 301, headers: { location: '/cel' } },
      'https://zewn.example/cel': { body: 'cel' },
    });
    const client = createHttpClient({ fetcher, minIntervalMs: 0, lookup });
    const ctx = context();
    assert.match((await client.get('http://127.0.0.1:8080/', ctx, { publicOnly: true })).rejected ?? '', /nie jest publiczny/);
    assert.match((await client.get('http://wewn.example/', ctx, { publicOnly: true })).rejected ?? '', /niepubliczny/);
    assert.equal(calls.length, 0);
    // Przekierowanie z publicznego hosta na prywatny też jest odrzucane.
    assert.match((await client.get('https://zewn.example/start', ctx, { publicOnly: true })).rejected ?? '', /niepubliczny/);
    assert.ok(!calls.some((call) => call.url.includes('wewn.example')));
    assert.match((await client.get('https://zewn.example/petla', ctx, { publicOnly: true })).rejected ?? '', /więcej niż 3 przekierowania/);
    const followed = await client.get('https://zewn.example/dalej', ctx, { publicOnly: true });
    assert.equal(followed.text, 'cel');
    assert.equal(followed.url, 'https://zewn.example/cel');
    assert.ok(calls.every((call) => call.redirect === 'manual'));
  });
});

describe('pomocnicze', () => {
  test('innerByClass domyka zagnieżdżone elementy', () => {
    const html = '<div class="a b"><div>x<div>y</div></div>z</div><div class="ab">nie</div>';
    assert.equal(innerByClass(html, 'b')?.inner, '<div>x<div>y</div></div>z');
    assert.equal(innerByClass(html, 'c'), null);
  });

  test('dedupeIdentifiers scala http/https i pomija identyfikator wejściowy', () => {
    const input: Identifier = { type: 'nick', value: 'Ktos' };
    const result = dedupeIdentifiers(
      [
        { type: 'profile_url', value: 'http://strona.example/' },
        { type: 'profile_url', value: 'https://www.strona.example' },
        { type: 'nick', value: 'ktos' },
        { type: 'login', value: 'ktos' },
      ],
      input,
    );
    assert.deepEqual(result, [
      { type: 'profile_url', value: 'https://www.strona.example' },
      { type: 'login', value: 'ktos' },
    ]);
    // Adresy „noreply" i odnośniki do samego serwisu nie są tropami.
    assert.deepEqual(
      dedupeIdentifiers(
        [
          { type: 'email', value: '123+ktos@users.noreply.github.com' },
          { type: 'email', value: 'no-reply@serwis.example' },
          { type: 'email', value: 'ktos@poczta.example' },
          { type: 'profile_url', value: 'https://www.serwis.example/inny' },
          { type: 'profile_url', value: 'https://gdzie-indziej.example/ktos' },
        ],
        undefined,
        ['serwis.example'],
      ),
      [
        { type: 'email', value: 'ktos@poczta.example' },
        { type: 'profile_url', value: 'https://gdzie-indziej.example/ktos' },
      ],
    );
  });

  test('robots.txt: grupa „*", najdłuższa reguła, wzorce', () => {
    const robots = 'User-agent: innybot\nDisallow: /\n\nUser-agent: *\nDisallow: /prywatne/\nAllow: /prywatne/jawne\nDisallow: /*.pdf$\nDisallow:\n';
    assert.equal(robotsAllows(robots, '/'), true);
    assert.equal(robotsAllows(robots, '/prywatne/x'), false);
    assert.equal(robotsAllows(robots, '/prywatne/jawne/1'), true);
    assert.equal(robotsAllows(robots, '/a/b.pdf'), false);
    assert.equal(robotsAllows(robots, '/a/b.pdf?x=1'), true);
    assert.equal(robotsAllows('User-agent: *\nDisallow: /', '/cokolwiek'), false);
    assert.equal(robotsAllows('User-agent: OLCyS-research\nAllow: /\n\nUser-agent: *\nDisallow: /', '/x'), true);
    assert.equal(robotsAllows('', '/x'), true);
  });
});

// ---------- Łączniki ----------

describe('łączniki live — konfiguracja', () => {
  test('osobne identyfikatory, opisy po polsku, kolejność niezależna od sieci', () => {
    const { connectors } = setup({});
    const ids = connectors.map((connector) => connector.id);
    assert.deepEqual(ids, [
      'live-keybase',
      'live-ens',
      'live-github',
      'live-github-gists',
      'live-github-activity',
      'live-gravatar',
      'live-fediverse',
      'live-telegram',
      'live-bitcointalk',
      'live-bluesky',
      'live-nostr',
      'live-openpgp',
      'live-vat-whitelist',
      'live-krs',
      'live-www',
      'live-wayback',
      'live-wayback-twitter',
      'live-walletexplorer',
      'live-bitcoinwhoswho',
      'live-github-search',
      'deep-search',
    ]);
    assert.equal(new Set(ids).size, ids.length);
    for (const connector of connectors) {
      assert.ok(connector.description.length > 80, connector.id);
      assert.ok(connector.accepts.length > 0, connector.id);
    }
  });

  test('identyfikator nieobsługiwany przez łącznik nie powoduje żadnego żądania', async () => {
    const { connectors, calls } = setup({});
    const ctx = context();
    for (const connector of connectors) {
      for (const identifier of [
        { type: 'profile_url', value: 'nie adres' },
        { type: 'nick', value: 'zły nick!' },
        { type: 'crypto_address', value: ADDR.kacperBtc },
      ] as Identifier[]) {
        if (!connector.accepts.includes(identifier.type)) continue;
        // Serwisy wiedzy o adresach Bitcoin słusznie odpytują o poprawny adres BTC — sprawdzane osobno.
        if (identifier.type === 'crypto_address' && ['live-walletexplorer', 'live-bitcoinwhoswho'].includes(connector.id)) continue;
        assert.deepEqual(await connector.search(identifier, ctx), [], `${connector.id} ${identifier.type}`);
      }
    }
    assert.equal(calls.length, 0);
  });
});

const KEYBASE = 'https://keybase.io/_/api/1.0/user/lookup.json';
const KEYBASE_FIELDS = 'fields=basics,profile,proofs_summary,cryptocurrency_addresses';
const keybaseUser = (username: string, extra: object = {}) => ({
  id: 'abc',
  basics: { username, ctime: 1_400_000_000, mtime: 1_700_000_000 },
  profile: { full_name: 'Kacper Testowy', location: 'Gdynia', bio: 'Buduję rzeczy.' },
  proofs_summary: {
    all: [
      { proof_type: 'twitter', nametag: 'kacper_tw', state: 1, service_url: 'https://twitter.com/kacper_tw', proof_url: 'https://twitter.com/kacper_tw/status/1' },
      { proof_type: 'github', nametag: 'kacper-gh', state: 1, service_url: 'https://github.com/kacper-gh', proof_url: 'https://gist.github.com/1' },
      { proof_type: 'generic_web_site', nametag: 'kacper.example', state: 1, service_url: 'http://kacper.example/' },
      { proof_type: 'dns', nametag: 'kacper.example', state: 1, service_url: 'https://kacper.example' },
      { proof_type: 'reddit', nametag: 'usuniety', state: 5, service_url: 'https://reddit.com/user/usuniety' },
    ],
  },
  cryptocurrency_addresses: { bitcoin: [{ address: ADDR.kacperBtc, sig_id: 'f00d' }] },
  ...extra,
});

describe('Keybase', () => {
  test('nick: nazwa użytkownika i dowody kont; podpisany adres to dowód kryptograficzny', async () => {
    const { run, calls } = setup({
      [`${KEYBASE}?usernames=kacper&${KEYBASE_FIELDS}`]: { body: { status: { code: 0, name: 'OK' }, them: [keybaseUser('kacper')] } },
      [`${KEYBASE}?github=kacper&${KEYBASE_FIELDS}`]: {
        body: { status: { code: 0 }, them: [keybaseUser('inny_czlowiek', { cryptocurrency_addresses: { bitcoin: [{ address: ADDR.namesakeBtc }] } })] },
      },
      [`${KEYBASE}?twitter=kacper&${KEYBASE_FIELDS}`]: { body: { status: { code: 0 }, them: [] } },
      [`${KEYBASE}?reddit=kacper&${KEYBASE_FIELDS}`]: { body: { status: { code: 0 }, them: [null] } },
    });
    const documents = await run('live-keybase', 'nick', '@kacper');
    assert.equal(calls.length, 4);
    assert.equal(documents.length, 2);

    const [own, guessed] = documents as [SourceDocument, SourceDocument];
    assert.equal(own.service, 'keybase.io');
    assert.equal(own.url, 'https://keybase.io/kacper');
    assert.equal(own.author, 'kacper');
    assert.equal(own.category, 'cryptographic_proof');
    assert.equal(own.identityMatch, 'exact_identifier');
    assert.equal(own.publishedAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(addressesOf(own), [ADDR.kacperBtc]);
    assert.match(own.text, /GitHub: kacper-gh — https:\/\/github\.com\/kacper-gh/);
    assert.doesNotMatch(own.text, /usuniety/);
    assert.deepEqual(own.discoveredIdentifiers, [
      { type: 'nick', value: 'kacper_tw' },
      { type: 'login', value: 'kacper-gh' },
      { type: 'profile_url', value: 'https://kacper.example/' },
    ]);

    assert.deepEqual(own.profile, {
      handle: 'kacper',
      displayName: 'Kacper Testowy',
      location: 'Gdynia',
      bio: 'Buduję rzeczy.',
      urls: ['https://twitter.com/kacper_tw', 'https://github.com/kacper-gh', 'https://kacper.example'],
      createdAt: new Date(1_400_000_000_000).toISOString(),
    });

    // Konto znalezione tylko dlatego, że ktoś ma na GitHubie login równy nickowi: łącznik niczego
    // nie potwierdza (ocenę nicku robi analiza), ostrzega w treści i nie podsuwa dalszych tropów.
    assert.equal(guessed.author, 'inny_czlowiek');
    assert.equal(guessed.identityMatch, 'exact_identifier');
    assert.equal(guessed.discoveredIdentifiers, undefined);
    assert.match(guessed.text, /UWAGA/);
  });

  test('adres profilu Keybase: trafienie po nazwie nie jest potwierdzeniem przez źródło', async () => {
    const { run } = setup({
      [`${KEYBASE}?usernames=kacper&${KEYBASE_FIELDS}`]: { body: { status: { code: 0 }, them: [keybaseUser('kacper')] } },
    });
    const [document] = await run('live-keybase', 'profile_url', 'https://keybase.io/kacper');
    assert.equal(document!.identityMatch, 'exact_identifier');
  });

  test('adres profilu GitHub: jedno zapytanie po dowodzie, tożsamość potwierdzona przez źródło', async () => {
    const { run, calls } = setup({
      [`${KEYBASE}?github=kacper-gh&${KEYBASE_FIELDS}`]: { body: { status: { code: 0 }, them: [keybaseUser('kacper')] } },
    });
    const [document] = await run('live-keybase', 'profile_url', 'https://github.com/kacper-gh');
    assert.equal(calls.length, 1);
    // Keybase ma dowód dla dokładnie tego konta, które podał analityk.
    assert.equal(document!.identityMatch, 'verified_link');
    assert.ok(document!.discoveredIdentifiers!.some((item) => item.type === 'nick' && item.value === 'kacper'));
  });

  test('odmowa serwisu: pusty wynik i wpis w dzienniku', async () => {
    const { run, logs, calls } = setup({ [`${KEYBASE}?usernames=kacper&${KEYBASE_FIELDS}`]: { status: 429 } });
    assert.deepEqual(await run('live-keybase', 'nick', 'kacper'), []);
    assert.equal(calls.length, 1);
    assert.match(logs.join('\n'), /kod 429/);
  });
});

describe('Gravatar', () => {
  const email = 'Kacper.Testowy@Poczta.Example ';
  const normalized = 'kacper.testowy@poczta.example';
  const sha = createHash('sha256').update(normalized).digest('hex');
  const md5 = createHash('md5').update(normalized).digest('hex');
  const entry = {
    hash: md5,
    profileUrl: 'https://gravatar.com/kacpert',
    preferredUsername: 'kacpert',
    displayName: 'Kacper T.',
    aboutMe: 'Napiwki mile widziane.',
    currentLocation: 'Gdynia',
    name: { givenName: 'Kacper', familyName: 'Testowy', formatted: 'Kacper Testowy' },
    emails: [{ primary: 'true', value: 'kontakt@kacper.example' }],
    phoneNumbers: [{ type: 'mobile', value: '500 000 201' }],
    thumbnailUrl: 'https://gravatar.com/avatar/abc',
    accounts: [
      { domain: 'github.com', url: 'https://github.com/kacper-gh', verified: true, name: 'GitHub', shortname: 'github' },
      { domain: 'x.com', url: 'https://x.com/niepewny', verified: false, name: 'X' },
    ],
    urls: [{ value: 'https://kacper.example', title: 'Strona' }],
    currency: [{ type: 'bitcoin', value: ADDR.kacperBtc }],
    payments: { crypto_wallets: [{ label: 'ETH', address: ADDR.kacperEth }] },
  };

  test('e-mail: skrót SHA-256, zapasowo MD5; do serwisu nie trafia sam adres', async () => {
    const { run, calls } = setup({ [`https://gravatar.com/${md5}.json`]: { body: { entry: [entry] } } });
    const [document] = await run('live-gravatar', 'email', email);
    assert.deepEqual(calls.map((call) => call.url), [`https://gravatar.com/${sha}.json`, `https://gravatar.com/${md5}.json`]);
    assert.ok(calls.every((call) => !call.url.includes('@') && !call.url.toLowerCase().includes('kacper')));
    assert.equal(document!.service, 'gravatar.com');
    assert.equal(document!.url, 'https://gravatar.com/kacpert');
    assert.equal(document!.author, 'kacpert');
    assert.equal(document!.category, 'own_profile');
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.deepEqual(addressesOf(document!).sort(), [ADDR.kacperBtc, ADDR.kacperEth].sort());
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'nick', value: 'kacpert' },
      { type: 'profile_url', value: 'https://github.com/kacper-gh' },
      { type: 'email', value: 'kontakt@kacper.example' },
      { type: 'profile_url', value: 'https://kacper.example/' },
    ]);
    assert.deepEqual(document!.profile, {
      handle: 'kacpert',
      displayName: 'Kacper Testowy',
      emails: [normalized, 'kontakt@kacper.example'],
      phones: ['500000201'],
      urls: ['https://github.com/kacper-gh', 'https://x.com/niepewny', 'https://kacper.example'],
      location: 'Gdynia',
      avatarUrl: 'https://gravatar.com/avatar/abc',
      bio: 'Napiwki mile widziane.',
    });
  });

  test('nick: profil pod nazwą; brak profilu daje pusty wynik', async () => {
    const { run, calls, logs } = setup({ 'https://gravatar.com/kacpert.json': { body: { entry: [entry] } } });
    assert.equal((await run('live-gravatar', 'nick', 'KacperT')).length, 1);
    assert.deepEqual(await run('live-gravatar', 'nick', 'nikt_taki'), []);
    assert.equal(calls.length, 2);
    assert.match(logs.join('\n'), /brak publicznego profilu/);
  });
});

describe('ENS', () => {
  const record = {
    address: ADDR.kacperEth,
    ens: 'kacper.eth',
    ens_primary: 'kacper.eth',
    github: 'kacper-gh',
    twitter: 'kacper_tw',
    url: 'https://kacper.example',
    description: 'opis',
    records: { name: 'Kacper Testowy', location: 'Gdynia', email: 'Kacper@Poczta.example' },
    resolverAddress: '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63',
    wallets: { eth: ADDR.kacperEth, btc: ADDR.kacperBtc },
  };

  test('nazwa ENS: adres, rekordy tekstowe i adresy w innych sieciach', async () => {
    const { run, calls } = setup({ 'https://api.ensdata.net/kacper.eth': { body: record } });
    const [document] = await run('live-ens', 'ens_name', 'Kacper.eth');
    assert.equal(calls.length, 1);
    assert.equal(document!.service, 'ens.domains');
    assert.equal(document!.author, 'kacper.eth');
    assert.equal(document!.category, 'cryptographic_proof');
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.deepEqual(addressesOf(document!).sort(), [ADDR.kacperBtc, ADDR.kacperEth].sort());
    // Adres kontraktu resolvera nie należy do podmiotu i nie może trafić do treści.
    assert.doesNotMatch(document!.text, /0x231b0Ee1/);
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'login', value: 'kacper-gh' },
      { type: 'nick', value: 'kacper_tw' },
      { type: 'email', value: 'kacper@poczta.example' },
      { type: 'profile_url', value: 'https://kacper.example/' },
    ]);
    assert.deepEqual(document!.profile, {
      handle: 'kacper.eth',
      displayName: 'Kacper Testowy',
      emails: ['kacper@poczta.example'],
      urls: ['https://kacper.example', 'https://github.com/kacper-gh', 'https://x.com/kacper_tw'],
      location: 'Gdynia',
      bio: 'opis',
    });
  });

  test('nick → <nick>.eth: sama zbieżność nazwy to słabe powiązanie bez dalszych tropów', async () => {
    const { run } = setup({ 'https://api.ensdata.net/kacper.eth': { body: record } });
    const [document] = await run('live-ens', 'nick', 'kacper');
    assert.equal(document!.identityMatch, 'name_only');
    assert.equal(document!.category, 'own_profile');
    assert.equal(document!.discoveredIdentifiers, undefined);
    assert.match(document!.text, /UWAGA/);
  });

  test('nick → <nick>.eth potwierdzony rekordem tekstowym: dowód kryptograficzny', async () => {
    const { run } = setup({ 'https://api.ensdata.net/kacper-gh.eth': { body: { ...record, ens: 'kacper-gh.eth' } } });
    const [document] = await run('live-ens', 'login', 'Kacper-GH');
    // Właściciel nazwy sam wskazał w blockchainie ten login — potwierdzenie przez źródło.
    assert.equal(document!.identityMatch, 'verified_link');
    assert.equal(document!.profile!.handle, 'kacper-gh.eth');
    assert.equal(document!.profile!.displayName, 'Kacper Testowy');
    assert.equal(document!.category, 'cryptographic_proof');
    assert.equal(document!.author, 'kacper-gh.eth');
    assert.ok(document!.discoveredIdentifiers!.some((item) => item.type === 'ens_name' && item.value === 'kacper-gh.eth'));
    assert.match(document!.text, /potwierdzona rekordem tekstowym „github"/);
  });

  test('adres EVM → nazwa główna; autor = nazwa ENS, ten sam adres dokumentu co dla nazwy', async () => {
    const { run } = setup({ [`https://api.ensdata.net/${ADDR.kacperEth}`]: { body: record } });
    const [document] = await run('live-ens', 'crypto_address', ADDR.kacperEth);
    assert.equal(document!.author, 'kacper.eth');
    assert.equal(document!.url, 'https://app.ens.domains/kacper.eth');
    assert.equal(document!.category, 'cryptographic_proof');
    assert.equal(document!.matchedIdentifier.type, 'crypto_address');
    assert.ok(addressesOf(document!).includes(ADDR.kacperEth));
    assert.ok(document!.discoveredIdentifiers!.some((item) => item.type === 'ens_name'));
  });

  test('brak nazwy kończy bez zapasu; awaria ensdata uruchamia ensideas', async () => {
    const missing = setup({});
    assert.deepEqual(await missing.run('live-ens', 'ens_name', 'nieistnieje.eth'), []);
    assert.equal(missing.calls.length, 1);

    const failing = setup({
      'https://api.ensdata.net/kacper.eth': { status: 502 },
      'https://api.ensideas.com/ens/resolve/kacper.eth': { body: { address: ADDR.kacperEth, name: 'kacper.eth', displayName: 'kacper.eth', avatar: null } },
    });
    const [document] = await failing.run('live-ens', 'ens_name', 'kacper.eth');
    assert.equal(failing.calls.length, 2);
    assert.deepEqual(addressesOf(document!), [ADDR.kacperEth]);
    assert.match(failing.logs.join('\n'), /kod 502/);
  });
});

describe('GitHub', () => {
  const API = 'https://api.github.com';
  const user = {
    login: 'Kacper-GH',
    html_url: 'https://github.com/Kacper-GH',
    name: 'Kacper Testowy',
    bio: 'Kontakt: kacper@poczta.example',
    company: 'Wentyl sp. z o.o.',
    location: 'Gdynia',
    blog: 'kacper.example',
    email: null,
    twitter_username: 'kacper_tw',
    created_at: '2019-01-01T00:00:00Z',
    updated_at: '2025-05-05T05:05:05Z',
  };

  test('profil, README i FUNDING.yml w 4 żądaniach; token tylko w nagłówku do api.github.com', async () => {
    const { run, calls } = setup(
      {
        [`${API}/users/kacper-gh`]: { body: user },
        [`${API}/repos/Kacper-GH/Kacper-GH/readme`]: { body: `# Cześć\nBTC: ${ADDR.kacperBtc}`, type: 'application/vnd.github.raw+json' },
        [`${API}/repos/Kacper-GH/.github/contents/FUNDING.yml`]: { body: `custom: ["${ADDR.kacperEth}"]`, type: 'application/vnd.github.raw+json' },
      },
      { githubToken: ' ghp_tajny ' },
    );
    const documents = await run('live-github', 'login', 'kacper-gh');
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.url.startsWith(`${API}/`) && call.headers.Authorization === 'Bearer ghp_tajny'));
    assert.ok(calls.every((call) => !call.url.includes('ghp_tajny')));
    assert.deepEqual(documents.map((document) => document.title), [
      'Profil GitHub: Kacper-GH',
      'README profilu Kacper-GH',
      'FUNDING.yml użytkownika Kacper-GH',
    ]);
    const [profile, readme, funding] = documents as [SourceDocument, SourceDocument, SourceDocument];
    assert.equal(profile.publishedAt, '2025-05-05T05:05:05Z');
    assert.deepEqual(profile.profile, {
      handle: 'Kacper-GH',
      displayName: 'Kacper Testowy',
      emails: ['kacper@poczta.example'],
      urls: ['https://kacper.example', 'https://x.com/kacper_tw'],
      location: 'Gdynia',
      bio: 'Kontakt: kacper@poczta.example · Firma: Wentyl sp. z o.o.',
      createdAt: '2019-01-01T00:00:00Z',
    });
    assert.deepEqual(readme.profile, profile.profile);
    assert.deepEqual(profile.discoveredIdentifiers, [
      { type: 'nick', value: 'kacper_tw' },
      { type: 'profile_url', value: 'https://kacper.example/' },
      { type: 'email', value: 'kacper@poczta.example' },
    ]);
    assert.deepEqual(addressesOf(readme), [ADDR.kacperBtc]);
    assert.deepEqual(addressesOf(funding), [ADDR.kacperEth]);
    for (const document of documents) {
      assert.equal(document.service, 'github.com');
      assert.equal(document.author, 'Kacper-GH');
      assert.equal(document.category, 'own_profile');
      assert.equal(document.identityMatch, 'exact_identifier');
    }
  });

  test('bez tokenu nie ma nagłówka Authorization; inne łączniki nigdy go nie dostają', async () => {
    const without = setup({ 'https://api.github.com/users/kacper-gh': { body: user } });
    await without.run('live-github', 'profile_url', 'https://github.com/kacper-gh');
    assert.ok(without.calls.length > 0 && without.calls.every((call) => !('Authorization' in call.headers)));

    const withToken = setup({}, { githubToken: 'ghp_tajny' });
    for (const connector of withToken.connectors) {
      for (const identifier of [
        { type: 'nick', value: 'kacper' },
        { type: 'profile_url', value: 'https://strona.example/kacper' },
        { type: 'email', value: 'kacper@poczta.example' },
      ] as Identifier[]) {
        if (connector.accepts.includes(identifier.type)) await connector.search(identifier, { log: () => undefined });
      }
    }
    for (const call of withToken.calls) {
      const sentToken = JSON.stringify(call).includes('ghp_tajny');
      assert.equal(sentToken, new URL(call.url).host === 'api.github.com', call.url);
    }
  });

  test('403/429: czytelny wpis o tokenie, jedno żądanie, pusty wynik', async () => {
    for (const status of [403, 429]) {
      const { run, calls, logs } = setup({ 'https://api.github.com/users/kacper-gh': { status, body: { message: 'API rate limit exceeded' } } });
      assert.deepEqual(await run('live-github', 'login', 'kacper-gh'), []);
      assert.equal(calls.length, 1);
      assert.match(logs.join('\n'), /limit zapytań GitHub.*ustaw GITHUB_TOKEN/);
    }
  });

  test('aktywność: imię, nazwisko i e-mail autora commitów; adresy noreply pominięte', async () => {
    const push = (name: string, email: string, count: number) => ({
      type: 'PushEvent',
      created_at: '2026-03-03T10:00:00Z',
      repo: { name: 'Kacper-GH/wentyl-ctl' },
      payload: { commits: Array.from({ length: count }, () => ({ sha: 'abc', author: { name, email } })) },
    });
    const { run, calls } = setup({
      'https://api.github.com/users/kacper-gh/events/public?per_page=100': {
        body: [
          push('Kacper Testowy', 'Kacper@Poczta.example', 3),
          push('Kacper-GH', '123+kacper-gh@users.noreply.github.com', 5),
          push('Ktoś Inny', 'inny@poczta.example', 1),
          { type: 'WatchEvent', created_at: '2026-04-01T00:00:00Z', payload: {} },
        ],
      },
    });
    const [document] = await run('live-github-activity', 'login', 'kacper-gh');
    assert.equal(calls.length, 1);
    assert.equal(document!.service, 'github.com');
    assert.equal(document!.author, 'kacper-gh');
    assert.deepEqual(document!.profile, { handle: 'kacper-gh', displayName: 'Kacper Testowy', emails: ['kacper@poczta.example'] });
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'email', value: 'kacper@poczta.example' }]);
    assert.match(document!.text, /events\/public/);
    assert.match(document!.text, /Kacper Testowy <kacper@poczta\.example> — commitów: 3/);
    assert.doesNotMatch(document!.text, /noreply/);
    assert.equal(document!.publishedAt, '2026-04-01T00:00:00Z');

    // Zdarzenia bez listy commitów (tak GitHub odpowiada coraz częściej) dają pusty wynik.
    const empty = setup({ 'https://api.github.com/users/kacper-gh/events/public?per_page=100': { body: [{ type: 'PushEvent', payload: { head: 'abc' } }] } });
    assert.deepEqual(await empty.run('live-github-activity', 'login', 'kacper-gh'), []);
    assert.match(empty.logs.join('\n'), /brak danych autora commitów/);
  });

  test('gisty: lista z opisami i treść pierwszych plików najwyżej 3 gistów', async () => {
    const gist = (id: string, description: string, content?: string) => ({
      id,
      html_url: `https://gist.github.com/Kacper-GH/${id}`,
      description,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-02-02T00:00:00Z',
      owner: { login: 'Kacper-GH' },
      files: { 'notatka.md': { filename: 'notatka.md', ...(content === undefined ? {} : { content }) } },
    });
    const { run, calls } = setup({
      'https://api.github.com/users/kacper-gh/gists?per_page=30': { body: [gist('a1', 'Wpłaty'), gist('b2', 'Skrypt'), gist('c3', ''), gist('d4', 'Czwarty')] },
      'https://api.github.com/gists/a1': { body: gist('a1', 'Wpłaty', `Wpłaty na ${ADDR.kacperBtc}`) },
      'https://api.github.com/gists/b2': { body: gist('b2', 'Skrypt', 'echo 1') },
      'https://api.github.com/gists/c3': { body: gist('c3', '', 'bez opisu') },
    });
    const documents = await run('live-github-gists', 'login', 'kacper-gh');
    assert.equal(calls.length, 4);
    assert.equal(documents.length, 4);
    assert.match(documents[0]!.text, /Czwarty/);
    assert.equal(documents[1]!.url, 'https://gist.github.com/Kacper-GH/a1');
    assert.equal(documents[1]!.publishedAt, '2024-02-02T00:00:00Z');
    assert.deepEqual(addressesOf(documents[1]!), [ADDR.kacperBtc]);
    assert.ok(documents.every((document) => document.service === 'github.com' && document.author === 'Kacper-GH'));
  });
});

describe('Mastodon / Fediwersum', () => {
  const account = {
    id: '1',
    username: 'Kacper',
    acct: 'Kacper',
    display_name: 'Kacper T.',
    note: `<p>Napiwki: ${ADDR.kacperEth}</p><p>kontakt: kacper@poczta.example</p>`,
    url: 'https://mastodon.example/@Kacper',
    created_at: '2020-03-16T00:00:00.000Z',
    fields: [
      { name: 'GitHub', value: '<a href="https://github.com/kacper-gh" rel="me nofollow noopener" target="_blank">github.com/kacper-gh</a>', verified_at: '2023-01-01T00:00:00.000+00:00' },
      { name: 'Strona', value: '<a href="https://niepotwierdzona.example">niepotwierdzona.example</a>', verified_at: null },
      { name: 'BTC', value: ADDR.kacperBtc, verified_at: null },
    ],
  };

  test('nick: sprawdzane instancje z listy; service = host instancji', async () => {
    const { run, calls } = setup({
      'https://mastodon.example/api/v1/accounts/lookup?acct=kacper': { body: account },
      'https://pl.example/api/v1/accounts/lookup?acct=kacper': { status: 404, body: { error: 'Record not found' } },
    });
    const documents = await run('live-fediverse', 'nick', '@kacper');
    assert.equal(calls.length, 2);
    assert.equal(documents.length, 1);
    const [document] = documents;
    assert.equal(document!.service, 'mastodon.example');
    assert.equal(document!.url, 'https://mastodon.example/@Kacper');
    assert.equal(document!.author, 'Kacper');
    assert.equal(document!.category, 'own_profile');
    assert.deepEqual(addressesOf(document!).sort(), [ADDR.kacperBtc, ADDR.kacperEth].sort());
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'profile_url', value: 'https://github.com/kacper-gh' },
      { type: 'email', value: 'kacper@poczta.example' },
    ]);
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.equal(document!.profile!.handle, 'Kacper');
    assert.equal(document!.profile!.displayName, 'Kacper T.');
    assert.deepEqual(document!.profile!.emails, ['kacper@poczta.example']);
    assert.deepEqual(document!.profile!.urls, ['https://github.com/kacper-gh', 'https://niepotwierdzona.example']);
    assert.equal(document!.profile!.createdAt, '2020-03-16T00:00:00.000Z');
  });

  test('nick@instancja i adres profilu: tylko wskazana instancja', async () => {
    const routes = { 'https://inna.example/api/v1/accounts/lookup?acct=Kacper': { body: { ...account, url: 'https://inna.example/@Kacper' } } };
    const byAcct = setup(routes);
    assert.equal((await byAcct.run('live-fediverse', 'nick', '@Kacper@inna.example'))[0]!.service, 'inna.example');
    assert.equal(byAcct.calls.length, 1);
    const byUrl = setup(routes);
    assert.equal((await byUrl.run('live-fediverse', 'profile_url', 'https://inna.example/@Kacper'))[0]!.service, 'inna.example');
    assert.equal(byUrl.calls.length, 1);
    // Adres, który nie wygląda na profil, nie jest odpytywany.
    assert.deepEqual(await byUrl.run('live-fediverse', 'profile_url', 'https://inna.example/blog/wpis'), []);
    assert.equal(byUrl.calls.length, 1);
  });

  test('instancja wskazana w identyfikatorze nie może być adresem prywatnym', async () => {
    const { run, calls, logs } = setup({}, { allowPrivateHosts: false });
    assert.deepEqual(await run('live-fediverse', 'nick', 'kacper@router.local'), []);
    assert.equal(calls.length, 0);
    assert.match(logs.join('\n'), /odrzucono/);
  });
});

describe('Telegram', () => {
  const message = (id: number, html: string, time: string) => `
    <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="kacper_kanal/${id}" data-view="x">
      <div class="tgme_widget_message_user"><a href="https://t.me/kacper_kanal"><i class="tgme_widget_message_user_photo"></i></a></div>
      <div class="tgme_widget_message_bubble">
        <div class="tgme_widget_message_text js-message_text" dir="auto">${html}</div>
        <div class="tgme_widget_message_footer compact js-message_footer"><div class="tgme_widget_message_info short js-message_info">
          <span class="tgme_widget_message_views">1K</span><span class="tgme_widget_message_meta"><a class="tgme_widget_message_date" href="https://t.me/kacper_kanal/${id}"><time datetime="${time}" class="time">12:00</time></a></span>
        </div></div>
      </div>
    </div></div>`;
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Kacper – Telegram</title></head><body>
    <div class="tgme_channel_info">
      <div class="tgme_channel_info_header"><div class="tgme_channel_info_header_title"><span dir="auto">Kacper sprzedaje</span></div>
      <div class="tgme_channel_info_header_username"><a href="https://t.me/kacper_kanal">@kacper_kanal</a></div></div>
      <div class="tgme_channel_info_counters"><div class="tgme_channel_info_counter"><span class="counter_value">12</span></div></div>
      <div class="tgme_channel_info_description">Koparki i części. Strona: <a href="https://kacper.example/">kacper.example</a>, drugi kanał <a href="https://t.me/inny_kanal">@inny_kanal</a></div>
    </div>
    <section class="tgme_channel_history js-message_history">
      ${message(10, 'Nowa dostawa <b>kart</b>, pytajcie.', '2025-03-01T10:00:00+00:00')}
      ${message(11, `Zaliczkę przelej na<br/>${ADDR.kacperBtc}<br/><div class="inner">do piątku</div>`, '2025-03-02T12:00:00+00:00')}
    </section></body></html>`;

  test('opis kanału jako własny profil, wiadomość z adresem jako rozliczenie', async () => {
    const { run, calls } = setup({ 'https://t.me/s/kacper_kanal': { body: page } });
    const documents = await run('live-telegram', 'messenger_id', '@kacper_kanal');
    assert.deepEqual(calls.map((call) => call.url), ['https://t.me/s/kacper_kanal']);
    assert.equal(documents.length, 2);
    const [about, settlement] = documents as [SourceDocument, SourceDocument];
    assert.equal(about.category, 'own_profile');
    assert.equal(about.service, 't.me');
    assert.equal(about.author, 'kacper_kanal');
    assert.match(about.text, /Kacper sprzedaje/);
    assert.match(about.text, /Koparki i części/);
    assert.deepEqual(about.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kacper.example/' }]);
    const expectedProfile = {
      handle: 'kacper_kanal',
      displayName: 'Kacper sprzedaje',
      urls: ['https://kacper.example/'],
      bio: 'Koparki i części. Strona: kacper.example , drugi kanał @inny_kanal',
    };
    assert.deepEqual(about.profile, expectedProfile);
    assert.deepEqual(settlement.profile, expectedProfile);
    assert.equal(settlement.category, 'settlement_message');
    assert.equal(settlement.url, 'https://t.me/kacper_kanal/11');
    assert.equal(settlement.publishedAt, '2025-03-02T12:00:00.000Z');
    assert.deepEqual(addressesOf(settlement), [ADDR.kacperBtc]);
    assert.match(settlement.text, /do piątku/);
    assert.equal(settlement.identityMatch, 'exact_identifier');
  });

  test('zapis t.me/<nazwa> i adres profilu; konto bez publicznego podglądu daje pusty wynik', async () => {
    const { run, calls, logs } = setup({
      'https://t.me/s/kacper_kanal': { body: page },
      'https://t.me/s/prywatny_ktos': { body: '<html><body><div class="tgme_page"><div class="tgme_page_title">Ktoś</div></div></body></html>' },
    });
    assert.equal((await run('live-telegram', 'messenger_id', 't.me/kacper_kanal')).length, 2);
    assert.equal((await run('live-telegram', 'profile_url', 'https://t.me/s/kacper_kanal')).length, 2);
    assert.deepEqual(await run('live-telegram', 'nick', 'prywatny_ktos'), []);
    assert.equal(calls.length, 3);
    assert.match(logs.join('\n'), /brak kanału z publicznym podglądem/);
  });
});

describe('Telegram — typowanie', () => {
  const channelPage = (name: string, id: number, text: string, time: string) => `<html><body>
    <div class="tgme_channel_info"><div class="tgme_channel_info_header_title"><span>Kanał ${name}</span></div>
    <div class="tgme_channel_info_description">Wymiana</div></div>
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${name}/${id}">
      <div class="tgme_widget_message_text">${text}</div>
      <a class="tgme_widget_message_date"><time datetime="${time}"></time></a></div></div>
    <div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="${name}/${id + 1}">
      <div class="tgme_widget_message_text">Bez adresu</div>
      <a class="tgme_widget_message_date"><time datetime="${time}"></time></a></div></div>
    </body></html>`;

  test('discover: wiadomości z adresami z kanałów z listy, od najnowszych, autor = kanał', async () => {
    const { connectors, calls } = setup(
      {
        'https://t.me/s/kanal_pierwszy': { body: channelPage('kanal_pierwszy', 5, `Wpłaty: ${ADDR.kacperBtc}`, '2026-01-01T10:00:00+00:00') },
        'https://t.me/s/kanal_drugi': { body: channelPage('kanal_drugi', 9, `USDT na ${ADDR.hubertTron}`, '2026-02-01T10:00:00+00:00') },
      },
      { telegramChannels: ['@kanal_pierwszy', 'https://t.me/kanal_drugi', 'kanal_nieistniejacy', 'zła nazwa'] },
    );
    const telegram = connectors.find((connector) => connector.id === 'live-telegram') as DiscoveringConnector;
    const logs: string[] = [];
    const documents = await telegram.discover({ log: (message) => void logs.push(message) }, 10);
    assert.equal(calls.length, 3);
    assert.deepEqual(documents.map((document) => document.url), ['https://t.me/kanal_drugi/9', 'https://t.me/kanal_pierwszy/5']);
    for (const document of documents) {
      assert.equal(document.category, 'settlement_message');
      assert.deepEqual(document.matchedIdentifier, { type: 'nick', value: document.author });
      assert.equal(document.profile!.handle, document.author);
      assert.equal(extractAddresses(document.text).length, 1);
    }
    assert.equal((await telegram.discover({ log: () => undefined }, 1)).length, 1);
  });

  test('discover: pusta lista kanałów nie powoduje żadnego żądania', async () => {
    const { connectors, calls } = setup({}, { telegramChannels: [] });
    const telegram = connectors.find((connector) => connector.id === 'live-telegram') as DiscoveringConnector;
    const logs: string[] = [];
    assert.deepEqual(await telegram.discover({ log: (message) => void logs.push(message) }, 10), []);
    assert.equal(calls.length, 0);
    assert.match(logs.join('\n'), /lista kanałów.*pusta/);
  });
});

describe('Tor — typowanie', () => {
  test('discover: tylko strony .onion z listy zawierające adresy; autor = host', async () => {
    const { fetcher, calls } = mockFetch({
      'http://targprzykladowy.onion/oferty': { body: `<html><body><p>Sprzedam, wpłata na ${ADDR.kacperBtc}</p></body></html>` },
      'http://bezadresow.onion/': { body: '<p>Nic tu nie ma</p>' },
    });
    const tor = createTorConnector('http://127.0.0.1:9', {
      fetcher,
      sources: [
        { url: 'http://targprzykladowy.onion/oferty', label: 'Targ — oferty' },
        { url: 'http://bezadresow.onion/' },
        { url: 'https://zwykla-strona.example/' },
        { url: 'http://niedostepny.onion/' },
      ],
    });
    const logs: string[] = [];
    const documents = await tor.discover({ log: (message) => void logs.push(message) }, 10);
    assert.equal(calls.length, 3);
    assert.equal(documents.length, 1);
    const [document] = documents;
    assert.equal(document!.service, 'targprzykladowy.onion');
    assert.equal(document!.author, 'targprzykladowy.onion');
    assert.deepEqual(document!.matchedIdentifier, { type: 'nick', value: 'targprzykladowy.onion' });
    assert.deepEqual(document!.profile, { handle: 'targprzykladowy.onion', urls: ['http://targprzykladowy.onion/oferty'], displayName: 'Targ — oferty' });
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.match(logs.join('\n'), /to nie jest adres \.onion/);
    assert.match(logs.join('\n'), /kod 404/);
  });
});

describe('Strona WWW', () => {
  const page = `<!doctype html><html><head><title>Kacper — strona domowa</title><meta name="author" content="Kacper Testowy">
    <script>var ukryty = "${ADDR.namesakeBtc}";</script></head><body>
    <p>Wesprzyj mnie: ${ADDR.kacperBtc}</p><p>Kontakt: tel. 500&nbsp;000&nbsp;201</p>
    <a rel="me" href="https://mastodon.example/@Kacper">Mastodon</a>
    <a href="https://github.com/kacper-gh">GitHub</a>
    <a href="https://github.com/kacper-gh/projekt/issues/1">zgłoszenie</a>
    <a href="https://twitter.com/intent/tweet?text=x">udostępnij</a>
    <a href="/kontakt">kontakt</a><a href="http://[zly">zły</a>
    </body></html>`;

  test('robots.txt, potem strona; tekst, autor i odnośniki do profili', async () => {
    const { run, calls } = setup({
      'https://www.kacper.example/robots.txt': { body: 'User-agent: *\nDisallow: /admin/\n', type: 'text/plain' },
      'https://www.kacper.example/o-mnie': { body: page },
    });
    const [document] = await run('live-www', 'profile_url', 'https://www.kacper.example/o-mnie#sekcja');
    assert.deepEqual(calls.map((call) => call.url), ['https://www.kacper.example/robots.txt', 'https://www.kacper.example/o-mnie']);
    assert.equal(document!.service, 'kacper.example');
    assert.equal(document!.title, 'Kacper — strona domowa (kacper.example)');
    assert.equal(document!.author, 'Kacper Testowy');
    assert.equal(document!.category, 'own_profile');
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'profile_url', value: 'https://mastodon.example/@Kacper' },
      { type: 'profile_url', value: 'https://github.com/kacper-gh' },
    ]);
    assert.deepEqual(document!.profile, {
      displayName: 'Kacper Testowy',
      phones: ['500000201'],
      urls: ['https://www.kacper.example/o-mnie', 'https://mastodon.example/@Kacper', 'https://github.com/kacper-gh'],
    });
  });

  test('dane właściciela: schema.org Person w JSON-LD, mailto:/tel:, og:title', async () => {
    const jsonLd = {
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebSite', name: 'Pracownia' },
        {
          '@type': ['Person', 'Thing'],
          name: 'Kacper Testowy',
          email: 'mailto:Kacper@Poczta.example',
          telephone: '+48 500 000 201',
          address: { '@type': 'PostalAddress', addressLocality: 'Bydgoszcz', addressCountry: 'PL' },
          sameAs: ['https://github.com/kacper-gh', 'https://www.kacper.example/inna-podstrona'],
          image: { '@type': 'ImageObject', url: 'https://www.kacper.example/ja.jpg' },
          description: 'Programista systemów wbudowanych.',
        },
      ],
    };
    const { run } = setup({
      'https://www.kacper.example/': {
        body: `<html><head><title>Pracownia</title><meta property="og:title" content="Pracownia Kacpra">
          <script type="application/ld+json">{ to nie jest JSON</script>
          <script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>
          <p>Zapraszam.</p><a href="mailto:biuro@kacper.example?subject=Zlecenie">napisz</a> <a href="tel:+48500000202">zadzwoń</a>
          <a href="mailto:noreply@kacper.example">automat</a></body></html>`,
      },
    });
    const [document] = await run('live-www', 'profile_url', 'https://www.kacper.example/');
    assert.equal(document!.author, 'Kacper Testowy');
    assert.deepEqual(document!.profile, {
      displayName: 'Kacper Testowy',
      emails: ['biuro@kacper.example', 'kacper@poczta.example'],
      phones: ['+48500000202', '+48500000201'],
      urls: ['https://www.kacper.example/', 'https://github.com/kacper-gh'],
      location: 'Bydgoszcz, PL',
      avatarUrl: 'https://www.kacper.example/ja.jpg',
      bio: 'Programista systemów wbudowanych.',
    });
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'email', value: 'biuro@kacper.example' },
      { type: 'email', value: 'kacper@poczta.example' },
      { type: 'profile_url', value: 'https://github.com/kacper-gh' },
    ]);

    // Bez danych osoby nazwą właściciela zostaje og:title.
    const plain = setup({ 'https://inna.example/': { body: '<html><head><meta property="og:title" content="Jan z Radomia"></head><body><p>Witam</p></body></html>' } });
    const [other] = await plain.run('live-www', 'profile_url', 'https://inna.example/');
    assert.equal(other!.profile!.displayName, 'Jan z Radomia');
    assert.equal(other!.author, 'inna.example');
  });

  test('zakaz w robots.txt, zły typ treści i awaria robots.txt kończą pustym wynikiem', async () => {
    const disallowed = setup({
      'https://kacper.example/robots.txt': { body: 'User-agent: *\nDisallow: /', type: 'text/plain' },
      'https://kacper.example/': { body: page },
    });
    assert.deepEqual(await disallowed.run('live-www', 'profile_url', 'kacper.example'), []);
    assert.equal(disallowed.calls.length, 1);
    assert.match(disallowed.logs.join('\n'), /robots\.txt nie pozwala/);

    const binary = setup({ 'https://kacper.example/zdjecie': { body: 'PNG', type: 'image/png' } });
    assert.deepEqual(await binary.run('live-www', 'profile_url', 'https://kacper.example/zdjecie'), []);
    assert.match(binary.logs.join('\n'), /typ treści/);

    const broken = setup({ 'https://kacper.example/robots.txt': { status: 503 }, 'https://kacper.example/': { body: page } });
    assert.deepEqual(await broken.run('live-www', 'profile_url', 'https://kacper.example/'), []);
    assert.equal(broken.calls.length, 1);
  });

  test('adresy prywatne są odrzucane, serwisy z własnym łącznikiem pomijane', async () => {
    const { run, calls, logs } = setup({}, { allowPrivateHosts: false });
    for (const url of ['http://127.0.0.1:4100/www/kacper', 'http://localhost/x', 'http://192.168.0.1/', 'http://[::1]/']) {
      assert.deepEqual(await run('live-www', 'profile_url', url), [], url);
    }
    assert.equal(calls.length, 0);
    assert.match(logs.join('\n'), /odrzucono/);
    for (const url of ['https://github.com/kacper-gh', 'https://t.me/kacper_kanal', 'https://mastodon.example/@Kacper', 'ftp://kacper.example/plik']) {
      assert.deepEqual(await run('live-www', 'profile_url', url), [], url);
    }
    assert.equal(calls.length, 0);
  });
});

describe('Wayback Machine', () => {
  const cdx = (target: string) =>
    `https://web.archive.org/cdx/search/cdx?output=json&fl=timestamp,original&filter=statuscode:200&collapse=digest&limit=200&url=${encodeURIComponent(target)}`;
  const rows = [
    ['timestamp', 'original'],
    ['20200101000000', 'http://kacper.example:80/o-mnie'],
    ['20210101000000', 'https://kacper.example/o-mnie'],
    ['20220101000000', 'https://kacper.example/o-mnie'],
    ['20230101000000', 'https://kacper.example/o-mnie'],
    ['20240512031400', 'https://kacper.example/o-mnie'],
  ];

  test('adres profilu: poprawny punkt CDX, kopie rozłożone w czasie, service oryginału', async () => {
    const { run, calls } = setup({
      [cdx('www.kacper.example/o-mnie')]: { body: rows },
      'https://web.archive.org/web/20200101000000id_/http://kacper.example:80/o-mnie': { body: `<p>Stary adres: ${ADDR.dominikOldBtc}</p>` },
      'https://web.archive.org/web/20220101000000id_/https://kacper.example/o-mnie': { body: '<p>W przebudowie</p>' },
      'https://web.archive.org/web/20240512031400id_/https://kacper.example/o-mnie': { body: `<p>Nowy adres: ${ADDR.dominikNewBtc}</p>` },
    });
    const documents = await run('live-wayback', 'profile_url', 'https://www.kacper.example/o-mnie/');
    assert.equal(calls.length, 4);
    assert.ok(calls[0]!.url.startsWith('https://web.archive.org/cdx/search/cdx?'));
    assert.deepEqual(documents.map((document) => document.archivedAt), ['2020-01-01T00:00:00Z', '2022-01-01T00:00:00Z', '2024-05-12T03:14:00Z']);
    assert.equal(documents[2]!.url, 'https://web.archive.org/web/20240512031400/https://kacper.example/o-mnie');
    assert.deepEqual(addressesOf(documents[0]!), [ADDR.dominikOldBtc]);
    assert.deepEqual(addressesOf(documents[2]!), [ADDR.dominikNewBtc]);
    for (const document of documents) {
      assert.equal(document.service, 'kacper.example');
      assert.equal(document.author, 'kacper.example');
      assert.equal(document.connectorId, 'live-wayback');
      assert.deepEqual(document.profile, { urls: ['https://www.kacper.example/o-mnie/'] });
    }
  });

  test('login: profil github.com/<login>; pusty indeks i odmowa dają pusty wynik', async () => {
    const found = setup({
      [cdx('github.com/kacper-gh')]: { body: [rows[0], ['20230101000000', 'https://github.com/kacper-gh']] },
      'https://web.archive.org/web/20230101000000id_/https://github.com/kacper-gh': { body: `<p>${ADDR.kacperEth}</p>` },
    });
    const [document] = await found.run('live-wayback', 'login', 'kacper-gh');
    assert.equal(document!.service, 'github.com');
    assert.equal(document!.author, 'kacper-gh');
    assert.deepEqual(document!.profile, { handle: 'kacper-gh', urls: ['https://github.com/kacper-gh'] });

    const empty = setup({ [cdx('github.com/kacper-gh')]: { body: '', type: 'text/plain' } });
    assert.deepEqual(await empty.run('live-wayback', 'nick', 'kacper-gh'), []);
    const refused = setup({ [cdx('github.com/kacper-gh')]: { status: 429 } });
    assert.deepEqual(await refused.run('live-wayback', 'nick', 'kacper-gh'), []);
    assert.match(refused.logs.join('\n'), /kod 429/);
    // Adresów lokalnych nie wysyłamy do archiwum.
    assert.deepEqual(await refused.run('live-wayback', 'profile_url', 'http://192.168.1.10/panel'), []);
    assert.equal(refused.calls.length, 1);
  });
});

describe('Bitcointalk', () => {
  const html = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=ISO-8859-1" /><title>View the profile of Jürgen</title></head><body>
    <table><tr><td><b>Name: </b></td><td>Jürgen</td></tr><tr><td><b>Posts: </b></td><td>575</td></tr>
    <tr><td><b>Position: </b></td><td>Member</td></tr>
    <tr><td><b>Date Registered: </b></td><td>February 09, 2010, 12:49:38 AM</td></tr>
    <tr><td><b>Location: </b></td><td>Wien</td></tr>
    <tr><td><b>Last Active: </b></td><td>May 12, 2024, 03:14:00 PM</td></tr>
    <tr><td><b>Website: </b></td><td><a href="https://kacper.example/" target="_blank">Moja strona</a></td></tr>
    <tr><td><b>Bitcoin address: </b></td>
        <td>${ADDR.kacperBtc}</td></tr>
    <tr><td><b>Gender: </b></td><td></td></tr>
    <tr><td colspan="2" height="25"><b>Signature:</b></td></tr>
    <tr><td colspan="2" width="100%" class="smalltext"><div class="signature">Napiwki café: ${ADDR.kacperEth}</div></td></tr></table></body></html>`;
  const url = 'https://bitcointalk.org/index.php?action=profile;u=1234';

  test('strona profilu w ISO-8859-1: pole „Bitcoin address" i podpis', async () => {
    const { run, calls } = setup({ [url]: { body: Uint8Array.from(Buffer.from(html, 'latin1')), type: 'text/html; charset=ISO-8859-1' } });
    const [document] = await run('live-bitcointalk', 'profile_url', 'https://bitcointalk.org/index.php?action=profile;u=1234;sa=summary');
    assert.deepEqual(calls.map((call) => call.url), [url]);
    assert.equal(document!.service, 'bitcointalk.org');
    assert.equal(document!.url, url);
    assert.equal(document!.author, 'Jürgen');
    assert.equal(document!.category, 'own_profile');
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.match(document!.text, new RegExp(`Bitcoin address: ${ADDR.kacperBtc}`));
    assert.match(document!.text, /Napiwki café/);
    assert.doesNotMatch(document!.text, /Posts|Gender/);
    assert.deepEqual(addressesOf(document!).sort(), [ADDR.kacperBtc, ADDR.kacperEth].sort());
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kacper.example/' }]);
    assert.deepEqual(document!.profile, {
      handle: 'Jürgen',
      urls: ['https://kacper.example/'],
      location: 'Wien',
      bio: `Napiwki café: ${ADDR.kacperEth}`,
      createdAt: '2010-02-09T00:49:38.000Z',
    });
  });

  test('tylko adresy profili; strona bez danych profilu daje pusty wynik', async () => {
    const { run, calls, logs } = setup({ 'https://bitcointalk.org/index.php?action=profile;u=7': { body: '<html><body>An Error Has Occurred!</body></html>' } });
    assert.deepEqual(await run('live-bitcointalk', 'profile_url', 'https://bitcointalk.org/index.php?topic=5.0'), []);
    assert.deepEqual(await run('live-bitcointalk', 'profile_url', 'https://inne-forum.example/index.php?action=profile;u=7'), []);
    assert.equal(calls.length, 0);
    assert.deepEqual(await run('live-bitcointalk', 'profile_url', 'https://bitcointalk.org/index.php?action=profile;u=7'), []);
    assert.match(logs.join('\n'), /brak danych profilu/);
  });
});
