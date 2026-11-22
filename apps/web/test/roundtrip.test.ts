import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge } from '@olcys/core';
import { expansionSummary } from '../src/graph/network.ts';
import type { ExpansionRecord, NetworkView } from '../src/graph/network.ts';
import { cycleEvidencePath, cycleSummary, durationText, progressText, roundTripNodeIds, roundTripReports } from '../src/graph/roundtrip.ts';
import type { RoundTripCycle, RoundTripReport } from '../src/graph/roundtrip.ts';

const A = 'addr:bitcoin:A';
const B = 'addr:bitcoin:B';
const C = 'addr:bitcoin:C';

const cycle: RoundTripCycle = {
  id: 'obieg-1',
  pattern: 'intermediaries',
  label: 'obieg przez adresy pośrednie',
  sameFunds: 'hypothesis',
  hops: [
    { from: 'A', to: 'B', txid: 't1', time: '2026-03-01T10:00:00Z', amount: 1, asset: 'BTC', valuePln: 300000 },
    { from: 'B', to: 'C', txid: 't2', time: '2026-03-02T10:00:00Z', amount: 0.98, asset: 'BTC' },
    { from: 'C', to: 'A', txid: 't3', time: '2026-03-04T10:00:00Z', amount: 0.97, asset: 'BTC', valuePln: 291000 },
  ],
  hopCount: 3,
  startedAt: '2026-03-01T10:00:00Z',
  endedAt: '2026-03-04T10:00:00Z',
  durationHours: 72,
  out: { amount: 1, asset: 'BTC', valuePln: 300000 },
  back: { amount: 0.97, asset: 'BTC', valuePln: 291000 },
  ratio: 0.97,
  returnsTo: { address: 'A', role: 'subject' },
  intermediaries: [
    { address: 'B', class: 'unlabelled' },
    { address: 'C', class: 'unlabelled' },
  ],
  note: 'uwaga',
  nodeIds: [A, B, C, A],
  edgeIds: [`net:roundtrip_hop:${A}>${B}`, `net:roundtrip_hop:${B}>${C}`, `net:roundtrip_hop:${C}>${A}`],
};

const report: RoundTripReport = {
  anchor: A,
  origin: 'A',
  network: 'bitcoin',
  params: { maxHops: 10, budget: 60, windowDays: 180, fanOut: 3, minShare: 0.05 },
  cycles: [cycle],
  stops: [],
  stats: { addressesFetched: 2, deepestHop: 2, pathsExplored: 2, cyclesFound: 1 },
  caveat: 'Każdy krok obiegu to fakt…',
};

const record = (id: string, extra: Partial<ExpansionRecord> = {}): ExpansionRecord => ({
  id,
  caseId: 'sprawa',
  nodeId: A,
  relations: ['roundtrip'],
  depth: 1,
  budget: { limit: 61, used: 2 },
  startedAt: `2026-11-22T10:00:0${id.length}Z`,
  finishedAt: '2026-11-22T10:00:09Z',
  requestedBy: 'analityk',
  results: { nodes: [], edges: [], runs: [], roundtrip: report },
  stops: [],
  sourceErrors: [],
  ...extra,
});

const view = (expansions: ExpansionRecord[]): NetworkView => ({ caseId: 'sprawa', runId: 'r', generatedAt: '', graph: { nodes: [], edges: [] }, depthCounts: {}, sanctioned: [], expansions });

const edges: GraphEdge[] = [
  { id: cycle.edgeIds[0]!, from: A, to: B, kind: 'transfer', status: 'source_fact' },
  { id: cycle.edgeIds[1]!, from: B, to: C, kind: 'transfer', status: 'source_fact' },
  { id: cycle.edgeIds[2]!, from: C, to: A, kind: 'transfer', status: 'source_fact' },
];

test('obieg na grafie: ścieżka po krawędziach-przelewach w kolejności, same fakty; brak krawędzi w widoku = null', () => {
  const path = cycleEvidencePath(cycle, edges)!;
  assert.deepEqual(path.nodes, [A, B, C, A]);
  assert.deepEqual(path.steps.map((step) => `${step.from}>${step.to}:${step.forward}`), [`${A}>${B}:true`, `${B}>${C}:true`, `${C}>${A}:true`]);
  assert.equal(path.hypotheses, 0);
  assert.equal(cycleEvidencePath(cycle, edges.slice(0, 2)), null);
});

test('odznaka „ping-pong”: tylko adresy pośrednie z niewycofanych rozwinięć; raporty węzła od najnowszego', () => {
  const active = record('a');
  const withdrawn = record('bb', { withdrawnAt: '2026-11-22T11:00:00Z' });
  assert.deepEqual([...roundTripNodeIds(view([active]))].sort(), [B, C]);
  assert.equal(roundTripNodeIds(view([withdrawn])).size, 0);
  assert.equal(roundTripNodeIds(null).size, 0);
  const newer = record('ccc');
  assert.deepEqual(roundTripReports(view([active, withdrawn, newer]), A).map((item) => item.record.id), ['ccc', 'a']);
  assert.deepEqual(roundTripReports(view([active]), B), []);
});

test('opisy obiegu: liczba przelewów, czas, kwoty wyszło / wróciło ze stosunkiem; postęp i historia rozwinięć', () => {
  assert.match(cycleSummary(cycle), /^3 przelewy · 3 dni · wyszło 1 BTC \(ok\. .*\), wróciło 0,97 BTC \(ok\. .*\) \(97%\)$/);
  assert.equal(durationText(0.25), '15 min');
  assert.equal(durationText(5), '5 godz.');
  assert.equal(durationText(72), '3 dni');
  assert.equal(progressText(null), 'przygotowanie…');
  assert.equal(progressText({ addressesFetched: 4, deepestHop: 2, cyclesFound: 1 }), 'pobrane adresy: 4 · najdalszy krok: 2 · znalezione obiegi: 1');
  assert.match(expansionSummary(record('a'), (id) => id), /obieg środków \(ping-pong\); znalezione obiegi: 1; do 10 przelewów, okno 180 dni/);
});
