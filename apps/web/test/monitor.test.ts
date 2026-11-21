import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_HIT_FILTER, LIMIT_RANGE, countDismissed, filterHits, hitBasisLabel, hitTotal, lastRunRows, parseLimit, sortHits } from '../src/monitor.ts';
import type { MonitorHit } from '../src/monitor.ts';

const hit = (id: string, change: Partial<MonitorHit> & { polish?: number; suspicion?: number } = {}): MonitorHit => {
  const { polish = 50, suspicion = 50, ...rest } = change;
  return {
    id,
    detectedAt: '2026-01-01T00:00:00Z',
    connectorId: 'c',
    service: 'forum',
    url: `https://example.test/${id}`,
    title: id,
    excerpt: '',
    language: 'pl',
    addresses: [],
    polishNexus: { score: polish, reasons: [] },
    suspicion: { score: suspicion, reasons: [] },
    status: 'new',
    ...rest,
  };
};

const ids = (hits: MonitorHit[]) => hits.map((item) => item.id);

test('podstawa trafienia po polsku; brak — pominięta, nieznana — bez zmian', () => {
  assert.equal(hitBasisLabel('own_address'), 'autor podaje adres jako własny');
  assert.equal(hitBasisLabel('offer_poland'), 'oferta obrotu kryptowalutą ze związkiem z Polską');
  assert.equal(hitBasisLabel('address_poland'), 'adres i związek z Polską');
  assert.equal(hitBasisLabel(undefined), undefined);
  assert.equal(hitBasisLabel('inna'), 'inna');
});

test('filtr: odrzucone domyślnie ukryte, przełącznik je pokazuje', () => {
  const hits = [hit('a'), hit('b', { status: 'dismissed' }), hit('c', { status: 'analyzed' })];
  assert.deepEqual(ids(filterHits(hits, DEFAULT_HIT_FILTER)), ['a', 'c']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, showDismissed: true })), ['a', 'b', 'c']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, status: 'dismissed' })), ['b']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, status: 'new', showDismissed: true })), ['a']);
  assert.equal(countDismissed(hits), 1);
});

test('filtr: „tylko ze związkiem z Polską” to próg 40, nie niższy od suwaka', () => {
  const hits = [hit('a', { polish: 39 }), hit('b', { polish: 40 }), hit('c', { polish: 90 })];
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, polishOnly: true })), ['b', 'c']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, polishOnly: true, minPolish: 60 })), ['c']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, minPolish: 10 })), ['a', 'b', 'c']);
});

test('filtr: sieć, serwis i sygnały', () => {
  const hits = [
    hit('a', { addresses: [{ address: 'x', network: 'bitcoin' }] }),
    hit('b', { service: 'targ', suspicion: 10 }),
    // Trafienie ze starszej usługi bez listy adresów nie może wysypać filtra.
    hit('c', { addresses: undefined as unknown as MonitorHit['addresses'] }),
  ];
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, network: 'bitcoin' })), ['a']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, service: 'targ' })), ['b']);
  assert.deepEqual(ids(filterHits(hits, { ...DEFAULT_HIT_FILTER, minSuspicion: 20 })), ['a', 'c']);
});

test('sortowanie: od najwyższej sumy ocen, przy remisie nowsze wyżej; albo po dacie', () => {
  const hits = [
    hit('niska', { polish: 10, suspicion: 10, publishedAt: '2026-03-01T00:00:00Z' }),
    hit('wysoka-stara', { polish: 100, suspicion: 80, publishedAt: '2025-01-01T00:00:00Z' }),
    hit('wysoka-nowa', { polish: 80, suspicion: 100, publishedAt: '2026-02-01T00:00:00Z' }),
  ];
  assert.equal(hitTotal(hits[1]!), 180);
  assert.deepEqual(ids(sortHits(hits, 'total')), ['wysoka-nowa', 'wysoka-stara', 'niska']);
  assert.deepEqual(ids(sortHits(hits, 'date')), ['niska', 'wysoka-nowa', 'wysoka-stara']);
  assert.equal(hits[0]!.id, 'niska');
});

test('limity: liczba całkowita przycięta do zakresu, błędny wpis odrzucony', () => {
  assert.equal(parseLimit('25', LIMIT_RANGE.maxAutoAnalyses), 25);
  assert.equal(parseLimit('999', LIMIT_RANGE.maxAutoAnalyses), 200);
  assert.equal(parseLimit('-3', LIMIT_RANGE.maxAutoAnalyses), 0);
  assert.equal(parseLimit('12.6', LIMIT_RANGE.maxAiPublications), 13);
  assert.equal(parseLimit('5000', LIMIT_RANGE.maxAiPublications), 2000);
  assert.equal(parseLimit('', LIMIT_RANGE.maxAiPublications), undefined);
  assert.equal(parseLimit('abc', LIMIT_RANGE.maxAiPublications), undefined);
});

test('ostatni przebieg: wiersze z liczników, brakujące pominięte', () => {
  assert.deepEqual(lastRunRows(undefined), []);
  assert.deepEqual(lastRunRows({}), []);
  const rows = lastRunRows({ documents: 1200, withAddress: 40, candidates: 60, aiRead: 55, contractsFiltered: 3, hits: 7, analyzed: 2, skipped: { noAuthorNoAddress: 1, limit: 0, belowThreshold: 4 } });
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row.value), [1200, 40, 60, 55, 3, 7, 2, 1, 0, 4]);
  assert.ok(rows.every((row) => typeof row.label === 'string' && row.label.length > 0));
  // Starsza usługa bez rozbicia pominiętych analiz.
  assert.equal(lastRunRows({ documents: 5, hits: 1 }).length, 2);
});
