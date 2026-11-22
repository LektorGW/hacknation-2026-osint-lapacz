// Regresja: przelew z badanego adresu na ten sam adres nie jest wypływem. Zostaje w historii,
// ale bez przepływu netto — nie wchodzi do sumy wydatków, wypływów ani wskaźników wypłat.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BlockscoutProvider } from '../src/providers/blockscout.ts';
import { TronGridProvider } from '../src/providers/trongrid.ts';
import { StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const rateSource = new StaticRateSource({ source: 'tabela testowa', rates: { ETH: { '2025-05': 10000 }, USDT: { '2025-03': 4, '2025-06': 3.7 } } });

const ETH_SUBJECT = '0x52908400098527886E0F7030069857D2E4169EE7';
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const SCOUT = 'https://eth.blockscout.com';

test('blockscout: przelew ETH i tokenu na własny adres zostaje w historii bez przepływu netto', async () => {
  const mock = mockFetch({
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}`]: { hash: ETH_SUBJECT, is_contract: false, name: null, coin_balance: '3000000000000000000' },
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}/transactions`]: {
      items: [
        {
          hash: '0xself',
          timestamp: '2025-05-10T12:00:00.000000Z',
          status: 'ok',
          value: '2000000000000000000',
          // Wielkość liter adresu różna po obu stronach — to nadal ten sam adres.
          from: { hash: ETH_SUBJECT.toLowerCase(), is_contract: false },
          to: { hash: ETH_SUBJECT, is_contract: false },
        },
        {
          hash: '0xfund',
          timestamp: '2025-05-01T12:00:00.000000Z',
          status: 'ok',
          value: '3000000000000000000',
          from: { hash: '0x1111111111111111111111111111111111111111', is_contract: false },
          to: { hash: ETH_SUBJECT, is_contract: false },
        },
      ],
      next_page_params: null,
    },
    [`${SCOUT}/api/v2/addresses/${ETH_SUBJECT}/token-transfers?type=ERC-20`]: {
      items: [
        {
          transaction_hash: '0xselftoken',
          timestamp: '2025-06-02T09:00:00.000000Z',
          from: { hash: ETH_SUBJECT, is_contract: false },
          to: { hash: ETH_SUBJECT.toLowerCase(), is_contract: false },
          token: { symbol: 'USDT', decimals: '6', address_hash: USDT_CONTRACT },
          total: { value: '5000000000', decimals: '6' },
        },
      ],
      next_page_params: null,
    },
  });
  const activity = await new BlockscoutProvider({ fetch: mock.fetch, rateSource }).getActivity('ethereum', ETH_SUBJECT, testContext());

  assert.deepEqual(activity.transfers.map((t) => t.txid), ['0xfund', '0xself', '0xselftoken']);
  for (const txid of ['0xself', '0xselftoken']) {
    const item = activity.transfers.find((t) => t.txid === txid)!;
    assert.equal(item.amount, 0, txid);
    assert.notEqual(item.direction, 'out', txid);
    assert.equal(item.counterparty.toLowerCase(), ETH_SUBJECT.toLowerCase(), txid);
  }
  assert.equal(activity.profile.totalSent, 0);
  assert.equal(activity.profile.totalReceived, 3);
  assert.equal(activity.profile.balance, 3);
  assert.ok(!activity.transfers.some((t) => t.direction === 'out'));
  assert.deepEqual(activity.cashOuts, []);
  assert.deepEqual(activity.trails ?? [], []);
});

const GRID = 'https://api.trongrid.io';
const TRON_SUBJECT = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const TRON_SUBJECT_HEX = '410000000000000000000000000000000000000000';
const TRON_USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

test('trongrid: przelew TRX i TRC-20 na własny adres zostaje w historii bez przepływu netto', async () => {
  const mock = mockFetch({
    [`${GRID}/v1/accounts/${TRON_SUBJECT}`]: { data: [{ balance: 2_500_000 }], success: true },
    [`${GRID}/v1/accounts/${TRON_SUBJECT}/transactions?limit=50&only_confirmed=true`]: {
      data: [
        {
          txID: 'trx-self',
          block_timestamp: 1741947720000,
          ret: [{ contractRet: 'SUCCESS' }],
          raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { amount: 7_500_000, owner_address: TRON_SUBJECT_HEX, to_address: TRON_SUBJECT_HEX } } }] },
        },
      ],
      meta: {},
    },
    [`${GRID}/v1/accounts/${TRON_SUBJECT}/transactions/trc20?limit=50&only_confirmed=true`]: {
      data: [
        {
          transaction_id: 'usdt-self',
          block_timestamp: 1741947000000,
          from: TRON_SUBJECT,
          to: TRON_SUBJECT,
          value: '1250000000',
          token_info: { symbol: 'USDT', address: TRON_USDT, decimals: 6 },
        },
        {
          transaction_id: 'usdt-in',
          block_timestamp: 1741946000000,
          from: 'TSender',
          to: TRON_SUBJECT,
          value: '1000000',
          token_info: { symbol: 'USDT', address: TRON_USDT, decimals: 6 },
        },
      ],
      meta: {},
    },
  });
  const activity = await new TronGridProvider({ fetch: mock.fetch, rateSource }).getActivity('tron', TRON_SUBJECT, testContext());

  assert.deepEqual(activity.transfers.map((t) => t.txid), ['usdt-in', 'usdt-self', 'trx-self']);
  for (const txid of ['usdt-self', 'trx-self']) {
    const item = activity.transfers.find((t) => t.txid === txid)!;
    assert.equal(item.amount, 0, txid);
    assert.notEqual(item.direction, 'out', txid);
    assert.equal(item.counterparty, TRON_SUBJECT, txid);
  }
  assert.equal(activity.transfers.find((t) => t.txid === 'usdt-in')!.amount, 1);
  assert.equal(activity.profile.totalSent, 0);
  assert.ok(!activity.transfers.some((t) => t.direction === 'out'));
  assert.deepEqual(activity.cashOuts, []);
});
