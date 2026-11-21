import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ClaimStatus, GraphEdge, GraphNode, GraphNodeKind, OperatorHypothesis } from '@olcys/core';
import {
  applyView,
  childMap,
  collapseGraph,
  edgeLayer,
  edgeStatus,
  findEvidencePath,
  hiddenByCollapse,
  hypothesisForEdge,
  linkKeyOf,
  nodeStatus,
  sourceCounts,
  toggled,
} from '../src/graph/investigation.ts';
import type { ViewFilter } from '../src/graph/investigation.ts';
import { flowLayout, layeredLayout } from '../src/graph/layout.ts';
import { activeDecisions, currentDecision, decisionHistory } from '../src/decisions.ts';
import type { DecisionRecord } from '../src/decisions.ts';
import { identityAccounts, identityStatus, parseIdentityId } from '../src/identities.ts';

const ALL_STATUSES: ClaimStatus[] = ['source_fact', 'computed', 'hypothesis', 'confirmed', 'rejected'];
const ALL_KINDS: GraphNodeKind[] = ['subject', 'operator', 'persona', 'identifier', 'profile', 'source', 'address', 'service', 'person'];
const view = (patch: Partial<ViewFilter> = {}): ViewFilter => ({ statuses: new Set(ALL_STATUSES), kinds: new Set(ALL_KINDS), minScore: 0, layer: 'both', ...patch });

/**
 * Graf śledczy w miniaturze: podmiot → hipoteza operatora → dwa konta (A, B) → adres → giełda,
 * persona i źródła z polem `parent`, hipoteza wspólnego operatora A–B oraz odrzucone powiązanie z osobą.
 */
function sample(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [
    { id: 's', kind: 'subject', label: 'Podmiot' },
    { id: 'op', kind: 'operator', label: 'Hipoteza operatora #1', status: 'hypothesis', parent: 's' },
    { id: 'A', kind: 'profile', label: 'konto A', score: 90 },
    { id: 'B', kind: 'profile', label: 'konto B', score: 40 },
    { id: 'per', kind: 'persona', label: 'Jan K.', parent: 'op' },
    { id: 'src1', kind: 'source', label: 'wpis 1', parent: 'A' },
    { id: 'src2', kind: 'source', label: 'wpis 2', parent: 'A' },
    { id: 'src3', kind: 'source', label: 'ogłoszenie' },
    { id: 'adr', kind: 'address', label: 'bc1…', score: 85 },
    { id: 'dep', kind: 'address', label: 'adres wpłat' },
    { id: 'gielda', kind: 'service', label: 'Giełda', score: 70 },
    { id: 'inna', kind: 'person', label: 'inna osoba' },
  ];
  const edge = (id: string, from: string, to: string, kind: GraphEdge['kind'], extra: Partial<GraphEdge> = {}): GraphEdge => ({ id, from, to, kind, ...extra });
  const edges: GraphEdge[] = [
    edge('s>op', 's', 'op', 'operates', { status: 'hypothesis' }),
    edge('op>A', 'op', 'A', 'operates', { status: 'hypothesis' }),
    edge('op>B', 'op', 'B', 'operates', { status: 'hypothesis' }),
    edge('A>per', 'A', 'per', 'declares', { status: 'source_fact' }),
    edge('A>src1', 'A', 'src1', 'documented_by', { status: 'source_fact' }),
    edge('A>src2', 'A', 'src2', 'documented_by', { status: 'source_fact' }),
    edge('B>src3', 'B', 'src3', 'documented_by', { status: 'source_fact' }),
    edge('A>adr', 'A', 'adr', 'publishes', { status: 'source_fact', weight: 85 }),
    edge('B>adr', 'B', 'adr', 'publishes', { status: 'source_fact', weight: 40 }),
    edge('A~B', 'A', 'B', 'same_operator', { status: 'hypothesis', weight: 80 }),
    edge('adr>dep', 'adr', 'dep', 'transfer', { status: 'source_fact', layer: 'chain' }),
    edge('dep>gielda', 'dep', 'gielda', 'cash_out', { status: 'computed', layer: 'chain', weight: 60 }),
    edge('adr>inna', 'adr', 'inna', 'related', { status: 'rejected' }),
    // Starsza teczka: podmiot wprost do konta A, bez pola `status`.
    edge('s>A', 's', 'A', 'found_profile'),
  ];
  return { nodes, edges };
}

// ---------- Status relacji ----------

test('status relacji starszej teczki wynika z pola inferred', () => {
  assert.equal(edgeStatus({ inferred: true }), 'hypothesis');
  assert.equal(edgeStatus({ inferred: false }), 'source_fact');
  assert.equal(edgeStatus({}), 'source_fact');
});

test('jawny status ma pierwszeństwo przed inferred, a nieznany jest traktowany jak hipoteza', () => {
  assert.equal(edgeStatus({ status: 'confirmed', inferred: true }), 'confirmed');
  assert.equal(edgeStatus({ status: 'rejected' }), 'rejected');
  assert.equal(edgeStatus({ status: 'cos_nowego' as ClaimStatus }), 'hypothesis');
});

test('warstwa relacji: jawne pole albo rodzaj przelewu', () => {
  assert.equal(edgeLayer({ kind: 'transfer' }), 'chain');
  assert.equal(edgeLayer({ kind: 'cash_out' }), 'chain');
  assert.equal(edgeLayer({ kind: 'publishes' }), 'identity');
  assert.equal(edgeLayer({ kind: 'related', layer: 'chain' }), 'chain');
});

test('operator i osoba powiązana bez statusu są hipotezą, konto i adres nie mają statusu', () => {
  assert.equal(nodeStatus({ kind: 'operator' }), 'hypothesis');
  assert.equal(nodeStatus({ kind: 'person' }), 'hypothesis');
  assert.equal(nodeStatus({ kind: 'person', status: 'confirmed' }), 'confirmed');
  assert.equal(nodeStatus({ kind: 'profile' }), undefined);
  assert.equal(nodeStatus({ kind: 'persona' }), undefined);
});

// ---------- Filtry ----------

test('filtr statusów ukrywa hipotezy i osierocone przez to węzły', () => {
  const { nodes, edges } = sample();
  const result = applyView(nodes, edges, view({ statuses: new Set<ClaimStatus>(['source_fact', 'computed', 'confirmed']) }));
  assert.ok(result.edges.every((edge) => edgeStatus(edge) !== 'hypothesis' && edgeStatus(edge) !== 'rejected'));
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.ok(!ids.has('op'), 'węzeł operatora łączyły wyłącznie hipotezy');
  assert.ok(!ids.has('inna'), 'osobę łączyła wyłącznie relacja odrzucona');
  assert.ok(ids.has('A') && ids.has('adr') && ids.has('s'));
});

test('filtr rodzajów węzłów usuwa węzły i ich relacje, podmiot zostaje', () => {
  const { nodes, edges } = sample();
  const result = applyView(nodes, edges, view({ kinds: new Set(ALL_KINDS.filter((kind) => kind !== 'source' && kind !== 'persona')) }));
  assert.ok(result.nodes.every((node) => node.kind !== 'source' && node.kind !== 'persona'));
  assert.ok(result.edges.every((edge) => edge.kind !== 'documented_by' && edge.kind !== 'declares'));
  assert.ok(result.nodes.some((node) => node.kind === 'subject'));
});

test('minimalny wynik odcina słabe węzły i słabe relacje; elementy bez liczby zostają', () => {
  const { nodes, edges } = sample();
  const result = applyView(nodes, edges, view({ minScore: 50 }));
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.ok(!ids.has('B'), 'konto B ma wynik 40');
  assert.ok(ids.has('A') && ids.has('adr') && ids.has('dep'));
  assert.ok(!result.edges.some((edge) => edge.id === 'B>adr'));
  assert.ok(result.edges.some((edge) => edge.id === 'adr>dep'), 'relacja bez wagi nie jest odcinana');
});

test('warstwa blockchain zostawia wyłącznie portfele, usługi i przepływy', () => {
  const { nodes, edges } = sample();
  const result = applyView(nodes, edges, view({ layer: 'chain' }));
  assert.deepEqual(result.edges.map((edge) => edge.id).sort(), ['adr>dep', 'dep>gielda']);
  assert.deepEqual(result.nodes.map((node) => node.id).sort(), ['adr', 'dep', 'gielda']);
  assert.ok(!result.nodes.some((node) => node.kind === 'subject'));
});

test('warstwa tożsamości pomija przepływy blockchain', () => {
  const { nodes, edges } = sample();
  const result = applyView(nodes, edges, view({ layer: 'identity' }));
  assert.ok(result.edges.every((edge) => edgeLayer(edge) === 'identity'));
  assert.ok(!result.nodes.some((node) => node.id === 'gielda' || node.id === 'dep'));
});

test('układ przepływów ustawia węzły od lewej do prawej zgodnie z kierunkiem przelewów', () => {
  const { nodes, edges } = sample();
  const chain = applyView(nodes, edges, view({ layer: 'chain' }));
  const layout = flowLayout(chain.nodes, chain.edges);
  const x = (id: string) => layout.positions.get(id)!.x;
  assert.ok(x('adr') < x('dep') && x('dep') < x('gielda'));
  assert.equal(layout.columns.length, 3);
  // Cykl nie zawiesza układu i każdy węzeł dostaje pozycję.
  const cyclic = flowLayout(
    [
      { id: 'a', kind: 'address', label: 'a' },
      { id: 'b', kind: 'address', label: 'b' },
    ],
    [
      { id: 'ab', from: 'a', to: 'b', kind: 'transfer' },
      { id: 'ba', from: 'b', to: 'a', kind: 'transfer' },
    ],
  );
  assert.equal(cyclic.positions.size, 2);
});

test('układ warstwowy ma kolumny dla nowych rodzajów węzłów', () => {
  const { nodes, edges } = sample();
  const layout = layeredLayout(nodes, edges);
  assert.equal(layout.positions.size, nodes.length);
  const order = layout.columns.map((column) => column.kind);
  assert.ok(order.indexOf('operator') < order.indexOf('profile'));
  assert.ok(order.includes('persona') && order.includes('source'));
});

// ---------- Zwijanie ----------

const open = { collapsed: new Set<string>(), sourcesShown: new Set<string>() };

test('źródła są domyślnie schowane za licznikiem przy węźle nadrzędnym', () => {
  const { nodes, edges } = sample();
  const counts = sourceCounts(nodes, edges);
  assert.equal(counts.get('A'), 2);
  assert.equal(counts.get('B'), 1, 'bez pola parent rodzicem jest drugi koniec relacji documented_by');
  const hidden = hiddenByCollapse(nodes, edges, open);
  assert.deepEqual([...hidden].sort(), ['src1', 'src2', 'src3']);
});

test('rozwinięcie źródeł jednego konta nie pokazuje źródeł innych kont', () => {
  const { nodes, edges } = sample();
  const graph = collapseGraph(nodes, edges, { collapsed: new Set(), sourcesShown: new Set(['A']) });
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.ok(ids.has('src1') && ids.has('src2') && !ids.has('src3'));
  assert.ok(graph.edges.some((edge) => edge.id === 'A>src1') && !graph.edges.some((edge) => edge.id === 'B>src3'));
});

test('dzieci węzła: pole parent ma pierwszeństwo przed relacjami wychodzącymi', () => {
  const { nodes, edges } = sample();
  const children = childMap(nodes, edges);
  assert.deepEqual(children.get('op')!.sort(), ['A', 'B', 'per']);
  assert.ok(!children.get('A')!.includes('per'), 'persona należy do operatora (parent), nie do konta, które ją deklaruje');
  assert.ok(![...children.values()].flat().includes('s'), 'podmiot nigdy nie jest dzieckiem');
});

test('zwinięcie konta chowa to, co jest osiągalne wyłącznie przez nie', () => {
  const { nodes, edges } = sample();
  const all = { collapsed: new Set(['B']), sourcesShown: new Set(['A', 'B']) };
  const hidden = hiddenByCollapse(nodes, edges, all);
  assert.ok(hidden.has('src3'), 'źródło konta B');
  assert.ok(!hidden.has('adr'), 'adres publikuje także konto A — zostaje widoczny');
  assert.ok(!hidden.has('B'), 'zwinięty węzeł zostaje widoczny');
});

test('zwinięcie hipotezy operatora chowa gałąź i podaje liczbę schowanych węzłów', () => {
  const { nodes, edges } = sample();
  // Bez krawędzi podmiot → konto A cała gałąź wisi na węźle operatora.
  const withoutDirect = edges.filter((edge) => edge.id !== 's>A');
  const graph = collapseGraph(nodes, withoutDirect, { collapsed: new Set(['op']), sourcesShown: new Set() });
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ['op', 's']);
  assert.equal(graph.hiddenCount.get('op'), nodes.length - 2);
  assert.deepEqual(graph.edges.map((edge) => edge.id), ['s>op']);
  // Z krawędzią podmiot → konto A konto zostaje osiągalne mimo zwinięcia operatora.
  const kept = collapseGraph(nodes, edges, { collapsed: new Set(['op']), sourcesShown: new Set() });
  assert.ok(kept.nodes.some((node) => node.id === 'A') && !kept.nodes.some((node) => node.id === 'per'));
});

test('przełączanie zbioru nie zmienia oryginału', () => {
  const original = new Set(['a']);
  assert.deepEqual([...toggled(original, 'b')].sort(), ['a', 'b']);
  assert.deepEqual([...toggled(original, 'a')], []);
  assert.deepEqual([...original], ['a']);
});

// ---------- Ścieżka dowodowa ----------

test('ścieżka dowodowa woli fakty od krótszej drogi przez hipotezy', () => {
  const { edges } = sample();
  const path = findEvidencePath(edges, 'adr', 's');
  assert.ok(path);
  assert.deepEqual(path.nodes, ['adr', 'A', 's']);
  assert.equal(path.hypotheses, 0);
  assert.deepEqual(path.steps.map((step) => step.edge.id), ['A>adr', 's>A']);
  assert.deepEqual(path.steps.map((step) => step.forward), [false, false], 'ścieżka idzie pod prąd relacji');
});

test('gdy nie ma drogi po faktach, ścieżka przechodzi przez hipotezę i to zgłasza', () => {
  const { edges } = sample();
  const path = findEvidencePath(edges.filter((edge) => edge.id !== 's>A'), 'gielda', 's');
  assert.ok(path);
  assert.equal(path.nodes[0], 'gielda');
  assert.equal(path.nodes.at(-1), 's');
  assert.equal(path.hypotheses, 2, 'podmiot → operator → konto to dwa kroki-hipotezy');
  assert.deepEqual(path.steps.slice(0, 2).map((step) => step.status), ['computed', 'source_fact']);
});

test('relacja odrzucona nie należy do ścieżki dowodowej', () => {
  const { edges } = sample();
  assert.equal(findEvidencePath(edges, 'inna', 's'), null);
  assert.equal(findEvidencePath(edges, 'adr', 'nie-ma-takiego'), null);
});

test('ścieżka z węzła do niego samego jest pusta', () => {
  assert.deepEqual(findEvidencePath(sample().edges, 'A', 'A'), { nodes: ['A'], steps: [], hypotheses: 0 });
});

test('potwierdzenie analityka kosztuje tyle co fakt', () => {
  const edges: GraphEdge[] = [
    { id: 'h1', from: 'x', to: 'y', kind: 'same_operator', status: 'confirmed' },
    { id: 'f1', from: 'x', to: 'm', kind: 'links_to', status: 'source_fact' },
    { id: 'f2', from: 'm', to: 'y', kind: 'links_to', status: 'source_fact' },
  ];
  assert.deepEqual(findEvidencePath(edges, 'x', 'y')!.steps.map((step) => step.edge.id), ['h1']);
});

// ---------- Hipoteza wspólnego operatora a krawędź ----------

test('krawędź same_operator znajduje swoją hipotezę po parze kont, bez względu na kolejność i przedrostek', () => {
  const hypothesis = { id: linkKeyOf('Forum.example|Jan', 'bazar.example|jan_k'), accounts: ['Forum.example|Jan', 'bazar.example|jan_k'] } as OperatorHypothesis;
  const other = { id: linkKeyOf('a|x', 'b|y'), accounts: ['a|x', 'b|y'] } as OperatorHypothesis;
  const edge: GraphEdge = { id: 'same_operator:profile:bazar.example|jan_k>profile:forum.example|jan', from: 'profile:bazar.example|jan_k', to: 'profile:forum.example|jan', kind: 'same_operator' };
  assert.equal(hypothesisForEdge(edge, [other, hypothesis]), hypothesis);
  assert.equal(hypothesisForEdge({ ...edge, id: hypothesis.id }, [hypothesis]), hypothesis);
  assert.equal(hypothesisForEdge(edge, [other]), undefined);
});

test('klucz decyzji o parze kont nie zależy od kolejności ani wielkości liter', () => {
  assert.equal(linkKeyOf('B|y', 'a|X'), 'a|x<->b|y');
  assert.equal(linkKeyOf('a|x', 'B|Y '), 'a|x<->b|y');
});

// ---------- Decyzje i wycofania ----------

const decision = (id: string, key: string, decidedAt: string, extra: Partial<DecisionRecord> = {}): DecisionRecord => ({ id, caseId: 'c', target: 'link', key, decision: 'confirmed', decidedAt, ...extra });

test('wycofana decyzja zostaje w historii, ale nie obowiązuje', () => {
  const list = [
    decision('d1', 'a<->b', '2026-11-20T10:00:00Z', { withdrawnAt: '2026-11-20T11:00:00Z', withdrawnBy: 'analityk' }),
    decision('d2', 'a<->b', '2026-11-20T12:00:00Z', { decision: 'rejected' }),
    decision('d3', 'c<->d', '2026-11-20T09:00:00Z', { withdrawnAt: '2026-11-20T13:00:00Z' }),
  ];
  assert.deepEqual(activeDecisions(list).map((item) => item.id), ['d2']);
  assert.equal(currentDecision(list, 'link', 'A<->B')?.id, 'd2');
  assert.equal(currentDecision(list, 'link', 'c<->d'), undefined);
  assert.equal(currentDecision(list, 'profile', 'a<->b'), undefined);
  assert.deepEqual(decisionHistory(list).map((item) => item.id), ['d3', 'd2', 'd1'], 'od najnowszego zdarzenia, z wycofaniami');
  assert.deepEqual(decisionHistory(list, ['a<->b']).map((item) => item.id), ['d2', 'd1']);
});

// ---------- Powiązane tożsamości: nowy format ----------

test('identyfikator tożsamości w nowym i starym formacie', () => {
  assert.deepEqual(parseIdentityId('tozsamosc:ogloszenia.example|julka_wz'), { service: 'ogloszenia.example', handle: 'julka_wz' });
  assert.deepEqual(parseIdentityId('tozsamosc:julka_wz'), { handle: 'julka_wz' });
  assert.deepEqual(identityAccounts({ id: 'tozsamosc:ogloszenia.example|julka_wz', profiles: [] }), ['ogloszenia.example|julka_wz']);
  assert.deepEqual(identityAccounts({ id: 'tozsamosc:x', accounts: ['a|b', 'c|d'], profiles: [] }), ['a|b', 'c|d']);
  assert.deepEqual(identityAccounts({ id: 'tozsamosc:julka_wz', profiles: [] }), []);
});

test('tożsamość bez statusu i decyzji jest hipotezą, nigdy ustaleniem', () => {
  assert.equal(identityStatus({}), 'hypothesis');
  assert.equal(identityStatus({ decision: 'rejected' }), 'rejected');
  assert.equal(identityStatus({ decision: 'confirmed' }), 'confirmed');
  assert.equal(identityStatus({ status: 'hypothesis', decision: 'confirmed' }), 'hypothesis', 'status z usługi ma pierwszeństwo');
});
