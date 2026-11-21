// Powiązane adresy — kandydaci na inne adresy tej samej osoby. Bez internetu.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressCluster } from '@olcys/core';
import type { RawTransfer } from '../src/activity.ts';
import type { InferredDeposit } from '../src/deposit.ts';
import { RequestBudget } from '../src/http.ts';
import { createChainProviders } from '../src/index.ts';
import { createLabelSet } from '../src/labels.ts';
import { LINK_STRENGTH, findLinkedAddresses } from '../src/links.ts';
import type { IncomingNode, LinkSearch } from '../src/links.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const A = (letter: string) => `0x${letter.repeat(40)}`;
const SUBJECT = A('1');
const DEPOSIT = A('d');
const EXCHANGE = A('e');
const labels = createLabelSet([{ network: 'ethereum', address: EXCHANGE, label: 'Kraken: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' }], 'zbiór testowy');

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
const deposit: InferredDeposit = {
  txid: 'dep1',
  counterparty: DEPOSIT,
  asset: 'USDT',
  exchangeAddress: EXCHANGE,
  exchangeLabel: 'Kraken: portfel giełdy',
  exchangeLabelSource: 'zbiór testowy',
  hoursToForward: 0.2,
  forwardedAmount: 1000,
  forwardedShare: 1,
  forwardTxid: 'sweep1',
};

function search(extra: Partial<LinkSearch> & { nodes?: Record<string, IncomingNode>; counts?: Record<string, number> }) {
  const asked: string[] = [];
  const counted: string[] = [];
  const budget = new RequestBudget(12);
  const { nodes = {}, counts = {}, ...rest } = extra;
  const input: LinkSearch = {
    network: 'ethereum',
    address: SUBJECT,
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
    countTransactions: async (address) => {
      counted.push(address);
      return counts[address] ?? 5;
    },
    ...rest,
  };
  return { input, asked, counted, budget };
}

test('co_depositor: inni nadawcy wpłat na ten sam indywidualny adres wpłat giełdy', async () => {
  const { input, asked } = search({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    nodes: {
      [DEPOSIT]: {
        incoming: [
          move('dep1', '2025-05-10T08:00:00Z', 'in', SUBJECT, 1000),
          move('j1', '2025-03-01T10:00:00Z', 'in', A('a'), 400),
          move('j2', '2025-06-01T10:00:00Z', 'in', A('a'), 600),
          move('k1', '2025-04-01T10:00:00Z', 'in', A('b'), 50),
          // Wypłata z innej giełdy i wpłata z kontraktu nie wskazują osoby.
          move('x1', '2025-04-02T10:00:00Z', 'in', EXCHANGE, 900),
          move('c1', '2025-04-03T10:00:00Z', 'in', A('c'), 10, { counterpartyIsContract: true }),
          // Wpłata sprzed okna czasu.
          move('old', '2021-01-01T10:00:00Z', 'in', A('9'), 5),
        ],
      },
    },
  });
  const result = await findLinkedAddresses(input);
  const co = result.links.filter((link) => link.kind === 'co_depositor');
  assert.deepEqual(co.map((link) => [link.address, link.strength, link.txids, link.amount, link.asset]), [
    [A('a'), LINK_STRENGTH.coDepositor, ['j1', 'j2'], 1000, 'USDT'],
    [A('b'), LINK_STRENGTH.coDepositor, ['k1'], 50, 'USDT'],
  ]);
  assert.equal(co[0]?.firstSeen, '2025-03-01T10:00:00Z');
  assert.equal(co[0]?.lastSeen, '2025-06-01T10:00:00Z');
  assert.match(co[0]?.reason ?? '', /^HEURYSTYKA „współwpłacający”: adres wpłacił 2 raz\(y\) na 0xdddddd…dddddd — ten sam prawdopodobny indywidualny adres wpłat w giełdzie „Kraken: portfel giełdy”/);
  assert.match(co[0]?.reason ?? '', /najpewniej ta sama osoba ALBO ktoś wpłacający na jej konto/);
  assert.match(co[0]?.reason ?? '', /Rozstrzyga giełda/);
  assert.deepEqual(asked, [DEPOSIT]);
  assert.ok(result.limitations.some((item) => /adres wpłat 0xd+ \(„Kraken: portfel giełdy”\) — 6 różnych nadawców w pobranej historii; współwpłacających: 2; pominięto 2 nadawców będących usługami lub kontraktami i 1 spoza okna 730 dni\./.test(item)));
  assert.ok(result.limitations.some((item) => /to HEURYSTYKI wskazujące kandydatów na inne adresy tej samej osoby — nie ustalenie tożsamości/.test(item)));

  // Krótsze okno odcina dalsze wpłaty.
  const few = search({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    options: { coDepositWindowDays: 30 },
    nodes: { [DEPOSIT]: { incoming: [move('dep1', '2025-05-10T08:00:00Z', 'in', SUBJECT, 1000), move('j1', '2025-03-01T10:00:00Z', 'in', A('a'), 400), move('j2', '2025-06-01T10:00:00Z', 'in', A('a'), 600)] } },
  });
  const narrow = (await findLinkedAddresses(few.input)).links;
  assert.deepEqual(narrow.map((link) => [link.strength, link.txids]), [[LINK_STRENGTH.coDepositor, ['j2']]]);
});

test('wyjątek: adres wpłat pośrednika (wielu nadawców lub bardzo wiele transakcji) nie tworzy powiązań', async () => {
  const many = Array.from({ length: 14 }, (_, index) => move(`m${index}`, '2025-05-01T10:00:00Z', 'in', `0x${index.toString(16).padStart(2, '0').repeat(20)}`, 100));
  const crowd = search({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    nodes: { [DEPOSIT]: { incoming: many, more: true } },
    counts: { [DEPOSIT]: 380 },
  });
  const rejected = await findLinkedAddresses(crowd.input);
  assert.deepEqual(rejected.links, []);
  assert.ok(
    rejected.limitations.some((item) =>
      /adres 0xd+ \(środki przekazywane do „Kraken: portfel giełdy”\) ma 14\+ różnych nadawców i 380 transakcji — to raczej adres pośrednika \(kantor, bramka, serwis przyjmujący wpłaty wielu osób\).*Nie utworzono powiązań „współwpłacający”\./.test(item),
    ),
  );

  // Niewielu nadawców na stronie, ale tysiące transakcji — też usługa.
  const busy = search({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    nodes: { [DEPOSIT]: { incoming: [move('j1', '2025-05-01T10:00:00Z', 'in', A('a'), 400)], txCount: 50_000 } },
  });
  assert.deepEqual((await findLinkedAddresses(busy.input)).links, []);
  // Próg jest konfigurowalny.
  const lenient = search({
    transfers: [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000)],
    deposits: [deposit],
    options: { maxDepositSenders: 20, maxCoDepositors: 3 },
    nodes: { [DEPOSIT]: { incoming: many } },
  });
  const capped = await findLinkedAddresses(lenient.input);
  assert.equal(capped.links.length, 3);
  assert.equal(capped.links[0]?.strength, LINK_STRENGTH.coDepositorManySenders, 'wielu nadawców (poniżej progu pośrednika) obniża siłę');
  assert.ok(capped.limitations.some((item) => /współwpłacających: 3 z 14 \(limit\)/.test(item)));
});

test('same_wallet: adresy klastra z siłą zależną od heurystyki', async () => {
  const cluster: AddressCluster = {
    seed: 'bc1qseed',
    network: 'bitcoin',
    method: [],
    addresses: [
      { address: 'bc1qcommon', txid: 'co', reason: 'heurystyka wspólnych wejść: środki tego adresu wydano razem ze środkami adresu podmiotu w transakcji co' },
      { address: 'bc1qchange1', txid: 'p1', reason: 'heurystyka adresu reszty w transakcji p1: typ skryptu zgodny z wejściem (v0_p2wpkh), drugie wyjście ma inny typ' },
      { address: 'bc1qchange2', txid: 'p2', reason: 'heurystyka adresu reszty w transakcji p2: typ skryptu zgodny z wejściem (v0_p2wpkh), drugie wyjście ma inny typ; kwota „nieokrągła”, podczas gdy drugie wyjście ma kwotę okrągłą' },
      { address: 'bc1qbusy', txid: 'co2', reason: 'heurystyka wspólnych wejść: … w transakcji co2 — UWAGA: adres ma bardzo dużą aktywność, więc może należeć do usługi' },
    ],
  };
  const { input, budget } = search({ network: 'bitcoin', address: 'bc1qseed', cluster });
  const result = await findLinkedAddresses(input);
  assert.deepEqual(result.links.map((link) => [link.address, link.kind, link.strength, link.txids]), [
    ['bc1qcommon', 'same_wallet', 75, ['co']],
    ['bc1qchange2', 'same_wallet', 65, ['p2']],
    ['bc1qchange1', 'same_wallet', 55, ['p1']],
    ['bc1qbusy', 'same_wallet', 25, ['co2']],
  ]);
  assert.match(result.links[0]?.reason ?? '', /^HEURYSTYKA „ten sam portfel”: heurystyka wspólnych wejść/);
  assert.equal(budget.used, 0, 'klaster nie wymaga dodatkowych żądań');
});

test('funded_by i funds: pierwsze zasilenie między adresami prywatnymi; usługi i aktywne adresy pominięte', async () => {
  const transfers = [
    move('f1', '2025-01-05T10:00:00Z', 'in', A('a'), 0.5, { asset: 'ETH' }),
    move('f2', '2025-02-05T10:00:00Z', 'out', A('a'), 0.1, { asset: 'ETH' }),
    move('g1', '2025-03-01T10:00:00Z', 'out', A('b'), 2, { asset: 'ETH' }),
    move('g2', '2025-03-02T10:00:00Z', 'out', A('c'), 1, { asset: 'ETH' }),
    move('x1', '2025-03-03T10:00:00Z', 'out', EXCHANGE, 5, { asset: 'ETH' }),
  ];
  const { input, asked } = search({
    transfers,
    nodes: {
      // Adres „b”: pierwszą wpłatą był przelew od podmiotu.
      [A('b')]: { incoming: [move('later', '2025-04-01T10:00:00Z', 'in', A('7'), 1, { asset: 'ETH' }), move('g1', '2025-03-01T10:00:00Z', 'in', SUBJECT, 2, { asset: 'ETH' })] },
      // Adres „c” istniał wcześniej — przelew podmiotu nie był pierwszym zasileniem.
      [A('c')]: { incoming: [move('g2', '2025-03-02T10:00:00Z', 'in', SUBJECT, 1, { asset: 'ETH' }), move('early', '2024-01-01T10:00:00Z', 'in', A('8'), 3, { asset: 'ETH' })] },
    },
  });
  const result = await findLinkedAddresses(input);
  assert.deepEqual(result.links.map((link) => [link.kind, link.address, link.strength, link.txids]), [
    ['funded_by', A('a'), LINK_STRENGTH.fundingBothWays, ['f1', 'f2']],
    ['funds', A('b'), LINK_STRENGTH.funding, ['g1']],
  ]);
  assert.match(result.links[0]?.reason ?? '', /^HEURYSTYKA „źródło środków”: pierwsza wpłata na adres podmiotu \(0\.5 ETH, 2025-01-05, tx f1\)/);
  assert.match(result.links[1]?.reason ?? '', /^HEURYSTYKA „zasilony adres”: pierwszą wpłatą na ten adres był przelew z adresu podmiotu/);
  assert.deepEqual(asked.sort(), [A('a'), A('b'), A('c')].filter((item) => item !== A('a')).sort(), 'giełda nie jest sprawdzana');

  // Adres zasilający o dużej aktywności to nie osoba prywatna.
  const busy = search({ transfers, counts: { [A('a')]: 9000 } });
  assert.ok(!(await findLinkedAddresses(busy.input)).links.some((link) => link.kind === 'funded_by'));
  // Pierwsza wpłata z giełdy: brak powiązania (wypłata giełdy nie mówi nic o osobie).
  const fromExchange = search({ transfers: [move('w1', '2025-01-01T10:00:00Z', 'in', EXCHANGE, 1, { asset: 'ETH' }), ...transfers] });
  assert.ok(!(await findLinkedAddresses(fromExchange.input)).links.some((link) => link.kind === 'funded_by'));
  // Niepełna historia: nie wolno mówić o „pierwszej wpłacie”.
  const partial = await findLinkedAddresses(search({ transfers, historyComplete: false }).input);
  assert.ok(!partial.links.some((link) => link.kind === 'funded_by'));
  assert.ok(partial.limitations.some((item) => /nie ustalano źródła pierwszego zasilenia adresu — historia adresu nie jest pełna/.test(item)));
});

test('repeated_counterparty: prywatny kontrahent z przelewami w obie strony przez dłuższy czas', async () => {
  const steady = [
    move('r1', '2025-01-10T10:00:00Z', 'out', A('a'), 100),
    move('r2', '2025-02-10T10:00:00Z', 'in', A('a'), 80),
    move('r3', '2025-04-10T10:00:00Z', 'out', A('a'), 50),
    move('r4', '2025-06-10T10:00:00Z', 'in', A('a'), 20),
    move('r5', '2025-07-10T10:00:00Z', 'out', A('a'), 10),
    // Trzy przelewy w jedną stronę — to nie jest wymiana w obie strony.
    move('o1', '2025-01-10T10:00:00Z', 'out', A('b'), 1),
    move('o2', '2025-03-10T10:00:00Z', 'out', A('b'), 1),
    move('o3', '2025-05-10T10:00:00Z', 'out', A('b'), 1),
    // W obie strony, ale w ciągu tygodnia.
    move('s1', '2025-01-10T10:00:00Z', 'out', A('c'), 1),
    move('s2', '2025-01-12T10:00:00Z', 'in', A('c'), 1),
    move('s3', '2025-01-15T10:00:00Z', 'out', A('c'), 1),
    // Pierwsza wpłata z giełdy, żeby nie powstało powiązanie „źródło środków”.
    move('w0', '2024-12-01T10:00:00Z', 'in', EXCHANGE, 500),
  ];
  const { input } = search({ transfers: steady, options: { maxFundedChecks: 0 } });
  const result = await findLinkedAddresses(input);
  assert.deepEqual(result.links.map((link) => [link.kind, link.address, link.strength]), [['repeated_counterparty', A('a'), 38]]);
  assert.match(result.links[0]?.reason ?? '', /^HEURYSTYKA „stały kontrahent”: łącznie 5 przelew\(y\) między adresami \(2 przychodzących, 3 wychodzących\) w ciągu 181 dni/);
  assert.match(result.links[0]?.reason ?? '', /drugi portfel tej samej osoby, ale też osoba bliska, wspólnik albo stały kontrahent/);
  assert.equal(result.links[0]?.amount, 260);

  // Siła rośnie z liczbą przelewów, ale nie przekracza 50.
  const lots = Array.from({ length: 20 }, (_, index) => move(`n${index}`, new Date(Date.UTC(2025, 0, 1 + index * 10)).toISOString(), index % 2 ? 'in' : 'out', A('a'), 1));
  const strong = await findLinkedAddresses(search({ transfers: [steady.at(-1)!, ...lots], options: { maxFundedChecks: 0 } }).input);
  assert.equal(strong.links[0]?.strength, LINK_STRENGTH.repeatedMax);
});

test('budżet powiązań jest osobny i jego wyczerpanie jest odnotowane; opcja wyłącza szukanie', async () => {
  const transfers = [move('dep1', '2025-05-10T08:00:00Z', 'out', DEPOSIT, 1000), move('g1', '2025-03-01T10:00:00Z', 'out', A('b'), 2)];
  const tight = search({ transfers, deposits: [deposit], nodes: { [DEPOSIT]: { incoming: [move('j1', '2025-05-01T10:00:00Z', 'in', A('a'), 400)] } } });
  tight.budget.limit = 1;
  const result = await findLinkedAddresses(tight.input);
  assert.deepEqual(result.links.map((link) => link.kind), ['co_depositor']);
  assert.ok(result.limitations.some((item) => /szukanie przerwano — wyczerpano budżet 1 żądań na szukanie powiązań/.test(item)));

  const off = search({ transfers, deposits: [deposit], options: { enabled: false } });
  assert.deepEqual(await findLinkedAddresses(off.input), { links: [], limitations: [] });
  assert.equal(off.budget.used, 0);
});

test('Blockscout: współwpłacający trafiają do pola `linkedAddresses` wyniku analizy', async () => {
  const BS = 'https://eth.blockscout.com/api/v2/addresses';
  const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null, public_tags: [], private_tags: [] });
  const usdt = A('7');
  const tokenLabels = createLabelSet(
    [
      { network: 'ethereum', address: EXCHANGE, label: 'Kraken: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
      { network: 'ethereum', address: usdt, label: 'Tether: kontrakt tokena USDT', addressClass: 'smart_contract', asset: 'USDT' },
    ],
    'zbiór testowy',
  );
  const tt = (hash: string, timestamp: string, from: string, to: string, amount: number) => ({
    transaction_hash: hash,
    timestamp,
    from: party(from),
    to: party(to),
    token: { symbol: 'USDT', decimals: '6', address_hash: usdt },
    total: { value: String(amount * 1e6), decimals: '6' },
  });
  const mock = mockFetch({
    [`${BS}/${SUBJECT}`]: { ...party(SUBJECT), coin_balance: '0' },
    [`${BS}/${SUBJECT}/transactions`]: { items: [], next_page_params: null },
    [`${BS}/${SUBJECT}/token-transfers?type=ERC-20`]: { items: [tt('0xdep', '2025-05-10T08:00:00.000000Z', SUBJECT, DEPOSIT, 1000)], next_page_params: null },
    [`${BS}/${DEPOSIT}/token-transfers?type=ERC-20&filter=from`]: { items: [tt('0xsweep', '2025-05-10T08:20:00.000000Z', DEPOSIT, EXCHANGE, 1000)], next_page_params: null },
    [`${BS}/${DEPOSIT}/token-transfers?type=ERC-20&filter=to`]: {
      items: [tt('0xdep', '2025-05-10T08:00:00.000000Z', SUBJECT, DEPOSIT, 1000), tt('0xother', '2025-05-12T09:00:00.000000Z', A('a'), DEPOSIT, 250)],
      next_page_params: null,
    },
  });
  const provider = new BlockscoutProvider({
    fetch: mock.fetch,
    rateSource: new StaticRateSource({ source: 'tabela testowa', rates: { USDT: { '2025-05': 4 } } }),
    labels: tokenLabels,
    sanctions: createSanctionsList({ addresses: [] }),
    followDeposits: true,
    findLinks: true,
  });
  const activity = await provider.getActivity('ethereum', SUBJECT, testContext());
  assert.equal(activity.cashOuts.length, 1);
  const links = (activity as { linkedAddresses?: { address: string; kind: string; strength: number; txids: string[]; network: string }[] }).linkedAddresses;
  assert.deepEqual(links?.map((link) => [link.address, link.kind, link.strength, link.txids, link.network]), [[A('a'), 'co_depositor', 80, ['0xother'], 'ethereum']]);
  assert.ok(activity.limitations.some((item) => /adres wpłat 0xd+ .* 2 różnych nadawców/.test(item)));

  // Fabryka: powiązania włączone przy danych na żywo, budżet 12 / 40.
  const budgets = (config: object) => createChainProviders({ enableLive: true, fetch: mock.fetch, ...config }).map((item) => (item as unknown as { linkBudget: number; findLinks: boolean }));
  assert.deepEqual(budgets({}).map((item) => [item.findLinks, item.linkBudget]), Array(4).fill([true, 12]));
  assert.deepEqual(budgets({ depth: 'deep' }).map((item) => item.linkBudget), [40, 40, 40, 40]);
  assert.deepEqual(budgets({ findLinks: false }).map((item) => item.findLinks), [false, false, false, false]);
});

test('adresy-podróbki („address poisoning”) i przelewy zerowe lub w fałszywych tokenach nie tworzą powiązań', async () => {
  const real = `0xae4c${'5'.repeat(32)}ebeb`;
  const fake = `0xae4c${'9'.repeat(32)}ebeb`;
  const transfers = [
    move('w0', '2024-12-01T10:00:00Z', 'in', EXCHANGE, 500),
    move('p1', '2025-01-10T10:00:00Z', 'out', real, 300),
    move('p2', '2025-03-10T10:00:00Z', 'in', real, 100),
    move('p3', '2025-05-10T10:00:00Z', 'out', real, 50),
    // Podróbka: te same końcówki adresu, drobne kwoty tuż po prawdziwych przelewach.
    move('z1', '2025-01-10T10:05:00Z', 'out', fake, 0.01),
    move('z2', '2025-03-10T10:05:00Z', 'in', fake, 0.01),
    move('z3', '2025-05-10T10:05:00Z', 'out', fake, 0.01),
    // Przelew zerowy i fałszywy token do innego adresu.
    move('n1', '2025-02-01T10:00:00Z', 'out', A('b'), 0),
    move('n2', '2025-02-02T10:00:00Z', 'out', A('b'), 1000, { asset: 'USDT (niezweryfikowany token 0xdead…)' }),
  ];
  const { input, asked } = search({ transfers });
  const result = await findLinkedAddresses(input);
  assert.deepEqual(result.links.map((link) => [link.kind, link.address]), [['repeated_counterparty', real]]);
  assert.ok(!asked.includes(A('b')) && !asked.includes(fake));
  assert.ok(result.limitations.some((item) => /pominięto 1 adres\(y\) wyglądające na podróbki prawdziwych kontrahentów .*„address poisoning”/.test(item)));
});
