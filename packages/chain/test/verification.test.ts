// Testy regresji z weryfikacji modułu blockchain: czego narzędziu NIE wolno wnioskować.
// Wspólna giełda lub kontrakt to nie powiązanie osób, adres usługi to nie portfel prywatny,
// reszta to nie płatność, a brak danych (kurs, liczba miejsc po przecinku) to brak wyniku — nie zero i nie zgadywanie.
// Bez internetu: dane wstrzykiwane funkcjami lub atrapą `fetch`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressCluster } from '@olcys/core';
import { buildChainActivity } from '../src/activity.ts';
import type { RawTransfer } from '../src/activity.ts';
import { CASHOUT_CAVEAT } from '../src/cashout.ts';
import type { ClassifiedTransfer } from '../src/cashout.ts';
import { commonInputAddresses } from '../src/cluster.ts';
import type { UtxoTx } from '../src/cluster.ts';
import type { InferredDeposit } from '../src/deposit.ts';
import { RequestBudget } from '../src/http.ts';
import { classify, createLabelSet } from '../src/labels.ts';
import { findLinkedAddresses } from '../src/links.ts';
import type { IncomingNode, LinkSearch } from '../src/links.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { EsploraProvider, esploraTransfer } from '../src/providers/esplora.ts';
import { TronGridProvider } from '../src/providers/trongrid.ts';
import { traceAccountFlows, traceUtxoFlows } from '../src/trace.ts';
import type { ExpandedNode } from '../src/trace.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const A = (letter: string) => `0x${letter.repeat(40)}`;
const WALLET_A = A('1');
const WALLET_B = A('2');
const HOT_WALLET = A('e');
const ROUTER = A('c');
const DEPOSIT = A('d');
const BTC_SUBJECT = 'bc1qsubject0000000000000000000000000000';
const BTC_OTHER = 'bc1qother000000000000000000000000000000';
const BTC_CHANGE = 'bc1qchange00000000000000000000000000000';
const BTC_SHOP = '1ShopPayment00000000000000000000000';
const BTC_EXCHANGE = '1ExchangeHotWallet00000000000000000';
const BTC_FOUNDATION = '1FoundationDonations000000000000000';
const BTC_WE_WALLET = '1WalletExplorerLabelled000000000000';

const labels = createLabelSet(
  [
    { network: 'ethereum', address: HOT_WALLET, label: 'Kraken: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
    { network: 'ethereum', address: ROUTER, label: 'Uniswap V3: Router', addressClass: 'smart_contract' },
    { network: 'bitcoin', address: BTC_EXCHANGE, label: 'Zonda: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
    { network: 'bitcoin', address: BTC_FOUNDATION, label: 'Fundacja Testowa: zbiórka', addressClass: 'charity' },
  ],
  'zbiór testowy',
);
const noSanctions = createSanctionsList({ addresses: [] });
const rates = new StaticRateSource({ source: 'tabela testowa', rates: { BTC: { '2025-03': 300000 }, USDT: { '2025-05': 4 } } });

const move = (txid: string, time: string, direction: 'in' | 'out', counterparty: string, amount: number, extra: Partial<RawTransfer> = {}): RawTransfer => ({
  txid,
  time,
  direction,
  counterparty,
  asset: 'USDT',
  amount,
  explorerUrl: `https://example.test/tx/${txid}`,
  ...extra,
});

function linkSearch(extra: Partial<LinkSearch> & { nodes?: Record<string, IncomingNode>; counts?: Record<string, number | undefined> }) {
  const asked: string[] = [];
  const budget = new RequestBudget(12);
  const { nodes = {}, counts = {}, ...rest } = extra;
  const input: LinkSearch = {
    network: 'ethereum',
    address: WALLET_A,
    transfers: [],
    deposits: [],
    historyComplete: true,
    labels,
    sourceName: 'źródło testowe',
    budget,
    fetchIncoming: async (address) => {
      asked.push(address);
      return nodes[address] ?? { incoming: [] };
    },
    countTransactions: async (address) => (address in counts ? counts[address] : 5),
    ...rest,
  };
  return { input, asked, budget };
}

const at = (iso: string) => Date.parse(iso) / 1000;
const utx = (txid: string, time: string, inputs: [string, number, string, string?, number?][], outputs: [string, number, string][]): UtxoTx => ({
  txid,
  status: { confirmed: true, block_time: at(time) },
  vin: inputs.map(([address, value, type, fromTx, fromIndex]) => ({ txid: fromTx ?? `fund-${txid}`, vout: fromIndex ?? 0, prevout: { scriptpubkey_address: address, value, scriptpubkey_type: type } })),
  vout: outputs.map(([address, value, type]) => ({ scriptpubkey_address: address, value, scriptpubkey_type: type })),
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
      fetchTxCount: async () => 5,
      ...extra,
    },
  };
}

// ---------- Powiązania: wspólna giełda i wspólny kontrakt to nie wspólny właściciel ----------

test('dwa portfele korzystają z tej samej giełdy → brak powiązania', async () => {
  // Oba portfele wpłacają WPROST na ten sam portfel zbiorczy giełdy (hot wallet), na który wpłacają tysiące osób.
  const fromA = [move('a1', '2025-05-10T08:00:00Z', 'out', HOT_WALLET, 1000), move('a2', '2025-05-20T08:00:00Z', 'out', HOT_WALLET, 500)];
  const hot: IncomingNode = {
    incoming: [move('a1', '2025-05-10T08:00:00Z', 'in', WALLET_A, 1000), move('b1', '2025-05-11T08:00:00Z', 'in', WALLET_B, 700)],
  };
  const direct = linkSearch({ transfers: fromA, nodes: { [HOT_WALLET]: hot } });
  const result = await findLinkedAddresses(direct.input);
  assert.deepEqual(result.links, []);
  assert.ok(!direct.asked.includes(HOT_WALLET), 'portfel zbiorczy giełdy nie jest w ogóle badany jako adres wpłat');
  assert.equal(direct.budget.used, 0);

  // To samo z perspektywy drugiego portfela.
  const other = linkSearch({ address: WALLET_B, transfers: [move('b1', '2025-05-11T08:00:00Z', 'out', HOT_WALLET, 700)], nodes: { [HOT_WALLET]: hot } });
  assert.deepEqual((await findLinkedAddresses(other.input)).links, []);

  // Bitcoin: adres zaliczony przez WalletExplorer do portfela giełdy. Mało nadawców na pierwszej stronie historii,
  // ale adres ma tysiące transakcji — to portfel zbiorczy, nie indywidualny adres wpłat.
  const toWallet = [move('w1', '2025-05-10T08:00:00Z', 'out', BTC_WE_WALLET, 0.5, { asset: 'BTC', counterpartyLabel: 'Binance.com', counterpartyLabelSource: 'WalletExplorer' })];
  const page: IncomingNode = {
    incoming: [move('w1', '2025-05-10T08:00:00Z', 'in', BTC_SUBJECT, 0.5, { asset: 'BTC' }), move('w2', '2025-05-10T09:00:00Z', 'in', BTC_OTHER, 0.2, { asset: 'BTC' })],
    more: true,
  };
  const busy = linkSearch({ network: 'bitcoin', address: BTC_SUBJECT, transfers: toWallet, nodes: { [BTC_WE_WALLET]: page }, counts: { [BTC_WE_WALLET]: 48_000 } });
  const rejected = await findLinkedAddresses(busy.input);
  assert.deepEqual(rejected.links, []);
  assert.ok(rejected.limitations.some((item) => /48000 transakcji — to raczej adres pośrednika .*Nie utworzono powiązań „współwpłacający”\./.test(item)));

  // Etykieta bez zaobserwowanego zamiecenia wymaga aktywności pojedynczego klienta (próg adresu prywatnego, nie 2000).
  const medium = linkSearch({ network: 'bitcoin', address: BTC_SUBJECT, transfers: toWallet, nodes: { [BTC_WE_WALLET]: page }, counts: { [BTC_WE_WALLET]: 900 } });
  assert.deepEqual((await findLinkedAddresses(medium.input)).links, []);

  // Liczby transakcji nie da się ustalić (brak budżetu lub odpowiedzi): nie wiemy, czy to adres wpłat — powiązań nie tworzymy.
  const blind = linkSearch({ network: 'bitcoin', address: BTC_SUBJECT, transfers: toWallet, nodes: { [BTC_WE_WALLET]: page }, counts: { [BTC_WE_WALLET]: undefined } });
  const unknown = await findLinkedAddresses(blind.input);
  assert.deepEqual(unknown.links, []);
  assert.ok(unknown.limitations.some((item) => /liczby jego transakcji nie udało się ustalić — nie da się odróżnić indywidualnego adresu wpłat od portfela zbiorczego usługi/.test(item)));

  // Adres wpisany do zbioru etykiet jako portfel giełdy nie jest kandydatem na adres wpłat, nawet z etykietą WalletExplorer.
  const curated = linkSearch({
    network: 'bitcoin',
    address: BTC_SUBJECT,
    transfers: [move('z1', '2025-05-10T08:00:00Z', 'out', BTC_EXCHANGE, 0.5, { asset: 'BTC', counterpartyLabel: 'Zonda.exchange', counterpartyLabelSource: 'WalletExplorer' })],
    nodes: { [BTC_EXCHANGE]: { incoming: [move('z2', '2025-05-10T09:00:00Z', 'in', BTC_OTHER, 0.2, { asset: 'BTC' })] } },
  });
  assert.deepEqual((await findLinkedAddresses(curated.input)).links, []);
  assert.deepEqual(curated.asked, []);
});

test('wspólny indywidualny adres wpłat to jedyna podstawa powiązania przez giełdę — zawsze jako wnioskowanie o sile poniżej 100', async () => {
  const deposit: InferredDeposit = {
    txid: 'dep1',
    counterparty: DEPOSIT,
    asset: 'USDT',
    exchangeAddress: HOT_WALLET,
    exchangeLabel: 'Kraken: portfel giełdy',
    exchangeLabelSource: 'zbiór testowy',
    hoursToForward: 0.2,
    forwardedAmount: 1000,
    forwardedShare: 1,
    forwardTxid: 'sweep1',
  };
  const { input } = linkSearch({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    nodes: { [DEPOSIT]: { incoming: [move('dep1', '2025-05-10T08:00:00Z', 'in', WALLET_A, 1000), move('b1', '2025-05-11T08:00:00Z', 'in', WALLET_B, 700)] } },
  });
  const { links, limitations } = await findLinkedAddresses(input);
  assert.deepEqual(links.map((link) => [link.address, link.kind]), [[WALLET_B, 'co_depositor']]);
  assert.ok(links[0]!.strength < 100 && links[0]!.strength > 0);
  assert.match(links[0]!.reason, /^HEURYSTYKA „współwpłacający”/);
  assert.match(links[0]!.reason, /sam adres wpłat ustalono wnioskowaniem/);
  assert.ok(limitations.some((item) => /to HEURYSTYKI wskazujące kandydatów .* nie ustalenie tożsamości/.test(item)));
});

test('dwa portfele korzystają z tego samego kontraktu → brak powiązania', async () => {
  const swap = (txid: string, time: string, direction: 'in' | 'out') => move(txid, time, direction, ROUTER, 2, { asset: 'ETH', counterpartyIsContract: true });
  // Wielokrotne przelewy w obie strony przez długi czas — wzorzec „stałego kontrahenta”, ale kontrahentem jest kontrakt.
  const transfers = [swap('s1', '2025-01-10T10:00:00Z', 'out'), swap('s2', '2025-02-10T10:00:00Z', 'in'), swap('s3', '2025-04-10T10:00:00Z', 'out'), swap('s4', '2025-06-10T10:00:00Z', 'in')];
  const { input, asked, budget } = linkSearch({ transfers, nodes: { [ROUTER]: { incoming: [move('x', '2025-03-01T10:00:00Z', 'in', WALLET_B, 5, { asset: 'ETH' })] } } });
  assert.deepEqual((await findLinkedAddresses(input)).links, []);
  assert.deepEqual(asked, []);
  assert.equal(budget.used, 0);

  // Kontrakt bez wpisu w zbiorze etykiet — wystarcza informacja źródła, że pod adresem jest kod.
  const anonymous = A('9');
  const plain = linkSearch({
    transfers: transfers.map((item) => ({ ...item, counterparty: anonymous })),
    nodes: { [anonymous]: { incoming: [move('x', '2025-03-01T10:00:00Z', 'in', WALLET_B, 5, { asset: 'ETH' })] } },
  });
  assert.deepEqual((await findLinkedAddresses(plain.input)).links, []);
  assert.deepEqual(plain.asked, []);
});

test('adres kontraktu nie jest portfelem prywatnym', async () => {
  // Kod pod adresem przesądza o klasie — także wtedy, gdy adres ma historię transakcji i brak etykiety.
  const contract = classify('ethereum', A('9'), { labels, isContract: true, txCount: 120, sourceName: 'źródło testowe' });
  assert.equal(contract.addressClass, 'smart_contract');
  assert.match(contract.classificationSource, /pod adresem jest kod kontraktu/);
  // Adres giełdy z etykietą też nie staje się prywatny przez samą historię transakcji.
  assert.equal(classify('ethereum', HOT_WALLET, { labels, txCount: 120 }).addressClass, 'exchange');
  // Kontrahent bez etykiety pozostaje „nieznany” — nigdy nie jest z góry portfelem prywatnym.
  assert.equal(classify('ethereum', A('8'), { labels }).addressClass, 'unknown');

  // Badany adres będący kontraktem: profil ma klasę kontraktu; kontrahent-kontrakt także.
  const activity = await buildChainActivity(
    {
      network: 'ethereum',
      address: A('9'),
      sourceName: 'źródło testowe',
      isContract: true,
      transfers: [move('t1', '2025-05-10T08:00:00Z', 'out', A('7'), 10, { counterpartyIsContract: true }), move('t2', '2025-05-11T08:00:00Z', 'in', A('8'), 10)],
      limitations: [],
    },
    { labels, rateSource: rates, sanctions: noSanctions },
  );
  assert.equal(activity.profile.addressClass, 'smart_contract');
  assert.equal(activity.profile.isContract, true);
  assert.deepEqual(activity.transfers.map((item) => item.counterpartyClass), ['smart_contract', 'unknown']);

  // Klaster portfela: adres z etykietą usługi nie staje się „tym samym portfelem” osoby.
  const cluster: AddressCluster = {
    seed: BTC_SUBJECT,
    network: 'bitcoin',
    method: [],
    addresses: [
      { address: BTC_EXCHANGE, txid: 'co1', reason: 'heurystyka wspólnych wejść: środki tego adresu wydano razem ze środkami adresu podmiotu w transakcji co1' },
      { address: BTC_OTHER, txid: 'co2', reason: 'heurystyka wspólnych wejść: środki tego adresu wydano razem ze środkami adresu podmiotu w transakcji co2' },
    ],
  };
  const linked = await findLinkedAddresses(linkSearch({ network: 'bitcoin', address: BTC_SUBJECT, cluster }).input);
  assert.deepEqual(linked.links.map((link) => [link.address, link.kind]), [[BTC_OTHER, 'same_wallet']]);
  assert.ok(linked.links[0]!.strength < 100);
  assert.ok(linked.limitations.some((item) => /pominięto 1 adres\(y\) klastra z publiczną etykietą usługi/.test(item)));
});

// ---------- Klaster UTXO: adresy usług poza klastrem ----------

test('wspólne wejścia z adresem giełdy nie budują klastra; adres z etykietą usługi nie ma klastra ani ścieżek', async () => {
  // Wypłata zbiorcza usługi: wśród wejść jest adres giełdy — cała transakcja nie świadczy o wspólnym portfelu.
  const batch = utx('batch', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 30_000_000, 'v0_p2wpkh'], [BTC_EXCHANGE, 90_000_000, 'p2pkh'], [BTC_OTHER, 5_000_000, 'v0_p2wpkh']], [[BTC_SHOP, 124_000_000, 'p2pkh']]);
  const own = utx('own', '2025-03-02T10:00:00Z', [[BTC_SUBJECT, 30_000_000, 'v0_p2wpkh'], [BTC_CHANGE, 20_000_000, 'v0_p2wpkh']], [[BTC_SHOP, 49_000_000, 'p2pkh']]);
  const isService = (address: string) => address === BTC_EXCHANGE;
  assert.deepEqual(commonInputAddresses([batch, own], BTC_SUBJECT, isService), [{ address: BTC_CHANGE, txid: 'own' }]);

  const passive = utxoSearch([batch, own], {}, { options: { enabled: false } });
  const built = await traceUtxoFlows(passive.search);
  assert.deepEqual(built.clusterAddresses.map((item) => item.address), [BTC_CHANGE]);

  // Badany adres sam jest portfelem giełdy: żadnego klastra i żadnego śledzenia „przez giełdę”.
  const exchangeSpend = utx('ex', '2025-03-03T10:00:00Z', [[BTC_EXCHANGE, 90_000_000, 'p2pkh'], [BTC_OTHER, 5_000_000, 'v0_p2wpkh']], [[BTC_SHOP, 94_000_000, 'p2pkh']]);
  const service = utxoSearch([exchangeSpend], { [BTC_SHOP]: [] }, { address: BTC_EXCHANGE });
  const result = await traceUtxoFlows(service.search);
  assert.deepEqual(result.clusterAddresses, []);
  assert.deepEqual(result.trails, []);
  assert.deepEqual(service.asked, []);
  assert.ok(result.limitations.some((item) => /Badany adres ma publiczną etykietę usługi — nie budujemy klastra portfela .* nie śledzimy dalszej drogi środków/.test(item)));
});

// ---------- Bitcoin: reszta nie jest płatnością, kwota należy do jednego odbiorcy ----------

test('Bitcoin: reszta wracająca na nowy adres portfela nie jest kontrahentem ani częścią kwoty przelewu', async () => {
  // Płatność 0,1 BTC do sklepu, 0,39987654 BTC reszty na nowy adres tego samego typu co wejście.
  const peel = utx('peel', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_SHOP, 10_000_000, 'p2pkh'],
    [BTC_CHANGE, 39_987_654, 'v0_p2wpkh'],
  ]);
  const described = esploraTransfer(peel, BTC_SUBJECT, '2025-03-01T10:00:00.000Z', 'https://example.test/tx/peel');
  assert.equal(described?.direction, 'out');
  assert.equal(described?.counterparty, BTC_SHOP);
  assert.equal(described?.amount, 0.1);
  assert.equal(described?.changeAddress, BTC_CHANGE);

  // Bez rozstrzygającej heurystyki (ten sam typ, obie kwoty nieokrągłe) niczego nie zgadujemy: odbiorca największej kwoty, tylko jego kwota.
  const unclear = utx('unclear', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [
    [BTC_OTHER, 10_123_456, 'v0_p2wpkh'],
    [BTC_CHANGE, 39_812_345, 'v0_p2wpkh'],
  ]);
  const guess = esploraTransfer(unclear, BTC_SUBJECT, '2025-03-01T10:00:00.000Z', 'https://example.test/tx/unclear');
  assert.deepEqual([guess?.counterparty, guess?.amount, guess?.changeAddress, guess?.otherRecipients, guess?.otherAmount], [BTC_CHANGE, 0.39812345, undefined, 1, 0.10123456]);

  // W wyniku analizy: przelew do sklepu, a heurystyka reszty i jej zawodność opisane w ograniczeniach.
  const api = 'https://blockstream.info/api/address';
  const mock = mockFetch({
    [`${api}/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 50_000_000, spent_txo_sum: 50_000_000, tx_count: 1 } },
    [`${api}/${BTC_SUBJECT}/txs`]: [peel],
  });
  const provider = new EsploraProvider({ id: 'esplora-test', label: 'Esplora test', siteUrl: 'https://blockstream.info', fetch: mock.fetch, rateSource: rates, labels, sanctions: noSanctions });
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.deepEqual(activity.transfers.map((item) => [item.counterparty, item.amount]), [[BTC_SHOP, 0.1]]);
  assert.deepEqual(activity.cashOuts, []);
  assert.ok(activity.limitations.some((item) => /w 1 transakcjach wychodzących jedno z dwóch wyjść uznano HEURYSTYCZNIE za resztę/.test(item)));
});

test('Bitcoin: wpłata na giełdę w transakcji z kilkoma odbiorcami ma kwotę tylko z wyjścia na adres giełdy', () => {
  const multi = utx('multi', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 100_000_000, 'v0_p2wpkh'], [BTC_OTHER, 20_000_000, 'v0_p2wpkh']], [
    [BTC_EXCHANGE, 60_000_000, 'p2pkh'],
    [BTC_SHOP, 30_000_000, 'p2pkh'],
    [BTC_FOUNDATION, 29_000_000, 'p2pkh'],
  ]);
  const described = esploraTransfer(multi, BTC_SUBJECT, '2025-03-01T10:00:00.000Z', 'https://example.test/tx/multi');
  assert.deepEqual([described?.counterparty, described?.amount, described?.otherRecipients, described?.otherAmount], [BTC_EXCHANGE, 0.6, 2, 0.59]);

  // Transakcja współfinansowana: adresowi nie przypisujemy więcej, niż sam wniósł.
  const coFunded = utx('cofunded', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 10_000_000, 'v0_p2wpkh'], [BTC_OTHER, 90_000_000, 'v0_p2wpkh']], [[BTC_EXCHANGE, 99_000_000, 'p2pkh']]);
  assert.equal(esploraTransfer(coFunded, BTC_SUBJECT, '2025-03-01T10:00:00.000Z', 'https://example.test/tx/cofunded')?.amount, 0.1);
});

// ---------- Śledzenie: koniec na adresie z etykietą, nic „przez giełdę” ----------

test('Bitcoin: ścieżka kończy się na adresie z etykietą, która nie jest usługą wymiany', async () => {
  const pay = utx('pay', '2025-03-01T10:00:00Z', [[BTC_SUBJECT, 50_000_000, 'v0_p2wpkh']], [[BTC_OTHER, 49_990_000, 'v0_p2wpkh']]);
  // Adres pośredni przekazał wszystko fundacji; fundacja wpłaciła potem na giełdę — to już nie są środki podmiotu.
  const donate = utx('donate', '2025-03-01T12:00:00Z', [[BTC_OTHER, 49_990_000, 'v0_p2wpkh', 'pay', 0]], [[BTC_FOUNDATION, 49_980_000, 'p2pkh']]);
  const onward = utx('onward', '2025-03-01T14:00:00Z', [[BTC_FOUNDATION, 49_980_000, 'p2pkh', 'donate', 0]], [[BTC_EXCHANGE, 49_970_000, 'p2pkh']]);
  const { search, asked } = utxoSearch([pay], { [BTC_OTHER]: [donate, pay], [BTC_FOUNDATION]: [onward, donate] });
  const result = await traceUtxoFlows(search);
  assert.deepEqual(result.trails, []);
  assert.deepEqual(asked, [BTC_OTHER], 'historia adresu z etykietą nie jest pobierana');
  assert.ok(result.limitations.some((item) => /środki trafiły na adres z etykietą, która nie wskazuje usługi wymiany/.test(item)));
});

test('śledzenie kończy się na giełdzie: jej wypłaty nie są dalszym ciągiem ścieżki', async () => {
  const asked: string[] = [];
  const nodes: Record<string, ExpandedNode> = {
    [DEPOSIT]: { outgoing: [move('sweep', '2025-05-10T08:20:00Z', 'out', HOT_WALLET, 1000)] },
    // Giełda wypłaca komuś innemu tę samą kwotę — środki klientów są wymieszane, to nie jest ciąg dalszy.
    [HOT_WALLET]: { outgoing: [move('payout', '2025-05-10T09:00:00Z', 'out', WALLET_B, 1000)] },
  };
  const result = await traceAccountFlows({
    network: 'ethereum',
    address: WALLET_A,
    transfers: [move('dep', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000), move('direct', '2025-05-12T08:00:00Z', 'out', HOT_WALLET, 300)],
    labels,
    sourceName: 'źródło testowe',
    budget: new RequestBudget(15),
    expand: async (address) => {
      asked.push(address);
      return nodes[address] ?? { outgoing: [] };
    },
  });
  assert.deepEqual(asked, [DEPOSIT]);
  assert.equal(result.trails.length, 1);
  const trail = result.trails[0]!;
  assert.equal(trail.hops.at(-1)!.to, HOT_WALLET);
  assert.ok(!trail.hops.some((hop) => hop.to === WALLET_B));
  // Krok przez adres pośredni jest wnioskowaniem i ścieżka nie dostaje pewności przelewu bezpośredniego.
  assert.deepEqual(trail.hops.map((hop) => hop.inferred ?? false), [false, true]);
  assert.ok(trail.confidence <= 90);
  assert.match(trail.reasons[0]!, /^WNIOSKOWANIE: środki dotarły do usługi „Kraken: portfel giełdy”.*etykieta usługi: zbiór testowy\.$/);
});

// ---------- Etykiety ze źródłem, wskaźniki bez zgadywania ----------

test('każda etykieta kontrahenta niesie źródło, a etykieta z wnioskowania jest tak oznaczona', async () => {
  const deposit: InferredDeposit = {
    txid: 'dep',
    counterparty: DEPOSIT,
    asset: 'USDT',
    exchangeAddress: HOT_WALLET,
    exchangeLabel: 'Kraken: portfel giełdy',
    exchangeLabelSource: 'zbiór testowy',
    hoursToForward: 0.3,
    forwardedAmount: 1000,
    forwardedShare: 1,
    forwardTxid: 'sweep',
  };
  const activity = await buildChainActivity(
    {
      network: 'ethereum',
      address: WALLET_A,
      sourceName: 'źródło testowe',
      inferredDeposits: [deposit],
      transfers: [
        move('direct', '2025-05-12T08:00:00Z', 'out', HOT_WALLET, 300),
        move('dep', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000),
        move('tag', '2025-05-13T08:00:00Z', 'out', A('5'), 50, { counterpartyLabel: 'Binance 14', counterpartyLabelSource: 'Blockscout' }),
        move('plain', '2025-05-14T08:00:00Z', 'out', A('6'), 20),
      ],
      limitations: [],
    },
    { labels, rateSource: rates, sanctions: noSanctions },
  );
  const byTx = new Map((activity.transfers as ClassifiedTransfer[]).map((item) => [item.txid, item]));
  assert.equal(byTx.get('direct')!.counterpartyLabelSource, 'zbiór testowy');
  assert.equal(byTx.get('direct')!.counterpartyLabelInferred, undefined);
  assert.equal(byTx.get('tag')!.counterpartyLabelSource, 'Blockscout (klasa rozpoznana po nazwie w etykiecie)');
  assert.match(byTx.get('dep')!.counterpartyLabel ?? '', /^Prawdopodobny adres wpłat giełdy „Kraken: portfel giełdy” \(wnioskowanie\)$/);
  assert.equal(byTx.get('dep')!.counterpartyLabelInferred, true);
  assert.match(byTx.get('dep')!.counterpartyLabelSource ?? '', /^wnioskowanie narzędzia \(reguła adresu wpłat giełdy; etykieta giełdy: zbiór testowy\)$/);
  // Adres pośredni z wnioskowania nie dostaje klasy „giełda” — klasa pozostaje nieznana.
  assert.equal(byTx.get('dep')!.counterpartyClass, 'unknown');
  // Bez etykiety nie ma też źródła etykiety — niczego nie dopisujemy.
  assert.deepEqual([byTx.get('plain')!.counterpartyLabel, byTx.get('plain')!.counterpartyLabelSource], [undefined, undefined]);
  // Każda ścieżka podaje źródło etykiety usługi.
  assert.ok((activity.trails ?? []).length > 0);
  for (const trail of activity.trails ?? []) assert.match(trail.reasons[0]!, /etykieta: (zbiór testowy|Blockscout)/);
});

test('wskaźnik wypłaty: brak kursu to brak kwoty PLN (nie zero), a opis nie twierdzi, że doszło do wypłaty na rachunek', async () => {
  const activity = await buildChainActivity(
    {
      network: 'ethereum',
      address: WALLET_A,
      sourceName: 'źródło testowe',
      transfers: [
        // Kurs USDT jest tylko dla maja 2025 — przelew z lipca nie ma wyceny.
        move('valued', '2025-05-12T08:00:00Z', 'out', HOT_WALLET, 300),
        move('unvalued', '2025-07-12T08:00:00Z', 'out', HOT_WALLET, 500),
        move('incoming', '2025-07-13T08:00:00Z', 'in', HOT_WALLET, 900),
      ],
      limitations: [],
    },
    { labels, rateSource: rates, sanctions: noSanctions },
  );
  assert.deepEqual(activity.cashOuts.map((item) => [item.txid, item.kind, item.amount, item.valuePln]), [
    ['valued', 'exchange_deposit', 300, 1200],
    ['unvalued', 'exchange_deposit', 500, undefined],
  ]);
  assert.ok(!('valuePln' in activity.cashOuts[1]!), 'brak kursu nie może dać pola z zerem');
  assert.deepEqual(activity.cashOutPlnByYear, { '2025': 1200 });
  assert.ok(activity.limitations.some((item) => /Dla 1 wskaźników wypłaty brak kursu — nie są ujęte w sumach PLN/.test(item)));
  // Przelew przychodzący z giełdy to źródło środków, nie wypłata.
  assert.ok(!activity.cashOuts.some((item) => item.txid === 'incoming'));
  for (const item of activity.cashOuts) assert.ok(item.explanation.endsWith(CASHOUT_CAVEAT));
  assert.match(CASHOUT_CAVEAT, /może potwierdzić wyłącznie usługa/);
});

test('Tron: transfer TRC-20 bez podanej liczby miejsc po przecinku nie dostaje zgadywanej kwoty ani wyceny', async () => {
  const GRID = 'https://api.trongrid.io';
  const SUBJECT = 'TSubjectAddress00000000000000000000';
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const tronLabels = createLabelSet(
    [
      { network: 'tron', address: USDT, label: 'Tether: kontrakt tokena USDT', addressClass: 'smart_contract', asset: 'USDT' },
      { network: 'tron', address: 'TExchangeHot0000000000000000000000', label: 'Binance: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
    ],
    'zbiór testowy',
  );
  const mock = mockFetch({
    [`${GRID}/v1/accounts/${SUBJECT}`]: { data: [{ balance: 0 }], success: true },
    [`${GRID}/v1/accounts/${SUBJECT}/transactions?limit=50&only_confirmed=true`]: { data: [], meta: {} },
    [`${GRID}/v1/accounts/${SUBJECT}/transactions/trc20?limit=50&only_confirmed=true`]: {
      data: [
        { transaction_id: 'ok', block_timestamp: Date.parse('2025-05-10T08:00:00Z'), from: SUBJECT, to: 'TExchangeHot0000000000000000000000', value: '250000000', token_info: { symbol: 'USDT', address: USDT, decimals: 6 } },
        { transaction_id: 'nodecimals', block_timestamp: Date.parse('2025-05-11T08:00:00Z'), from: SUBJECT, to: 'TExchangeHot0000000000000000000000', value: '250000000', token_info: { symbol: 'USDT', address: USDT } },
      ],
      meta: {},
    },
  });
  const provider = new TronGridProvider({ fetch: mock.fetch, rateSource: rates, labels: tronLabels, sanctions: noSanctions });
  const activity = await provider.getActivity('tron', SUBJECT, testContext());
  const [ok, broken] = activity.transfers;
  assert.deepEqual([ok?.asset, ok?.amount], ['USDT', 250]);
  assert.match(broken?.asset ?? '', /^USDT \(niezweryfikowany — źródło nie podało liczby miejsc po przecinku; kwota w jednostkach bazowych\)$/);
  // Wycenę dostaje tylko przelew o znanej kwocie; drugi nie udaje 250 mln USDT.
  assert.deepEqual(activity.cashOuts.map((item) => [item.txid, item.valuePln]), [['ok', 1000], ['nodecimals', undefined]]);
  assert.deepEqual(activity.trails?.map((trail) => trail.hops[0]!.txid), ['ok']);
});
