// Obieg środków (ping-pong): wyszukiwanie na sztucznym grafie przelewów — bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressClass, Transfer } from '@olcys/core';
import { ROUNDTRIP_CAVEAT, ROUNDTRIP_LIMITS, StaticRateSource, findRoundTrips, roundTripParams } from '../src/index.ts';
import type { RoundTripActivity, RoundTripOptions } from '../src/index.ts';

interface Row {
  from: string;
  to: string;
  amount: number;
  time: string;
  asset?: string;
  txid?: string;
}

/** Sztuczny eksplorator: przelewy z księgi, klasy i etykiety adresów z mapy; liczy pobrania. */
function ledger(rows: Row[], classes: Record<string, { cls: AddressClass; label?: string }> = {}) {
  const fetched: string[] = [];
  const activity = (address: string): RoundTripActivity => {
    const transfers: Transfer[] = [];
    rows.forEach((row, index) => {
      const txid = row.txid ?? `tx${String(index).padStart(3, '0')}`;
      const base = { txid, time: row.time, asset: row.asset ?? 'BTC', amount: row.amount, explorerUrl: `https://explorer.example/tx/${txid}` };
      if (row.from === address) transfers.push({ ...base, direction: 'out', counterparty: row.to, counterpartyClass: classes[row.to]?.cls ?? 'unknown', ...(classes[row.to]?.label ? { counterpartyLabel: classes[row.to]!.label! } : {}) });
      if (row.to === address) transfers.push({ ...base, direction: 'in', counterparty: row.from, counterpartyClass: classes[row.from]?.cls ?? 'unknown', ...(classes[row.from]?.label ? { counterpartyLabel: classes[row.from]!.label! } : {}) });
    });
    return { transfers, profile: { addressClass: classes[address]?.cls ?? 'private', ...(classes[address]?.label ? { label: classes[address]!.label! } : {}) } };
  };
  const options = (origin: string, extra: Partial<RoundTripOptions> = {}): RoundTripOptions => ({
    network: 'bitcoin',
    origin,
    originActivity: activity(origin),
    fetchActivity: async (address) => {
      fetched.push(address);
      return activity(address);
    },
    ...extra,
  });
  return { activity, options, fetched };
}

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();

test('bezpośredni ping-pong A→B→A: wykryty z przelewów samego adresu, bez żadnego pobrania', async () => {
  const { options, fetched } = ledger([
    { from: 'A', to: 'B', amount: 1, time: day(1) },
    { from: 'B', to: 'A', amount: 0.98, time: day(3) },
  ]);
  const result = await findRoundTrips(options('A', { budget: 0 }));
  assert.equal(result.cycles.length, 1);
  const cycle = result.cycles[0]!;
  assert.equal(cycle.pattern, 'direct');
  assert.equal(cycle.label, 'bezpośredni ping-pong');
  assert.equal(cycle.hopCount, 2);
  assert.deepEqual(cycle.hops.map((hop) => `${hop.from}>${hop.to}`), ['A>B', 'B>A']);
  assert.equal(cycle.ratio, 0.98);
  assert.equal(cycle.durationHours, 48);
  assert.equal(cycle.sameFunds, 'hypothesis');
  assert.deepEqual(cycle.intermediaries, [{ address: 'B', class: 'unlabelled' }]);
  assert.deepEqual(cycle.returnsTo, { address: 'A', role: 'subject' });
  assert.equal(result.caveat, ROUNDTRIP_CAVEAT);
  assert.deepEqual(fetched, []);
});

test('powtarzany ping-pong z tym samym adresem: każda para osobno, etykieta z liczbą powtórzeń', async () => {
  const { options } = ledger([
    { from: 'A', to: 'B', amount: 1, time: day(1) },
    { from: 'B', to: 'A', amount: 1, time: day(2) },
    { from: 'A', to: 'B', amount: 2, time: day(10) },
    { from: 'B', to: 'A', amount: 1.9, time: day(11) },
    { from: 'A', to: 'B', amount: 3, time: day(20) },
    { from: 'B', to: 'A', amount: 3, time: day(21) },
  ]);
  const result = await findRoundTrips(options('A', { budget: 0 }));
  assert.equal(result.cycles.length, 3);
  assert.ok(result.cycles.every((cycle) => cycle.pattern === 'direct' && cycle.repeats === 3));
  assert.match(result.cycles[0]!.label, /powtarzany: 3 razy/);
});

test('obieg przez 2 adresy pośrednie (3 przelewy) z przebiegiem w czasie i stosunkiem kwot', async () => {
  const { options, fetched } = ledger([
    { from: 'F', to: 'A', amount: 5, time: day(0) },
    { from: 'A', to: 'P1', amount: 2, time: day(1) },
    { from: 'P1', to: 'P2', amount: 1.95, time: day(2) },
    { from: 'P2', to: 'A', amount: 1.9, time: day(4) },
    // Gałąź bez powrotu.
    { from: 'A', to: 'X', amount: 1, time: day(1) },
    { from: 'X', to: 'Y', amount: 1, time: day(2) },
  ]);
  const result = await findRoundTrips(options('A'));
  assert.equal(result.cycles.length, 1);
  const cycle = result.cycles[0]!;
  assert.equal(cycle.pattern, 'intermediaries');
  assert.equal(cycle.label, 'obieg przez adresy pośrednie');
  assert.equal(cycle.hopCount, 3);
  assert.deepEqual(cycle.hops.map((hop) => hop.to), ['P1', 'P2', 'A']);
  assert.equal(cycle.ratio, 0.95);
  assert.equal(cycle.durationHours, 72);
  assert.deepEqual(cycle.intermediaries.map((item) => item.class), ['unlabelled', 'unlabelled']);
  assert.ok(fetched.includes('P1') && fetched.includes('P2'));
  assert.equal(result.stats.cyclesFound, 1);
  assert.equal(result.stats.deepestHop, 2);
});

test('powrót na inny adres tego samego portfela albo inny adres sprawy też zamyka obieg', async () => {
  const { options } = ledger([
    { from: 'A', to: 'P1', amount: 1, time: day(1) },
    { from: 'P1', to: 'A2', amount: 1, time: day(2) },
    { from: 'A', to: 'Q1', amount: 1, time: day(1) },
    { from: 'Q1', to: 'C', amount: 1, time: day(2) },
  ]);
  const result = await findRoundTrips(options('A', { cluster: ['A2'], caseAddresses: ['C'] }));
  const roles = result.cycles.map((cycle) => `${cycle.returnsTo.address}:${cycle.returnsTo.role}`).sort();
  assert.deepEqual(roles, ['A2:cluster', 'C:case']);
});

test('powrót z giełdy: obieg „przez giełdę” jako hipoteza; historii giełdy nie pobieramy', async () => {
  const classes = { EX: { cls: 'exchange' as const, label: 'Giełda Testowa: Hot Wallet' } };
  const { options, fetched } = ledger(
    [
      { from: 'A', to: 'P1', amount: 1, time: day(1) },
      { from: 'P1', to: 'EX', amount: 1, time: day(2) },
      { from: 'EX', to: 'A', amount: 0.97, time: day(9) },
    ],
    classes,
  );
  const result = await findRoundTrips(options('A'));
  assert.ok(!fetched.includes('EX'), 'adres giełdy nie jest pobierany');
  const viaExchange = result.cycles.find((cycle) => cycle.hopCount === 3)!;
  assert.equal(viaExchange.pattern, 'exchange');
  assert.equal(viaExchange.label, 'obieg przez giełdę');
  assert.equal(viaExchange.sameFunds, 'hypothesis');
  assert.match(viaExchange.note, /NIE dowodzi/);
  assert.deepEqual(viaExchange.intermediaries.map((item) => item.class), ['unlabelled', 'exchange']);
  assert.equal(viaExchange.intermediaries[1]!.label, 'Giełda Testowa: Hot Wallet');
  assert.ok(result.stops.some((stop) => stop.reason === 'service_reached'));
});

test('ping-pong z mikserem bezpośrednio: wzorzec „obieg przez mikser”', async () => {
  const { options } = ledger(
    [
      { from: 'A', to: 'MIX', amount: 0.3, time: day(1) },
      { from: 'MIX', to: 'A', amount: 0.29, time: day(30) },
    ],
    { MIX: { cls: 'mixer', label: 'WirMix' } },
  );
  const result = await findRoundTrips(options('A'));
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0]!.pattern, 'mixer');
});

test('okno czasu: powrót po 200 dniach przy oknie 180 dni nie jest obiegiem; powód zatrzymania „time_window”', async () => {
  const { options } = ledger([
    { from: 'A', to: 'P1', amount: 1, time: day(1) },
    { from: 'P1', to: 'P2', amount: 1, time: day(2) },
    { from: 'P2', to: 'A', amount: 1, time: day(201) },
  ]);
  const result = await findRoundTrips(options('A'));
  assert.equal(result.cycles.length, 0);
  assert.ok(result.stops.some((stop) => stop.reason === 'time_window'));
  const wider = await findRoundTrips(options('A', { windowDays: 365 }));
  assert.equal(wider.cycles.length, 1);
});

test('budżet pobrań: zatrzymanie z powodem „budget” i liczbą pominiętych adresów', async () => {
  const { options, fetched } = ledger([
    { from: 'A', to: 'P1', amount: 3, time: day(1) },
    { from: 'A', to: 'P2', amount: 2, time: day(1) },
    { from: 'A', to: 'P3', amount: 1, time: day(1) },
    { from: 'P1', to: 'Q1', amount: 3, time: day(2) },
    { from: 'Q1', to: 'A', amount: 3, time: day(3) },
  ]);
  const result = await findRoundTrips(options('A', { budget: 2 }));
  assert.equal(fetched.length, 2);
  const budget = result.stops.find((stop) => stop.reason === 'budget')!;
  assert.ok(budget.count >= 2);
  assert.equal(result.stats.addressesFetched, 2);
  // Zewnętrzny budżet (np. rozwinięcia) też zatrzymuje wyszukiwanie.
  let allowed = 1;
  const external = await findRoundTrips(options('A', { reserve: () => allowed-- > 0 }));
  assert.equal(external.stats.addressesFetched, 1);
  assert.ok(external.stops.some((stop) => stop.reason === 'budget'));
});

test('limit kroków: obieg dłuższy niż maxHops nie jest zgłaszany; powód „max_hops”', async () => {
  const rows: Row[] = [{ from: 'A', to: 'N1', amount: 1, time: day(1) }];
  for (let i = 1; i < 6; i++) rows.push({ from: `N${i}`, to: `N${i + 1}`, amount: 1, time: day(1 + i) });
  rows.push({ from: 'N6', to: 'A', amount: 1, time: day(10) });
  const { options } = ledger(rows);
  const short = await findRoundTrips(options('A', { maxHops: 4 }));
  assert.equal(short.cycles.length, 0);
  assert.ok(short.stops.some((stop) => stop.reason === 'max_hops'));
  const long = await findRoundTrips(options('A', { maxHops: 7 }));
  assert.equal(long.cycles.length, 1);
  assert.equal(long.cycles[0]!.hopCount, 7);
});

test('pętle w grafie przelewów (P1↔P2, P2→P1→…) nie zapętlają wyszukiwania; każdy adres pobrany najwyżej raz', async () => {
  const { options, fetched } = ledger([
    { from: 'A', to: 'P1', amount: 1, time: day(1) },
    { from: 'P1', to: 'P2', amount: 1, time: day(2) },
    { from: 'P2', to: 'P1', amount: 1, time: day(3) },
    { from: 'P1', to: 'P2', amount: 1, time: day(4) },
    { from: 'P2', to: 'P3', amount: 1, time: day(5) },
    { from: 'P3', to: 'P1', amount: 1, time: day(6) },
  ]);
  const result = await findRoundTrips(options('A', { maxHops: 50, budget: 200 }));
  assert.equal(result.cycles.length, 0);
  assert.equal(new Set(fetched).size, fetched.length);
  assert.ok(fetched.length <= 3);
});

test('limit 50 kroków: długi łańcuch z powrotem po 50 przelewach jest wykryty, po 51 — nie; parametry przycięte do limitów', async () => {
  const chain = (length: number) => {
    const rows: Row[] = [{ from: 'A', to: 'N1', amount: 1, time: day(0) }];
    for (let i = 1; i < length - 1; i++) rows.push({ from: `N${i}`, to: `N${i + 1}`, amount: 1, time: day(i) });
    rows.push({ from: `N${length - 1}`, to: 'A', amount: 1, time: day(length) });
    return rows;
  };
  const fifty = await findRoundTrips(ledger(chain(50)).options('A', { maxHops: 50, budget: 200 }));
  assert.equal(fifty.cycles.length, 1);
  assert.equal(fifty.cycles[0]!.hopCount, 50);
  const tooLong = await findRoundTrips(ledger(chain(51)).options('A', { maxHops: 999, budget: 200 }));
  assert.equal(tooLong.params.maxHops, ROUNDTRIP_LIMITS.maxHops);
  assert.equal(tooLong.cycles.length, 0);
  assert.ok(tooLong.stops.some((stop) => stop.reason === 'max_hops'));
  assert.deepEqual(roundTripParams({ maxHops: 1, budget: 10_000, windowDays: 0 }), { maxHops: 2, budget: 200, windowDays: 1, fanOut: 3, minShare: 0.05 });
});

test('przycinanie rozgałęzień: tylko największe udziały, drobne kwoty pominięte', async () => {
  const rows: Row[] = [{ from: 'A', to: 'P', amount: 10, time: day(1) }];
  for (let i = 1; i <= 5; i++) rows.push({ from: 'P', to: `S${i}`, amount: i, time: day(2) });
  rows.push({ from: 'P', to: 'DUST', amount: 0.01, time: day(2) });
  rows.push({ from: 'S1', to: 'A', amount: 1, time: day(3) });
  rows.push({ from: 'S5', to: 'A', amount: 5, time: day(3) });
  const { options, fetched } = ledger(rows);
  const result = await findRoundTrips(options('A', { fanOut: 3 }));
  assert.ok(!fetched.includes('S1') && !fetched.includes('DUST'));
  assert.ok(fetched.includes('S5'));
  assert.deepEqual(result.cycles.map((cycle) => cycle.hops[1]!.to), ['S5']);
  assert.ok(result.stops.some((stop) => stop.reason === 'fan_out'));
  assert.ok(result.stops.some((stop) => stop.reason === 'dust'));
});

test('wycena kroków w PLN i stosunek wartości dla różnych walut', async () => {
  const { options } = ledger([
    { from: 'A', to: 'SW', amount: 1, time: '2025-06-30T16:44:00Z', asset: 'ETH' },
    { from: 'SW', to: 'A', amount: 2450, time: '2025-06-30T16:44:30Z', asset: 'USDT' },
  ], { SW: { cls: 'smart_contract', label: 'Router' } });
  const result = await findRoundTrips(options('A', { rateSource: new StaticRateSource() }));
  const cycle = result.cycles[0]!;
  assert.equal(cycle.pattern, 'contract');
  assert.ok(cycle.out.valuePln && cycle.back.valuePln, 'obie strony wycenione');
  assert.ok(cycle.ratio !== undefined && cycle.ratio > 0);
  assert.ok(cycle.hops.every((hop) => hop.valuation));
});
