// Śledzenie środków w głąb, wzór pewności, klaster adresów i Tron TRC-20.
// Bez internetu: dane wstrzykiwane funkcjami lub atrapą `fetch`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RawTransfer } from '../src/activity.ts';
import { commonInputAddresses, detectChange, looksLikeCoinJoin } from '../src/cluster.ts';
import type { UtxoTx } from '../src/cluster.ts';
import { RequestBudget } from '../src/http.ts';
import { DEEP_REQUEST_BUDGET, createChainProviders } from '../src/index.ts';
import { createLabelSet } from '../src/labels.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { TronScanTagClient } from '../src/party-labels.ts';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { TronGridProvider } from '../src/providers/trongrid.ts';
import { CONFIDENCE_RULES, traceAccountFlows, traceUtxoFlows, trailConfidence } from '../src/trace.ts';
import type { ExpandedNode } from '../src/trace.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const A = (letter: string) => `0x${letter.repeat(40)}`;
const SUBJECT = A('1');
const KRAKEN = A('e');
const MIXER = A('f');
const ROUTER = A('c');
const labels = createLabelSet(
  [
    { network: 'ethereum', address: KRAKEN, label: 'Kraken: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
    { network: 'ethereum', address: MIXER, label: 'Tornado Cash: pula 10 ETH', addressClass: 'mixer' },
    { network: 'ethereum', address: ROUTER, label: 'Uniswap V3: Router', addressClass: 'smart_contract' },
    { network: 'bitcoin', address: '1ExchangeHotWallet00000000000000000', label: 'Zonda: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
  ],
  'zbiór testowy',
);
const noSanctions = createSanctionsList({ addresses: [] });
const rates = new StaticRateSource({ source: 'tabela testowa', rates: { BTC: { '2025-03': 300000 }, ETH: { '2025-05': 10000 }, USDT: { '2025-05': 4, '2025-06': 4 } } });

const transfer = (txid: string, time: string, counterparty: string, amount: number, extra: Partial<RawTransfer> = {}): RawTransfer => ({
  txid,
  time,
  direction: 'out',
  counterparty,
  asset: 'USDT',
  amount,
  explorerUrl: `https://example.test/tx/${txid}`,
  ...extra,
});

function accountSearch(transfers: RawTransfer[], nodes: Record<string, ExpandedNode>, extra: object = {}) {
  const asked: string[] = [];
  const budget = new RequestBudget(15);
  return {
    asked,
    budget,
    search: {
      network: 'ethereum' as const,
      address: SUBJECT,
      transfers,
      labels,
      sourceName: 'źródło testowe',
      budget,
      expand: async (address: string) => {
        asked.push(address);
        return nodes[address] ?? { outgoing: [] };
      },
      ...extra,
    },
  };
}

// ---------- (a) adres przelotowy ----------

test('adres przelotowy: dwa kroki pośrednie do giełdy, każdy z regułą w `reason`', async () => {
  const { search, asked } = accountSearch([transfer('t0', '2025-05-10T08:00:00Z', A('2'), 1000)], {
    [A('2')]: { outgoing: [transfer('t1', '2025-05-10T10:00:00Z', A('3'), 995)] },
    [A('3')]: { outgoing: [transfer('t2', '2025-05-10T11:00:00Z', KRAKEN, 990)] },
  });
  const result = await traceAccountFlows(search);
  assert.equal(result.trails.length, 1);
  const trail = result.trails[0]!;
  assert.deepEqual(trail.hops.map((hop) => [hop.from, hop.to, hop.amount]), [
    [SUBJECT, A('2'), 1000],
    [A('2'), A('3'), 995],
    [A('3'), KRAKEN, 990],
  ]);
  assert.equal(trail.hops[0]?.inferred, undefined, 'pierwszy krok wynika wprost z transakcji');
  assert.equal(trail.hops[1]?.inferred, true);
  assert.match(trail.hops[1]?.reason ?? '', /w ciągu 2 h przekazał dalej 100% otrzymanej kwoty .* — reguła: adres przelotowy/);
  assert.match(trail.hops[2]?.reason ?? '', /przekazał 99% otrzymanej kwoty do usługi „Kraken: portfel giełdy” po 1 h \(reguła: adres przelotowy\)/);
  assert.equal(trail.serviceName, 'Kraken: portfel giełdy');
  assert.equal(trail.serviceKind, 'exchange_deposit');
  assert.equal(trail.amount, 990);
  // 95 − 10 − 10 + 4 (kwota 99%) + 2 (3 h) = 81
  assert.equal(trail.confidence, 81);
  assert.match(trail.reasons[0] ?? '', /^WNIOSKOWANIE: środki dotarły do usługi „Kraken: portfel giełdy” \(giełda\) przez 2 adres\(y\) pośredni\(e\)/);
  assert.match(trail.openQuestions[0] ?? '', /Kraken: portfel giełdy może potwierdzić właściciela konta, na które wpłynęło 990 USDT 2025-05-10 \(tx t2\)/);
  assert.match(trail.openQuestions.at(-1) ?? '', /Kto kontroluje adresy pośrednie/);
  assert.deepEqual(asked, [A('2'), A('3')]);
  assert.deepEqual(result.deposits, [], 'dwa kroki pośrednie to nie jest „adres wpłat giełdy”');
  assert.ok(result.limitations.some((item) => /są WNIOSKOWANIEM z jawnych reguł/.test(item)));
});

test('adres przelotowy: zbyt mała część kwoty, przekazanie po oknie i limit kroków kończą ścieżkę bez wyniku', async () => {
  const start = [transfer('t0', '2025-05-10T08:00:00Z', A('2'), 1000)];
  const partial = await traceAccountFlows(accountSearch(start, { [A('2')]: { outgoing: [transfer('t1', '2025-05-10T10:00:00Z', A('3'), 500)] } }).search);
  assert.deepEqual(partial.trails, []);
  assert.ok(partial.limitations.some((item) => /środki pozostały na adresie pośrednim/.test(item)));

  const late = await traceAccountFlows(accountSearch(start, { [A('2')]: { outgoing: [transfer('t1', '2025-05-13T10:00:00Z', KRAKEN, 1000)] } }).search);
  assert.deepEqual(late.trails, []);

  // Łańcuch czterech adresów przelotowych nie mieści się w limicie 4 kroków.
  const chain = {
    [A('2')]: { outgoing: [transfer('t1', '2025-05-10T09:00:00Z', A('3'), 1000)] },
    [A('3')]: { outgoing: [transfer('t2', '2025-05-10T10:00:00Z', A('4'), 1000)] },
    [A('4')]: { outgoing: [transfer('t3', '2025-05-10T11:00:00Z', A('5'), 1000)] },
    [A('5')]: { outgoing: [transfer('t4', '2025-05-10T12:00:00Z', KRAKEN, 1000)] },
  };
  const deep = await traceAccountFlows(accountSearch(start, chain).search);
  assert.deepEqual(deep.trails, []);
  assert.ok(deep.limitations.some((item) => /osiągnięto maksymalną liczbę kroków/.test(item)));
  const longer = await traceAccountFlows(accountSearch(start, chain, { options: { maxHops: 5 } }).search);
  assert.equal(longer.trails[0]?.hops.length, 5);
});

test('adres wpłat giełdy to szczególny przypadek jednego kroku; jedno zamiecenie obsługuje dwie wpłaty do swojej kwoty', async () => {
  const { search } = accountSearch(
    [transfer('d1', '2025-05-10T08:00:00Z', A('2'), 50), transfer('d2', '2025-05-11T08:00:00Z', A('2'), 50), transfer('d3', '2025-05-11T09:00:00Z', A('2'), 50)],
    { [A('2')]: { outgoing: [transfer('sweep', '2025-05-11T08:30:00Z', KRAKEN, 100)] } },
  );
  const result = await traceAccountFlows(search);
  // Zamiecenie 100 pokrywa dwie pierwsze wpłaty; trzecia (po zamieceniu) nie ma pokrycia.
  assert.deepEqual(result.trails.map((trail) => trail.hops[0]?.txid), ['d1', 'd2']);
  assert.deepEqual(result.deposits.map((deposit) => [deposit.txid, deposit.counterparty, deposit.forwardTxid]), [
    ['d1', A('2'), 'sweep'],
    ['d2', A('2'), 'sweep'],
  ]);
  assert.match(result.trails[0]?.hops[1]?.reason ?? '', /prawdopodobny indywidualny adres wpłat klienta giełdy \(reguła: zamiecenie adresu wpłat\)/);
  assert.match(result.trails[0]?.openQuestions[0] ?? '', /do konta którego klienta przypisany jest adres wpłat/);
  assert.equal(result.trails[1]?.confidence, 90);
});

// ---------- (d) zamiana na stablecoin ----------

test('zamiana na stablecoin i dalszy przelew: bezpośrednio do giełdy oraz przez adres wpłat', async () => {
  const swap = [
    transfer('swap', '2025-05-10T08:00:00Z', ROUTER, 1, { asset: 'ETH', counterpartyIsContract: true }),
    transfer('swap', '2025-05-10T08:00:00Z', A('9'), 2000, { direction: 'in' }),
  ];
  const direct = await traceAccountFlows(accountSearch([...swap, transfer('out', '2025-05-10T20:00:00Z', KRAKEN, 1990)], {}).search);
  assert.equal(direct.trails.length, 1);
  const trail = direct.trails[0]!;
  assert.deepEqual(trail.hops.map((hop) => [hop.txid, hop.to, hop.asset, hop.amount]), [
    ['swap', ROUTER, 'ETH', 1],
    ['out', KRAKEN, 'USDT', 1990],
  ]);
  assert.match(trail.hops[0]?.reason ?? '', /zamiana na stablecoin: 1 ETH wysłano do kontraktu wymiany „Uniswap V3: Router”, a na adres wpłynęło 2000 USDT w tej samej transakcji/);
  assert.match(trail.hops[1]?.reason ?? '', /po 12 h od zamiany z adresu wyszło 1990 USDT \(100% kwoty z zamiany\) — reguła: stablecoin z zamiany przekazany dalej/);
  assert.equal(trail.asset, 'USDT');
  assert.equal(trail.amount, 1990);
  // 95 − 12 (zamiana) + 4 (kwota) + 4 (czas od wyjścia stablecoina: 0 h) = 91 → ograniczenie do 90
  assert.equal(trail.confidence, 90);

  const viaDeposit = accountSearch([...swap, transfer('out', '2025-05-10T20:00:00Z', A('2'), 1990)], {
    [A('2')]: { outgoing: [transfer('sweep', '2025-05-10T21:00:00Z', KRAKEN, 1990)] },
  });
  const second = await traceAccountFlows(viaDeposit.search);
  assert.equal(second.trails.length, 1);
  assert.deepEqual(second.trails[0]?.hops.map((hop) => hop.txid), ['swap', 'out', 'sweep']);
  // 95 − 12 − 8 + 4 + 4 = 83
  assert.equal(second.trails[0]?.confidence, 83);
  assert.deepEqual(viaDeposit.asked, [A('2')], 'przelew po zamianie nie jest badany drugi raz jako zwykły kandydat');

  // Bez późniejszego przelewu stablecoina zamiana nie tworzy ścieżki.
  assert.deepEqual((await traceAccountFlows(accountSearch(swap, {}).search)).trails, []);
});

// ---------- zatrzymanie: duża aktywność, mikser, kontrakt, budżet ----------

test('ścieżka kończy się na adresie o dużej aktywności, chyba że wszystkie jego wyjścia trafiają do jednej giełdy', async () => {
  const start = [transfer('t0', '2025-05-10T08:00:00Z', A('2'), 1000)];
  const mixed = [transfer('t1', '2025-05-10T09:00:00Z', KRAKEN, 1000), transfer('x1', '2025-05-10T09:05:00Z', A('7'), 5000), transfer('x2', '2025-05-10T09:06:00Z', A('8'), 800)];
  const busy = await traceAccountFlows(accountSearch(start, { [A('2')]: { outgoing: mixed, txCount: 5000 } }).search);
  assert.deepEqual(busy.trails, [], 'wypłata usługi do giełdy nie jest wpłatą podmiotu');
  assert.ok(busy.limitations.some((item) => /adres pośredni o dużej aktywności \(5000 transakcji, próg 200\) — prawdopodobnie usługa bez publicznej etykiety/.test(item)));

  // Liczbę transakcji pobieramy osobnym żądaniem tylko przy pełnej stronie historii.
  const counted = accountSearch(start, { [A('2')]: { outgoing: mixed, more: true } }, { countTransactions: async () => 120 });
  const quiet = await traceAccountFlows(counted.search);
  assert.equal(quiet.trails.length, 1);
  assert.equal(counted.budget.used, 2);
  const unknown = await traceAccountFlows(accountSearch(start, { [A('2')]: { outgoing: mixed, more: true } }).search);
  assert.deepEqual(unknown.trails, [], 'nieznana aktywność przy pełnej stronie = ostrożne zatrzymanie');

  // Wzorzec adresu wpłat intensywnie używanego konta: wszystko idzie do tej samej giełdy.
  const sweeps = [1, 2, 3, 4].map((n) => transfer(`s${n}`, `2025-05-10T0${8 + n}:30:00Z`, KRAKEN, 1000));
  const exclusive = await traceAccountFlows(accountSearch(start, { [A('2')]: { outgoing: sweeps, txCount: 5000 } }).search);
  assert.equal(exclusive.trails.length, 1);
  assert.match(exclusive.trails[0]?.hops[1]?.reason ?? '', /adres ma dużą aktywność \(5000 transakcji\), ale 4 z 4 ostatnich przelewów wychodzących trafia do tej samej giełdy/);
});

test('mikser kończy ścieżkę z ostrzeżeniem; kontrakt kończy ją bez wyniku', async () => {
  const start = [transfer('t0', '2025-05-10T08:00:00Z', A('2'), 3, { asset: 'ETH' })];
  const mixed = await traceAccountFlows(
    accountSearch(start, { [A('2')]: { outgoing: [transfer('t1', '2025-05-10T09:00:00Z', MIXER, 3, { asset: 'ETH' })] } }).search,
  );
  assert.deepEqual(mixed.trails, []);
  assert.ok(mixed.limitations.some((item) => /^OSTRZEŻENIE — mikser: środki trafiły do „Tornado Cash: pula 10 ETH”/.test(item)));

  const directMixer = await traceAccountFlows(accountSearch([transfer('t0', '2025-05-10T08:00:00Z', MIXER, 3, { asset: 'ETH' })], {}).search);
  assert.ok(directMixer.limitations.some((item) => /OSTRZEŻENIE — mikser/.test(item)));

  const contract = await traceAccountFlows(
    accountSearch(start, { [A('2')]: { outgoing: [transfer('t1', '2025-05-10T09:00:00Z', A('d'), 3, { asset: 'ETH', counterpartyIsContract: true })] } }).search,
  );
  assert.deepEqual(contract.trails, []);
  assert.ok(contract.limitations.some((item) => /środki trafiły do kontraktu/.test(item)));
});

test('wyczerpanie budżetu przerywa śledzenie w połowie ścieżki i jest odnotowane', async () => {
  const { search, asked, budget } = accountSearch([transfer('t0', '2025-05-10T08:00:00Z', A('2'), 1000)], {
    [A('2')]: { outgoing: [transfer('t1', '2025-05-10T10:00:00Z', A('3'), 995)] },
    [A('3')]: { outgoing: [transfer('t2', '2025-05-10T11:00:00Z', KRAKEN, 990)] },
  });
  budget.limit = 1;
  const result = await traceAccountFlows(search);
  assert.deepEqual(result.trails, []);
  assert.deepEqual(asked, [A('2')]);
  assert.ok(result.limitations.some((item) => /Śledzenie dalszej drogi środków przerwano: wyczerpano budżet 1 żądań na jedną analizę adresu\. Sprawdzono 1 z 1 kontrahentów/.test(item)));
});

// ---------- wzór pewności ----------

test('wzór pewności: przelew bezpośredni najwyżej, każdy krok obniża, reszta bardziej niż adres przelotowy', () => {
  const base = { labelBy: 'curated' as const, amountRatio: 1, elapsedHours: 0.5 };
  const direct = trailConfidence({ ...base, steps: [] }).confidence;
  assert.equal(direct, CONFIDENCE_RULES.direct);
  assert.equal(trailConfidence({ ...base, steps: [], labelBy: 'wallet_heuristic' }).confidence, 90);

  // Monotoniczność: kolejne kroki pośrednie nigdy nie podnoszą wyniku.
  let previous = direct;
  for (let count = 1; count <= 12; count++) {
    const score = trailConfidence({ ...base, steps: Array(count).fill('passthrough') }).confidence;
    assert.ok(score < previous || score === CONFIDENCE_RULES.min, `kroków ${count}: ${score} < ${previous}`);
    previous = score;
  }
  assert.equal(previous, CONFIDENCE_RULES.min, 'wynik nie spada poniżej minimum');

  const pass = trailConfidence({ ...base, steps: ['passthrough'] }).confidence;
  const sweep = trailConfidence({ ...base, steps: ['deposit_sweep'] }).confidence;
  const change1 = trailConfidence({ ...base, steps: ['change'], changeHeuristics: [1] }).confidence;
  const change3 = trailConfidence({ ...base, steps: ['change'], changeHeuristics: [3] }).confidence;
  assert.ok(direct > sweep && sweep >= pass && pass > change3 && change3 > change1, `${direct} > ${sweep} ≥ ${pass} > ${change3} > ${change1}`);

  // Zgodność kwot i krótki czas podnoszą wynik (dla tej samej liczby kroków).
  const two = (amountRatio: number, elapsedHours: number) => trailConfidence({ labelBy: 'curated', steps: ['passthrough', 'passthrough'], amountRatio, elapsedHours }).confidence;
  assert.ok(two(1, 0.5) > two(0.95, 0.5) && two(0.95, 0.5) > two(0.7, 0.5) && two(0.7, 0.5) > two(0.3, 0.5));
  assert.ok(two(1, 0.5) > two(1, 12) && two(1, 12) > two(1, 60) && two(1, 60) > two(1, 200));
  const explained = trailConfidence({ ...base, steps: ['change', 'passthrough'], changeHeuristics: [2] });
  assert.deepEqual(explained.reasons.map((reason) => reason.split(' — ')[0]), ['95 pkt', '-18', '-10', '+4', '+4']);
});

// ---------- Bitcoin: reszta, wspólne wejścia, CoinJoin ----------

const BTC_SUBJECT = 'bc1qsubject0000000000000000000000000000';
const BTC_CHANGE = 'bc1qchange00000000000000000000000000000';
const BTC_CHANGE2 = 'bc1qchange20000000000000000000000000000';
const BTC_SHOP = '1ShopPayment00000000000000000000000';
const BTC_EXCHANGE = '1ExchangeHotWallet00000000000000000';
const BTC_OTHER = 'bc1qother000000000000000000000000000000';
const at = (iso: string) => Date.parse(iso) / 1000;
const utx = (txid: string, time: string, inputs: [string, number, string, string?, number?][], outputs: [string, number, string][]): UtxoTx => ({
  txid,
  status: { confirmed: true, block_time: at(time) },
  vin: inputs.map(([address, value, type, fromTx, fromIndex]) => ({ txid: fromTx ?? `fund-${txid}`, vout: fromIndex ?? 0, prevout: { scriptpubkey_address: address, value, scriptpubkey_type: type } })),
  vout: outputs.map(([address, value, type]) => ({ scriptpubkey_address: address, value, scriptpubkey_type: type })),
});

test('heurystyki reszty: typ skryptu, kwota nieokrągła, sprzeczne przesłanki = brak wskazania', () => {
  const own = new Set([BTC_SUBJECT]);
  const peel = utx('p', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_SHOP, 10_000_000, 'p2pkh'],
    [BTC_CHANGE, 39_987_654, 'v0_p2wpkh'],
  ]);
  const guess = detectChange(peel, own);
  assert.equal(guess?.changeAddress, BTC_CHANGE);
  assert.equal(guess?.paymentIndex, 0);
  assert.deepEqual(guess?.heuristics, ['typ skryptu zgodny z wejściem (v0_p2wpkh), drugie wyjście ma inny typ', 'kwota „nieokrągła”, podczas gdy drugie wyjście ma kwotę okrągłą']);

  // Typ skryptu wskazuje jedno wyjście, kwota drugie → brak wskazania.
  const conflict = utx('c', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_SHOP, 10_123_456, 'p2pkh'],
    [BTC_CHANGE, 39_800_000, 'v0_p2wpkh'],
  ]);
  assert.equal(detectChange(conflict, own), undefined);
  // Żadnej przesłanki, trzy wyjścia, cudze wejście → brak wskazania.
  const same = utx('s', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [[BTC_OTHER, 10_123_456, 'v0_p2wpkh'], [BTC_CHANGE, 39_812_345, 'v0_p2wpkh']]);
  assert.equal(detectChange(same, own), undefined);
  assert.equal(detectChange(utx('f', '2025-03-01T10:00:00Z', [[BTC_OTHER, 50_000_000, 'v0_p2wpkh']], peel.vout!.map((o) => [o.scriptpubkey_address!, o.value!, o.scriptpubkey_type!])), own), undefined);
  // Reszta wracająca na własny adres.
  const back = utx('b', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [[BTC_OTHER, 10_123_456, 'v0_p2wpkh'], [BTC_SUBJECT, 39_812_345, 'v0_p2wpkh']]);
  assert.deepEqual(detectChange(back, own)?.heuristics, ['reszta wraca na adres tego samego portfela']);
});

function utxoSearch(txs: UtxoTx[], histories: Record<string, UtxoTx[]>, extra: object = {}) {
  const asked: string[] = [];
  const budget = new RequestBudget(15);
  return {
    asked,
    budget,
    search: {
      network: 'bitcoin' as const,
      address: BTC_SUBJECT,
      txs,
      labels,
      sourceName: 'źródło testowe',
      budget,
      txUrl: (txid: string) => `https://example.test/tx/${txid}`,
      fetchTxs: async (address: string) => {
        asked.push(address);
        return histories[address] ?? [];
      },
      fetchTxCount: async () => 5000,
      ...extra,
    },
  };
}

test('łańcuch reszty (peel chain): płatność do giełdy z adresu reszty, heurystyki wypisane w `reason`', async () => {
  const first = utx('peel1', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_SHOP, 10_000_000, 'p2pkh'],
    [BTC_CHANGE, 39_987_654, 'v0_p2wpkh'],
  ]);
  const second = utx('peel2', '2025-03-03T12:00:00Z', [[BTC_CHANGE, 39_987_654, 'v0_p2wpkh', 'peel1', 1]], [
    [BTC_EXCHANGE, 20_000_000, 'p2pkh'],
    [BTC_CHANGE2, 19_980_111, 'v0_p2wpkh'],
  ]);
  const { search, asked } = utxoSearch([first], { [BTC_CHANGE]: [second, first], [BTC_CHANGE2]: [second] });
  const result = await traceUtxoFlows(search);

  assert.equal(result.trails.length, 1);
  const trail = result.trails[0]!;
  assert.deepEqual(trail.hops.map((hop) => [hop.txid, hop.from, hop.to, hop.amount, hop.inferred ?? false]), [
    ['peel1', BTC_SUBJECT, BTC_CHANGE, 0.39987654, true],
    ['peel2', BTC_CHANGE, BTC_EXCHANGE, 0.2, false],
  ]);
  const reason = trail.hops[0]?.reason ?? '';
  assert.match(reason, /uznany za resztę wracającą do portfela podmiotu \(heurystyki: typ skryptu zgodny z wejściem \(v0_p2wpkh\), drugie wyjście ma inny typ; kwota „nieokrągła”, podczas gdy drugie wyjście ma kwotę okrągłą; adres nie był wcześniej używany\) — reguła: łańcuch reszty/);
  assert.equal(trail.serviceName, 'Zonda: portfel giełdy');
  assert.equal(trail.amount, 0.2);
  // 95 − 15 (reszta, trzy zgodne heurystyki) = 80; bez premii za kwotę i czas — płatność wychodzi wprost z portfela.
  assert.equal(trail.confidence, 80);
  // Adresy reszty trafiają do klastra portfela; płatność do sklepu jest sprawdzana jako adres pośredni.
  assert.deepEqual(result.clusterAddresses.map((item) => item.address), [BTC_CHANGE, BTC_CHANGE2]);
  assert.match(result.clusterAddresses[0]?.reason ?? '', /heurystyka adresu reszty w transakcji peel1/);
  assert.deepEqual(asked, [BTC_SHOP, BTC_CHANGE, BTC_CHANGE2]);
  assert.ok(result.limitations.some((item) => /reszta nie została jeszcze wydana/.test(item)));
});

test('wspólne wejścia budują klaster, CoinJoin jest wykluczony; wypłata z adresu klastra ma dopisek o heurystyce', async () => {
  const cospend = utx('co', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 30_000_000, 'v0_p2wpkh'], [BTC_OTHER, 20_000_000, 'v0_p2wpkh']], [[BTC_SHOP, 49_000_000, 'p2pkh']]);
  const joinInputs: [string, number, string][] = [BTC_SUBJECT, 'bc1qjoinA', 'bc1qjoinB', 'bc1qjoinC'].map((address) => [address, 10_100_000, 'v0_p2wpkh']);
  const coinjoin = utx('cj', '2025-03-02T10:00:00Z', joinInputs, [
    ['bc1qmixed1', 10_000_000, 'v0_p2wpkh'],
    ['bc1qmixed2', 10_000_000, 'v0_p2wpkh'],
    ['bc1qmixed3', 10_000_000, 'v0_p2wpkh'],
    ['bc1qmixed4', 10_000_000, 'v0_p2wpkh'],
  ]);
  assert.equal(looksLikeCoinJoin(coinjoin), true);
  assert.equal(looksLikeCoinJoin(cospend), false);
  assert.deepEqual(commonInputAddresses([cospend, coinjoin], BTC_SUBJECT), [{ address: BTC_OTHER, txid: 'co' }]);

  // Inny adres portfela wpłaca na giełdę — ścieżka zaczyna się od niego i jest oznaczona jako wnioskowanie.
  const fromOther = utx('dep', '2025-03-05T10:00:00Z', [[BTC_OTHER, 15_000_000, 'v0_p2wpkh']], [[BTC_EXCHANGE, 14_990_000, 'p2pkh']]);
  const { search } = utxoSearch([cospend, coinjoin], { [BTC_OTHER]: [fromOther, cospend] });
  const result = await traceUtxoFlows(search);
  assert.deepEqual(result.clusterAddresses.map((item) => item.address), [BTC_OTHER]);
  assert.match(result.clusterAddresses[0]?.reason ?? '', /^heurystyka wspólnych wejść: .* w transakcji co$/);
  const trail = result.trails.find((item) => item.hops[0]?.txid === 'dep');
  assert.ok(trail);
  assert.equal(trail.sourceAddress, BTC_SUBJECT);
  assert.equal(trail.hops[0]?.from, BTC_OTHER);
  assert.equal(trail.hops[0]?.inferred, true);
  assert.match(trail.hops[0]?.reason ?? '', /uznanego za należący do portfela podmiotu \(heurystyka wspólnych wejść\)/);
  // 95 − 12 (adres z klastra) = 83
  assert.equal(trail.confidence, 83);
  assert.ok(result.limitations.some((item) => /OSTRZEŻENIE — mikser: środki trafiły do „transakcja typu CoinJoin”/.test(item)));
  assert.ok(result.limitations.some((item) => /zaczyna się od innych adresów portfela ustalonych HEURYSTYKĄ wspólnych wejść/.test(item)));

  // Bez śledzenia klaster i tak powstaje z pobranych transakcji — bez żadnych żądań.
  const passive = utxoSearch([cospend], {}, { options: { enabled: false } });
  const built = await traceUtxoFlows(passive.search);
  assert.deepEqual(built.clusterAddresses.map((item) => item.address), [BTC_OTHER]);
  assert.equal(passive.budget.used, 0);
});

test('Bitcoin: adres pośredni o dużej aktywności kończy ścieżkę; budżet ogranicza liczbę pobranych historii', async () => {
  const pay = utx('pay', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [[BTC_OTHER, 49_990_000, 'v0_p2wpkh']]);
  const page = Array.from({ length: 25 }, (_, index) => utx(`busy${index}`, '2025-03-02T10:00:00Z', [[BTC_OTHER, 1_000_000, 'v0_p2wpkh', index === 0 ? 'pay' : `x${index}`, 0]], [[BTC_EXCHANGE, 990_000, 'p2pkh']]));
  const busy = await traceUtxoFlows(utxoSearch([pay], { [BTC_OTHER]: page }).search);
  assert.deepEqual(busy.trails, []);
  assert.ok(busy.limitations.some((item) => /adres pośredni o dużej aktywności \(5000 transakcji, próg 200\)/.test(item)));

  const limited = utxoSearch([pay], { [BTC_OTHER]: page });
  limited.budget.limit = 0;
  const stopped = await traceUtxoFlows(limited.search);
  assert.deepEqual(limited.asked, []);
  assert.ok(stopped.limitations.some((item) => /przerwano: wyczerpano budżet 0 żądań/.test(item)));
});

test('Esplora: klaster w wyniku analizy, ścieżka z adresu reszty daje wskaźnik wypłaty bez dublowania', async () => {
  const api = 'https://blockstream.info/api/address';
  const first = utx('peel1', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_SHOP, 10_000_000, 'p2pkh'],
    [BTC_CHANGE, 39_987_654, 'v0_p2wpkh'],
  ]);
  const second = utx('peel2', '2025-03-03T12:00:00Z', [[BTC_CHANGE, 39_987_654, 'v0_p2wpkh', 'peel1', 1]], [[BTC_EXCHANGE, 39_980_000, 'p2pkh']]);
  const mock = mockFetch({
    [`${api}/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 50_000_000, tx_count: 1 } },
    [`${api}/${BTC_SUBJECT}/txs`]: [first],
    [`${api}/${BTC_CHANGE}/txs`]: [second, first],
  });
  const provider = new EsploraProvider({ id: 'esplora-blockstream', label: 'Blockstream Esplora (Bitcoin)', siteUrl: 'https://blockstream.info', fetch: mock.fetch, rateSource: rates, labels, sanctions: noSanctions, followDeposits: true });
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());

  assert.deepEqual(activity.cluster?.addresses.map((item) => item.address), [BTC_CHANGE]);
  assert.match(activity.cluster?.method[0] ?? '', /^HEURYSTYKA wspólnych wejść/);
  assert.equal(activity.trails?.length, 1);
  assert.equal(activity.trails?.[0]?.valuePln, 119940);
  assert.match(activity.trails?.[0]?.valuation ?? '', /^Szacunek: 0,3998 BTC × /);
  // Jeden wskaźnik: wpłata na giełdę z adresu reszty, opisana jako wnioskowanie.
  assert.equal(activity.cashOuts.length, 1);
  assert.equal(activity.cashOuts[0]?.txid, 'peel2');
  assert.match(activity.cashOuts[0]?.explanation ?? '', /^WNIOSKOWANIE \(nie ustalony fakt\): 0,3998 BTC dotarło do usługi „Zonda: portfel giełdy” ścieżką o 2 krokach/);
  assert.deepEqual(activity.cashOutPlnByYear, { '2025': 119940 });
});

// ---------- Tron: TRC-20 z TronScan ----------

test('Tron: transfery TRC-20 i znaczniki z TronScan — wpłata bezpośrednia i przez adres wpłat', async () => {
  const subject = 'TSubjectAddress0000000000000000000';
  const deposit = 'TDepositAddress0000000000000000000';
  const hot = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
  const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const grid = `https://api.trongrid.io/v1/accounts/${subject}`;
  const scan = 'https://apilist.tronscanapi.com';
  const row = (id: string, time: string, from: string, to: string, usd: number, toTag?: string) => ({
    transaction_id: id,
    block_ts: Date.parse(time),
    from_address: from,
    to_address: to,
    quant: String(usd * 1e6),
    confirmed: true,
    contractRet: 'SUCCESS',
    finalResult: 'SUCCESS',
    tokenInfo: { tokenId: usdt, tokenAbbr: 'USDT', tokenDecimal: 6 },
    from_address_tag: { from_address_tag_logo: '' },
    to_address_tag: toTag ? { to_address_tag: toTag } : { to_address_tag_logo: '' },
    fromAddressIsContract: false,
    toAddressIsContract: false,
  });
  // Odpowiedzi w układzie zapisanym z TronScan (`/api/token_trc20/transfers`).
  const mock = mockFetch({
    [grid]: { data: [{ balance: 5_000_000 }] },
    [`${grid}/transactions?limit=50&only_confirmed=true`]: { data: [] },
    [`${scan}/api/token_trc20/transfers?relatedAddress=${subject}&limit=50&start=0`]: {
      total: 10000,
      token_transfers: [
        row('direct', '2025-06-03T12:00:00Z', subject, hot, 1500, 'Binance-Hot 2'),
        row('todeposit', '2025-06-01T12:00:00Z', subject, deposit, 800),
        { ...row('failed', '2025-06-02T12:00:00Z', subject, hot, 9999, 'Binance-Hot 2'), finalResult: 'REVERT' },
        { ...row('fake', '2025-06-02T13:00:00Z', subject, hot, 5000, 'Binance-Hot 2'), tokenInfo: { tokenId: 'TFakeToken', tokenAbbr: 'USDT', tokenDecimal: 6 } },
      ],
    },
    // Zapytanie o adres pośredni jest zawężone do okna 48 h od wpłaty.
    [`${scan}/api/token_trc20/transfers?relatedAddress=${deposit}&limit=50&start=0&contract_address=${usdt}&start_timestamp=${Date.parse('2025-06-01T12:00:00Z')}&end_timestamp=${Date.parse('2025-06-03T12:00:00Z')}`]: {
      total: 10000,
      token_transfers: [row('sweep', '2025-06-01T12:20:00Z', deposit, hot, 800, 'Binance-Hot 2'), row('todeposit', '2025-06-01T12:00:00Z', subject, deposit, 800)],
    },
    [`${scan}/api/account/tag?address=${subject}`]: { publicTag: '' },
  });
  const tronLabels = createLabelSet([{ network: 'tron', address: usdt, label: 'Tether: kontrakt tokena USDT (TRC-20)', addressClass: 'smart_contract', asset: 'USDT' }], 'zbiór testowy');
  const provider = new TronGridProvider({
    fetch: mock.fetch,
    rateSource: rates,
    labels: tronLabels,
    sanctions: noSanctions,
    labelLookup: new TronScanTagClient({ fetch: mock.fetch, minIntervalMs: 0 }),
    tronScanUrl: scan,
    followDeposits: true,
  });
  const activity = await provider.getActivity('tron', subject, testContext());

  assert.equal(activity.transfers.length, 3, 'nieudana transakcja jest pominięta');
  const fake = activity.transfers.find((item) => item.txid === 'fake');
  assert.match(fake?.asset ?? '', /niezweryfikowany token/);
  const direct = activity.transfers.find((item) => item.txid === 'direct');
  assert.equal(direct?.counterpartyLabel, 'Binance-Hot 2');
  assert.equal(direct?.counterpartyClass, 'exchange');
  assert.equal(activity.cluster?.addresses.length, 0);
  assert.match(activity.cluster?.method[0] ?? '', /model.* kont.*klaster nie jest budowany/);

  assert.deepEqual(activity.trails?.map((trail) => [trail.hops.map((hop) => hop.txid).join('>'), trail.confidence, trail.amount]), [
    ['todeposit>sweep', 90, 800],
    ['direct', 95, 1500],
  ]);
  assert.equal(activity.trails?.[0]?.serviceName, 'Binance-Hot 2');
  assert.equal(activity.trails?.[1]?.valuePln, 6000);
  // Dwa wskaźniki na prawdziwy USDT; fałszywy token też wskazuje giełdę, ale nie jest wyceniany.
  assert.deepEqual(activity.cashOuts.map((item) => [item.txid, item.valuePln]), [['todeposit', 3200], ['fake', undefined], ['direct', 6000]]);
  assert.match(activity.cashOuts[0]?.explanation ?? '', /^WNIOSKOWANIE/);
  // TronScan podał znaczniki w transferach — o kontrahentów nie pytamy osobno (tylko o badany adres).
  assert.equal(mock.calls.filter((url) => url.includes('/api/account/tag')).length, 1);
  assert.equal(mock.calls.length, 5);
});

test('Tron: gdy TronScan nie odpowiada, transfery TRC-20 pochodzą z TronGrid, a ograniczenie to opisuje', async () => {
  const subject = 'TSubjectAddress0000000000000000000';
  const grid = `https://api.trongrid.io/v1/accounts/${subject}`;
  const mock = mockFetch({
    [grid]: { data: [{ balance: 1 }] },
    [`${grid}/transactions?limit=50&only_confirmed=true`]: { data: [] },
    [`${grid}/transactions/trc20?limit=50&only_confirmed=true`]: { data: [] },
    [`https://apilist.tronscanapi.com/api/token_trc20/transfers?relatedAddress=${subject}&limit=50&start=0`]: { status: 429 },
  });
  const provider = new TronGridProvider({ fetch: mock.fetch, rateSource: rates, labels, sanctions: noSanctions, tronScanUrl: 'https://apilist.tronscanapi.com' });
  const activity = await provider.getActivity('tron', subject, testContext());
  assert.ok(activity.limitations.some((item) => /TronScan nie zwrócił transferów TRC-20 \(TronScan: przekroczono limit zapytań.*użyto TronGrid/.test(item)));
});

// ---------- Ethereum: hurtowe znaczniki i tryb głęboki ----------

test('Blockscout: hurtowe znaczniki z usługi metadanych uzupełniają etykiety kontrahentów jednym żądaniem', async () => {
  const BS = 'https://eth.blockscout.com/api/v2/addresses';
  const META = 'https://metadata.services.blockscout.com';
  const krakenLike = A('a');
  const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null, public_tags: [], private_tags: [] });
  const mock = mockFetch({
    [`${BS}/${SUBJECT}`]: { ...party(SUBJECT), coin_balance: '0' },
    [`${BS}/${SUBJECT}/transactions`]: {
      items: [
        { hash: '0xt1', timestamp: '2025-05-10T08:00:00.000000Z', from: party(SUBJECT), to: party(krakenLike), value: '2000000000000000000', status: 'ok' },
        { hash: '0xt2', timestamp: '2025-05-11T08:00:00.000000Z', from: party(SUBJECT), to: party(A('b')), value: '1000000000000000000', status: 'ok' },
      ],
    },
    [`${BS}/${SUBJECT}/token-transfers?type=ERC-20`]: { items: [] },
    // Zapisany układ odpowiedzi usługi metadanych (pole `meta` jest tekstem JSON).
    [`${META}/api/v1/metadata?addresses=${krakenLike},${A('b')}&chainId=1&tagsLimit=20`]: {
      addresses: {
        [krakenLike]: {
          tags: [
            { slug: 'kraken-hot-wallet', name: 'Kraken: Hot Wallet', tagType: 'name', ordinal: 10, meta: '{"main_entity":"Kraken"}' },
            { slug: 'exchange', name: 'Exchange', tagType: 'generic', ordinal: 0, meta: '{}' },
          ],
        },
      },
    },
  });
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource: rates, labels, sanctions: noSanctions, metadataUrl: META });
  const activity = await provider.getActivity('ethereum', SUBJECT, testContext());
  const labelled = activity.transfers.find((item) => item.txid === '0xt1');
  assert.equal(labelled?.counterpartyLabel, 'Kraken: Hot Wallet');
  assert.equal(labelled?.counterpartyClass, 'exchange');
  assert.equal(activity.transfers.find((item) => item.txid === '0xt2')?.counterpartyClass, 'unknown');
  assert.deepEqual(activity.cashOuts.map((item) => item.txid), ['0xt1']);
  assert.equal(activity.trails?.[0]?.confidence, 95);
  assert.match(activity.trails?.[0]?.reasons[0] ?? '', /etykieta: Blockscout \(klasa podana przez źródło\)/);
  assert.equal(mock.calls.length, 4);
});

test('createChainProviders: tryb głęboki podnosi budżet żądań do 40, standardowy zostaje przy 15', () => {
  const budgets = (config: object) =>
    createChainProviders({ enableLive: true, fetch: mockFetch({}).fetch, ...config }).map((provider) => (provider as unknown as { requestBudget: number }).requestBudget);
  assert.deepEqual(budgets({}), [15, 15, 15, 15]);
  assert.deepEqual(budgets({ depth: 'deep' }), [DEEP_REQUEST_BUDGET, DEEP_REQUEST_BUDGET, DEEP_REQUEST_BUDGET, DEEP_REQUEST_BUDGET]);
  assert.equal(DEEP_REQUEST_BUDGET, 40);
  assert.deepEqual(budgets({ depth: 'deep', requestBudget: 25 }), [25, 25, 25, 25]);
});

// ---------- Kursy: sporadyczne błędy NBP ----------

test('kurs NBP: po błędzie 500 zapytanie jest ponawiane, a gdy zakres wciąż zawodzi — cofamy się dzień po dniu', async () => {
  const { MarketRateSource } = await import('../src/valuation.ts');
  const range = 'https://api.nbp.pl/api/exchangerates/rates/a/usd/2025-03-08/2025-03-14/?format=json';
  const friday = { rates: [{ no: '051/A/NBP/2025', effectiveDate: '2025-03-14', mid: 3.8509 }] };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

  // Pierwsza odpowiedź 500, druga poprawna.
  const calls: string[] = [];
  const flaky = new MarketRateSource({
    fetch: async (url) => {
      calls.push(url);
      return calls.length === 1 ? new Response('Internal Server Error', { status: 500 }) : json(friday);
    },
  });
  assert.equal((await flaky.usdPlnBefore('2025-03-15')).mid, 3.8509);
  assert.deepEqual(calls, [range, range]);

  // Zakres zawodzi trwale: tabela z dnia poprzedniego pojedynczym zapytaniem.
  const single: string[] = [];
  const broken = new MarketRateSource({
    fetch: async (url) => {
      single.push(url);
      return url === range ? new Response('Internal Server Error', { status: 500 }) : json(friday);
    },
  });
  const table = await broken.usdPlnBefore('2025-03-15');
  assert.equal(table.effectiveDate, '2025-03-14');
  assert.equal(single.at(-1), 'https://api.nbp.pl/api/exchangerates/rates/a/usd/2025-03-14/?format=json');
  assert.equal(single.length, 5, 'cztery próby zakresu i jedno zapytanie o dzień');
});
