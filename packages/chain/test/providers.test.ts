import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChainActivity, ChainProvider } from '@olcys/core';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { ChainProviderError } from '../src/http.ts';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { SandboxChainProvider } from '../src/providers/sandbox.ts';
import { TronGridProvider, tronHexToBase58 } from '../src/providers/trongrid.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const rateSource = new StaticRateSource({
  source: 'tabela testowa',
  rates: {
    BTC: { '2025-03': 300000, '2025-04': 320000 },
    ETH: { '2025-05': 10000 },
    USDT: { '2025-03': 4, '2025-06': 3.7 },
  },
});

// ---------- Sandbox ----------

const SANDBOX = 'http://localhost:4100';
const SUBJECT = 'bc1qsubject';
const sandboxRoutes = {
  [`${SANDBOX}/explorer/api/address/${SUBJECT}`]: {
    address: SUBJECT,
    network: 'bitcoin',
    isContract: false,
    transfers: [
      { txid: 't3', time: '2025-04-02T09:00:00Z', direction: 'out', counterparty: 'bc1qgateway', asset: 'BTC', amount: 0.1 },
      { txid: 't1', time: '2025-03-01T08:00:00Z', direction: 'in', counterparty: 'bc1qfriend', asset: 'BTC', amount: 1 },
      { txid: 't2', time: '2025-03-14T10:22:00Z', direction: 'out', counterparty: 'bc1qkraken', asset: 'BTC', amount: 0.42 },
    ],
  },
  [`${SANDBOX}/explorer/api/address/bc1qkraken`]: {
    address: 'bc1qkraken',
    network: 'bitcoin',
    isContract: false,
    label: 'Kraken: Hot Wallet',
    addressClass: 'exchange',
    transfers: [],
  },
  [`${SANDBOX}/explorer/api/address/bc1qgateway`]: {
    address: 'bc1qgateway',
    network: 'bitcoin',
    isContract: false,
    label: 'PayGate: bramka płatnicza',
    addressClass: 'institutional',
    transfers: [],
  },
};

test('sandbox: profil, przelewy chronologicznie, wypłaty z wyceną i sumy per rok', async () => {
  const mock = mockFetch(sandboxRoutes);
  const provider = new SandboxChainProvider({ sandboxUrl: `${SANDBOX}/`, fetch: mock.fetch, rateSource });
  const activity = await provider.getActivity('bitcoin', SUBJECT, testContext());

  assert.equal(activity.profile.addressClass, 'private');
  assert.equal(activity.profile.isContract, false);
  assert.equal(activity.profile.txCount, 3);
  assert.equal(activity.profile.totalReceived, 1);
  assert.equal(activity.profile.totalSent, 0.52);
  assert.equal(activity.profile.balance, 0.48);
  assert.equal(activity.profile.nativeAsset, 'BTC');
  assert.equal(activity.profile.firstSeen, '2025-03-01T08:00:00Z');
  assert.equal(activity.profile.lastSeen, '2025-04-02T09:00:00Z');

  assert.deepEqual(activity.transfers.map((t) => t.txid), ['t1', 't2', 't3']);
  const [friend, kraken, gateway] = activity.transfers;
  assert.equal(friend?.counterpartyClass, 'unknown');
  assert.equal(kraken?.counterpartyClass, 'exchange');
  assert.equal(kraken?.counterpartyLabel, 'Kraken: Hot Wallet');
  assert.equal(kraken?.explorerUrl, `${SANDBOX}/explorer/address/bc1qkraken`);
  assert.equal(gateway?.counterpartyClass, 'institutional');

  assert.deepEqual(activity.cashOuts.map((c) => c.kind), ['exchange_deposit', 'payment_gateway']);
  assert.equal(activity.cashOuts[0]?.valuePln, 126000);
  assert.equal(activity.cashOuts[1]?.valuePln, 32000);
  assert.deepEqual(activity.cashOutPlnByYear, { '2025': 158000 });
  assert.ok(activity.limitations.some((text) => /syntetycznego/.test(text)));
  assert.ok(activity.limitations.some((text) => /szacunkiem/.test(text)));
});

test('sandbox: etykieta i klasa badanego adresu oraz opis kontrahenta podany w przelewie', async () => {
  const mock = mockFetch({
    [`${SANDBOX}/explorer/api/address/addr-ex`]: {
      address: 'addr-ex',
      network: 'ethereum',
      isContract: false,
      label: 'Giełda Demo: portfel',
      addressClass: 'exchange',
      transfers: [
        {
          txid: 'a',
          time: '2025-05-02T10:00:00Z',
          direction: 'out',
          counterparty: 'addr-card',
          asset: 'ETH',
          amount: 0.2,
          counterpartyLabel: 'KryptoKarta',
          counterpartyKind: 'crypto_card',
        },
      ],
    },
  });
  const provider = new SandboxChainProvider({ sandboxUrl: SANDBOX, fetch: mock.fetch, rateSource });
  const activity = await provider.getActivity('ethereum', 'addr-ex', testContext());
  assert.equal(activity.profile.addressClass, 'exchange');
  assert.equal(activity.profile.label, 'Giełda Demo: portfel');
  assert.match(activity.profile.classificationSource, /sandbox/);
  assert.equal(activity.cashOuts[0]?.kind, 'crypto_card');
  assert.equal(activity.cashOuts[0]?.valuePln, 2000);
  assert.equal(mock.calls.length, 1, 'opisany kontrahent nie wymaga dodatkowego zapytania');
});

test('sandbox: nieznany adres (404) to błąd „nieznany adres”, choć supports zwraca true', async () => {
  const provider = new SandboxChainProvider({ sandboxUrl: SANDBOX, fetch: mockFetch({}).fetch });
  assert.equal(provider.supports(), true);
  await assert.rejects(
    provider.getActivity('bitcoin', 'bc1qnieznany', testContext()),
    (error: ChainProviderError) => error.code === 'not_found' && /nieznany adres/.test(error.message),
  );
});

// ---------- Kolejność prób ----------

function fakeProvider(id: string, result: ChainActivity | Error, calls: string[], supported = true): ChainProvider {
  return {
    id,
    label: `Dostawca ${id}`,
    supports: () => supported,
    getActivity: async () => {
      calls.push(id);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

test('dostawcy są pytani po kolei; wygrywa pierwszy, który ma dane', async () => {
  const sandbox = new SandboxChainProvider({ sandboxUrl: SANDBOX, fetch: mockFetch(sandboxRoutes).fetch, rateSource });
  const expected = await sandbox.getActivity('bitcoin', SUBJECT, testContext());
  const calls: string[] = [];
  const context = testContext();
  const activity = await getActivityFromProviders(
    [
      fakeProvider('pomijany', expected, calls, false),
      fakeProvider('pierwszy', new ChainProviderError('not_found', 'nieznany adres'), calls),
      fakeProvider('drugi', expected, calls),
      fakeProvider('trzeci', expected, calls),
    ],
    'bitcoin',
    SUBJECT,
    context,
  );
  assert.deepEqual(calls, ['pierwszy', 'drugi']);
  assert.equal(activity, expected);
  assert.ok(context.messages.some((message) => /Dostawca pierwszy.*nieznany adres/.test(message)));
});

test('gdy żaden dostawca nie ma danych: klasa nieznana, zera i wpis w ograniczeniach', async () => {
  const calls: string[] = [];
  const activity = await getActivityFromProviders(
    [fakeProvider('a', new ChainProviderError('not_found', 'nieznany adres'), calls), fakeProvider('b', new Error('awaria'), calls)],
    'bitcoin',
    'bc1qnieznany',
    testContext(),
  );
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(activity.profile.addressClass, 'unknown');
  assert.equal(activity.profile.txCount, 0);
  assert.equal(activity.profile.totalReceived, 0);
  assert.equal(activity.profile.balance, 0);
  assert.deepEqual(activity.transfers, []);
  assert.deepEqual(activity.cashOuts, []);
  assert.deepEqual(activity.cashOutPlnByYear, {});
  assert.equal(activity.limitations.length, 1);
  assert.match(activity.limitations[0] ?? '', /Brak danych blockchain.*nieznany adres.*awaria/);
});

test('bez danych adres ze zbioru etykiet zachowuje swoją klasę', async () => {
  const activity = await getActivityFromProviders([], 'ethereum', '0xdAC17F958D2ee523a2206206994597C13D831ec7', testContext());
  assert.equal(activity.profile.addressClass, 'smart_contract');
  assert.match(activity.limitations[0] ?? '', /żaden skonfigurowany dostawca/);
});

test('createChainProviders: sandbox pierwszy, dostawcy live tylko za zgodą', () => {
  assert.deepEqual(createChainProviders({}), []);
  assert.deepEqual(createChainProviders({ sandboxUrl: SANDBOX }).map((p) => p.id), ['sandbox-explorer']);
  const all = createChainProviders({ sandboxUrl: SANDBOX, enableLive: true });
  assert.deepEqual(all.map((p) => p.id), ['sandbox-explorer', 'esplora-blockstream', 'esplora-mempool', 'blockscout-ethereum', 'trongrid']);
  const live = all.slice(1);
  assert.deepEqual(live.map((p) => p.supports('bitcoin', 'x')), [true, true, false, false]);
  assert.deepEqual(live.map((p) => p.supports('bitcoin-testnet', 'x')), [true, true, false, false]);
  assert.deepEqual(live.map((p) => p.supports('ethereum', 'x')), [false, false, true, false]);
  assert.deepEqual(live.map((p) => p.supports('tron', 'x')), [false, false, false, true]);
});

// ---------- Esplora (Bitcoin) ----------

const BTC_SUBJECT = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const BINANCE = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo';
const ESPLORA = 'https://blockstream.info';

function esploraProvider(routes: Record<string, unknown>) {
  const mock = mockFetch(routes);
  const provider = new EsploraProvider({ id: 'esplora-test', label: 'Esplora test', siteUrl: ESPLORA, fetch: mock.fetch, rateSource });
  return { mock, provider };
}

test('esplora: kierunek, kwota i kontrahent transakcji; wypłata na adres giełdy ze zbioru etykiet', async () => {
  const { mock, provider } = esploraProvider({
    [`${ESPLORA}/api/address/${BTC_SUBJECT}`]: {
      address: BTC_SUBJECT,
      chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 100_000_000, tx_count: 2 },
      mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 },
    },
    [`${ESPLORA}/api/address/${BTC_SUBJECT}/txs`]: [
      {
        txid: 'out1',
        status: { confirmed: true, block_time: 1741947720 },
        vin: [{ prevout: { scriptpubkey_address: BTC_SUBJECT, value: 100_000_000 } }],
        vout: [
          { scriptpubkey_address: 'bc1qsmall', value: 5_000_000 },
          { scriptpubkey_address: BINANCE, value: 42_000_000 },
          { scriptpubkey_address: BTC_SUBJECT, value: 52_990_000 },
        ],
      },
      {
        txid: 'in1',
        status: { confirmed: true, block_time: 1740816000 },
        vin: [
          { prevout: { scriptpubkey_address: 'bc1qsender', value: 160_000_000 } },
          { prevout: { scriptpubkey_address: 'bc1qother', value: 1_000_000 } },
        ],
        vout: [
          { scriptpubkey_address: BTC_SUBJECT, value: 150_000_000 },
          { scriptpubkey_address: 'bc1qsender', value: 10_990_000 },
        ],
      },
      { txid: 'pending', status: { confirmed: false }, vin: [], vout: [{ scriptpubkey_address: BTC_SUBJECT, value: 1 }] },
    ],
  });
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());

  assert.equal(mock.calls.length, 2);
  assert.equal(activity.profile.txCount, 2);
  assert.equal(activity.profile.totalReceived, 1.5);
  assert.equal(activity.profile.totalSent, 1);
  assert.equal(activity.profile.balance, 0.5);
  assert.equal(activity.profile.addressClass, 'private');

  const [incoming, outgoing] = activity.transfers;
  assert.equal(incoming?.direction, 'in');
  assert.equal(incoming?.amount, 1.5);
  assert.equal(incoming?.counterparty, 'bc1qsender');
  assert.equal(incoming?.time, '2025-03-01T08:00:00.000Z');
  assert.equal(outgoing?.direction, 'out');
  assert.equal(outgoing?.amount, 0.47);
  assert.equal(outgoing?.counterparty, BINANCE);
  assert.equal(outgoing?.counterpartyClass, 'exchange');
  assert.equal(outgoing?.explorerUrl, `${ESPLORA}/tx/out1`);

  assert.equal(activity.cashOuts.length, 1);
  assert.equal(activity.cashOuts[0]?.kind, 'exchange_deposit');
  assert.equal(activity.cashOuts[0]?.valuePln, 141000);
  assert.ok(activity.limitations.some((text) => /uproszczeniem/.test(text)));
  assert.ok(activity.limitations.some((text) => /Pominięto 1 transakcji oczekujących/.test(text)));
});

test('esplora: najwyżej 3 żądania i 50 transakcji, z wpisem o limicie', async () => {
  const page = (prefix: string) =>
    Array.from({ length: 25 }, (_, i) => ({
      txid: `${prefix}${i}`,
      status: { confirmed: true, block_time: 1741947720 - i },
      vin: [{ prevout: { scriptpubkey_address: 'bc1qsender', value: 2000 } }],
      vout: [{ scriptpubkey_address: BTC_SUBJECT, value: 1000 }],
    }));
  const { mock, provider } = esploraProvider({
    [`${ESPLORA}/api/address/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 120_000, spent_txo_sum: 0, tx_count: 120 } },
    [`${ESPLORA}/api/address/${BTC_SUBJECT}/txs`]: page('a'),
    [`${ESPLORA}/api/address/${BTC_SUBJECT}/txs/chain/a24`]: page('b'),
  });
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.equal(mock.calls.length, 3);
  assert.equal(activity.transfers.length, 50);
  assert.equal(activity.profile.txCount, 120);
  assert.equal(activity.profile.firstSeen, undefined, 'niepełna historia nie daje daty pierwszej transakcji');
  assert.ok(activity.limitations.some((text) => /Pobrano 50 najnowszych z 120 transakcji \(limit 50\)/.test(text)));
});

test('esplora: adres bez historii ma klasę nieznaną; 429 i 5xx dają czytelny błąd', async () => {
  const empty = esploraProvider({
    [`${ESPLORA}/api/address/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } },
  });
  const activity = await empty.provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.equal(activity.profile.addressClass, 'unknown');
  assert.equal(empty.mock.calls.length, 1);

  const limited = esploraProvider({ [`${ESPLORA}/api/address/${BTC_SUBJECT}`]: { status: 429 } });
  await assert.rejects(
    limited.provider.getActivity('bitcoin', BTC_SUBJECT, testContext()),
    (error: ChainProviderError) => error.code === 'rate_limited' && /limit zapytań/.test(error.message),
  );
  const down = esploraProvider({ [`${ESPLORA}/api/address/${BTC_SUBJECT}`]: { status: 502 } });
  await assert.rejects(
    down.provider.getActivity('bitcoin', BTC_SUBJECT, testContext()),
    (error: ChainProviderError) => error.code === 'unavailable' && /HTTP 502/.test(error.message),
  );
});

// ---------- Blockscout (Ethereum) ----------

const ETH_SUBJECT = '0x52908400098527886E0F7030069857D2E4169EE7';
const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const BINANCE_14 = '0x28C6c06298d514Db089934071355E5743bf21d60';
const SCOUT = 'https://eth.blockscout.com';

test('blockscout: przelewy ETH i tokenów, zamiana na stablecoiny, podrobiony token bez wyceny', async () => {
  const mock = mockFetch({
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}`]: {
      hash: ETH_SUBJECT,
      is_contract: false,
      name: null,
      coin_balance: '1500000000000000000',
    },
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}/transactions`]: {
      items: [
        {
          hash: '0xswap',
          timestamp: '2025-05-10T12:00:00.000000Z',
          status: 'ok',
          value: '2000000000000000000',
          from: { hash: ETH_SUBJECT.toLowerCase(), is_contract: false },
          to: { hash: ROUTER, is_contract: true, name: 'UniswapV2Router02' },
        },
        {
          hash: '0xcall',
          timestamp: '2025-05-09T12:00:00.000000Z',
          status: 'ok',
          value: '0',
          from: { hash: ETH_SUBJECT, is_contract: false },
          to: { hash: USDT_CONTRACT, is_contract: true },
        },
        {
          hash: '0xfailed',
          timestamp: '2025-05-08T12:00:00.000000Z',
          status: 'error',
          value: '1000000000000000000',
          from: { hash: ETH_SUBJECT, is_contract: false },
          to: { hash: BINANCE_14, is_contract: false },
        },
        {
          hash: '0xfund',
          timestamp: '2025-05-01T12:00:00.000000Z',
          status: 'ok',
          value: '3500000000000000000',
          from: { hash: '0x1111111111111111111111111111111111111111', is_contract: false },
          to: { hash: ETH_SUBJECT, is_contract: false },
        },
      ],
      next_page_params: null,
    },
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}/token-transfers?type=ERC-20`]: {
      items: [
        {
          transaction_hash: '0xdeposit',
          timestamp: '2025-06-02T09:00:00.000000Z',
          from: { hash: ETH_SUBJECT, is_contract: false },
          to: { hash: BINANCE_14, is_contract: false },
          token: { symbol: 'USDT', decimals: '6', address_hash: USDT_CONTRACT },
          total: { value: '5000000000', decimals: '6' },
        },
        {
          transaction_hash: '0xfake',
          timestamp: '2025-05-20T09:00:00.000000Z',
          from: { hash: '0x2222222222222222222222222222222222222222', is_contract: false },
          to: { hash: ETH_SUBJECT, is_contract: false },
          token: { symbol: 'USDT', decimals: '6', address_hash: '0x3333333333333333333333333333333333333333' },
          total: { value: '999000000', decimals: '6' },
        },
        {
          transaction_hash: '0xswap',
          timestamp: '2025-05-10T12:00:00.000000Z',
          from: { hash: '0x4444444444444444444444444444444444444444', is_contract: true, name: 'UniswapV2Pair' },
          to: { hash: ETH_SUBJECT, is_contract: false },
          token: { symbol: 'USDT', decimals: '6', address_hash: USDT_CONTRACT },
          total: { value: '5000000000', decimals: '6' },
        },
      ],
      next_page_params: null,
    },
  });
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource });
  const activity = await provider.getActivity('ethereum', ETH_SUBJECT, testContext());

  assert.equal(mock.calls.length, 3);
  assert.equal(activity.profile.addressClass, 'private');
  assert.equal(activity.profile.balance, 1.5);
  assert.equal(activity.profile.totalReceived, 3.5);
  assert.equal(activity.profile.totalSent, 2);
  assert.deepEqual(activity.transfers.map((t) => t.txid), ['0xfund', '0xswap', '0xswap', '0xfake', '0xdeposit']);

  const swapOut = activity.transfers.find((t) => t.txid === '0xswap' && t.direction === 'out');
  assert.equal(swapOut?.counterpartyClass, 'smart_contract');
  assert.equal(swapOut?.counterpartyLabel, 'Uniswap V2: Router 2');
  assert.equal(swapOut?.explorerUrl, `${SCOUT}/tx/0xswap`);
  const pairIn = activity.transfers.find((t) => t.txid === '0xswap' && t.direction === 'in');
  assert.equal(pairIn?.asset, 'USDT');
  assert.equal(pairIn?.amount, 5000);
  assert.equal(pairIn?.counterpartyClass, 'smart_contract');
  assert.equal(pairIn?.counterpartyLabel, 'UniswapV2Pair');
  const fake = activity.transfers.find((t) => t.txid === '0xfake');
  assert.match(fake?.asset ?? '', /niezweryfikowany token/);

  assert.deepEqual(activity.cashOuts.map((c) => [c.kind, c.txid]), [
    ['stablecoin_swap', '0xswap'],
    ['exchange_deposit', '0xdeposit'],
  ]);
  assert.equal(activity.cashOuts[0]?.valuePln, 20000);
  assert.equal(activity.cashOuts[1]?.valuePln, 18500);
  assert.deepEqual(activity.cashOutPlnByYear, { '2025': 38500 });
});

test('blockscout: kontrakt i etykieta ze źródła, niepełna historia, 404 jako nieznany adres', async () => {
  const address = '0x5555555555555555555555555555555555555555';
  const mock = mockFetch({
    [`${SCOUT}/api/v2/addresses/${address}`]: { hash: address, is_contract: true, name: 'SomeVault', coin_balance: '0' },
    [`${SCOUT}/api/v2/addresses/${address}/transactions`]: { items: [], next_page_params: { block_number: 1 } },
    [`${SCOUT}/api/v2/addresses/${address}/token-transfers?type=ERC-20`]: { items: [], next_page_params: null },
  });
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource });
  const activity = await provider.getActivity('ethereum', address, testContext());
  assert.equal(activity.profile.addressClass, 'smart_contract');
  assert.equal(activity.profile.isContract, true);
  assert.equal(activity.profile.label, 'SomeVault');
  assert.ok(activity.limitations.some((text) => /Pobrano po 50 najnowszych/.test(text)));

  await assert.rejects(
    new BlockscoutProvider({ fetch: mockFetch({}).fetch }).getActivity('ethereum', address, testContext()),
    (error: ChainProviderError) => error.code === 'not_found',
  );
});

// ---------- TronGrid (Tron) ----------

const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRON_USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';
const TRON_ZERO = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TRON_ZERO_HEX = '410000000000000000000000000000000000000000';
const GRID = 'https://api.trongrid.io';

test('trongrid: zamiana adresu szesnastkowego na Base58Check', () => {
  assert.equal(tronHexToBase58(TRON_USDT_HEX), TRON_USDT);
  assert.equal(tronHexToBase58(TRON_ZERO_HEX), TRON_ZERO);
});

test('trongrid: przelewy TRX i TRC-20 z weryfikacją kontraktu tokena', async () => {
  // Badanym adresem jest tu adres zerowy sieci — wystarcza do sprawdzenia parsowania.
  const mock = mockFetch({
    [`${GRID}/v1/accounts/${TRON_ZERO}`]: { data: [{ balance: 2_500_000 }], success: true },
    [`${GRID}/v1/accounts/${TRON_ZERO}/transactions?limit=50&only_confirmed=true`]: {
      data: [
        {
          txID: 'trx-out',
          block_timestamp: 1741947720000,
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: {
            contract: [
              { type: 'TransferContract', parameter: { value: { amount: 7_500_000, owner_address: TRON_ZERO_HEX, to_address: TRON_USDT_HEX } } },
            ],
          },
        },
        {
          txID: 'trigger',
          block_timestamp: 1741947700000,
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: { contract: [{ type: 'TriggerSmartContract', parameter: { value: { owner_address: TRON_ZERO_HEX } } }] },
        },
      ],
      meta: { fingerprint: 'next' },
    },
    [`${GRID}/v1/accounts/${TRON_ZERO}/transactions/trc20?limit=50&only_confirmed=true`]: {
      data: [
        {
          transaction_id: 'usdt-in',
          block_timestamp: 1741947000000,
          from: 'TSender',
          to: TRON_ZERO,
          value: '1250000000',
          token_info: { symbol: 'USDT', address: TRON_USDT, decimals: 6 },
        },
        {
          transaction_id: 'fake-in',
          block_timestamp: 1741946000000,
          from: 'TSender',
          to: TRON_ZERO,
          value: '1000000',
          token_info: { symbol: 'USDT', address: 'TFakeToken', decimals: 6 },
        },
      ],
      meta: {},
    },
  });
  const provider = new TronGridProvider({ fetch: mock.fetch, rateSource });
  const activity = await provider.getActivity('tron', TRON_ZERO, testContext());

  assert.equal(mock.calls.length, 3);
  assert.equal(activity.profile.balance, 2.5);
  assert.equal(activity.profile.nativeAsset, 'TRX');
  assert.deepEqual(activity.transfers.map((t) => t.txid), ['fake-in', 'usdt-in', 'trx-out']);
  const [fake, usdt, trx] = activity.transfers;
  assert.match(fake?.asset ?? '', /niezweryfikowany token/);
  assert.equal(usdt?.asset, 'USDT');
  assert.equal(usdt?.amount, 1250);
  assert.equal(usdt?.direction, 'in');
  assert.equal(trx?.asset, 'TRX');
  assert.equal(trx?.amount, 7.5);
  assert.equal(trx?.direction, 'out');
  assert.equal(trx?.counterparty, TRON_USDT);
  assert.equal(trx?.counterpartyClass, 'smart_contract');
  assert.equal(trx?.time, '2025-03-14T10:22:00.000Z');
  assert.ok(activity.limitations.some((text) => /Pobrano po 50 najnowszych/.test(text)));
});
