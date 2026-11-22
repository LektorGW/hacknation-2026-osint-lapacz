import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServiceLink } from '@olcys/core';
import { moneyDestinations, moneyServicesView } from '../src/proof.ts';
import type { CashOutProof } from '../src/proof.ts';

const link = (name: string, change: Partial<ServiceLink> = {}): ServiceLink => ({
  id: name.toLowerCase(),
  name,
  kind: 'exchange',
  networks: ['bitcoin'],
  basis: ['transfer_out'],
  strength: 80,
  reasons: [],
  inferredOnly: false,
  transfersOut: 1,
  transfersIn: 0,
  transfers: [],
  mentions: [],
  requestHints: [],
  ...change,
});

const proof = (id: string, serviceName: string, valuePln?: number, trailId = id): CashOutProof =>
  ({
    id,
    person: null,
    address: 'adres-osoby',
    network: 'tron',
    addressBasis: 'published',
    personAddressProbability: 90,
    trailConfidence: 95,
    combinedConfidence: 95,
    tier: 'bardzo wysoka',
    components: [],
    layer: 'calculation',
    serviceName,
    statement: '',
    trail: { id: trailId, sourceAddress: 'adres-osoby', network: 'tron', hops: [], serviceName, serviceKind: 'p2p_service', asset: 'USDT', amount: 1, ...(valuePln !== undefined ? { valuePln } : {}), confidence: 95, reasons: [], openQuestions: [] },
  }) as CashOutProof;

test('kafel pieniędzy: usługa tylko z dowodu spieniężenia (kantor P2P) trafia na listę z kwotą z dowodu', () => {
  const list = moneyDestinations([], [proof('p1', 'KantorKrypto P2P', 10_860)]);
  assert.deepEqual(list, [{ name: 'KantorKrypto P2P', pln: 10_860, transfers: 1, inferred: false, source: 'proof' }]);
  // Zdanie „Nie stwierdzono powiązań…” nie może stać obok listy.
  assert.equal(moneyServicesView({ destinations: list.length, serviceLinks: 0, money: 10_860, proofs: 1, fiatSignals: 4 }), 'list');
});

test('kafel pieniędzy: przelewy i dowody łączone po nazwie („Kraken.com” = „Kraken”), brakująca wycena z dowodu', () => {
  const list = moneyDestinations(
    [link('Kraken', { transfersOut: 3 }), link('Giełda Bursztyn', { transfersOut: 2, outPln: 50_000 }), link('Binance', { transfersOut: 0, transfersIn: 2 })],
    [proof('p1', 'Kraken.com', 120_000), proof('p2', 'KantorKrypto P2P', 9_000), proof('p3', 'Giełda Bursztyn', 1)],
  );
  assert.deepEqual(
    list.map((item) => [item.name, item.pln, item.source]),
    [
      ['Kraken', 120_000, 'transfers'],
      ['Giełda Bursztyn', 50_000, 'transfers'],
      ['KantorKrypto P2P', 9_000, 'proof'],
    ],
  );
  // Usługa wyłącznie z wpływami (Binance → podmiot) nie jest miejscem, dokąd trafiły pieniądze.
  assert.ok(!list.some((item) => item.name === 'Binance'));
});

test('kafel pieniędzy: wspólna ścieżka kilku dowodów liczona raz; dowód bez wyceny — bez kwoty', () => {
  const list = moneyDestinations([], [proof('a', 'KantorKrypto P2P', 5_000, 'trasa-1'), proof('b', 'KantorKrypto P2P', 5_000, 'trasa-1'), proof('c', 'Bitget')]);
  assert.deepEqual(list[0], { name: 'KantorKrypto P2P', pln: 5_000, transfers: 1, inferred: false, source: 'proof' });
  assert.equal(list[1]!.name, 'Bitget');
  assert.equal(list[1]!.pln, undefined);
});

test('kafel pieniędzy: „Nie stwierdzono powiązań” tylko bez kwoty, dowodów, oznak wypłaty i powiązań', () => {
  const empty = { destinations: 0, serviceLinks: 0, money: 0, proofs: 0, fiatSignals: 0 };
  assert.equal(moneyServicesView(empty), 'none');
  assert.equal(moneyServicesView({ ...empty, money: 10_860 }), 'unnamed');
  assert.equal(moneyServicesView({ ...empty, proofs: 1 }), 'unnamed');
  assert.equal(moneyServicesView({ ...empty, fiatSignals: 4 }), 'unnamed');
  assert.equal(moneyServicesView({ ...empty, serviceLinks: 1 }), 'chips');
  assert.deepEqual(moneyDestinations(undefined, undefined), []);
});
