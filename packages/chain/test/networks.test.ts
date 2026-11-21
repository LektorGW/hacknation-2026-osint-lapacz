// Sieci EVM (rejestr, wykrywanie, analiza innej sieci) i stan posiadania. Bez internetu.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeBalances } from '../src/balances.ts';
import type { BalanceEntry } from '../src/balances.ts';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { createLabelSet } from '../src/labels.ts';
import { EvmMultiChainProvider, chainLabelSet, discoverNetworks, getEvmNetwork, loadEvmNetworks } from '../src/networks.ts';
import type { EvmNetwork, MultiChainActivity } from '../src/networks.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const SUBJECT = `0x${'1'.repeat(40)}`;
const HOT = `0x${'e'.repeat(40)}`;
const OP_USDT = `0x${'7'.repeat(40)}`;
const noSanctions = createSanctionsList({ addresses: [] });
const rates = new StaticRateSource({
  source: 'tabela testowa',
  rates: { ETH: { '2025-05': 10000, '2024-12': 15000, '2023-12': 9000 }, USDT: { '2025-05': 4, '2024-12': 4.1, '2023-12': 3.9 }, BTC: { '2023-12': 170000, '2024-12': 400000 } },
});
const optimism: EvmNetwork = {
  id: 'optimism',
  name: 'OP Mainnet (Optimism)',
  chainId: 10,
  nativeAsset: 'ETH',
  apiUrl: 'https://explorer.optimism.io',
  explorerUrl: 'https://explorer.optimism.io',
  stablecoins: [{ symbol: 'USDT', address: OP_USDT }],
};
const celo: EvmNetwork = { id: 'celo', name: 'Celo', chainId: 42220, nativeAsset: 'CELO', apiUrl: 'https://celo.blockscout.com', explorerUrl: 'https://celo.blockscout.com', stablecoins: [] };
const lisk: EvmNetwork = { id: 'lisk', name: 'Lisk', chainId: 1135, nativeAsset: 'ETH', apiUrl: 'https://blockscout.lisk.com', explorerUrl: 'https://blockscout.lisk.com', stablecoins: [] };
const ethereum: EvmNetwork = { id: 'ethereum', name: 'Ethereum', chainId: 1, nativeAsset: 'ETH', apiUrl: 'https://eth.blockscout.com', explorerUrl: 'https://eth.blockscout.com', stablecoins: [] };

test('rejestr sieci EVM: tylko sieci potwierdzone na żywo, z walutą natywną i zweryfikowanymi stablecoinami', () => {
  const registry = loadEvmNetworks();
  const ids = registry.networks.map((item) => item.id);
  assert.ok(ids.includes('ethereum') && ids.includes('optimism') && ids.includes('zksync') && ids.includes('scroll') && ids.includes('celo'));
  assert.equal(new Set(ids).size, ids.length);
  for (const chain of registry.networks) {
    assert.match(chain.apiUrl, /^https:\/\/[^/]+$/, chain.id);
    assert.match(chain.explorerUrl, /^https:\/\//, chain.id);
    assert.ok(chain.nativeAsset.length > 0 && Number.isInteger(chain.chainId), chain.id);
    for (const coin of chain.stablecoins) {
      assert.match(coin.address, /^0x[0-9a-fA-F]{40}$/, `${chain.id} ${coin.symbol}`);
      assert.ok(['USDT', 'USDC'].includes(coin.symbol));
      assert.ok((coin.holders ?? 0) >= 10_000, 'stablecoin potwierdzony liczbą posiadaczy');
    }
  }
  assert.equal(getEvmNetwork('celo')?.nativeAsset, 'CELO');
  // Sieci sprawdzone i niedostępne bez klucza są opisane, a nie przemilczane.
  const missing = registry.unavailable.map((item) => item.id);
  for (const id of ['base', 'arbitrum', 'polygon', 'bnb']) {
    assert.ok(missing.includes(id) && !ids.includes(id), id);
  }
  assert.match(registry.unavailable.find((item) => item.id === 'bnb')?.reason ?? '', /brak publicznego eksploratora z API bez klucza/);

  // Etykiety z Ethereum nie przechodzą na inną sieć — znane są tylko jej kontrakty stablecoinów.
  const set = chainLabelSet(optimism);
  assert.equal(set.lookup('ethereum', OP_USDT)?.asset, 'USDT');
  assert.equal(set.lookup('ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7'), undefined);
});

test('wykrywanie sieci: jedno zapytanie o liczniki na sieć, saldo tylko dla sieci z aktywnością', async () => {
  const mock = mockFetch({
    [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '850', token_transfers_count: '1200' },
    [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}`]: { coin_balance: '181100000000000000' },
    [`https://celo.blockscout.com/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '0', token_transfers_count: '3' },
    [`https://celo.blockscout.com/api/v2/addresses/${SUBJECT}`]: { coin_balance: '1843400000000000000' },
    [`https://blockscout.lisk.com/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '0', token_transfers_count: '0' },
    [`https://broken.example/api/v2/addresses/${SUBJECT}/counters`]: { status: 502 },
  });
  const broken: EvmNetwork = { ...lisk, id: 'broken', name: 'Zepsuta', apiUrl: 'https://broken.example' };
  const unknown: EvmNetwork = { ...lisk, id: 'nowa', name: 'Nieznająca adresu', apiUrl: 'https://unknown.example' };
  const result = await discoverNetworks(SUBJECT, testContext(), { fetch: mock.fetch, networks: [celo, optimism, lisk, broken, unknown] });
  assert.deepEqual(result.networks, [
    { networkId: 'optimism', name: 'OP Mainnet (Optimism)', txCount: 850, tokenTransfers: 1200, balance: 0.1811, nativeAsset: 'ETH', explorerUrl: `https://explorer.optimism.io/address/${SUBJECT}` },
    { networkId: 'celo', name: 'Celo', txCount: 0, tokenTransfers: 3, balance: 1.8434, nativeAsset: 'CELO', explorerUrl: `https://celo.blockscout.com/address/${SUBJECT}` },
  ]);
  // Sieć bez aktywności i sieć nieznająca adresu (404) nie kosztują drugiego żądania.
  assert.equal(mock.calls.length, 7);
  assert.ok(result.limitations.some((item) => /nie udało się sprawdzić 1 z 5 sieci — Zepsuta \(HTTP 502\)/.test(item)));
  assert.ok(result.limitations.some((item) => /NIE sprawdzono: .*Base.*BNB Smart Chain/.test(item)));
});

// Zapisany układ strony transakcji Blockscout ze znacznikami giełdy.
const exchangeParty = { hash: HOT, is_contract: false, metadata: { tags: [{ name: 'Binance: Hot Wallet', slug: 'binance-hot-wallet', tagType: 'name', ordinal: 10 }, { name: 'Exchange', slug: 'exchange', tagType: 'generic', ordinal: 0 }] } };
const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null });
const opRoutes = {
  [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}`]: { ...party(SUBJECT), coin_balance: '500000000000000000' },
  [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}/transactions`]: {
    items: [{ hash: '0xop1', timestamp: '2025-05-10T08:00:00.000000Z', from: party(SUBJECT), to: exchangeParty, value: '2000000000000000000', status: 'ok' }],
    next_page_params: null,
  },
  [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}/token-transfers?type=ERC-20`]: {
    items: [
      { transaction_hash: '0xop2', timestamp: '2025-05-11T08:00:00.000000Z', from: party(SUBJECT), to: exchangeParty, token: { symbol: 'USDT', decimals: '6', address_hash: OP_USDT }, total: { value: '1500000000', decimals: '6' } },
      // Ten sam symbol z innego kontraktu nie jest stablecoinem tej sieci.
      { transaction_hash: '0xop3', timestamp: '2025-05-12T08:00:00.000000Z', from: party(SUBJECT), to: exchangeParty, token: { symbol: 'USDT', decimals: '6', address_hash: '0xdAC17F958D2ee523a2206206994597C13D831ec7' }, total: { value: '9000000000', decimals: '6' } },
    ],
    next_page_params: null,
  },
};

test('przelew z innej sieci EVM: `network: ethereum`, pole `chain`, odnośnik do eksploratora tej sieci, ścieżka i wycena', async () => {
  const provider = new BlockscoutProvider({ fetch: mockFetch(opRoutes).fetch, rateSource: rates, sanctions: noSanctions, chain: optimism });
  assert.equal(provider.label, 'Blockscout (OP Mainnet (Optimism))');
  const activity = (await provider.getActivity('ethereum', SUBJECT, testContext())) as MultiChainActivity;

  const native = activity.transfers.find((item) => item.txid === '0xop1') as (typeof activity.transfers)[number] & { chain?: string };
  assert.equal(activity.profile.network, 'ethereum');
  assert.equal(native.chain, 'optimism');
  assert.equal(native.asset, 'ETH');
  assert.equal(native.explorerUrl, 'https://explorer.optimism.io/tx/0xop1');
  assert.equal(native.counterpartyLabel, 'Binance: Hot Wallet');
  assert.match(activity.transfers.find((item) => item.txid === '0xop3')?.asset ?? '', /niezweryfikowany token/);

  // Wpłata na giełdę przez inną sieć trafia do wskaźników i ścieżek, z oznaczeniem sieci.
  const trails = (activity.trails ?? []) as ((typeof activity.trails & object)[number] & { chain?: string })[];
  assert.deepEqual(trails.map((trail) => [trail.hops[0]?.txid, trail.chain, (trail.hops[0] as { chain?: string }).chain, trail.valuePln]), [
    ['0xop1', 'optimism', 'optimism', 20000],
    ['0xop2', 'optimism', 'optimism', 6000],
  ]);
  assert.deepEqual(activity.cashOuts.filter((item) => item.valuePln !== undefined).map((item) => [(item as { chain?: string }).chain, item.valuePln]), [['optimism', 20000], ['optimism', 6000]]);
  assert.match(trails[0]?.reasons[0] ?? '', /etykieta: Blockscout \(klasa podana przez źródło\)/);
});

test('dostawca wielosieciowy: pole `networks`, pełna analiza innej sieci w trybie głębokim, ograniczenia z nazwą sieci', async () => {
  const ethRoutes = {
    [`https://eth.blockscout.com/api/v2/addresses/${SUBJECT}`]: { ...party(SUBJECT), coin_balance: '1000000000000000000' },
    [`https://eth.blockscout.com/api/v2/addresses/${SUBJECT}/transactions`]: {
      items: [{ hash: '0xeth1', timestamp: '2025-05-01T08:00:00.000000Z', from: party(`0x${'9'.repeat(40)}`), to: party(SUBJECT), value: '1000000000000000000', status: 'ok' }],
      next_page_params: null,
    },
    [`https://eth.blockscout.com/api/v2/addresses/${SUBJECT}/token-transfers?type=ERC-20`]: { items: [], next_page_params: null },
    [`https://explorer.optimism.io/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '12', token_transfers_count: '4' },
    [`https://celo.blockscout.com/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '1', token_transfers_count: '0' },
    [`https://celo.blockscout.com/api/v2/addresses/${SUBJECT}`]: { coin_balance: '0' },
    ...opRoutes,
  };
  const build = (maxExtraNetworks: number) => {
    const mock = mockFetch(ethRoutes);
    const shared = { fetch: mock.fetch, rateSource: rates, sanctions: noSanctions, labels: createLabelSet([], 'zbiór testowy') };
    return {
      mock,
      provider: new EvmMultiChainProvider({
        main: new BlockscoutProvider({ ...shared, chain: ethereum }),
        createProvider: (chain) => new BlockscoutProvider({ fetch: mock.fetch, rateSource: rates, sanctions: noSanctions, chain }),
        fetch: mock.fetch,
        networks: [ethereum, optimism, celo],
        maxExtraNetworks,
      }),
    };
  };

  // Tryb standardowy: samo wykrycie sieci — wypłaty przez Optimism jeszcze nie widać, ale wiadomo, gdzie szukać.
  const shallow = (await build(0).provider.getActivity('ethereum', SUBJECT, testContext())) as MultiChainActivity;
  assert.deepEqual(shallow.networks?.map((item) => [item.networkId, item.txCount, item.tokenTransfers, item.balance]), [
    ['ethereum', 1, 0, 1],
    ['optimism', 12, 4, 0.5],
    ['celo', 1, 0, 0],
  ]);
  assert.equal(shallow.cashOuts.length, 0);
  assert.ok(shallow.limitations.some((item) => /adres jest używany także w 2 innych sieciach \(OP Mainnet \(Optimism\): 12 transakcji, 4 transferów tokenów; Celo: 1 transakcji/.test(item)));
  assert.ok(shallow.limitations.some((item) => /bez pełnej analizy pozostały OP Mainnet \(Optimism\), Celo \(analiza innych sieci działa w trybie głębokim\)/.test(item)));

  // Tryb głęboki: sieć o największej aktywności przechodzi pełną analizę.
  const deep = (await build(1).provider.getActivity('ethereum', SUBJECT, testContext())) as MultiChainActivity;
  assert.equal(deep.profile.txCount, 1, 'profil opisuje Ethereum mainnet');
  assert.deepEqual(deep.transfers.map((item) => [item.txid, (item as { chain?: string }).chain]), [
    ['0xeth1', undefined],
    ['0xop1', 'optimism'],
    ['0xop2', 'optimism'],
    ['0xop3', 'optimism'],
  ]);
  assert.equal(deep.trails?.length, 2);
  assert.deepEqual(deep.cashOutPlnByYear, { '2025': 26000 });
  assert.equal(deep.networks?.find((item) => item.networkId === 'optimism')?.lastSeen, '2025-05-12T08:00:00.000000Z');
  assert.ok(deep.limitations.some((item) => /^\[OP Mainnet \(Optimism\)\] Ethereum: uwzględniono przelewy/.test(item) || /^\[OP Mainnet \(Optimism\)\] /.test(item)));
  assert.ok(deep.limitations.some((item) => /pełną analizę \(wypływy, etykiety, ścieżki\) wykonano dla Ethereum oraz OP Mainnet \(Optimism\)/.test(item)));
  assert.ok(deep.limitations.some((item) => /bez pełnej analizy pozostały Celo \(limit 1 dodatkowych sieci\)/.test(item)));

  // Fabryka: Ethereum obsługuje dostawca wielosieciowy; w trybie głębokim analizuje do 3 innych sieci.
  const providers = (config: object) => createChainProviders({ enableLive: true, fetch: mockFetch({}).fetch, ...config });
  const evm = (config: object) => providers(config).find((item) => item.supports('ethereum', SUBJECT)) as unknown as EvmMultiChainProvider | BlockscoutProvider;
  assert.ok(evm({}) instanceof EvmMultiChainProvider);
  assert.equal((evm({}) as EvmMultiChainProvider).config.maxExtraNetworks, 0);
  assert.equal((evm({ depth: 'deep' }) as EvmMultiChainProvider).config.maxExtraNetworks, 3);
  assert.ok(evm({ evmNetworks: false }) instanceof BlockscoutProvider);
  const viaFactory = await getActivityFromProviders(providers({}), 'ethereum', SUBJECT, testContext());
  assert.equal(viaFactory.profile.network, 'ethereum');
});

test('stan posiadania: saldo na koniec roku liczone wstecz od salda bieżącego; pominięcie przy niepełnej lub niezgodnej historii', async () => {
  const flows = [
    { asset: 'USDT', time: '2023-03-01T10:00:00Z', delta: 1000 },
    { asset: 'USDT', time: '2023-11-01T10:00:00Z', delta: -400 },
    { asset: 'USDT', time: '2024-06-01T10:00:00Z', delta: 2000 },
    // 31 grudnia 23:30 UTC to w Polsce już 1 stycznia — przelew należy do roku 2025.
    { asset: 'USDT', time: '2024-12-31T23:30:00Z', delta: -600 },
    { asset: 'USDT', time: '2025-05-10T10:00:00Z', delta: -1500 },
    { asset: 'ETH', time: '2024-02-01T10:00:00Z', delta: 2 },
    { asset: 'ETH', time: '2025-02-01T10:00:00Z', delta: -0.5 },
  ];
  const now = new Date('2025-05-20T12:00:00Z');
  const full = await computeBalances(
    'ethereum',
    { current: [{ asset: 'USDT', amount: 500 }, { asset: 'ETH', amount: 1.5 }], flows, complete: ['USDT', 'ETH'], chain: 'optimism', networkName: 'OP Mainnet (Optimism)' },
    rates,
    now,
  );
  const row = (entry: BalanceEntry) => [entry.asset, entry.kind, entry.asOf, entry.amount, entry.valuePln, entry.chain];
  assert.deepEqual(full.balances.map(row), [
    ['USDT', 'current', '2025-05-20T12:00:00.000Z', 500, 2000, 'optimism'],
    ['USDT', 'year_end', '2023-12-31', 600, 2340, 'optimism'],
    ['USDT', 'year_end', '2024-12-31', 2600, 10660, 'optimism'],
    ['ETH', 'current', '2025-05-20T12:00:00.000Z', 1.5, 15000, 'optimism'],
    ['ETH', 'year_end', '2024-12-31', 2, 30000, 'optimism'],
  ]);
  assert.match(full.balances[1]?.basis ?? '', /^wynik obliczeń \(OP Mainnet \(Optimism\)\): saldo bieżące pomniejszone o przelewy po 31 grudnia 2023 r\./);
  assert.match(full.balances[1]?.valuation ?? '', /^Szacunek: 600 USDT × /);
  assert.ok(full.limitations.some((item) => /^Stan posiadania \(OP Mainnet \(Optimism\)\) to wynik obliczeń/.test(item)));

  // Niepełna historia aktywa: tylko saldo bieżące i wpis w ograniczeniach.
  const partial = await computeBalances('ethereum', { current: [{ asset: 'USDT', amount: 500 }, { asset: 'ETH', amount: 1.5 }], flows, complete: ['ETH'] }, rates, now);
  assert.deepEqual(partial.balances.map((entry) => [entry.asset, entry.kind]), [['USDT', 'current'], ['ETH', 'current'], ['ETH', 'year_end']]);
  assert.ok(partial.limitations.some((item) => /nie wyliczono sald USDT na koniec lat — pobrana historia tego aktywa nie jest pełna/.test(item)));

  // Historia „pełna”, ale niezgodna z saldem (brak opłat, transakcji wewnętrznych): nie zgadujemy.
  const mismatch = await computeBalances('ethereum', { current: [{ asset: 'ETH', amount: 1.2 }], flows, complete: ['ETH'] }, rates, now);
  assert.deepEqual(mismatch.balances.map((entry) => entry.kind), ['current']);
  assert.ok(mismatch.limitations.some((item) => /nie wyliczono sald ETH na koniec lat — suma pobranych przelewów \(1\.5\) nie zgadza się z saldem bieżącym \(1\.2\)/.test(item)));
});

test('Bitcoin: saldo bieżące i salda na koniec lat z pełnej historii (z opłatami); przy niepełnej historii tylko bieżące', async () => {
  const address = 'bc1qsubject0000000000000000000000000000';
  const api = `https://blockstream.info/api/address/${address}`;
  const tx = (txid: string, time: string, inputs: [string, number][], outputs: [string, number][]) => ({
    txid,
    status: { confirmed: true, block_time: Date.parse(time) / 1000 },
    vin: inputs.map(([from, value]) => ({ txid: `f-${txid}`, vout: 0, prevout: { scriptpubkey_address: from, value, scriptpubkey_type: 'v0_p2wpkh' } })),
    vout: outputs.map(([to, value]) => ({ scriptpubkey_address: to, value, scriptpubkey_type: 'v0_p2wpkh' })),
  });
  const txs = [
    // 2024: wydano 0,6 BTC + 0,001 opłaty, reszta 0,399 wraca na adres.
    tx('spend', '2024-08-01T10:00:00Z', [[address, 100_000_000]], [['bc1qother000000000000000000000000000000', 60_000_000], [address, 39_900_000]]),
    tx('fund', '2023-05-01T10:00:00Z', [['bc1qfunder00000000000000000000000000000', 100_010_000]], [[address, 100_000_000]]),
  ];
  const run = async (stats: object, list: object[]) => {
    const mock = mockFetch({ [api]: { chain_stats: stats }, [`${api}/txs`]: list });
    const provider = new EsploraProvider({ id: 'esplora-blockstream', label: 'Blockstream Esplora (Bitcoin)', siteUrl: 'https://blockstream.info', fetch: mock.fetch, rateSource: rates, labels: createLabelSet([], 'zbiór testowy'), sanctions: noSanctions });
    return (await provider.getActivity('bitcoin', address, testContext())) as MultiChainActivity;
  };
  const complete = await run({ funded_txo_sum: 139_900_000, spent_txo_sum: 100_000_000, tx_count: 2 }, txs);
  assert.deepEqual(complete.balances?.map((entry) => [entry.kind, entry.asOf.slice(0, 10), entry.amount, entry.valuePln]), [
    ['current', new Date().toISOString().slice(0, 10), 0.399, undefined],
    ['year_end', '2023-12-31', 1, 170000],
    ['year_end', '2024-12-31', 0.399, 159600],
  ]);
  assert.equal(complete.balances?.[0]?.network, 'bitcoin');

  const partial = await run({ funded_txo_sum: 939_900_000, spent_txo_sum: 900_000_000, tx_count: 300 }, txs);
  assert.deepEqual(partial.balances?.map((entry) => entry.kind), ['current']);
  assert.ok(partial.limitations.some((item) => /Stan posiadania \(Bitcoin\): nie wyliczono sald BTC na koniec lat — pobrana historia tego aktywa nie jest pełna/.test(item)));
});
