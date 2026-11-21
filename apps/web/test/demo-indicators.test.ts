import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AnalysisRun, AnalystDecision } from '@olcys/core';
import { combineComponents } from '../../../packages/core/src/indicators.ts';
import { computeConfidence } from '../../../packages/core/src/score.ts';
import { demoReplacements, demoRuns } from '../src/demo-data.ts';
import { applyDemoInvestigation } from '../src/demo-indicators.ts';
import { dossierFromRun } from '../src/dossier.ts';
import { edgeStatus, hypothesisForEdge, nodeStatus } from '../src/graph/investigation.ts';
import type { FullDossier } from '../src/proof.ts';

const NOW = new Date('2026-11-20T10:00:00Z');

function scoredRun(): AnalysisRun {
  const raw = demoRuns[1]!;
  return {
    ...raw,
    findings: raw.findings.map((finding) => ({
      ...finding,
      confidence: computeConfidence({ evidence: finding.evidence, addressClass: finding.chain?.profile.addressClass ?? 'unknown', unrelatedPublishers: finding.unrelatedPublishers }),
    })),
  };
}

const build = (decisions: AnalystDecision[] = []): FullDossier =>
  applyDemoInvestigation(dossierFromRun(scoredRun(), { name: 'Sprawa testowa', replacements: demoReplacements, decisions, now: NOW }) as FullDossier, decisions);

test('teczka demo ma trzy wskaźniki z jawnymi składnikami, a żaden nie udaje prawdopodobieństwa', () => {
  const { indicators } = build();
  assert.ok(indicators);
  assert.ok(indicators.accountWallet.length > 0 && indicators.commonOperator.length > 0 && indicators.cashOut.length > 0);
  for (const item of [...indicators.accountWallet, ...indicators.commonOperator, ...indicators.cashOut]) {
    assert.equal(item.indicator.calibrated, false);
    assert.ok(item.indicator.score >= 0 && item.indicator.score <= 100);
    assert.ok(item.indicator.components.length > 0, item.id);
    assert.match(item.indicator.scale, /nie jest skalibrowanym/);
  }
});

test('wskaźnik B w demo jest wynikiem combineComponents, nie liczbą wpisaną ręcznie', () => {
  for (const hypothesis of build().indicators!.commonOperator) {
    const drafts = hypothesis.indicator.components.map(({ applied: _applied, independence: _independence, ...component }, index) => ({
      ...component,
      weight: Math.abs(component.weight),
      // Składnik zależny powtarza pochodzenie wcześniejszego — odtwarzamy to wspólnym kluczem.
      originKey: `${component.rule}:${component.evidence[0]?.value ?? index}`,
    }));
    const recomputed = combineComponents('common_operator', drafts);
    assert.equal(hypothesis.indicator.score, recomputed.score, hypothesis.id);
    assert.ok(hypothesis.indicator.score <= 95, 'bez decyzji analityka wskaźnik nie przekracza 95');
    assert.notEqual(hypothesis.status, 'confirmed');
  }
});

test('wyjście do fiat w demo nigdy nie osiąga szczebla udokumentowanego i niesie stałe ograniczenie', () => {
  for (const item of build().indicators!.cashOut) {
    assert.notEqual(item.stage, 'documented_fiat_exit');
    assert.ok(item.status === 'computed' || item.status === 'hypothesis');
    assert.ok(item.indicator.limitations.some((text) => text.includes('wyłącznie usługa')));
    assert.ok(item.txids.length > 0);
  }
});

test('każda relacja grafu demo ma status, a hipotezy nie wyglądają na ustalenia', () => {
  const dossier = build();
  assert.ok(dossier.graph.edges.every((edge) => edge.status !== undefined && edge.layer !== undefined));
  const operator = dossier.graph.nodes.find((node) => node.kind === 'operator');
  assert.ok(operator);
  assert.equal(nodeStatus(operator), 'hypothesis');
  const links = dossier.graph.edges.filter((edge) => edge.kind === 'same_operator');
  assert.ok(links.length > 0);
  for (const edge of links) {
    assert.equal(edgeStatus(edge), 'hypothesis');
    assert.ok(hypothesisForEdge(edge, dossier.indicators!.commonOperator), edge.id);
  }
  assert.ok(dossier.graph.edges.filter((edge) => edge.kind === 'operates').every((edge) => edgeStatus(edge) === 'hypothesis'));
  const sources = dossier.graph.nodes.filter((node) => node.kind === 'source');
  assert.ok(sources.length > 0 && sources.every((node) => node.parent !== undefined));
});

test('decyzja analityka o parze kont zmienia status hipotezy i krawędzi', () => {
  const first = build().indicators!.commonOperator[0]!;
  const decide = (decision: 'confirmed' | 'rejected'): AnalystDecision[] => [{ id: 'd1', caseId: 'c', target: 'link', key: first.id, decision, decidedAt: NOW.toISOString() }];

  const confirmed = build(decide('confirmed'));
  const confirmedItem = confirmed.indicators!.commonOperator.find((item) => item.id === first.id)!;
  assert.equal(confirmedItem.status, 'confirmed');
  assert.equal(confirmedItem.indicator.score, 100);
  assert.equal(edgeStatus(confirmed.graph.edges.find((edge) => edge.kind === 'same_operator' && hypothesisForEdge(edge, [confirmedItem]))!), 'confirmed');

  const rejected = build(decide('rejected'));
  const rejectedItem = rejected.indicators!.commonOperator.find((item) => item.id === first.id)!;
  assert.equal(rejectedItem.status, 'rejected');
  assert.ok(rejectedItem.indicator.score <= 45);
  assert.ok(rejectedItem.indicator.components.some((component) => component.direction === 'contradicts' && component.blocking));
  assert.equal(edgeStatus(rejected.graph.edges.find((edge) => edge.kind === 'same_operator' && hypothesisForEdge(edge, [rejectedItem]))!), 'rejected');
});
