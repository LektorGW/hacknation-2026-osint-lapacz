// Wskaźnik C — oznaki wyjścia do walut tradycyjnych w publikacjach podmiotu (Web2) i nowe wzorce w blockchainie.
// Bez internetu i bez bazy: atrapy łączników (`fakeConnector`) i dostawcy danych blockchain (`chainWith`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutAssessment, CashOutIndicator, Finding, Transfer } from '@olcys/core';
import { matchOfframps, offrampFor } from '@olcys/chain';
import { runAnalysis } from '../src/analysis.ts';
import { BANK_SIDE_LIMITATION, CASH_OUT_RULES, buildCashOutAssessments } from '../src/cashout-stage.ts';
import { FIAT_WEB_RULES, buildWebCashOutAssessment, detectFiatSignals, offrampInfo, registryNotes } from '../src/fiat-signals.ts';
import type { FiatPublication } from '../src/fiat-signals.ts';
import { BTC_A, BTC_B, ETH_A, cashOut, chainWith, decision, dossierOf, evidence, fakeActivity, fakeConnector, finding, transfer } from './helpers.ts';

const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const CARD = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const ETH_EXCHANGE = '0x28C6c06298d514Db089934071355E5743bf21d60';
const NOW = new Date('2026-11-21T10:00:00.000Z');

const rulesOf = (hits: { rule: string; service?: string }[]) => [...new Set(hits.map((hit) => (hit.service ? `${hit.rule}:${hit.service}` : hit.rule)))];
const rules = (item: CashOutAssessment) => item.indicator.components.map((component) => component.rule);
const component = (item: CashOutAssessment, rule: string) => item.indicator.components.find((entry) => entry.rule === rule)!;
const pub = (url: string, text: string, service = 'targ'): FiatPublication => ({ url, service, hits: detectFiatSignals(text) });

type Labelled = Transfer & { counterpartyLabelSource?: string; counterpartyKind?: string };
function subject(address: string, spec: { transfers?: Labelled[]; cashOuts?: CashOutIndicator[]; balance?: number; lastSeen?: string }, network: Finding['network'] = 'bitcoin'): Finding {
  const base = fakeActivity(network, address, 'private');
  return {
    ...finding(address, 80, [evidence('https://github.com/janek')], network),
    chain: {
      ...base,
      profile: { ...base.profile, nativeAsset: network === 'ethereum' ? 'ETH' : 'BTC', ...(spec.balance !== undefined ? { balance: spec.balance } : {}), ...(spec.lastSeen ? { lastSeen: spec.lastSeen } : {}) },
      transfers: spec.transfers ?? [],
      cashOuts: spec.cashOuts ?? [],
      cashOutPlnByYear: {},
    },
  };
}
const keysOf = (...findings: Finding[]) => new Set(findings.map((item) => `${item.network}:${item.address}`));

// ---------- Wykrywanie w treści ----------

test('Web2: oferta sprzedaży za gotówkę z BLIK-iem i spotkaniem daje trzy oznaki, każdą z cytatem', () => {
  const hits = detectFiatSignals('Sprzedam USDT za gotówkę, Warszawa, BLIK. Odbiór osobisty w centrum, kurs dnia.');
  assert.deepEqual(rulesOf(hits), ['p2p_offer_pln', 'cash_meeting', 'bank_or_blik']);
  assert.equal(hits[0]!.excerpt, 'Sprzedam USDT za gotówkę, Warszawa, BLIK.');
  assert.deepEqual(rulesOf(detectFiatSignals('Wymiana BTC na PLN, przelew na konto w 15 minut.')), ['p2p_offer_pln', 'bank_or_blik']);
});

test('Web2: karta krypto, nazwane usługi wyjścia do fiat, bitomat, platforma P2P i bramka płatnicza', () => {
  assert.deepEqual(rulesOf(detectFiatSignals('Płacę kartą Binance, a resztę wypłacam przez Kangę na konto.')), [
    'bank_or_blik',
    'named_offramp:Kanga',
    'crypto_card:Binance Card',
  ]);
  assert.deepEqual(rulesOf(detectFiatSignals('Wypłacam przez Zondacrypto, czasem bitomat. Mam też profil na Binance P2P i LocalCoinSwap.')), [
    'named_offramp:Zonda (BitBay)',
    'named_offramp:Bitomat (ogólnie)',
    'named_offramp:Binance P2P',
    'named_offramp:LocalCoinSwap',
  ]);
  // Marka płatności ogólnego przeznaczenia liczy się tylko w zdaniu o kryptowalutach.
  assert.deepEqual(rulesOf(detectFiatSignals('Przyjmuję płatności przez CoinGate i Przelewy24.')), ['payment_gateway:CoinGate']);
  assert.deepEqual(rulesOf(detectFiatSignals('Przelewy24 rozliczy też krypto.')), ['payment_gateway:Przelewy24 (płatności krypto)']);
});

test('Web2: kupno kryptowaluty, zapłata kryptowalutą za towar, ostrzeżenie i zaprzeczenie nie są oznakami wyjścia do fiat', () => {
  assert.deepEqual(detectFiatSignals('Kupię BTC za gotówkę, Kraków.'), []);
  assert.deepEqual(detectFiatSignals('Sprzedam rower za 5 200 zł, przyjmę też BTC.'), []);
  assert.deepEqual(detectFiatSignals('Uwaga na oszustów: ktoś sprzedaje BTC za gotówkę na Binance P2P.'), []);
  assert.deepEqual(detectFiatSignals('Nie sprzedaję USDT za gotówkę, nie pytajcie.'), []);
  assert.deepEqual(detectFiatSignals('Spotkanie zespołu w piątek, przelew na konto do 10.'), []);
});

test('lista usług wyjścia do fiat: rodzaj po nazwie, nazwa szczegółowa wygrywa, wpisy w rejestrach tylko po dokładnej nazwie z migawki', () => {
  assert.equal(offrampFor('Binance: Hot Wallet')?.kind, 'exchange_with_pln');
  assert.equal(offrampFor('Binance Card')?.kind, 'crypto_card_issuer');
  assert.equal(offrampFor('Bitomaty Polska')?.kind, 'crypto_atm_operator');
  assert.equal(offrampFor('Giełda Bursztyn: Hot Wallet'), undefined, 'nazwy spoza listy nie są zgadywane');
  assert.deepEqual(matchOfframps('Binance P2P').map((item) => item.service.name), ['Binance P2P']);
  // Migawka podana wprost: numer wpisu i organ pochodzą z rejestru, nie z listy usług.
  const registry = {
    rdww: { zrodlo: 'RDWW', strona: '', plik: '', stanNa: '2026-07-02', wpisy: [{ numer: 'RDWW-465', dataWpisu: '2022-01-01', nazwa: 'BINANCE POLAND SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ', nip: '0' }] },
    casp: { zrodlo: 'ESMA', strona: '', plik: '', pobrano: '2026-11-21T00:00:00.000Z', wpisy: [{ organ: 'FMA', kraj: 'AT', nazwa: 'Bitpanda GmbH', nazwaHandlowa: 'Bitpanda', kraje: 'AT|PL' }] },
  };
  assert.match(registryNotes(offrampFor('Binance')!, registry)[0]!, /RDWW.*BINANCE POLAND.*nr RDWW-465.*stan na 2026-07-02/);
  assert.match(registryNotes(offrampFor('Bitpanda')!, registry)[0]!, /zezwolenie MiCA.*Bitpanda GmbH.*organ: FMA \(AT\).*usługi zgłoszone także w Polsce/);
  assert.deepEqual(registryNotes(offrampFor('Kanga')!, registry), [], 'usługa bez wpisu na liście — brak noty, nic nie jest dopowiadane');
  assert.deepEqual(offrampInfo('Kanga', null), { kind: 'exchange_with_pln', label: 'giełda lub kantor z wypłatą w walucie tradycyjnej', registry: [] });
});

// ---------- Ocena z publikacji ----------

test('Web2: kopie tej samej oferty liczą się raz; kilka oznak z jednej oferty nie sumuje się; ocena to hipoteza na szczeblu sygnału', () => {
  const offer = 'Sprzedam USDT za gotówkę, Warszawa, BLIK. Odbiór osobisty w centrum, kurs dnia bez prowizji.';
  const one = buildWebCashOutAssessment({ publications: [pub('https://targ.example/1', offer)], registry: null })!;
  const copies = buildWebCashOutAssessment({
    publications: [pub('https://targ.example/1', offer), pub('https://forum.example/2', offer, 'forum'), pub('https://web.archive.org/web/2026/https://targ.example/1', offer, 'archiwum')],
    registry: null,
  })!;
  assert.deepEqual([one.stage, one.status, one.origin, one.network, one.address], ['cashout_signal', 'hypothesis', 'web', 'web', '']);
  assert.equal(one.indicator.score, FIAT_WEB_RULES.weights.p2p_offer_pln, 'oferta, spotkanie i BLIK z jednej publikacji to jedno pochodzenie');
  assert.equal(copies.indicator.score, one.indicator.score, 'kopie oferty nie podnoszą wyniku');
  assert.match(component(copies, 'cashout.web.p2p_offer_pln').explanation, /3 publikacje konta podmiotu \(w tym 2 kopie tej samej treści — 1 niezależne pochodzenie\)/);
  assert.equal(component(copies, 'cashout.web.cash_meeting').independence, 'dependent');
  assert.deepEqual(copies.publications!.map((item) => item.url), ['https://targ.example/1', 'https://forum.example/2', 'https://web.archive.org/web/2026/https://targ.example/1']);
  // Druga, inna publikacja to niezależne pochodzenie: wynik rośnie o 20% wagi jej najmocniejszej oznaki.
  const two = buildWebCashOutAssessment({ publications: [pub('https://targ.example/1', offer), pub('https://forum.example/9', 'Kartą Binance płacę za wszystko, wygodniej niż bank.', 'forum')], registry: null })!;
  assert.equal(two.indicator.score, FIAT_WEB_RULES.weights.p2p_offer_pln + Math.round(FIAT_WEB_RULES.weights.crypto_card * 0.2));
  assert.ok(two.confirm!.services.some((item) => item.serviceId === 'binance'));
  assert.match(two.confirm!.text, /zapytanie do banku prowadzącego rachunek albo operatora płatności/);
  assert.match(two.why!, /Podmiot sam opisuje zamianę kryptowalut na walutę tradycyjną/);
  // Sama wzmianka o usłudze to szczebel „interakcja”, nie sygnał wypłaty.
  const mention = buildWebCashOutAssessment({ publications: [pub('https://forum.example/3', 'Konto mam na Zondacrypto od lat.')], registry: null })!;
  assert.deepEqual([mention.stage, rules(mention)], ['service_interaction', ['cashout.web.named_offramp']]);
  // Brak oznak — brak oceny.
  assert.equal(buildWebCashOutAssessment({ publications: [pub('https://forum.example/4', 'Dziś ładna pogoda.')] }), undefined);
});

test('Web2 nigdy nie daje ostatniego szczebla — nawet razem z dokumentem analityka i odpowiedzią usługi dla adresu', () => {
  const offer = 'Sprzedam BTC za gotówkę albo przelew na konto, Warszawa.';
  const deposit = { ...transfer(1, { counterparty: EXCHANGE, time: '2025-03-14T10:00:00.000Z', amount: 0.4, counterpartyClass: 'exchange' as const, counterpartyLabel: 'Kanga Exchange' }) };
  const address = subject(BTC_A, { transfers: [deposit], cashOuts: [cashOut(deposit, 100_000)] });
  const result = buildCashOutAssessments({
    findings: [address],
    linkedKeys: keysOf(address),
    documentedExits: new Set([`bitcoin:${BTC_A}`]),
    publications: [pub('https://targ.example/1', offer)],
    registry: null,
  });
  const web = result.find((item) => item.origin === 'web')!;
  assert.equal(web.stage, 'cashout_signal');
  assert.notEqual(web.status, 'confirmed');
  assert.ok(web.indicator.score <= 95);
  assert.ok(!rules(web).some((rule) => /documented/.test(rule)));
  // Ocena adresu przeszła na ostatni szczebel wyłącznie dzięki dokumentowi analityka.
  const chain = result.find((item) => item.origin === 'chain')!;
  assert.deepEqual([chain.stage, chain.indicator.components[0]!.rule], ['documented_fiat_exit', 'cashout.documented_offchain']);
  assert.match(chain.why!, /dokument spoza blockchaina/);
});

// ---------- Nowe wzorce w blockchainie ----------

test('blockchain: zamiana znacznej wartości na stablecoin i wpłata do giełdy — próg w PLN z wyceny, bez kursu reguły nie ma', () => {
  const swapOut = transfer(1, { counterparty: ROUTER, time: '2025-05-10T08:00:00.000Z', amount: 20, asset: 'ETH', counterpartyClass: 'smart_contract', counterpartyLabel: 'Uniswap V2: Router' });
  const stableIn = transfer(2, { counterparty: ROUTER, time: '2025-05-10T08:00:00.000Z', amount: 60_000, asset: 'USDT', direction: 'in', counterpartyClass: 'smart_contract' });
  const deposit: Labelled = { ...transfer(3, { counterparty: ETH_EXCHANGE, time: '2025-05-11T09:00:00.000Z', amount: 60_000, asset: 'USDT', counterpartyClass: 'exchange', counterpartyLabel: 'Kanga Exchange' }), counterpartyLabelSource: 'zbiór testowy' };
  const large = subject(ETH_A, { transfers: [swapOut, stableIn, deposit], cashOuts: [cashOut(swapOut, 240_000, { kind: 'stablecoin_swap' }), cashOut(deposit, 238_000)] }, 'ethereum');
  const [signal] = buildCashOutAssessments({ findings: [large], linkedKeys: keysOf(large), registry: null });
  assert.equal(signal!.stage, 'cashout_signal');
  assert.deepEqual(rules(signal!).slice(0, 2), ['cashout.stablecoin_conversion_large', 'cashout.stablecoin_swap']);
  assert.equal(component(signal!, 'cashout.stablecoin_swap').independence, 'dependent', 'ta sama zamiana liczy się raz');
  assert.deepEqual(component(signal!, 'cashout.stablecoin_conversion_large').evidence, [{ kind: 'txid', value: swapOut.txid }, { kind: 'txid', value: deposit.txid }]);
  assert.match(component(signal!, 'cashout.stablecoin_conversion_large').explanation, /do 240 tys\. zł \(próg 50 tys\. zł\)/);
  assert.deepEqual(signal!.offramp, { kind: 'exchange_with_pln', label: 'giełda lub kantor z wypłatą w walucie tradycyjnej', registry: [] });
  assert.match(signal!.why!, /wymiana znacznej wartości na stablecoin/);
  // Bez kursu: reguły nie oceniono — i jest to zapisane w ograniczeniach, a nie przemilczane.
  const unvalued = subject(ETH_A, { transfers: [swapOut, stableIn, deposit], cashOuts: [{ ...cashOut(swapOut, 0, { kind: 'stablecoin_swap' }), valuePln: undefined }] }, 'ethereum');
  const [noRate] = buildCashOutAssessments({ findings: [unvalued], linkedKeys: keysOf(unvalued), registry: null });
  assert.ok(!rules(noRate!).includes('cashout.stablecoin_conversion_large'));
  assert.ok(noRate!.indicator.limitations.some((item) => /Brak kursu dla zamiany na stablecoin — reguły „wymiana znacznej wartości na stablecoin”/.test(item)));
  // Poniżej progu — tylko reguła ogólna.
  const small = subject(ETH_A, { transfers: [swapOut, stableIn, deposit], cashOuts: [cashOut(swapOut, 20_000, { kind: 'stablecoin_swap' })] }, 'ethereum');
  const [below] = buildCashOutAssessments({ findings: [small], linkedKeys: keysOf(small), registry: null });
  assert.ok(!rules(below!).includes('cashout.stablecoin_conversion_large') && rules(below!).includes('cashout.stablecoin_swap'));
});

test('blockchain: wpłata do giełdy i adres zamilkł — tylko z datą oceny, bez późniejszych transakcji i z pustym saldem', () => {
  const deposit = transfer(1, { counterparty: EXCHANGE, time: '2025-03-14T10:00:00.000Z', amount: 0.99, counterpartyClass: 'exchange', counterpartyLabel: 'Kanga Exchange' });
  const quiet = subject(BTC_A, { transfers: [deposit], balance: 0, lastSeen: '2025-03-14T10:00:00.000Z' });
  const [withNow] = buildCashOutAssessments({ findings: [quiet], linkedKeys: keysOf(quiet), now: NOW, registry: null });
  assert.equal(withNow!.stage, 'cashout_signal');
  assert.ok(rules(withNow!).includes('cashout.deposit_then_quiet'));
  assert.match(component(withNow!, 'cashout.deposit_then_quiet').explanation, /od tego czasu — 617 dni do dnia oceny — adres nie ma żadnych transakcji, a jego saldo jest bliskie zeru/);
  // Bez daty oceny reguła nie działa (nie zgadujemy „dziś”).
  const [withoutNow] = buildCashOutAssessments({ findings: [quiet], linkedKeys: keysOf(quiet), registry: null });
  assert.deepEqual([withoutNow!.stage, rules(withoutNow!).includes('cashout.deposit_then_quiet')], ['service_interaction', false]);
  // Saldo pozostało na adresie albo później coś przyszło — adres nie zamilkł.
  const funded = subject(BTC_A, { transfers: [deposit], balance: 0.6 });
  assert.ok(!rules(buildCashOutAssessments({ findings: [funded], linkedKeys: keysOf(funded), now: NOW, registry: null })[0]!).includes('cashout.deposit_then_quiet'));
  const active = subject(BTC_A, { transfers: [deposit, transfer(2, { counterparty: BTC_B, time: '2025-06-01T10:00:00.000Z', amount: 0.1, direction: 'in' })], balance: 0 });
  const [activeResult] = buildCashOutAssessments({ findings: [active], linkedKeys: keysOf(active), now: NOW, registry: null });
  assert.ok(!rules(activeResult!).includes('cashout.deposit_then_quiet'));
});

test('blockchain: doładowanie karty krypto i regularne spieniężanie przez wiele miesięcy; kwoty okrągłe w PLN to słaba przesłanka', () => {
  const topup: Labelled = { ...transfer(1, { counterparty: CARD, time: '2025-04-02T10:00:00.000Z', amount: 0.05, counterpartyLabel: 'KartaTest: doładowanie karty' }), counterpartyKind: 'crypto_card', counterpartyLabelSource: 'zbiór testowy' };
  const card = subject(BTC_A, { transfers: [topup] });
  const [cardResult] = buildCashOutAssessments({ findings: [card], linkedKeys: keysOf(card), registry: null });
  assert.equal(cardResult!.stage, 'cashout_signal');
  assert.deepEqual(rules(cardResult!), ['cashout.crypto_card_topup', 'cashout.direct_service_transfer']);
  assert.equal(cardResult!.indicator.score, CASH_OUT_RULES.weights.cryptoCardTopup, 'ten sam przelew opisany dwiema regułami liczy się raz');

  const deposits = ['2025-01-10', '2025-03-10', '2025-06-10'].map((day, index) =>
    transfer(index + 1, { counterparty: EXCHANGE, time: `${day}T10:00:00.000Z`, amount: 0.1, counterpartyClass: 'exchange', counterpartyLabel: 'Kanga Exchange' }),
  );
  const values = [10_020, 4_990, 33_333];
  const repeated = subject(BTC_A, { transfers: deposits, cashOuts: deposits.map((item, index) => cashOut(item, values[index]!)) });
  const [regular] = buildCashOutAssessments({ findings: [repeated], linkedKeys: keysOf(repeated), registry: null });
  assert.ok(rules(regular!).includes('cashout.repeated_offramp'));
  assert.match(component(regular!, 'cashout.repeated_offramp').explanation, /3 wpłaty w 3 różnych miesiącach \(2025-01 – 2025-06; próg 3\)/);
  // 10 020 i 4 990 zł są bliskie okrągłym kwotom (2 z 3 wycenionych), 33 333 zł — nie.
  assert.deepEqual(component(regular!, 'cashout.round_amounts_pln').evidence.map((ref) => ref.value), [deposits[0]!.txid, deposits[1]!.txid]);
  assert.equal(component(regular!, 'cashout.round_amounts_pln').weight, CASH_OUT_RULES.weights.roundAmountsPln);
  // Wszystkie wpłaty w jednym miesiącu: powtarzalne, ale bez „regularnego spieniężania”.
  const burst = subject(BTC_A, { transfers: deposits.map((item, index) => ({ ...item, time: `2025-03-1${index}T10:00:00.000Z` })) });
  const [burstResult] = buildCashOutAssessments({ findings: [burst], linkedKeys: keysOf(burst), registry: null });
  assert.ok(rules(burstResult!).includes('cashout.repeated_deposits') && !rules(burstResult!).includes('cashout.repeated_offramp'));
  assert.ok(burstResult!.indicator.limitations.some((item) => /reguły „kwoty bliskie okrągłym w PLN” nie oceniono/.test(item)));
});

test('każda ocena ma „Dlaczego to oznaka wypłaty” i „Co potwierdzi wypłatę” ze wskazówkami z powiązań z usługami', () => {
  const deposit = transfer(1, { counterparty: EXCHANGE, time: '2025-03-14T10:00:00.000Z', amount: 0.4, counterpartyClass: 'exchange', counterpartyLabel: 'Kanga Exchange' });
  const address = subject(BTC_A, { transfers: [deposit, transfer(2, { counterparty: BTC_B, time: '2025-03-15T10:00:00.000Z', amount: 0.1 })] });
  const link = { id: 'kanga', name: 'Kanga', requestHints: ['Przelewy z adresu podmiotu … (1).'] } as unknown as import('@olcys/core').ServiceLink;
  const result = buildCashOutAssessments({ findings: [address], linkedKeys: keysOf(address), serviceLinks: [link], registry: null });
  const [service, onchain] = result;
  assert.equal(service!.origin, 'chain');
  assert.match(service!.why!, /^Środki trafiły do usługi \(giełda\), w której zwykle zamienia się kryptowaluty na pieniądze\. Sam przelew nie dowodzi sprzedaży\.$/);
  assert.deepEqual(service!.confirm!.services, [{ name: 'Kanga', serviceId: 'kanga', requestHints: ['Przelewy z adresu podmiotu … (1).'] }]);
  assert.match(service!.confirm!.text, /Ostatni szczebel daje tylko odpowiedź usługi Kanga: dane KYC właściciela konta/);
  assert.match(onchain!.why!, /^To nie jest oznaka wypłaty/);
  assert.deepEqual(onchain!.confirm!.services, []);
  assert.ok(result.every((item) => item.indicator.limitations.includes(BANK_SIDE_LIMITATION)));
});

// ---------- Teczka: tylko publikacje kont podmiotu ----------

test('teczka: liczą się wyłącznie publikacje kont podmiotu — cudza wzmianka nie; publikacja wzmacnia ocenę tej samej usługi z blockchaina', async () => {
  const query = { identifiers: [{ type: 'nick' as const, value: 'janek_usdt' }] };
  const connectors = [
    fakeConnector('targ', 'targ.example', ['nick'], () => [
      {
        url: 'https://targ.example/oferta/1',
        author: 'janek_usdt',
        category: 'sale_offer' as const,
        text: `Sprzedam USDT za gotówkę, Warszawa, BLIK. Wypłacam też przez Kangę na konto. Adres do wpłat: ${BTC_A}`,
      },
    ]),
    fakeConnector('forum', 'forum.example', ['nick'], () => [
      {
        url: 'https://forum.example/watek/7',
        author: 'obcy_autor',
        identityMatch: 'name_only' as const,
        category: 'forum_post' as const,
        text: 'Ktoś pisał, że janek_usdt sprzedaje BTC za gotówkę przez Bitomat i Binance P2P.',
      },
    ]),
  ];
  const deposit = transfer(1, { counterparty: EXCHANGE, time: '2025-03-14T10:00:00.000Z', amount: 0.4, counterpartyClass: 'exchange', counterpartyLabel: 'Kanga Exchange' });
  const result = await runAnalysis({ query, connectors, chainProviders: [chainWith({ [BTC_A]: { transfers: [deposit], cashOuts: [cashOut(deposit, 120_000)] } })] });
  const dossier = dossierOf(result, query);
  const cashOuts = dossier.indicators.cashOut;
  const web = cashOuts.find((item) => item.origin === 'web')!;
  assert.ok(web, 'jest ocena z publikacji');
  assert.deepEqual(web.publications!.map((item) => item.url), ['https://targ.example/oferta/1'], 'cudza publikacja na forum się nie liczy');
  assert.ok(!web.indicator.components.some((item) => item.evidence.some((ref) => ref.value === 'https://forum.example/watek/7')));
  assert.equal(web.id, 'cashout:web:sprawa-1');
  // Ocena giełdy z blockchaina: publikacja podmiotu o wypłacie przez tę giełdę jest drugą, niezależną podstawą i podnosi szczebel do sygnału.
  const chain = cashOuts.find((item) => item.origin === 'chain' && item.serviceName === 'Kanga')!;
  assert.equal(chain.stage, 'cashout_signal');
  assert.ok(rules(chain).includes('cashout.web.named_offramp'));
  assert.deepEqual(component(chain, 'cashout.web.named_offramp').evidence, [{ kind: 'url', value: 'https://targ.example/oferta/1' }]);
  assert.match(chain.statement, /podmiot sam pisze o wymianie na walutę tradycyjną w tej usłudze/);
  // Ani publikacje, ani blockchain nie dają ostatniego szczebla.
  assert.ok(cashOuts.every((item) => item.stage !== 'documented_fiat_exit'));

  // Decyzja analityka „wyjście do fiat potwierdzone” dla adresu podnosi tylko ocenę adresu — nigdy ocenę z publikacji.
  const documented = dossierOf(result, query, { decisions: [decision('cashout', `bitcoin:${BTC_A}`, 'confirmed', 'wyciąg bankowy')] });
  assert.equal(documented.indicators.cashOut.find((item) => item.origin === 'web')!.stage, 'cashout_signal');
  assert.ok(documented.indicators.cashOut.some((item) => item.origin === 'chain' && item.stage === 'documented_fiat_exit'));
});
