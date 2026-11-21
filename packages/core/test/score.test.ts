import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeConfidence, type Evidence } from '../src/score.ts';

const evidence = (over: Partial<Evidence> & Pick<Evidence, 'id' | 'category' | 'service'>): Evidence => ({
  url: `https://${over.service}/x`,
  capturedAt: '2026-11-21T12:00:00Z',
  identityMatch: 'exact_identifier',
  ...over,
});

test('własny profil daje bardzo wysokie prawdopodobieństwo', () => {
  const result = computeConfidence({
    evidence: [evidence({ id: 'e1', category: 'own_profile', service: 'github.com' })],
    addressClass: 'private',
  });
  assert.equal(result.score, 85);
  assert.equal(result.tier, 'bardzo wysokie prawdopodobieństwo');
});

test('drugie niezależne źródło dodaje 15 p.p., a to samo źródło nie', () => {
  const forum = evidence({ id: 'e1', category: 'forum_post', service: 'forum.example' });
  const sameService = computeConfidence({
    evidence: [forum, evidence({ id: 'e2', category: 'forum_post', service: 'forum.example' })],
    addressClass: 'private',
  });
  assert.equal(sameService.score, 50);

  const independent = computeConfidence({
    evidence: [forum, evidence({ id: 'e2', category: 'sale_offer', service: 'ogloszenia.example' })],
    addressClass: 'private',
  });
  assert.equal(independent.score, 85);
  assert.ok(independent.ledger.some((entry) => entry.rule === 'synergy.second_source'));
});

test('wynik nie przekracza 100', () => {
  const result = computeConfidence({
    evidence: [
      evidence({ id: 'e1', category: 'cryptographic_proof', service: 'ens' }),
      evidence({ id: 'e2', category: 'own_profile', service: 'github.com' }),
      evidence({ id: 'e3', category: 'sale_offer', service: 'ogloszenia.example' }),
    ],
    addressClass: 'private',
  });
  assert.equal(result.score, 100);
});

test('adres giełdy i smart kontrakt są wykluczane z wynikiem 0', () => {
  for (const addressClass of ['exchange', 'smart_contract'] as const) {
    const result = computeConfidence({
      evidence: [evidence({ id: 'e1', category: 'own_profile', service: 'github.com' })],
      addressClass,
    });
    assert.equal(result.score, 0);
    assert.equal(result.excluded, true);
    assert.equal(result.ledger[0]!.rule, 'exclusion.address_class');
  }
});

test('zgodność samego nazwiska i adres współdzielony obniżają wynik', () => {
  const result = computeConfidence({
    evidence: [evidence({ id: 'e1', category: 'forum_post', service: 'forum.example', identityMatch: 'name_only' })],
    addressClass: 'unknown',
    unrelatedPublishers: 5,
  });
  assert.equal(result.score, 0);
  assert.deepEqual(
    result.ledger.map((entry) => entry.rule),
    ['base.forum_post', 'identity.name_only', 'penalty.shared_address'],
  );
  assert.ok(result.nextSteps.length >= 2);
});

test('księga sumuje się do wyniku końcowego', () => {
  const result = computeConfidence({
    evidence: [
      evidence({ id: 'e1', category: 'mass_comment', service: 'x.com' }),
      evidence({ id: 'e2', category: 'forum_post', service: 'forum.example', identityMatch: 'linked_profile' }),
    ],
    addressClass: 'private',
  });
  const sum = result.ledger.reduce((total, entry) => total + entry.delta, 0);
  assert.equal(sum, result.score);
  assert.equal(result.ledger.at(-1)!.running, result.score);
});
