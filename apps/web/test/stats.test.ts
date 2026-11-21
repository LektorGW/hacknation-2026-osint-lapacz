import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HIT_THRESHOLD, changeSummary, countHits, fmtStat, intervalLabel, nextSort, sortHistory, summarizeStats } from '../src/stats.ts';

const finding = (score: number, excluded = false) => ({ confidence: { score, excluded } });

test('trafienie: adres nieodrzucony z wynikiem co najmniej 60', () => {
  assert.equal(HIT_THRESHOLD, 60);
  assert.equal(countHits([finding(60), finding(59), finding(95, true), finding(80)]), 2);
});

test('statystyki: średnie po sprawach z analizą, skuteczność i odsetek spraw z trafieniami', () => {
  const summary = summarizeStats(
    [
      { topScore: 90, hits: 3 },
      { topScore: 50, hits: 0 },
      { topScore: 70, hits: 1 },
    ],
    5,
  );
  assert.equal(summary.analysedCases, 3);
  assert.equal(summary.averageConfidence, 70);
  assert.equal(summary.averageHits, 1.3);
  assert.equal(summary.effectiveness, 66.7);
  assert.equal(summary.casesWithHitsShare, 40);
  assert.deepEqual(summarizeStats([], 0), {
    hitThreshold: 60,
    totalCases: 0,
    analysedCases: 0,
    casesWithHits: 0,
    totalHits: 0,
    averageConfidence: null,
    averageHits: null,
    effectiveness: null,
    casesWithHitsShare: null,
  });
  assert.equal(fmtStat(null), '—');
  assert.equal(fmtStat(66.7, '%').replace(/\s/g, ' '), '66,7%');
});

test('historia spraw: domyślnie od najnowszej, sprawy bez analizy zawsze na końcu', () => {
  const rows = [
    { id: 'a', name: 'A', createdAt: '2026-11-01T10:00:00Z', stat: { priority: 80, topScore: 60, cashOutPlnTotal: 100 } },
    { id: 'b', name: 'B', createdAt: '2026-11-20T10:00:00Z' },
    { id: 'c', name: 'C', createdAt: '2026-11-10T10:00:00Z', stat: { priority: 40, topScore: 95, cashOutPlnTotal: 5000 } },
  ];
  assert.deepEqual(sortHistory(rows).map((row) => row.id), ['b', 'c', 'a']);
  assert.deepEqual(sortHistory(rows, 'created', 'asc').map((row) => row.id), ['a', 'c', 'b']);
  assert.deepEqual(sortHistory(rows, 'priority').map((row) => row.id), ['a', 'c', 'b']);
  assert.deepEqual(sortHistory(rows, 'priority', 'asc').map((row) => row.id), ['c', 'a', 'b']);
  assert.deepEqual(sortHistory(rows, 'strength').map((row) => row.id), ['c', 'a', 'b']);
  assert.deepEqual(sortHistory(rows, 'payouts').map((row) => row.id), ['c', 'a', 'b']);
  // Kliknięcie w tę samą kolumnę odwraca kierunek, w nową — zaczyna od malejącego.
  assert.deepEqual(nextSort({ key: 'created', direction: 'desc' }, 'created'), { key: 'created', direction: 'asc' });
  assert.deepEqual(nextSort({ key: 'created', direction: 'asc' }, 'priority'), { key: 'priority', direction: 'desc' });
});

test('monitorowanie: odstępy słownie i krótki opis zmian', () => {
  assert.equal(intervalLabel(60), 'co godzinę');
  assert.equal(intervalLabel(360), 'co 6 godzin');
  assert.equal(intervalLabel(120), 'co 2 godziny');
  assert.equal(intervalLabel(1440), 'codziennie');
  assert.equal(intervalLabel(45), 'co 45 min');
  const diff = { addedAddresses: ['x', 'y'], removedAddresses: [], scoreChanges: [{}], replacedAddresses: [] };
  assert.deepEqual(changeSummary({ diff, newCashOuts: [{}] }), ['2 nowe adresy', '1 zmiana wyniku', '1 nowy przelew do usługi']);
  assert.deepEqual(changeSummary({ diff: { addedAddresses: [], removedAddresses: [], scoreChanges: [], replacedAddresses: [] }, newCashOuts: [] }), []);
});
