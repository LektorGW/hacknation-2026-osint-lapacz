import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runAnalysis } from '../src/analysis.ts';
import { BTC_A, BTC_B, BTC_EXCHANGE, ETH_A, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };

test('ślady z dwóch usług trafiają do jednego adresu i dają premię za niezależne źródło', async () => {
  const profileText = `Wsparcie projektu: ${BTC_A} — dziękuję!`;
  const github = fakeConnector('github', 'github.com', ['nick'], () => [
    { url: 'https://github.com/krypto_janek', text: profileText, author: 'krypto_janek' },
  ]);
  const forum = fakeConnector('forum', 'forum.example', ['nick'], () => [
    { url: 'https://forum.example/t/1', text: `Płatność na ${BTC_A}`, category: 'forum_post', author: 'krypto_janek' },
  ]);

  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [github, forum],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
  });

  assert.equal(result.findings.length, 1);
  const [finding] = result.findings;
  assert.equal(finding!.address, BTC_A);
  assert.equal(finding!.evidence.length, 2);
  // 85 (własny profil) − 10 (zgodny tylko nick) + 15 (drugie źródło)
  assert.equal(finding!.confidence.score, 90);
  assert.ok(finding!.confidence.ledger.some((entry) => entry.rule === 'identity.same_handle'));
  assert.ok(finding!.confidence.ledger.some((entry) => entry.rule === 'synergy.second_source'));
  assert.equal(finding!.chain?.profile.addressClass, 'private');

  const fromGithub = finding!.evidence.find((item) => item.service === 'github.com')!;
  assert.equal(fromGithub.contentHash, createHash('sha256').update(profileText).digest('hex'));
  assert.ok(fromGithub.excerpt.includes(BTC_A));
  assert.equal(fromGithub.capturedAt, '2026-11-21T09:00:00.000Z');
  // Kopie treści obu dokumentów idą do zapisu.
  assert.equal(result.documents.length, 2);
  assert.ok(result.log.every((entry) => entry.time === '2026-11-21T10:00:00.000Z'));
});

test('adres giełdy jest wykluczony, ale zostaje w wynikach na końcu listy', async () => {
  const github = fakeConnector('github', 'github.com', ['nick'], () => [
    { url: 'https://github.com/krypto_janek', text: `Depozyt: ${BTC_EXCHANGE}, mój portfel: ${BTC_A}` },
  ]);

  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [github],
    chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })],
  });

  assert.deepEqual(result.findings.map((finding) => finding.address), [BTC_A, BTC_EXCHANGE]);
  const excluded = result.findings[1]!;
  assert.equal(excluded.confidence.excluded, true);
  assert.equal(excluded.confidence.score, 0);
  assert.equal(excluded.confidence.ledger[0]!.rule, 'exclusion.address_class');
  assert.equal(excluded.evidence.length, 1);
});

test('odkryte identyfikatory uruchamiają dokładnie jedną dodatkową rundę', async () => {
  const github = fakeConnector('github', 'github.com', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [
          {
            url: 'https://github.com/krypto_janek',
            text: 'Profil bez adresu.',
            discoveredIdentifiers: [
              { type: 'nick', value: 'janek_btc' },
              { type: 'nick', value: 'Krypto_Janek' },
            ],
          },
        ]
      : [],
  );
  const forum = fakeConnector('forum', 'forum.example', ['nick'], (identifier) =>
    identifier.value === 'janek_btc'
      ? [
          {
            url: 'https://forum.example/u/janek_btc',
            text: `Sprzedam, płatność ${BTC_B}`,
            category: 'forum_post',
            discoveredIdentifiers: [{ type: 'nick', value: 'trzeci_profil' }],
          },
        ]
      : [],
  );

  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [github, forum],
    chainProviders: [fakeProvider()],
  });

  // Identyfikator wejściowy nie jest pytany drugi raz, a „trzeci_profil” wcale (brak trzeciej rundy).
  assert.deepEqual(forum.calls.map((call) => call.value), ['krypto_janek', 'janek_btc']);
  assert.deepEqual(github.calls.map((call) => call.value), ['krypto_janek', 'janek_btc']);

  const [finding] = result.findings;
  assert.equal(finding!.address, BTC_B);
  assert.equal(finding!.evidence[0]!.identityMatch, 'linked_profile');
  assert.equal(finding!.confidence.score, 45);
  assert.ok(finding!.confidence.ledger.some((entry) => entry.rule === 'identity.linked_profile'));
});

test('w drugiej rundzie słabsze dopasowanie po samym nazwisku nie jest podnoszone', async () => {
  const github = fakeConnector('github', 'github.com', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://github.com/krypto_janek', text: 'x', discoveredIdentifiers: [{ type: 'nick', value: 'janek_btc' }] }]
      : [{ url: 'https://github.com/janek_btc', text: `Adres ${BTC_B}`, identityMatch: 'name_only' }],
  );

  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [github], chainProviders: [] });

  assert.equal(result.findings[0]!.evidence[0]!.identityMatch, 'name_only');
  // Bez dostawcy danych adres zostaje bez klasyfikacji, a analiza się kończy.
  assert.equal(result.findings[0]!.chain, undefined);
  assert.ok(result.log.some((entry) => entry.message.includes('brak danych blockchain')));
});

test('niepowiązani autorzy publikujący ten sam adres obniżają wynik i nie są śladami', async () => {
  const github = fakeConnector('github', 'github.com', ['nick'], () => [
    { url: 'https://github.com/krypto_janek', text: `Zbiórka: ${BTC_A}`, author: 'krypto_janek' },
  ]);
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) => [
    ...['ala', 'ola', 'ela'].map((author) => ({
      url: `https://forum.example/p/${author}`,
      text: `Wpłacajcie na ${identifier.value}`,
      category: 'mass_comment' as const,
      author,
    })),
    // Ten sam autor dwa razy liczy się raz.
    { url: 'https://forum.example/p/ala-2', text: `Jeszcze raz: ${identifier.value}`, author: 'Ala' },
    // Wpis samego podmiotu jest śladem, nie „obcym publikującym”.
    { url: 'https://forum.example/p/janek', text: `Mój adres ${identifier.value}`, category: 'forum_post' as const, author: '@Krypto_Janek' },
    // Dokument bez tego adresu jest ignorowany.
    { url: 'https://forum.example/p/inne', text: 'Nic tu nie ma', author: 'ktos' },
  ]);

  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [github, forum],
    chainProviders: [fakeProvider()],
  });

  const [finding] = result.findings;
  assert.equal(finding!.unrelatedPublishers, 3);
  assert.deepEqual(finding!.evidence.map((item) => item.url).sort(), [
    'https://forum.example/p/janek',
    'https://github.com/krypto_janek',
  ]);
  assert.ok(finding!.confidence.ledger.some((entry) => entry.rule === 'penalty.shared_address'));
  // 85 (własny profil) − 10 (zgodny tylko nick) + 15 (drugie źródło) − 30 (adres współdzielony)
  assert.equal(finding!.confidence.score, 60);
});

test('błąd łącznika trafia do dziennika i nie przerywa analizy', async () => {
  const broken = fakeConnector('zepsuty', 'down.example', ['nick'], () => {
    throw new Error('HTTP 503');
  });
  const github = fakeConnector('github', 'github.com', ['nick'], () => [
    { url: 'https://github.com/krypto_janek', text: `ETH: ${ETH_A}` },
  ]);
  const failingProvider = {
    ...fakeProvider(),
    id: 'pierwszy',
    getActivity: async () => {
      throw new Error('limit zapytań');
    },
  };

  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [broken, github],
    chainProviders: [failingProvider, fakeProvider()],
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.address, ETH_A);
  assert.equal(result.findings[0]!.network, 'ethereum');
  // Po błędzie pierwszego dostawcy dane podał kolejny.
  assert.equal(result.findings[0]!.chain?.profile.classificationSource, 'atrapa etykiet');
  assert.ok(result.log.some((entry) => entry.message.includes('[zepsuty] BŁĄD') && entry.message.includes('HTTP 503')));
  assert.ok(result.log.some((entry) => entry.message.includes('[pierwszy] BŁĄD')));
});

test('adres podany jako identyfikator jest analizowany także bez dokumentów', async () => {
  const forum = fakeConnector('forum', 'forum.example', ['nick', 'crypto_address'], () => []);

  const result = await runAnalysis({
    query: { identifiers: [{ type: 'crypto_address', value: BTC_A }] },
    connectors: [forum],
    chainProviders: [fakeProvider()],
  });

  assert.deepEqual(forum.calls, [{ type: 'crypto_address', value: BTC_A }]);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.address, BTC_A);
  assert.equal(result.findings[0]!.evidence.length, 0);
  assert.equal(result.findings[0]!.confidence.score, 0);
  assert.equal(result.findings[0]!.confidence.excluded, false);
  assert.equal(result.findings[0]!.chain?.cashOuts.length, 1);
});

test('analiza samego adresu: autor publikacji staje się kandydatem na właściciela', async () => {
  const profiles = fakeConnector('profile', 'github.com', ['crypto_address'], () => [
    { url: 'https://github.com/krypto_janek', text: `Wsparcie: ${BTC_A}`, author: 'krypto_janek' },
  ]);
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], () => [
    { url: 'https://forum.example/t/9', text: `Mój adres ${BTC_A}`, category: 'forum_post', author: 'krypto_janek' },
  ]);

  const result = await runAnalysis({
    query: { identifiers: [{ type: 'crypto_address', value: BTC_A }] },
    connectors: [profiles, forum],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
  });

  const [finding] = result.findings;
  assert.equal(finding!.address, BTC_A);
  assert.equal(finding!.evidence.length, 2);
  assert.equal(finding!.unrelatedPublishers, 0);
  assert.equal(finding!.confidence.score, 100);
  assert.ok(finding!.evidence.every((item) => item.author === 'krypto_janek'));
});

test('analiza samego adresu: kilku autorów osłabia przypisanie', async () => {
  const authors = ['ala', 'ola', 'ela', 'ula'];
  const social = fakeConnector('social', 'social.example', ['crypto_address'], () =>
    authors.map((author) => ({
      url: `https://social.example/${author}`,
      text: `Wpłaty na ${BTC_A}`,
      category: 'mass_comment' as const,
      author,
    })),
  );

  const result = await runAnalysis({
    query: { identifiers: [{ type: 'crypto_address', value: BTC_A }] },
    connectors: [social],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
  });

  const [finding] = result.findings;
  assert.equal(finding!.unrelatedPublishers, 3);
  assert.ok(finding!.confidence.ledger.some((entry) => entry.rule === 'penalty.shared_address'));
});
