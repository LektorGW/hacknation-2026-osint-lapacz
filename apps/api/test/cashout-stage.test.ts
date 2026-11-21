// Wskaźnik C — drabina dowodowa wyjścia do walut tradycyjnych. Bez internetu i bez bazy:
// oceny powstają z ręcznie opisanej aktywności adresów (te same atrapy co w testach dowodu spieniężenia).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutAssessment, CashOutIndicator, CashOutTrail, ChainActivity, Finding, FlowHop, Transfer } from '@olcys/core';
import { BANK_SIDE_LIMITATION, CASH_OUT_RULES, buildCashOutAssessments } from '../src/cashout-stage.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, ETH_A, cashOut, evidence, fakeActivity, finding, transfer } from './helpers.ts';

const BINANCE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const KRAKEN = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';
const STRANGER = '1dice8EMZmqKvrGE4Qc9bUFf9PX3xaYDp';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const ETH_EXCHANGE = '0x28C6c06298d514Db089934071355E5743bf21d60';

type LabelledTransfer = Transfer & { counterpartyLabelSource?: string; counterpartyKind?: string };
type ChainSpec = { transfers?: LabelledTransfer[]; cashOuts?: CashOutIndicator[]; trails?: CashOutTrail[]; addressClass?: ChainActivity['profile']['addressClass'] };

/** Adres teczki z ręcznie opisaną aktywnością w blockchainie. */
function subject(address: string, spec: ChainSpec, network: Finding['network'] = 'bitcoin'): Finding {
  const base = fakeActivity(network, address, spec.addressClass ?? 'private');
  return {
    ...finding(address, 80, [evidence('https://github.com/janek')], network),
    chain: { ...base, transfers: spec.transfers ?? [], cashOuts: spec.cashOuts ?? [], cashOutPlnByYear: {}, ...(spec.trails ? { trails: spec.trails } : {}) },
  };
}

const keysOf = (...findings: Finding[]) => new Set(findings.map((item) => `${item.network}:${item.address}`));
const assess = (findings: Finding[], documentedExits?: Set<string>) => buildCashOutAssessments({ findings, linkedKeys: keysOf(...findings), ...(documentedExits ? { documentedExits } : {}) });
const rules = (item: CashOutAssessment) => item.indicator.components.map((component) => component.rule);
const component = (item: CashOutAssessment, rule: string) => item.indicator.components.find((entry) => entry.rule === rule)!;

/** Bezpośredni przelew na oznaczony portfel giełdy, ze źródłem etykiety. */
const toBinance = (index: number, time: string, amount = 0.4, extra: Partial<LabelledTransfer> = {}): LabelledTransfer => ({
  ...transfer(index, { counterparty: BINANCE, time, amount, counterpartyClass: 'exchange', counterpartyLabel: 'Binance 14' }),
  counterpartyLabelSource: 'zbiór etykiet testowych',
  ...extra,
});

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

/** Ścieżka: adres podmiotu → adres bez etykiety → portfel giełdy (wzorzec indywidualnego adresu wpłat). */
const VIA_DEPOSIT: CashOutTrail = {
  id: 'sciezka-wplat',
  sourceAddress: BTC_A,
  network: 'bitcoin',
  hops: [
    hop(1, BTC_A, BTC_D),
    hop(2, BTC_D, BINANCE, { toLabel: 'Binance 14', toClass: 'exchange', inferred: true, reason: 'adres bez publicznej etykiety został po 2 h zamieciony do portfela giełdy „Binance 14” — prawdopodobny indywidualny adres wpłat klienta giełdy (reguła: zamiecenie adresu wpłat)' }),
  ],
  serviceName: 'Binance 14',
  serviceKind: 'exchange_deposit',
  asset: 'BTC',
  amount: 0.4,
  valuePln: 130_000,
  valuation: 'kurs testowy',
  confidence: 87,
  reasons: ['WNIOSKOWANIE: środki dotarły do usługi „Binance 14” (giełda) przez 1 adres(y) pośredni(e); etykieta usługi: zbiór etykiet testowych.'],
  openQuestions: ['Czy po tej wpłacie nastąpiła sprzedaż i wypłata na rachunek bankowy?'],
};

test('szczebel 1 — sama transakcja w blockchainie: przelewy na adresy bez etykiety to niski wskaźnik i nic o walutach tradycyjnych', () => {
  const address = subject(BTC_A, {
    transfers: [
      transfer(1, { counterparty: STRANGER, time: '2025-03-01T10:00:00.000Z', amount: 0.2 }),
      transfer(2, { counterparty: BTC_D, time: '2025-03-05T10:00:00.000Z', amount: 0.3 }),
      // Przelew przychodzący od nieznanego nadawcy nie jest żadnym wypływem.
      transfer(3, { counterparty: STRANGER, time: '2025-02-01T10:00:00.000Z', amount: 1, direction: 'in' }),
    ],
  });
  const [only, ...rest] = assess([address]);
  assert.deepEqual(rest, []);
  assert.equal(only!.id, `cashout:bitcoin:${BTC_A}:onchain`);
  assert.equal(only!.stage, 'onchain_transfer');
  assert.equal(only!.status, 'computed');
  assert.equal(only!.serviceName, undefined);
  assert.deepEqual(only!.txids, [transfer(1, { counterparty: '', time: '', amount: 0 }).txid, transfer(2, { counterparty: '', time: '', amount: 0 }).txid]);
  assert.deepEqual([only!.asset, only!.amount, only!.valuePln], ['BTC', 0.5, undefined]);
  assert.deepEqual(rules(only!), ['cashout.onchain_transfer']);
  assert.equal(only!.indicator.kind, 'cash_out');
  assert.equal(only!.indicator.score, CASH_OUT_RULES.weights.onchainTransfer);
  assert.equal(only!.indicator.level, 'brak przesłanek');
  assert.equal(only!.indicator.calibrated, false);
  assert.match(only!.statement, /^Transakcje w blockchainie: z adresu .* wyszło 2 przelewy na adresy bez etykiety usługi wymiany\. To tylko przelewy między adresami — nie wynika z nich nic o wymianie na waluty tradycyjne\.$/);
  assert.ok(only!.indicator.limitations.includes(BANK_SIDE_LIMITATION));
});

test('szczebel 2 — interakcja z usługą: bezpośredni przelew na oznaczony adres, z etykietą, jej źródłem i transakcją', () => {
  const deposit = toBinance(1, '2025-03-14T10:22:00.000Z');
  const address = subject(BTC_A, { transfers: [deposit], cashOuts: [cashOut(deposit, 132_000)] });
  const [only, ...rest] = assess([address]);
  assert.deepEqual(rest, []);
  assert.equal(only!.id, `cashout:bitcoin:${BTC_A}:svc:binance`);
  assert.equal(only!.stage, 'service_interaction');
  assert.equal(only!.status, 'computed');
  assert.equal(only!.serviceName, 'Binance');
  // Kwota i wycena wprost z danych blockchain.
  assert.deepEqual([only!.txids, only!.asset, only!.amount, only!.valuePln], [[deposit.txid], 'BTC', 0.4, 132_000]);
  assert.deepEqual(rules(only!), ['cashout.direct_service_transfer', 'cashout.valuation_available']);
  const direct = component(only!, 'cashout.direct_service_transfer');
  assert.deepEqual(direct.evidence, [
    { kind: 'txid', value: deposit.txid },
    { kind: 'address', value: BINANCE },
    { kind: 'attribute', value: 'etykieta „Binance 14” — źródło: zbiór etykiet testowych' },
  ]);
  assert.match(direct.explanation, /publicznie oznaczony jako giełda „Binance 14” \(1 przelew\)\. Źródło etykiety: zbiór etykiet testowych\.$/);
  // 40 za przelew bezpośredni + 20% z 5 za dostępną wycenę.
  assert.equal(only!.indicator.score, 41);
  assert.equal(only!.indicator.level, 'umiarkowane przesłanki');
  assert.match(only!.statement, /^Interakcja z usługą wymiany: z adresu .* przekazano 0,4 BTC \(szacunkowo 132 tys\. zł\) do usługi Binance \(giełda\) — 1 przelew wprost na oznaczony adres usługi\./);
  assert.match(only!.statement, /nie wynika z niego, że doszło do wymiany na waluty tradycyjne ani wypłaty na rachunek — potwierdzić może to tylko usługa\.$/);
  assert.ok(only!.indicator.limitations.includes(BANK_SIDE_LIMITATION));

  // Bez kursu: brak kwoty w PLN (nie zero) i wpis w ograniczeniach; etykieta bez zapisanego źródła jest tak opisana.
  const bare = { ...transfer(2, { counterparty: KRAKEN, time: '2025-04-01T10:00:00.000Z', amount: 1, counterpartyClass: 'exchange' as const, counterpartyLabel: 'Kraken 4' }) };
  const [unvalued] = assess([subject(BTC_B, { transfers: [bare] })]);
  assert.equal(unvalued!.stage, 'service_interaction');
  assert.ok(!('valuePln' in unvalued!));
  assert.deepEqual(rules(unvalued!), ['cashout.direct_service_transfer']);
  assert.ok(unvalued!.indicator.limitations.includes('Brak kursu dla tych transakcji — wartości w PLN nie podano (nie jest to zero).'));
  assert.ok(component(unvalued!, 'cashout.direct_service_transfer').evidence.some((ref) => ref.kind === 'attribute' && ref.value === 'etykieta „Kraken 4” — źródło: nie zapisano w danych'));
});

test('szczebel 3 — sygnał wypłaty: ścieżka przez indywidualny adres wpłat jest hipotezą z kontrskładnikiem za wnioskowanie', () => {
  const first = transfer(1, { counterparty: BTC_D, time: '2025-03-11T10:00:00.000Z', amount: 0.4 });
  const address = subject(BTC_A, { transfers: [{ ...first, txid: VIA_DEPOSIT.hops[0]!.txid }], trails: [VIA_DEPOSIT] });
  const [only, ...rest] = assess([address]);
  // Przelew na adres pośredni należy do ścieżki — nie tworzy osobnej oceny „sama transakcja”.
  assert.deepEqual(rest, []);
  assert.equal(only!.stage, 'cashout_signal');
  assert.equal(only!.status, 'hypothesis');
  assert.equal(only!.serviceName, 'Binance');
  assert.deepEqual(only!.txids, VIA_DEPOSIT.hops.map((item) => item.txid));
  assert.deepEqual([only!.asset, only!.amount, only!.valuePln], ['BTC', 0.4, 130_000]);
  assert.deepEqual(rules(only!), ['cashout.deposit_address_inferred', 'cashout.valuation_available', 'cashout.inferred_hop']);
  const inferred = component(only!, 'cashout.deposit_address_inferred');
  assert.ok(inferred.evidence.some((ref) => ref.kind === 'address' && ref.value === BTC_D), 'adres wpłat jest w dowodach');
  assert.ok(inferred.evidence.some((ref) => ref.kind === 'attribute' && ref.value === 'etykieta „Binance 14” — źródło: zbiór etykiet testowych'));
  assert.match(inferred.limitations[0]!, /Adres wpłat ustalono WNIOSKOWANIEM/);
  assert.equal(component(only!, 'cashout.inferred_hop').direction, 'contradicts');
  // 55 (adres wpłat) + 1 (wycena) − 8 (wnioskowanie).
  assert.equal(only!.indicator.score, 48);
  assert.match(only!.statement, /^Potencjalny sygnał wypłaty: .* 1 przelew przez prawdopodobny indywidualny adres wpłat \(wnioskowanie\)\. To hipoteza oparta na wnioskowaniu, do weryfikacji\./);
  assert.match(only!.statement, /sama wypłata w walucie tradycyjnej nie jest widoczna w blockchainie — potwierdzić może ją tylko usługa\.$/);

  // Starszy zapis bez ścieżki: sam wskaźnik „WNIOSKOWANIE” przy przelewie na adres bez etykiety daje ten sam szczebel.
  const legacy = subject(BTC_A, {
    transfers: [first],
    cashOuts: [cashOut(first, 130_000, { explanation: 'WNIOSKOWANIE (nie ustalony fakt): przelew 0,4 BTC na adres bez etykiety. Ten adres pośredni przekazał środki do portfela giełdy „Binance 14” (1Boat…).' })],
  });
  const [fromIndicator] = assess([legacy]);
  assert.deepEqual([fromIndicator!.stage, fromIndicator!.status, fromIndicator!.serviceName, fromIndicator!.valuePln], ['cashout_signal', 'hypothesis', 'Binance', 130_000]);
  assert.ok(rules(fromIndicator!).includes('cashout.deposit_address_inferred'));

  // Ścieżka przez adresy pośrednie bez wzorca adresu wpłat i z adresu klastra portfela.
  const passthrough: CashOutTrail = {
    ...VIA_DEPOSIT,
    id: 'sciezka-klaster',
    sourceAddress: BTC_A,
    hops: [hop(3, BTC_C, BTC_D, { inferred: true, reason: 'przelew z adresu uznanego za należący do portfela podmiotu (heurystyka wspólnych wejść)' }), hop(4, BTC_D, KRAKEN, { toLabel: 'Kraken 4', toClass: 'exchange', inferred: true, reason: 'adres przekazał 99% otrzymanej kwoty do usługi „Kraken 4” (reguła: adres przelotowy)' })],
    serviceName: 'Kraken 4',
    confidence: 55,
    reasons: ['WNIOSKOWANIE: środki dotarły do usługi „Kraken 4” (giełda) przez 1 adres(y) pośredni(e); etykieta usługi: WalletExplorer (klasa rozpoznana po nazwie w etykiecie).'],
  };
  const [viaCluster] = assess([subject(BTC_A, { trails: [passthrough] })]);
  assert.deepEqual([viaCluster!.stage, viaCluster!.status], ['cashout_signal', 'hypothesis']);
  assert.deepEqual(rules(viaCluster!), [
    'cashout.trail_documented',
    'cashout.valuation_available',
    'cashout.inferred_hop',
    'cashout.cluster_origin',
    'cashout.label_heuristic',
    'cashout.low_trail_confidence',
  ]);
  // 50 + 1 − 8 − 10 − 5 − 10.
  assert.equal(viaCluster!.indicator.score, 18);
});

test('szczebel 3 — sygnał wypłaty z samych faktów: zamiana na stablecoin i wpłata oraz wpłaty powtarzalne', () => {
  const swapOut = { ...transfer(1, { counterparty: ROUTER, time: '2025-05-10T08:00:00.000Z', amount: 2, asset: 'ETH', counterpartyClass: 'smart_contract' as const, counterpartyLabel: 'Uniswap V2: Router' }) };
  const stableIn = transfer(2, { counterparty: ROUTER, time: '2025-05-10T08:00:00.000Z', amount: 5000, asset: 'USDT', direction: 'in', counterpartyClass: 'smart_contract' });
  const deposit: LabelledTransfer = {
    ...transfer(3, { counterparty: ETH_EXCHANGE, time: '2025-05-11T09:00:00.000Z', amount: 5000, asset: 'USDT', counterpartyClass: 'exchange', counterpartyLabel: 'Binance: Hot Wallet' }),
    counterpartyLabelSource: 'Blockscout',
  };
  const swap = cashOut(swapOut, 20_000, { kind: 'stablecoin_swap', counterpartyLabel: 'Uniswap V2: Router' });
  const swapped = subject(ETH_A, { transfers: [swapOut, stableIn, deposit], cashOuts: [swap, cashOut(deposit, 20_000)] }, 'ethereum');
  const [signal, ...rest] = assess([swapped]);
  // Zamiana powiązana z wpłatą nie tworzy osobnej oceny „sama transakcja”.
  assert.deepEqual(rest, []);
  assert.equal(signal!.stage, 'cashout_signal');
  assert.equal(signal!.status, 'computed', 'każdy krok jest faktem z blockchaina');
  assert.deepEqual(rules(signal!), ['cashout.stablecoin_swap', 'cashout.direct_service_transfer', 'cashout.valuation_available']);
  assert.deepEqual(component(signal!, 'cashout.stablecoin_swap').evidence, [{ kind: 'txid', value: swapOut.txid }, { kind: 'txid', value: deposit.txid }]);
  // 60 (zamiana i wpłata) + 20% z 40 + 20% z 5.
  assert.equal(signal!.indicator.score, 69);
  assert.match(signal!.statement, /wpłatę poprzedziła zamiana na stablecoin/);

  // Sama zamiana, bez późniejszej wpłaty do usługi: zostaje na najniższym szczeblu.
  const [swapOnly, ...none] = assess([subject(ETH_A, { transfers: [swapOut, stableIn], cashOuts: [swap] }, 'ethereum')]);
  assert.deepEqual(none, []);
  assert.equal(swapOnly!.stage, 'onchain_transfer');
  assert.deepEqual(rules(swapOnly!), ['cashout.stablecoin_swap_only']);
  assert.equal(swapOnly!.indicator.score, CASH_OUT_RULES.weights.stablecoinSwapOnly);
  assert.match(component(swapOnly!, 'cashout.stablecoin_swap_only').limitations[0]!, /sama nie jest wyjściem do walut tradycyjnych/);

  // Trzy osobne wpłaty do tej samej usługi (różne numery portfeli tej samej giełdy) — wpłaty powtarzalne.
  const deposits = [
    toBinance(1, '2025-01-10T10:00:00.000Z', 0.1),
    toBinance(2, '2025-02-10T10:00:00.000Z', 0.2, { counterpartyLabel: 'Binance 7' }),
    toBinance(3, '2025-03-10T10:00:00.000Z', 0.3),
  ];
  const [repeated] = assess([subject(BTC_A, { transfers: deposits, cashOuts: [cashOut(deposits[0]!, 30_000), cashOut(deposits[1]!, 60_000)] })]);
  assert.deepEqual([repeated!.stage, repeated!.status, repeated!.serviceName], ['cashout_signal', 'computed', 'Binance']);
  assert.deepEqual(rules(repeated!), ['cashout.repeated_deposits', 'cashout.direct_service_transfer', 'cashout.valuation_available']);
  assert.deepEqual([repeated!.amount, repeated!.valuePln, repeated!.txids.length], [0.6, 90_000, 3]);
  assert.ok(repeated!.indicator.limitations.includes('Wartość w PLN obejmuje 2 z 3 wpłat; dla pozostałych brak kursu.'));
  // Dwie wpłaty to jeszcze nie wzorzec.
  const [two] = assess([subject(BTC_A, { transfers: deposits.slice(0, 2) })]);
  assert.equal(two!.stage, 'service_interaction');
});

test('szczebel 4 — udokumentowane wyjście tylko z dokumentem spoza blockchaina; same dane blockchain nigdy go nie dają', () => {
  // Najmocniejszy możliwy obraz z samego blockchaina: zamiana, wpłaty powtarzalne, ścieżka, wyceny.
  const deposits = [1, 2, 3, 4].map((index) => toBinance(index, `2025-03-0${index}T10:00:00.000Z`, 1));
  const strong = subject(BTC_A, { transfers: deposits, cashOuts: deposits.map((item) => cashOut(item, 300_000)), trails: [VIA_DEPOSIT] });
  const other = subject(BTC_B, { transfers: [toBinance(9, '2025-04-01T10:00:00.000Z', 0.5)] });
  const onchainOnly = assess([strong, other]);
  assert.ok(onchainOnly.length >= 2);
  for (const item of onchainOnly) {
    assert.notEqual(item.stage, 'documented_fiat_exit');
    assert.notEqual(item.status, 'confirmed');
    assert.ok(item.indicator.score <= 95);
    assert.ok(item.indicator.limitations.includes(BANK_SIDE_LIMITATION), 'każda ocena poniżej ostatniego szczebla niesie ograniczenie o braku danych bankowych');
    assert.ok(!rules(item).includes('cashout.documented_offchain'));
  }
  assert.match(BANK_SIDE_LIMITATION, /może potwierdzić wyłącznie usługa \(dane KYC właściciela konta, historia zleceń i wypłat — odpowiedź na zapytanie\)/);
  // Pusty zbiór potwierdzeń niczego nie zmienia.
  assert.deepEqual(assess([strong, other], new Set()), onchainOnly);

  // Analityk przyjął dokument dla pierwszego adresu: tylko jego ocena przechodzi na ostatni szczebel.
  const documented = assess([strong, other], new Set([`bitcoin:${BTC_A}`]));
  const [first, second] = documented;
  assert.deepEqual([first!.address, first!.stage, first!.status, first!.indicator.score], [BTC_A, 'documented_fiat_exit', 'confirmed', 100]);
  assert.equal(first!.indicator.components[0]!.rule, 'cashout.documented_offchain');
  assert.deepEqual(first!.indicator.components[0]!.evidence, [{ kind: 'decision', value: `bitcoin:${BTC_A}` }]);
  assert.equal(first!.indicator.components[0]!.source, 'decyzja analityka');
  // Składniki z blockchaina zostają widoczne pod dokumentem.
  assert.ok(rules(first!).includes('cashout.direct_service_transfer') && rules(first!).includes('cashout.repeated_deposits'));
  assert.ok(!first!.indicator.limitations.includes(BANK_SIDE_LIMITATION));
  assert.ok(first!.indicator.limitations.some((item) => /na podstawie dokumentacji spoza blockchaina zaakceptowanej przez analityka/.test(item)));
  assert.match(first!.statement, /^Udokumentowane wyjście do walut tradycyjnych: .* przez usługę Binance potwierdza dokumentacja spoza blockchaina przyjęta przez analityka\. Dane blockchain pokazują przy tym wyłącznie przekazanie środków/);
  assert.deepEqual([second!.address, second!.stage, second!.status], [BTC_B, 'service_interaction', 'computed']);
  assert.ok(second!.indicator.limitations.includes(BANK_SIDE_LIMITATION));

  // Dokument przy adresie bez wpłat do usług: podstawą jest wyłącznie dokument — i jest to powiedziane wprost.
  const plain = subject(BTC_C, { transfers: [transfer(5, { counterparty: STRANGER, time: '2025-03-01T10:00:00.000Z', amount: 0.2 })] });
  const [byDocument, ...rest] = assess([plain], new Set([`bitcoin:${BTC_C}`]));
  assert.deepEqual(rest, []);
  assert.deepEqual([byDocument!.stage, byDocument!.status, byDocument!.indicator.score, byDocument!.serviceName], ['documented_fiat_exit', 'confirmed', 100, undefined]);
  assert.ok(byDocument!.indicator.limitations.some((item) => /nie ma przelewu z tego adresu do rozpoznanej usługi wymiany — udokumentowane wyjście opiera się wyłącznie na dokumencie/.test(item)));
});

test('przelewy PRZYCHODZĄCE z giełdy to źródło środków, nie wyjście do walut tradycyjnych', () => {
  const withdrawals = [
    { ...toBinance(1, '2025-03-01T10:00:00.000Z', 0.5), direction: 'in' as const },
    { ...toBinance(2, '2025-03-08T10:00:00.000Z', 0.5), direction: 'in' as const },
  ];
  const [only, ...rest] = assess([subject(BTC_A, { transfers: withdrawals })]);
  assert.deepEqual(rest, []);
  assert.equal(only!.stage, 'onchain_transfer');
  assert.equal(only!.status, 'computed');
  assert.equal(only!.serviceName, 'Binance');
  assert.deepEqual(rules(only!), ['cashout.incoming_only']);
  assert.equal(component(only!, 'cashout.incoming_only').direction, 'contradicts');
  assert.equal(only!.indicator.score, 0);
  assert.equal(only!.indicator.level, 'brak przesłanek');
  assert.deepEqual([only!.amount, only!.valuePln], [undefined, undefined]);
  assert.match(only!.statement, /wyłącznie OTRZYMYWAŁ środki z usługi Binance \(2 przelewy\)\. To źródło środków, nie wyjście do walut tradycyjnych/);
  assert.ok(only!.indicator.limitations.includes(BANK_SIDE_LIMITATION));
  // Nawet dokument analityka nie zamienia wypłat Z giełdy w wyjście przez tę giełdę: osobna ocena oparta wyłącznie na dokumencie.
  const documented = assess([subject(BTC_A, { transfers: withdrawals })], new Set([`bitcoin:${BTC_A}`]));
  assert.deepEqual(documented.map((item) => [item.stage, item.serviceName]), [['documented_fiat_exit', undefined], ['onchain_transfer', 'Binance']]);

  // Wpłata i późniejsze wypłaty z tej samej usługi: ocena zostaje, ale z kontrskładnikiem.
  const mixed = subject(BTC_A, { transfers: [toBinance(1, '2025-03-01T10:00:00.000Z', 0.5), { ...toBinance(2, '2025-03-08T10:00:00.000Z', 0.2), direction: 'in' as const }] });
  const [both] = assess([mixed]);
  assert.equal(both!.stage, 'service_interaction');
  assert.deepEqual(rules(both!), ['cashout.direct_service_transfer', 'cashout.withdrawals_back']);
  assert.equal(both!.indicator.score, 35);
});

test('jedna ocena na parę adres–usługa, najmocniejsze pierwsze; adresy niepowiązane, wykluczone i adresy usług są pomijane', () => {
  const gateway: LabelledTransfer = {
    ...transfer(7, { counterparty: KRAKEN, time: '2025-03-02T10:00:00.000Z', amount: 0.05, counterpartyLabel: 'BitPay' }),
    counterpartyKind: 'payment_gateway',
    counterpartyLabelSource: 'zbiór etykiet testowych',
  };
  const busy = subject(BTC_A, {
    transfers: [
      toBinance(1, '2025-03-01T10:00:00.000Z', 0.1),
      toBinance(2, '2025-03-02T10:00:00.000Z', 0.1, { counterpartyLabel: 'Binance-Hot 2' }),
      gateway,
      transfer(8, { counterparty: STRANGER, time: '2025-03-03T10:00:00.000Z', amount: 0.01 }),
      // Przelew na własny, drugi adres podmiotu nie jest wypływem.
      transfer(9, { counterparty: BTC_B, time: '2025-03-04T10:00:00.000Z', amount: 0.7 }),
    ],
    trails: [VIA_DEPOSIT],
  });
  const second = subject(BTC_B, { transfers: [toBinance(3, '2025-04-01T10:00:00.000Z', 0.5)] });
  const result = assess([busy, second]);
  assert.deepEqual(
    result.map((item) => [item.address, item.stage, item.serviceName ?? null]),
    [
      [BTC_A, 'cashout_signal', 'Binance'],
      [BTC_B, 'service_interaction', 'Binance'],
      [BTC_A, 'service_interaction', 'BitPay'],
      [BTC_A, 'onchain_transfer', null],
    ],
  );
  assert.equal(new Set(result.map((item) => item.id)).size, result.length);
  // Wpłaty wprost i przez adres wpłat do tej samej giełdy: jedna ocena, trzy wpłaty → także wzorzec powtarzalności; fakt i wnioskowanie razem = hipoteza.
  const binance = result[0]!;
  assert.equal(binance.status, 'hypothesis');
  assert.deepEqual(rules(binance), ['cashout.repeated_deposits', 'cashout.deposit_address_inferred', 'cashout.direct_service_transfer', 'cashout.valuation_available']);
  assert.ok(binance.indicator.limitations.some((item) => /Część kroków ścieżki ustalono heurystyką/.test(item)), 'przy przelewie bezpośrednim wnioskowanie jest ograniczeniem, nie odejmuje punktów');
  // Bramka płatnicza: zapłata za towar, nie wypłata podmiotu.
  const bitpay = result[2]!;
  assert.deepEqual(rules(bitpay), ['cashout.direct_service_transfer', 'cashout.payment_gateway_spend']);
  assert.equal(bitpay.indicator.score, 20);
  // Zbiorcza ocena obejmuje tylko przelew do nieznanego adresu.
  assert.deepEqual(result[3]!.txids, [transfer(8, { counterparty: '', time: '', amount: 0 }).txid]);

  // Adres niepowiązany z podmiotem, adres wykluczony i adres będący giełdą lub kontraktem nie dostają ocen.
  const unlinked = buildCashOutAssessments({ findings: [busy, second], linkedKeys: keysOf(second) });
  assert.deepEqual(unlinked.map((item) => item.address), [BTC_B]);
  const excluded = { ...second, confidence: { ...second.confidence, excluded: true } };
  assert.deepEqual(assess([excluded]), []);
  assert.deepEqual(assess([subject(BTC_B, { transfers: [toBinance(3, '2025-04-01T10:00:00.000Z', 0.5)], addressClass: 'exchange' })]), []);
  assert.deepEqual(assess([subject(ETH_A, { transfers: [toBinance(3, '2025-04-01T10:00:00.000Z', 0.5)], addressClass: 'smart_contract' }, 'ethereum')]), []);
  // Adres bez danych blockchain: brak ocen, nic nie jest dopisywane.
  assert.deepEqual(assess([finding(BTC_C, 80, [])]), []);
});

test('produkt bez powiernictwa i token niezweryfikowany ograniczają ocenę', () => {
  const dex: LabelledTransfer = {
    ...transfer(1, { counterparty: ETH_EXCHANGE, time: '2025-05-01T10:00:00.000Z', amount: 1, asset: 'ETH', counterpartyClass: 'exchange', counterpartyLabel: 'OKX: DEX Router' }),
    counterpartyLabelSource: 'Blockscout',
  };
  const [limited] = assess([subject(ETH_A, { transfers: [dex] }, 'ethereum')]);
  assert.deepEqual(rules(limited!), ['cashout.direct_service_transfer', 'cashout.service_also_non_custodial']);
  assert.equal(limited!.indicator.score, 25);
  assert.match(component(limited!, 'cashout.service_also_non_custodial').explanation, /produkt bez powiernictwa/);

  const fake: LabelledTransfer = { ...toBinance(2, '2025-05-02T10:00:00.000Z', 1_000_000), asset: 'USDT (niezweryfikowany token 0xdeadbe…)' };
  const [unverified] = assess([subject(BTC_A, { transfers: [fake] })]);
  assert.equal(unverified!.stage, 'onchain_transfer');
  assert.deepEqual(rules(unverified!), ['cashout.unverified_asset']);
  assert.deepEqual([unverified!.indicator.score, unverified!.amount, unverified!.valuePln], [0, undefined, undefined]);
});
