import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutTrail, FlowHop, Identifier } from '@olcys/core';
import { canonicalUrl, runAnalysis } from '../src/analysis.ts';
import { insightEffect } from '../src/ai-rules.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, ETH_A, chainWith, decision, dossierOf, evidence, fakeAi, fakeConnector, fakeProvider, transfer } from './helpers.ts';

const email: Identifier = { type: 'email', value: 'jan.kowalski@poczta.example' };
const nick: Identifier = { type: 'nick', value: 'krypto_janek' };
const BINANCE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const KRAKEN = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';

const hop = (index: number, from: string, to: string, extra: Partial<FlowHop> = {}): FlowHop => ({
  txid: index.toString(16).padStart(64, '0'),
  time: `2025-03-1${index}T10:00:00.000Z`,
  from,
  to,
  asset: 'BTC',
  amount: 0.4,
  explorerUrl: `https://explorer.example/tx/${index}`,
  ...extra,
});

/** Ścieżka w dwóch krokach: adres podmiotu → adres pośredni → portfel giełdy. */
const TWO_HOPS: CashOutTrail = {
  id: 'sciezka-1',
  sourceAddress: BTC_A,
  network: 'bitcoin',
  hops: [hop(1, BTC_A, BTC_D), hop(2, BTC_D, BINANCE, { toLabel: 'Binance 14', toClass: 'exchange' })],
  serviceName: 'Binance',
  serviceKind: 'exchange_deposit',
  asset: 'BTC',
  amount: 0.4,
  valuePln: 130_000,
  valuation: 'kurs testowy',
  confidence: 85,
  reasons: ['Adres pośredni przekazał całość na portfel giełdy w ciągu 2 godzin.'],
  openQuestions: ['Kto jest klientem giełdy przypisanym do adresu wpłat?', 'Czy i kiedy wypłacono środki na rachunek bankowy?'],
};
/** Ścieżka z adresu zaliczonego do portfela podmiotu heurystyką. */
const FROM_CLUSTER: CashOutTrail = {
  ...TWO_HOPS,
  id: 'sciezka-2',
  sourceAddress: BTC_C,
  hops: [hop(3, BTC_C, KRAKEN, { toLabel: 'Kraken 4', toClass: 'exchange' })],
  serviceName: 'Kraken',
  valuePln: 50_000,
  confidence: 90,
  reasons: ['Bezpośredni przelew na oznaczony portfel giełdy.'],
};

const profileByEmail = (text = `Wsparcie: ${BTC_A}`) =>
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    { url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text, profile: { handle: 'jkowalski', displayName: 'Jan Kowalski' } },
  ]);

test('dowód spieniężenia: osoba → adres → ścieżka, z łączną pewnością i jej składnikami', async () => {
  const query = { identifiers: [email] };
  const chain = chainWith({
    [BTC_A]: {
      trails: [TWO_HOPS, FROM_CLUSTER],
      cluster: { seed: BTC_A, network: 'bitcoin', addresses: [{ address: BTC_C, reason: 'wspólne wejścia w transakcji' }], method: ['wspólne wejścia'] },
    },
  });
  const dossier = dossierOf(await runAnalysis({ query, connectors: [profileByEmail()], chainProviders: [chain] }), query);

  assert.deepEqual(dossier.cashOutProof.map((proof) => proof.id), ['sciezka-1', 'sciezka-2']);
  const [direct, viaCluster] = dossier.cashOutProof;

  // Osoba 90% × adres na własnym profilu 85% = 77% (łączne prawdopodobieństwo osoba–adres).
  assert.deepEqual(direct!.person, { id: 'osoba-1', fullName: 'Jan Kowalski', probability: 90 });
  assert.equal(dossier.findings[0]!.subjectProbability, 77);
  assert.equal(direct!.personAddressProbability, 77);
  assert.equal(direct!.trailConfidence, 85);
  // Wzór: 77 × 85 / 100 = 65.
  assert.equal(direct!.combinedConfidence, 65);
  assert.equal(direct!.tier, 'wysoka');
  assert.equal(direct!.addressBasis, 'published');
  assert.equal(direct!.layer, 'calculation');
  assert.equal(direct!.components.at(-1), 'Łączna pewność ustalenia = 77 × 85 / 100 = 65% (wysoka).');
  assert.deepEqual(direct!.trail.openQuestions, TWO_HOPS.openQuestions);

  // Adres z klastra portfela: dopisek o heurystyce i obniżka × 0,8.
  assert.equal(viaCluster!.addressBasis, 'cluster');
  assert.deepEqual(viaCluster!.cluster, { seed: BTC_A, reason: 'wspólne wejścia w transakcji' });
  assert.equal(viaCluster!.personAddressProbability, 62);
  assert.equal(viaCluster!.combinedConfidence, 56);
  assert.equal(viaCluster!.layer, 'inference');
  assert.ok(viaCluster!.components.some((item) => item.includes('heurystyką') && item.includes('× 0,8')));

  // Kluczowe ustalenia: zaraz po osobie.
  assert.match(dossier.keyFindings[0]!.text, /^Najbardziej prawdopodobna osoba: Jan Kowalski/);
  assert.match(
    dossier.keyFindings[1]!.text,
    /^Udokumentowano przekazanie 0,4 BTC \(ok\. 130 tys\. zł\) z adresu 1A1zP1eP5Q…v7DivfNa do usługi Binance w 2 krokach — pewność ścieżki 85%, łączna pewność ustalenia 65%\.$/,
  );

  // Usługa, priorytet, oś czasu i graf korzystają ze ścieżki.
  const binance = dossier.serviceLinks.find((link) => link.name === 'Binance')!;
  assert.deepEqual(binance.basis, ['deposit_address']);
  assert.deepEqual([binance.transfers[0]!.viaAddress, binance.transfers[0]!.serviceAddress, binance.outPln], [BTC_D, BINANCE, 130_000]);
  assert.ok(dossier.totals.priorityReasons.some((reason) => reason.startsWith('Dowód spieniężenia: udokumentowana ścieżka środków do usługi, łączna pewność ustalenia 65%')));
  assert.ok(dossier.timeline.some((event) => event.kind === 'cash_out' && event.title.startsWith('Środki dotarły do usługi Binance') && event.valuePln === 130_000));
  const path = dossier.graph.edges.filter((edge) => edge.kind === 'cash_out').map((edge) => [edge.from, edge.to]);
  assert.ok(path.some(([from, to]) => from === `addr:bitcoin:${BTC_A}` && to === `addr:bitcoin:${BTC_D}`));
  assert.ok(path.some(([from, to]) => from === `addr:bitcoin:${BTC_D}` && to === 'svc:binance'));
  const ids = new Set(dossier.graph.nodes.map((node) => node.id));
  assert.ok(dossier.graph.edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
});

test('dowód spieniężenia: adres podany przez analityka liczy się jako 100%; bez ścieżek sekcja jest pusta', async () => {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const withTrail = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [chainWith({ [BTC_A]: { trails: [TWO_HOPS] } })] }), query);
  assert.equal(withTrail.cashOutProof[0]!.addressBasis, 'analyst');
  assert.equal(withTrail.cashOutProof[0]!.personAddressProbability, 100);
  assert.equal(withTrail.cashOutProof[0]!.combinedConfidence, 85);
  assert.equal(withTrail.cashOutProof[0]!.person, null);

  // Dane bez ścieżek: dotychczasowe zachowanie oparte na wskaźnikach wypłat.
  const plain = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [fakeProvider()] }), query);
  assert.deepEqual(plain.cashOutProof, []);
  assert.deepEqual(plain.totals.cashOutPlnByYear, { '2025': 132_000 });
  assert.ok(plain.serviceLinks.some((link) => link.name === 'Giełda Testowa'));
});

// ---------- Model językowy: reguły wykorzystania ----------

const profileAndPost = () => [
  fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie projektu: ${BTC_A}` },
  ]),
  fakeConnector('forum', 'forum.example', ['nick'], () => [
    { url: 'https://forum.example/t/7', author: 'krypto_janek', category: 'forum_post' as const, text: `Uwaga na oszusta, podaje adres ${BTC_A} — nie wpłacajcie!` },
  ]),
];

test('model: ostrzeżenie o adresie wyłącza ślad (z wpisem w księdze), decyzja analityka to cofa', async () => {
  const query = { identifiers: [nick] };
  const ai = fakeAi((input) =>
    input.text.includes('oszusta')
      ? { ownership: 'warning_about_address', quote: 'Uwaga na oszusta, podaje adres' }
      : { ownership: 'own_address', quote: 'Wsparcie projektu', suggestedCategory: 'sale_offer' },
  );
  const withoutModel = dossierOf(await runAnalysis({ query, connectors: profileAndPost(), chainProviders: [fakeProvider()] }), query);
  // Same reguły: 85 − 10 + 15 za drugie źródło.
  assert.equal(withoutModel.findings[0]!.confidence.score, 90);

  const result = await runAnalysis({ query, connectors: profileAndPost(), chainProviders: [fakeProvider()], ai });
  // Odczyt jest zapisany przy śladzie, ale zapisana analiza liczy same reguły.
  assert.equal(result.findings[0]!.confidence.score, 90);
  const post = result.findings[0]!.evidence.find((item) => item.service === 'forum.example')!;
  assert.equal(post.insight!.ownership, 'warning_about_address');
  assert.deepEqual(ai.calls.publications.map((call) => call.address), [BTC_A, BTC_A]);
  assert.ok(result.log.some((entry) => entry.message.includes('[model atrapa-1] odczytano publikacji: 2 z 2')));

  const dossier = dossierOf(result, query);
  const [finding] = dossier.findings;
  assert.equal(finding!.confidence.score, 75);
  assert.deepEqual(finding!.evidence.map((item) => item.service), ['gitpub.example']);
  assert.deepEqual(finding!.excludedEvidence!.map((item) => item.service), ['forum.example']);
  const entry = finding!.confidence.ledger.at(-1)!;
  assert.equal(entry.rule, 'ai.ownership');
  assert.equal(entry.delta, -15);
  assert.deepEqual(entry.evidenceIds, [post.id]);
  for (const expected of ['autor ostrzega przed tym adresem', 'Cytat: „Uwaga na oszusta, podaje adres”', 'model atrapa-1', 'wersja polecenia p1']) {
    assert.ok(entry.explanation.includes(expected), expected);
  }
  // „Własny adres” to tylko przesłanka; inna kategoria — tylko adnotacja.
  assert.ok(finding!.annotations!.some((note) => note.includes('przesłanka potwierdzająca, bez zmiany punktów')));
  assert.ok(finding!.annotations!.some((note) => note.includes('Model sugeruje inną kategorię publikacji (sale_offer) niż źródło (own_profile)')));

  // Analityk cofa wpływ modelu decyzją dla śladu albo dla profilu.
  const undone = dossierOf(result, query, { decisions: [decision('evidence' as 'profile', post.id, 'confirmed')] });
  assert.equal(undone.findings[0]!.confidence.score, 90);
  assert.ok(!undone.findings[0]!.confidence.ledger.some((item) => item.rule === 'ai.ownership'));
  const byProfile = dossierOf(result, query, { decisions: [decision('profile', 'forum.example|krypto_janek', 'confirmed')] });
  assert.equal(byProfile.findings[0]!.evidence.length, 2);
  // Analityk może też sam odrzucić pojedynczy ślad.
  const gitpubId = result.findings[0]!.evidence.find((item) => item.service === 'gitpub.example')!.id;
  const rejected = dossierOf(result, query, { decisions: [decision('evidence' as 'profile', gitpubId, 'rejected')] });
  assert.equal(rejected.findings[0]!.evidence.length, 0);
});

test('model: odczyt bez zweryfikowanego cytatu nie zmienia wyniku; błąd modelu nie przerywa analizy', async () => {
  const query = { identifiers: [nick] };
  const unverified = fakeAi(() => ({ ownership: 'third_party_address', quote: '' }));
  const dossier = dossierOf(await runAnalysis({ query, connectors: profileAndPost(), chainProviders: [fakeProvider()], ai: unverified }), query);
  assert.equal(dossier.findings[0]!.confidence.score, 90);
  assert.equal(dossier.findings[0]!.excludedEvidence, undefined);

  assert.equal(insightEffect({ ...evidence('https://x.example'), insight: undefined }), undefined);
  assert.equal(insightEffect({ ...evidence('https://x.example'), insight: { ownership: 'quoted', quote: 'cytat', language: 'pl', model: 'm', promptVersion: 'p' } })!.effect, 'excludes');
  assert.equal(insightEffect({ ...evidence('https://x.example'), insight: { ownership: 'unclear', quote: '', language: 'pl', model: 'm', promptVersion: 'p' } })!.effect, 'none');

  const broken = fakeAi(() => new Error('limit zapytań'));
  const result = await runAnalysis({ query, connectors: profileAndPost(), chainProviders: [fakeProvider()], ai: broken });
  assert.equal(result.findings[0]!.confidence.score, 90);
  assert.ok(result.findings[0]!.evidence.every((item) => item.insight === undefined));
  assert.ok(result.log.some((entry) => entry.message.includes('BŁĄD odczytu') && entry.message.includes('limit zapytań')));

  // Limit liczby publikacji czytanych przez model: najpierw ślady najmocniejsze.
  const limited = fakeAi();
  await runAnalysis({ query, connectors: profileAndPost(), chainProviders: [fakeProvider()], ai: limited, maxAiPublications: 1 });
  assert.equal(limited.calls.publications.length, 1);
  assert.ok(limited.calls.publications[0]!.text.includes('Wsparcie projektu'));
});

test('model: porównanie autorów to słaba przesłanka — nie łączy profili', async () => {
  const query = { identifiers: [nick] };
  // Ten sam nick w dwóch serwisach, różne adresy: wiązanie 20 („możliwe, ale niepotwierdzone”).
  const connectors = [
    fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Adres ${BTC_A}` }]),
    fakeConnector('forum', 'forum.example', ['nick'], () => [{ url: 'https://forum.example/u/krypto_janek', author: 'krypto_janek', text: `Adres ${BTC_B}` }]),
  ];
  const ai = fakeAi();
  const result = await runAnalysis({ query, connectors, chainProviders: [fakeProvider()], ai });
  assert.equal(ai.calls.comparisons, 1);
  assert.deepEqual(result.intel.authorComparisons, [
    { a: 'gitpub.example|krypto_janek', b: 'forum.example|krypto_janek', likelihood: 80, reasons: ['podobne zwroty'], model: 'atrapa-1' },
  ]);

  const dossier = dossierOf(result, query);
  assert.equal(dossier.persons.length, 2);
  assert.ok(dossier.profiles.every((profile) => profile.identityReasons.some((reason) => reason.includes('model atrapa-1: podobny styl wypowiedzi (80%)') && reason.includes('waga 28, poniżej progu 50'))));
  // Bez modelu nie ma ani porównań, ani dodatkowych przesłanek.
  const plain = await runAnalysis({ query, connectors, chainProviders: [fakeProvider()] });
  assert.equal(plain.intel.authorComparisons, undefined);
});

// ---------- Jakość na prawdziwych danych ----------

test('adres powszechnie cytowany nie jest przypisywany osobie', async () => {
  const query = { identifiers: [nick] };
  const authors = Array.from({ length: 10 }, (_, index) => `autor_${index}`);
  const profile = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Darowizny dla projektu: ${BTC_A}` }]);
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) =>
    authors.map((author) => ({ url: `https://forum.example/p/${author}`, author, category: 'forum_post' as const, text: `Wspierajcie projekt: ${identifier.value}` })),
  );
  const result = await runAnalysis({ query, connectors: [profile, forum], chainProviders: [fakeProvider()] });
  const [finding] = result.findings;

  assert.equal(finding!.widelyCited, true);
  assert.equal(finding!.unrelatedPublishers, 10);
  assert.deepEqual([finding!.confidence.score, finding!.confidence.excluded], [0, true]);
  assert.equal(finding!.confidence.ledger.at(-1)!.rule, 'exclusion.widely_cited');
  assert.match(finding!.notes![0]!, /Adres powszechnie cytowany: publikuje go 10 niepowiązanych autorów/);

  const dossier = dossierOf(result, query);
  assert.equal(dossier.findings[0]!.confidence.excluded, true);
  assert.equal(dossier.findings[0]!.widelyCited, true);
  assert.ok(dossier.findings[0]!.annotations!.some((note) => note.startsWith('Adres powszechnie cytowany')));
  assert.equal(dossier.totals.linkedAddresses, 0);
  assert.equal(dossier.serviceLinks.length, 0);

  // Poniżej progu działa zwykła kara za adres współdzielony.
  const fewer = await runAnalysis({ query, connectors: [profile, forum], chainProviders: [fakeProvider()], widelyCitedAuthors: 20 });
  assert.deepEqual([fewer.findings[0]!.widelyCited, fewer.findings[0]!.confidence.score], [undefined, 45]);
});

test('limit adresów do analizy blockchain: najpierw podane przez analityka i najlepiej udokumentowane', async () => {
  const query = { identifiers: [nick, { type: 'crypto_address' as const, value: BTC_D }] };
  const calls: string[] = [];
  const provider = { ...fakeProvider(), getActivity: async (network: 'bitcoin', address: string) => (calls.push(address), fakeProvider().getActivity(network, address, { log() {} })) };
  const connectors = [
    fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Mój adres ${BTC_A}` }]),
    fakeConnector('social', 'social.example', ['nick'], () => [
      { url: 'https://social.example/1', author: 'krypto_janek', category: 'mass_comment' as const, text: `rozdanie ${BTC_B} oraz ${ETH_A}` },
    ]),
  ];
  const result = await runAnalysis({ query, connectors, chainProviders: [provider], maxChainAddresses: 2 });

  assert.deepEqual(calls.sort(), [BTC_A, BTC_D].sort());
  const skipped = result.findings.filter((finding) => finding.chainSkipped);
  assert.deepEqual(skipped.map((finding) => finding.address).sort(), [BTC_B, ETH_A].sort());
  assert.ok(skipped.every((finding) => finding.chain === undefined && finding.notes!.some((note) => note.startsWith('Nie analizowano łańcucha'))));
  assert.ok(result.log.some((entry) => entry.message.includes('limit analizy blockchain 2')));
  assert.ok(dossierOf(result, query).findings.find((finding) => finding.address === BTC_B)!.annotations!.some((note) => note.startsWith('Nie analizowano łańcucha')));
});

test('źródło wyszukiwawcze: trafienie po fragmencie treści nie jest profilem osoby', async () => {
  const posts = [
    // Cudzy post, w którym pada nick podmiotu — to nie jest jego publikacja.
    { url: 'https://forum.example/t/1', author: 'ktos_inny', category: 'forum_post' as const, text: `krypto_janek to oszust, mój adres to ${BTC_B}` },
    { url: 'https://forum.example/t/2', author: 'Krypto_Janek', category: 'forum_post' as const, text: `Sprzedam, płatność ${BTC_A}` },
    // Unikalny identyfikator podany przez analityka w treści wystarcza.
    { url: 'https://forum.example/t/3', author: 'jk_handel', category: 'forum_post' as const, text: `Kontakt jan.kowalski@poczta.example, adres ${BTC_C}` },
  ];
  const query = { identifiers: [nick, email] };
  const deepSearch = fakeConnector('deep-search', 'forum.example', ['nick'], () => posts);
  const result = await runAnalysis({ query, connectors: [deepSearch], chainProviders: [fakeProvider()] });

  assert.deepEqual(result.findings.map((finding) => finding.address).sort(), [BTC_A, BTC_C].sort());
  assert.ok(result.log.some((entry) => entry.message.includes('1 publikacji 2 innych autorów') && entry.message.includes('nie przypisano ich podmiotowi')));
  assert.deepEqual(result.intel.mentions, [{ identifier: nick, documents: 1, authors: 2, services: 1 }]);
  // Ten sam dokument ze zwykłego łącznika profili jest przyjmowany jak dotąd.
  const profiles = fakeConnector('profile', 'forum.example', ['nick'], () => posts.slice(0, 1));
  assert.equal((await runAnalysis({ query: { identifiers: [nick] }, connectors: [profiles], chainProviders: [fakeProvider()] })).findings.length, 1);
});

test('nazwa powszechnie cytowana: wzmianki wielu autorów nie są profilami, a dowód kryptograficzny ma pierwszeństwo', async () => {
  const ens = { type: 'ens_name' as const, value: 'janek.eth' };
  const query = { identifiers: [ens] };
  const authors = Array.from({ length: 12 }, (_, index) => `fan_${index}`);
  // Rekord ENS: dowód kryptograficzny wskazujący adres.
  const registry = fakeConnector('live-ens', 'ens.domains', ['ens_name'], () => [
    { url: 'https://app.ens.domains/janek.eth', author: 'janek.eth', category: 'cryptographic_proof' as const, identityMatch: 'verified_link' as const, text: `Rekord adresu: ${ETH_A}` },
  ]);
  // Wyszukiwarka forów: inni autorzy wymieniają nazwę i adres; jeden serwis bez autora ostrzega.
  const deepSearch = fakeConnector('deep-search', 'forum.example', ['ens_name', 'crypto_address'], (identifier) => [
    ...authors.map((author) => ({
      url: `https://forum.example/p/${author}`,
      author,
      category: 'forum_post' as const,
      identityMatch: 'name_only' as const,
      text: `Widziałem, że janek.eth używa ${ETH_A}, a mój adres to ${BTC_B}`,
    })),
    ...(identifier.type === 'crypto_address' ? [{ url: 'https://ostrzezenia.example/a', title: 'Scam Alert: 3 zgłoszenia', category: 'forum_post' as const, text: `Zgłoszenia dla ${ETH_A}` }] : []),
  ]);
  const result = await runAnalysis({ query, connectors: [registry, deepSearch], chainProviders: [fakeProvider()] });

  // 12 wzmianek nie tworzy 12 profili ani nie przypisuje podmiotowi cudzych adresów.
  assert.deepEqual(result.findings.map((finding) => finding.address), [ETH_A]);
  assert.deepEqual(result.intel.mentions, [{ identifier: ens, documents: 12, authors: 12, services: 1 }]);
  assert.equal(result.intel.sightings.filter((item) => item.role === 'subject').length, 1);

  // Adres cytuje 12 osób, ale własność potwierdza dowód kryptograficzny: bez kary i bez wykluczenia.
  const [finding] = result.findings;
  assert.equal(finding!.unrelatedPublishers, 12);
  assert.deepEqual([finding!.confidence.score, finding!.confidence.excluded, finding!.widelyCited], [95, false, undefined]);
  assert.ok(finding!.notes!.some((note) => note.includes('12 innych autorów') && note.includes('cytowania nie obniżają wyniku')));
  // Publikacja bez autora to wiedza o adresie, nie ślad osoby.
  assert.ok(finding!.notes!.some((note) => note.includes('Wiedza o adresie z serwisu forum.example: „Scam Alert: 3 zgłoszenia”')));

  const dossier = dossierOf(result, query);
  assert.equal(dossier.persons.length, 1);
  assert.equal(dossier.findings[0]!.confidence.score, 95);
  assert.deepEqual(dossier.mentions, result.intel.mentions);
  assert.ok(dossier.keyFindings.some((item) => item.text.startsWith('Identyfikator „janek.eth” wymienia 12 innych autorów w 1 serwisie (12 publikacji)')));
  // Każdy cytujący jest najwyżej osobą powiązaną — wskazówką, nie profilem podmiotu.
  assert.equal(dossier.profiles.length, 1);
});

test('ten sam post widziany przez różne łączniki jest jednym śladem', async () => {
  const text = `Sprzedam koparkę, płatność ${BTC_A}`;
  const query = { identifiers: [nick] };
  const direct = fakeConnector('forum', 'forum.example', ['nick'], () => [{ url: 'https://forum.example/t/5', author: 'krypto_janek', category: 'forum_post' as const, text }]);
  const viaSearch = fakeConnector('deep-search', 'forum.example', ['nick'], () => [
    // Inny zapis tego samego adresu publikacji…
    { url: 'https://www.forum.example/t/5/?utm_source=szukajka#post-2', author: 'krypto_janek', category: 'forum_post' as const, text },
    // …i kopia tej samej treści pod innym adresem.
    { url: 'https://forum.example/print/5', author: 'krypto_janek', category: 'forum_post' as const, text },
  ]);
  const result = await runAnalysis({ query, connectors: [direct, viaSearch], chainProviders: [fakeProvider()] });

  assert.deepEqual(result.findings[0]!.evidence.map((item) => item.url), ['https://forum.example/t/5']);
  assert.equal(result.documents.length, 1);
  assert.ok(result.log.some((entry) => entry.message.includes('Pominięto 1 powtórzeń tej samej treści')));
  assert.equal(canonicalUrl('https://WWW.Forum.example/t/5/?utm_source=x&page=2#p'), 'https://forum.example/t/5?page=2');
});

test('limit czasu całej analizy: wynik częściowy zamiast błędu', async () => {
  const query = { identifiers: [nick, { type: 'crypto_address' as const, value: BTC_A }] };
  const connector = fakeConnector('gitpub', 'gitpub.example', ['nick', 'crypto_address'], () => [{ url: 'https://gitpub.example/krypto_janek', text: `Adres ${BTC_B}` }]);
  const stages: string[] = [];
  const result = await runAnalysis({ query, connectors: [connector], chainProviders: [fakeProvider()], totalTimeoutMs: 0, onProgress: (step) => stages.push(step.stage) });

  assert.equal(result.intel.partial, true);
  assert.equal(connector.calls.length, 0);
  // Adres podany przez analityka zostaje w wyniku, choć bez analizy łańcucha.
  assert.deepEqual(result.findings.map((finding) => [finding.address, finding.chainSkipped]), [[BTC_A, true]]);
  assert.ok(result.log.some((entry) => entry.message.includes('Przekroczono limit czasu całej analizy')));
  assert.ok(stages.includes('scoring'));
  assert.equal(dossierOf(result, query).partial, true);
});

// ---------- Analiza samego adresu: nie wolno wskazywać przypadkowych osób ----------

const addressQuery = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
/** Głośny adres: komentują go dziesiątki osób na forach. */
const commenters = (count: number, extra: { url: string; author: string; category: 'own_profile' | 'sale_offer' | 'forum_post'; text: string }[] = []) =>
  fakeConnector('deep-search', 'news.example', ['crypto_address'], (identifier) => [
    ...Array.from({ length: count }, (_, index) => ({
      url: `https://news.example/item/${index}`,
      author: `komentujacy_${index}`,
      category: 'forum_post' as const,
      identityMatch: 'name_only' as const,
      text: `Hakerzy podali adres ${identifier.value} — nie wysyłajcie tam nic!`,
    })),
    ...extra,
  ]);

test('sam adres, powszechnie cytowany: żadnych kandydatów na osobę, a ustalenia z blockchaina zostają', async () => {
  const contexts: { address: string; history?: string; since?: string; until?: string }[] = [];
  const chain = chainWith({ [BTC_A]: { trails: [TWO_HOPS] } });
  const provider = {
    ...chain,
    getActivity: async (network: 'bitcoin', address: string, context: { history?: string; since?: string; until?: string; log(message: string): void }) => {
      contexts.push({ address, history: context.history, since: context.since, until: context.until });
      return chain.getActivity(network, address, context);
    },
  };
  const result = await runAnalysis({ query: addressQuery, connectors: [commenters(14)], chainProviders: [provider], period: { from: '2020-07-01', to: '2020-12-31' } });
  const [finding] = result.findings;

  // Komentujący nie są śladami ani profilami podmiotu — tylko policzonymi wzmiankami.
  assert.equal(finding!.evidence.length, 0);
  assert.equal(finding!.unrelatedPublishers, 14);
  assert.equal(finding!.widelyCited, true);
  assert.deepEqual(result.intel.mentions, [{ identifier: addressQuery.identifiers[0], documents: 14, authors: 14, services: 1 }]);
  assert.ok(result.intel.sightings.every((item) => item.role !== 'subject'));
  // Adres podany przez analityka nie jest wykluczany: łańcuch został przeanalizowany w pełnej historii.
  assert.equal(finding!.confidence.excluded, false);
  assert.deepEqual(contexts, [{ address: BTC_A, history: 'full', since: '2020-07-01', until: '2020-12-31' }]);
  assert.ok(finding!.notes!.some((note) => note.startsWith('Zakres historii blockchain: pełna historia adresu') && note.includes('od 2020-07-01 do 2020-12-31')));
  assert.ok(finding!.notes!.some((note) => note.includes('pozostaje przedmiotem sprawy')));

  const dossier = dossierOf(result, addressQuery);
  assert.deepEqual(dossier.persons, []);
  assert.deepEqual(dossier.profiles, []);
  assert.deepEqual(dossier.relatedPersons, []);
  assert.equal(
    dossier.keyFindings[0]!.text,
    'Adres jest powszechnie cytowany (co najmniej 14 autorów w 1 serwisie) — nie da się wskazać właściciela na podstawie publikacji. Poniżej ustalenia z samego blockchaina.',
  );
  assert.ok(dossier.keyFindings.every((item) => !item.text.includes('Najbardziej prawdopodobna osoba') && !item.text.includes('komentujacy_')));
  assert.ok(!dossier.graph.nodes.some((node) => node.kind === 'profile' || node.kind === 'person'));

  // Dowód spieniężenia i usługi liczone dla adresu, bez osoby.
  const [proof] = dossier.cashOutProof;
  assert.deepEqual([proof!.person, proof!.addressBasis, proof!.personAddressProbability, proof!.combinedConfidence], [null, 'analyst', 100, 85]);
  assert.match(proof!.statement, /^Środki z badanego adresu 1A1zP1eP5Q…v7DivfNa: udokumentowano przekazanie 0,4 BTC \(ok\. 130 tys\. zł\) do usługi Binance w 2 krokach — pewność ścieżki 85%\.$/);
  assert.equal(dossier.keyFindings[1]!.text, proof!.statement);
  assert.equal(dossier.totals.linkedAddresses, 1);
  assert.ok(dossier.serviceLinks.some((link) => link.name === 'Binance'));
  assert.equal(dossier.totals.priorityReasons.at(-1), 'Sprawa dotyczy adresu: sumy i priorytet opisują badany adres, a nie osobę.');
});

test('sam adres: kandydatem jest tylko autor z mocną podstawą własności albo wskazany przez model', async () => {
  // Jeden autor z samą wypowiedzią na forum to wzmianka, nie kandydat.
  const single = await runAnalysis({ query: addressQuery, connectors: [commenters(1)], chainProviders: [fakeProvider()] });
  assert.deepEqual(dossierOf(single, addressQuery).persons, []);
  assert.match(dossierOf(single, addressQuery).keyFindings[0]!.text, /^Adres jest wymieniany w cudzych publikacjach \(co najmniej 1 autor w 1 serwisie\)/);

  // Oferta z adresem do wpłaty jest podstawą własności; komentujący obok pozostają wzmiankami.
  const offer = { url: 'https://targ.example/oferta/1', author: 'sprzedawca', category: 'sale_offer' as const, text: `Sprzedam laptopa, wpłata na ${BTC_A}` };
  const withOwner = await runAnalysis({ query: addressQuery, connectors: [commenters(2, [offer])], chainProviders: [fakeProvider()] });
  assert.deepEqual(withOwner.findings[0]!.evidence.map((item) => item.author), ['sprzedawca']);
  assert.equal(withOwner.findings[0]!.unrelatedPublishers, 2);
  const dossier = dossierOf(withOwner, addressQuery);
  assert.deepEqual(dossier.persons.map((person) => person.profileIds), [['news.example|sprzedawca']]);
  assert.deepEqual(dossier.mentions.map((item) => item.authors), [2]);
  assert.deepEqual(dossier.relatedPersons, []);

  // Ten sam właściciel przy adresie powszechnie cytowanym: teczka nikogo nie wskazuje.
  const famous = await runAnalysis({ query: addressQuery, connectors: [commenters(12, [offer])], chainProviders: [fakeProvider()] });
  const famousDossier = dossierOf(famous, addressQuery);
  assert.deepEqual([famousDossier.persons.length, famousDossier.profiles.length], [0, 0]);
  assert.ok(famousDossier.findings[0]!.annotations!.some((note) => note.includes('autor publikacji nie jest wskazywany jako właściciel')));

  // Model (gdy włączony) może wskazać autora wypowiedzi, który podaje adres jako własny — tylko z cytatem.
  const ai = fakeAi((input) => (input.author === 'komentujacy_0' ? { ownership: 'own_address', quote: 'podali adres' } : { ownership: 'own_address', quote: '' }));
  const byModel = await runAnalysis({ query: addressQuery, connectors: [commenters(3)], chainProviders: [fakeProvider()], ai });
  assert.deepEqual(byModel.findings[0]!.evidence.map((item) => item.author), ['komentujacy_0']);
  assert.equal(byModel.findings[0]!.unrelatedPublishers, 2);
});

// ---------- Zajęcie środków, pochodzenie środków, zestawienia adresów ----------

test('zajęcie przez organ państwa i pochodzenie środków z incydentu: ustalenia, nie spieniężenie', async () => {
  const GOV = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  const HACK = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';
  const seized = transfer(1, { counterparty: GOV, counterpartyClass: 'institutional', counterpartyLabel: 'Rząd USA: środki zajęte po włamaniu', time: '2022-02-01T10:00:00.000Z', amount: 567.49 });
  const base = chainWith({ [BTC_A]: { transfers: [seized] } });
  const provider = {
    ...base,
    getActivity: async (network: 'bitcoin', address: string) => ({
      ...(await base.getActivity(network, address, { log() {} })),
      seizures: [{ txid: seized.txid, time: seized.time, asset: 'BTC', amount: 567.49, counterparty: GOV, counterpartyLabel: 'Rząd USA: środki zajęte po włamaniu', labelSource: 'https://justice.example/komunikat', valuePln: 87_000_000, explanation: 'Przelew na adres organu państwa.', explorerUrl: seized.explorerUrl }],
      fundingSources: [
        { address: HACK, network: 'bitcoin', label: 'Włamanie na giełdę (2016)', addressClass: 'unknown', category: 'incident', labelSource: 'https://analiza.example/raport', amount: 500, asset: 'BTC', share: 0.88, hops: 1, txids: ['t1'], reason: 'Nadawca ma etykietę.' },
        { address: BTC_D, network: 'bitcoin', addressClass: 'unknown', amount: 67, asset: 'BTC', share: 0.12, hops: 2, via: BTC_C, txids: ['t2'], reason: 'Największy nadawca przed przelewem.' },
      ],
    }),
  };
  const dossier = dossierOf(await runAnalysis({ query: addressQuery, connectors: [], chainProviders: [provider] }), addressQuery);

  assert.deepEqual(dossier.seizures.map((item) => [item.subjectAddress, item.counterparty, item.amount, item.labelSource]), [[BTC_A, GOV, 567.49, 'https://justice.example/komunikat']]);
  assert.deepEqual(dossier.fundingSources.map((item) => [item.subjectAddress, item.address, item.category, item.share, item.hops]), [[BTC_A, HACK, 'incident', 0.88, 1], [BTC_A, BTC_D, undefined, 0.12, 2]]);
  // Zajęcie nie jest spieniężeniem: nie ma go w sumach, dowodzie ani usługach.
  assert.deepEqual(dossier.totals.cashOutPlnByYear, {});
  assert.deepEqual(dossier.cashOutProof, []);
  assert.deepEqual(dossier.serviceLinks, []);
  // Wyjaśnienie mówi o zajęciu zamiast o „braku wypływów do usług”.
  assert.deepEqual(dossier.explanations.map((item) => item.kind), ['seized']);
  // Kluczowe ustalenia: fakty z publicznych etykiet, ze źródłem etykiety.
  const texts = dossier.keyFindings.map((item) => item.text);
  assert.ok(texts.some((text) => text.includes('przekazane na adres organu państwa: „Rząd USA: środki zajęte po włamaniu” — źródło etykiety: https://justice.example/komunikat. To zajęcie, nie spieniężenie.')));
  assert.ok(texts.some((text) => text.includes('pochodzą w 88% z adresu') && text.includes('„Włamanie na giełdę (2016)”') && text.includes('incydentem')));
  // Jawny czynnik priorytetu.
  assert.ok(dossier.totals.priorityReasons.some((reason) => reason.startsWith('Związek z incydentem lub zajęciem środków: środki pochodzą z adresu oznaczonego jako „Włamanie na giełdę (2016)” — +10 pkt.')));
  // Graf i oś czasu.
  assert.ok(dossier.graph.edges.some((edge) => edge.from === `addr:bitcoin:${BTC_A}` && edge.to === `gov:${GOV}` && edge.label!.startsWith('zajęcie')));
  assert.ok(dossier.graph.edges.some((edge) => edge.from === `src:${HACK}` && edge.label === '88% wpływów'));
  assert.ok(dossier.timeline.some((event) => event.title.startsWith('Zajęcie środków: 567,49 BTC') && event.layer === 'fact'));
});

test('autorzy zestawień adresów nie są właścicielami ani osobami powiązanymi', async () => {
  const COUNTERPARTY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
  const richList = (address: string) =>
    `Rich list:\n${[address, BTC_A, BTC_B, BTC_C, BTC_D, ETH_A, '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX', '1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', '1FeexV6bAHb8ybZjqQMjJrcCrHGW9sb6uF'].join('\n')}`;
  const github = fakeConnector('live-github-search', 'github.com', ['crypto_address'], (identifier) => [
    { url: `https://github.com/lista/rich/${identifier.value}`, author: 'lista_bogaczy', text: richList(identifier.value) },
  ]);
  const chain = chainWith({ [BTC_A]: { transfers: [transfer(1, { counterparty: COUNTERPARTY, time: '2025-01-01T00:00:00.000Z', amount: 5 })] } });
  const result = await runAnalysis({ query: addressQuery, connectors: [github], chainProviders: [chain] });
  const dossier = dossierOf(result, addressQuery);

  // Ani adres podmiotu, ani adres kontrahenta nie zyskuje „autora”: zestawienie to nie przesłanka.
  assert.deepEqual(result.findings.map((finding) => [finding.address, finding.evidence.length, finding.unrelatedPublishers]), [[BTC_A, 0, 0]]);
  assert.deepEqual(dossier.relatedPersons, []);
  assert.deepEqual(dossier.linkedIdentities, []);
  assert.deepEqual(dossier.persons, []);
  assert.ok(!dossier.graph.nodes.some((node) => node.kind === 'person' || node.kind === 'profile'));
  assert.deepEqual(dossier.mentions, [{ identifier: addressQuery.identifiers[0], documents: 1, authors: 0, services: 0, note: 'adres występuje w publicznych zestawieniach adresów' }]);
  assert.ok(dossier.findings[0]!.annotations!.some((note) => note.startsWith('Adres występuje w publicznych zestawieniach adresów (1 publikacja)')));
  assert.ok(result.log.some((entry) => entry.message.includes(`Kontrahent ${COUNTERPARTY} występuje w publicznych zestawieniach adresów`)));

  // Kontrahent opublikowany przez trzech niezależnych autorów też nikogo nie wskazuje.
  const many = fakeConnector('profile', 'social.example', ['crypto_address'], (identifier) =>
    identifier.value === COUNTERPARTY ? ['a', 'b', 'c'].map((name) => ({ url: `https://social.example/${name}`, author: `autor_${name}`, text: `Mój adres: ${COUNTERPARTY}` })) : [],
  );
  assert.deepEqual(dossierOf(await runAnalysis({ query: addressQuery, connectors: [many], chainProviders: [chain] }), addressQuery).relatedPersons, []);

  // Analiza po nicku: profil z listą wielu adresów nie przypisuje ich podmiotowi.
  const nickQuery = { identifiers: [nick] };
  const listProfile = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek/lista', author: 'krypto_janek', text: richList(BTC_A) }]);
  const byNick = await runAnalysis({ query: nickQuery, connectors: [listProfile], chainProviders: [fakeProvider()] });
  assert.deepEqual(byNick.findings, []);
  assert.ok(byNick.log.some((entry) => entry.message.includes('to zestawienie adresów, nie przypisano ich podmiotowi')));
});
