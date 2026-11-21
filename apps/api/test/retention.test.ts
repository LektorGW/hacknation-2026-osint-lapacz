// Retencja zamkniętych spraw: domyślnie wyłączona; zadanie usuwa wyłącznie zarchiwizowane, niepowiązane
// sprawy zamknięte dłużej niż próg — nigdy sprawy bez archiwum ani powiązanej z otwartą. Baza w pamięci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import type { LifecycleOptions } from '../src/lifecycle-routes.ts';
import { DAY_MS, assessRetention, createRetentionJob, retentionDaysFromEnv } from '../src/retention.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_EXCHANGE, ETH_A, fakeConnector, fakeProvider } from './helpers.ts';

const START = new Date('2026-09-01T10:00:00.000Z').getTime();
const PUBLISHED: Record<string, string> = { stara_nick: ETH_A, bez_archiwum_nick: BTC_A, powiazana_nick: BTC_B, otwarta_nick: BTC_B, swieza_nick: BTC_EXCHANGE };

async function setup(lifecycle: LifecycleOptions) {
  let time = START;
  const pending: (() => void)[] = [];
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const github = fakeConnector('github', 'github.com', ['nick'], (identifier) => [
    { url: `https://github.com/${identifier.value}`, text: `Wpłaty: ${PUBLISHED[identifier.value] ?? BTC_A}`, author: identifier.value },
  ]);
  const app = await buildApp({
    storage,
    connectors: [github],
    chainProviders: [fakeProvider()],
    now: () => new Date(time),
    lifecycle: { ...lifecycle, retentionTimers: { set: (callback) => pending.push(callback), clear: () => {} } },
  });
  app.addHook('onClose', () => storage.close());
  const call = (method: 'POST' | 'GET', url: string, payload?: object) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  const make = async (name: string, nick: string, steps: ('close' | 'archive')[]) => {
    const id = (await call('POST', '/api/cases', { name, identifiers: [{ type: 'nick', value: nick }] })).json().id as string;
    await call('POST', `/api/cases/${id}/runs`, {});
    if (steps.includes('close')) await call('POST', `/api/cases/${id}/close`, { reason: 'koniec' });
    if (steps.includes('archive')) assert.equal((await call('POST', `/api/cases/${id}/archive`)).statusCode, 200);
    return id;
  };
  return { app, storage, call, make, pending, advance: (days: number) => (time += days * DAY_MS) };
}

test('zmienna środowiskowa: brak = wyłączona; liczba dni; wartość błędna zatrzymuje start', () => {
  assert.equal(retentionDaysFromEnv(undefined), undefined);
  assert.equal(retentionDaysFromEnv(''), undefined);
  assert.equal(retentionDaysFromEnv('90'), 90);
  for (const bad of ['0', '-5', '1.5', 'trzydzieści']) assert.throws(() => retentionDaysFromEnv(bad), /OLCYS_RETENTION_DAYS_CLOSED/);
});

test('domyślnie wyłączona: podgląd niczego nie kwalifikuje, zadanie niczego nie planuje ani nie usuwa', async () => {
  const { app, storage, call, make, pending, advance } = await setup({});
  const id = await make('Stara sprawa', 'stara_nick', ['close', 'archive']);
  advance(400);
  const preview = (await call('GET', '/api/retention/preview')).json();
  assert.equal(preview.enabled, false);
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].eligible, false);
  assert.match(preview.items[0].reasons.join(' '), /Retencja jest wyłączona/);
  assert.equal(pending.length, 0, 'brak zaplanowanego przebiegu');
  assert.ok(await storage.getCase(id));
  const status = (await call('GET', '/api/security/status')).json();
  assert.deepEqual(status.retention, { enabled: false });

  const job = createRetentionJob({ days: undefined, now: () => new Date(), preview: async () => { throw new Error('nie powinno być wywołane'); }, remove: async () => {}, log: () => {} });
  assert.deepEqual(await job.runOnce(), { deleted: [], skipped: 0 });
  await app.close();
});

test('zadanie retencji usuwa tylko zarchiwizowaną, niepowiązaną sprawę po progu; podgląd podaje powody', async () => {
  const { app, storage, call, make, pending, advance } = await setup({ retentionDays: 30 });
  const old = await make('Stara zarchiwizowana', 'stara_nick', ['close', 'archive']);
  const noArchive = await make('Zamknięta bez archiwum', 'bez_archiwum_nick', ['close']);
  const linked = await make('Powiązana z otwartą', 'powiazana_nick', ['close', 'archive']);
  await make('Otwarta', 'otwarta_nick', []);
  advance(40);
  const fresh = await make('Świeżo zamknięta', 'swieza_nick', ['close', 'archive']);

  const preview = (await call('GET', '/api/retention/preview')).json();
  assert.deepEqual([preview.enabled, preview.days], [true, 30]);
  const byId = Object.fromEntries(preview.items.map((item: { caseId: string }) => [item.caseId, item]));
  assert.equal(byId[old].eligible, true);
  assert.equal(byId[noArchive].eligible, false);
  assert.match(byId[noArchive].reasons.join(' '), /bez archiwum/);
  assert.equal(byId[linked].eligible, false);
  assert.match(byId[linked].reasons.join(' '), /Powiązana z otwartymi sprawami: „Otwarta”/);
  assert.equal(byId[linked].blockingLinks[0].caseName, 'Otwarta');
  assert.equal(byId[fresh].eligible, false);
  assert.match(byId[fresh].reasons.join(' '), /0 dni temu — próg retencji to 30 dni/);
  assert.equal(preview.items.length, 4, 'otwarte sprawy nie trafiają do podglądu');
  // Podgląd niczego nie zmienia.
  assert.ok(await storage.getCase(old));

  // Przebieg zadania (zaplanowany przy starcie) — kolejny jest planowany po zakończeniu.
  assert.equal(pending.length, 1);
  pending.shift()!();
  for (let wait = 0; pending.length === 0 && wait < 200; wait++) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(pending.length, 1, 'zaplanowano kolejny przebieg');

  assert.equal(await storage.getCase(old), null, 'zarchiwizowana, niepowiązana, po progu — usunięta');
  for (const id of [noArchive, linked, fresh]) assert.ok(await storage.getCase(id), `sprawa ${id} nie mogła zostać usunięta`);
  const tombstone = await storage.getTombstone(old);
  assert.equal(tombstone?.mode, 'retencja');
  const audit = (await call('GET', `/api/audit?caseId=${old}`)).json().entries as { action: string }[];
  assert.ok(audit.some((entry) => entry.action === 'sprawa.usunieta-retencja'));
  await app.close();
});

test('ocena retencji: archiwum sprzed ponownego zamknięcia nie wystarcza', () => {
  const base = { id: 'x', name: 'X', createdAt: '2026-01-01T00:00:00.000Z', query: { identifiers: [] }, runs: [] };
  const now = new Date('2026-11-21T00:00:00.000Z');
  const reclosed = assessRetention({ ...base, status: 'archived', closedAt: '2026-06-01T00:00:00.000Z', archivedAt: '2026-05-01T00:00:00.000Z', archiveSha256: 'a'.repeat(64) }, [], 30, now);
  assert.equal(reclosed.eligible, false);
  const ok = assessRetention({ ...base, status: 'archived', closedAt: '2026-06-01T00:00:00.000Z', archivedAt: '2026-06-02T00:00:00.000Z', archiveSha256: 'a'.repeat(64) }, [], 30, now);
  assert.equal(ok.eligible, true);
  assert.equal(assessRetention({ ...base, status: 'open' }, [], 30, now).eligible, false);
});
