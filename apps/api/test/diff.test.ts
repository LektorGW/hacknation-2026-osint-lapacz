import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectReplacements, diffRuns, normalizeProfileUrl } from '../src/diff.ts';
import { BTC_A, BTC_B, ETH_A, evidence, finding, run } from './helpers.ts';

const PROFILE = 'https://github.com/janek';

test('diffRuns: nowe i usunięte adresy, zmiany wyniku, podmiana w tej samej publikacji', () => {
  const before = run('r1', [
    finding(BTC_A, 85, [evidence(PROFILE)]),
    finding(ETH_A, 50, [evidence('https://forum.example/t/1')], 'ethereum'),
  ]);
  const after = run('r2', [
    finding(BTC_B, 85, [evidence(PROFILE)]),
    finding(ETH_A, 65, [evidence('https://forum.example/t/1'), evidence('https://blog.example/janek')], 'ethereum'),
  ]);

  assert.deepEqual(diffRuns(before, after), {
    fromRunId: 'r1',
    toRunId: 'r2',
    addedAddresses: [BTC_B],
    removedAddresses: [BTC_A],
    scoreChanges: [{ address: ETH_A, from: 50, to: 65 }],
    replacedAddresses: [{ url: PROFILE, from: BTC_A, to: BTC_B }],
  });
});

test('diffRuns: adres dopisany obok istniejącego nie jest podmianą', () => {
  const before = run('r1', [finding(BTC_A, 85, [evidence(PROFILE)])]);
  const after = run('r2', [finding(BTC_A, 85, [evidence(PROFILE)]), finding(BTC_B, 85, [evidence(PROFILE)])]);

  const diff = diffRuns(before, after);
  assert.deepEqual(diff.addedAddresses, [BTC_B]);
  assert.deepEqual(diff.replacedAddresses, []);
  assert.deepEqual(diff.scoreChanges, []);
});

test('detectReplacements: wersja archiwalna profilu z innym adresem niż bieżąca', () => {
  const analysed = run('r1', [
    finding(BTC_A, 85, [
      evidence(`https://web.archive.org/web/20240105120000/${PROFILE}`, { archivedAt: '2024-01-05T12:00:00.000Z' }),
    ]),
    finding(BTC_B, 85, [evidence(PROFILE)]),
    // Adres w innej sieci nie jest zamiennikiem adresu Bitcoin.
    finding(ETH_A, 85, [evidence(PROFILE)], 'ethereum'),
  ]);

  assert.deepEqual(detectReplacements(analysed), [
    {
      url: PROFILE,
      network: 'bitcoin',
      from: BTC_A,
      to: BTC_B,
      archivedAt: '2024-01-05T12:00:00.000Z',
      observedAt: '2026-11-21T09:00:00.000Z',
    },
  ]);
});

test('detectReplacements: ten sam adres w archiwum i dziś to nie podmiana', () => {
  const analysed = run('r1', [
    finding(BTC_A, 85, [evidence(PROFILE, { archivedAt: '2024-01-05T12:00:00.000Z' }), evidence(PROFILE)]),
  ]);
  assert.deepEqual(detectReplacements(analysed), []);
});

test('normalizeProfileUrl sprowadza kopię z archiwum do adresu oryginału', () => {
  assert.equal(normalizeProfileUrl('https://web.archive.org/web/20240105120000/https://x.example/a/'), 'https://x.example/a');
  assert.equal(normalizeProfileUrl('https://x.example/a#sekcja'), 'https://x.example/a');
});
