// Strona WWW (konta zadeklarowane, podstrony, zaciemnione e-maile) i relacje konta GitHub (organizacje,
// obserwujący, współtwórcy). Dane fikcyjne; `fetch` jest atrapą — żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import { createGithubSocialProvider, GITHUB_SOCIAL_LIMITS } from '../src/github-social.ts';
import type { SocialGraphContext } from '../src/github-social.ts';
import { createHttpClient } from '../src/http.ts';
import type { Fetcher } from '../src/http.ts';
import { DECLARED_ONLY_NOTE, declaredAccountOf, findObfuscatedEmails, isDeclaredOnlyHost, pickSubpages } from '../src/www.ts';
import { createWwwConnector } from '../src/www.ts';
import type { AnnotatedIdentifier } from '../src/www.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
  headers?: Record<string, string>;
}

function mockFetch(routes: Record<string, Route>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const route = routes[url];
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object';
    return new Response(isJson ? JSON.stringify(route.body) : ((route.body ?? '') as string), {
      status: route.status ?? 200,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'), ...(route.headers ?? {}) },
    });
  };
  return { fetcher, calls };
}

function www(routes: Record<string, Route>) {
  const { fetcher, calls } = mockFetch(routes);
  const connector = createWwwConnector(createHttpClient({ fetcher, minIntervalMs: 0, allowPrivateHosts: true }), { skipHosts: ['mastodon.example'] });
  const logs: string[] = [];
  const run = (value: string): Promise<SourceDocument[]> => connector.search({ type: 'profile_url', value }, { log: (message) => void logs.push(message) });
  return { run, calls, logs };
}

const SITE = 'https://ola.example';
const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', name: 'Pracownia Oli', sameAs: ['https://www.linkedin.com/company/pracownia-oli/'] },
    { '@type': 'Person', name: 'Ola Przykładowa', sameAs: ['https://github.com/ola-gh'] },
  ],
};
const home = `<!doctype html><html><head><title>Ola — strona</title>
  <meta name="twitter:creator" content="@ola_tw">
  <link rel="me" href="https://mastodon.example/@ola">
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body>
  <p>Napisz: ola [at] ola-example [dot] pl</p>
  <nav><a href="/o-mnie/">O mnie</a><a href="/kontakt">Kontakt</a><a href="/projekty">Projekty</a><a href="/wsparcie">Wesprzyj</a>
  <a href="/portfolio">Portfolio</a><a href="/blog?strona=2">kontakt</a><a href="https://inna.example/kontakt">kontakt</a><a href="/cv.pdf">portfolio</a></nav>
  <footer>
    <a href="https://www.linkedin.com/in/ola-przykladowa?trk=stopka" aria-label="LinkedIn"><svg></svg></a>
    <a href="https://instagram.com/ola.foto/"><svg></svg></a>
    <a href="https://www.youtube.com/@olakanal"></a>
    <a href="https://www.tiktok.com/@ola.tt"></a>
    <a href="https://discord.gg/abcDEF12">Discord</a>
    <a href="https://t.me/ola_kanal">Telegram</a>
    <a href="https://facebook.com/sharer/sharer.php?u=x">udostępnij</a>
  </footer></body></html>`;

const routes: Record<string, Route> = {
  [`${SITE}/robots.txt`]: { body: 'User-agent: *\nDisallow: /projekty\n', type: 'text/plain' },
  [`${SITE}/`]: { body: home },
  [`${SITE}/o-mnie/`]: { body: '<html><body><p>Programistka. Zdjęcia: <a href="https://instagram.com/ola.foto">IG</a></p></body></html>' },
  [`${SITE}/kontakt`]: { body: '<html><body><p>E-mail: kontakt(at)ola-example(dot)pl</p><a href="https://www.facebook.com/ola.przykladowa">FB</a></body></html>' },
  [`${SITE}/projekty`]: { body: '<p>nie powinno być pobrane</p>' },
  [`${SITE}/wsparcie`]: { body: `<html><body><p>Wesprzyj projekt: ${ADDR.kacperBtc}</p></body></html>` },
};

describe('Strona WWW — konta zadeklarowane i podstrony', () => {
  test('konta w serwisach bez łącznika wracają z adnotacją; obsługiwane — bez niej', async () => {
    const { run, calls, logs } = www(routes);
    const [document] = await run(`${SITE}/`);
    const found = (document!.discoveredIdentifiers ?? []) as AnnotatedIdentifier[];
    const byValue = new Map(found.map((item) => [item.value, item]));
    // Obsługiwane serwisy (konto sprawdzane dalej w analizie): bez adnotacji.
    for (const value of ['https://github.com/ola-gh', 'https://mastodon.example/@ola', 'https://t.me/ola_kanal']) {
      assert.ok(byValue.has(value), value);
      assert.equal(byValue.get(value)!.note, undefined, value);
    }
    // Serwisy nieobsługiwane: adres kanoniczny (bez parametrów), adnotacja i serwis/konto.
    const declared: [string, string, string][] = [
      ['https://linkedin.com/company/pracownia-oli', 'linkedin.com', 'company/pracownia-oli'],
      ['https://x.com/ola_tw', 'x.com', 'ola_tw'],
      ['https://linkedin.com/in/ola-przykladowa', 'linkedin.com', 'in/ola-przykladowa'],
      ['https://instagram.com/ola.foto', 'instagram.com', 'ola.foto'],
      ['https://youtube.com/@olakanal', 'youtube.com', '@olakanal'],
      ['https://tiktok.com/@ola.tt', 'tiktok.com', '@ola.tt'],
      ['https://discord.gg/abcDEF12', 'discord.gg', 'abcDEF12'],
    ];
    for (const [value, host, handle] of declared) {
      const item = byValue.get(value);
      assert.ok(item, `brak ${value}`);
      assert.equal(item.type, 'profile_url');
      assert.equal(item.note, DECLARED_ONLY_NOTE);
      assert.deepEqual(item.declaredAccount, { host, handle });
    }
    assert.ok(!found.some((item) => item.value.includes('sharer')), 'odnośnik „udostępnij” to nie konto');
    // E-mail zapisany z zaciemnieniem.
    assert.ok(document!.profile!.emails!.includes('ola@ola-example.pl'));
    // Żadnego żądania do serwisów zadeklarowanych.
    assert.ok(calls.every((call) => call.url.startsWith(SITE)), calls.map((call) => call.url).join(', '));
    assert.match(logs.join('\n'), /strona deklaruje konta: .*linkedin\.com\/in\/ola-przykladowa/);
  });

  test('podstrony: najwyżej 4, ta sama witryna, bez parametrów i plików, robots.txt dla każdej; każda osobnym dokumentem', async () => {
    const { run, calls, logs } = www(routes);
    const documents = await run(`${SITE}/`);
    assert.deepEqual(
      calls.map((call) => call.url),
      [`${SITE}/robots.txt`, `${SITE}/`, `${SITE}/o-mnie/`, `${SITE}/kontakt`, `${SITE}/wsparcie`],
    );
    assert.match(logs.join('\n'), /robots\.txt nie pozwala na pobranie \/projekty; podstronę pominięto/);
    assert.deepEqual(documents.map((doc) => doc.url), [`${SITE}/`, `${SITE}/o-mnie/`, `${SITE}/kontakt`, `${SITE}/wsparcie`]);
    for (const doc of documents) {
      assert.equal(doc.category, 'own_profile');
      assert.equal(doc.author, 'Ola Przykładowa', 'ten sam właściciel — ta sama karta profilu');
      assert.equal(doc.service, 'ola.example');
      assert.deepEqual(doc.matchedIdentifier, { type: 'profile_url', value: `${SITE}/` });
    }
    const contact = documents.find((doc) => doc.url === `${SITE}/kontakt`)!;
    assert.deepEqual(contact.profile!.emails, ['kontakt@ola-example.pl']);
    const facebook = (contact.discoveredIdentifiers as AnnotatedIdentifier[]).find((item) => item.value === 'https://facebook.com/ola.przykladowa');
    assert.equal(facebook?.note, DECLARED_ONLY_NOTE);
    const support = documents.find((doc) => doc.url === `${SITE}/wsparcie`)!;
    assert.deepEqual(extractAddresses(support.text).map((item) => item.address), [ADDR.kacperBtc]);

    // Wybór podstron: limit i filtry.
    assert.deepEqual(pickSubpages(home, `${SITE}/`), [`${SITE}/o-mnie/`, `${SITE}/kontakt`, `${SITE}/projekty`, `${SITE}/wsparcie`]);
    assert.deepEqual(pickSubpages(home, `${SITE}/`, 10), [`${SITE}/o-mnie/`, `${SITE}/kontakt`, `${SITE}/projekty`, `${SITE}/wsparcie`, `${SITE}/portfolio`]);
  });

  test('podstrona wskazana wprost nie uruchamia przeglądania; konto zadeklarowane nie jest pobierane', async () => {
    const deep = www(routes);
    const documents = await deep.run(`${SITE}/kontakt`);
    assert.equal(documents.length, 1);
    assert.deepEqual(deep.calls.map((call) => call.url), [`${SITE}/robots.txt`, `${SITE}/kontakt`]);

    const declared = www({});
    for (const url of ['https://www.linkedin.com/in/ola-przykladowa', 'https://x.com/ola_tw', 'https://instagram.com/ola.foto', 'https://discord.gg/abcDEF12']) {
      assert.deepEqual(await declared.run(url), [], url);
    }
    assert.equal(declared.calls.length, 0);
    assert.match(declared.logs.join('\n'), /nieobsługiwany \(deklaracja na stronie, bez pobierania\)/);
  });

  test('rozpoznanie kont: serwisy obsługiwane i nie, ścieżki niebędące profilem', () => {
    assert.equal(isDeclaredOnlyHost('www.linkedin.com'), true);
    assert.equal(isDeclaredOnlyHost('github.com'), false);
    assert.equal(isDeclaredOnlyHost('ola.example'), false);
    assert.deepEqual(declaredAccountOf('https://github.com/ola-gh'), { host: 'github.com', handle: 'ola-gh', url: 'https://github.com/ola-gh', supported: true });
    assert.equal(declaredAccountOf('https://x.com/intent/tweet?text=x'), null);
    assert.equal(declaredAccountOf('https://www.youtube.com/watch?v=abc'), null);
    assert.equal(declaredAccountOf('https://instagram.com/p/abc123'), null);
    assert.equal(declaredAccountOf('https://ola.example/@ola', 'ola.example'), null, 'ta sama witryna');
    assert.deepEqual(declaredAccountOf('https://discord.com/invite/abc123'), { host: 'discord.com', handle: 'invite/abc123', url: 'https://discord.com/invite/abc123', supported: false });
    assert.equal(declaredAccountOf('https://stackoverflow.com/users/123/ola')?.handle, '123/ola');
  });

  test('zaciemnione e-maile: zachowawczo, tylko z nawiasami', () => {
    assert.deepEqual(findObfuscatedEmails('Pisz: ola [at] ola-example [dot] pl.'), ['ola@ola-example.pl']);
    assert.deepEqual(findObfuscatedEmails('jan (małpa) poczta (kropka) example (kropka) com'), ['jan@poczta.example.com']);
    assert.deepEqual(findObfuscatedEmails('biuro{at}firma.pl'), ['biuro@firma.pl']);
    assert.deepEqual(findObfuscatedEmails('spotkajmy się at home dot com'), []);
    assert.deepEqual(findObfuscatedEmails('cena [at] 5 zł'), []);
  });
});

// ---------- GitHub: relacje konta ----------

const API = 'https://api.github.com';
const user = (login: string, type = 'User') => ({ login, html_url: `https://github.com/${login}`, type });

function githubRoutes(): Record<string, Route> {
  const followers = Array.from({ length: 45 }, (_, index) => user(`obserwator-${index + 1}`));
  const contributors = [
    { ...user('ola-gh'), contributions: 300 },
    { ...user('dependabot[bot]', 'Bot'), contributions: 50 },
    ...Array.from({ length: 11 }, (_, index) => ({ ...user(`wspolautor-${index + 1}`), contributions: 40 - index })),
  ];
  return {
    [`${API}/users/ola-gh`]: { body: { login: 'ola-gh', html_url: 'https://github.com/ola-gh', followers: 45, following: 3, public_repos: 2 } },
    [`${API}/users/ola-gh/orgs?per_page=30`]: { body: [{ login: 'pracownia-oli', url: `${API}/orgs/pracownia-oli` }] },
    [`${API}/users/ola-gh/followers?per_page=30&page=1`]: { body: followers.slice(0, 30) },
    [`${API}/users/ola-gh/followers?per_page=30&page=2`]: { body: followers.slice(30) },
    [`${API}/users/ola-gh/following?per_page=30&page=1`]: { body: [user('wspolautor-1'), user('obserwator-45'), user('ktos-inny')] },
    [`${API}/users/ola-gh/repos?type=owner&sort=pushed&per_page=30`]: {
      body: [
        { full_name: 'ola-gh/narzedzie', html_url: 'https://github.com/ola-gh/narzedzie', fork: false, pushed_at: '2026-10-01T00:00:00Z' },
        { full_name: 'ola-gh/rozwidlenie', html_url: 'https://github.com/ola-gh/rozwidlenie', fork: true },
      ],
    },
    [`${API}/repos/ola-gh/narzedzie/contributors?per_page=10`]: { body: contributors },
  };
}

const socialContext = (budget = 100) => {
  let used = 0;
  const logs: string[] = [];
  const context: SocialGraphContext = { reserve: () => (used < budget ? (used++, true) : false), log: (message) => void logs.push(message), now: () => new Date('2026-11-22T10:00:00Z') };
  return { context, logs, used: () => used };
};

describe('GitHub — relacje konta (organizacje, obserwujący, współtwórcy)', () => {
  test('limity: najnowsi obserwujący (30), współtwórcy po 10 bez automatów, rozwidlenia pominięte; token tylko w nagłówku', async () => {
    const { fetcher, calls } = mockFetch(githubRoutes());
    const provider = createGithubSocialProvider({ fetcher, token: () => 'token-testowy' });
    const { context } = socialContext();
    const graph = (await provider.fetch('ola-gh', context))!;
    assert.deepEqual(graph.organizations, [{ login: 'pracownia-oli', url: 'https://github.com/pracownia-oli', kind: 'organization' }]);
    assert.equal(graph.followers.length, GITHUB_SOCIAL_LIMITS.followers);
    assert.equal(graph.followers[0]!.login, 'obserwator-45', 'najnowszy obserwujący pierwszy');
    assert.ok(!graph.followers.some((item) => item.login === 'obserwator-15'), 'najstarsi poza limitem');
    assert.equal(graph.following.length, 3);
    const tool = graph.repos.find((repo) => repo.fullName === 'ola-gh/narzedzie')!;
    assert.equal(tool.contributors!.length, GITHUB_SOCIAL_LIMITS.contributorsPerRepo);
    assert.ok(!tool.contributors!.some((item) => item.login.endsWith('[bot]')));
    assert.equal(tool.contributors![0]!.login, 'ola-gh');
    assert.equal(graph.repos.find((repo) => repo.fork)!.contributors, undefined);
    assert.equal(graph.requests, 7);
    assert.ok(!calls.some((call) => call.url.includes('rozwidlenie')));
    assert.ok(!calls.some((call) => call.url.includes('stargazers')), 'gwiazdek nie pobieramy');
    assert.ok(calls.every((call) => call.headers.Authorization === 'Bearer token-testowy' && call.url.startsWith(API)));
    assert.ok(graph.stops.some((stop) => stop.reason === 'limit' && /obserwujących jest 45/.test(stop.detail)));
  });

  test('limit API (403) kończy pobieranie bez ponawiania; budżet rozwinięcia jest respektowany', async () => {
    const routes = githubRoutes();
    routes[`${API}/users/ola-gh/followers?per_page=30&page=1`] = { status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } };
    const { fetcher, calls } = mockFetch(routes);
    const graph = (await createGithubSocialProvider({ fetcher }).fetch('ola-gh', socialContext().context))!;
    assert.ok(graph.stops.some((stop) => stop.reason === 'rate_limit' && /GITHUB_TOKEN/.test(stop.detail)));
    assert.equal(calls.length, 3, 'po odmowie żadnych kolejnych żądań');
    assert.ok(calls.every((call) => call.headers.Authorization === undefined), 'bez tokenu — bez nagłówka');

    const remaining = githubRoutes();
    remaining[`${API}/users/ola-gh/orgs?per_page=30`] = { body: [], headers: { 'x-ratelimit-remaining': '0' } };
    const second = mockFetch(remaining);
    const halted = (await createGithubSocialProvider({ fetcher: second.fetcher }).fetch('ola-gh', socialContext().context))!;
    assert.equal(second.calls.length, 2);
    assert.ok(halted.stops.some((stop) => /x-ratelimit-remaining: 0/.test(stop.detail)));

    const limited = mockFetch(githubRoutes());
    const budget = socialContext(2);
    const partial = (await createGithubSocialProvider({ fetcher: limited.fetcher }).fetch('ola-gh', budget.context))!;
    assert.equal(limited.calls.length, 2);
    assert.equal(budget.used(), 2);
    assert.ok(partial.stops.some((stop) => stop.reason === 'budget'));
  });

  test('nieznane konto albo zła nazwa: brak wyniku', async () => {
    const { fetcher } = mockFetch({});
    assert.equal(await createGithubSocialProvider({ fetcher }).fetch('nie/prawidlowa', socialContext().context), null);
    const graph = await createGithubSocialProvider({ fetcher }).fetch('nikt-taki', socialContext().context);
    assert.ok(graph && graph.stops.some((stop) => stop.reason === 'missing'));
  });
});
