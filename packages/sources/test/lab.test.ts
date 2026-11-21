// Łączniki laboratorium tożsamości sprawdzane na atrapie jego publicznego API
// (kształt odpowiedzi zgodny z apps/identity-lab, dane fikcyjne). Żadnych połączeń sieciowych.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { extractAddresses } from '@olcys/core';
import type { Identifier, SourceDocument } from '@olcys/core';
import type { Fetcher } from '../src/http.ts';
import { createConnectors } from '../src/index.ts';
import { LAB_PORTALS, createLabConnectors } from '../src/lab.ts';

const LAB = 'http://lab.example:8787';
const OWN = `lab1${'a1'.repeat(20)}`;
const SHARED = `lab1${'b2'.repeat(20)}`;

const ACCOUNTS = [
  { id: 'acct-1', serviceId: 'social-x', username: 'szlak_ciszy', displayName: 'Mira Kowal', email: 'mira.kowal@poczta.test', bio: 'Spokojnie, krok po kroku.', location: 'Nowe Brzeziny', joinedAt: '2025-02-02T15:00:00.000Z', walletAddresses: [OWN] },
  { id: 'acct-2', serviceId: 'social-x', username: 'szlak_ciszy_fan', displayName: 'Ktoś Inny', email: 'inny@poczta.test', bio: 'Lubię szlak_ciszy. Pisz: @inne_konto.', location: 'Mała Polana', walletAddresses: [] },
  { id: 'acct-3', serviceId: 'forum-rower', username: 'mira_k', displayName: 'Mira Kowal', email: 'szlak.ciszy@inbox.test', bio: 'Rowery i trasy. Kontakt: mira.kowal@poczta.test.', location: 'Nowe Brzeziny', walletAddresses: [SHARED] },
  { id: 'acct-4', serviceId: 'forum-rower', username: 'zbieracz', displayName: 'Adam Lis', email: 'adam@poczta.test', bio: 'Zbiórki lokalne.', location: 'Stary Bór', walletAddresses: [] },
];
const POSTS = [
  { id: 'post-1', accountId: 'acct-1', serviceId: 'social-x', text: `Napiwki w LAB: ${OWN}. #PortfelLAB`, createdAt: '2026-11-19T08:00:00.000Z' },
  { id: 'post-2', accountId: 'acct-2', serviceId: 'social-x', text: 'Zwykły wpis bez adresu.', createdAt: '2026-11-18T08:00:00.000Z' },
];
const THREADS = [
  {
    id: 'thread-1',
    accountId: 'acct-3',
    serviceId: 'forum-rower',
    title: 'Zbiórka na serwis szlaku',
    text: `Wpłaty na adres pośrednika: ${SHARED}`,
    createdAt: '2026-11-17T08:00:00.000Z',
    replies: [{ id: 'reply-1-1', accountId: 'acct-4', text: `Potwierdzam, też podaję ${SHARED}`, createdAt: '2026-11-17T09:00:00.000Z' }],
  },
];
const LISTINGS = [{ id: 'offer-1', accountId: 'acct-3', serviceId: 'forum-rower', title: 'Rower', description: 'Stan dobry.', price: 800, currency: 'PLN', createdAt: '2026-11-10T08:00:00.000Z' }];

/** Atrapa publicznego API laboratorium; każda inna ścieżka (w tym prawda wzorcowa) to błąd testu. */
function mockLab() {
  const calls: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  const fetcher: Fetcher = async (target) => {
    calls.push(target);
    const url = new URL(target);
    const path = url.pathname;
    if (path === '/api/accounts') {
      const service = url.searchParams.get('service');
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const accounts = ACCOUNTS.filter((account) => (!service || account.serviceId === service) && [account.id, account.email, account.username, account.displayName, account.bio, ...account.walletAddresses].some((field) => field.toLowerCase().includes(q)));
      return json({ total: accounts.length, accounts });
    }
    if (path.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(path.slice('/api/accounts/'.length));
      const account = ACCOUNTS.find((item) => item.id === id);
      if (!account) return json({ error: 'Nie znaleziono profilu.' }, 404);
      return json({ account, posts: POSTS.filter((item) => item.accountId === id), listings: LISTINGS.filter((item) => item.accountId === id), threads: THREADS.filter((item) => item.accountId === id) });
    }
    if (path.startsWith('/api/portal/')) {
      const portal = LAB_PORTALS.find((item) => item.slug === decodeURIComponent(path.slice('/api/portal/'.length)));
      if (!portal) return json({ error: 'Nie znaleziono portalu.' }, 404);
      const own = <T extends { serviceId: string }>(items: T[]) => items.filter((item) => item.serviceId === portal.id);
      return json({ service: { id: portal.id }, accounts: own(ACCOUNTS), posts: own(POSTS), listings: own(LISTINGS), threads: own(THREADS) });
    }
    throw new Error(`łącznik sięgnął po niedozwoloną ścieżkę: ${path}`);
  };
  return { fetcher, calls };
}

function setup() {
  const { fetcher, calls } = mockLab();
  const connectors = createLabConnectors(`${LAB}/`, { fetcher });
  const log: string[] = [];
  const context = { log: (message: string) => void log.push(message) };
  const searchAll = async (identifier: Identifier): Promise<SourceDocument[]> => (await Promise.all(connectors.map((connector) => connector.search(identifier, context)))).flat();
  return { connectors, calls, log, context, searchAll };
}

describe('łączniki laboratorium tożsamości', () => {
  test('po jednym łączniku na portal; etykiety „LAB: …” i opis „symulacja lokalna”', () => {
    const { connectors } = setup();
    assert.equal(connectors.length, 27);
    assert.equal(new Set(connectors.map((connector) => connector.id)).size, 27);
    assert.equal(new Set(connectors.map((connector) => connector.service)).size, 27);
    for (const connector of connectors) {
      assert.match(connector.id, /^lab-/);
      assert.match(connector.label, /^LAB: /);
      assert.doesNotMatch(connector.label, /·/);
      assert.match(connector.description, /symulacja lokalna/i);
      assert.match(connector.service, /\.lab\.test$/);
      assert.ok(connector.accepts.includes('nick') && connector.accepts.includes('email') && connector.accepts.includes('full_name') && connector.accepts.includes('crypto_address'));
    }
  });

  test('łączniki powstają tylko po podaniu labUrl', () => {
    // Bez konfiguracji powstaje tylko lokalny łącznik rejestrów publicznych (bez zapytań do sieci).
    assert.deepEqual(createConnectors({}).map((connector) => connector.id), ['rejestry-publiczne', 'listy-sankcyjne']);
    const created = createConnectors({ labUrl: LAB, fetcher: mockLab().fetcher }).filter((connector) => !['rejestry-publiczne', 'listy-sankcyjne'].includes(connector.id));
    assert.equal(created.length, 27);
    assert.ok(created.every((connector) => connector.id.startsWith('lab-')));
  });

  test('nick: dopasowanie dokładne, profil z treściami, e-mail jako odkryty identyfikator', async () => {
    const { searchAll } = setup();
    const documents = await searchAll({ type: 'nick', value: '@Szlak_Ciszy' });
    // Konto „szlak_ciszy_fan” zawiera nick tylko jako podciąg — nie jest trafieniem.
    assert.deepEqual([...new Set(documents.map((document) => document.author))], ['szlak_ciszy']);
    const [profile, post] = documents;
    assert.equal(documents.length, 2);
    assert.equal(profile!.url, `${LAB}/s/x/profile/acct-1`);
    assert.equal(profile!.connectorId, 'lab-x');
    assert.equal(profile!.service, 'x.lab.test');
    assert.equal(profile!.category, 'own_profile');
    assert.equal(profile!.identityMatch, 'exact_identifier');
    assert.deepEqual(profile!.discoveredIdentifiers, [{ type: 'email', value: 'mira.kowal@poczta.test' }]);
    assert.deepEqual(profile!.profile, {
      handle: 'szlak_ciszy',
      displayName: 'Mira Kowal',
      emails: ['mira.kowal@poczta.test'],
      location: 'Nowe Brzeziny',
      bio: 'Spokojnie, krok po kroku.',
      createdAt: '2025-02-02T15:00:00.000Z',
    });
    // Adres z listy „publiczne adresy portfeli” jest częścią strony profilu.
    assert.deepEqual(extractAddresses(profile!.text).map((found) => [found.network, found.address]), [['lab', OWN]]);
    assert.equal(post!.url, `${LAB}/s/x/profile/acct-1?wpis=post-1`);
    assert.equal(post!.publishedAt, '2026-11-19T08:00:00.000Z');
    assert.equal(post!.category, 'own_profile');
    assert.equal(extractAddresses(post!.text)[0]!.address, OWN);
  });

  test('e-mail: konto z e-mailem w polu albo w opisie; odkryty nick i drugi e-mail', async () => {
    const { searchAll } = setup();
    const documents = await searchAll({ type: 'email', value: 'Mira.Kowal@poczta.test' });
    assert.deepEqual([...new Set(documents.map((document) => `${document.author}|${document.service}`))], ['szlak_ciszy|x.lab.test', 'mira_k|forum-rowerowe.lab.test']);
    const forumProfile = documents.find((document) => document.url === `${LAB}/s/forum-rowerowe/profile/acct-3`)!;
    assert.equal(forumProfile.identityMatch, 'exact_identifier');
    assert.deepEqual(forumProfile.discoveredIdentifiers, [
      { type: 'nick', value: 'mira_k' },
      { type: 'email', value: 'szlak.ciszy@inbox.test' },
    ]);
    assert.deepEqual(forumProfile.profile?.emails, ['szlak.ciszy@inbox.test', 'mira.kowal@poczta.test']);
    // Wątek zawiera tylko wypowiedź autora, bez odpowiedzi innych osób; oferta ma kategorię ogłoszenia.
    const thread = documents.find((document) => document.url.includes('watek=thread-1'))!;
    assert.equal(thread.category, 'forum_post');
    assert.doesNotMatch(thread.text, /Potwierdzam/);
    assert.equal(documents.find((document) => document.url.includes('oferta=offer-1'))!.category, 'sale_offer');
  });

  test('imię i nazwisko: najsłabsze powiązanie i brak odkrytych identyfikatorów', async () => {
    const { searchAll } = setup();
    const documents = await searchAll({ type: 'full_name', value: 'mira kowal' });
    assert.ok(documents.length >= 2);
    assert.ok(documents.every((document) => document.identityMatch === 'name_only' && document.discoveredIdentifiers === undefined));
    assert.deepEqual([...new Set(documents.map((document) => document.author))].sort(), ['mira_k', 'szlak_ciszy']);
  });

  test('adres: wszyscy publikujący (profil, wątek, odpowiedź) jako dokumenty cudzego autorstwa', async () => {
    const { searchAll, calls } = setup();
    const identifier: Identifier = { type: 'crypto_address', value: SHARED };
    const documents = await searchAll(identifier);
    assert.deepEqual(documents.map((document) => `${document.author}|${document.url.split('/profile/')[1]}`).sort(), ['mira_k|acct-3', 'mira_k|acct-3?watek=thread-1', 'zbieracz|acct-4?odpowiedz=reply-1-1']);
    for (const document of documents) {
      assert.equal(document.identityMatch, 'name_only');
      assert.deepEqual(document.matchedIdentifier, identifier);
      assert.equal(document.discoveredIdentifiers, undefined);
      assert.ok(extractAddresses(document.text).some((found) => found.address === SHARED));
    }
    // Jedno żądanie na portal; drugie wyszukiwanie korzysta z zapamiętanej zawartości.
    assert.equal(calls.length, 27);
    assert.ok(calls.every((url) => url.startsWith(`${LAB}/api/portal/`)));
    await searchAll({ type: 'crypto_address', value: OWN });
    assert.equal(calls.length, 27);
  });

  test('adres prawdziwej sieci nie jest wysyłany do laboratorium', async () => {
    const { searchAll, calls } = setup();
    assert.deepEqual(await searchAll({ type: 'crypto_address', value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa' }), []);
    assert.equal(calls.length, 0);
  });

  test('korzysta wyłącznie z /api/accounts i /api/portal — nigdy z prawdy wzorcowej', async () => {
    const { searchAll, calls } = setup();
    await searchAll({ type: 'nick', value: 'mira_k' });
    await searchAll({ type: 'email', value: 'adam@poczta.test' });
    await searchAll({ type: 'full_name', value: 'Adam Lis' });
    await searchAll({ type: 'crypto_address', value: OWN });
    assert.ok(calls.length > 0);
    for (const url of calls) {
      assert.match(new URL(url).pathname, /^\/api\/(accounts(\/[^/]+)?|portal\/[^/]+)$/);
      assert.doesNotMatch(url, /ground-truth|resolve|evaluate|export|search/);
    }
  });

  test('błąd laboratorium kończy się pustym wynikiem i wpisem w dzienniku, bez wyjątku', async () => {
    const fetcher: Fetcher = async () => new Response('awaria', { status: 500, headers: { 'content-type': 'text/plain' } });
    const [connector] = createLabConnectors(LAB, { fetcher });
    const log: string[] = [];
    const context = { log: (message: string) => void log.push(message) };
    assert.deepEqual(await connector!.search({ type: 'nick', value: 'ktokolwiek' }, context), []);
    assert.deepEqual(await connector!.search({ type: 'crypto_address', value: OWN }, context), []);
    assert.ok(log.some((line) => line.includes('kod 500')));
  });
});
