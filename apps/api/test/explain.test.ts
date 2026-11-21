import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutTrail, Identifier } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { serviceFromName } from '../src/services.ts';
import { BTC_A, BTC_C, BTC_D, ETH_A, chainWith, decision, dossierOf, fakeConnector, fakeProvider, transfer } from './helpers.ts';

const nick: Identifier = { type: 'nick', value: 'zondacrypto' };
const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';

const TRAIL: CashOutTrail = {
  id: 'sciezka-ens',
  sourceAddress: ETH_A,
  network: 'ethereum',
  hops: [{ txid: 'f'.repeat(64), time: '2025-05-01T10:00:00.000Z', from: ETH_A, to: EXCHANGE, asset: 'ETH', amount: 2, toLabel: 'Kraken 4', toClass: 'exchange', explorerUrl: 'https://explorer.example/tx/f' }],
  serviceName: 'Kraken',
  serviceKind: 'exchange_deposit',
  asset: 'ETH',
  amount: 2,
  valuePln: 20_000,
  confidence: 90,
  reasons: ['Bezpośredni przelew na oznaczony portfel giełdy.'],
  openQuestions: ['Kto jest klientem giełdy?'],
};

/** Profil znaleziony po nicku (bez adresu) i odgadnięta nazwa ENS z adresem — osobny, słaby kandydat. */
const profileAndGuessedEns = () => [
  fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/zondacrypto', author: 'zondacrypto', text: 'Oficjalne repozytoria.' }]),
  fakeConnector('live-ens', 'ens.domains', ['nick'], () => [
    { url: 'https://app.ens.domains/zondacrypto.eth', author: 'zondacrypto.eth', identityMatch: 'name_only' as const, text: `Rekord adresu: ${ETH_A}` },
  ]),
];
const ensChain = () =>
  chainWith({
    [ETH_A]: {
      transfers: [transfer(1, { counterparty: EXCHANGE, counterpartyLabel: 'Kraken 4', counterpartyClass: 'exchange', time: '2025-05-01T10:00:00.000Z', amount: 2, asset: 'ETH' })],
      trails: [TRAIL],
    },
  });

test('adres z niepotwierdzonego profilu nie znika: trafia do adresów do potwierdzenia i warunkowego dowodu', async () => {
  const query = { identifiers: [nick] };
  const result = await runAnalysis({ query, connectors: profileAndGuessedEns(), chainProviders: [ensChain()] });
  const dossier = dossierOf(result, query);

  // Adres nie jest adresem osoby głównej…
  assert.equal(dossier.totals.linkedAddresses, 0);
  assert.equal(dossier.findings[0]!.confidence.score, 0);
  // …ale jest pokazany z powodem, prawdopodobieństwem i skrótem aktywności w łańcuchu.
  assert.equal(dossier.unconfirmedAddresses.length, 1);
  const [pending] = dossier.unconfirmedAddresses;
  assert.deepEqual([pending!.address, pending!.network], [ETH_A, 'ethereum']);
  // Kandydat 20% × adres u tego kandydata 85% = 17%.
  assert.equal(pending!.personAddressProbability, 17);
  assert.deepEqual(pending!.sources, [
    { url: 'https://app.ens.domains/zondacrypto.eth', service: 'ens.domains', author: 'zondacrypto.eth', profileId: 'ens.domains|zondacrypto.eth', personId: 'osoba-2' },
  ]);
  assert.match(pending!.reasons[0]!, /nie potwierdzono jako należącego do podmiotu \(prawdopodobieństwo 20%\)/);
  assert.deepEqual(pending!.chain, { transfers: 1, totalReceived: 1, totalSent: 0.4, asset: 'BTC', services: ['Kraken'], cashOutPlnTotal: 0, trails: 1 });
  assert.deepEqual(pending!.confirmWith, [
    { target: 'profile', key: 'ens.domains|zondacrypto.eth' },
    { target: 'address', key: `ethereum:${ETH_A}` },
  ]);

  // Dowód spieniężenia: ustalenie warunkowe z niską pewnością i informacją, co da potwierdzenie.
  const [proof] = dossier.cashOutProof;
  assert.deepEqual([proof!.ownerUnconfirmed, proof!.personAddressProbability, proof!.combinedConfidence, proof!.confidenceIfConfirmed], [true, 17, 15, 90]);
  assert.match(
    proof!.statement,
    /nie jest potwierdzony jako należący do podmiotu \(prawdopodobieństwo 17%\)\. Z adresu przekazano 2 ETH \(ok\. 20 tys\. zł\) do usługi Kraken .* łączna pewność 15%; jeśli analityk potwierdzi własność adresu, ustalenie zyska pewność 90%\.$/,
  );
  // Warunkowe ustalenie nie wchodzi do priorytetu ani sum.
  assert.ok(!dossier.totals.priorityReasons.some((reason) => reason.startsWith('Dowód spieniężenia')));
  assert.deepEqual(dossier.totals.cashOutPlnByYear, {});

  // Wyjaśnienie i pierwsze zdania mówią wprost, co się stało i co zrobić.
  assert.deepEqual(dossier.explanations.map((item) => item.kind), ['service_name', 'only_unconfirmed']);
  assert.match(dossier.explanations[1]!.text, /^Znaleziono 1 adres, ale żadnego nie potwierdzono jako należącego do podmiotu \(najbliższy: 0xde0B2956…cb697BAe, prawdopodobieństwo 17%\)/);
  assert.ok(dossier.keyFindings[1]!.text.startsWith('Znaleziono 1 adres, ale żadnego nie potwierdzono'));
  assert.ok(dossier.keyFindings.some((item) => item.text === proof!.statement));

  // Gotowa akcja: potwierdzenie adresu albo profilu przelicza wszystko.
  for (const confirmation of [decision('address', `ethereum:${ETH_A}`, 'confirmed'), decision('profile', 'ens.domains|zondacrypto.eth', 'confirmed')]) {
    const confirmed = dossierOf(result, query, { decisions: [confirmation] });
    assert.deepEqual(confirmed.unconfirmedAddresses, []);
    assert.equal(confirmed.totals.linkedAddresses, 1);
    assert.equal(confirmed.cashOutProof[0]!.ownerUnconfirmed, undefined);
    // Potwierdzony adres: 100 × 90; potwierdzony profil: adres z własnego profilu 85 × 90.
    assert.ok([90, 77].includes(confirmed.cashOutProof[0]!.combinedConfidence));
    assert.ok(!confirmed.explanations.some((item) => item.kind === 'only_unconfirmed'));
    assert.ok(confirmed.serviceLinks.some((link) => link.name === 'Kraken'));
  }
  assert.equal(dossierOf(result, query, { decisions: [decision('address', `ethereum:${ETH_A}`, 'confirmed')] }).cashOutProof[0]!.addressBasis, 'confirmed');
});

test('zapytanie o nazwę giełdy: wyjaśnienie z publicznie oznaczonymi adresami usługi', async () => {
  assert.deepEqual(serviceFromName('ZondaCrypto'), { name: 'Zonda (BitBay)', kind: 'exchange' });
  assert.deepEqual(serviceFromName('binance_official'), { name: 'Binance', kind: 'exchange' });
  assert.equal(serviceFromName('krypto_janek'), undefined);
  assert.equal(serviceFromName('ledgerman'), undefined);

  const query = { identifiers: [{ type: 'nick' as const, value: 'ZondaCrypto' }] };
  const result = await runAnalysis({ query, connectors: [], chainProviders: [] });
  const labels = [
    { address: BTC_A, network: 'bitcoin', label: 'Zonda: Hot Wallet' },
    { address: BTC_C, network: 'bitcoin', label: 'BitBay 2' },
    { address: BTC_D, network: 'bitcoin', label: 'Kraken 4' },
  ];
  const [explanation, noAddresses] = dossierOf(result, query, { serviceLabels: labels }).explanations;
  assert.equal(explanation!.kind, 'service_name');
  assert.match(explanation!.text, /^„ZondaCrypto” to nazwa giełdy lub serwisu \(Zonda \(BitBay\)\), a nie osoby\..*zbiór etykiet zawiera 2 oznaczone adresy tej usługi\.$/);
  assert.deepEqual(explanation!.addresses, labels.slice(0, 2));
  assert.equal(noAddresses!.kind, 'no_addresses');
  // Bez zbioru etykiet lista jest pusta — nic nie jest zmyślane.
  const bare = dossierOf(result, query).explanations[0]!;
  assert.deepEqual(bare.addresses, []);
  assert.ok(bare.text.includes('zbiór etykiet nie zawiera adresów tej usługi'));
  // Pierwsze zdanie kluczowych ustaleń mówi to zamiast suchego „Priorytet 0”.
  assert.ok(dossierOf(result, query).keyFindings[0]!.text.startsWith('„ZondaCrypto” to nazwa giełdy lub serwisu'));
});

test('brak adresów: wyjaśnienie z liczbą źródeł i profili oraz wskazówkami', async () => {
  const query = { identifiers: [{ type: 'full_name' as const, value: 'Rafał Testowy' }] };
  const mirrors = fakeConnector('fedi', 'fedi.example', ['full_name'], () => [
    { url: 'https://fedi.example/@rafal', author: 'rafal', identityMatch: 'name_only' as const, text: 'Lustro konta, bez adresów.', profile: { displayName: 'Rafał Testowy' } },
  ]);
  const result = await runAnalysis({ query, connectors: [mirrors], chainProviders: [] });
  const dossier = dossierOf(result, query);

  assert.deepEqual(dossier.explanations.map((item) => item.kind), ['no_addresses']);
  const [explanation] = dossier.explanations;
  assert.equal(explanation!.text, 'Przeszukano 1 źródło i znaleziono 1 profil, ale w ich treści nie ma żadnego adresu kryptowalutowego — dlatego nie ma czego analizować w blockchainie.');
  assert.deepEqual(explanation!.suggestions, [
    'Podaj dodatkowy identyfikator podmiotu: e-mail, adres profilu, znany adres portfela albo nazwę ENS.',
    'Uruchom analizę w trybie głębokim — przeszukuje dodatkowo kilkaset forów.',
  ]);
  assert.ok(dossier.keyFindings[0]!.text.startsWith('Przeszukano 1 źródło i znaleziono 1 profil'));
  assert.ok(dossier.keyFindings[0]!.text.includes('Co można zrobić: Podaj dodatkowy identyfikator'));
  // W trybie głębokim nie proponujemy trybu głębokiego.
  assert.equal(dossierOf(result, query, { deep: true }).explanations[0]!.suggestions.length, 1);
});

test('wyjaśnienia: brak wypływów do usług, pominięty łańcuch, wynik częściowy', async () => {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const quiet = chainWith({ [BTC_A]: { transfers: [transfer(1, { counterparty: BTC_D, time: '2025-01-01T00:00:00.000Z', amount: 1 })] } });
  const noCashOut = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [quiet] }), query);
  assert.deepEqual(noCashOut.explanations.map((item) => item.kind), ['no_owner', 'no_cash_out']);
  assert.match(noCashOut.explanations[1]!.text, /^1 adres powiązany ma łącznie 1 pobrany przelew, ale żaden wypływ nie trafił do adresu oznaczonego jako giełda/);

  const cut = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [fakeProvider()], totalTimeoutMs: 0 }), query);
  assert.deepEqual(cut.explanations.map((item) => item.kind), ['no_owner', 'chain_skipped', 'partial']);

  // Gdy jest wskaźnik wypłaty albo dowód, wyjaśnienie o braku spieniężenia się nie pojawia.
  const withCashOut = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [fakeProvider()] }), query);
  assert.deepEqual(withCashOut.explanations.map((item) => item.kind), ['no_owner']);
});
