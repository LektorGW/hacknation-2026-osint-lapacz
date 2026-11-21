// Nowe łączniki do źródeł otwartych (Bluesky, Nostr NIP-05, keys.openpgp.org, wykaz podatników VAT, KRS,
// Bitcointalk po nicku) sprawdzane na zapisanych kształtach odpowiedzi z danymi fikcyjnymi.
// `fetch` jest atrapą — żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import { createTestWallet, signBitcoinMessage } from '../../core/test/signing-helpers.ts';
import type { Fetcher } from '../src/http.ts';
import { createConnectors, findRegistryNumbers, isValidNip, isValidNrb, registryNumber, withRegistryIdentifiers } from '../src/index.ts';
import type { SourcesConfig } from '../src/index.ts';
import { npubOf } from '../src/nostr.ts';
import { parseArmoredKey } from '../src/openpgp.ts';
import { VAT_DAILY_LIMIT } from '../src/registry.ts';

interface Route {
  status?: number;
  body?: string | object;
  type?: string;
  headers?: Record<string, string>;
}

function setup(routes: Record<string, Route>, config: Partial<SourcesConfig> = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } });
    const isJson = typeof route.body === 'object';
    const status = route.status ?? 200;
    return new Response(status >= 300 && status < 400 ? null : isJson ? JSON.stringify(route.body) : (route.body as string), {
      status,
      headers: { 'content-type': route.type ?? (isJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8'), ...route.headers },
    });
  };
  const logs: string[] = [];
  const connectors = createConnectors({ enableLive: true, fetcher, minRequestIntervalMs: 0, allowPrivateHosts: true, fediverseInstances: ['mastodon.example'], monitorSources: [], nostrRelays: [], ...config });
  const run = (id: string, type: IdentifierType, value: string): Promise<SourceDocument[]> => {
    const connector = connectors.find((item) => item.id === id) as SourceConnector;
    assert.ok(connector, `brak łącznika ${id}`);
    assert.ok(connector.accepts.includes(type), `${id} nie przyjmuje ${type}`);
    return connector.search({ type, value }, { log: (message) => void logs.push(message) });
  };
  return { connectors, calls, logs, run };
}

const addressesOf = (document: SourceDocument) => extractAddresses(document.text).map((found) => found.address);
const today = new Date().toISOString().slice(0, 10);

// ---------- Bluesky ----------

describe('live-bluesky', () => {
  const API = 'https://public.api.bsky.app/xrpc';
  const did = 'did:plc:abcdefghijklmnopqrstuvwx';
  const profile = {
    did,
    handle: 'kacper-dev.bsky.social',
    displayName: 'Kacper (dev)',
    avatar: 'https://cdn.bsky.app/img/avatar/plain/x/y',
    createdAt: '2024-02-03T10:11:12.000Z',
    description: `Firmware i koparki. Napiwki ETH: ${ADDR.kacperEth}\nKontakt: kacper@poczta.example, strona https://kacper.example/o-mnie.`,
  };
  const post = (rkey: string, text: string, extra: object = {}) => ({
    post: { uri: `at://${did}/app.bsky.feed.post/${rkey}`, author: { did, handle: profile.handle }, record: { text, createdAt: '2026-03-04T05:06:07.000Z' } },
    ...extra,
  });
  const feed = {
    feed: [
      post('3aaa', 'Dzień dobry, dziś o regulatorach PID.'),
      post('3bbb', `Zbiórka na nowy oscyloskop, BTC: ${ADDR.kacperBtc}`),
      // Wpis podany dalej: autor inny niż właściciel konta.
      { post: { uri: 'at://did:plc:zzzzzzzzzzzzzzzzzzzzzzzz/app.bsky.feed.post/3ccc', author: { did: 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz', handle: 'ktos.bsky.social' }, record: { text: `Wpłaty: ${ADDR.namesakeBtc}` } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } },
      post('3ddd', 'Adres w odnośniku', { }),
    ],
  };
  // Czwarty wpis: adres tylko w pełnym odnośniku (facet), w treści skrócony.
  (feed.feed[3] as { post: { record: Record<string, unknown> } }).post.record.facets = [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: `https://etherscan.io/address/${ADDR.martaEth}` }] }];
  const routes = {
    [`${API}/app.bsky.actor.getProfile?actor=kacper-dev.bsky.social`]: { body: profile },
    [`${API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=30&filter=posts_no_replies`]: { body: feed },
  };

  test('nick bez domeny → <nick>.bsky.social: profil i własne wpisy z adresami, bez wpisów podanych dalej', async () => {
    const { run, calls } = setup(routes);
    const documents = await run('live-bluesky', 'nick', 'kacper-dev');
    assert.deepEqual(calls, Object.keys(routes));
    assert.deepEqual(documents.map((d) => d.url), [
      'https://bsky.app/profile/kacper-dev.bsky.social',
      'https://bsky.app/profile/kacper-dev.bsky.social/post/3bbb',
      'https://bsky.app/profile/kacper-dev.bsky.social/post/3ddd',
    ]);
    assert.ok(documents.every((d) => d.service === 'bsky.app' && d.category === 'own_profile' && d.author === 'kacper-dev.bsky.social' && d.identityMatch === 'exact_identifier'));
    assert.deepEqual(addressesOf(documents[0]!), [ADDR.kacperEth]);
    assert.deepEqual(addressesOf(documents[1]!), [ADDR.kacperBtc]);
    assert.deepEqual(addressesOf(documents[2]!), [ADDR.martaEth]);
    assert.equal(documents[1]!.publishedAt, '2026-03-04T05:06:07.000Z');
    assert.deepEqual(documents[0]!.profile, {
      handle: 'kacper-dev.bsky.social',
      displayName: 'Kacper (dev)',
      emails: ['kacper@poczta.example'],
      avatarUrl: profile.avatar,
      bio: profile.description,
      createdAt: '2024-02-03T10:11:12.000Z',
    });
    assert.deepEqual(documents[0]!.discoveredIdentifiers, [
      { type: 'email', value: 'kacper@poczta.example' },
      { type: 'profile_url', value: 'https://kacper.example/o-mnie' },
    ]);
  });

  test('adres profilu i własna domena jako nazwa konta; nieistniejące konto i niepoprawne nazwy bez żądań', async () => {
    const own = { ...profile, handle: 'kacper.example', description: '' };
    const { run, calls, logs } = setup({
      [`${API}/app.bsky.actor.getProfile?actor=kacper.example`]: { body: own },
      [`${API}/app.bsky.actor.getProfile?actor=nikt.bsky.social`]: { status: 400, body: { error: 'InvalidRequest', message: 'Profile not found' } },
    });
    const [document] = await run('live-bluesky', 'profile_url', 'https://bsky.app/profile/kacper.example');
    assert.equal(document!.url, 'https://bsky.app/profile/kacper.example');
    // Nazwa konta będąca domeną jest potwierdzona przez protokół — domena trafia do dalszego sprawdzenia.
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kacper.example/' }]);
    assert.deepEqual(await run('live-bluesky', 'nick', 'nikt'), []);
    assert.match(logs.join('\n'), /brak konta nikt\.bsky\.social/);
    const before = calls.length;
    assert.deepEqual(await run('live-bluesky', 'nick', 'z_podkresleniem'), []);
    assert.deepEqual(await run('live-bluesky', 'profile_url', 'https://inny-serwis.example/profile/kacper.example'), []);
    assert.deepEqual(await run('live-bluesky', 'nick', 'ktos@mastodon.example'), []);
    assert.equal(calls.length, before);
  });

  test('wpis z podpisaną wiadomością wymieniającą konto → dodatkowy dokument-dowód', async () => {
    const wallet = createTestWallet();
    const message = 'kacper-dev.bsky.social to moje konto';
    const signature = signBitcoinMessage(wallet.privateKey, message, 'p2wpkh');
    const signed = { feed: [post('3sig', `Address: ${wallet.p2wpkh}\nMessage: ${message}\nSignature: ${signature}`)] };
    const { run } = setup({ ...routes, [Object.keys(routes)[1]!]: { body: signed } });
    const documents = await run('live-bluesky', 'nick', 'kacper-dev');
    assert.deepEqual(documents.map((d) => d.category), ['own_profile', 'own_profile', 'cryptographic_proof']);
    assert.equal(documents[2]!.url, `https://bsky.app/profile/kacper-dev.bsky.social/post/3sig?podpis=${wallet.p2wpkh}`);
  });
});

// ---------- Nostr ----------

describe('live-nostr', () => {
  const pubkey = '82341f882b6eabcd2ba7f1ef90aad961cf074af15b9ef44a09f9d2a8fbfbe6a2';
  const url = 'https://nostr-dom.example/.well-known/nostr.json?name=kacper';

  test('npub wg NIP-19 — wektor ze specyfikacji', () => {
    // NIP-19: klucz 3bf0c63f… ↔ npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6.
    assert.equal(npubOf('3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'), 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6');
  });

  test('NIP-05: nazwa@domena → klucz publiczny; bez przekaźników profil nie jest pobierany', async () => {
    const relayCalls: string[] = [];
    const { run, calls } = setup({ [url]: { body: { names: { Kacper: pubkey.toUpperCase() }, relays: {} } } }, { nostrRelayQuery: async (relay) => (relayCalls.push(relay), null) });
    const [document, ...rest] = await run('live-nostr', 'messenger_id', 'kacper@nostr-dom.example');
    assert.equal(rest.length, 0);
    assert.deepEqual(calls, [url]);
    assert.deepEqual(relayCalls, []);
    assert.deepEqual([document!.service, document!.url, document!.author, document!.category], ['nostr-dom.example', url, 'kacper@nostr-dom.example', 'own_profile']);
    assert.ok(document!.text.includes(npubOf(pubkey)) && document!.text.includes(pubkey));
    assert.match(document!.text, /nie został pobrany/);
    assert.deepEqual(document!.profile, { handle: 'kacper@nostr-dom.example' });
  });

  test('przekaźnik wskazany przez operatora: profil kind 0 z adresem, stroną i potwierdzeniem dwustronnym', async () => {
    const asked: [string, string][] = [];
    const { run } = setup(
      { [url]: { body: { names: { kacper: pubkey } } } },
      {
        nostrRelays: ['wss://przekaznik.example', 'http://nie-wss.example', 'wss://drugi.example'],
        nostrRelayQuery: async (relay, key) => {
          asked.push([relay, key]);
          return { name: 'kacper', about: `Koparki. BTC: ${ADDR.kacperBtc}`, website: 'kacper.example', lud16: 'kacper@portfel.example', nip05: 'kacper@nostr-dom.example' };
        },
      },
    );
    const [document] = await run('live-nostr', 'nick', 'kacper@nostr-dom.example');
    assert.deepEqual(asked, [['wss://przekaznik.example', pubkey]]);
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
    assert.match(document!.text, /Adres Lightning \(lud16\): kacper@portfel\.example/);
    assert.match(document!.text, /potwierdzenie dwustronne/);
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'profile_url', value: 'https://kacper.example/' }]);
    assert.equal(document!.profile!.displayName, 'kacper');
  });

  test('domena nie potwierdza nazwy, przekierowanie albo zwykły nick — pusty wynik', async () => {
    const redirected = 'https://przekierowanie.example/.well-known/nostr.json?name=kacper';
    const { run, calls, logs } = setup({
      [url]: { body: { names: { ktos_inny: pubkey } } },
      [redirected]: { status: 302, headers: { location: 'https://inne.example/nostr.json' } },
    });
    assert.deepEqual(await run('live-nostr', 'nick', 'kacper@nostr-dom.example'), []);
    assert.match(logs.join('\n'), /nie potwierdza takiego identyfikatora/);
    assert.deepEqual(await run('live-nostr', 'nick', 'kacper@przekierowanie.example'), []);
    assert.deepEqual(calls, [url, redirected]);
    assert.deepEqual(await run('live-nostr', 'nick', 'kacper'), []);
    assert.equal(calls.length, 2);
  });
});

// ---------- keys.openpgp.org ----------

describe('live-openpgp', () => {
  /** Minimalny klucz w starym formacie pakietów: pakiet klucza (wersja 4) i dwa identyfikatory użytkownika. */
  const keyBody = Buffer.from([4, 0x65, 0x00, 0x00, 0x00, 22, 9, 1, 2, 3, 4, 5, 6, 7, 8]);
  const uid = (value: string) => Buffer.concat([Buffer.from([0xb4, Buffer.byteLength(value)]), Buffer.from(value)]);
  const binary = Buffer.concat([Buffer.from([0x99, 0, keyBody.length]), keyBody, uid('Kacper Wrzosek <kacper.wrzosek@poczta.example>'), uid('Kacper (praca) <k.wrzosek@firma.example>')]);
  const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\nComment: przykład\n\n${binary.toString('base64').replace(/(.{64})/g, '$1\n')}\n=AAAA\n-----END PGP PUBLIC KEY BLOCK-----\n`;
  const fingerprint = createHash('sha1').update(Buffer.from([0x99, 0, keyBody.length])).update(keyBody).digest('hex').toUpperCase();
  const url = 'https://keys.openpgp.org/vks/v1/by-email/kacper.wrzosek%40poczta.example';

  test('parseArmoredKey: odcisk v4, data utworzenia i identyfikatory użytkownika', () => {
    assert.deepEqual(parseArmoredKey(armored), {
      fingerprint,
      createdAt: new Date(0x65000000 * 1000).toISOString(),
      userIds: ['Kacper Wrzosek <kacper.wrzosek@poczta.example>', 'Kacper (praca) <k.wrzosek@firma.example>'],
    });
    assert.equal(parseArmoredKey('No key found for email address'), null);
    assert.equal(parseArmoredKey('-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n!!!!\n-----END PGP PUBLIC KEY BLOCK-----'), null);
  });

  test('e-mail → klucz: drugi adres z tego samego klucza jako identyfikator odkryty', async () => {
    const { run, calls } = setup({ [url]: { body: armored, type: 'application/pgp-keys' } });
    const [document] = await run('live-openpgp', 'email', 'Kacper.Wrzosek@poczta.example');
    assert.deepEqual(calls, [url]);
    assert.equal(document!.url, `https://keys.openpgp.org/vks/v1/by-fingerprint/${fingerprint}`);
    assert.match(document!.text, new RegExp(`Odcisk klucza: ${fingerprint}`));
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'email', value: 'k.wrzosek@firma.example' }]);
    assert.deepEqual(document!.profile, {
      handle: 'kacper.wrzosek@poczta.example',
      displayName: 'Kacper Wrzosek',
      emails: ['kacper.wrzosek@poczta.example', 'k.wrzosek@firma.example'],
      createdAt: new Date(0x65000000 * 1000).toISOString(),
    });
    assert.deepEqual(addressesOf(document!), []);
  });

  test('brak klucza (404) — pusty wynik z wpisem w dzienniku', async () => {
    const { run, logs } = setup({});
    assert.deepEqual(await run('live-openpgp', 'email', 'nikt@poczta.example'), []);
    assert.match(logs.join('\n'), /brak opublikowanego klucza/);
    assert.deepEqual(await run('live-openpgp', 'email', 'to nie e-mail'), []);
  });
});

// ---------- Rejestry: wykaz podatników VAT i KRS ----------

/** Rachunek NRB z poprawnymi cyframi kontrolnymi dla podanych 24 cyfr. */
function nrb(bban: string): string {
  let remainder = 0;
  for (const char of `${bban}252100`) remainder = (remainder * 10 + Number(char)) % 97;
  return `${String(98 - remainder).padStart(2, '0')}${bban}`;
}

describe('numery rejestrowe', () => {
  const account = nrb('101010100075912222000000');

  test('NIP i rachunek: sumy kontrolne', () => {
    // NIP Ministerstwa Finansów (publiczny) i numer z błędną cyfrą kontrolną.
    assert.equal(isValidNip('526-025-02-74'), true);
    assert.equal(isValidNip('5260250275'), false);
    assert.equal(isValidNip('123'), false);
    assert.equal(isValidNrb(account), true);
    assert.equal(isValidNrb(`PL ${account.replace(/(.{2})(.{4})/, '$1 $2 ')}`), true);
    assert.equal(isValidNrb(account.replace(/.$/, (digit) => String((Number(digit) + 1) % 10))), false);
  });

  test('registryNumber: zapisy identyfikatora przyjmowane przez łączniki rejestrów', () => {
    const of = (value: string) => registryNumber({ type: 'login', value });
    assert.deepEqual(of('NIP 5260250274'), { kind: 'nip', value: '5260250274' });
    assert.deepEqual(of('nip: 526-025-02-74'), { kind: 'nip', value: '5260250274' });
    assert.deepEqual(of('PL5260250274'), { kind: 'nip', value: '5260250274' });
    assert.deepEqual(of('KRS 19193'), { kind: 'krs', value: '0000019193' });
    assert.deepEqual(of(`rachunek ${account}`), { kind: 'bank_account', value: account });
    assert.deepEqual(of(`PL${account}`), { kind: 'bank_account', value: account });
    for (const value of ['5260250274', 'NIP 5260250275', 'kwrzosek_dev', 'KRS abc', 'KRS 0', 'rachunek 123']) assert.equal(of(value), null, value);
    assert.equal(registryNumber({ type: 'email', value: 'NIP 5260250274' }), null);
  });

  test('findRegistryNumbers i withRegistryIdentifiers: tylko numery po etykiecie, tylko z publikacji własnych', () => {
    const text = 'Firma Koparki sp. z o.o., NIP: 526-025-02-74, KRS 0000019193, REGON 000002217. Telefon 5260250274. NIP 1111111112.';
    assert.deepEqual(findRegistryNumbers(text), [
      { kind: 'nip', value: '5260250274' },
      { kind: 'krs', value: '0000019193' },
    ]);
    const doc: SourceDocument = {
      connectorId: 'live-www',
      service: 'koparki.example',
      url: 'https://koparki.example/',
      title: 'Koparki',
      text,
      fetchedAt: '2026-11-21T00:00:00.000Z',
      category: 'own_profile',
      identityMatch: 'exact_identifier',
      matchedIdentifier: { type: 'profile_url', value: 'https://koparki.example/' },
    };
    assert.deepEqual(withRegistryIdentifiers(doc).discoveredIdentifiers, [
      { type: 'login', value: 'NIP 5260250274' },
      { type: 'login', value: 'KRS 0000019193' },
    ]);
    assert.equal(withRegistryIdentifiers({ ...doc, category: 'mass_comment' }).discoveredIdentifiers, undefined);
    assert.equal(withRegistryIdentifiers({ ...doc, identityMatch: 'name_only' }).discoveredIdentifiers, undefined);
    assert.equal(withRegistryIdentifiers({ ...doc, text: 'bez numerów' }).discoveredIdentifiers, undefined);
  });

  test('publikacja z prawdziwego serwisu z numerem NIP → identyfikator dla rejestru; piaskownica nie', async () => {
    const note = '<p>Serwis koparek. NIP: 526-025-02-74</p>';
    const { run } = setup({ 'https://mastodon.example/api/v1/accounts/lookup?acct=koparki': { body: { username: 'koparki', note, url: 'https://mastodon.example/@koparki', fields: [] } } });
    const [document] = await run('live-fediverse', 'nick', 'koparki');
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'login', value: 'NIP 5260250274' }]);
    const off = setup({ 'https://mastodon.example/api/v1/accounts/lookup?acct=koparki': { body: { username: 'koparki', note, fields: [] } } }, { discoverRegistryNumbers: false });
    assert.equal((await off.run('live-fediverse', 'nick', 'koparki'))[0]!.discoveredIdentifiers, undefined);
  });
});

describe('live-vat-whitelist', () => {
  const API = 'https://wykazpodatnikowvat.mf.gov.pl/api/search';
  const account = nrb('101010100075912222000000');
  const subject = {
    name: 'KOPARKI I FIRMWARE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
    nip: '5260250274',
    statusVat: 'Czynny',
    regon: '000002217',
    pesel: null,
    krs: '0000019193',
    residenceAddress: null,
    workingAddress: 'FIKCYJNA 12, 85-001 BYDGOSZCZ',
    representatives: [{ companyName: null, firstName: 'JAN', lastName: 'PRZYKŁADOWY', nip: null, pesel: null }],
    authorizedClerks: [],
    partners: [],
    registrationLegalDate: '2019-06-03',
    removalDate: null,
    accountNumbers: [account],
    hasVirtualAccounts: false,
  };

  test('NIP → nazwa podmiotu, status, KRS jako identyfikator odkryty; bez adresów kryptowalutowych', async () => {
    const url = `${API}/nip/5260250274?date=${today}`;
    const { run, calls } = setup({ [url]: { body: { result: { subject, requestDateTime: '21-11-2026 19:50:43', requestId: 'abc-123' } } } });
    const [document, ...rest] = await run('live-vat-whitelist', 'login', 'NIP 526-025-02-74');
    assert.equal(rest.length, 0);
    assert.deepEqual(calls, [url]);
    assert.equal(document!.service, 'wykazpodatnikowvat.mf.gov.pl');
    assert.equal(document!.title, `Wykaz podatników VAT: ${subject.name} (NIP 5260250274)`);
    assert.match(document!.text, /Status VAT: Czynny/);
    assert.match(document!.text, /Reprezentanci: JAN PRZYKŁADOWY/);
    assert.match(document!.text, /Rachunki zgłoszone do wykazu: 1/);
    assert.match(document!.text, /Identyfikator zapytania w wykazie: abc-123/);
    assert.deepEqual(document!.profile, {
      handle: 'NIP 5260250274',
      organization: subject.name,
      registryEntries: ['NIP 5260250274 (wykaz podatników VAT: Czynny)', 'KRS 0000019193', 'REGON 000002217'],
    });
    assert.deepEqual(document!.discoveredIdentifiers, [{ type: 'login', value: 'KRS 0000019193' }]);
    assert.deepEqual(addressesOf(document!), []);
  });

  test('rachunek bankowy → podmiot, NIP jako identyfikator odkryty; brak podmiotu i zwykły nick', async () => {
    const url = `${API}/bank-account/${account}?date=${today}`;
    const missing = `${API}/nip/1234563218?date=${today}`;
    const { run, calls, logs } = setup({ [url]: { body: { result: { subjects: [subject], requestId: 'x' } } }, [missing]: { body: { result: { subject: null, requestId: 'y' } } } });
    const [document] = await run('live-vat-whitelist', 'nick', `rachunek ${account}`);
    assert.match(document!.text, new RegExp(`Sprawdzany rachunek ${account}: figuruje w wykazie`));
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'login', value: 'KRS 0000019193' },
      { type: 'login', value: 'NIP 5260250274' },
    ]);
    assert.deepEqual(await run('live-vat-whitelist', 'login', 'NIP 1234563218'), []);
    assert.match(logs.join('\n'), /brak podmiotu w wykazie/);
    const before = calls.length;
    assert.deepEqual(await run('live-vat-whitelist', 'login', 'kwrzosek_dev'), []);
    assert.deepEqual(await run('live-vat-whitelist', 'login', 'KRS 0000019193'), []);
    assert.equal(calls.length, before);
  });

  test('dzienny limit zapytań łącznika: po jego wyczerpaniu żadnych żądań', async () => {
    const { run, calls, logs } = setup({});
    for (let i = 0; i < VAT_DAILY_LIMIT + 3; i++) await run('live-vat-whitelist', 'login', 'NIP 5260250274');
    assert.equal(calls.length, VAT_DAILY_LIMIT);
    assert.match(logs.join('\n'), /wyczerpano dzienny limit/);
  });
});

describe('live-krs', () => {
  const API = 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny';
  const extract = {
    odpis: {
      rodzaj: 'Aktualny',
      naglowekA: { rejestr: 'RejP', numerKRS: '0000019193', dataRejestracjiWKRS: '14.06.2001', stanZDnia: '21.11.2026' },
      dane: {
        dzial1: {
          danePodmiotu: { formaPrawna: 'SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', identyfikatory: { regon: '00000221700000', nip: '5260250274' }, nazwa: 'KOPARKI I FIRMWARE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ' },
          siedzibaIAdres: {
            siedziba: { kraj: 'POLSKA', wojewodztwo: 'KUJAWSKO-POMORSKIE', miejscowosc: 'BYDGOSZCZ' },
            adres: { ulica: 'FIKCYJNA', nrDomu: '12', miejscowosc: 'BYDGOSZCZ', kodPocztowy: '85-001', poczta: 'BYDGOSZCZ', kraj: 'POLSKA' },
            adresPocztyElektronicznej: 'BIURO@KOPARKI.EXAMPLE',
            adresStronyInternetowej: 'WWW.KOPARKI.EXAMPLE',
          },
        },
        dzial2: {
          reprezentacja: {
            nazwaOrganu: 'ZARZĄD',
            sposobReprezentacji: 'KAŻDY CZŁONEK ZARZĄDU SAMODZIELNIE',
            sklad: [{ nazwisko: { nazwiskoICzlon: 'P*********' }, imiona: { imie: 'J**', imieDrugie: 'A***' }, identyfikator: { pesel: '8**********' }, funkcjaWOrganie: 'PREZES ZARZĄDU', czyZawieszona: false }],
          },
        },
      },
    },
  };

  test('numer KRS → nazwa, NIP, strona i e-mail z rejestru; dane osobowe pozostają zamaskowane', async () => {
    const url = `${API}/0000019193?rejestr=P&format=json`;
    const { run, calls } = setup({ [url]: { body: extract } });
    const [document] = await run('live-krs', 'login', 'KRS 19193');
    assert.deepEqual(calls, [url]);
    assert.deepEqual([document!.service, document!.url, document!.title], ['api-krs.ms.gov.pl', url, 'KRS 0000019193: KOPARKI I FIRMWARE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ']);
    assert.match(document!.text, /Adres: FIKCYJNA 12, 85-001 BYDGOSZCZ/);
    assert.match(document!.text, /ZARZĄD \(dane osobowe zamaskowane przez rejestr\):\n- J\*\* A\*\*\* P\*{9} — PREZES ZARZĄDU/);
    assert.doesNotMatch(document!.text, /pesel|8\*{10}/i);
    assert.deepEqual(document!.profile, {
      handle: 'KRS 0000019193',
      organization: 'KOPARKI I FIRMWARE SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ',
      registryEntries: ['KRS 0000019193', 'NIP 5260250274'],
      urls: ['https://www.koparki.example/'],
      emails: ['biuro@koparki.example'],
    });
    assert.deepEqual(document!.discoveredIdentifiers, [
      { type: 'profile_url', value: 'https://www.koparki.example/' },
      { type: 'email', value: 'biuro@koparki.example' },
      { type: 'login', value: 'NIP 5260250274' },
    ]);
  });

  test('brak w rejestrze przedsiębiorców → próba w rejestrze stowarzyszeń; nieznany numer — pusty wynik', async () => {
    const second = `${API}/0000019193?rejestr=S&format=json`;
    const found = setup({ [second]: { body: extract } });
    assert.equal((await found.run('live-krs', 'login', 'KRS 0000019193')).length, 1);
    assert.deepEqual(found.calls, [`${API}/0000019193?rejestr=P&format=json`, second]);
    const none = setup({});
    assert.deepEqual(await none.run('live-krs', 'login', 'KRS 0000000001'), []);
    assert.equal(none.calls.length, 2);
    assert.match(none.logs.join('\n'), /brak aktualnego odpisu/);
    assert.deepEqual(await none.run('live-krs', 'login', 'NIP 5260250274'), []);
    assert.equal(none.calls.length, 2);
  });
});

// ---------- Bitcointalk po nicku ----------

describe('live-bitcointalk — profil po nicku', () => {
  const html = `<html><body><table>
<tr><td><b>Name: </b></td><td>Kacper_Dev</td></tr>
<tr><td><b>Date Registered: </b></td><td>February 09, 2010, 12:49:38 AM</td></tr>
<tr><td><b>Bitcoin address: </b></td><td>${ADDR.kacperBtc}</td></tr>
</table><a href="https://bitcointalk.org/index.php?action=profile;u=4321;sa=showPosts">Show the last posts</a></body></html>`;

  test('nick → index.php?action=profile;user=<nick>; trwały adres profilu z numerem użytkownika', async () => {
    const url = 'https://bitcointalk.org/index.php?action=profile;user=kacper_dev';
    const { run, calls } = setup({ [url]: { body: html } });
    const [document] = await run('live-bitcointalk', 'nick', 'kacper_dev');
    assert.deepEqual(calls, [url]);
    assert.equal(document!.url, 'https://bitcointalk.org/index.php?action=profile;u=4321');
    assert.equal(document!.author, 'Kacper_Dev');
    assert.deepEqual(addressesOf(document!), [ADDR.kacperBtc]);
  });

  test('strona innego użytkownika niż szukany nick oraz nick z niedozwolonymi znakami — pusty wynik', async () => {
    const url = 'https://bitcointalk.org/index.php?action=profile;user=kacper';
    const { run, calls, logs } = setup({ [url]: { body: html } });
    assert.deepEqual(await run('live-bitcointalk', 'nick', 'kacper'), []);
    assert.match(logs.join('\n'), /dotyczy użytkownika „Kacper_Dev" — pominięto/);
    assert.deepEqual(await run('live-bitcointalk', 'nick', 'a;action=mlist'), []);
    assert.deepEqual(await run('live-bitcointalk', 'nick', 'x@y.example'), []);
    assert.equal(calls.length, 1);
  });
});
