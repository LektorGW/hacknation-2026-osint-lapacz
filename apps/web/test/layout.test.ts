import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode } from '@olcys/core';
import { edgeGeometry, filterGraph, layeredLayout, neighbourhood, radialLayout } from '../src/graph/layout.ts';

/** Graf syntetyczny: podmiot, identyfikatory, profile, adresy, kontrahenci i osoby — łącznie 60 węzłów. */
function sampleGraph(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{ id: 's', kind: 'subject', label: 'Podmiot' }];
  const edges: GraphEdge[] = [];
  const link = (from: string, to: string, kind: GraphEdge['kind']) => edges.push({ id: `${from}>${to}`, from, to, kind });
  for (let i = 0; i < 6; i += 1) {
    nodes.push({ id: `i${i}`, kind: 'identifier', label: `id ${i}` });
    link('s', `i${i}`, 'has_identifier');
  }
  for (let i = 0; i < 8; i += 1) {
    nodes.push({ id: `p${i}`, kind: 'profile', label: `profil ${i}`, score: 20 + i * 10 });
    link(`i${(i * 5) % 6}`, `p${i}`, 'found_profile');
  }
  for (let i = 0; i < 10; i += 1) {
    nodes.push({ id: `a${i}`, kind: 'address', label: `adres ${i}`, score: i * 10, excluded: i === 0 });
    link(`p${(i * 3) % 8}`, `a${i}`, 'publishes');
  }
  for (let i = 0; i < 30; i += 1) {
    nodes.push({ id: `k${i}`, kind: 'service', label: `kontrahent ${i}` });
    link(`a${(i * 7) % 10}`, `k${i}`, i % 3 === 0 ? 'cash_out' : 'transfer');
  }
  for (let i = 0; i < 5; i += 1) {
    nodes.push({ id: `o${i}`, kind: 'person', label: `osoba ${i}` });
    link(`k${i * 4}`, `o${i}`, 'related');
  }
  return { nodes, edges };
}

test('układ warstwowy: każdy węzeł ma pozycję, a prostokąty węzłów się nie nakładają', () => {
  const { nodes, edges } = sampleGraph();
  assert.equal(nodes.length, 60);
  const layout = layeredLayout(nodes, edges);
  const points = nodes.map((node) => layout.positions.get(node.id)!);
  assert.ok(points.every(Boolean));
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const apart = Math.abs(points[a]!.x - points[b]!.x) >= 230 || Math.abs(points[a]!.y - points[b]!.y) >= 40;
      assert.ok(apart, `węzły ${nodes[a]!.id} i ${nodes[b]!.id} nakładają się`);
    }
  }
  for (const point of points) {
    assert.ok(point.x >= 0 && point.x <= layout.width && point.y >= 0 && point.y <= layout.height);
  }
});

test('układ warstwowy: kolumny odpowiadają rodzajom węzłów w ustalonej kolejności', () => {
  const { nodes, edges } = sampleGraph();
  const layout = layeredLayout(nodes, edges);
  assert.deepEqual(layout.columns.map((column) => column.kind), ['subject', 'identifier', 'profile', 'address', 'service', 'person']);
  const x = (id: string) => layout.positions.get(id)!.x;
  assert.ok(x('s') < x('i0') && x('i0') < x('p0') && x('p0') < x('a0') && x('a0') < x('k0') && x('k0') < x('o0'));
});

test('układ jest stabilny: ten sam graf i graf z odwróconą listą krawędzi dają te same pozycje', () => {
  const { nodes, edges } = sampleGraph();
  const first = layeredLayout(nodes, edges);
  const second = layeredLayout(nodes, [...edges].reverse());
  for (const node of nodes) assert.deepEqual(first.positions.get(node.id), second.positions.get(node.id));
  assert.deepEqual([...radialLayout(nodes, edges).positions], [...radialLayout(nodes, edges).positions]);
});

test('sortowanie barycentryczne usuwa przecięcia w prostym grafie', () => {
  const nodes: GraphNode[] = [
    { id: 's', kind: 'subject', label: 's' },
    { id: 'i1', kind: 'identifier', label: 'i1' },
    { id: 'i2', kind: 'identifier', label: 'i2' },
    { id: 'p1', kind: 'profile', label: 'p1' },
    { id: 'p2', kind: 'profile', label: 'p2' },
  ];
  // Profile podane w kolejności odwrotnej do identyfikatorów, z którymi są połączone.
  const edges: GraphEdge[] = [
    { id: '1', from: 'i1', to: 'p2', kind: 'found_profile' },
    { id: '2', from: 'i2', to: 'p1', kind: 'found_profile' },
  ];
  const { positions } = layeredLayout(nodes, edges);
  const y = (id: string) => positions.get(id)!.y;
  assert.equal(Math.sign(y('i1') - y('i2')), Math.sign(y('p2') - y('p1')));
});

test('układ promienisty: podmiot w środku, węzły nie bliżej niż zadany odstęp', () => {
  const { nodes, edges } = sampleGraph();
  const layout = radialLayout(nodes, edges, { minDistance: 100 });
  assert.deepEqual(layout.positions.get('s'), layout.centre);
  const points = nodes.map((node) => layout.positions.get(node.id)!);
  for (let a = 0; a < points.length; a += 1) {
    for (let b = a + 1; b < points.length; b += 1) {
      const distance = Math.hypot(points[a]!.x - points[b]!.x, points[a]!.y - points[b]!.y);
      assert.ok(distance >= 99.9, `węzły ${nodes[a]!.id} i ${nodes[b]!.id}: ${distance.toFixed(1)}`);
    }
  }
});

test('filtry: ukrycie odrzuconych, tylko wypłaty, minimalny wynik; węzły bez połączeń znikają', () => {
  const { nodes, edges } = sampleGraph();
  const all = filterGraph(nodes, edges, { hideExcluded: false, cashOutOnly: false, minScore: 0 });
  assert.equal(all.nodes.length, 60);

  const hidden = filterGraph(nodes, edges, { hideExcluded: true, cashOutOnly: false, minScore: 0 });
  assert.ok(!hidden.nodes.some((node) => node.id === 'a0'));
  // Kontrahenci adresu a0 (k0, k10, k20) tracą jedyne połączenie.
  assert.ok(!hidden.nodes.some((node) => node.id === 'k10'));

  const cash = filterGraph(nodes, edges, { hideExcluded: false, cashOutOnly: true, minScore: 0 });
  assert.ok(cash.edges.every((edge) => edge.kind !== 'transfer'));
  assert.ok(cash.nodes.filter((node) => node.kind === 'service').every((node) => cash.edges.some((edge) => edge.to === node.id || edge.from === node.id)));

  const strict = filterGraph(nodes, edges, { hideExcluded: false, cashOutOnly: false, minScore: 50 });
  assert.ok(strict.nodes.every((node) => node.score === undefined || node.score >= 50));
  assert.ok(strict.nodes.some((node) => node.kind === 'subject'));
  assert.ok(strict.edges.every((edge) => strict.nodes.some((node) => node.id === edge.from) && strict.nodes.some((node) => node.id === edge.to)));
});

test('sąsiedztwo i geometria krawędzi', () => {
  const { edges } = sampleGraph();
  assert.deepEqual([...neighbourhood(edges, 'i0')].sort(), ['i0', 'p0', 'p6', 's']);
  const straight = edgeGeometry({ x: 0, y: 0 }, { x: 100, y: 0 }, false);
  assert.deepEqual(straight.mid, { x: 50, y: 0 });
  assert.equal(straight.angle, 0);
  const curved = edgeGeometry({ x: 0, y: 0 }, { x: 200, y: 100 }, true);
  assert.deepEqual(curved.mid, { x: 100, y: 50 });
  assert.ok(curved.path.startsWith('M0,0C100,0 100,100 200,100'));
});
