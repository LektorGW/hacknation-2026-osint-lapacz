// Niezależność pochodzenia śladów i składanie wskaźników śledczych.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence, provenanceGroups, textFingerprint, type Evidence } from '../src/score.ts';
import { combineComponents, linkKey, type ComponentDraft } from '../src/indicators.ts';

const evidence = (over: Partial<Evidence> & Pick<Evidence, 'id' | 'category' | 'service'>): Evidence => ({
  url: `https://${over.service}/x`,
  capturedAt: '2026-11-21T12:00:00Z',
  identityMatch: 'exact_identifier',
  ...over,
});

const ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const OFFER = `Sprzedam koparkę kryptowalut w dobrym stanie, odbiór osobisty w Radomiu, wpłaty proszę kierować na adres ${ADDRESS} — pilne!`;

test('jeden adres skopiowany do pięciu serwisów nie daje premii za pięć niezależnych dowodów', () => {
  const services = ['forum-a.example', 'forum-b.example', 'ogloszenia.example', 'social.example', 'tablica.example'];
  const copies = services.map((service, index) =>
    evidence({ id: `k${index}`, category: 'sale_offer', service, excerpt: index % 2 ? OFFER.toUpperCase() : `${OFFER}  ` }),
  );
  const result = computeConfidence({ evidence: copies, addressClass: 'private' });

  // Sama oferta (70), bez +15 za drugie źródło i bez +10 za kolejne.
  assert.equal(result.score, 70);
  assert.equal(result.independentSources, 1);
  assert.equal(result.provenance!.length, 1);
  assert.deepEqual([...result.provenance![0]!.services].sort(), [...services].sort());
  assert.ok(!result.ledger.some((entry) => entry.rule.startsWith('synergy.')));
  const merged = result.ledger.find((entry) => entry.rule === 'independence.copies_merged')!;
  assert.equal(merged.delta, 0);
  assert.match(merged.explanation, /skopiowana/);
  assert.equal(merged.sources!.length, 5);

  // Ta sama piątka serwisów z RÓŻNYMI treściami to pięć pochodzeń: 70 + 15 + 10.
  const goods = ['rower górski z pełnym osprzętem', 'telefon po wymianie baterii', 'konsolę z dwoma padami', 'monitor do pracy biurowej', 'aparat z obiektywem stałym'];
  const distinct = services.map((service, index) =>
    evidence({ id: `r${index}`, category: 'sale_offer', service, excerpt: `Ogłoszenie numer ${index}: sprzedam ${goods[index]} — płatność na adres ${ADDRESS}` }),
  );
  const independent = computeConfidence({ evidence: distinct, addressClass: 'private' });
  assert.equal(independent.independentSources, 5);
  assert.equal(independent.score, 95);
});

test('przedruk z drobną zmianą, kopia archiwalna i identyczny skrót treści nie są niezależnym potwierdzeniem', () => {
  const original = evidence({ id: 'o', category: 'forum_post', service: 'forum.example', url: 'https://forum.example/t/42', excerpt: OFFER });
  const reprint = evidence({ id: 'p', category: 'forum_post', service: 'agregator.example', excerpt: OFFER.replace('pilne', 'bardzo pilne') });
  const reprinted = computeConfidence({ evidence: [original, reprint], addressClass: 'private' });
  assert.equal(reprinted.score, 50);
  assert.match(reprinted.provenance![0]!.reasons.join(' '), /przedruk/);

  const archived = evidence({
    id: 'a',
    category: 'forum_post',
    service: 'web.archive.org',
    url: 'https://web.archive.org/web/20240101000000/https://forum.example/t/42',
    archivedAt: '2024-01-01T00:00:00Z',
  });
  const withArchive = computeConfidence({ evidence: [original, archived], addressClass: 'private' });
  assert.equal(withArchive.score, 50);
  assert.match(withArchive.provenance![0]!.reasons.join(' '), /kopia archiwalna/);

  const sameHash = computeConfidence({
    evidence: [
      evidence({ id: 'h1', category: 'forum_post', service: 'a.example', contentHash: 'abc' }),
      evidence({ id: 'h2', category: 'forum_post', service: 'b.example', contentHash: 'abc' }),
    ],
    addressClass: 'private',
  });
  assert.equal(sameHash.independentSources, 1);
  assert.equal(sameHash.score, 50);
});

test('krótka, nieswoista treść nie jest uznawana za kopię — zbieżność to nie dowód kopiowania', () => {
  const result = computeConfidence({
    evidence: [
      evidence({ id: 's1', category: 'own_profile', service: 'a.example', excerpt: `BTC: ${ADDRESS}` }),
      evidence({ id: 's2', category: 'own_profile', service: 'b.example', excerpt: `BTC: ${ADDRESS}` }),
    ],
    addressClass: 'private',
  });
  assert.equal(result.independentSources, 2);
  assert.equal(result.score, 100);
  assert.equal(textFingerprint(`BTC: ${ADDRESS}`), undefined);
  assert.equal(provenanceGroups([]).length, 0);
});

test('każdy krok księgi ma regułę, wagę, źródło, dowód, wyjaśnienie, niezależność i ograniczenia; wynik nie udaje prawdopodobieństwa', () => {
  const result = computeConfidence({
    evidence: [
      evidence({ id: 'e1', category: 'forum_post', service: 'forum.example', identityMatch: 'same_handle' }),
      evidence({ id: 'e2', category: 'sale_offer', service: 'ogloszenia.example' }),
    ],
    addressClass: 'private',
    unrelatedPublishers: 3,
  });
  assert.ok(result.ledger.length >= 3);
  for (const entry of result.ledger) {
    assert.ok(entry.rule && entry.explanation, entry.rule);
    assert.equal(typeof entry.weight, 'number', entry.rule);
    assert.ok(entry.sources!.length > 0 && entry.evidenceIds.length > 0, entry.rule);
    assert.ok(entry.independence, entry.rule);
    assert.ok(Array.isArray(entry.limitations), entry.rule);
  }
  assert.equal(result.ledger.reduce((sum, entry) => sum + entry.delta, 0), result.score);
  assert.equal(result.scale, 'ordinal_uncalibrated');
  assert.match(result.interpretation!, /nie skalibrowanym statystycznie prawdopodobieństwem/);

  const excluded = computeConfidence({ evidence: [evidence({ id: 'c', category: 'own_profile', service: 'a.example' })], addressClass: 'smart_contract' });
  assert.deepEqual([excluded.score, excluded.excluded, excluded.independentSources], [0, true, 0]);
  assert.match(excluded.ledger[0]!.limitations![0]!, /nie dowodzi/);
});

// ---------- Składanie wskaźników ----------

const draft = (rule: string, weight: number, over: Partial<ComponentDraft> = {}): ComponentDraft => ({
  rule,
  weight,
  direction: 'supports',
  source: 'test',
  evidence: [],
  explanation: rule,
  limitations: [],
  ...over,
});

test('wskaźnik: najmocniejszy składnik + malejące korzyści z kolejnych NIEZALEŻNYCH; powtórki nie są doliczane', () => {
  const indicator = combineComponents('common_operator', [
    draft('operator.same_email', 100, { originKey: 'email:x' }),
    draft('operator.link_from_email', 50, { originKey: 'email:x' }),
    draft('operator.same_website', 50),
    draft('operator.same_avatar', 50),
  ]);
  // 100 + 10 + 5 (premia łącznie najwyżej +15), ale bez potwierdzenia analityka najwyżej 95.
  assert.equal(indicator.score, 95);
  assert.equal(indicator.calibrated, false);
  assert.deepEqual(
    indicator.components.map((item) => [item.rule, item.applied, item.independence]),
    [
      ['operator.same_email', 100, 'independent'],
      ['operator.link_from_email', 0, 'dependent'],
      ['operator.same_website', 10, 'independent'],
      ['operator.same_avatar', 5, 'independent'],
    ],
  );
  assert.equal(combineComponents('common_operator', [draft('operator.same_email', 100)], { confirmed: true }).score, 100);
});

test('wskaźnik: kontrdowód twardy trzyma wynik poniżej progu łączenia, a sam nick to słaba przesłanka', () => {
  const blocked = combineComponents('common_operator', [
    draft('operator.same_email', 100),
    draft('operator.conflict.declared_name', 0, { direction: 'contradicts', blocking: true }),
  ]);
  assert.equal(blocked.score, 45);

  const soft = combineComponents('common_operator', [draft('operator.same_website', 50), draft('operator.conflict.location', 10, { direction: 'contradicts' })]);
  assert.equal(soft.score, 40);
  assert.equal(soft.components.at(-1)!.applied, -10);

  const nick = combineComponents('common_operator', [draft('operator.same_handle', 20)]);
  assert.deepEqual([nick.score, nick.level, nick.components[0]!.independence], [20, 'słabe przesłanki', 'single']);
  assert.equal(combineComponents('cash_out', []).score, 0);
  assert.equal(linkKey('B.example|X', 'a.example|y'), 'a.example|y<->b.example|x');
});
