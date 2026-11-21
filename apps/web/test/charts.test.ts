import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layoutSankey } from '../src/charts/sankey.ts';
import { bandScale, linearScale, niceMax, stackSeries, ticks, timeScale } from '../src/charts/scales.ts';

test('niceMax zaokrągla w górę do okrągłej wartości', () => {
  assert.equal(niceMax(0), 1);
  assert.equal(niceMax(7), 10);
  assert.equal(niceMax(146000), 200000);
  assert.equal(niceMax(265630), 500000);
  assert.equal(niceMax(230), 250);
  assert.equal(niceMax(1000), 1000);
});

test('podziałki i skala liniowa', () => {
  assert.deepEqual(ticks(200, 4), [0, 50, 100, 150, 200]);
  const y = linearScale([0, 200], [100, 0]);
  assert.equal(y(0), 100);
  assert.equal(y(200), 0);
  assert.equal(y(50), 75);
  assert.equal(linearScale([5, 5], [10, 20])(5), 10);
});

test('pasma słupków mieszczą się w zakresie i nie nachodzą na siebie', () => {
  const band = bandScale(3, [0, 300], 0.4);
  assert.equal(band.width, 60);
  assert.deepEqual([0, 1, 2].map(band.start), [20, 120, 220]);
});

test('słupki skumulowane: odcinki przylegają, a ostatni kończy się na sumie', () => {
  const stacks = stackSeries([[10, 0, 5], [20, 30], [5, 5, 5]]);
  assert.deepEqual(stacks[0], [[0, 10], [0, 0], [0, 5]]);
  assert.deepEqual(stacks[1], [[10, 30], [0, 30], [5, 5]]);
  assert.deepEqual(stacks[2], [[30, 35], [30, 35], [5, 10]]);
});

test('skala czasu', () => {
  const x = timeScale(['2024-01-01T00:00:00Z', '2026-01-01T00:00:00Z'], [0, 100]);
  assert.equal(x('2024-01-01T00:00:00Z'), 0);
  assert.equal(x('2026-01-01T00:00:00Z'), 100);
  assert.ok(Math.abs(x('2025-01-01T00:00:00Z') - 50) < 0.2);
  assert.equal(timeScale(['2025-01-01T00:00:00Z'], [0, 100])('2025-01-01T00:00:00Z'), 50);
});

test('diagram przepływu: wysokości proporcjonalne, węzły w kolumnie rozłączne, wstęgi mieszczą się w węzłach', () => {
  const nodes = [
    { id: 'a1', column: 0, label: 'adres 1' },
    { id: 'a2', column: 0, label: 'adres 2' },
    { id: 'k1', column: 1, label: 'giełda' },
    { id: 'k2', column: 1, label: 'p2p' },
    { id: 'r', column: 2, label: 'rok' },
    { id: 'pusty', column: 1, label: 'bez przepływów' },
  ];
  const links = [
    { source: 'a1', target: 'k1', value: 300 },
    { source: 'a1', target: 'k2', value: 100 },
    { source: 'a2', target: 'k1', value: 100 },
    { source: 'k1', target: 'r', value: 400 },
    { source: 'k2', target: 'r', value: 100 },
    { source: 'a2', target: 'k2', value: 0 },
  ];
  const layout = layoutSankey(nodes, links, { width: 500, height: 200, gap: 10 });
  assert.equal(layout.nodes.length, 5);
  assert.equal(layout.links.length, 5);
  const node = (id: string) => layout.nodes.find((item) => item.id === id)!;
  assert.ok(Math.abs(node('a1').height / node('a2').height - 4) < 1e-9);
  assert.ok(Math.abs(node('r').height - (node('k1').height + node('k2').height)) < 1e-9);

  for (const column of [0, 1, 2]) {
    const inColumn = layout.nodes.filter((item) => item.column === column).sort((a, b) => a.y - b.y);
    for (const item of inColumn) assert.ok(item.y >= -1e-9 && item.y + item.height <= 200 + 1e-9);
    for (let index = 1; index < inColumn.length; index += 1) {
      assert.ok(inColumn[index]!.y >= inColumn[index - 1]!.y + inColumn[index - 1]!.height + 10 - 1e-9);
    }
  }
  for (const link of layout.links) {
    const source = node(link.source);
    const target = node(link.target);
    assert.ok(link.sourceY - link.width / 2 >= source.y - 1e-9 && link.sourceY + link.width / 2 <= source.y + source.height + 1e-9);
    assert.ok(link.targetY - link.width / 2 >= target.y - 1e-9 && link.targetY + link.width / 2 <= target.y + target.height + 1e-9);
  }
  assert.deepEqual(layoutSankey([], [], { width: 100, height: 100 }), { nodes: [], links: [] });
});
