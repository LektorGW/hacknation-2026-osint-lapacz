import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Identifier } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { looksLikePersonName } from '../src/persons.ts';
import { BTC_A, BTC_B, BTC_C, ETH_A, decision, dossierOf, fakeConnector, fakeProvider } from './helpers.ts';

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

// ---------- Łączenie z ograniczeniami: sprzeczności, kopie publikacji, adresy usług ----------

const phone = '600 100 200';
const shopMail = 'kontakt@sklep.example';

/** A–B (ten sam telefon), B–C (ten sam e-mail sklepu); A i C deklarują różne imiona i nazwiska, B — żadnego. */
const chainWithContradiction = () => [
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    { url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', emails: [email.value], phones: [phone] } },
  ]),
  fakeConnector('forum', 'forum.example', ['nick'], () => [
    { url: 'https://forum.example/u/krypto_janek', author: 'krypto_janek', text: 'Profil bez nazwiska.', profile: { handle: 'krypto_janek', phones: ['+48 600-100-200'], emails: [shopMail] } },
  ]),
  fakeConnector('targ', 'targ.example', ['nick'], () => [
    { url: 'https://targ.example/u/krypto_janek', author: 'krypto_janek', category: 'sale_offer' as const, text: `Skup, wpłaty na ${BTC_C}`, profile: { handle: 'krypto_janek', displayName: 'Piotr Nowak', emails: [shopMail] } },
  ]),
];

test('łączenie nie jest przechodnie: A–B i B–C nie skleja A z C, gdy deklarują różne nazwiska', async () => {
  const { result, query } = await analyse([email, nick], chainWithContradiction());
  const dossier = dossierOf(result, query);
  const [a, b, c] = ['gitpub.example|jkowalski', 'forum.example|krypto_janek', 'targ.example|krypto_janek'];

  const [main, other] = dossier.persons;
  assert.equal(dossier.persons.length, 2);
  assert.deepEqual([...main!.profileIds].sort(), [b, a]);
  assert.deepEqual(other!.profileIds, [c]);
  assert.ok(!dossier.persons.some((person) => person.profileIds.includes(a) && person.profileIds.includes(c)));
  // Pominięte połączenie B–C jest wykazane u obu kandydatów, z powodem wskazującym sprzeczną parę.
  for (const person of [main!, other!]) {
    assert.equal(person.status, 'hypothesis');
    assert.deepEqual(person.blockedMerges!.map((item) => [[...item.profileIds].sort(), item.weight]), [[[b, c].sort(), 100]]);
    assert.match(person.blockedMerges![0]!.reason, /sprzeczne deklarowane imiona i nazwiska: .*(Jan Kowalski.*Piotr Nowak|Piotr Nowak.*Jan Kowalski)/);
    assert.ok(person.reasons.some((reason) => reason.startsWith('Nie połączono profili') && reason.includes('mimo wiązania o wadze 100')));
  }
  // Adres konta C nie jest adresem osoby głównej.
  assert.equal(dossier.findings.find((finding) => finding.address === BTC_C)!.confidence.score, 0);

  // Hipoteza B–C: mocne przesłanki, ale zablokowana sprzecznością w grupie; pary A–C nie łączy nic.
  const hypothesis = dossier.indicators.commonOperator.find((item) => item.accounts.includes(b) && item.accounts.includes(c))!;
  assert.equal(hypothesis.status, 'blocked');
  assert.ok(hypothesis.indicator.score <= 45);
  const conflict = hypothesis.indicator.components.find((item) => item.rule === 'operator.conflict.cluster')!;
  assert.deepEqual([conflict.direction, conflict.blocking], ['contradicts', true]);
  assert.ok(!dossier.indicators.commonOperator.some((item) => item.accounts.includes(a) && item.accounts.includes(c)));
  assert.equal(dossier.indicators.commonOperator.find((item) => item.accounts.includes(a) && item.accounts.includes(b))!.status, 'auto_grouped');
});

/** Podmiot z własnym profilem i drugie konto (to samo imię i nazwisko), które podaje ten sam adres na różne sposoby. */
const secondAccountWith = (doc: { category: 'sale_offer' | 'forum_post'; text: string }) => [
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    {
      url: 'https://gitpub.example/jkowalski',
      author: 'jkowalski',
      text: `Przyjmuję wpłaty za zlecenia programistyczne na adres ${BTC_A} dziękuję`,
      profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', emails: [email.value] },
    },
  ]),
  fakeConnector('targ', 'targ.example', ['full_name'], () => [
    { url: 'https://targ.example/oferta/7', author: 'kowalski_auto', identityMatch: 'name_only' as const, ...doc, profile: { handle: 'kowalski_auto', displayName: 'Jan Kowalski' } },
  ]),
];

test('ten sam adres łączy profile tylko jako niezależna deklaracja własności — nie jako wzmianka ani kopia treści', async () => {
  const personsOf = async (doc: { category: 'sale_offer' | 'forum_post'; text: string }) => {
    const { result, query } = await analyse([email, fullName], secondAccountWith(doc));
    return dossierOf(result, query);
  };
  const pairOf = (dossier: Awaited<ReturnType<typeof personsOf>>) => dossier.indicators.commonOperator.find((item) => item.accounts.includes('targ.example|kowalski_auto'))!;

  // Własna, niezależnie sformułowana oferta z tym samym adresem: mocne wiązanie (80) — jedna osoba.
  const owned = await personsOf({ category: 'sale_offer', text: `Sprzedam auto, zaliczka na ${BTC_A}` });
  assert.equal(owned.persons.length, 1);
  assert.ok(pairOf(owned).indicator.components.some((item) => item.rule === 'operator.same_owned_address' && item.applied === 80));

  // Wzmianka w wypowiedzi: słaba przesłanka (30 + 15 za nazwę) — osobni kandydaci.
  const mentioned = await personsOf({ category: 'forum_post', text: `Czy ktoś kojarzy adres ${BTC_A}? Podobno oszust.` });
  assert.equal(mentioned.persons.length, 2);
  const mention = pairOf(mentioned).indicator.components.find((item) => item.rule === 'operator.same_address_mention')!;
  assert.equal(mention.weight, 30);
  assert.match(mention.limitations[0]!, /nie dowodzi wspólnego operatora/);
  assert.equal(pairOf(mentioned).status, 'hypothesis');
  assert.ok(pairOf(mentioned).indicator.score < 50);

  // Ta sama treść skopiowana do drugiego serwisu: kopia, nie druga deklaracja — też osobni kandydaci.
  const copied = await personsOf({ category: 'sale_offer', text: `Przyjmuję wpłaty za zlecenia programistyczne na adres ${BTC_A} dziękuję` });
  assert.equal(copied.persons.length, 2);
  assert.match(pairOf(copied).indicator.components.find((item) => item.rule === 'operator.same_address_mention')!.explanation, /kopia publikacji/);
  assert.ok(!pairOf(copied).indicator.components.some((item) => item.rule === 'operator.same_owned_address'));
});

test('dwa konta publikujące ten sam adres GIEŁDY nie są jedną osobą; składnik wyjaśnia, że adresu nie policzono', async () => {
  const query = { identifiers: [email, fullName] };
  const connectors = secondAccountWith({ category: 'sale_offer', text: `Sprzedam auto, zaliczka na ${BTC_A}` });
  const result = await runAnalysis({ query, connectors, chainProviders: [fakeProvider({ [BTC_A]: 'exchange' })] });
  const dossier = dossierOf(result, query);

  assert.equal(dossier.persons.length, 2);
  assert.ok(dossier.persons.every((person) => person.profileIds.length === 1 && person.blockedMerges === undefined));
  const [hypothesis] = dossier.indicators.commonOperator;
  assert.deepEqual(hypothesis!.accounts, ['gitpub.example|jkowalski', 'targ.example|kowalski_auto']);
  // Zostaje tylko słaba przesłanka (ta sama nazwa wyświetlana, 15); adres giełdy jest wykazany jako niepoliczony.
  assert.deepEqual([hypothesis!.status, hypothesis!.indicator.score], ['hypothesis', 15]);
  const notCounted = hypothesis!.indicator.components.find((item) => item.rule === 'operator.shared_or_institutional_address')!;
  assert.equal(Math.abs(notCounted.applied), 0);
  assert.match(notCounted.explanation, /NIE został policzony/);
  assert.deepEqual(notCounted.evidence[0], { kind: 'address', value: BTC_A });
  assert.ok(!hypothesis!.indicator.components.some((item) => item.rule === 'operator.same_owned_address'));
  // Konto → portfel: publikacja odnotowana, ale to nie jest portfel prywatny żadnego z kont.
  assert.deepEqual(dossier.indicators.accountWallet.map((link) => [link.accountId, link.notPrivateWallet, link.indicator.score]), [
    ['gitpub.example|jkowalski', true, 0],
    ['targ.example|kowalski_auto', true, 0],
  ]);
});

test('ten sam nick w dwóch serwisach u różnych osób: osobni kandydaci i najwyżej słaba hipoteza', async () => {
  const connectors = [
    fakeConnector('forum', 'forum.example', ['nick'], () => [
      { url: 'https://forum.example/u/krypto_janek', author: 'krypto_janek', text: `Mój adres ${BTC_A}`, profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', location: 'Poznań' } },
    ]),
    fakeConnector('targ', 'targ.example', ['nick'], () => [
      { url: 'https://targ.example/u/krypto_janek', author: 'krypto_janek', category: 'sale_offer' as const, text: `Skup, wpłaty na ${BTC_C}`, profile: { handle: 'krypto_janek', displayName: 'Piotr Nowak', location: 'Gdańsk' } },
    ]),
  ];
  const { result, query } = await analyse([nick], connectors);
  const dossier = dossierOf(result, query);

  assert.equal(dossier.persons.length, 2);
  assert.ok(dossier.persons.every((person) => person.profileIds.length === 1 && person.status === 'hypothesis'));
  // Adresy nie są łączone: każdy kandydat ma tylko swój.
  assert.deepEqual(dossier.persons.flatMap((person) => person.addresses.map((item) => item.key)).sort(), [`bitcoin:${BTC_A}`, `bitcoin:${BTC_C}`].sort());
  assert.ok(dossier.persons.every((person) => person.addresses.length === 1));
  const [hypothesis] = dossier.indicators.commonOperator;
  assert.equal(dossier.indicators.commonOperator.length, 1);
  assert.equal(hypothesis!.status, 'hypothesis');
  // Sam nick (20) minus sprzeczne nazwiska (10) i lokalizacje (10).
  assert.equal(hypothesis!.indicator.score, 0);
  assert.deepEqual(hypothesis!.indicator.components.map((item) => item.rule).sort(), ['operator.conflict.declared_name', 'operator.conflict.location', 'operator.same_handle']);
  assert.match(hypothesis!.indicator.components.find((item) => item.rule === 'operator.same_handle')!.limitations[0]!, /często używany przez różne osoby/);
  assert.match(hypothesis!.statement, /nie jest to ustalenie tożsamości/);
});

test('jeden operator, trzy persony: uzasadniona hipoteza ze składnikami, nigdy „potwierdzona” bez analityka', async () => {
  const mail = email.value;
  const connectors = [
    fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
      { url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: `Wsparcie projektu: ${BTC_A}`, profile: { handle: 'jkowalski', emails: [mail] }, discoveredIdentifiers: [{ type: 'nick' as const, value: 'mroczny_handlarz' }] },
    ]),
    fakeConnector('forum', 'forum.example', ['email'], () => [
      { url: 'https://forum.example/u/mroczny_handlarz', author: 'mroczny_handlarz', text: `Handel wyłącznie na mój adres ${BTC_A}, bez pośredników`, profile: { handle: 'mroczny_handlarz', emails: [mail] }, discoveredIdentifiers: [{ type: 'login' as const, value: 'jkowalski' }] },
    ]),
    fakeConnector('targ', 'targ.example', ['email'], () => [
      { url: 'https://targ.example/u/btc_skup_24', author: 'btc_skup_24', category: 'sale_offer' as const, text: `Skup kryptowalut całą dobę, wpłaty kierować na ${BTC_A}`, profile: { handle: 'btc_skup_24', emails: [mail] } },
    ]),
  ];
  const { result, query } = await analyse([email], connectors);
  const dossier = dossierOf(result, query);

  assert.equal(dossier.persons.length, 1);
  assert.equal(dossier.persons[0]!.profileIds.length, 3);
  assert.equal(dossier.persons[0]!.status, 'hypothesis');
  const hypotheses = dossier.indicators.commonOperator;
  assert.equal(hypotheses.length, 3);
  for (const hypothesis of hypotheses) {
    assert.equal(hypothesis.status, 'auto_grouped');
    assert.equal(hypothesis.indicator.kind, 'common_operator');
    assert.equal(hypothesis.indicator.calibrated, false);
    // Bez decyzji analityka wskaźnik nie osiąga 100.
    assert.equal(hypothesis.indicator.score, 95);
    assert.match(hypothesis.statement, /Przesłanki wspólnego operatora — nie jest to ustalenie tożsamości\./);
    assert.equal(hypothesis.decision, undefined);
    const byRule = new Map(hypothesis.indicator.components.map((item) => [item.rule, item]));
    const mailComponent = byRule.get('operator.same_email')!;
    assert.deepEqual([mailComponent.weight, mailComponent.applied, mailComponent.direction], [100, 100, 'supports']);
    assert.deepEqual(mailComponent.evidence[0], { kind: 'attribute', value: mail });
    assert.ok(mailComponent.limitations.length > 0 && mailComponent.explanation.length > 0 && mailComponent.source.length > 0);
    // Kolejna niezależna przesłanka dolicza tylko część wagi (20%, łącznie najwyżej 15).
    const addressComponent = byRule.get('operator.same_owned_address')!;
    assert.equal(addressComponent.weight, 80);
    assert.ok(addressComponent.applied < 80 && addressComponent.independence === 'independent');
    assert.ok(hypothesis.path.length >= 3);
  }
  const mutual = hypotheses.find((item) => item.accounts.includes('gitpub.example|jkowalski') && item.accounts.includes('forum.example|mroczny_handlarz'))!;
  assert.ok(mutual.indicator.components.some((item) => item.rule === 'operator.mutual_links' && item.weight === 90));
  assert.ok(!hypotheses.some((item) => item.status === 'confirmed'));
  // Konto → portfel: trzy konta deklarują ten sam adres, każde z własnym wskaźnikiem ze swoich publikacji.
  assert.deepEqual(dossier.indicators.accountWallet.map((link) => [link.accountId, link.indicator.score, link.status, link.notPrivateWallet]).sort(), [
    ['forum.example|mroczny_handlarz', 85, 'computed', false],
    ['gitpub.example|jkowalski', 85, 'computed', false],
    ['targ.example|btc_skup_24', 70, 'computed', false],
  ]);
});

test('konto → portfel: adres smart kontraktu nie jest portfelem prywatnym, a wzmianka waży mniej niż deklaracja', async () => {
  const connectors = [
    fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
      { url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: `Kontrakt puli: ${ETH_A}, wsparcie: ${BTC_A}`, profile: { handle: 'jkowalski', emails: [email.value] } },
    ]),
    fakeConnector('forum', 'forum.example', ['email'], () => [
      { url: 'https://forum.example/p/1', author: 'jkowalski', category: 'forum_post' as const, text: `W dyskusji padł adres ${BTC_B}`, profile: { handle: 'jkowalski', emails: [email.value] } },
    ]),
  ];
  const query = { identifiers: [email] };
  const result = await runAnalysis({ query, connectors, chainProviders: [fakeProvider({ [ETH_A]: 'smart_contract' })] });
  const dossier = dossierOf(result, query);
  const linkOf = (address: string) => dossier.indicators.accountWallet.find((link) => link.address === address)!;

  const contract = linkOf(ETH_A);
  assert.deepEqual([contract.accountId, contract.addressClass, contract.notPrivateWallet, contract.indicator.score, contract.status], ['gitpub.example|jkowalski', 'smart_contract', true, 0, 'computed']);
  const exclusion = contract.indicator.components.find((item) => item.rule === 'wallet.exclusion.address_class')!;
  assert.deepEqual([exclusion.applied, exclusion.direction], [0, 'contradicts']);
  assert.match(exclusion.explanation, /smart kontrakt/);
  // W teczce adres kontraktu jest wykluczony i nie wchodzi do adresów powiązanych.
  const finding = dossier.findings.find((item) => item.address === ETH_A)!;
  assert.deepEqual([finding.confidence.excluded, finding.confidence.score, finding.subjectProbability], [true, 0, 0]);
  assert.ok(!dossier.cashOutProof.some((proof) => JSON.stringify(proof).includes(ETH_A)));

  // Deklaracja na własnym profilu: 85; sama wzmianka w wypowiedzi: 50 − 20, z jawnym ograniczeniem.
  assert.equal(linkOf(BTC_A).indicator.score, 85);
  const mention = linkOf(BTC_B);
  assert.equal(mention.indicator.score, 30);
  assert.ok(mention.indicator.limitations.includes('wzmianka, nie deklaracja własności'));
  assert.deepEqual(mention.indicator.components.map((item) => [item.rule, item.applied]), [['wallet.base.forum_post', 50], ['wallet.mention_only', -20]]);
  // Odrzucenie adresu przez analityka zeruje wskaźnik i zmienia status twierdzenia.
  const rejected = dossierOf(result, query, { decisions: [decision('address', `bitcoin:${BTC_A}`, 'rejected')] }).indicators.accountWallet.find((link) => link.address === BTC_A)!;
  assert.deepEqual([rejected.status, rejected.indicator.score], ['rejected', 0]);
});

test('potwierdzenie jednego profilu nie dołącza innego konta; odrzucona para i sprzeczność wstrzymują łączenie', async () => {
  const { result, query } = await analyse([email, fullName], subjectAndNamesake());
  const [main, namesake] = ['gitpub.example|jkowalski', 'targ.example|kowalski_auto'];

  // Analityk potwierdza TYLKO profil główny: imiennik (bez wiązań) nie trafia do osoby głównej ani nie dostaje statusu „potwierdzony”.
  const confirmedMain = dossierOf(result, query, { decisions: [decision('profile', main, 'confirmed', 'profil z akt')] });
  assert.equal(confirmedMain.persons.length, 2);
  assert.deepEqual(confirmedMain.persons[0]!.profileIds, [main]);
  assert.equal(confirmedMain.persons[0]!.status, 'confirmed');
  const other = confirmedMain.persons.find((person) => person.profileIds.includes(namesake))!;
  assert.notEqual(other.status, 'confirmed');
  assert.ok(!other.profileIds.includes(main));
  assert.equal(confirmedMain.findings.find((finding) => finding.address === BTC_C)!.confidence.score, 0);

  // Potwierdzenie imiennika przy decyzji „to nie ten sam operator” dla pary: profil wyznaczający osobę główną
  // NIE jest do niego doklejany, a pominięte połączenie jest wykazane z powodem.
  const rejectedPair = decision('link', `${main}<->${namesake}`, 'rejected', 'różne osoby');
  const withRejected = dossierOf(result, query, { decisions: [decision('profile', namesake, 'confirmed'), rejectedPair] });
  assert.ok(!withRejected.persons.some((person) => person.profileIds.includes(main) && person.profileIds.includes(namesake)));
  const skipped = withRejected.persons.flatMap((person) => person.blockedMerges ?? []);
  assert.ok(skipped.some((item) => [...item.profileIds].sort().join() === [main, namesake].sort().join() && /decyzja analityka/.test(item.reason)));
  // Bez odrzuconej pary potwierdzenie imiennika nadal dołącza go do osoby głównej (zachowanie bez zmian).
  assert.equal(dossierOf(result, query, { decisions: [decision('profile', namesake, 'confirmed')] }).persons.length, 1);

  // Oba profile potwierdzone, ale para odrzucona: nie są łączone, a pominięte połączenie jest wykazane z powodem.
  const both = dossierOf(result, query, { decisions: [decision('profile', main, 'confirmed'), decision('profile', namesake, 'confirmed'), rejectedPair] });
  assert.ok(!both.persons.some((person) => person.profileIds.includes(main) && person.profileIds.includes(namesake)));
  const blocked = both.persons.flatMap((person) => person.blockedMerges ?? []);
  assert.ok(blocked.some((item) => [...item.profileIds].sort().join() === [main, namesake].sort().join() && /decyzja analityka/.test(item.reason)));
});
