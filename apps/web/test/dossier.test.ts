import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisRun, AnalystDecision } from '@olcys/core';
import { computeConfidence } from '../../../packages/core/src/score.ts';
import { ADDR_MAIN, ADDR_NAMESAKE, KEY_FOTO, demoReplacements, demoRuns } from '../src/demo-data.ts';
import { cashOutFlows, cashOutRows, cashOutSeries, computePriority, dossierFromRun, jointProbability, profileKey } from '../src/dossier.ts';
import { buildUniverse, universeHighlight } from '../src/graph/universe.ts';
import { serviceLinksFromFindings, serviceName } from '../src/services.ts';

const NOW = new Date('2026-11-20T10:00:00Z');

/** Analiza demonstracyjna wyceniona prawdziwymi regułami — tak jak zwróciłoby ją starsze API. */
function scoredRun(): AnalysisRun {
  const raw = demoRuns[1]!;
  return {
    ...raw,
    findings: raw.findings.map((finding) => ({
      ...finding,
      confidence: computeConfidence({
        evidence: finding.evidence,
        addressClass: finding.chain?.profile.addressClass ?? 'unknown',
        unrelatedPublishers: finding.unrelatedPublishers,
      }),
    })),
  };
}

const build = (decisions: AnalystDecision[] = []) =>
  dossierFromRun(scoredRun(), { name: 'Sprawa testowa', replacements: demoReplacements, decisions, now: NOW });

test('dossierFromRun: profile powstają ze śladów, po jednym na autora w serwisie', () => {
  const dossier = build();
  assert.equal(dossier.profiles.length, 5);
  const forum = dossier.profiles.find((profile) => profile.service === 'forum-krypto.example')!;
  assert.equal(forum.handle, 'tomwzor');
  assert.equal(forum.identityMatch, 'exact_identifier');
  assert.equal(forum.identityScore, 90);
  assert.equal(forum.addresses.length, 2);
  const namesake = dossier.profiles.find((profile) => profileKey(profile) === KEY_FOTO)!;
  assert.equal(namesake.identityScore, 25);
  assert.deepEqual(namesake.addresses, [`bitcoin:${ADDR_NAMESAKE}`]);
  assert.ok(namesake.identityReasons.length > 0);
});

test('dossierFromRun: identyfikatory podane i odkryte', () => {
  const { subject } = build();
  assert.equal(subject.identifiers.filter((item) => item.origin === 'analyst').length, 3);
  assert.deepEqual(
    subject.identifiers.filter((item) => item.origin === 'discovered').map((item) => item.identifier),
    [{ type: 'login', value: 't-wzorcowy' }],
  );
  assert.ok(subject.knownNames.includes('Tomasz Wzorcowy'));
});

test('dossierFromRun: graf jest spójny — krawędzie łączą istniejące węzły, identyfikatory są unikalne', () => {
  const { graph } = build();
  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.equal(ids.size, graph.nodes.length);
  assert.equal(new Set(graph.edges.map((edge) => edge.id)).size, graph.edges.length);
  for (const edge of graph.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), edge.id);
  for (const kind of ['subject', 'identifier', 'profile', 'address', 'service'] as const) {
    assert.ok(graph.nodes.some((node) => node.kind === kind), kind);
  }
  assert.equal(graph.nodes.filter((node) => node.kind === 'address').length, 6);
  assert.equal(graph.nodes.filter((node) => node.kind === 'address' && node.excluded).length, 2);
  assert.ok(graph.nodes.length >= 30);
  assert.ok(graph.edges.some((edge) => edge.kind === 'cash_out' && edge.inferred));
});

test('dossierFromRun: oś czasu jest uporządkowana i obejmuje publikacje, przelewy, wypłaty i podmianę', () => {
  const { timeline } = build();
  assert.ok(timeline.length >= 30);
  for (let index = 1; index < timeline.length; index += 1) assert.ok(timeline[index - 1]!.time <= timeline[index]!.time);
  for (const kind of ['publication', 'transfer_in', 'cash_out', 'address_replaced'] as const) {
    assert.ok(timeline.some((event) => event.kind === kind), kind);
  }
  assert.ok(timeline.filter((event) => event.kind === 'cash_out').every((event) => event.layer === 'inference'));
});

test('dossierFromRun: sumy, priorytet, kandydat i kluczowe ustalenia', () => {
  const dossier = build();
  const { totals } = dossier;
  assert.equal(totals.linkedAddresses, 4);
  assert.equal(totals.excludedAddresses, 2);
  assert.equal(totals.topScore, 95);
  assert.deepEqual(Object.keys(totals.cashOutPlnByYear).sort(), ['2024', '2025', '2026']);
  assert.equal(totals.cashOutPlnByYear['2024'], 146000);
  assert.ok(totals.priority > 60 && totals.priority <= 100);
  assert.equal(totals.priorityReasons.length, 3);
  assert.equal(dossier.persons.length, 1);
  assert.equal(dossier.persons[0]!.probability, 95);
  assert.equal(dossier.persons[0]!.fullName, 'Tomasz Wzorcowy');
  assert.equal(jointProbability(dossier, { network: 'bitcoin', address: ADDR_MAIN }), 95);
  assert.ok(dossier.keyFindings.length >= 4);
  assert.ok(dossier.keyFindings.some((item) => item.layer === 'inference'));
});

test('dossierFromRun: pusta analiza daje pustą, poprawną teczkę', () => {
  const dossier = dossierFromRun({ ...scoredRun(), findings: [] }, { name: 'Pusta', now: NOW });
  assert.equal(dossier.totals.priority, 0);
  assert.deepEqual(dossier.persons, []);
  assert.deepEqual(dossier.serviceLinks, []);
  assert.equal(dossier.graph.nodes.filter((node) => node.kind !== 'identifier').length, 1);
});

test('decyzje analityka: profil odrzucony zostaje oznaczony, potwierdzony ma pewną tożsamość', () => {
  const decision = (key: string, value: AnalystDecision['decision']): AnalystDecision => ({
    id: key,
    caseId: 'x',
    target: 'profile',
    key,
    decision: value,
    decidedAt: NOW.toISOString(),
  });
  const dossier = build([decision(KEY_FOTO, 'rejected'), decision('bazarek-p2p.example|tomwzor', 'confirmed')]);
  assert.equal(dossier.profiles.find((profile) => profileKey(profile) === KEY_FOTO)!.decision, 'rejected');
  const confirmed = dossier.profiles.find((profile) => profile.service === 'bazarek-p2p.example')!;
  assert.equal(confirmed.identityMatch, 'verified_link');
  assert.equal(confirmed.identityScore, 100);
  assert.ok(!dossier.persons[0]!.profileIds.includes(KEY_FOTO));
});

test('priorytet rośnie z pewnością, skalą i aktualnością wypłat', () => {
  assert.equal(computePriority(0, { '2026': 1e6 }, NOW).priority, 0);
  const low = computePriority(50, {}, NOW).priority;
  const scaled = computePriority(50, { '2022': 100000 }, NOW).priority;
  const recent = computePriority(50, { '2026': 100000 }, NOW).priority;
  const certain = computePriority(95, { '2026': 100000 }, NOW).priority;
  assert.ok(low < scaled && scaled < recent && recent < certain);
  assert.equal(computePriority(100, { '2026': 5e6 }, NOW).priority, 100);
});

test('powiązania z usługami liczone lokalnie: grupowanie po nazwie, kwoty i podstawy', () => {
  assert.equal(serviceName('KryptoGiełda: adres depozytowy'), 'KryptoGiełda');
  assert.equal(serviceName('Binance 14'), 'Binance 14');
  assert.equal(serviceName('Kraken (hot wallet)'), 'Kraken');

  const links = serviceLinksFromFindings(scoredRun().findings);
  const names = links.map((link) => link.name);
  for (const name of ['KryptoGiełda', 'WymianaP2P', 'PłatnośćKrypto', 'KartaKrypto', 'ZamianaDEX', 'Giełda Bałtyk']) {
    assert.ok(names.includes(name), name);
  }
  for (let index = 1; index < links.length; index += 1) assert.ok(links[index - 1]!.strength >= links[index]!.strength);

  const exchange = links.find((link) => link.name === 'KryptoGiełda')!;
  assert.equal(exchange.kind, 'exchange');
  assert.deepEqual([...exchange.basis].sort(), ['transfer_in', 'transfer_out']);
  assert.deepEqual([...exchange.networks].sort(), ['bitcoin', 'ethereum']);
  assert.equal(exchange.transfersOut, 7);
  assert.equal(exchange.transfersIn, 1);
  assert.equal(exchange.outPln, exchange.transfers.reduce((total, item) => total + (item.direction === 'out' ? item.valuePln ?? 0 : 0), 0));
  assert.ok(exchange.requestHints.length >= 3);
  assert.equal(links.find((link) => link.name === 'WymianaP2P')!.kind, 'p2p');
  assert.equal(links.find((link) => link.name === 'ZamianaDEX')!.outPln, undefined);
});

test('uniwersum podmiotu: układ deterministyczny, huby się nie nakładają, kwoty krawędzi zgadzają się z usługami', () => {
  const dossier = build();
  const input = {
    name: 'Tomasz Wzorcowy',
    identifiers: dossier.subject.identifiers,
    profiles: dossier.profiles,
    findings: dossier.findings,
    services: dossier.serviceLinks,
  };
  const graph = buildUniverse(input);
  assert.deepEqual(buildUniverse(input), graph);

  const ids = new Set(graph.nodes.map((node) => node.id));
  assert.equal(ids.size, graph.nodes.length);
  for (const edge of graph.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), edge.id);

  const big = graph.nodes.filter((node) => node.role !== 'service-address' && node.role !== 'bank');
  for (let a = 0; a < big.length; a += 1) {
    for (let b = a + 1; b < big.length; b += 1) {
      const distance = Math.hypot(big[a]!.x - big[b]!.x, big[a]!.y - big[b]!.y);
      assert.ok(distance >= big[a]!.r + big[b]!.r, `${big[a]!.id} i ${big[b]!.id} nakładają się`);
    }
  }
  for (const node of graph.nodes) assert.ok(node.x > 0 && node.x < graph.width && node.y > 0 && node.y < graph.height, node.id);

  for (const service of dossier.serviceLinks) {
    const out = graph.edges.filter((edge) => edge.kind === 'out' && edge.serviceId === service.id);
    assert.equal(out.reduce((total, edge) => total + (edge.valuePln ?? 0), 0), service.outPln ?? 0, service.name);
    assert.equal(out.reduce((total, edge) => total + edge.transfers.length, 0), service.transfersOut);
  }
  assert.ok(graph.nodes.filter((node) => node.role === 'bank').length >= 2);
  assert.ok(graph.edges.filter((edge) => edge.kind === 'bank').every((edge) => edge.dashed));

  const hub = graph.nodes.find((node) => node.role === 'service')!;
  const highlighted = universeHighlight(graph, hub.id);
  assert.ok(graph.nodes.filter((node) => node.hubId === hub.id).every((node) => highlighted.has(node.id)));
});

test('dane wykresów przepływów: lata, rodzaje i zachowanie sumy', () => {
  const rows = cashOutRows(scoredRun().findings);
  const total = rows.reduce((sum, row) => sum + (row.valuePln ?? 0), 0);
  const series = cashOutSeries(rows);
  assert.deepEqual(series.years, ['2024', '2025', '2026']);
  assert.equal(series.series.flatMap((item) => item.values).reduce((sum, value) => sum + value, 0), total);
  assert.ok(!series.series.some((item) => item.kind === 'stablecoin_swap'));
  const flows = cashOutFlows(rows);
  const toYears = flows.links.filter((link) => link.target.startsWith('r:')).reduce((sum, link) => sum + link.value, 0);
  assert.equal(toYears, total);
});
