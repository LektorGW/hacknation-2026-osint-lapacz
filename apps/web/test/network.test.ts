import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode } from '@olcys/core';
import { createDemoNetwork } from '../src/demo-network.ts';
import { depthSummary, expansionSummary, freshNodeIds, mergeExpansions, pathStrength, riskBadgeOf, riskPathNote, sanctionedNodes, strongestEvidencePath, viewGraph } from '../src/graph/network.ts';
import type { ExpansionRecord, NetworkView } from '../src/graph/network.ts';

const subject: GraphNode = { id: 'podmiot', kind: 'subject', label: 'Tomasz W.' };
const profile: GraphNode = { id: 'forum|tomwzor', kind: 'profile', label: 'tomwzor' };
const address: GraphNode = { id: 'adres:bitcoin:bc1qtest', kind: 'address', label: 'bc1qtest' };
const base = {
  nodes: [subject, profile, address],
  edges: [
    { id: 'e1', from: 'podmiot', to: 'forum|tomwzor', kind: 'found_profile', status: 'source_fact' },
    { id: 'e2', from: 'forum|tomwzor', to: 'adres:bitcoin:bc1qtest', kind: 'publishes', status: 'source_fact' },
  ] as GraphEdge[],
};

const record = (id: string, nodeId: string, nodes: ExpansionRecord['results']['nodes'], edges: ExpansionRecord['results']['edges'], extra: Partial<ExpansionRecord> = {}): ExpansionRecord => ({
  id,
  caseId: 'sprawa',
  nodeId,
  relations: ['accounts'],
  depth: 1,
  budget: { limit: 20, used: 2 },
  startedAt: '2026-11-21T10:00:00.000Z',
  finishedAt: '2026-11-21T10:00:01.000Z',
  requestedBy: 'analityk',
  results: { nodes, edges, runs: [] },
  stops: [],
  sourceErrors: [],
  ...extra,
});

test('scalanie: rozwinięcie dopina węzły do teczki, wycofane nie wchodzi do sieci', () => {
  const kept = record('r1', profile.id, [{ id: 'id:email:x@y.example', kind: 'identifier', label: 'x@y.example', expansionId: 'r1', depth: 1 }], [
    { id: 'n1', from: profile.id, to: 'id:email:x@y.example', kind: 'links_to', status: 'source_fact', relation: 'publishes_identifier', strength: 0.9, expansionId: 'r1' },
  ]);
  const withdrawn = record('r2', profile.id, [{ id: 'id:nick:inny', kind: 'identifier', label: 'inny', expansionId: 'r2', depth: 1 }], [], { withdrawnAt: '2026-11-21T11:00:00.000Z' });
  const merged = mergeExpansions(base, [kept, withdrawn]);
  assert.ok(merged.graph.nodes.some((node) => node.id === 'id:email:x@y.example'));
  assert.ok(!merged.graph.nodes.some((node) => node.id === 'id:nick:inny'));
  assert.equal(depthSummary(merged.depthCounts), 'teczka: 3 · krok 1: 1');
  const email = merged.graph.nodes.find((node) => node.id === 'id:email:x@y.example')!;
  assert.equal(email.link?.level, 'documented');
  assert.equal(email.link?.summary, 'ścieżka: 2 kroki, najsłabsze ogniwo: publikuje identyfikator (fakt źródłowy)');
});

test('bezpiecznik w widoku: byt osiągalny tylko przez hipotezę = „w siatce — ścieżka poszlakowa”', () => {
  const guess = record('r1', profile.id, [{ id: 'profile:gry|tomwzor', kind: 'profile', label: 'tomwzor', expansionId: 'r1', depth: 1 }], [
    { id: 'n1', from: profile.id, to: 'profile:gry|tomwzor', kind: 'found_profile', status: 'hypothesis', relation: 'same_nick', strength: 1, expansionId: 'r1' },
  ]);
  const node = mergeExpansions(base, [guess]).graph.nodes.find((item) => item.id === 'profile:gry|tomwzor')!;
  assert.equal(node.link?.label, 'w siatce — ścieżka poszlakowa');
});

test('widok: ukrycie węzłów z rozwinięć, znaczek „nowe”, wpisy list i podsumowanie historii', () => {
  const expansion = record('r1', profile.id, [{ id: 'nowy', kind: 'organization', label: 'Firma', expansionId: 'r1', depth: 1, meta: { sanctioned: { list: 'Lista', entryId: 'X' } } }], [
    { id: 'n1', from: profile.id, to: 'nowy', kind: 'related', status: 'source_fact', expansionId: 'r1' },
  ]);
  const network: NetworkView = { caseId: 'sprawa', runId: 'run', generatedAt: '', ...mergeExpansions(base, [expansion]), expansions: [expansion] };
  assert.equal(viewGraph(base, network, false).nodes.length, 4);
  const hidden = viewGraph(base, network, true);
  assert.equal(hidden.nodes.length, 3);
  assert.ok(hidden.edges.every((edge) => edge.id !== 'n1'));
  assert.deepEqual([...freshNodeIds(network, 'r1')], ['nowy']);
  assert.equal(freshNodeIds(network, null).size, 0);
  assert.deepEqual(sanctionedNodes(network.graph.nodes).map((node) => node.id), ['nowy']);
  assert.equal(expansionSummary(expansion, (id) => (id === profile.id ? 'tomwzor' : id)), 'tomwzor — konta i identyfikatory; 1 krok; nowych węzłów: 1, relacji: 1; zapytań: 2/20');
  assert.equal(viewGraph(base, null, true), base);
});

test('siła ścieżki w panelu: zanik na hipotezie i najsłabsze ogniwo', () => {
  const strength = pathStrength(
    [
      { id: 'a', from: 'podmiot', to: 'x', kind: 'found_profile', status: 'source_fact' },
      { id: 'b', from: 'x', to: 'y', kind: 'related', status: 'hypothesis', relation: 'same_nick' } as GraphEdge,
    ],
    ['podmiot', 'x', 'y'],
  );
  assert.equal(strength.level, 'circumstantial');
  assert.equal(strength.summary, 'ścieżka: 2 kroki, najsłabsze ogniwo: wspólny nick (hipoteza)');
});

test('lista sankcyjna: odznaka z teczki albo wpisu, najmocniejsza ścieżka i „możliwy imiennik” przy zgodności nazwy', () => {
  const badges = { org1: { badge: 'lista sankcyjna', status: 'hypothesis' as const, summary: 'Nazwa zgodna z wpisem.', caveat: 'Możliwy imiennik.' } };
  assert.deepEqual(riskBadgeOf({ id: 'org1', kind: 'organization', label: 'Firma' }, badges), { badge: 'lista sankcyjna', status: 'hypothesis', tooltip: 'Nazwa zgodna z wpisem. Możliwy imiennik.' });
  assert.equal(riskBadgeOf({ id: 'wpis', kind: 'organization', label: 'X', meta: { sanctioned: { list: 'OFAC SDN', entryId: '1' } } }, undefined)?.status, 'source_fact');
  assert.equal(riskBadgeOf({ id: 'inny', kind: 'organization', label: 'Y' }, badges), null);
  const edges = [
    { id: 'a', from: 'podmiot', to: 'org1', kind: 'related', status: 'source_fact' },
    { id: 'b', from: 'org1', to: 'wpis', kind: 'documented_by', status: 'hypothesis', relation: 'sanctions_name_match' },
  ] as GraphEdge[];
  const path = strongestEvidencePath(edges, 'podmiot', 'wpis')!;
  assert.deepEqual(path.nodes, ['podmiot', 'org1', 'wpis']);
  assert.equal(path.hypotheses, 1);
  assert.equal(riskPathNote(path), 'ścieżka poszlakowa — możliwy imiennik');
  assert.equal(riskPathNote(strongestEvidencePath(edges.slice(0, 1), 'podmiot', 'org1')!), null);
});

test('tryb demonstracyjny: dwa rozwinięcia prowadzą do trzeciej osoby i wpisu listy syntetycznej; wycofanie zostaje w historii', async () => {
  const demo = createDemoNetwork(async () => base);
  const plan = await demo.getNetworkPlan('sprawa', profile.id);
  assert.ok(plan?.expandable);
  assert.ok(plan.groups.some((group) => group.id === 'accounts'));
  // 1) konto podmiotu → e-mail → konto „kantor_wzor” → jego adres BTC (3 kroki).
  const first = await demo.expandNetwork('sprawa', { nodeId: profile.id, relations: ['accounts'], depth: 3 });
  assert.ok(first.expansion.results.nodes.some((node) => node.id === 'profile:targ.example|kantor_wzor'));
  const y = first.expansion.results.nodes.find((node) => node.id.startsWith('addr:bitcoin:'))!;
  assert.ok(y);
  // 2) adres → publikacje → konto „leon_mewa” → adres USDT → wpis listy syntetycznej.
  const second = await demo.expandNetwork('sprawa', { nodeId: y.id, relations: ['publications', 'accounts', 'sanctions'], depth: 3 });
  assert.ok(second.expansion.results.nodes.some((node) => node.id === 'profile:targ.example|leon_mewa'));
  const network = (await demo.getNetwork('sprawa'))!;
  const entry = sanctionedNodes(network.graph.nodes)[0]!;
  assert.ok(entry.meta?.sanctioned?.synthetic, 'wpis oznaczony jako syntetyczny');
  assert.match(entry.sublabel ?? '', /SYNTETYCZNA/);
  assert.ok(entry.link && entry.link.level !== 'none');
  // Kontrahenci przelewów nigdy nie są osobami.
  const flows = await demo.expandNetwork('sprawa', { nodeId: address.id, relations: ['flows'], depth: 1 });
  assert.ok(flows.expansion.results.nodes.filter((node) => !node.known).every((node) => node.kind === 'address'));
  await demo.withdrawExpansion('sprawa', flows.expansion.id);
  const after = (await demo.getNetwork('sprawa'))!;
  assert.ok(after.expansions.find((item) => item.id === flows.expansion.id)?.withdrawnAt);
  assert.ok(!after.graph.nodes.some((node) => node.expansionId === flows.expansion.id));
  await assert.rejects(demo.withdrawExpansion('sprawa', flows.expansion.id));
});
