import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Dossier, GraphNode } from '@olcys/core';
import { isMixerNode, mixerBadgeText, mixerBanner, mixerExposureOf } from '../src/mixers.ts';
import type { MixerExposure, MixerTransfer } from '../src/mixers.ts';

const out = (txid: string, valuePln?: number): MixerTransfer => ({
  direction: 'to_mixer',
  address: 'bc1q-podmiot',
  network: 'bitcoin',
  txid,
  time: '2026-03-10T10:00:00.000Z',
  asset: 'BTC',
  amount: 0.1,
  ...(valuePln !== undefined ? { valuePln } : {}),
  mixerAddress: 'bc1q-mikser',
  mixerLabel: 'Wasabi: koordynator',
  mixerName: 'Wasabi',
  labelSource: 'zbiór testowy',
  status: 'computed',
  explorerUrl: 'https://explorer.example/tx/1',
});

const exposure = (change: Partial<MixerExposure>): MixerExposure => ({
  level: 'none',
  statement: '',
  mixers: [],
  outgoing: [],
  incoming: [],
  coinjoins: [],
  traceStops: [],
  sanctions: [],
  totals: { transactions: 0, outCount: 0, inCount: 0, unvalued: 0 },
  addresses: [],
  limitations: [],
  ...change,
});

test('baner mikserów: oznaczony mikser — czerwony, nazwa, liczba transakcji i kwota w skrócie', () => {
  const banner = mixerBanner(exposure({ level: 'confirmed', mixers: ['Wasabi'], outgoing: [out('a', 30_000), out('b', 18_000)], totals: { transactions: 2, outCount: 2, inCount: 0, outPln: 48_000, unvalued: 0 } }));
  assert.equal(banner.tone, 'confirmed');
  // Skrót kwoty z Intl zawiera twardą spację — porównujemy po jej zamianie.
  assert.equal(banner.text.replace(/ /g, ' '), 'Środki przeszły przez mikser (Wasabi, 2 transakcje, ok. 48 tys. zł do miksera) — dalsza droga nieustalona');
  // Kierunków nie sumujemy: sam wpływ z miksera podaje kwotę „z miksera”.
  const inflowOnly = mixerBanner(exposure({ level: 'confirmed', mixers: ['Wasabi'], incoming: [{ ...out('e', 20_000), direction: 'from_mixer' }], totals: { transactions: 1, outCount: 0, inCount: 1, inPln: 20_000, unvalued: 0 } }));
  assert.match(inflowOnly.text.replace(/ /g, ' '), /ok\. 20 tys\. zł z miksera\)/);
});

test('baner mikserów: bez wyceny bez kwoty; wpływ z miksera dopisuje zatarte pochodzenie; sama heurystyka — bursztynowy', () => {
  const unvalued = mixerBanner(exposure({ level: 'confirmed', mixers: ['WirMix'], incoming: [{ ...out('c'), direction: 'from_mixer' }] }));
  assert.equal(unvalued.text, 'Środki przeszły przez mikser (WirMix, 1 transakcja) — dalsza droga nieustalona');
  assert.match(unvalued.note, /pochodzenie zatarte/);

  const possible = mixerBanner(
    exposure({ level: 'possible', coinjoins: [{ address: 'a', network: 'bitcoin', txid: 'd', basis: 'equal_outputs', status: 'hypothesis', explanation: 'x' }] }),
  );
  assert.equal(possible.tone, 'possible');
  assert.equal(possible.text, 'Możliwy udział w mikserze lub CoinJoin (1 transakcja) — hipoteza, dalsza droga nieustalona');
  assert.equal(mixerBadgeText(exposure({ level: 'possible' })), 'możliwy mikser');
  assert.equal(mixerBadgeText(exposure({ level: 'confirmed' })), 'mikser');
});

test('ekspozycja z teczki: brak pola (starsza usługa) albo poziom „brak” → nic do pokazania; węzeł miksera po oznaczeniu', () => {
  const base = { graph: { nodes: [], edges: [] } } as unknown as Dossier;
  assert.equal(mixerExposureOf(base), undefined);
  assert.equal(mixerExposureOf({ ...base, mixerExposure: exposure({}) } as unknown as Dossier), undefined);
  assert.equal(mixerExposureOf({ ...base, mixerExposure: exposure({ level: 'possible' }) } as unknown as Dossier)?.level, 'possible');

  const plain: GraphNode = { id: 'svc:gielda', kind: 'service', label: 'Giełda' };
  assert.equal(isMixerNode(plain), false);
  assert.equal(isMixerNode({ ...plain, mixer: { kind: 'labelled' } } as GraphNode), true);
});
