import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, evidence, finding, run } from './helpers.ts';

let storage: Storage;

before(async () => {
  storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  // Migracja przy każdym starcie musi być bezpieczna do powtórzenia.
  await storage.migrate();
});
after(() => storage.close());

test('sprawa: zapis, odczyt i lista', async () => {
  const query = { identifiers: [{ type: 'nick' as const, value: 'janek' }] };
  const created = await storage.createCase('Sprawa testowa', query, '2026-11-21T08:00:00.000Z');

  assert.deepEqual(await storage.getCase(created.id), {
    id: created.id,
    name: 'Sprawa testowa',
    createdAt: '2026-11-21T08:00:00.000Z',
    query,
    runs: [],
  });
  assert.ok((await storage.listCases()).some((item) => item.id === created.id));
  assert.equal(await storage.getCase('brak'), null);
});

test('analiza: pełny wynik wraca bez zmian, a sprawa pokazuje podsumowanie', async () => {
  const created = await storage.createCase('Sprawa z analizą', { identifiers: [{ type: 'nick', value: 'janek' }] }, '2026-11-21T08:00:00.000Z');
  const saved = { ...run('run-1', [finding(BTC_A, 85, [evidence('https://github.com/janek')])]), caseId: created.id };

  await storage.saveRun({ ...saved, status: 'running', findings: [], finishedAt: undefined });
  await storage.saveRun(saved);

  assert.deepEqual(await storage.getRun('run-1'), saved);
  assert.equal(await storage.getRun('brak'), null);
  assert.deepEqual((await storage.getCase(created.id))!.runs, [
    { id: 'run-1', startedAt: '2026-11-21T09:00:00.000Z', status: 'completed', findingCount: 1, topScore: 85 },
  ]);
});

test('kopie treści dokumentów: zapis ze skrótem i odczyt', async () => {
  const created = await storage.createCase('Sprawa z dowodami', { identifiers: [{ type: 'nick', value: 'janek' }] }, '2026-11-21T08:00:00.000Z');
  await storage.saveRun({ ...run('run-2', []), caseId: created.id });
  const document = {
    contentHash: 'f'.repeat(64),
    url: 'https://github.com/janek',
    title: 'Profil',
    service: 'github.com',
    connectorId: 'github',
    author: 'janek',
    publishedAt: undefined,
    archivedAt: undefined,
    fetchedAt: '2026-11-21T09:00:00.000Z',
    text: `Treść z adresem ${BTC_A} i znakami 'cudzysłowu'; -- oraz średnikiem`,
  };

  await storage.saveDocuments('run-2', [document, document]);

  assert.deepEqual(await storage.listDocuments('run-2'), [document]);
});

test('decyzje: wycofanie nie usuwa wpisu — zostaje ślad audytowy', async () => {
  const created = await storage.createCase('Sprawa z decyzjami', { identifiers: [{ type: 'nick' as const, value: 'janek' }] }, '2026-11-21T08:00:00.000Z');
  const base = { caseId: created.id, decision: 'confirmed' as const, decidedAt: '2026-11-21T10:00:00.000Z', author: 'analityk' };
  const link = { ...base, id: 'dec-1', target: 'link' as const, key: 'forum.example|a<->gitpub.example|b', note: 'ten sam telefon w aktach' };
  const profile = { ...base, id: 'dec-2', target: 'profile' as const, key: 'gitpub.example|b' };
  await storage.addDecision(link);
  await storage.addDecision(profile);
  assert.deepEqual(await storage.listDecisions(created.id), [link, profile]);

  assert.equal(await storage.deleteDecision(created.id, 'dec-1', { at: '2026-11-21T11:30:00.000Z', by: 'kierownik' }), true);
  // Wpis zostaje w rejestrze, w tej samej kolejności, z czasem i autorem wycofania.
  assert.deepEqual(await storage.listDecisions(created.id), [{ ...link, withdrawnAt: '2026-11-21T11:30:00.000Z', withdrawnBy: 'kierownik' }, profile]);
  // Drugie wycofanie tej samej decyzji, nieznana decyzja i cudza sprawa: brak zmian.
  assert.equal(await storage.deleteDecision(created.id, 'dec-1'), false);
  assert.equal(await storage.deleteDecision(created.id, 'brak'), false);
  assert.equal(await storage.deleteDecision('inna-sprawa', 'dec-2'), false);
  assert.equal((await storage.listDecisions(created.id))[1]!.withdrawnAt, undefined);
});
