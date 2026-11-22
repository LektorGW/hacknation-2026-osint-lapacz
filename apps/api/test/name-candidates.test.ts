// Imię i nazwisko jako trop: nicki wygenerowane z imienia i nazwiska (krok 0), imię i nazwisko z nazwy
// wyświetlanej profilu mocno przypisanego, limity łączników w powodach zatrzymania. Atrapy, bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Identifier } from '@olcys/core';
import { CONNECTOR_STOP_PREFIX, NICK_CANDIDATE_REASON, nickCandidates } from '@olcys/sources';
import { MAX_FOLLOWED_NAMES, runAnalysis } from '../src/analysis.ts';
import { BTC_A, BTC_C, dossierOf, fakeConnector, fakeProvider } from './helpers.ts';

const fullName: Identifier = { type: 'full_name', value: 'Jan Kowalski' };
const email: Identifier = { type: 'email', value: 'jan.kowalski@poczta.example' };

test('samo imię i nazwisko: nicki-kandydaci pytane raz każdy, tylko w źródłach bezpośrednich, wynik słaby, powód zatrzymania', async () => {
  const profiles = fakeConnector('profile', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'jkowalski'
      ? [{ url: 'https://serwis.example/jkowalski', author: 'jkowalski', text: `Wsparcie: ${BTC_C}`, profile: { handle: 'jkowalski', displayName: 'Jan Kowalski' } }]
      : identifier.value === 'jankowalski'
        ? [{ url: 'https://serwis.example/jankowalski', author: 'jankowalski', text: 'Konto innej osoby.', profile: { handle: 'jankowalski', displayName: 'Janusz Kowalczyk' } }]
        : [],
  );
  // Kosztowna wyszukiwarka nie dostaje zgadywanych nicków.
  const broad = fakeConnector('web-search', 'wyszukiwarka.example', ['nick', 'full_name'], () => []);
  const result = await runAnalysis({ query: { identifiers: [fullName] }, connectors: [profiles, broad], chainProviders: [fakeProvider()] });

  const expected = nickCandidates('Jan Kowalski');
  assert.deepEqual(profiles.calls.map((call) => call.value), expected);
  assert.deepEqual(broad.calls, [fullName]);

  // Konto z innym imieniem i nazwiskiem odrzucone; konto zgodne — tylko „zgodne imię i nazwisko”.
  assert.deepEqual(result.intel.sightings.map((item) => [item.url, item.identity.match]), [['https://serwis.example/jkowalski', 'name_only']]);
  const [finding] = result.findings;
  assert.equal(finding!.address, BTC_C);
  assert.equal(finding!.evidence[0]!.identityMatch, 'name_only');
  assert.ok(finding!.evidence[0]!.identityReasons!.includes(NICK_CANDIDATE_REASON));

  const stop = result.intel.expansion!.stops.find((item) => item.detail.includes('nicków wygenerowanych z imienia i nazwiska'))!;
  assert.equal(stop.reason, 'query_limit');
  assert.match(stop.detail, new RegExp(`sprawdzono ${expected.length} nicków`));
  assert.match(stop.detail, /znalezionych kont 1/);
  assert.match(stop.detail, /odrzuconych kont z innym imieniem i nazwiskiem 1/);
});

test('nick-kandydat nigdy nie jest dokładny — nawet zgodny e-mail sprawy tylko podpowiada analitykowi', async () => {
  const profiles = fakeConnector('profile', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'jan.kowalski'
      ? [{ url: 'https://serwis.example/jan.kowalski', author: 'jan.kowalski', text: `Kontakt: ${email.value}. BTC ${BTC_A}` }]
      : [],
  );
  const result = await runAnalysis({ query: { identifiers: [fullName, email] }, connectors: [profiles], chainProviders: [fakeProvider()] });
  const [sighting] = result.intel.sightings;
  assert.equal(sighting!.identity.match, 'name_only');
  assert.ok(sighting!.identity.reasons.some((reason) => reason.startsWith('Do potwierdzenia przez analityka')));
  assert.equal(result.findings[0]!.evidence[0]!.identityMatch, 'name_only');
});

test('adres imiennika znaleziony przez nick-kandydata nie jest przypisany osobie głównej', async () => {
  const connectors = [
    fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
      { url: 'https://gitpub.example/janek_dev', author: 'janek_dev', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'janek_dev', displayName: 'Jan Kowalski', emails: [email.value] } },
    ]),
    fakeConnector('forum', 'forum.example', ['nick'], (identifier) =>
      identifier.value === 'jkowalski'
        ? [{ url: 'https://forum.example/u/jkowalski', author: 'jkowalski', text: `Sprzedam rower, wpłata na ${BTC_C}`, profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', location: 'Rzeszów' } }]
        : [],
    ),
  ];
  const query = { identifiers: [email, fullName] };
  const result = await runAnalysis({ query, connectors, chainProviders: [fakeProvider()] });
  const dossier = dossierOf(result, query);

  // Konto kandydata jest osobnym, słabym kandydatem — bez automatycznego scalania.
  assert.equal(dossier.persons.length, 2);
  assert.deepEqual(dossier.persons[0]!.profileIds, ['gitpub.example|janek_dev']);
  assert.deepEqual(dossier.persons[1]!.profileIds, ['forum.example|jkowalski']);
  const foreign = dossier.findings.find((item) => item.address === BTC_C)!;
  assert.equal(foreign.confidence.score, 0);
  assert.equal(foreign.evidence.length, 0);
  assert.equal(dossier.findings.find((item) => item.address === BTC_A)!.confidence.score, 85);
});

test('imię i nazwisko z profilu mocno przypisanego jest wyszukiwane w kolejnym kroku; potwierdza je tylko identyfikator sprawy', async () => {
  const byEmail = fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    {
      url: 'https://gitpub.example/janek_dev',
      author: 'janek_dev',
      text: 'Programista. Strona: https://janek.example',
      profile: { handle: 'janek_dev', displayName: 'Jan Kowalski' },
      discoveredIdentifiers: [{ type: 'profile_url' as const, value: 'https://janek.example/' }],
    },
  ]);
  const byName = fakeConnector('katalog', 'katalog.example', ['full_name'], () => [
    { url: 'https://katalog.example/u/1', author: 'kowalski_j', identityMatch: 'name_only' as const, text: `Jan Kowalski — więcej na janek.example. BTC ${BTC_A}` },
    { url: 'https://katalog.example/u/2', author: 'jk_imiennik', identityMatch: 'name_only' as const, text: `Jan Kowalski z Gdańska. BTC ${BTC_C}` },
  ]);
  const result = await runAnalysis({ query: { identifiers: [email] }, connectors: [byEmail, byName], chainProviders: [fakeProvider()] });

  assert.deepEqual(byName.calls, [{ type: 'full_name', value: 'Jan Kowalski' }]);
  const entry = result.intel.trail.find((item) => item.identifier.type === 'full_name')!;
  assert.deepEqual([entry.identifier.value, entry.step, entry.followed, entry.match, entry.sourceUrl], ['Jan Kowalski', 1, true, 'linked_profile', 'https://gitpub.example/janek_dev']);
  const matches = Object.fromEntries(result.intel.sightings.map((item) => [item.url, item.identity.match]));
  assert.equal(matches['https://katalog.example/u/1'], 'linked_profile');
  assert.equal(matches['https://katalog.example/u/2'], 'name_only');
  const stop = result.intel.expansion!.stops.find((item) => item.detail.includes('nazw wyświetlanych profili'))!;
  assert.match(stop.detail, new RegExp(`wyszukiwano 1 \\(limit ${MAX_FOLLOWED_NAMES}\\)`));
});

test('odnośniki wzajemne potwierdzają profil wskazujący — jego nazwa wyświetlana też jest tropem', async () => {
  const connector = fakeConnector('profile', 'serwis.example', ['nick', 'profile_url', 'full_name'], (identifier) => {
    if (identifier.value === 'LektorJK') {
      return [{ url: 'https://serwis.example/LektorJK', author: 'LektorJK', text: 'Strona: https://jk.example', profile: { handle: 'LektorJK', displayName: 'Jan Kowalski' }, discoveredIdentifiers: [{ type: 'profile_url' as const, value: 'https://jk.example/' }] }];
    }
    if (identifier.value === 'https://jk.example/') return [{ url: 'https://jk.example/', author: 'jk.example', text: 'Mój profil: LektorJK' }];
    if (identifier.type === 'full_name') return [{ url: 'https://serwis.example/inny', author: 'inny', identityMatch: 'name_only' as const, text: 'Jan Kowalski, hodowca.' }];
    return [];
  });
  const result = await runAnalysis({ query: { identifiers: [{ type: 'nick', value: 'LektorJK' }] }, connectors: [connector], chainProviders: [fakeProvider()] });
  assert.ok(connector.calls.some((call) => call.type === 'full_name' && call.value === 'Jan Kowalski'));
  assert.equal(result.intel.sightings.find((item) => item.url === 'https://serwis.example/inny')!.identity.match, 'name_only');
});

test('wpis łącznika z przedrostkiem powodu zatrzymania trafia do wykazu powodów zatrzymania', async () => {
  const connector = fakeConnector('domeny', 'www', ['full_name'], () => []);
  const search = connector.search.bind(connector);
  connector.search = async (identifier, context) => {
    context.log(`${CONNECTOR_STOP_PREFIX}domeny osobiste: sprawdzono w DNS 12 (limit 12), istnieje 0.`);
    return search(identifier, context);
  };
  const result = await runAnalysis({ query: { identifiers: [fullName] }, connectors: [connector], chainProviders: [fakeProvider()] });
  const stop = result.intel.expansion!.stops.find((item) => item.detail.includes('domeny osobiste'))!;
  assert.equal(stop.reason, 'query_limit');
  assert.equal(stop.detail, '[domeny] domeny osobiste: sprawdzono w DNS 12 (limit 12), istnieje 0.');
});
