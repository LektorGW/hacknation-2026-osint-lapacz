// Powiązanie przez płatność: zasilenie adresu to przelew (fakt z blockchaina), a nie „powiązanie z inną osobą”.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressLinkGraph } from '../src/network.ts';
import { BTC_A, BTC_B, BTC_C, finding } from './helpers.ts';

const subject = () => ({
  ...finding(BTC_A, 85, []),
  relatedAddresses: [
    { address: BTC_B, kind: 'funds' as const, strength: 55, reason: 'HEURYSTYKA „zasilony adres”: pierwszą wpłatą na ten adres był przelew z adresu podmiotu.', txids: ['t1'] },
    { address: BTC_C, kind: 'funded_by' as const, strength: 50, reason: 'HEURYSTYKA „źródło zasilenia”.', txids: ['t2', 't3'] },
  ],
});
const existing = { nodes: [{ id: `addr:bitcoin:${BTC_A}`, kind: 'address' as const, label: 'A' }], edges: [] };

test('zasilenie adresu to płatność: fakt źródłowy z kierunkiem, interpretacja zostaje hipotezą w wyjaśnieniu', () => {
  const { nodes, edges } = addressLinkGraph([subject()], existing);
  const paid = edges.find((edge) => edge.to === `addr:bitcoin:${BTC_B}`)!;
  assert.equal(paid.kind, 'payment');
  assert.equal(paid.status, 'source_fact');
  assert.equal(paid.layer, 'chain');
  assert.equal(paid.from, `addr:bitcoin:${BTC_A}`);
  assert.match(paid.label!, /płatność z adresu sprawy/);
  assert.match(paid.explanation!, /nowy portfel tej samej osoby czy ktoś, komu zapłacono \(hipoteza\)/);
  assert.deepEqual(paid.evidence, [{ kind: 'txid', value: 't1' }]);

  // Wpłata NA adres sprawy: kierunek odwrotny, kilka przelewów.
  const received = edges.find((edge) => edge.from === `addr:bitcoin:${BTC_C}`)!;
  assert.equal(received.kind, 'payment');
  assert.equal(received.to, `addr:bitcoin:${BTC_A}`);
  assert.match(received.label!, /2 przelewy\) na adres sprawy/);

  // Żaden z tych adresów nie staje się osobą.
  assert.ok(nodes.every((node) => node.kind === 'address'));
  assert.ok(!edges.some((edge) => edge.kind === 'related'));
});
