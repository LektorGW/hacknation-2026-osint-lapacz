import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtShare, hopsText, mentionServices, relatedKindLabel, relatedSummary, sortRelated, splitLinks } from '../src/funds.ts';
import type { RelatedAddress } from '../src/funds.ts';

const related = (change: Partial<RelatedAddress>): RelatedAddress => ({ address: 'a', kind: 'same_wallet', strength: 50, txids: [], ...change });

test('adresy powiązane: rodzaj po polsku, nieznany bez zmian', () => {
  assert.equal(relatedKindLabel('same_wallet'), 'ten sam portfel (heurystyka)');
  assert.equal(relatedKindLabel('funded_by'), 'finansowany z');
  assert.equal(relatedKindLabel('funds'), 'finansuje');
  assert.equal(relatedKindLabel('co_depositor'), 'wpłaca na ten sam adres wpłat');
  assert.equal(relatedKindLabel('repeated_counterparty'), 'powtarzający się kontrahent');
  assert.equal(relatedKindLabel('nowy_rodzaj'), 'nowy_rodzaj');
});

test('adresy powiązane: sortowanie od najmocniejszego nie zmienia wejścia i zachowuje kolejność remisów', () => {
  const items = [related({ address: 'x', strength: 40 }), related({ address: 'y', strength: 75 }), related({ address: 'z', strength: 75 })];
  assert.deepEqual(sortRelated(items).map((item) => item.address), ['y', 'z', 'x']);
  assert.equal(items[0]!.address, 'x');
  assert.deepEqual(sortRelated([]), []);
});

test('adresy powiązane: podsumowanie rodzajów', () => {
  assert.equal(relatedSummary([related({}), related({}), related({ kind: 'funded_by' })]), 'ten sam portfel (heurystyka): 2 · finansowany z: 1');
  assert.equal(relatedSummary([]), '');
});

test('udział: ułamek jako procent, znikomy udział niezerowej kwoty to „<1%”', () => {
  assert.equal(fmtShare(1, 567.48), '100%');
  assert.equal(fmtShare(0.256, 1), '26%');
  assert.equal(fmtShare(0, 0.00577852), '<1%');
  assert.equal(fmtShare(0.004, 1), '<1%');
  assert.equal(fmtShare(0, 0), '0%');
  assert.equal(fmtShare(1.7, 1), '100%');
  assert.equal(fmtShare(undefined), '—');
  assert.equal(fmtShare(Number.NaN), '—');
});

test('liczba kroków słownie', () => {
  assert.equal(hopsText(1), '1 krok');
  assert.equal(hopsText(2), '2 kroki');
  assert.equal(hopsText(5), '5 kroków');
  assert.equal(hopsText(12), '12 kroków');
  assert.equal(hopsText(22), '22 kroki');
  assert.equal(hopsText(0), '0 kroków');
});

test('źródło etykiety: adresy stron wydzielone z tekstu, bez końcowej interpunkcji', () => {
  const parts = splitLinks('https://a.example/x (dokładny adres); https://b.example/y. — sprawdzono 2026-11-21');
  assert.deepEqual(parts, [
    { url: 'https://a.example/x' },
    { text: ' (dokładny adres); ' },
    { url: 'https://b.example/y' },
    { text: '. — sprawdzono 2026-11-21' },
  ]);
  // Tekst złożony z części daje z powrotem całe zdanie — nic nie ginie.
  const source = 'Źródło: (https://c.example/z), koniec';
  assert.equal(splitLinks(source).map((part) => ('url' in part ? part.url : part.text)).join(''), source);
  assert.deepEqual(splitLinks('bez odnośników'), [{ text: 'bez odnośników' }]);
  assert.deepEqual(splitLinks(undefined), []);
  assert.deepEqual(splitLinks(''), []);
});

test('wzmianki: serwisy jako liczba (nowsza usługa) albo lista (starsza)', () => {
  assert.deepEqual(mentionServices(3), { count: 3, names: [] });
  assert.deepEqual(mentionServices(['forum', 'targ']), { count: 2, names: ['forum', 'targ'] });
  assert.deepEqual(mentionServices(undefined), { count: 0, names: [] });
});
