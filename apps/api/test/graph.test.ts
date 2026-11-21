import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphEdge, GraphNode, HypothesisStatus, Identifier, InvestigationIndicators, OperatorHypothesis, ProfileCard, ScoreComponent, ServiceLink } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import type { LinkedIdentity } from '../src/aliases.ts';
import type { ProfileNode } from '../src/entity.ts';
import { WEAK_OPERATOR_SCORE, buildGraph, chainOnlyNodeIds, evidencePath, graphLegend } from '../src/graph.ts';
import type { GraphInput } from '../src/graph.ts';
import type { CashOutProof } from '../src/proof.ts';
import { BTC_A, BTC_B, BTC_D, BTC_EXCHANGE, dossierOf, evidence, fakeConnector, fakeProvider, finding } from './helpers.ts';

const nick: Identifier = { type: 'nick', value: 'janek' };
const email: Identifier = { type: 'email', value: 'jan@example.com' };

const GIT = 'github.com|janek';
const FORUM = 'forum.example|janek_btc';
const SOCIAL = 'social.example|inny';
const MARKET = 'market.example|sprzedawca';
const GIT_URL = 'https://github.com/janek';
const FORUM_URL = 'https://forum.example/u/janek_btc';

function profile(id: string, url: string, extra: Partial<ProfileCard> = {}, matched: Identifier = nick): ProfileNode {
  const [service, handle] = id.split('|') as [string, string];
  const card: ProfileCard = {
    id,
    service,
    url,
    handle,
    attributes: { handle },
    identityMatch: 'same_handle',
    identityReasons: ['Zgodny nick.'],
    identityScore: 60,
    addresses: [],
    evidenceIds: [],
    ...extra,
  };
  return {
    card,
    sightings: [
      {
        url,
        service,
        connectorId: service,
        title: 'Profil',
        fetchedAt: '2026-11-21T09:00:00.000Z',
        category: 'own_profile',
        matchedIdentifier: matched,
        discoveredIdentifiers: [],
        identity: { match: card.identityMatch, reasons: card.identityReasons },
        step: 0,
        addresses: card.addresses,
        role: 'subject',
      },
    ],
    base: { match: card.identityMatch, reasons: card.identityReasons },
    matchedIdentifier: matched,
    step: 0,
    names: new Set([handle]),
    refs: new Set(),
  };
}

const component = (rule: string, weight: number, extra: Partial<ScoreComponent> = {}): ScoreComponent => ({
  rule,
  weight,
  applied: weight,
  direction: weight < 0 ? 'contradicts' : 'supports',
  source: 'profile kont',
  evidence: [{ kind: 'attribute', value: `cecha:${rule}` }],
  explanation: `Składnik ${rule}.`,
  independence: 'single',
  limitations: ['Nie dowodzi tożsamości.'],
  ...extra,
});

function hypothesis(a: string, b: string, status: HypothesisStatus, score: number, components: ScoreComponent[], extra: Partial<OperatorHypothesis> = {}): OperatorHypothesis {
  const accounts = [a, b].sort() as [string, string];
  return {
    id: accounts.join('<->'),
    accounts,
    accountLabels: [accounts[0].split('|')[1]!, accounts[1].split('|')[1]!],
    personas: ['Jan K.', 'janek_btc'],
    indicator: { kind: 'common_operator', score, level: 'test', calibrated: false, scale: 'porządkowa', components, limitations: [] },
    status,
    statement: `Przesłanki wspólnego operatora kont ${a} i ${b} — hipoteza, nie ustalenie.`,
    path: [],
    ...extra,
  };
}

const evGit = evidence(GIT_URL, { id: 'ev-git', publishedAt: '2024-06-01T00:00:00.000Z' });
const evForum = evidence(FORUM_URL, { id: 'ev-forum', service: 'forum.example', category: 'forum_post', identityMatch: 'same_handle' });

const exchange = {
  id: 'gielda',
  name: 'Giełda Testowa',
  kind: 'exchange',
  networks: ['bitcoin'],
  basis: ['transfer_out'],
  strength: 80,
  reasons: [],
  inferredOnly: false,
  transfersOut: 12,
  transfersIn: 0,
  outPln: 100_000,
  transfers: Array.from({ length: 12 }, (_, index) => ({
    txid: `tx-out-${index}`,
    time: '2025-03-14T10:00:00.000Z',
    direction: 'out',
    asset: 'BTC',
    amount: 0.1,
    valuePln: 8000,
    subjectAddress: BTC_A,
    serviceAddress: BTC_EXCHANGE,
    explorerUrl: `https://explorer.example/tx-out-${index}`,
  })),
  mentions: [{ url: GIT_URL, excerpt: 'Handluję na Giełdzie Testowej', evidenceId: 'ev-git' }],
  requestHints: [],
} as ServiceLink;

const wallet = {
  ...exchange,
  id: 'portfel',
  name: 'Portfel Testowy',
  kind: 'wallet',
  basis: ['transfer_in'],
  outPln: undefined,
  transfers: [{ txid: 'tx-in-1', time: '2025-01-01T00:00:00.000Z', direction: 'in', asset: 'BTC', amount: 1, subjectAddress: BTC_A, serviceAddress: 'adres-portfela', explorerUrl: 'https://explorer.example/tx-in-1' }],
  mentions: [],
} as ServiceLink;

const proof = {
  id: 'dowod-1',
  address: BTC_A,
  network: 'bitcoin',
  personAddressProbability: 80,
  trail: {
    id: 'sciezka-1',
    sourceAddress: BTC_A,
    network: 'bitcoin',
    serviceName: 'Kantor Testowy',
    serviceKind: 'exchange_deposit',
    asset: 'BTC',
    amount: 0.5,
    confidence: 70,
    reasons: [],
    openQuestions: [],
    hops: [
      { txid: 'hop-1', time: '2025-02-01T00:00:00.000Z', from: BTC_A, to: BTC_D, asset: 'BTC', amount: 0.5, explorerUrl: 'https://explorer.example/hop-1' },
      { txid: 'hop-2', time: '2025-02-01T01:00:00.000Z', from: BTC_D, to: 'adres-kantoru', asset: 'BTC', amount: 0.5, explorerUrl: 'https://explorer.example/hop-2' },
    ],
  },
} as unknown as CashOutProof;

const identity = (id: string, displayName: string, extra: Record<string, unknown> = {}) =>
  ({
    id,
    displayName,
    handles: [],
    relation: 'possibly_same_or_close',
    score: 60,
    reasons: [{ text: 'Wspólna strona WWW w obu profilach.', evidence: [{ kind: 'url', value: 'https://strona.example' }] }],
    profiles: [],
    addresses: [],
    cashOutPlnByYear: {},
    cashOutProof: [],
    path: [],
    note: '',
    mergeWith: [],
    ...extra,
  }) as unknown as LinkedIdentity;

function input(extra: Partial<GraphInput> = {}): GraphInput {
  const rejectedAddress = { ...finding(BTC_B, 0, [evForum]), decision: 'rejected' as const };
  const indicators: InvestigationIndicators = {
    accountWallet: [],
    cashOut: [],
    commonOperator: [
      hypothesis(GIT, FORUM, 'auto_grouped', 70, [component('operator.same_email', 70, { evidence: [{ kind: 'attribute', value: 'e-mail: jan@example.com' }, { kind: 'url', value: GIT_URL }] }), component('operator.same_site', 40, { applied: 8 })]),
      hypothesis(GIT, MARKET, 'hypothesis', 25, [component('operator.similar_handle', 25)]),
      hypothesis(GIT, SOCIAL, 'rejected', 60, [component('operator.same_avatar', 60)], { decision: { decision: 'rejected', decidedAt: '2026-11-21T10:00:00.000Z', author: 'analityk', id: 'd-1' } }),
      hypothesis(FORUM, MARKET, 'blocked', 45, [component('operator.same_phone', 85), component('operator.conflicting_names', -40, { blocking: true })]),
      hypothesis(GIT, 'obcy.example|nieznany', 'hypothesis', 20, [component('operator.similar_handle', 20)]),
      hypothesis(GIT, 'kantor.example|wspolnik', 'hypothesis', 65, [component('operator.same_phone', 65)]),
    ],
  };
  return {
    subjectLabel: 'Sprawa testowa',
    caseName: 'Sprawa testowa',
    identifiers: [
      { identifier: nick, origin: 'analyst' },
      { identifier: email, origin: 'discovered' },
    ],
    profiles: [
      profile(GIT, GIT_URL, { identityMatch: 'exact_identifier', identityScore: 90, addresses: [`bitcoin:${BTC_A}`], evidenceIds: ['ev-git'], attributes: { handle: 'janek', displayName: 'Jan K.' } }),
      profile(FORUM, FORUM_URL, { addresses: [`bitcoin:${BTC_B}`], evidenceIds: ['ev-forum'] }),
      profile(SOCIAL, 'https://social.example/inny', { decision: 'rejected' }),
      profile(MARKET, 'https://market.example/sprzedawca'),
    ],
    mainProfileIds: new Set([GIT, FORUM]),
    findings: [finding(BTC_A, 85, [evGit]), rejectedAddress],
    serviceLinks: [exchange, wallet],
    relatedPersons: [{ id: 'bartek', handle: 'bartek_p2p', services: ['forum.example'], relations: [{ kind: 'transacted', via: `bitcoin:${BTC_A}`, description: 'Bezpośredni przelew.' }], strength: 50, profileUrls: [] }],
    trail: [{ identifier: email, step: 1, sourceUrl: GIT_URL, sourceService: 'github.com', via: nick, match: 'exact_identifier', followed: true }],
    proofs: [proof],
    linkedIdentities: [identity('tozsamosc:social.example|julka', 'Julia K.'), identity('tozsamosc:social.example|obca', 'Obca Osoba', { status: 'rejected', decision: 'rejected' })],
    indicators,
    ...extra,
  };
}

const edgeOf = (edges: GraphEdge[], kind: GraphEdge['kind'], from: string, to: string) => edges.find((edge) => edge.kind === kind && edge.from === from && edge.to === to);
const nodeOf = (nodes: GraphNode[], id: string) => nodes.find((node) => node.id === id);

test('graf śledczy: rodzaje węzłów, identyfikatory i zgodność wsteczna', () => {
  const { nodes, edges } = buildGraph(input());
  assert.deepEqual([...new Set(nodes.map((node) => node.kind))].sort(), ['address', 'identifier', 'operator', 'person', 'persona', 'profile', 'service', 'source', 'subject']);
  for (const id of ['subject', 'id:nick:janek', `addr:bitcoin:${BTC_A}`, `profile:${GIT}`, 'operator:1', 'persona:jan k.', `source:${GIT_URL}`, 'svc:gielda', 'identity:tozsamosc:social.example|julka', 'person:bartek']) {
    assert.ok(nodeOf(nodes, id), `brak węzła ${id}`);
  }
  const ids = new Set(nodes.map((node) => node.id));
  assert.equal(ids.size, nodes.length);
  assert.ok(edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
  assert.equal(new Set(edges.map((edge) => edge.id)).size, edges.length);
  // Każda krawędź ma status i warstwę; `inferred` oznacza dokładnie status „hipoteza”.
  assert.ok(edges.every((edge) => edge.status !== undefined && edge.layer !== undefined));
  assert.ok(edges.every((edge) => (edge.inferred === true) === (edge.status === 'hypothesis')));
  // Źródło jest podpięte pod konto, które je opublikowało, i ma adres URL.
  const source = nodeOf(nodes, `source:${GIT_URL}`)!;
  assert.deepEqual([source.parent, source.url, source.status], [`profile:${GIT}`, GIT_URL, 'source_fact']);
  assert.equal(nodeOf(nodes, 'persona:jan k.')!.parent, 'operator:1');
});

test('graf śledczy: statusy krawędzi — fakt, obliczenie, hipoteza, odrzucenie', () => {
  const { edges } = buildGraph(input());
  assert.equal(edgeOf(edges, 'has_identifier', 'subject', 'id:nick:janek')!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'has_identifier', 'subject', 'id:email:jan@example.com')!.status, 'hypothesis');
  // Konto znalezione po unikalnym identyfikatorze to fakt; po samym nicku — hipoteza; odrzucone zostaje jako odrzucone.
  assert.equal(edgeOf(edges, 'found_profile', 'id:nick:janek', `profile:${GIT}`)!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'found_profile', 'id:nick:janek', `profile:${FORUM}`)!.status, 'hypothesis');
  assert.equal(edgeOf(edges, 'found_profile', 'id:nick:janek', `profile:${SOCIAL}`)!.status, 'rejected');
  assert.equal(edgeOf(edges, 'publishes', `profile:${GIT}`, `addr:bitcoin:${BTC_A}`)!.status, 'source_fact');
  // Adres odrzucony decyzją analityka nie znika z grafu.
  const rejected = edgeOf(edges, 'publishes', `profile:${FORUM}`, `addr:bitcoin:${BTC_B}`)!;
  assert.deepEqual([rejected.status, rejected.inferred], ['rejected', undefined]);
  assert.equal(edgeOf(edges, 'declares', `profile:${GIT}`, 'persona:jan k.')!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'documented_by', `addr:bitcoin:${BTC_A}`, `source:${GIT_URL}`)!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'documented_by', `profile:${GIT}`, `source:${GIT_URL}`)!.status, 'source_fact');
  // Wypłata jest wnioskiem, pojedynczy przelew bez wyceny — faktem, krok ścieżki z transakcji — faktem, dotarcie do usługi — hipotezą.
  assert.equal(edgeOf(edges, 'cash_out', `addr:bitcoin:${BTC_A}`, 'svc:gielda')!.status, 'hypothesis');
  assert.equal(edgeOf(edges, 'transfer', 'svc:portfel', `addr:bitcoin:${BTC_A}`)!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'cash_out', `addr:bitcoin:${BTC_A}`, `addr:bitcoin:${BTC_D}`)!.status, 'source_fact');
  assert.equal(edgeOf(edges, 'cash_out', `addr:bitcoin:${BTC_D}`, 'svc:kantor-testowy')!.status, 'hypothesis');
  // Powiązane tożsamości: hipoteza albo odrzucenie — nigdy fakt.
  assert.equal(edges.find((edge) => edge.to === 'identity:tozsamosc:social.example|julka')!.status, 'hypothesis');
  assert.equal(edges.find((edge) => edge.to === 'identity:tozsamosc:social.example|obca')!.status, 'rejected');
  assert.equal(edges.find((edge) => edge.to === 'person:bartek')!.status, 'hypothesis');
});

test('graf śledczy: warstwa blockchain osobno od warstwy tożsamości', () => {
  const graph = buildGraph(input());
  for (const edge of graph.edges) {
    assert.equal(edge.layer, edge.kind === 'transfer' || edge.kind === 'cash_out' ? 'chain' : 'identity', `warstwa krawędzi ${edge.id}`);
  }
  const chainOnly = chainOnlyNodeIds(graph);
  assert.ok(chainOnly.has(`addr:bitcoin:${BTC_D}`));
  assert.ok(chainOnly.has('svc:portfel'));
  // Giełda ma też wzmiankę w profilu, a adres podmiotu publikację — nie są wyłącznie „łańcuchowe”.
  assert.ok(!chainOnly.has('svc:gielda') && !chainOnly.has(`addr:bitcoin:${BTC_A}`) && !chainOnly.has('subject'));
});

test('graf śledczy: hipotezy wspólnego operatora — zgrupowana, słaba, zablokowana, odrzucona', () => {
  const { nodes, edges } = buildGraph(input());
  const sameOperator = (a: string, b: string) => {
    const [from, to] = [a, b].sort();
    return edgeOf(edges, 'same_operator', `profile:${from}`, `profile:${to}`);
  };
  const grouped = sameOperator(GIT, FORUM)!;
  assert.deepEqual([grouped.status, grouped.weight, grouped.inferred], ['hypothesis', 70, true]);
  assert.equal(grouped.label, 'hipoteza wspólnego operatora (konta zgrupowane automatycznie)');
  assert.match(grouped.explanation!, /hipoteza, nie ustalenie/);
  // Dowody krawędzi to suma dowodów składników, bez powtórzeń.
  assert.deepEqual(grouped.evidence, [
    { kind: 'attribute', value: 'e-mail: jan@example.com' },
    { kind: 'url', value: GIT_URL },
    { kind: 'attribute', value: 'cecha:operator.same_site' },
  ]);

  const weak = sameOperator(GIT, MARKET)!;
  assert.deepEqual([weak.status, weak.weight, weak.label], ['hypothesis', 25, 'słaba hipoteza wspólnego operatora (do weryfikacji)']);
  assert.ok(weak.weight! < WEAK_OPERATOR_SCORE);
  const blocked = sameOperator(FORUM, MARKET)!;
  assert.deepEqual([blocked.status, blocked.label], ['hypothesis', 'hipoteza wspólnego operatora (zablokowana sprzecznością)']);
  const rejected = sameOperator(GIT, SOCIAL)!;
  assert.deepEqual([rejected.status, rejected.inferred], ['rejected', undefined]);
  assert.ok(rejected.evidence!.some((item) => item.kind === 'decision' && item.value === 'd-1'));

  // Węzeł operatora obejmuje tylko konta zgrupowane; słaba, zablokowana i odrzucona hipoteza nie dołączają konta.
  const operators = nodes.filter((node) => node.kind === 'operator');
  assert.deepEqual(operators.map((node) => [node.id, node.label, node.status]), [['operator:1', 'Hipoteza operatora #1', 'hypothesis']]);
  assert.deepEqual(edges.filter((edge) => edge.kind === 'operates' && edge.from === 'operator:1').map((edge) => edge.to).sort(), [`profile:${FORUM}`, `profile:${GIT}`]);
  assert.ok(edges.filter((edge) => edge.kind === 'operates').every((edge) => edge.status === 'hypothesis'));
  assert.equal(edgeOf(edges, 'operates', 'subject', 'operator:1')!.status, 'hypothesis');

  // Słaba hipoteza o koncie spoza sprawy nie tworzy węzła; istotna — tworzy węzeł konta i krawędź.
  assert.ok(!nodeOf(nodes, 'profile:obcy.example|nieznany'));
  assert.ok(nodeOf(nodes, 'profile:kantor.example|wspolnik')!.excluded);
  assert.equal(sameOperator(GIT, 'kantor.example|wspolnik')!.status, 'hypothesis');
});

test('graf śledczy: potwierdzenie analityka zmienia status hipotezy operatora', () => {
  const base = input();
  const confirmed = hypothesis(GIT, MARKET, 'confirmed', 100, [component('operator.same_email', 85)], { decision: { decision: 'confirmed', decidedAt: '2026-11-21T10:00:00.000Z', author: 'analityk', id: 'd-2' } });
  const { nodes, edges } = buildGraph({ ...base, mainProfileIds: new Set([GIT]), indicators: { accountWallet: [], cashOut: [], commonOperator: [confirmed] } });
  const operator = nodes.find((node) => node.kind === 'operator')!;
  assert.deepEqual([operator.status, operator.label], ['confirmed', 'Hipoteza operatora #1']);
  assert.match(operator.sublabel!, /potwierdzony decyzją analityka/);
  assert.equal(edges.find((edge) => edge.kind === 'same_operator')!.status, 'confirmed');
  assert.ok(edges.filter((edge) => edge.kind === 'operates').every((edge) => edge.status === 'confirmed'));

  // Kandydaci na osobę przekazani wprost: każdy z więcej niż jednym kontem to osobna hipoteza operatora.
  const persons = buildGraph({
    ...base,
    indicators: undefined,
    persons: [
      { id: 'osoba-1', nameVariants: [], probability: 80, reasons: [], attributes: [], profileIds: [GIT, FORUM], addresses: [], status: 'hypothesis' },
      { id: 'osoba-2', nameVariants: [], probability: 30, reasons: [], attributes: [], profileIds: [SOCIAL, MARKET], addresses: [] },
    ],
  });
  assert.deepEqual(persons.nodes.filter((node) => node.kind === 'operator').map((node) => [node.id, node.status, node.score]), [['operator:1', 'hypothesis', 80], ['operator:2', 'hypothesis', 30]]);
  assert.equal(edgeOf(persons.edges, 'operates', 'operator:2', `profile:${SOCIAL}`)!.status, 'rejected');
  assert.ok(!persons.edges.some((edge) => edge.kind === 'same_operator'));
});

test('graf śledczy: dowody i wyjaśnienia na krawędziach', () => {
  const { edges } = buildGraph(input());
  const publishes = edgeOf(edges, 'publishes', `profile:${GIT}`, `addr:bitcoin:${BTC_A}`)!;
  assert.deepEqual(publishes.evidence, [{ kind: 'evidence_id', value: 'ev-git' }, { kind: 'url', value: GIT_URL }]);
  assert.match(publishes.explanation!, /nie dowodzi dysponowania kluczem prywatnym/);
  const found = edgeOf(edges, 'found_profile', 'id:nick:janek', `profile:${GIT}`)!;
  assert.deepEqual(found.evidence, [{ kind: 'attribute', value: 'nick: janek' }, { kind: 'url', value: GIT_URL }]);
  assert.match(found.explanation!, /identyfikatorze „janek”\. Zgodny nick\./);
  // Przelewy: najwyżej 10 identyfikatorów transakcji i adres podmiotu.
  const cashOut = edgeOf(edges, 'cash_out', `addr:bitcoin:${BTC_A}`, 'svc:gielda')!;
  assert.equal(cashOut.evidence!.filter((item) => item.kind === 'txid').length, 10);
  assert.ok(cashOut.evidence!.some((item) => item.kind === 'address' && item.value === BTC_A));
  assert.deepEqual(edgeOf(edges, 'cash_out', `addr:bitcoin:${BTC_A}`, `addr:bitcoin:${BTC_D}`)!.evidence![0], { kind: 'txid', value: 'hop-1' });
  const discovered = edgeOf(edges, 'has_identifier', 'subject', 'id:email:jan@example.com')!;
  assert.ok(discovered.evidence!.some((item) => item.kind === 'url' && item.value === GIT_URL));
  assert.ok(edges.filter((edge) => ['publishes', 'found_profile', 'declares', 'documented_by', 'same_operator', 'operates'].includes(edge.kind)).every((edge) => edge.explanation));
});

test('graf śledczy: słabe przesłanki nie wyglądają jak potwierdzona tożsamość', () => {
  const { nodes } = buildGraph(input({ linkedIdentities: [identity('tozsamosc:social.example|julka', 'Julia K.')] }));
  const claims = nodes.filter((node) => node.kind === 'operator' || node.kind === 'persona' || node.kind === 'person');
  assert.ok(claims.length >= 4);
  for (const node of claims) {
    assert.equal(node.status, 'hypothesis', `węzeł ${node.id}`);
    assert.match(node.sublabel!, /hipoteza — do weryfikacji/, `podpis węzła ${node.id}`);
  }
  // Etykieta operatora nigdy nie jest nazwiskiem.
  assert.ok(nodes.filter((node) => node.kind === 'operator').every((node) => /^Hipoteza operatora #\d+$/.test(node.label)));
});

test('ścieżka dowodowa: najmocniejsza podstawa wygrywa z krótszą hipotezą', () => {
  const graph = buildGraph(input());
  const path = evidencePath(graph, 'id:nick:janek', `addr:bitcoin:${BTC_A}`)!;
  assert.deepEqual(path.map((edge) => [edge.kind, edge.status]), [['found_profile', 'source_fact'], ['publishes', 'source_fact']]);
  assert.deepEqual(evidencePath(graph, 'subject', 'subject'), []);
  assert.equal(evidencePath(graph, 'subject', 'nie-ma-takiego'), null);
  // Do usługi na końcu ścieżki środków prowadzi tylko hipoteza — ścieżka istnieje, ale zawiera krawędź-hipotezę.
  const toService = evidencePath(graph, `addr:bitcoin:${BTC_A}`, 'svc:kantor-testowy')!;
  assert.deepEqual(toService.map((edge) => edge.status), ['source_fact', 'hypothesis']);

  const node = (id: string): GraphNode => ({ id, kind: 'profile', label: id });
  const edge = (from: string, to: string, status: GraphEdge['status'], weight?: number): GraphEdge => ({ id: `links_to:${from}>${to}`, from, to, kind: 'links_to', status, weight });
  const small = {
    nodes: ['a', 'b', 'c', 'd', 'e'].map(node),
    edges: [edge('a', 'b', 'hypothesis', 95), edge('a', 'c', 'source_fact'), edge('c', 'd', 'confirmed'), edge('b', 'd', 'source_fact'), edge('a', 'e', 'rejected'), edge('a', 'd', 'computed', 10), edge('c', 'b', 'computed', 90)],
  };
  // a→b: bezpośrednia hipoteza przegrywa z dłuższą ścieżką z samych faktów i potwierdzeń (przechodzoną także „pod prąd”).
  assert.deepEqual(evidencePath(small, 'a', 'b')!.map((item) => item.id), ['links_to:a>c', 'links_to:c>d', 'links_to:b>d']);
  // Krawędź odrzucona nie tworzy ścieżki.
  assert.equal(evidencePath(small, 'a', 'e'), null);
  // Bez faktów: obliczenie przed hipotezą, a przy tej samej długości — wyższa waga.
  const noFacts = { nodes: small.nodes, edges: [edge('a', 'b', 'hypothesis', 95), edge('a', 'c', 'computed', 20), edge('a', 'd', 'computed', 80), edge('c', 'b', 'computed', 50), edge('d', 'b', 'computed', 50)] };
  assert.deepEqual(evidencePath(noFacts, 'a', 'b')!.map((item) => item.id), ['links_to:a>d', 'links_to:d>b']);
});

test('legenda grafu opisuje wszystkie statusy po polsku', () => {
  assert.deepEqual(graphLegend.map((item) => item.status), ['source_fact', 'computed', 'hypothesis', 'confirmed', 'rejected']);
  assert.ok(graphLegend.every((item) => item.label.length > 0 && item.description.length > 20));
  assert.equal(graphLegend.find((item) => item.status === 'hypothesis')!.label, 'hipoteza — do weryfikacji');
});

test('graf z teczki: nowe węzły i statusy przy zachowaniu dotychczasowych identyfikatorów', async () => {
  const subject = { type: 'nick' as const, value: 'krypto_janek' };
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'krypto_janek' } },
  ]);
  const result = await runAnalysis({ query: { identifiers: [subject] }, connectors: [gitpub], chainProviders: [fakeProvider()] });
  const { nodes, edges } = dossierOf(result, { identifiers: [subject] }).graph;
  for (const id of ['subject', 'id:nick:krypto_janek', 'profile:gitpub.example|krypto_janek', `addr:bitcoin:${BTC_A}`, 'persona:krypto_janek', 'source:https://gitpub.example/krypto_janek']) {
    assert.ok(nodeOf(nodes, id), `brak węzła ${id}`);
  }
  assert.ok(edges.every((edge) => edge.status !== undefined && edge.layer !== undefined));
  assert.equal(edgeOf(edges, 'publishes', 'profile:gitpub.example|krypto_janek', `addr:bitcoin:${BTC_A}`)!.status, 'source_fact');
  const path = evidencePath({ nodes, edges }, 'subject', 'source:https://gitpub.example/krypto_janek')!;
  assert.ok(path.length >= 2 && path.at(-1)!.kind === 'documented_by');
});
