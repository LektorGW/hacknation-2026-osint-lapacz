import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_TAB, DOSSIER_SECTIONS, DOSSIER_TABS, href, parseRoute, sectionOf, toTab } from '../src/router.ts';

const CASE = '677d8c80-78c8-4e2e-961b-00ab5a37d748';

test('dotychczasowe adresy sekcji teczki otwierają ten sam widok', () => {
  const old = ['dowod', 'tozsamosci', 'uslugi', 'graf', 'wskazniki', 'profile', 'adresy', 'przeplywy', 'os-czasu', 'osoby', 'decyzje', 'analizy'] as const;
  for (const tab of old) {
    assert.deepEqual(parseRoute(`#/sprawa/${CASE}/${tab}`), { page: 'case', caseId: CASE, tab });
    assert.deepEqual(parseRoute(`#/analiza/r1/${tab}`), { page: 'run', runId: 'r1', tab });
  }
});

test('teczka bez wskazanej sekcji i z nieznaną sekcją otwiera podsumowanie', () => {
  assert.equal(DEFAULT_TAB, 'podsumowanie');
  assert.deepEqual(parseRoute(`#/sprawa/${CASE}`), { page: 'case', caseId: CASE, tab: 'podsumowanie' });
  assert.equal(toTab('nie-ma-takiej'), 'podsumowanie');
  assert.equal(toTab(undefined), 'podsumowanie');
});

test('nazwy sekcji i skróty działają jako aliasy', () => {
  assert.equal(toTab('pieniadze'), 'dowod');
  assert.equal(toTab('wiecej'), 'wskazniki');
  assert.equal(toTab('ustalenie'), 'osoba');
  assert.equal(toTab('gieldy'), 'uslugi');
  assert.equal(toTab('historia'), 'analizy');
});

test('odnośnik do podsumowania nie dopisuje sekcji; pozostałe — tak, a parseRoute je odczytuje', () => {
  assert.equal(href.case(CASE), `#/sprawa/${CASE}`);
  assert.equal(href.case(CASE, 'podsumowanie'), `#/sprawa/${CASE}`);
  for (const { id } of DOSSIER_TABS) {
    const route = parseRoute(href.case(CASE, id));
    assert.equal(route.page === 'case' && route.tab, id);
  }
});

test('każdy widok należy do dokładnie jednej sekcji, a sekcji jest najwyżej sześć', () => {
  assert.ok(DOSSIER_SECTIONS.length <= 6);
  for (const { id } of DOSSIER_TABS) {
    assert.equal(DOSSIER_SECTIONS.filter((section) => section.tabs.includes(id)).length, 1, id);
  }
  assert.equal(sectionOf('dowod').id, 'pieniadze');
  assert.equal(sectionOf('przeplywy').id, 'pieniadze');
  assert.equal(sectionOf('tozsamosci').id, 'osoba');
  assert.equal(sectionOf('decyzje').id, 'wiecej');
});

test('pozostałe ekrany bez zmian', () => {
  assert.deepEqual(parseRoute('#/'), { page: 'dashboard' });
  assert.deepEqual(parseRoute(''), { page: 'dashboard' });
  assert.deepEqual(parseRoute('#/typowanie/s1'), { page: 'sweep', sweepId: 's1' });
  assert.deepEqual(parseRoute('#/monitoring'), { page: 'monitor' });
  assert.deepEqual(parseRoute('#/zasady'), { page: 'rules' });
});
