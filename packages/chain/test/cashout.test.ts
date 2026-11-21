import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressClass, CashOutKind } from '@olcys/core';
import { detectCashOuts } from '../src/cashout.ts';
import type { ClassifiedTransfer } from '../src/cashout.ts';

let counter = 0;

function transfer(partial: Partial<ClassifiedTransfer>): ClassifiedTransfer {
  counter += 1;
  return {
    txid: `tx${counter}`,
    time: '2025-03-14T10:00:00Z',
    direction: 'out',
    counterparty: `addr${counter}`,
    counterpartyClass: 'unknown',
    asset: 'BTC',
    amount: 0.5,
    explorerUrl: `https://example.test/tx${counter}`,
    ...partial,
  };
}

const direct: { kind: CashOutKind; counterpartyClass: AddressClass; label: string; expect: RegExp }[] = [
  { kind: 'exchange_deposit', counterpartyClass: 'exchange', label: 'Giełda X', expect: /giełdy kryptowalut/ },
  { kind: 'p2p_service', counterpartyClass: 'institutional', label: 'Serwis P2P', expect: /P2P/ },
  { kind: 'payment_gateway', counterpartyClass: 'institutional', label: 'Bramka Y', expect: /bramki płatniczej/ },
  { kind: 'crypto_card', counterpartyClass: 'institutional', label: 'Karta Z', expect: /kartę płatniczą/ },
];

for (const item of direct) {
  test(`przelew wychodzący do usługi rodzaju ${item.kind} jest wskaźnikiem wypłaty`, () => {
    const out = transfer({ counterpartyKind: item.kind, counterpartyClass: item.counterpartyClass, counterpartyLabel: item.label });
    const [indicator, ...rest] = detectCashOuts([out]);
    assert.equal(rest.length, 0);
    assert.equal(indicator?.kind, item.kind);
    assert.equal(indicator?.txid, out.txid);
    assert.equal(indicator?.amount, 0.5);
    assert.equal(indicator?.counterpartyLabel, item.label);
    assert.equal(indicator?.explorerUrl, out.explorerUrl);
    assert.match(indicator?.explanation ?? '', item.expect);
  });
}

test('klasa giełdy wystarcza bez podanego rodzaju; drobne kwoty też są zgłaszane', () => {
  const result = detectCashOuts([transfer({ counterpartyClass: 'exchange', amount: 0.0001 })]);
  assert.equal(result[0]?.kind, 'exchange_deposit');
});

test('przelewy przychodzące i przelewy do adresów prywatnych nie są wypłatami', () => {
  const result = detectCashOuts([
    transfer({ direction: 'in', counterpartyClass: 'exchange', counterpartyKind: 'exchange_deposit' }),
    transfer({ counterpartyClass: 'private' }),
    transfer({ counterpartyClass: 'unknown' }),
  ]);
  assert.deepEqual(result, []);
});

test('zamiana na stablecoiny: wyjście do kontraktu i przyjście USDT w oknie czasu', () => {
  const out = transfer({ asset: 'ETH', amount: 2, counterpartyClass: 'smart_contract', time: '2025-05-01T12:00:00Z' });
  const stable = transfer({ direction: 'in', asset: 'USDT', amount: 5000, time: '2025-05-01T12:05:00Z' });
  const result = detectCashOuts([stable, out]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'stablecoin_swap');
  assert.equal(result[0]?.asset, 'ETH');
  assert.match(result[0]?.explanation ?? '', /stablecoiny/);
  assert.match(result[0]?.explanation ?? '', /USDT/);
});

test('zamiana na stablecoiny: przyjście po oknie czasu albo przed wyjściem nie liczy się', () => {
  const out = transfer({ asset: 'ETH', amount: 2, counterpartyClass: 'smart_contract', time: '2025-05-01T12:00:00Z' });
  const late = transfer({ direction: 'in', asset: 'USDC', amount: 5000, time: '2025-05-01T13:00:00Z' });
  const early = transfer({ direction: 'in', asset: 'USDC', amount: 5000, time: '2025-05-01T11:59:00Z' });
  assert.deepEqual(detectCashOuts([out, late, early]), []);
  assert.equal(detectCashOuts([out, late], { swapWindowMinutes: 90 }).length, 1);
});

test('zamiana na stablecoiny: próg znacznej wartości jest konfigurowalny', () => {
  const out = transfer({ asset: 'ETH', amount: 0.4, counterpartyClass: 'smart_contract', time: '2025-05-01T12:00:00Z' });
  const stable = transfer({ direction: 'in', asset: 'USDT', amount: 1000, time: '2025-05-01T12:01:00Z' });
  assert.deepEqual(detectCashOuts([out, stable]), []);
  assert.equal(detectCashOuts([out, stable], { significantAmounts: { ETH: 0.25 } }).length, 1);
  assert.deepEqual(detectCashOuts([out, stable], { significantAmounts: { BTC: 0.01 } }), [], 'waluta spoza tabeli nie jest oceniana');
});

test('zamiana na stablecoiny: adres usługi zamiany wystarcza bez widocznego przyjścia', () => {
  const big = transfer({ amount: 0.5, counterpartyKind: 'stablecoin_swap', counterpartyLabel: 'StableSwap' });
  const small = transfer({ amount: 0.001, counterpartyKind: 'stablecoin_swap' });
  const result = detectCashOuts([big, small]);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.txid, big.txid);
  assert.equal(result[0]?.kind, 'stablecoin_swap');
});

test('jedno przyjście stablecoinów potwierdza tylko jedną zamianę; wyjście stablecoina nie jest zamianą', () => {
  const first = transfer({ asset: 'ETH', amount: 2, counterpartyClass: 'smart_contract', time: '2025-05-01T12:00:00Z' });
  const second = transfer({ asset: 'ETH', amount: 3, counterpartyClass: 'smart_contract', time: '2025-05-01T12:02:00Z' });
  const stable = transfer({ direction: 'in', asset: 'USDT', amount: 5000, time: '2025-05-01T12:03:00Z' });
  const stableOut = transfer({ asset: 'USDT', amount: 9000, counterpartyClass: 'smart_contract', time: '2025-05-01T12:02:30Z' });
  const result = detectCashOuts([first, second, stable, stableOut]);
  assert.deepEqual(result.map((item) => item.txid), [first.txid]);
});

test('zamiana w jednej transakcji (ten sam identyfikator) jest wykrywana', () => {
  const out = transfer({ txid: 'swap', asset: 'ETH', amount: 1.5, counterpartyClass: 'smart_contract', time: '2025-05-01T12:00:00Z' });
  const stable = transfer({ txid: 'swap', direction: 'in', asset: 'USDC', amount: 4000, time: '2025-05-01T12:00:00Z' });
  assert.equal(detectCashOuts([out, stable]).length, 1);
});
