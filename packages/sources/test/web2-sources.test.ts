// Łączniki Web2: GitLab, Codeberg, npm, PyPI, crates.io i dowody Ariadne (Keyoxide) sprawdzane na zapisanych
// kształtach odpowiedzi z danymi fikcyjnymi. `fetch` i DNS są atrapami — żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import { createCodebergConnector, createGitlabConnector, nameTokens, rankByName, searchableName } from '../src/code-hosts.ts';
import { createHttpClient } from '../src/http.ts';
import type { Fetcher } from '../src/http.ts';
import { ariadneClaims, classifyClaim, createKeyoxideConnector } from '../src/keyoxide.ts';
import { createCratesConnector, createNpmConnector, createPypiConnector, fundingEntries, repositoryUrl } from '../src/packages.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function mockFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url];
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object';
    return new Response(isJson ? JSON.stringify(route.body) : ((route.body ?? '') as string), {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8') },
    });
  };
  return { fetcher, calls };
}

function harness(routes: Record<string, Route>, build: (http: ReturnType<typeof createHttpClient>) => SourceConnector) {
  const { fetcher, calls } = mockFetch(routes);
  const connector = build(createHttpClient({ fetcher, minIntervalMs: 0 }));
  const logs: string[] = [];
  const run = (type: IdentifierType, value: string): Promise<SourceDocument[]> => {
    assert.ok(connector.accepts.includes(type), `${connector.id} nie przyjmuje ${type}`);
    return connector.search({ type, value }, { log: (message) => void logs.push(message) });
  };
  return { connector, calls, logs, run };
}

const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);
const discovered = (document: SourceDocument) => (document.discoveredIdentifiers ?? []).map((item) => `${item.type}:${item.value}`);

// ---------- GitLab ----------

describe('live-gitlab', () => {
  const API = 'https://gitlab.com/api/v4';
  const routes: Record<string, Route> = {
    [`${API}/users?username=kacper`]: { body: [{ id: 42, username: 'Kacper', name: 'Kacper Testowy', state: 'active', public_email: 'kacper@poczta.example', web_url: 'https://gitlab.com/Kacper' }] },
    [`${API}/users/42`]: {
      body: { id: 42, username: 'Kacper', name: 'Kacper Testowy', bio: 'Firmware. Kontakt: kacper.prywatny@poczta.example', website_url: 'kacper.example', github: 'kacper-gh', twitter: 'kacper_tw', location: 'Gdynia', created_at: '2020-01-02T03:04:05Z' },
    },
    [`${API}/users/42/projects?per_page=20&order_by=last_activity_at&simple=true`]: {
      body: [
        { name: 'Kacper', path: 'kacper', path_with_namespace: 'Kacper/kacper', description: 'Profil', web_url: 'https://gitlab.com/Kacper/kacper', default_branch: 'main', last_activity_at: '2026-05-06T07:08:09Z' },
        { name: 'koparka', path: 'koparka', path_with_namespace: 'Kacper/koparka', description: `Sterownik koparki. Napiwki BTC: ${ADDR.kacperBtc}`, web_url: 'https://gitlab.com/Kacper/koparka', last_activity_at: '2026-01-01T00:00:00Z' },
      ],
    },
    [`${API}/projects/Kacper%2Fkacper/repository/files/README.md/raw?ref=main`]: { body: `# Cześć\nWesprzyj projekt (ETH): ${ADDR.kacperEth}\nPoczta: kacper@poczta.example` },
  };

  test('bez tokenu: profil, projekty z opisami i README profilu; pełnego profilu nie pobiera', async () => {
    const { run, calls, connector } = harness(routes, (http) => createGitlabConnector(http));
    assert.match(connector.description, /ustaw GITLAB_TOKEN/);
    const documents = await run('nick', '@kacper');
    assert.equal(calls.length, 3);
    assert.ok(!calls.some((call) => call.url.endsWith('/users/42')), 'bez tokenu nie pytamy o pełny profil (403)');
    assert.ok(calls.every((call) => !('PRIVATE-TOKEN' in call.headers)));
    const [profile, projects, readme] = documents as [SourceDocument, SourceDocument, SourceDocument];
    assert.equal(documents.length, 3);
    assert.equal(profile.service, 'gitlab.com');
    assert.equal(profile.author, 'Kacper');
    assert.equal(profile.category, 'own_profile');
    assert.equal(profile.identityMatch, 'exact_identifier');
    assert.match(profile.text, /bez tokenu GitLab nie udostępnia bio/);
    assert.deepEqual(discovered(profile), ['email:kacper@poczta.example']);
    assert.deepEqual(addressesOf(projects), [ADDR.kacperBtc]);
    assert.equal(projects.publishedAt, '2026-05-06T07:08:09Z');
    assert.deepEqual(addressesOf(readme), [ADDR.kacperEth]);
    assert.equal(readme.url, 'https://gitlab.com/Kacper/kacper');
  });

  test('z tokenem: pełny profil (bio, strona, GitHub, X); token tylko w nagłówku do gitlab.com', async () => {
    const { run, calls, connector } = harness(routes, (http) => createGitlabConnector(http, { token: 'glpat-tajny' }));
    assert.match(connector.description, /Z tokenem GITLAB_TOKEN/);
    const [profile] = await run('profile_url', 'https://gitlab.com/kacper');
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.headers['PRIVATE-TOKEN'] === 'glpat-tajny' && new URL(call.url).host === 'gitlab.com'));
    assert.ok(!profile!.text.includes('glpat-tajny'));
    assert.match(profile!.text, /Bio: Firmware/);
    assert.deepEqual(discovered(profile!).sort(), [
      'email:kacper.prywatny@poczta.example',
      'email:kacper@poczta.example',
      'login:kacper-gh',
      'profile_url:https://github.com/kacper-gh',
      'profile_url:https://kacper.example/',
      'profile_url:https://x.com/kacper_tw',
    ]);
  });

  test('brak użytkownika i niepoprawny nick: pusty wynik; zły nick bez żadnego żądania', async () => {
    const { run, calls } = harness({ [`${API}/users?username=nikt`]: { body: [] } }, (http) => createGitlabConnector(http));
    assert.deepEqual(await run('nick', 'nikt'), []);
    assert.equal(calls.length, 1);
    assert.deepEqual(await run('nick', 'zły nick!'), []);
    assert.deepEqual(await run('profile_url', 'https://github.com/kacper'), []);
    assert.equal(calls.length, 1);
  });
});

// ---------- Codeberg ----------

describe('live-codeberg', () => {
  const API = 'https://codeberg.org/api/v1';
  test('profil, repozytoria i README z repozytorium .profile; adres noreply nie jest tropem', async () => {
    const { run, calls } = harness(
      {
        [`${API}/users/kacper`]: { body: { login: 'kacper', full_name: 'Kacper Testowy', email: 'kacper@noreply.codeberg.org', description: 'Elektronika. kacper@poczta.example', website: 'https://kacper.example', location: 'Gdynia', created: '2021-02-03T04:05:06+01:00', html_url: 'https://codeberg.org/kacper' } },
        [`${API}/users/kacper/repos?limit=20`]: {
          body: [
            { name: '.profile', full_name: 'kacper/.profile', description: '', html_url: 'https://codeberg.org/kacper/.profile', updated_at: '2026-04-01T00:00:00Z' },
            { name: 'oscyloskop', full_name: 'kacper/oscyloskop', description: `Zbiórka ETH: ${ADDR.kacperEth}`, html_url: 'https://codeberg.org/kacper/oscyloskop', updated_at: '2026-03-01T00:00:00Z' },
          ],
        },
        [`${API}/repos/kacper/.profile/raw/README.md`]: { body: `Wsparcie BTC: ${ADDR.kacperBtc}` },
      },
      (http) => createCodebergConnector(http),
    );
    const documents = await run('login', 'kacper');
    assert.equal(calls.length, 3);
    assert.equal(documents.length, 3);
    const [profile, repos, readme] = documents as [SourceDocument, SourceDocument, SourceDocument];
    assert.equal(profile.service, 'codeberg.org');
    assert.deepEqual(discovered(profile), ['email:kacper@poczta.example', 'profile_url:https://kacper.example/']);
    assert.deepEqual(addressesOf(repos), [ADDR.kacperEth]);
    assert.deepEqual(addressesOf(readme), [ADDR.kacperBtc]);
    assert.equal(readme.category, 'own_profile');
  });

  test('bez repozytorium .profile nie pyta o README', async () => {
    const { run, calls } = harness(
      {
        [`${API}/users/ola`]: { body: { login: 'ola', html_url: 'https://codeberg.org/ola' } },
        [`${API}/users/ola/repos?limit=20`]: { body: [{ name: 'notatki', full_name: 'ola/notatki' }] },
      },
      (http) => createCodebergConnector(http),
    );
    assert.equal((await run('nick', 'ola')).length, 2);
    assert.equal(calls.length, 2);
  });
});

// ---------- Imię i nazwisko (GitLab, Codeberg) ----------

describe('wyszukiwanie po imieniu i nazwisku w serwisach z kodem', () => {
  test('ranking: pełna zgodność bez diakrytyków i kolejności słów, potem nazwy z dodatkowym słowem; najwyżej 5', () => {
    assert.deepEqual(nameTokens('Żak  Łukasz-Óla'), ['zak', 'lukasz', 'ola']);
    const users = [
      { login: 'czesciowy', name: 'Łukasz Maria Żak' },
      { login: 'dokladny', name: 'ZAK lukasz' },
      { login: 'tylko-login-lukasz-zak', name: '' },
      { login: 'inny', name: 'Łukasz Nowak' },
    ];
    assert.deepEqual(rankByName(users, (user) => user.name, 'Łukasz Żak').map((entry) => [entry.item.login, entry.exact]), [
      ['dokladny', true],
      ['czesciowy', false],
    ]);
    const many = Array.from({ length: 8 }, (_, i) => ({ login: `u${i}`, name: 'Łukasz Żak' }));
    assert.equal(rankByName(many, (user) => user.name, 'Łukasz Żak').length, 5);
    assert.equal(searchableName({ type: 'full_name', value: 'Łukasz' }), null);
    assert.equal(searchableName({ type: 'full_name', value: 'Łukasz <script>' }), null);
    assert.equal(searchableName({ type: 'nick', value: 'Łukasz Żak' }), null);
  });

  test('Codeberg: /users/search, dokumenty name_only, konto zgodne tylko loginem odpada', async () => {
    const { run, calls } = harness(
      {
        'https://codeberg.org/api/v1/users/search?q=%C5%81ukasz%20%C5%BBak&limit=20': {
          body: {
            data: [
              { login: 'lukaszzak', full_name: '', html_url: 'https://codeberg.org/lukaszzak' },
              { login: 'lzak', full_name: 'Żak Łukasz', description: `Napiwki BTC: ${ADDR.kacperBtc}`, website: 'zak.example', email: 'lzak@noreply.codeberg.org', html_url: 'https://codeberg.org/lzak' },
            ],
          },
        },
      },
      (http) => createCodebergConnector(http),
    );
    const documents = await run('full_name', 'Łukasz Żak');
    assert.equal(calls.length, 1);
    assert.equal(documents.length, 1);
    const [document] = documents as [SourceDocument];
    assert.equal(document.author, 'lzak');
    assert.equal(document.identityMatch, 'name_only');
    assert.equal(document.category, 'own_profile');
    assert.match(document.text, /możliwy|imiennik/);
    assert.deepEqual(addressesOf(document), [ADDR.kacperBtc]);
    assert.deepEqual(discovered(document), ['profile_url:https://zak.example/']);
  });

  test('GitLab: bez tokenu imię i nazwisko nie jest przyjmowane (403 bez logowania); z tokenem — /users?search=', async () => {
    const plain = harness({}, (http) => createGitlabConnector(http));
    assert.ok(!plain.connector.accepts.includes('full_name'));
    assert.deepEqual(await plain.connector.search({ type: 'full_name', value: 'Łukasz Żak' }, { log: () => undefined }), []);
    assert.equal(plain.calls.length, 0);

    const { run, calls } = harness(
      { 'https://gitlab.com/api/v4/users?search=%C5%81ukasz%20%C5%BBak&per_page=20': { body: [{ id: 1, username: 'lzak', name: 'Łukasz Żak', state: 'active', web_url: 'https://gitlab.com/lzak' }, { id: 2, username: 'ktos', name: 'Łukasz Nowak', state: 'active' }] } },
      (http) => createGitlabConnector(http, { token: 'glpat-tajny' }),
    );
    const documents = await run('full_name', 'Łukasz Żak');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers['PRIVATE-TOKEN'], 'glpat-tajny');
    assert.deepEqual(documents.map((doc) => [doc.author, doc.identityMatch]), [['lzak', 'name_only']]);
  });
});

// ---------- npm ----------

describe('live-npm', () => {
  const REG = 'https://registry.npmjs.org';
  const manifest = {
    name: 'kacper-tools',
    version: '1.4.0',
    description: 'Narzędzia do koparek',
    author: { name: 'Kacper Testowy', email: 'kacper@poczta.example' },
    maintainers: [{ name: 'kacper', email: 'kacper@poczta.example' }],
    repository: { type: 'git', url: 'git+https://github.com/kacper-gh/kacper-tools.git' },
    homepage: 'https://kacper.example/narzedzia',
    funding: [{ type: 'individual', url: 'https://kacper.example/wesprzyj' }, `BTC ${ADDR.kacperBtc}`],
    readme: `# kacper-tools\nDarowizny ETH: ${ADDR.kacperEth}\nKontakt: kacper@poczta.example`,
    _npmUser: { name: 'kacper', email: 'kacper@poczta.example' },
  };

  test('konto: tylko pakiety, których jest opiekunem; pole funding i README z adresami; bez e-maili i imion', async () => {
    const { run, calls } = harness(
      {
        [`${REG}/-/v1/search?text=maintainer%3Akacper&size=20`]: {
          body: {
            objects: [
              { package: { name: 'kacper-tools', description: 'Narzędzia', date: '2026-02-03T00:00:00Z', maintainers: [{ username: 'kacper', email: 'kacper@poczta.example' }] } },
              { package: { name: 'cudzy-pakiet', description: 'Nie jego', maintainers: [{ username: 'kacperek' }] } },
            ],
          },
        },
        [`${REG}/kacper-tools/latest`]: { body: manifest },
      },
      (http) => createNpmConnector(http),
    );
    const documents = await run('nick', 'kacper');
    assert.deepEqual(calls.map((call) => call.url), [`${REG}/-/v1/search?text=maintainer%3Akacper&size=20`, `${REG}/kacper-tools/latest`]);
    assert.equal(documents.length, 2);
    const [list, pkg] = documents as [SourceDocument, SourceDocument];
    assert.ok(!list.text.includes('cudzy-pakiet'));
    assert.equal(pkg.author, 'kacper');
    assert.equal(pkg.category, 'own_profile');
    assert.equal(pkg.identityMatch, 'exact_identifier');
    assert.equal(pkg.publishedAt, '2026-02-03T00:00:00Z');
    assert.match(pkg.text, /Finansowanie \(pole „funding”\):\n- individual: https:\/\/kacper\.example\/wesprzyj/);
    assert.deepEqual(addressesOf(pkg).sort(), [ADDR.kacperBtc, ADDR.kacperEth].sort());
    // Regulamin npm (pkt 4): e-maile i imiona autorów nie są kopiowane do metadanych śladu.
    assert.ok(!/Kacper Testowy/.test(pkg.text));
    assert.ok(!pkg.text.split('README:')[0]!.includes('kacper@poczta.example'));
    assert.ok(!discovered(pkg).some((item) => item.startsWith('email:')));
    assert.deepEqual(discovered(pkg), ['profile_url:https://github.com/kacper-gh/kacper-tools', 'profile_url:https://kacper.example/narzedzia', 'profile_url:https://kacper.example/wesprzyj']);
  });

  test('adres pakietu (także z zakresem @): metadane i nazwy kont opiekunów jako tropy', async () => {
    const { run, calls } = harness({ [`${REG}/@kacper%2Fnarzedzia/latest`]: { body: { ...manifest, name: '@kacper/narzedzia' } } }, (http) => createNpmConnector(http));
    const [document] = await run('profile_url', 'https://www.npmjs.com/package/@kacper/narzedzia');
    assert.equal(calls.length, 1);
    assert.equal(document!.url, 'https://www.npmjs.com/package/@kacper/narzedzia');
    assert.ok(discovered(document!).includes('nick:kacper'));
  });

  test('pomocnicze: adres repozytorium i pole funding w różnych postaciach', () => {
    assert.equal(repositoryUrl('github:kacper-gh/x'), 'https://github.com/kacper-gh/x');
    assert.equal(repositoryUrl('kacper-gh/x'), 'https://github.com/kacper-gh/x');
    assert.equal(repositoryUrl({ url: 'git@gitlab.com:kacper/x.git' }), 'https://gitlab.com/kacper/x');
    assert.equal(repositoryUrl('file:../x'), null);
    assert.deepEqual(fundingEntries(['https://a.example', { type: 'patreon', url: 'https://patreon.com/k' }, { type: 'x' }]), ['https://a.example', 'patreon: https://patreon.com/k']);
  });
});

// ---------- PyPI ----------

describe('live-pypi', () => {
  test('tylko adres projektu; odnośnik Funding, e-mail autora, README z adresem; User-Agent z kontaktem', async () => {
    const { run, calls, connector } = harness(
      {
        'https://pypi.org/pypi/kacper-tools/json': {
          body: {
            info: {
              name: 'kacper-tools',
              version: '0.9.1',
              summary: 'Narzędzia do koparek',
              author: 'Kacper Testowy',
              author_email: 'Kacper Testowy <kacper@poczta.example>',
              project_urls: { Funding: 'https://kacper.example/wesprzyj', Source: 'https://github.com/kacper-gh/kacper-tools', PyPI: 'https://pypi.org/project/kacper-tools/' },
              description: `Wesprzyj autora: BTC ${ADDR.kacperBtc}`,
            },
            urls: [{ upload_time_iso_8601: '2026-03-04T05:06:07.000Z' }],
          },
        },
      },
      (http) => createPypiConnector(http, { contact: 'zespol@example.org' }),
    );
    assert.deepEqual(connector.accepts, ['profile_url']);
    const [document] = await run('profile_url', 'https://pypi.org/project/kacper-tools/');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers['User-Agent'], 'OLCyS-research/0.1 (zespol@example.org)');
    assert.equal(document!.service, 'pypi.org');
    assert.equal(document!.author, 'Kacper Testowy');
    assert.equal(document!.publishedAt, '2026-03-04T05:06:07.000Z');
    assert.match(document!.text, /Finansowanie:\n- Funding: https:\/\/kacper\.example\/wesprzyj/);
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.deepEqual(discovered(document!), ['email:kacper@poczta.example', 'profile_url:https://kacper.example/wesprzyj', 'profile_url:https://github.com/kacper-gh/kacper-tools']);
    // Adres spoza pypi.org i strona użytkownika nie prowadzą do zapytania.
    assert.deepEqual(await run('profile_url', 'https://pypi.org/user/kacper/'), []);
    assert.deepEqual(await run('profile_url', 'https://example.org/project/x/'), []);
    assert.equal(calls.length, 1);
  });
});

// ---------- crates.io ----------

describe('live-crates', () => {
  const API = 'https://crates.io/api/v1';
  test('konto: lista skrzynek właściciela; User-Agent z kontaktem', async () => {
    const { run, calls } = harness(
      {
        [`${API}/users/kacper-gh`]: { body: { user: { id: 7, login: 'kacper-gh', name: 'Kacper', url: 'https://github.com/kacper-gh' } } },
        [`${API}/crates?user_id=7&per_page=20`]: { body: { crates: [{ name: 'koparka', description: `Sterownik. ETH: ${ADDR.kacperEth}`, repository: 'https://github.com/kacper-gh/koparka', updated_at: '2026-01-02T00:00:00Z' }] } },
      },
      (http) => createCratesConnector(http, { contact: 'zespol@example.org' }),
    );
    const [document] = await run('login', 'kacper-gh');
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.headers['User-Agent'] === 'OLCyS-research/0.1 (zespol@example.org)'));
    assert.equal(document!.identityMatch, 'exact_identifier');
    assert.equal(document!.author, 'kacper-gh');
    assert.deepEqual(addressesOf(document!), [ADDR.kacperEth]);
    assert.deepEqual(discovered(document!), ['profile_url:https://github.com/kacper-gh']);
  });

  test('adres skrzynki: metadane, właściciele (bez zespołów jako osób) i README z adresem', async () => {
    const { run, calls } = harness(
      {
        [`${API}/crates/koparka`]: { body: { crate: { name: 'koparka', description: 'Sterownik', max_version: '1.2.0', repository: 'https://github.com/kacper-gh/koparka', updated_at: '2026-01-02T00:00:00Z' } } },
        [`${API}/crates/koparka/owners`]: { body: { users: [{ login: 'kacper-gh', kind: 'user', name: 'Kacper', url: 'https://github.com/kacper-gh' }, { login: 'github:rust-pl:zespol', kind: 'team' }] } },
        [`${API}/crates/koparka/1.2.0/readme`]: { body: `<p>Darowizny BTC: <code>${ADDR.kacperBtc}</code></p>`, type: 'text/html' },
      },
      (http) => createCratesConnector(http),
    );
    const [document] = await run('profile_url', 'https://crates.io/crates/koparka');
    assert.equal(calls.length, 3);
    assert.equal(document!.author, 'kacper-gh');
    assert.match(document!.text, /Właściciele: kacper-gh, github:rust-pl:zespol \(zespół\)/);
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.ok(discovered(document!).includes('login:kacper-gh'));
    assert.ok(!discovered(document!).some((item) => item.includes('zespol')));
  });
});

// ---------- Keyoxide / Ariadne ----------

/** Pakiet OpenPGP w nowym formacie. */
function packet(tag: number, body: Buffer): Buffer {
  const length = body.length < 192 ? Buffer.from([body.length]) : Buffer.from([((body.length - 192) >> 8) + 192, (body.length - 192) & 0xff]);
  return Buffer.concat([Buffer.from([0xc0 | tag]), length, body]);
}

function subpacket(type: number, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from([data.length + 1, type]), data]);
}

function notation(name: string, value: string): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0x80000000, 0);
  header.writeUInt16BE(Buffer.byteLength(name), 4);
  header.writeUInt16BE(Buffer.byteLength(value), 6);
  return subpacket(20, Buffer.concat([header, Buffer.from(name), Buffer.from(value)]));
}

/** Podpis v4 certyfikujący identyfikator: podpakiety haszowane i niehaszowane. */
function signature(created: number, hashed: Buffer[], unhashed: Buffer[] = []): Buffer {
  const time = Buffer.alloc(4);
  time.writeUInt32BE(created, 0);
  const hashedArea = Buffer.concat([subpacket(2, time), ...hashed]);
  const unhashedArea = Buffer.concat(unhashed);
  const lengths = Buffer.alloc(2);
  lengths.writeUInt16BE(hashedArea.length, 0);
  const unhashedLength = Buffer.alloc(2);
  unhashedLength.writeUInt16BE(unhashedArea.length, 0);
  return packet(2, Buffer.concat([Buffer.from([4, 0x13, 22, 8]), lengths, hashedArea, unhashedLength, unhashedArea, Buffer.from([0xab, 0xcd, 0x00, 0x08, 0x01])]));
}

function testKey(claims: string[], olderClaims: string[], unhashedClaims: string[]) {
  const keyBody = Buffer.concat([Buffer.from([4, 0x65, 0x00, 0x00, 0x00, 22]), Buffer.from('fikcyjny-material-klucza-publicznego')]);
  const fingerprint = createHash('sha1').update(Buffer.from([0x99, (keyBody.length >> 8) & 0xff, keyBody.length & 0xff])).update(keyBody).digest('hex').toUpperCase();
  const issuer = subpacket(33, Buffer.concat([Buffer.from([4]), Buffer.from(fingerprint, 'hex')]));
  const bytes = Buffer.concat([
    packet(6, keyBody),
    packet(13, Buffer.from('Kacper Testowy <kacper@poczta.example>')),
    // Starszy podpis z wycofaną deklaracją — zastąpiony przez nowszy.
    signature(1_700_000_000, [issuer, ...olderClaims.map((uri) => notation('proof@ariadne.id', uri))]),
    signature(1_750_000_000, [issuer, ...claims.map((uri) => notation('proof@ariadne.id', uri))], unhashedClaims.map((uri) => notation('proof@ariadne.id', uri))),
  ]);
  const base64 = bytes.toString('base64').match(/.{1,64}/g)!.join('\n');
  return { fingerprint, armored: `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${base64}\n=abcd\n-----END PGP PUBLIC KEY BLOCK-----\n` };
}

describe('live-keyoxide', () => {
  const claims = [
    'https://gist.github.com/kacper-gh/0123abcd',
    'https://codeberg.org/kacper/forgejo_proof',
    'https://gitlab.com/kacper-gl/gitlab_proof',
    'dns:kacper.example?type=TXT',
    'https://mastodon.example/@kacper',
  ];
  const { fingerprint, armored } = testKey(claims, ['https://gist.github.com/stary-login/ffff'], ['https://gist.github.com/podrzucony/eeee']);
  const fpr = `openpgp4fpr:${fingerprint.toLowerCase()}`;
  const KOO = 'https://keys.openpgp.org/vks/v1';
  const routes: Record<string, Route> = {
    [`${KOO}/by-email/kacper%40poczta.example`]: { body: armored, type: 'application/pgp-keys' },
    [`${KOO}/by-fingerprint/${fingerprint}`]: { body: armored, type: 'application/pgp-keys' },
    'https://api.github.com/gists/0123abcd': { body: { owner: { login: 'kacper-gh' }, files: { 'openpgp.md': { content: `[Verifying my OpenPGP key: ${fpr}]` } } } },
    // Repozytorium istnieje, ale nie publikuje odcisku — deklaracja jednostronna.
    'https://codeberg.org/api/v1/repos/kacper/forgejo_proof': { body: { owner: { login: 'kacper' }, description: 'mój klucz wkrótce' } },
    'https://gitlab.com/api/v4/projects/kacper-gl%2Fgitlab_proof': { body: { path_with_namespace: 'kacper-gl/gitlab_proof', description: `[Verifying my OpenPGP key: ${fpr}]` } },
  };
  const resolveTxt = async (domain: string) => (domain === 'kacper.example' ? [['v=spf1 -all'], [fpr]] : []);

  test('odczyt deklaracji: tylko najnowszy podpis i tylko podpakiety objęte podpisem', () => {
    const parsed = ariadneClaims(armored);
    assert.equal(parsed.fingerprint, fingerprint);
    assert.deepEqual(parsed.claims.map((claim) => claim.uri), claims);
    assert.equal(parsed.claims[0]!.userId, 'Kacper Testowy <kacper@poczta.example>');
    assert.equal(classifyClaim({ uri: 'https://gist.github.com/kacper-gh/0123abcd', userId: '' }).kind, 'github');
    assert.equal(classifyClaim({ uri: 'xmpp:kacper@jabber.example', userId: '' }).kind, 'other');
    assert.equal(classifyClaim({ uri: 'dns:zła_domena', userId: '' }).kind, 'other');
  });

  test('potwierdzone w obie strony → verified_link; niepotwierdzone i niesprawdzone → słabe tropy', async () => {
    const { run, calls } = harness(routes, (http) => createKeyoxideConnector(http, { resolveTxt }));
    const documents = await run('email', 'Kacper@Poczta.example');
    assert.deepEqual(calls.map((call) => call.url), [
      `${KOO}/by-email/kacper%40poczta.example`,
      'https://api.github.com/gists/0123abcd',
      'https://codeberg.org/api/v1/repos/kacper/forgejo_proof',
      'https://gitlab.com/api/v4/projects/kacper-gl%2Fgitlab_proof',
    ]);
    assert.ok(!calls.some((call) => call.url.includes('keyoxide.org')), 'API keyoxide.org nie jest używane');
    const [main, ...proofs] = documents as [SourceDocument, ...SourceDocument[]];
    assert.equal(main.identityMatch, 'exact_identifier');
    assert.equal(main.category, 'own_profile');
    assert.match(main.text, /forgejo_proof — NIEPOTWIERDZONA/);
    assert.match(main.text, /mastodon\.example\/@kacper — niesprawdzona/);
    assert.match(main.text, /Sprawdzono lokalnie: 3 potwierdzonych z 5 deklaracji/);
    assert.ok(!main.text.includes('stary-login') && !main.text.includes('podrzucony'));
    assert.deepEqual(discovered(main), ['profile_url:https://codeberg.org/kacper', 'profile_url:https://mastodon.example/@kacper']);

    assert.deepEqual(proofs.map((doc) => [doc.service, doc.author, doc.identityMatch, doc.category]), [
      ['github.com', 'kacper-gh', 'verified_link', 'cryptographic_proof'],
      ['gitlab.com', 'kacper-gl', 'verified_link', 'cryptographic_proof'],
      ['kacper.example', 'kacper.example', 'verified_link', 'cryptographic_proof'],
    ]);
    assert.deepEqual(discovered(proofs[0]!), ['profile_url:https://github.com/kacper-gh']);
    assert.equal(proofs[0]!.url, 'https://gist.github.com/kacper-gh/0123abcd');
    assert.match(proofs[2]!.text, /Rekord DNS TXT domeny kacper\.example/);
  });

  test('gist innego właściciela nie potwierdza konta; odcisk jako identyfikator; brak klucza bez dalszych zapytań', async () => {
    const stolen = { ...routes, 'https://api.github.com/gists/0123abcd': { body: { owner: { login: 'ktos-inny' }, files: { a: { content: fpr } } } } };
    const { run, calls } = harness(stolen, (http) => createKeyoxideConnector(http, { resolveTxt: async () => [] }));
    const documents = await run('login', fpr);
    assert.equal(calls[0]!.url, `${KOO}/by-fingerprint/${fingerprint}`);
    // Tylko GitLab potwierdzony; GitHub (cudzy gist), Codeberg i DNS — nie.
    assert.deepEqual(documents.slice(1).map((doc) => doc.author), ['kacper-gl']);
    assert.match(documents[0]!.text, /gist\.github\.com\/kacper-gh\/0123abcd — NIEPOTWIERDZONA/);

    const empty = harness({}, (http) => createKeyoxideConnector(http, { resolveTxt }));
    assert.deepEqual(await empty.run('email', 'nikt@poczta.example'), []);
    assert.equal(empty.calls.length, 1);
    assert.deepEqual(await empty.run('login', 'kacper'), []);
    assert.deepEqual(await empty.run('email', 'to nie e-mail'), []);
    assert.equal(empty.calls.length, 1);
  });

  test('klucz bez deklaracji Ariadne: pusty wynik i wpis w dzienniku', async () => {
    const plain = testKey([], [], []);
    const { run, logs } = harness({ [`${KOO}/by-email/ola%40poczta.example`]: { body: plain.armored } }, (http) => createKeyoxideConnector(http, { resolveTxt }));
    assert.deepEqual(await run('email', 'ola@poczta.example'), []);
    assert.match(logs.join('\n'), /nie zawiera deklaracji proof@ariadne\.id/);
  });
});
