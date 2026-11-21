// Pełna historia adresu (stronicowanie, zakres dat, zapasowy eksplorator), wybór
// największych wypływów, wiele gałęzi z jednej transakcji i pytania do wyjaśnienia.
// Bez internetu: atrapa `fetch` i wstrzykiwane funkcje.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UtxoTx } from '../src/cluster.ts';
import { planHistory } from '../src/history.ts';
import type { ChainRequestContext } from '../src/history.ts';
import { RequestBudget } from '../src/http.ts';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { createLabelSet } from '../src/labels.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { traceUtxoFlows } from '../src/trace.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const SUBJECT = 'bc1qsubject0000000000000000000000000000';
const EXCHANGE = '1ExchangeHotWallet00000000000000000';
const labels = createLabelSet([{ network: 'bitcoin', address: EXCHANGE, label: 'Zonda: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' }], 'zbiór testowy');
const noSanctions = createSanctionsList({ addresses: [] });
const rates = new StaticRateSource({ source: 'tabela testowa', rates: { BTC: { '2020-07': 36000 }, ETH: { '2025-05': 10000 } } });
const at = (iso: string) => Date.parse(iso) / 1000;
const pad = (name: string) => `bc1q${name}`.padEnd(40, '0');

type In = [address: string, satoshi: number, fromTx?: string, fromIndex?: number];
const utx = (txid: string, time: string, inputs: In[], outputs: [string, number][]): UtxoTx => ({
  txid,
  status: { confirmed: true, block_time: at(time) },
  vin: inputs.map(([address, value, fromTx, fromIndex]) => ({ txid: fromTx ?? `fund-${txid}`, vout: fromIndex ?? 0, prevout: { scriptpubkey_address: address, value, scriptpubkey_type: 'v0_p2wpkh' } })),
  vout: outputs.map(([address, value]) => ({ scriptpubkey_address: address, value, scriptpubkey_type: 'v0_p2wpkh' })),
});

// Adres jak w głośnych sprawach: stare, duże wypływy przykryte późniejszymi drobnymi wpłatami.
// 80 transakcji od najnowszej: 70 drobnych wpłat (2021–2024), potem 4 wypływy i 6 wpłat z lipca 2020 r.
const dust = Array.from({ length: 70 }, (_, index) =>
  utx(`dust${String(index).padStart(2, '0')}`, new Date(Date.UTC(2024, 0, 1) - index * 15 * 86_400_000).toISOString(), [[pad(`fan${index}`), 2000]], [[SUBJECT, 1000]]),
);
const year2020 = [
  utx('out-small', '2020-07-28T18:00:00Z', [[SUBJECT, 300_000]], [[pad('minor'), 290_000]]),
  utx('out-big2', '2020-07-16T12:00:00Z', [[SUBJECT, 200_100_000]], [[pad('hopb'), 200_000_000]]),
  utx('out-big1', '2020-07-15T21:00:00Z', [[SUBJECT, 400_100_000]], [[pad('hopa'), 400_000_000]]),
  utx('out-tiny', '2020-07-15T20:30:00Z', [[SUBJECT, 60_000]], [[pad('tiny'), 50_000]]),
  ...Array.from({ length: 6 }, (_, index) => utx(`in${index}`, `2020-07-15T19:0${index}:00Z`, [[pad(`victim${index}`), 110_000_000]], [[SUBJECT, 100_000_000]])),
];
const history = [...dust, ...year2020];
const API = 'https://blockstream.info/api/address';
const BACKUP = 'https://mempool.space/api/address';

function pagedRoutes(base = API): Record<string, unknown> {
  const routes: Record<string, unknown> = {
    [`${base}/${SUBJECT}`]: { chain_stats: { funded_txo_sum: 600_070_000, spent_txo_sum: 600_560_000, tx_count: history.length } },
    [`${base}/${SUBJECT}/txs`]: history.slice(0, 25),
  };
  for (let start = 25; start < history.length; start += 25) {
    routes[`${base}/${SUBJECT}/txs/chain/${history[start - 1]!.txid}`] = history.slice(start, start + 25);
  }
  return routes;
}

function provider(routes: Record<string, unknown>, extra: object = {}) {
  const mock = mockFetch(routes);
  const esplora = new EsploraProvider({
    id: 'esplora-blockstream',
    label: 'Blockstream Esplora (Bitcoin)',
    siteUrl: 'https://blockstream.info',
    fetch: mock.fetch,
    rateSource: rates,
    labels,
    sanctions: noSanctions,
    ...extra,
  });
  return { mock, esplora };
}
const context = (extra: Partial<ChainRequestContext> = {}): ChainRequestContext => ({ ...testContext(), ...extra });

test('historia `recent` widzi tylko 50 najnowszych transakcji; `full` stronicuje do końca i ustala pierwszą transakcję', async () => {
  const recent = provider(pagedRoutes());
  const shallow = await recent.esplora.getActivity('bitcoin', SUBJECT, context());
  assert.equal(shallow.transfers.length, 50);
  assert.equal(shallow.transfers.filter((item) => item.direction === 'out').length, 0, 'wypływy z 2020 r. są poza 50 najnowszymi');
  assert.equal(shallow.profile.firstSeen, undefined);
  assert.ok(shallow.limitations.some((item) => /Pobrano 50 najnowszych z 80 transakcji .* pełną historię włącza opcja `history: 'full'`/.test(item)));
  assert.equal(recent.mock.calls.length, 3);

  const all = provider(pagedRoutes());
  const deep = await all.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full' }));
  assert.equal(deep.transfers.length, 80);
  assert.deepEqual(deep.transfers.filter((item) => item.direction === 'out').map((item) => item.txid), ['out-tiny', 'out-big1', 'out-big2', 'out-small']);
  assert.equal(deep.profile.firstSeen, '2020-07-15T19:00:00.000Z');
  assert.equal(deep.profile.txCount, 80);
  // Sumy pochodzą z pól zbiorczych API, nie z pobranych stron.
  assert.equal(deep.profile.totalReceived, 6.0007);
  assert.equal(deep.profile.totalSent, 6.0056);
  assert.ok(deep.limitations.some((item) => /^Tryb pełnej historii: pobrano 80 z 80 transakcji adresu w 4 żądaniach \(cała historia\)\.$/.test(item)));
  assert.equal(all.mock.calls.length, 5, 'statystyki + 4 strony po 25');
});

test('pełna historia z limitem żądań: stronicowanie przerwane jest opisane, a budżet historii jest osobny od budżetu śledzenia', async () => {
  const { esplora, mock } = provider(pagedRoutes(), { requestBudget: 2 });
  const activity = await esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full', maxHistoryRequests: 2 }));
  assert.equal(activity.transfers.length, 75);
  assert.equal(activity.profile.firstSeen, undefined, 'bez całej historii nie podajemy daty pierwszej transakcji');
  assert.ok(activity.limitations.some((item) => /pobrano 75 z 80 transakcji adresu w 3 żądaniach — stronicowanie przerwano: limit 2 żądań o kolejne strony historii/.test(item)));
  assert.equal(mock.calls.length, 4);

  // Ustawienie domyślne dostawcy działa tak samo jak pole kontekstu; kontekst ma pierwszeństwo.
  const byDefault = provider(pagedRoutes(), { history: { history: 'full', maxHistoryRequests: 1 } });
  assert.equal((await byDefault.esplora.getActivity('bitcoin', SUBJECT, context())).transfers.length, 50);
  assert.equal((await byDefault.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'recent' }))).transfers.length, 50);
  assert.equal((await byDefault.esplora.getActivity('bitcoin', SUBJECT, context({ maxHistoryRequests: 5 }))).transfers.length, 80);
});

test('zakres dat: `since` kończy stronicowanie po wyjściu poza okres, `until` pomija nowsze transakcje', async () => {
  const sinceRun = provider(pagedRoutes());
  const recentYears = await sinceRun.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full', since: '2023-06-01' }));
  // Transakcje co 15 dni wstecz od 2024-01-01: w okresie mieści się 15, a druga strona nie jest już pobierana.
  assert.equal(recentYears.transfers.length, 15);
  assert.equal(sinceRun.mock.calls.length, 2);
  assert.ok(recentYears.limitations.some((item) => /stronicowanie przerwano: dalsze transakcje są starsze niż początek analizowanego okresu \(od 2023-06-01\)/.test(item)));
  assert.ok(recentYears.limitations.some((item) => /^Analiza ograniczona do okresu od 2023-06-01: uwzględniono 15 z 25 pobranych transakcji\.$/.test(item)));

  const window = provider(pagedRoutes());
  const july = await window.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full', since: '2020-07-01T00:00:00Z', until: '2020-07-20T00:00:00Z' }));
  assert.deepEqual(july.transfers.map((item) => item.txid), ['in0', 'in1', 'in2', 'in3', 'in4', 'in5', 'out-tiny', 'out-big1', 'out-big2']);
  assert.ok(july.limitations.some((item) => /okresu od 2020-07-01 do 2020-07-20: uwzględniono 9 z 80/.test(item)));
  assert.equal(july.profile.firstSeen, undefined, 'przy zawężonym okresie data pierwszej transakcji nie jest znana');

  assert.throws(() => planHistory(context({ since: 'wczoraj' })), /Nieprawidłowa data w polu „since”/);
  assert.equal(planHistory(context(), { history: 'full' }).mode, 'full');
  assert.equal(planHistory(context()).mode, 'recent');
});

test('błąd strony historii: kontynuacja z zapasowego eksploratora; bez zapasu — częściowa historia z opisem', async () => {
  const routes = pagedRoutes();
  const second = `${API}/${SUBJECT}/txs/chain/${history[24]!.txid}`;
  routes[second] = { status: 502 };
  // Zapasowy eksplorator ma to samo API i odpowiada od tego samego miejsca.
  routes[second.replace(API, BACKUP)] = history.slice(25, 50);
  const withBackup = provider(routes, { fallbackSiteUrl: 'https://mempool.space' });
  const activity = await withBackup.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full' }));
  assert.equal(activity.transfers.length, 80);
  assert.ok(activity.limitations.some((item) => /\(cała historia\)\. Część stron pobrano z zapasowego eksploratora https:\/\/mempool\.space\./.test(item)));

  const alone = provider(routes);
  const partial = await alone.esplora.getActivity('bitcoin', SUBJECT, context({ history: 'full' }));
  assert.equal(partial.transfers.length, 25);
  assert.ok(partial.limitations.some((item) => /stronicowanie przerwano: błąd przy pobieraniu kolejnej strony historii po \d+ próbach — .*HTTP 502/.test(item)));
});

test('do śledzenia trafiają największe wypływy, nie najnowsze; pokrycie wartości jest opisane', async () => {
  const asked: string[] = [];
  const result = await traceUtxoFlows({
    network: 'bitcoin',
    address: SUBJECT,
    txs: history,
    labels,
    sourceName: 'źródło testowe',
    budget: new RequestBudget(20),
    options: { maxCandidates: 2 },
    txUrl: (txid) => `https://example.test/tx/${txid}`,
    fetchTxs: async (address) => {
      asked.push(address);
      return [];
    },
    fetchTxCount: async () => 1,
  });
  // Najnowszy wypływ („out-small”) i najmniejszy nie są badane — badane są dwa największe.
  assert.deepEqual(asked, [pad('hopa'), pad('hopb')]);
  const coverage = result.limitations.find((item) => item.startsWith('Wypływy z adresu'));
  assert.match(coverage ?? '', /4 transakcji wychodzących na łącznie 6\.0034 BTC do obcych adresów \(przy 76 transakcjach przychodzących\)\. Do śledzenia wybrano 2 największych wartościowo — 100% wartości wypływów\./);
  assert.ok(result.limitations.some((item) => /sprawdzono dla 2 z 4 transakcji wychodzących \(największe kwoty\)/.test(item)));
});

test('wiele gałęzi z jednej transakcji wypływu; adres o dużej aktywności kończy gałąź z pytaniem, dokąd trafiły środki', async () => {
  const spend = utx('split', '2020-07-15T21:00:00Z', [[SUBJECT, 1_000_100_000]], [
    [pad('service'), 730_000_000],
    [pad('deposit'), 200_000_000],
    [pad('idle'), 60_000_000],
    [pad('crumb'), 10_000_000],
  ]);
  const busyPage = Array.from({ length: 25 }, (_, index) => utx(`svc${index}`, '2020-07-16T10:00:00Z', [[pad('service'), 1_000_000, index === 0 ? 'split' : `x${index}`, 0]], [[pad(`cust${index}`), 990_000]]));
  const sweep = utx('sweep', '2020-07-15T23:00:00Z', [[pad('deposit'), 200_000_000, 'split', 1]], [[EXCHANGE, 199_990_000]]);
  const asked: string[] = [];
  const result = await traceUtxoFlows({
    network: 'bitcoin',
    address: SUBJECT,
    txs: [spend],
    labels,
    sourceName: 'źródło testowe',
    budget: new RequestBudget(20),
    txUrl: (txid) => `https://example.test/tx/${txid}`,
    fetchTxs: async (address) => {
      asked.push(address);
      return { [pad('service')]: busyPage, [pad('deposit')]: [sweep, spend] }[address] ?? [];
    },
    fetchTxCount: async () => 4100,
  });

  // Trzy istotne wyjścia to trzy gałęzie; czwarte (1% wartości) jest poniżej progu istotności.
  assert.deepEqual(asked, [pad('service'), pad('deposit'), pad('idle')]);
  assert.equal(result.trails.length, 1);
  assert.deepEqual(result.trails[0]?.hops.map((hop) => [hop.to, hop.amount]), [[pad('deposit'), 2], [EXCHANGE, 1.9999]]);
  assert.equal(result.openQuestions.length, 1);
  assert.equal(result.openQuestions[0]?.txid, 'split');
  assert.match(
    result.openQuestions[0]?.text ?? '',
    /^73% wartości wypływu split \(2020-07-15; 7\.3 BTC\) trafiło na adres bc1qservice0+ o 4100 transakcjach — prawdopodobnie usługa bez publicznej etykiety \(giełda, kantor, mikser\)\./,
  );
  assert.ok(result.limitations.some((item) => /adres pośredni o dużej aktywności \(4100 transakcji, próg 200\)/.test(item)));

  // Limit gałęzi: przy jednej gałęzi badane jest tylko największe wyjście... i zawsze drugie co do wielkości.
  const narrow: string[] = [];
  await traceUtxoFlows({
    network: 'bitcoin', address: SUBJECT, txs: [spend], labels, sourceName: 'źródło testowe', budget: new RequestBudget(20), options: { maxBranches: 2 },
    txUrl: (txid) => txid,
    fetchTxs: async (address) => { narrow.push(address); return []; },
    fetchTxCount: async () => 1,
  });
  assert.deepEqual(narrow, [pad('service'), pad('deposit')]);
});

test('pytania do wyjaśnienia trafiają do ścieżki z tej samej transakcji, do wyniku i do ograniczeń; budżet śledzenia per adres', async () => {
  const spend = utx('split', '2020-07-15T21:00:00Z', [[SUBJECT, 1_000_100_000]], [[pad('service'), 730_000_000], [pad('deposit'), 270_000_000]]);
  const busyPage = Array.from({ length: 25 }, (_, index) => utx(`svc${index}`, '2020-07-16T10:00:00Z', [[pad('service'), 1_000_000, index === 0 ? 'split' : `x${index}`, 0]], [[pad(`cust${index}`), 990_000]]));
  const sweep = utx('sweep', '2020-07-15T23:00:00Z', [[pad('deposit'), 270_000_000, 'split', 1]], [[EXCHANGE, 269_990_000]]);
  const routes = {
    [`${API}/${SUBJECT}`]: { chain_stats: { funded_txo_sum: 1_000_100_000, spent_txo_sum: 1_000_100_000, tx_count: 1 } },
    [`${API}/${SUBJECT}/txs`]: [spend],
    [`${API}/${pad('service')}/txs`]: busyPage,
    [`${API}/${pad('service')}`]: { chain_stats: { funded_txo_sum: 1, spent_txo_sum: 1, tx_count: 4100 } },
    [`${API}/${pad('deposit')}/txs`]: [sweep, spend],
  };
  const { esplora } = provider(routes, { followDeposits: true });
  const activity = await esplora.getActivity('bitcoin', SUBJECT, context());
  const question = /^73% wartości wypływu split .* trafiło na adres bc1qservice0+ o 4100 transakcjach/;
  assert.equal(activity.trails?.length, 1);
  assert.match(activity.trails?.[0]?.openQuestions.at(-1) ?? '', question);
  assert.match((activity as { openQuestions?: string[] }).openQuestions?.[0] ?? '', question);
  assert.ok(activity.limitations.some((item) => /^Do wyjaśnienia: 73% wartości wypływu split/.test(item)));

  // Budżet z kontekstu (per adres) zastępuje budżet dostawcy: przy 2 żądaniach nie starcza na śledzenie.
  const tight = provider(routes, { followDeposits: true });
  const limited = await tight.esplora.getActivity('bitcoin', SUBJECT, context({ requestBudget: 2 }));
  assert.equal(limited.trails, undefined);
  assert.ok(limited.limitations.some((item) => /przerwano: wyczerpano budżet 2 żądań na jedną analizę adresu/.test(item)));
});

test('Ethereum: pełna historia stronicuje obie listy Blockscout do limitu żądań', async () => {
  const subject = `0x${'1'.repeat(40)}`;
  const other = `0x${'2'.repeat(40)}`;
  const BS = `https://eth.blockscout.com/api/v2/addresses/${subject}`;
  const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null });
  const tx = (index: number) => ({
    hash: `0xt${index}`,
    timestamp: new Date(Date.UTC(2025, 4, 30) - index * 3_600_000).toISOString(),
    from: party(subject),
    to: party(other),
    value: '1000000000000000000',
    status: 'ok',
  });
  const page = (from: number, next: object | null) => ({ items: Array.from({ length: 50 }, (_, index) => tx(from + index)), next_page_params: next });
  const routes = {
    [BS]: { ...party(subject), coin_balance: '0' },
    [`${BS}/transactions`]: page(0, { block_number: 100, index: 7, items_count: 50 }),
    [`${BS}/transactions?block_number=100&index=7&items_count=50`]: page(50, { block_number: 90, index: 1, items_count: 50 }),
    [`${BS}/transactions?block_number=90&index=1&items_count=50`]: { items: [tx(100), tx(101)], next_page_params: null },
    [`${BS}/token-transfers?type=ERC-20`]: { items: [], next_page_params: null },
  };
  const run = async (extra: Partial<ChainRequestContext>) => {
    const mock = mockFetch(routes);
    const blockscout = new BlockscoutProvider({ fetch: mock.fetch, rateSource: rates, labels, sanctions: noSanctions });
    return { activity: await blockscout.getActivity('ethereum', subject, context(extra)), calls: mock.calls.length };
  };
  const recent = await run({});
  assert.equal(recent.activity.transfers.length, 50);
  assert.equal(recent.calls, 3);

  const full = await run({ history: 'full' });
  assert.equal(full.activity.transfers.length, 102);
  assert.equal(full.calls, 5);
  assert.ok(full.activity.profile.firstSeen);
  assert.ok(full.activity.limitations.some((item) => /^Tryb pełnej historii: pobrano 102 transakcji i 0 transferów tokenów \(2 dodatkowych żądań\)\.$/.test(item)));

  const capped = await run({ history: 'full', maxHistoryRequests: 1 });
  assert.equal(capped.activity.transfers.length, 100);
  assert.ok(capped.activity.limitations.some((item) => /stronicowanie przerwano \(transakcje: limit 1 żądań o kolejne strony historii\)/.test(item)));
});

test('getActivityFromProviders przekazuje zakres historii z kontekstu; tryb głęboki daje 60 żądań historii i 10 wypływów', async () => {
  const mock = mockFetch(pagedRoutes());
  const providers = createChainProviders({ enableLive: true, depth: 'deep', fetch: mock.fetch, externalLabels: false });
  const activity = await getActivityFromProviders(providers, 'bitcoin', SUBJECT, context({ history: 'full' }));
  assert.equal(activity.transfers.length, 80);
  assert.equal(activity.profile.firstSeen, '2020-07-15T19:00:00.000Z');
  const esplora = providers[0] as unknown as EsploraProvider;
  assert.equal(esplora.history.maxHistoryRequests, 60);
  assert.equal(esplora.options.trace?.maxCandidates, 10);
  assert.equal(esplora.fallbackSiteUrl, 'https://mempool.space');
  const standard = createChainProviders({ enableLive: true, fetch: mock.fetch, history: 'full' })[0] as unknown as EsploraProvider;
  assert.deepEqual([standard.history.history, standard.history.maxHistoryRequests], ['full', 24]);
});
