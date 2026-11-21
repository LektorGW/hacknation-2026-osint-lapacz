import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode } from '@olcys/core';
import { collapseGraph, declutter, isPinnedSource, searchNodes, sourceCounts, withinHops } from '../src/graph/investigation.ts';
import { edgeGeometry, pointOnEdge, separateBoxes } from '../src/graph/layout.ts';
import type { Box } from '../src/graph/layout.ts';

const node = (id: string, kind: GraphNode['kind'], extra: Partial<GraphNode> = {}): GraphNode => ({ id, kind, label: id, ...extra });
const edge = (from: string, to: string, kind: GraphEdge['kind'], extra: Partial<GraphEdge> = {}): GraphEdge => ({ id: `${from}>${to}`, from, to, kind, ...extra });

test('rozsuwanie kolizji: żadne dwa prostokąty nie nachodzą na siebie, kolejność od góry zostaje', () => {
  const boxes: Box[] = [
    { id: 'a', x: 100, y: 100, width: 120, height: 40 },
    { id: 'b', x: 130, y: 110, width: 120, height: 40 },
    { id: 'c', x: 160, y: 105, width: 120, height: 40 },
    { id: 'd', x: 600, y: 100, width: 120, height: 40 },
  ];
  const result = separateBoxes(boxes, 4);
  for (let i = 0; i < result.length; i += 1) {
    for (let j = i + 1; j < result.length; j += 1) {
      const a = result[i]!;
      const b = result[j]!;
      const apart = Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 4 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 4;
      assert.ok(apart, `${a.id} i ${b.id} nachodzą na siebie`);
    }
  }
  // Prostokąt bez kolizji nie rusza się; kolejność wejścia zachowana.
  assert.deepEqual(result.map((box) => box.id), ['a', 'b', 'c', 'd']);
  assert.equal(result[3]!.y, 100);
  assert.equal(result[0]!.y, 100);
});

test('punkt na krawędzi: końce i środek zgodne z geometrią krzywej', () => {
  const from = { x: 0, y: 0 };
  const to = { x: 400, y: 100 };
  assert.deepEqual(pointOnEdge(from, to, true, 0).point, from);
  assert.deepEqual(pointOnEdge(from, to, true, 1).point, to);
  assert.deepEqual(pointOnEdge(from, to, true, 0.5).point, edgeGeometry(from, to, true).mid);
  assert.deepEqual(pointOnEdge(from, to, false, 0.25).point, { x: 100, y: 25 });
});

test('mniej szumu: słabe hipotezy tożsamości i relacje odrzucone są schowane, a ich liczba podana', () => {
  const nodes = [node('s', 'subject'), node('p', 'profile'), node('o', 'person', { score: 20 }), node('a', 'address'), node('svc', 'service')];
  const edges = [
    edge('s', 'p', 'found_profile', { status: 'source_fact' }),
    edge('p', 'o', 'related', { status: 'hypothesis', weight: 20 }),
    edge('p', 'a', 'publishes', { status: 'rejected' }),
    // Przepływ o małej wadze (względna wartość) nie jest „słabą hipotezą”.
    edge('p', 'svc', 'cash_out', { status: 'hypothesis', weight: 5, layer: 'chain' }),
  ];
  const hidden = declutter(nodes, edges, { showWeak: false, showRejected: false });
  assert.deepEqual(hidden.nodes.map((item) => item.id).sort(), ['p', 's', 'svc']);
  assert.ok(hidden.edges.some((item) => item.kind === 'cash_out'));
  assert.equal(hidden.weak, 2); // relacja i węzeł
  assert.equal(hidden.rejected, 1);
  const all = declutter(nodes, edges, { showWeak: true, showRejected: true });
  assert.equal(all.nodes.length, nodes.length);
  assert.equal(all.edges.length, edges.length);
});

test('odpowiedź usługi (reply:…) nie chowa się za licznikiem źródeł — widoczna w warstwie tożsamości i w obu warstwach', () => {
  const nodes = [node('s', 'subject'), node('svc:1', 'service'), node('addr:btc:x', 'address'), node('reply:r1', 'source', { status: 'confirmed' }), node('src:pub', 'source')];
  const edges = [
    edge('s', 'addr:btc:x', 'publishes'),
    edge('svc:1', 'reply:r1', 'documented_by', { status: 'confirmed' }),
    edge('addr:btc:x', 'reply:r1', 'documented_by', { status: 'confirmed' }),
    edge('addr:btc:x', 'src:pub', 'documented_by'),
  ];
  assert.ok(isPinnedSource(nodes[3]!));
  const graph = collapseGraph(nodes, edges, { collapsed: new Set(), sourcesShown: new Set() });
  assert.ok(graph.nodes.some((item) => item.id === 'reply:r1'), 'odpowiedź usługi widoczna');
  assert.ok(!graph.nodes.some((item) => item.id === 'src:pub'), 'zwykłe źródło schowane za licznikiem');
  assert.equal(sourceCounts(nodes, edges).get('addr:btc:x'), 1);
});

test('tryb skupienia i wyszukiwanie', () => {
  const edges = [edge('a', 'b', 'publishes'), edge('b', 'c', 'publishes'), edge('c', 'd', 'publishes')];
  assert.deepEqual([...withinHops(edges, 'a', 2)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...withinHops(edges, 'b', 1)].sort(), ['a', 'b', 'c']);
  const nodes = [node('svc:bursztyn', 'service', { label: 'Giełda Bursztyn' }), node('profile:x', 'profile', { label: 'rkowalski_btc', sublabel: 'gitpub.sandbox' }), node('addr:btc:bc1q43', 'address', { label: 'bc1q43zhzv…u6wk2g98' })];
  assert.equal(searchNodes(nodes, 'bursz')[0]!.id, 'svc:bursztyn');
  assert.equal(searchNodes(nodes, 'GITPUB')[0]!.id, 'profile:x');
  assert.equal(searchNodes(nodes, 'bc1q43')[0]!.id, 'addr:btc:bc1q43');
  assert.deepEqual(searchNodes(nodes, 'x'), []);
});
