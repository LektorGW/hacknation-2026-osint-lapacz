// „Szukaj dalej” — obieg środków (ping-pong) jako rozwinięcie sieci: zapis trwały, krawędzie-fakty, postęp, wycofanie.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Transfer } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, FIXED_NOW, chainWith, fakeConnector } from './helpers.ts';

let app: FastifyInstance;
let storage: Storage;
const fetchedAddresses: string[] = [];

/** Księga: A→B→C→A (3 przelewy, 2 adresy pośrednie) i bezpośredni ping-pong A→D→A. */
const ROWS = [
  { from: BTC_A, to: BTC_B, amount: 1, time: '2026-03-01T10:00:00.000Z' },
  { from: BTC_B, to: BTC_C, amount: 0.98, time: '2026-03-02T10:00:00.000Z' },
  { from: BTC_C, to: BTC_A, amount: 0.97, time: '2026-03-04T10:00:00.000Z' },
  { from: BTC_A, to: BTC_D, amount: 0.5, time: '2026-04-01T10:00:00.000Z' },
  { from: BTC_D, to: BTC_A, amount: 0.5, time: '2026-04-02T10:00:00.000Z' },
];

function transfersOf(address: string): Transfer[] {
  const list: Transfer[] = [];
  ROWS.forEach((row, index) => {
    const txid = (index + 1).toString(16).padStart(64, '0');
    const base = { txid, time: row.time, asset: 'BTC', amount: row.amount, counterpartyClass: 'unknown' as const, explorerUrl: `https://explorer.example/tx/${txid}` };
    if (row.from === address) list.push({ ...base, direction: 'out', counterparty: row.to });
    if (row.to === address) list.push({ ...base, direction: 'in', counterparty: row.from });
  });
  return list;
}

before(async () => {
  storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'obieg_test' ? [{ url: 'https://gitpub.example/obieg_test', author: 'obieg_test', text: `Wsparcie: ${BTC_A}.`, profile: { handle: 'obieg_test' } }] : [],
  );
  const base = chainWith(Object.fromEntries([BTC_A, BTC_B, BTC_C, BTC_D].map((address) => [address, { transfers: transfersOf(address) }])));
  const provider = {
    ...base,
    getActivity: async (...args: Parameters<typeof base.getActivity>) => {
      fetchedAddresses.push(args[1]);
      return base.getActivity(...args);
    },
  };
  app = await buildApp({ storage, connectors: [gitpub], chainProviders: [provider], now: FIXED_NOW, network: { sanctions: [], organizations: null, rdap: null } });
});
after(() => app.close());

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

async function caseWithRun(): Promise<string> {
  const created = (await post('/api/cases', { name: 'Obieg', identifiers: [{ type: 'nick', value: 'obieg_test' }] })).json();
  assert.equal((await post(`/api/cases/${created.id}/runs`)).statusCode, 201);
  return created.id;
}

test('Szukaj dalej: obieg przez 2 adresy pośrednie i bezpośredni ping-pong; zapis trwały, krawędzie-fakty, postęp', async () => {
  const caseId = await caseWithRun();
  const anchor = `addr:bitcoin:${BTC_A}`;
  const plan = (await app.inject(`/api/cases/${caseId}/network/plan?nodeId=${encodeURIComponent(anchor)}`)).json();
  assert.equal(plan.expandable, true);
  assert.ok(!plan.groups.some((group: { id: string }) => group.id === 'roundtrip'), 'obieg nie jest polem wyboru zwykłego „Rozwiń”');
  assert.equal(plan.roundtrip.available, true);
  assert.equal(plan.roundtrip.limits.maxHops, 50);

  fetchedAddresses.length = 0;
  const response = await post(`/api/cases/${caseId}/network/expand`, { nodeId: anchor, relations: ['roundtrip'], roundtrip: { maxHops: 12, budget: 30, windowDays: 90 }, force: true });
  assert.equal(response.statusCode, 201);
  const { expansion } = response.json();
  assert.deepEqual(expansion.relations, ['roundtrip']);
  const report = expansion.results.roundtrip;
  assert.ok(report, 'wynik obiegu w zapisie rozwinięcia');
  assert.equal(report.anchor, anchor);
  assert.deepEqual(report.params, { maxHops: 12, budget: 30, windowDays: 90, fanOut: 3, minShare: 0.05 });
  assert.match(report.caveat, /hipotezą/);
  const patterns = report.cycles.map((cycle: { pattern: string; hopCount: number }) => `${cycle.pattern}:${cycle.hopCount}`).sort();
  assert.deepEqual(patterns, ['direct:2', 'intermediaries:3']);
  const layered = report.cycles.find((cycle: { pattern: string }) => cycle.pattern === 'intermediaries');
  assert.deepEqual(layered.nodeIds, [anchor, `addr:bitcoin:${BTC_B}`, `addr:bitcoin:${BTC_C}`, anchor]);
  assert.equal(layered.ratio, 0.97);
  // Wycena orientacyjna (kurs przykładowy) przy każdym kroku.
  assert.ok(layered.hops.every((hop: { valuePln?: number }) => typeof hop.valuePln === 'number'));
  // Krawędzie-przelewy: fakt źródłowy, warstwa blockchain, txid w dowodach.
  for (const id of layered.edgeIds) {
    const edge = expansion.results.edges.find((item: { id: string }) => item.id === id);
    assert.ok(edge, `krawędź ${id} w zapisie`);
    assert.equal(edge.kind, 'transfer');
    assert.equal(edge.status, 'source_fact');
    assert.equal(edge.layer, 'chain');
    assert.ok(edge.evidence.some((item: { kind: string }) => item.kind === 'txid'));
  }
  // Adres badany jest w teczce — pobierano tylko adresy pośrednie (B, C, D), każdy raz.
  assert.deepEqual([...fetchedAddresses].sort(), [BTC_B, BTC_C, BTC_D].sort());
  assert.equal(new Set(fetchedAddresses).size, fetchedAddresses.length);

  const progress = (await app.inject(`/api/cases/${caseId}/network/progress`)).json();
  assert.equal(progress.running, false);
  assert.equal(progress.roundtrip.finished, true);
  assert.equal(progress.roundtrip.cyclesFound, 2);
  assert.equal(progress.roundtrip.addressesFetched, 3);

  // Trwałość: zapis w bazie z wynikiem obiegu; sieć ma krawędzie obiegu.
  const stored = (await storage.listNetworkExpansions(caseId)).find((item) => item.id === expansion.id)!;
  assert.equal(stored.results.roundtrip?.cycles.length, 2);
  const net = (await app.inject(`/api/cases/${caseId}/network`)).json();
  for (const id of layered.edgeIds) assert.ok(net.graph.edges.some((edge: { id: string }) => edge.id === id));

  // Wycofanie: krawędzie obiegu znikają z sieci, wpis zostaje w historii.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/network/expand/${expansion.id}` })).statusCode, 200);
  const afterWithdraw = (await app.inject(`/api/cases/${caseId}/network`)).json();
  assert.ok(!afterWithdraw.graph.edges.some((edge: { id: string }) => layered.edgeIds.includes(edge.id)));
  assert.ok(afterWithdraw.expansions.find((item: { id: string }) => item.id === expansion.id).withdrawnAt);
});

test('Szukaj dalej: walidacja parametrów (maks. 50 kroków, budżet 200) i zatrzymanie na budżecie', async () => {
  const caseId = await caseWithRun();
  const anchor = `addr:bitcoin:${BTC_A}`;
  assert.equal((await post(`/api/cases/${caseId}/network/expand`, { nodeId: anchor, relations: ['roundtrip'], roundtrip: { maxHops: 51 } })).statusCode, 400);
  assert.equal((await post(`/api/cases/${caseId}/network/expand`, { nodeId: anchor, relations: ['roundtrip'], roundtrip: { budget: 201 } })).statusCode, 400);
  const limited = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: anchor, relations: ['roundtrip'], roundtrip: { budget: 1 } })).json().expansion;
  assert.equal(limited.results.roundtrip.stats.addressesFetched, 1);
  assert.ok(limited.stops.some((stop: { reason: string; detail: string }) => stop.reason === 'budget' && stop.detail.startsWith('Obieg środków')));
  // Ping-pong bezpośredni nie wymaga pobrań — jest w wyniku mimo budżetu 1.
  assert.ok(limited.results.roundtrip.cycles.some((cycle: { pattern: string }) => cycle.pattern === 'direct'));
  // Zwykłe „Rozwiń” bez grup nie uruchamia obiegu środków.
  const plain = (await post(`/api/cases/${caseId}/network/expand`, { nodeId: anchor, force: true })).json().expansion;
  assert.ok(!plain.results.runs.some((run: { expander: string }) => run.expander === 'adres-obieg'));
  assert.equal(plain.results.roundtrip, undefined);
  assert.ok(plain.budget.limit <= 60);
});
