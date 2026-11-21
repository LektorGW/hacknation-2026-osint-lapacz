// Statystyki skuteczności, klucze API źródeł i obserwowane sprawy („Monitoruj”).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { Finding } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { diffCashOuts } from '../src/diff.ts';
import type { MonitorTimers } from '../src/monitor.ts';
import { sourceKeyInfo } from '../src/source-keys.ts';
import { HIT_THRESHOLD, countHits, summarizeStats } from '../src/stats.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, FIXED_NOW, cashOut, evidence, fakeActivity, fakeConnector, fakeProvider, finding, run, transfer } from './helpers.ts';

/** Sterowany zegar: zapamiętuje odliczania zamiast czekać. */
function fakeTimers() {
  const pending = new Map<number, { callback: () => void; delayMs: number }>();
  let next = 1;
  const timers: MonitorTimers = {
    set(callback, delayMs) {
      pending.set(next, { callback, delayMs });
      return next++;
    },
    clear: (handle) => void pending.delete(handle as number),
  };
  return { timers, pending };
}

const freshStorage = async (): Promise<Storage> => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  return storage;
};

/** Czeka, aż analiza w tle się zakończy. */
async function settle(app: FastifyInstance, runId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const progress = (await app.inject(`/api/runs/${runId}/progress`)).json();
    if (progress.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Analiza nie zakończyła się w czasie testu.');
}

const scored = (address: string, score: number, excluded = false): Finding => ({
  ...finding(address, score, [evidence(`https://example.test/${address}`)]),
  confidence: { score, tier: 'test', excluded, ledger: [], nextSteps: [] },
});

test('trafienie: adres nieodrzucony z Wskaźnikiem Pewności od 60; średnie liczone po sprawach z analizą', () => {
  assert.equal(HIT_THRESHOLD, 60);
  assert.equal(countHits({ findings: [scored(BTC_A, 60), scored(BTC_B, 59), scored('x', 90, true)] }), 1);

  const summary = summarizeStats(
    [
      { topScore: 80, hits: 2 },
      { topScore: 40, hits: 0 },
    ],
    4,
  );
  assert.equal(summary.analysedCases, 2);
  assert.equal(summary.casesWithHits, 1);
  assert.equal(summary.totalHits, 2);
  assert.equal(summary.averageConfidence, 60);
  assert.equal(summary.averageHits, 1);
  // Skuteczność: wśród spraw z analizą; odsetek spraw z trafieniami: wśród wszystkich spraw.
  assert.equal(summary.effectiveness, 50);
  assert.equal(summary.casesWithHitsShare, 25);
  assert.match(summary.definitions.hit, /co najmniej 60/);

  const empty = summarizeStats([], 3);
  assert.deepEqual([empty.averageConfidence, empty.averageHits, empty.effectiveness, empty.casesWithHitsShare], [null, null, null, 0]);
});

test('nowe przelewy do usług: tylko te, których nie było w poprzedniej analizie, bez adresów odrzuconych', () => {
  const withChain = (item: Finding, extra: ReturnType<typeof cashOut>[] = []): Finding => {
    const activity = fakeActivity(item.network, item.address, 'private');
    return { ...item, chain: { ...activity, cashOuts: [...activity.cashOuts, ...extra] } };
  };
  const later = cashOut(transfer(2, { counterparty: 'bc1qgieldaxx', time: '2026-03-01T10:00:00.000Z', amount: 0.2, counterpartyLabel: 'Giełda Druga' }), 51000);
  const older = run('r1', [withChain(scored(BTC_A, 80))]);
  const newer = run('r2', [withChain(scored(BTC_A, 80), [later]), withChain(scored(BTC_B, 70, true), [later])]);
  const changes = diffCashOuts(older, newer);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.address, BTC_A);
  assert.equal(changes[0]!.counterpartyLabel, 'Giełda Druga');
  assert.equal(changes[0]!.valuePln, 51000);
});

test('klucze API źródeł: wymagany / ustawiony, bez wartości kluczy', async () => {
  const githubSearch = { ...fakeConnector('live-github-search', 'github.com', ['nick'], () => []), enabledByDefault: false };
  const webSearch = { ...fakeConnector('web-search', 'wyszukiwarka', ['nick'], () => []), enabledByDefault: false };
  const monitorGithub = {
    ...fakeConnector('mon-gh-donate', 'github.com', [], () => []),
    description: 'Wyszukiwarka zgłoszeń GitHuba. Działa wyłącznie z tokenem (GITHUB_TOKEN) — bez niego źródło jest pomijane.',
  };
  const plain = fakeConnector('live-keybase', 'keybase.io', ['nick'], () => []);

  assert.deepEqual(sourceKeyInfo(plain), { requiresKey: false, keyConfigured: false });
  // Bez informacji z serwera o kluczu świadczy domyślne włączenie łącznika.
  assert.deepEqual(sourceKeyInfo(webSearch), { requiresKey: true, keyConfigured: false, keyEnv: ['MARGINALIA_API_KEY', 'MOJEEK_API_KEY'] });
  assert.equal(sourceKeyInfo({ ...githubSearch, enabledByDefault: true }).keyConfigured, true);

  const storage = await freshStorage();
  const app = await buildApp({
    storage,
    connectors: [plain, githubSearch, webSearch, monitorGithub],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
    configuredKeys: { GITHUB_TOKEN: false, MARGINALIA_API_KEY: true },
  });
  try {
    const connectors = (await app.inject('/api/connectors')).json() as { id: string; requiresKey: boolean; keyConfigured: boolean; keyEnv?: string[] }[];
    const byId = new Map(connectors.map((item) => [item.id, item]));
    assert.deepEqual([byId.get('live-keybase')!.requiresKey, byId.get('live-keybase')!.keyConfigured], [false, false]);
    assert.deepEqual([byId.get('live-github-search')!.requiresKey, byId.get('live-github-search')!.keyConfigured], [true, false]);
    assert.deepEqual([byId.get('web-search')!.requiresKey, byId.get('web-search')!.keyConfigured], [true, true]);
    assert.deepEqual([byId.get('mon-gh-donate')!.requiresKey, byId.get('mon-gh-donate')!.keyEnv], [true, ['GITHUB_TOKEN']]);
    assert.equal(byId.get('corpus')!.requiresKey, false);

    const health = (await app.inject('/api/health')).json();
    const web = health.sources.find((item: { id: string }) => item.id === 'web-search');
    assert.deepEqual([web.requiresKey, web.keyConfigured], [true, true]);
  } finally {
    await app.close();
    await storage.close();
  }
});

test('obserwowana sprawa: harmonogram w bazie, analiza w trybie głębokim, zmiany względem poprzedniej analizy', async () => {
  const storage = await freshStorage();
  let address = BTC_A;
  const github = fakeConnector('github', 'github.com', ['nick'], () => [{ url: 'https://github.com/janek', text: `Donate: ${address}`, author: 'janek' }]);
  const first = fakeTimers();
  // Zegar przesuwany ręcznie: kolejne analizy mają różne czasy rozpoczęcia.
  let current = FIXED_NOW().getTime();
  const now = () => new Date(current);
  const app = await buildApp({ storage, connectors: [github], chainProviders: [fakeProvider()], now, watchTimers: first.timers });
  let caseId = '';
  try {
    const created = (await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Janek', identifiers: [{ type: 'nick', value: 'janek' }] } })).json();
    caseId = created.id;
    assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${caseId}/runs`, payload: {} })).json().status, 'completed');
    current += 60_000;

    // Sprawa nieobserwowana: „Odśwież teraz” nie ma czego odświeżać.
    assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${caseId}/schedule/run` })).statusCode, 404);

    const scheduled = (await app.inject({ method: 'POST', url: `/api/cases/${caseId}/schedule`, payload: { everyMinutes: 60 } })).json();
    assert.deepEqual(scheduled.schedule, { everyMinutes: 60, nextRunAt: '2026-11-21T11:01:00.000Z' });
    assert.deepEqual([...first.pending.values()].map((item) => item.delayMs), [3_600_000]);

    let watched = (await app.inject('/api/watch')).json();
    assert.deepEqual(watched.intervals, [60, 360, 1440]);
    assert.equal(watched.items.length, 1);
    assert.equal(watched.items[0].depth, 'deep');
    assert.equal(watched.items[0].changes, undefined);

    // Termin mija: analiza startuje sama, harmonogram ustawia kolejny termin.
    address = BTC_B;
    current += 60 * 60_000;
    const [[handle, due]] = [...first.pending.entries()];
    first.pending.delete(handle);
    due.callback();
    for (let attempt = 0; attempt < 100 && !(await storage.getCase(caseId))!.runs.some((item, index) => index > 0); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const automatic = (await storage.getCase(caseId))!.runs.at(-1)!;
    await settle(app, automatic.id);
    assert.equal(((await app.inject(`/api/runs/${automatic.id}`)).json() as { depth?: string }).depth, 'deep');
    assert.equal(first.pending.size, 1);

    watched = (await app.inject('/api/watch')).json();
    const item = watched.items[0];
    assert.equal(item.running, false);
    assert.equal(item.lastRun.id, automatic.id);
    assert.deepEqual(item.changes.diff.addedAddresses, [BTC_B]);
    assert.deepEqual(item.changes.diff.removedAddresses, [BTC_A]);
    assert.deepEqual(item.changes.newCashOuts.map((change: { address: string }) => change.address), [BTC_B]);

    // „Odśwież teraz”: kolejna analiza od razu.
    current += 60_000;
    const refreshed = await app.inject({ method: 'POST', url: `/api/cases/${caseId}/schedule/run` });
    assert.equal(refreshed.statusCode, 202);
    await settle(app, refreshed.json().id);
  } finally {
    await app.close();
  }

  // Po ponownym uruchomieniu usługi harmonogram wraca z bazy.
  const second = fakeTimers();
  const restarted = await buildApp({ storage, connectors: [github], chainProviders: [fakeProvider()], now, watchTimers: second.timers });
  try {
    assert.equal((await restarted.inject(`/api/cases/${caseId}`)).json().schedule.everyMinutes, 60);
    assert.equal(second.pending.size, 1);
    const removed = (await restarted.inject({ method: 'DELETE', url: `/api/cases/${caseId}/schedule` })).json();
    assert.equal(removed.schedule, undefined);
    assert.equal(second.pending.size, 0);
    assert.deepEqual((await restarted.inject('/api/watch')).json().items, []);
  } finally {
    await restarted.close();
    await storage.close();
  }
});

test('zestawienie: statystyki każdej sprawy i wskaźniki skuteczności', async () => {
  const storage = await freshStorage();
  const github = fakeConnector('github', 'github.com', ['nick'], () => [{ url: 'https://github.com/janek', text: `Donate: ${BTC_A}`, author: 'janek' }]);
  const app = await buildApp({ storage, connectors: [github], chainProviders: [fakeProvider()], now: FIXED_NOW });
  try {
    const analysed = (await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Janek', identifiers: [{ type: 'nick', value: 'janek' }] } })).json();
    await app.inject({ method: 'POST', url: `/api/cases/${analysed.id}/runs`, payload: {} });
    await app.inject({ method: 'POST', url: '/api/cases', payload: { name: 'Bez analizy', identifiers: [{ type: 'nick', value: 'nikt' }] } });

    const overview = (await app.inject('/api/overview')).json();
    assert.equal(overview.caseStats.length, 1);
    const stat = overview.caseStats[0];
    assert.equal(stat.caseId, analysed.id);
    assert.deepEqual(Object.keys(stat).sort(), ['caseId', 'cashOutPlnTotal', 'hits', 'linkedAddresses', 'name', 'priority', 'services', 'topScore']);
    assert.equal(overview.stats.hitThreshold, 60);
    assert.equal(overview.stats.totalCases, 2);
    assert.equal(overview.stats.analysedCases, 1);
    assert.equal(overview.stats.averageConfidence, stat.topScore);
    assert.equal(overview.stats.casesWithHits, stat.hits > 0 ? 1 : 0);
    assert.equal(overview.stats.effectiveness, stat.hits > 0 ? 100 : 0);
    assert.equal(overview.stats.casesWithHitsShare, stat.hits > 0 ? 50 : 0);
  } finally {
    await app.close();
    await storage.close();
  }
});
