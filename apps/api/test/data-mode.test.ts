// Przełącznik trybu danych: wybór łączników i dostawców danych blockchain według trybu,
// trwałość ustawienia, nadpisanie dla jednej analizy i pola stanu usługi.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChainProvider } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { DATA_MODE_CONFIG_ID, dataModeAvailability, dataModeFromConnectorIds, defaultDataMode, filterByDataMode, sourceFamily } from '../src/data-mode.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

/** Dostawca danych blockchain z licznikiem zapytań. */
function countingProvider(id: string): ChainProvider & { calls: string[] } {
  const base = fakeProvider();
  const calls: string[] = [];
  return { ...base, id, label: `Atrapa ${id}`, calls, getActivity: (network, address, context) => (calls.push(address), base.getActivity(network, address, context)) };
}

async function setup(options: { live?: boolean; synthetic?: boolean } = { live: true, synthetic: true }, existing?: Storage) {
  const storage = existing ?? createStorage(await createPgliteDriver());
  if (!existing) await storage.migrate();
  const sandbox = fakeConnector('sandbox-gitpub', 'gitpub.sandbox', ['nick'], () => [{ url: 'https://gitpub.sandbox/janek', author: 'janek', text: `Wsparcie: ${BTC_A}` }]);
  const live = fakeConnector('live-github', 'github.com', ['nick'], () => [{ url: 'https://github.com/janek', author: 'janek', text: `Donate: ${BTC_A}` }]);
  const sandboxChain = countingProvider('sandbox-explorer');
  const liveChain = countingProvider('blockscout-ethereum');
  const app = await buildApp({
    storage,
    connectors: [...(options.synthetic ? [sandbox] : []), ...(options.live ? [live] : [])],
    chainProviders: [...(options.synthetic ? [sandboxChain] : []), ...(options.live ? [liveChain] : [])],
    now: FIXED_NOW,
  });
  return { app, storage, sandbox, live, sandboxChain, liveChain };
}

const reset = (...items: { calls: unknown[] }[]) => items.forEach((item) => (item.calls.length = 0));

test('rodziny źródeł i tryb domyślny', () => {
  assert.equal(sourceFamily('sandbox-gitpub'), 'synthetic');
  assert.equal(sourceFamily('lab-forum-it'), 'synthetic');
  assert.equal(sourceFamily('sandbox-explorer'), 'synthetic');
  assert.equal(sourceFamily('lab-chain'), 'synthetic');
  assert.equal(sourceFamily('corpus'), 'local');
  assert.equal(sourceFamily('rejestry-publiczne'), 'local');
  assert.equal(sourceFamily('listy-sankcyjne'), 'local');
  assert.equal(sourceFamily('live-github'), 'live');
  assert.equal(sourceFamily('tor-onion'), 'live');
  const items = ['sandbox-a', 'live-b', 'corpus', 'esplora-blockstream'].map((id) => ({ id }));
  assert.deepEqual(filterByDataMode(items, 'synthetic').map((item) => item.id), ['sandbox-a', 'corpus']);
  assert.deepEqual(filterByDataMode(items, 'live').map((item) => item.id), ['live-b', 'corpus', 'esplora-blockstream']);
  assert.deepEqual(filterByDataMode(items, 'both').map((item) => item.id), ['sandbox-a', 'live-b', 'corpus', 'esplora-blockstream']);
  assert.equal(defaultDataMode(dataModeAvailability(['sandbox-a', 'live-b'])), 'both');
  assert.equal(defaultDataMode(dataModeAvailability(['live-b', 'corpus'])), 'live');
  assert.equal(defaultDataMode(dataModeAvailability(['sandbox-a', 'rejestry-publiczne'])), 'synthetic');
  assert.equal(defaultDataMode(dataModeAvailability(['corpus'])), 'synthetic');
  assert.equal(dataModeFromConnectorIds(['sandbox-a', 'corpus']), 'synthetic');
  assert.equal(dataModeFromConnectorIds(['sandbox-a', 'live-b']), 'both');
});

test('przełączanie trybu: wybór źródeł, stan usługi, nadpisanie dla jednej analizy, trwałość', async () => {
  const { app, storage, sandbox, live, sandboxChain, liveChain } = await setup();

  // Obie rodziny zarejestrowane, bez zapisu: oba tryby naraz (jak przed wprowadzeniem przełącznika).
  const initial = (await app.inject('/api/settings/data-mode')).json();
  assert.equal(initial.dataMode, 'both');
  assert.equal(initial.defaultMode, 'both');
  assert.deepEqual([initial.modes.synthetic.available, initial.modes.live.available, initial.modes.both.available], [true, true, true]);
  let health = (await app.inject('/api/health')).json();
  assert.deepEqual([health.mode, health.dataMode, health.dataModeTag], ['live', 'both', 'LIVE']);
  assert.deepEqual(health.dataModesAvailable, { synthetic: true, live: true, both: true });

  // Zmiana na dane syntetyczne — bez restartu.
  const put = await app.inject({ method: 'PUT', url: '/api/settings/data-mode', payload: { dataMode: 'synthetic' } });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().dataMode, 'synthetic');
  assert.equal(put.json().tag, 'SANDBOX');
  health = (await app.inject('/api/health')).json();
  assert.deepEqual([health.mode, health.dataMode, health.dataModeTag], ['sandbox', 'synthetic', 'SANDBOX']);
  // Zmiana trafia do dziennika audytu (gdy baza go ma).
  const auditLog = (storage as { listAudit?: () => Promise<{ action: string; details: Record<string, unknown> }[]> }).listAudit;
  if (typeof auditLog === 'function') {
    const entry = (await auditLog.call(storage)).find((item) => item.action === 'ustawienia.tryb-danych');
    assert.deepEqual(entry?.details, { poprzedni: 'both', nowy: 'synthetic' });
  }
  assert.equal(health.sources.find((item: { id: string }) => item.id === 'live-github').active, false);
  assert.equal(health.sources.find((item: { id: string }) => item.id === 'sandbox-gitpub').active, undefined);
  assert.equal(health.chainProviders.find((item: { id: string }) => item.id === 'blockscout-ethereum').active, false);

  const created = (await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Janek', identifiers: [{ type: 'nick', value: 'janek' }] } })).json();
  reset(sandbox, live, sandboxChain, liveChain);
  const synthetic = (await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs` })).json();
  assert.equal(synthetic.dataMode, 'synthetic');
  assert.deepEqual(synthetic.connectors, ['sandbox-gitpub', 'corpus']);
  assert.equal(live.calls.length, 0);
  assert.ok(sandbox.calls.length > 0);
  assert.equal(liveChain.calls.length, 0);
  assert.ok(sandboxChain.calls.length > 0);

  // Nadpisanie dla jednej analizy nie zmienia ustawienia.
  reset(sandbox, live, sandboxChain, liveChain);
  const overridden = (await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { dataMode: 'live' } })).json();
  assert.equal(overridden.dataMode, 'live');
  assert.deepEqual(overridden.connectors, ['live-github', 'corpus']);
  assert.equal(sandbox.calls.length, 0);
  assert.equal(sandboxChain.calls.length, 0);
  assert.ok(liveChain.calls.length > 0);
  assert.equal((await app.inject('/api/settings/data-mode')).json().dataMode, 'synthetic');

  // Historia sprawy: tryb każdej analizy (znacznik SANDBOX/LIVE w interfejsie).
  const summary = (await app.inject(`/api/cases/${created.id}`)).json();
  // Obie analizy mają ten sam czas (zegar testowy), więc kolejność na liście nie jest ustalona.
  assert.deepEqual(summary.runs.map((run: { dataMode?: string }) => run.dataMode).sort(), ['live', 'synthetic']);

  // Łącznik wskazany wprost spoza trybu nie zostaje użyty; same łączniki spoza trybu to błąd.
  const onlyLive = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { connectors: ['live-github'] } });
  assert.equal(onlyLive.statusCode, 400);
  assert.match(onlyLive.json().error, /trybu danych „synthetic”/);
  const mixed = (await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { connectors: ['live-github', 'sandbox-gitpub'] } })).json();
  assert.deepEqual(mixed.connectors, ['sandbox-gitpub']);

  // Szybka analiza też przyjmuje tryb dla jednej analizy.
  const quick = await app.inject({ method: 'POST', url: '/api/quick', payload: { value: 'janek', dataMode: 'both', async: true } });
  assert.equal(quick.statusCode, 202);
  const quickRun = (await app.inject(`/api/runs/${quick.json().run.id}`)).json();
  assert.equal(quickRun.dataMode, 'both');

  // Walidacja.
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/data-mode', payload: { dataMode: 'wszystko' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/settings/data-mode', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { dataMode: 'nic' } })).statusCode, 400);

  // Trwałość: nowy proces z tą samą bazą zaczyna w zapisanym trybie.
  await app.close();
  const again = await setup(undefined, storage);
  assert.equal((await again.app.inject('/api/settings/data-mode')).json().dataMode, 'synthetic');
  assert.equal((await again.app.inject('/api/health')).json().mode, 'sandbox');
  await again.app.close();
  await storage.close();
});

test('tryb niedostępny w tym uruchomieniu: odmowa zmiany i powrót do trybu domyślnego', async () => {
  const { app, storage } = await setup({ synthetic: true });
  const health = (await app.inject('/api/health')).json();
  assert.deepEqual([health.mode, health.dataMode], ['sandbox', 'synthetic']);
  assert.deepEqual(health.dataModesAvailable, { synthetic: true, live: false, both: false });

  const refused = await app.inject({ method: 'PUT', url: '/api/settings/data-mode', payload: { dataMode: 'live' } });
  assert.equal(refused.statusCode, 400);
  assert.match(refused.json().error, /ENABLE_LIVE=1/);
  const state = (await app.inject('/api/settings/data-mode')).json();
  assert.equal(state.modes.live.available, false);
  assert.match(state.modes.live.reason, /ENABLE_LIVE=1/);

  const created = (await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Janek', identifiers: [{ type: 'nick', value: 'janek' }] } })).json();
  assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { dataMode: 'both' } })).statusCode, 400);
  await app.close();

  // Zapisany tryb „live” przy serwerze bez ENABLE_LIVE: obowiązuje domyślny, zapis zostaje z adnotacją.
  await storage.saveConfig(DATA_MODE_CONFIG_ID, { dataMode: 'live', updatedAt: '2026-11-21T09:00:00.000Z' });
  const restarted = await setup({ synthetic: true }, storage);
  const described = (await restarted.app.inject('/api/settings/data-mode')).json();
  assert.equal(described.dataMode, 'synthetic');
  assert.equal(described.storedDataMode, 'live');
  assert.match(described.note, /niedostępny/);
  await restarted.app.close();
  await storage.close();
});
