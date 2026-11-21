import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Identifier } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { looksLikePersonName } from '../src/persons.ts';
import { BTC_A, BTC_B, BTC_C, decision, dossierOf, fakeConnector, fakeProvider } from './helpers.ts';

const email: Identifier = { type: 'email', value: 'jan.kowalski@poczta.example' };
const nick: Identifier = { type: 'nick', value: 'krypto_janek' };
const fullName: Identifier = { type: 'full_name', value: 'Jan Kowalski' };

const analyse = async (identifiers: Identifier[], connectors: ReturnType<typeof fakeConnector>[]) => {
  const query = { identifiers };
  const result = await runAnalysis({ query, connectors, chainProviders: [fakeProvider()] });
  return { result, query };
};

/** Profil znaleziony po e-mailu i drugi, znaleziony tylko po nicku, ale z tym samym e-mailem. */
const twoProfilesSharingEmail = (location = 'Poznań') => [
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    {
      url: 'https://gitpub.example/jkowalski',
      author: 'jkowalski',
      text: `Wsparcie: ${BTC_A}`,
      profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', emails: ['jan.kowalski@poczta.example'], location: 'Poznań' },
    },
  ]),
  fakeConnector('forum', 'forum.example', ['nick'], () => [
    {
      url: 'https://forum.example/u/krypto_janek',
      author: 'krypto_janek',
      category: 'forum_post' as const,
      text: `Sprzedam, płatność ${BTC_B}`,
      profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', emails: ['Jan.Kowalski@poczta.example'], location },
    },
  ]),
];

test('dwa profile ze wspólnym e-mailem to jedna osoba; e-mail potwierdza profil znaleziony po nicku', async () => {
  const { result, query } = await analyse([email, nick], twoProfilesSharingEmail());
  const dossier = dossierOf(result, query);

  assert.equal(dossier.persons.length, 1);
  const [person] = dossier.persons;
  assert.equal(person!.profileIds.length, 2);
  assert.ok(person!.probability >= 90);
  assert.ok(person!.reasons.some((reason) => reason.includes('identyfikatorze unikalnym')));

  const forum = dossier.profiles.find((profile) => profile.service === 'forum.example')!;
  assert.equal(forum.identityMatch, 'exact_identifier');
  assert.ok(forum.identityScore >= 90);
  assert.ok(forum.identityReasons.some((reason) => reason.includes('zgadza się z identyfikatorem podanym przez analityka')));
  // W zapisanej analizie profil forum był tylko „zgodnym nickiem” (50 − 10); w teczce kara znika.
  assert.equal(result.findings.find((finding) => finding.address === BTC_B)!.confidence.score, 40);
  assert.equal(dossier.findings.find((finding) => finding.address === BTC_B)!.confidence.score, 50);
});

test('imię i nazwisko wybierane z nazwy wyświetlanej zgodnej z e-mailem; cechy z potwierdzeniami', async () => {
  const { result, query } = await analyse([email, nick], twoProfilesSharingEmail());
  const [person] = dossierOf(result, query).persons;

  assert.equal(person!.fullName, 'Jan Kowalski');
  assert.ok(person!.reasons.some((reason) => reason.includes('zgodna z adresem e-mail')));
  const mail = person!.attributes.find((item) => item.kind === 'email')!;
  assert.deepEqual(mail.sources.sort(), ['forum.example', 'gitpub.example']);
  assert.ok(person!.attributes.some((item) => item.kind === 'location' && item.value === 'Poznań'));

  assert.equal(looksLikePersonName('Jan Kowalski'), true);
  assert.equal(looksLikePersonName('krypto_janek'), false);
  assert.equal(looksLikePersonName('KRYPTO KANTOR SP Z O O'), false);
});

test('nazwa wyglądająca jak nick nie jest podawana jako imię i nazwisko', async () => {
  const github = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Adres ${BTC_A}`, profile: { displayName: 'krypto_janek 🚀' } },
  ]);
  const { result, query } = await analyse([nick], [github]);
  const [person] = dossierOf(result, query).persons;

  assert.equal(person!.fullName, undefined);
  assert.ok(person!.reasons.some((reason) => reason.includes('nie ustalono')));
  // Sam nick: ocena średnia, nie wysoka.
  assert.equal(person!.probability, 50);
  assert.equal(dossierOf(result, query).profiles[0]!.identityScore, 50);
});

test('sprzeczne lokalizacje w profilach obniżają prawdopodobieństwo osoby', async () => {
  const consistent = await analyse([email, nick], twoProfilesSharingEmail('Poznań'));
  const conflicting = await analyse([email, nick], twoProfilesSharingEmail('Gdańsk'));
  const high = dossierOf(consistent.result, consistent.query).persons[0]!;
  const low = dossierOf(conflicting.result, conflicting.query).persons[0]!;

  assert.ok(low.probability < high.probability);
  assert.ok(low.reasons.some((reason) => reason.includes('różne lokalizacje')));
});

/** Podmiot z profilem po e-mailu oraz imiennik znaleziony tylko po imieniu i nazwisku, z własnym adresem. */
const subjectAndNamesake = () => [
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    {
      url: 'https://gitpub.example/jkowalski',
      author: 'jkowalski',
      text: `Wsparcie: ${BTC_A}`,
      profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', emails: ['jan.kowalski@poczta.example'] },
    },
  ]),
  fakeConnector('targ', 'targ.example', ['full_name'], () => [
    {
      url: 'https://targ.example/oferta/7',
      author: 'kowalski_auto',
      category: 'sale_offer' as const,
      identityMatch: 'name_only' as const,
      text: `Sprzedam auto, wpłata na ${BTC_C}`,
      profile: { handle: 'kowalski_auto', displayName: 'Jan Kowalski', location: 'Rzeszów' },
    },
  ]),
];

test('imiennik bez wiązań jest osobnym kandydatem i nie podnosi wyniku osoby głównej', async () => {
  const { result, query } = await analyse([email, fullName], subjectAndNamesake());
  // Zapisana analiza przypisuje adres imiennika podmiotowi: ogłoszenie 70 − 20 za samo nazwisko.
  assert.equal(result.findings.find((finding) => finding.address === BTC_C)!.confidence.score, 50);

  const dossier = dossierOf(result, query);
  assert.equal(dossier.persons.length, 2);
  const [main, other] = dossier.persons;
  assert.deepEqual(main!.profileIds, ['gitpub.example|jkowalski']);
  assert.deepEqual(other!.profileIds, ['targ.example|kowalski_auto']);
  assert.ok(other!.probability <= 20);

  assert.equal(dossier.findings.find((finding) => finding.address === BTC_A)!.confidence.score, 85);
  // Adres znany tylko z profilu imiennika nie jest adresem osoby głównej.
  const foreign = dossier.findings.find((finding) => finding.address === BTC_C)!;
  assert.equal(foreign.confidence.score, 0);
  assert.equal(foreign.evidence.length, 0);
  assert.equal(foreign.excludedEvidence!.length, 1);
  assert.match(foreign.annotations![0]!, /innego kandydata/);
  assert.equal(dossier.totals.linkedAddresses, 1);
  assert.ok(dossier.keyFindings.some((item) => item.text.includes('należy prawdopodobnie do innej osoby')));
});

test('łączne prawdopodobieństwo osoba–adres łączy pewność autora i przynależność profilu', async () => {
  const { result, query } = await analyse([email, fullName], subjectAndNamesake());
  const [main, other] = dossierOf(result, query).persons;

  // Osoba główna: własny profil (85), profil należy do niej na pewno.
  assert.deepEqual(main!.addresses, [{ key: `bitcoin:${BTC_A}`, probability: 85 }]);
  // Imiennik: względem AUTORA ogłoszenia adres jest jego (70), choć on sam raczej nie jest podmiotem sprawy.
  assert.deepEqual(other!.addresses, [{ key: `bitcoin:${BTC_C}`, probability: 70 }]);

  // Profil dołączony średnim wiązaniem (jednostronny odnośnik) daje niższe prawdopodobieństwo niż sam Wskaźnik.
  const linking = fakeConnector('gitpub', 'gitpub.example', ['email', 'nick'], (identifier) =>
    identifier.type === 'email'
      ? [{ url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_btc' }] }]
      : [{ url: 'https://gitpub.example/janek_btc', author: 'janek_btc', text: `Adres ${BTC_B}` }],
  );
  const linked = await analyse([email], [linking]);
  const person = dossierOf(linked.result, linked.query).persons[0]!;
  assert.equal(person.profileIds.length, 2);
  // 85 (własny profil względem autora) × 0,5 (jednostronny odnośnik).
  assert.deepEqual(person.addresses, [{ key: `bitcoin:${BTC_B}`, probability: 43 }]);
});

test('profil odległy o dwa niepotwierdzone kroki nie jest doklejany do osoby głównej', async () => {
  const connector = fakeConnector('gitpub', 'gitpub.example', ['email', 'nick'], (identifier) => {
    if (identifier.type === 'email') return [{ url: 'https://gitpub.example/a', author: 'a_konto', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'b_konto' }] }];
    if (identifier.value === 'b_konto') return [{ url: 'https://gitpub.example/b', author: 'b_konto', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'c_konto' }] }];
    return [{ url: 'https://gitpub.example/c', author: 'c_konto', text: `Adres ${BTC_B}` }];
  });
  const { result, query } = await analyse([email], [connector]);
  const dossier = dossierOf(result, query);

  assert.deepEqual(dossier.persons[0]!.profileIds.sort(), ['gitpub.example|a_konto', 'gitpub.example|b_konto']);
  assert.deepEqual(dossier.persons[1]!.profileIds, ['gitpub.example|c_konto']);
  assert.equal(dossier.findings[0]!.confidence.score, 0);
});

test('wzajemne odnośniki między profilami dają potwierdzoną tożsamość i wysoki wynik', async () => {
  const connector = fakeConnector('gitpub', 'gitpub.example', ['email', 'nick'], (identifier) =>
    identifier.type === 'email'
      ? [{ url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_btc' }] }]
      : [{ url: 'https://gitpub.example/janek_btc', author: 'janek_btc', text: `Adres ${BTC_B}`, discoveredIdentifiers: [{ type: 'login' as const, value: 'jkowalski' }] }],
  );
  const { result, query } = await analyse([email], [connector]);
  const dossier = dossierOf(result, query);
  const second = dossier.profiles.find((profile) => profile.handle === 'janek_btc')!;

  assert.equal(dossier.persons.length, 1);
  assert.equal(second.identityMatch, 'verified_link');
  assert.ok(second.identityScore >= 80);
  assert.ok(second.identityReasons.some((reason) => reason.includes('wzajemne odnośniki')));
  assert.equal(dossier.findings[0]!.confidence.score, 85);
});

test('decyzja analityka przenosi profil między kandydatami i przelicza wynik', async () => {
  const { result, query } = await analyse([email, fullName], subjectAndNamesake());
  const key = 'targ.example|kowalski_auto';

  const confirmed = dossierOf(result, query, { decisions: [decision('profile', key, 'confirmed', 'ten sam telefon w aktach')] });
  assert.equal(confirmed.persons.length, 1);
  assert.equal(confirmed.persons[0]!.probability, 100);
  assert.equal(confirmed.profiles.find((profile) => profile.id === key)!.identityMatch, 'verified_link');
  assert.equal(confirmed.findings.find((finding) => finding.address === BTC_C)!.confidence.score, 70);
  assert.equal(confirmed.totals.linkedAddresses, 2);

  // Odrzucenie profilu osoby głównej: jego ślady przestają się liczyć.
  const rejected = dossierOf(result, query, { decisions: [decision('profile', 'https://gitpub.example/jkowalski', 'rejected')] });
  const gitpub = rejected.profiles.find((profile) => profile.service === 'gitpub.example')!;
  assert.equal(gitpub.decision, 'rejected');
  assert.equal(gitpub.identityScore, 0);
  assert.ok(!rejected.persons[0]!.profileIds.includes(gitpub.id));
  assert.equal(rejected.findings.find((finding) => finding.address === BTC_A)!.confidence.score, 0);

  // Bez decyzji wynik wraca do automatycznego.
  assert.equal(dossierOf(result, query).findings.find((finding) => finding.address === BTC_A)!.confidence.score, 85);
});
