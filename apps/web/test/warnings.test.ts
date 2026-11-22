import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectWarnings, groupWarnings, riskSummary, topSeverity } from '../src/warnings.ts';
import type { Warning } from '../src/warnings.ts';

const base = { caseId: 'c1', findings: [], serviceLinks: [], persons: [], profiles: [] };

const transfer = (txid: string, status = 'source_fact') => ({ direction: 'to_mixer', address: 'a', network: 'bitcoin', txid, time: '2026-01-01T00:00:00Z', asset: 'BTC', amount: 0.1, mixerAddress: 'm', mixerLabel: 'WirMix', mixerName: 'WirMix', labelSource: 'zbiór', status, explorerUrl: 'https://e/tx' });
const mixer = (level: 'confirmed' | 'possible', change: Record<string, unknown> = {}) => ({
  level,
  statement: '',
  mixers: level === 'confirmed' ? ['WirMix'] : [],
  outgoing: level === 'confirmed' ? [transfer('t1'), transfer('t2')] : [],
  incoming: [],
  coinjoins: level === 'possible' ? [{ txid: 'cj' }] : [],
  traceStops: [],
  sanctions: [],
  totals: { transactions: 2, outCount: 2, inCount: 0, outPln: 12_000, unvalued: 0 },
  addresses: [],
  limitations: [],
  ...change,
});
const severityOf = (warnings: Warning[], id: string) => warnings.find((item) => item.id === id)?.severity;

test('ostrzeżenia: brak danych — pusta lista (także dla starszej teczki bez pól i dla wartości niepoprawnych)', () => {
  assert.deepEqual(collectWarnings(base), []);
  assert.deepEqual(collectWarnings(null), []);
  assert.deepEqual(collectWarnings({ ...base, mixerExposure: { level: 'none' }, scamWarnings: { level: 'none', addresses: [], poisoning: [] }, riskLists: null, seizures: 'x' }), []);
  assert.deepEqual(groupWarnings([]), []);
  assert.equal(topSeverity([]), undefined);
});

test('ostrzeżenia: poziomy — sankcje i oznaczony mikser krytyczne; oszustwo, incydent, zajęcie wysokie; heurystyki „uwaga”; braki „informacja”', () => {
  const warnings = collectWarnings({
    ...base,
    mixerExposure: mixer('confirmed'),
    riskLists: {
      'addr:tron:T1': { badge: 'lista sankcyjna', status: 'source_fact', summary: 'adres na liście sankcyjnej OFAC SDN', caveat: '' },
      'org:x': { badge: 'lista sankcyjna', status: 'hypothesis', summary: 'zgodność nazwy z wpisem', caveat: '' },
      'org:y': { badge: 'ostrzeżenie KNF', status: 'source_fact', summary: 'wpis na liście KNF', caveat: '' },
    },
    scamWarnings: { level: 'strong', statement: '', addresses: [{ address: 'a', network: 'bitcoin', level: 'strong', independentSources: 3, listHits: [] }], poisoning: [{ address: 'a', lookalike: 'TXabc123456789', genuine: 'TXabd123456789', explanation: '' }], limitations: [] },
    seizures: [{ counterpartyLabel: 'Prokuratura', valuePln: 5_000 }],
    fundingSources: [{ category: 'incident', label: 'Hack giełdy', share: 0.4, amount: 1, hops: 1 }, { category: 'exchange', label: 'Binance', share: 0.6, amount: 1, hops: 1 }],
    indicators: { businessActivity: { indicator: { score: 65, level: 'istotne przesłanki', components: [] } } },
    partial: true,
  });
  assert.equal(severityOf(warnings, 'mikser'), 'krytyczne');
  assert.equal(severityOf(warnings, 'listy-sankcje-fakt'), 'krytyczne');
  assert.equal(severityOf(warnings, 'listy-sankcje-hipoteza'), 'uwaga');
  assert.equal(severityOf(warnings, 'listy-knf-fakt'), 'wysokie');
  assert.equal(severityOf(warnings, 'oszustwo'), 'wysokie');
  assert.equal(severityOf(warnings, 'zajecie'), 'wysokie');
  assert.equal(severityOf(warnings, 'pochodzenie-0'), 'wysokie');
  assert.equal(severityOf(warnings, 'zatruwanie'), 'uwaga');
  assert.equal(severityOf(warnings, 'dzialalnosc'), 'uwaga');
  assert.equal(severityOf(warnings, 'wynik-czesciowy'), 'informacja');
  // Zwykłe źródło środków (giełda) nie jest ostrzeżeniem.
  assert.equal(warnings.filter((item) => item.category === 'Pochodzenie środków').length, 1);
  // Kolejność: od najpoważniejszych.
  const order = ['krytyczne', 'wysokie', 'uwaga', 'informacja'];
  for (let index = 1; index < warnings.length; index += 1) assert.ok(order.indexOf(warnings[index]!.severity) >= order.indexOf(warnings[index - 1]!.severity));
  // Fakt czy hipoteza — jawnie przy każdej pozycji.
  assert.equal(warnings.find((item) => item.id === 'listy-sankcje-fakt')!.status, 'fakt');
  assert.equal(warnings.find((item) => item.id === 'zatruwanie')!.status, 'hipoteza');
  // Odnośniki do sekcji ze szczegółami.
  assert.deepEqual(warnings.find((item) => item.id === 'mikser')!.link, { tab: 'dowod', anchor: 'miksery' });
  assert.deepEqual(warnings.find((item) => item.id === 'oszustwo')!.link, { tab: 'adresy', anchor: 'oszustwo' });
  assert.ok(warnings.every((item) => item.title.length > 0 && !item.title.includes('\n') && !item.detail.includes('\n')));
});

test('ostrzeżenia: możliwy CoinJoin i słabe zgłoszenia oszustwa to „uwaga” (hipoteza); słaby wskaźnik D pominięty', () => {
  const warnings = collectWarnings({
    ...base,
    mixerExposure: mixer('possible'),
    scamWarnings: { level: 'reports', statement: '', addresses: [{ address: 'a', network: 'bitcoin', level: 'reports', independentSources: 1, listHits: [] }], poisoning: [] },
    indicators: { businessActivity: { indicator: { score: 40, level: 'umiarkowane przesłanki', components: [] } } },
  });
  assert.deepEqual(
    warnings.map((item) => [item.id, item.severity, item.status]),
    [
      ['coinjoin', 'uwaga', 'hipoteza'],
      ['oszustwo', 'uwaga', 'hipoteza'],
    ],
  );
});

test('ostrzeżenia: podmiot zarejestrowany (VAT nieaktywny, upadłość), dane niepełne, tokeny niezweryfikowane, obieg środków', () => {
  const warnings = collectWarnings(
    {
      ...base,
      findings: [{ chain: { transfers: [{ asset: 'USDT (niezweryfikowany token 0xdead…)' }, { asset: 'BTC' }] } }],
      sourceErrors: [{ connectorId: 'reddit', stage: 'search', message: 'limit', count: 2 }],
      indicators: {
        businessActivity: {
          indicator: { score: 10, components: [] },
          registered: {
            indicator: {
              score: 30,
              components: [
                { rule: 'business.registered.vat_status_inactive_or_removed', direction: 'supports', applied: 20, explanation: 'Wpływy przy statusie „Zwolniony”.' },
                { rule: 'business.registered.insolvency_or_liquidation', direction: 'supports', applied: 0, explanation: 'Powtórzenie.' },
              ],
            },
          },
        },
      },
      publicFigure: { status: 'hypothesis', wikidataId: 'Q1', label: 'Jan Wzór', match: 'name_only' },
    },
    { roundTrips: 2 },
  );
  const ids = warnings.map((item) => item.id);
  assert.ok(ids.includes('vat-nieaktywny'));
  // Składnik bez doliczonych punktów (powtórzenie) nie jest osobnym ostrzeżeniem.
  assert.ok(!ids.includes('upadlosc'));
  assert.equal(severityOf(warnings, 'ping-pong'), 'uwaga');
  assert.match(warnings.find((item) => item.id === 'ping-pong')!.title, /2 obiegi/);
  assert.equal(severityOf(warnings, 'bledy-zrodel'), 'informacja');
  assert.equal(severityOf(warnings, 'tokeny-niezweryfikowane'), 'informacja');
  assert.match(warnings.find((item) => item.id === 'tokeny-niezweryfikowane')!.title, /1 przelew\)/);
  assert.equal(severityOf(warnings, 'osoba-publiczna'), 'informacja');
});

test('ostrzeżenia: grupowanie po poziomie i jeden globalny wskaźnik ryzyka (najpoważniejszy poziom)', () => {
  const make = (id: string, severity: Warning['severity']): Warning => ({ id, severity, category: 'Dane niepełne', title: id, detail: '', status: 'fakt', link: { tab: 'analizy' } });
  const warnings = [make('a', 'krytyczne'), make('b', 'wysokie'), make('c', 'wysokie'), make('d', 'uwaga'), make('e', 'informacja')];
  assert.deepEqual(
    groupWarnings(warnings).map((group) => [group.severity, group.items.map((item) => item.id)]),
    [
      ['krytyczne', ['a']],
      ['wysokie', ['b', 'c']],
      ['uwaga', ['d']],
      ['informacja', ['e']],
    ],
  );
  assert.equal(topSeverity(warnings.slice(1)), 'wysokie');
  assert.deepEqual(riskSummary(warnings), { level: 'krytyczne', count: 5, text: 'Ryzyko: krytyczne · 5 alertów' });
  assert.deepEqual(riskSummary(warnings.slice(3)), { level: 'uwaga', count: 2, text: 'Ryzyko: uwaga · 2 alerty' });
  assert.equal(riskSummary([make('x', 'informacja')]).text, 'Ryzyko: informacja · 1 alert');
  assert.deepEqual(riskSummary([]), { level: 'brak', count: 0, text: 'Ryzyko: brak alertów' });
});
