import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ConnectorContext, DiscoveringConnector, SourceDocument } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { createMonitor } from '../src/monitor.ts';
import type { MonitorTimers } from '../src/monitor.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

type Post = { url: string; text: string; author?: string; title?: string };

const POLISH_OFFER: Post = {
  url: 'https://forum.example/t/1',
  author: 'marek_krk',
  text: `Sprzedam BTC za gotówkę w Krakowie, możliwy BLIK. Wpłata na adres ${BTC_A}`,
};
const ENGLISH_POST: Post = { url: 'https://forum.example/t/2', author: 'crypto_mike', text: `My donation address is ${BTC_B}, thanks for the support.` };
const POLISH_NO_ADDRESS: Post = { url: 'https://forum.example/t/3', author: 'wymiana_waw', text: 'Kupię USDT za gotówkę, Warszawa, do 20 000 zł, tylko odbiór osobisty.' };
const IRRELEVANT: Post = { url: 'https://forum.example/t/4', author: 'ktos', text: 'Which hardware wallet do you recommend for a beginner?' };
const NO_AUTHOR: Post = { url: 'https://forum.example/t/5', text: `Anonymous paste: ${BTC_D}` };
const ALL_POSTS = [POLISH_OFFER, ENGLISH_POST, POLISH_NO_ADDRESS, IRRELEVANT, NO_AUTHOR];

/** Atrapa źródła monitoringu: `discover` zwraca bieżącą listę postów, `search` — posty autora. */
function forumSource(id: string, posts: () => Post[]) {
  const state = { discoverCalls: 0, fail: undefined as string | undefined, gate: undefined as Promise<void> | undefined };
  const base = fakeConnector(id, 'forum.example', ['nick', 'crypto_address'], (identifier) =>
    posts()
      .filter((post) => (identifier.type === 'nick' ? post.author === identifier.value : post.text.includes(identifier.value)))
      .map((post) => ({ ...post, category: 'forum_post' as const })),
  );
  const connector: DiscoveringConnector & { state: typeof state } = {
    ...base,
    state,
    async discover(_context: ConnectorContext, _limit: number): Promise<SourceDocument[]> {
      state.discoverCalls++;
      await state.gate;
      if (state.fail) throw new Error(state.fail);
      return posts().map((post) => ({
        connectorId: id,
        service: 'forum.example',
        title: post.title ?? 'Wątek',
        fetchedAt: '2026-11-21T09:00:00.000Z',
        category: 'forum_post',
        identityMatch: 'exact_identifier',
        matchedIdentifier: { type: 'nick', value: post.author ?? '' },
        ...post,
      }));
    },
  };
  return connector;
}

/** Sterowany zegar harmonogramu: zapamiętuje ustawione odliczania zamiast czekać. */
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

const monitorWith = (storage: Storage, sources: DiscoveringConnector[], timers?: MonitorTimers) =>
  createMonitor({ storage, connectors: sources, chainProviders: [fakeProvider()], now: FIXED_NOW, timers });

test('przebieg: trafienia z adresem lub z sygnałami, automatyczna analiza od progu', async () => {
  const storage = await freshStorage();
  const monitor = monitorWith(storage, [forumSource('forum', () => ALL_POSTS)]);
  const newHits = await monitor.run();
  const byAuthor = new Map(newHits.map((hit) => [hit.author ?? '(brak)', hit]));

  // Dokument bez adresu i bez sygnałów nie jest trafieniem.
  assert.deepEqual([...byAuthor.keys()].sort(), ['(brak)', 'crypto_mike', 'marek_krk', 'wymiana_waw']);
  // Kolejność: malejąco po sumie ocen.
  const sums = newHits.map((hit) => hit.polishNexus.score + hit.suspicion.score);
  assert.deepEqual(sums, [...sums].sort((a, b) => b - a));

  const offer = byAuthor.get('marek_krk')!;
  assert.equal(offer.language, 'pl');
  assert.equal(offer.polishNexus.score, 100);
  assert.equal(offer.suspicion.score, 65);
  assert.deepEqual(offer.addresses, [{ address: BTC_A, network: 'bitcoin' }]);
  assert.ok(offer.excerpt.includes(BTC_A));
  // Suma 165 ≥ próg 100: autor przeanalizowany automatycznie, wskazanie z jawnym składnikiem związku z Polską.
  assert.equal(offer.status, 'analyzed');
  assert.equal(offer.lead!.handle, 'marek_krk');
  assert.equal(offer.lead!.addresses[0]!.address, BTC_A);
  assert.ok(offer.lead!.topScore > 0);
  assert.match(offer.lead!.priorityReasons.at(-2)!, /^Związek z Polską \(składnik monitoringu\): 100\/100 × 0,10 = \+10,0 pkt\./);
  assert.match(offer.lead!.priorityReasons.at(-1)!, new RegExp(`^Priorytet wskazania z monitoringu: ${offer.lead!.priority}/100`));
  assert.ok((await storage.getHitAnalysis(offer.id))!.findings.length > 0);

  // Trafienie bez adresu powstaje z samych sygnałów (oba progi) i też jest analizowane.
  const noAddress = byAuthor.get('wymiana_waw')!;
  assert.deepEqual(noAddress.addresses, []);
  assert.ok(noAddress.polishNexus.score >= 40 && noAddress.suspicion.score >= 30);
  assert.equal(noAddress.status, 'analyzed');

  // Adres bez sygnałów: trafienie zostaje, ale poniżej progu automatycznej analizy.
  const english = byAuthor.get('crypto_mike')!;
  assert.equal(english.status, 'new');
  assert.equal(english.lead, undefined);
  assert.equal(english.polishNexus.score, 0);
  // Publikacja bez autora nie ma kogo analizować.
  assert.equal(byAuthor.get('(brak)')!.status, 'new');

  const status = await monitor.status();
  assert.deepEqual(status.totals, { documentsSeen: 5, hits: 4, analyzed: 2, newHits: 2 });
  assert.equal(status.lastRunAt, '2026-11-21T10:00:00.000Z');
  assert.deepEqual(status.sources, [
    { connectorId: 'forum', label: 'Atrapa forum', service: 'forum.example', enabled: true, lastRunAt: '2026-11-21T10:00:00.000Z', documentsSeen: 5, hits: 4 },
  ]);
  await storage.close();
});

test('próg automatycznej analizy: poniżej progu trafienie czeka na decyzję, analizę można wymusić', async () => {
  const storage = await freshStorage();
  const monitor = monitorWith(storage, [forumSource('forum', () => ALL_POSTS)]);
  await monitor.configure({ autoAnalyzeThreshold: 200 });
  const newHits = await monitor.run();
  assert.ok(newHits.every((hit) => hit.status === 'new' && hit.lead === undefined));

  // Próg między sumami ocen: analizowany jest tylko autor najwyżej ocenionej publikacji.
  const second = await freshStorage();
  const strict = monitorWith(second, [forumSource('forum', () => ALL_POSTS)]);
  await strict.configure({ autoAnalyzeThreshold: 165 });
  assert.deepEqual((await strict.run()).filter((hit) => hit.status === 'analyzed').map((hit) => hit.author), ['marek_krk']);

  const offer = newHits.find((hit) => hit.author === 'marek_krk')!;
  const forced = (await monitor.analyze(offer.id))!;
  assert.equal(forced.status, 'analyzed');
  assert.equal(forced.lead!.handle, 'marek_krk');
  assert.equal(await monitor.analyze('brak'), null);
  await assert.rejects(monitor.analyze(newHits.find((hit) => !hit.author)!.id), /nie ma wskazanego autora/);
  await storage.close();
  await second.close();
});

test('pamięć widzianych publikacji i deduplikacja autora', async () => {
  const storage = await freshStorage();
  let posts = [POLISH_OFFER, ENGLISH_POST];
  const source = forumSource('forum', () => posts);
  const monitor = monitorWith(storage, [source]);
  assert.equal((await monitor.run()).length, 2);

  // Drugi przebieg po tych samych publikacjach: nic nowego, liczniki bez zmian.
  assert.deepEqual(await monitor.run(), []);
  assert.deepEqual((await monitor.status()).totals, { documentsSeen: 2, hits: 2, analyzed: 1, newHits: 1 });
  assert.equal(source.state.discoverCalls, 2);

  // Kolejny post tego samego autora uzupełnia istniejące trafienie zamiast tworzyć nowe.
  posts = [...posts, { url: 'https://forum.example/t/9', author: 'Marek_KRK', text: `Nowy adres do wpłat: ${BTC_C}` }];
  assert.deepEqual(await monitor.run(), []);
  const hits = await storage.listHits();
  assert.equal(hits.length, 2);
  const offer = hits.find((hit) => hit.author === 'marek_krk')!;
  assert.deepEqual(offer.addresses.map((item) => item.address), [BTC_A, BTC_C]);
  // Wizytówką trafienia zostaje wyżej oceniona publikacja; stan i wynik analizy są zachowane.
  assert.equal(offer.url, POLISH_OFFER.url);
  assert.equal(offer.status, 'analyzed');
  assert.ok(offer.lead);
  assert.equal((await monitor.status()).totals.documentsSeen, 3);
  await storage.close();
});

test('błąd źródła nie przerywa przebiegu i jest widoczny w stanie źródła', async () => {
  const storage = await freshStorage();
  const broken = forumSource('zepsute', () => []);
  broken.state.fail = 'HTTP 503';
  const working = forumSource('forum', () => [POLISH_OFFER]);
  const monitor = monitorWith(storage, [broken, working]);

  assert.equal((await monitor.run()).length, 1);
  let sources = (await monitor.status()).sources;
  assert.equal(sources.find((source) => source.connectorId === 'zepsute')!.lastError, 'HTTP 503');
  assert.equal(sources.find((source) => source.connectorId === 'forum')!.lastError, undefined);

  // Po udanym przebiegu błąd znika; wyłączone źródło nie jest odpytywane.
  broken.state.fail = undefined;
  await monitor.configure({ sources: { forum: false } });
  await monitor.run();
  sources = (await monitor.status()).sources;
  assert.equal(sources.find((source) => source.connectorId === 'zepsute')!.lastError, undefined);
  assert.equal(sources.find((source) => source.connectorId === 'forum')!.enabled, false);
  assert.equal(working.state.discoverCalls, 1);
  await assert.rejects(monitor.configure({ sources: { 'nie-ma': true } }), /Nieznane źródło monitoringu/);
  await storage.close();
});

test('harmonogram: trwałe ustawienia, jeden przebieg naraz, zatrzymanie', async () => {
  const storage = await freshStorage();
  const source = forumSource('forum', () => [ENGLISH_POST]);
  const clock = fakeTimers();
  const monitor = monitorWith(storage, [source], clock.timers);

  // Domyślnie monitoring jest wyłączony — nic nie jest zaplanowane.
  await monitor.start();
  assert.equal(clock.pending.size, 0);
  assert.deepEqual([(await monitor.status()).enabled, (await monitor.status()).nextRunAt], [false, undefined]);

  // Po włączeniu pierwszy przebieg jest planowany od razu (bez wcześniejszego przebiegu).
  let status = await monitor.configure({ enabled: true, everyMinutes: 15 });
  assert.deepEqual([...clock.pending.values()].map((item) => item.delayMs), [1_000]);
  assert.equal(status.nextRunAt, '2026-11-21T10:00:01.000Z');

  // Odliczanie mija: przebieg startuje; drugi start w trakcie dołącza do trwającego.
  let release!: () => void;
  source.state.gate = new Promise((resolve) => (release = resolve));
  const [scheduled] = [...clock.pending.values()];
  clock.pending.clear();
  scheduled!.callback();
  const first = monitor.run();
  const second = monitor.run();
  assert.equal(first, second);
  assert.equal((await monitor.status()).running, true);
  release();
  await first;
  assert.equal(source.state.discoverCalls, 1);

  // Po przebiegu kolejny jest planowany za pełny okres.
  status = await monitor.status();
  assert.equal(status.running, false);
  assert.equal(status.nextRunAt, '2026-11-21T10:15:00.000Z');
  assert.deepEqual([...clock.pending.values()].map((item) => item.delayMs), [15 * 60_000]);

  // Ustawienia są trwałe: nowa instancja na tej samej bazie planuje przebieg sama.
  await monitor.stop();
  assert.equal(clock.pending.size, 0);
  const restarted = fakeTimers();
  const again = monitorWith(storage, [source], restarted.timers);
  await again.start();
  assert.deepEqual([...restarted.pending.values()].map((item) => item.delayMs), [15 * 60_000]);
  assert.equal((await again.status()).everyMinutes, 15);

  // Wyłączenie usuwa zaplanowany przebieg.
  status = await again.configure({ enabled: false });
  assert.equal(restarted.pending.size, 0);
  assert.equal(status.nextRunAt, undefined);
  await again.stop();
  await storage.close();
});

// ---------- Trasy HTTP ----------

let app: FastifyInstance;

before(async () => {
  const storage = await freshStorage();
  const forum = forumSource('forum', () => ALL_POSTS);
  // Zwykły łącznik bez `discover` nie jest źródłem monitoringu, ale bierze udział w analizie autora.
  const profiles = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'marek_krk' ? [{ url: 'https://gitpub.example/marek_krk', author: 'marek_krk', text: `Donate: ${BTC_A}` }] : [],
  );
  app = await buildApp({ storage, connectors: [forum, profiles], chainProviders: [fakeProvider()], now: FIXED_NOW, monitorTimers: fakeTimers().timers });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const send = (method: 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object });

test('trasy monitoringu: stan, ustawienia, przebieg, trafienia i działania', async () => {
  const initial = (await app.inject('/api/monitor')).json();
  assert.deepEqual([initial.enabled, initial.everyMinutes, initial.autoAnalyzeThreshold, initial.running], [false, 30, 100, false]);
  assert.deepEqual(initial.sources.map((source: { connectorId: string }) => source.connectorId), ['forum']);

  const configured = await send('PUT', '/api/monitor', { everyMinutes: 60, autoAnalyzeThreshold: 165, sources: { forum: true } });
  assert.equal(configured.statusCode, 200);
  assert.deepEqual([configured.json().everyMinutes, configured.json().autoAnalyzeThreshold], [60, 165]);
  for (const payload of [{ everyMinutes: 0 }, { autoAnalyzeThreshold: 500 }, { sources: { 'nie-ma': true } }]) {
    assert.equal((await send('PUT', '/api/monitor', payload)).statusCode, 400, JSON.stringify(payload));
  }

  const run = await send('POST', '/api/monitor/run');
  assert.equal(run.statusCode, 200);
  const { status, newHits } = run.json();
  assert.equal(newHits.length, 4);
  assert.deepEqual(status.totals, { documentsSeen: 5, hits: 4, analyzed: 1, newHits: 3 });
  assert.equal((await send('POST', '/api/monitor/run')).json().newHits.length, 0);

  // Lista: malejąco po sumie ocen; filtry po stanie i ocenach.
  const hits = (await app.inject('/api/monitor/hits')).json();
  assert.deepEqual(hits.slice(0, 2).map((hit: { author?: string }) => hit.author), ['marek_krk', 'wymiana_waw']);
  assert.equal(hits.length, 4);
  assert.deepEqual((await app.inject('/api/monitor/hits?status=analyzed')).json().map((hit: { author: string }) => hit.author), ['marek_krk']);
  assert.deepEqual((await app.inject('/api/monitor/hits?minPolish=40&minSuspicion=30')).json().length, 2);
  assert.equal((await app.inject('/api/monitor/hits?limit=1')).json().length, 1);
  assert.equal((await app.inject('/api/monitor/hits?status=inne')).statusCode, 400);

  const [offer, noAddress] = hits;
  const english = hits.find((hit: { author?: string }) => hit.author === 'crypto_mike');
  const anonymous = hits.find((hit: { author?: string }) => hit.author === undefined);
  // Analiza autora korzysta także ze zwykłych łączników: adres potwierdzony w dwóch serwisach.
  assert.deepEqual(offer.lead.services.sort(), ['forum.example', 'gitpub.example']);

  // Ręczne wymuszenie analizy.
  const analyzed = await send('POST', `/api/monitor/hits/${noAddress.id}/analyze`);
  assert.equal(analyzed.statusCode, 200);
  assert.equal(analyzed.json().status, 'analyzed');
  assert.equal(analyzed.json().lead.handle, 'wymiana_waw');
  assert.equal((await send('POST', `/api/monitor/hits/${anonymous.id}/analyze`)).statusCode, 400);
  assert.equal((await send('POST', '/api/monitor/hits/brak/analyze')).statusCode, 404);

  // Sprawa z trafienia: zapisana już analiza staje się pierwszą analizą sprawy.
  const created = await send('POST', `/api/monitor/hits/${offer.id}/case`);
  assert.equal(created.statusCode, 201);
  const summary = created.json();
  assert.equal(summary.name, 'Monitoring: marek_krk');
  assert.deepEqual(summary.query.identifiers, [
    { type: 'nick', value: 'marek_krk' },
    { type: 'crypto_address', value: BTC_A },
  ]);
  assert.equal(summary.runs.length, 1);
  assert.equal(summary.runs[0].status, 'completed');
  assert.equal((await app.inject(`/api/cases/${summary.id}/dossier`)).json().findings[0].address, BTC_A);
  assert.equal((await send('POST', `/api/monitor/hits/${offer.id}/case`)).json().id, summary.id);
  // Trafienie nieanalizowane: sprawa najpierw wykonuje analizę autora.
  const fromNew = await send('POST', `/api/monitor/hits/${english.id}/case`);
  assert.equal(fromNew.statusCode, 201);
  assert.equal(fromNew.json().runs.length, 1);
  assert.equal((await app.inject(`/api/monitor/hits?status=analyzed`)).json().find((hit: { id: string }) => hit.id === english.id).caseId, fromNew.json().id);

  const dismissed = await send('POST', `/api/monitor/hits/${anonymous.id}/dismiss`);
  assert.equal(dismissed.statusCode, 200);
  assert.equal(dismissed.json().status, 'dismissed');
  assert.deepEqual((await app.inject('/api/monitor/hits?status=dismissed')).json().map((hit: { id: string }) => hit.id), [anonymous.id]);
  assert.equal((await send('POST', '/api/monitor/hits/brak/dismiss')).statusCode, 404);
  assert.equal((await send('POST', '/api/monitor/hits/brak/case')).statusCode, 404);

  // Zestawienie spraw i jawne reguły sygnałów.
  const overview = (await app.inject('/api/overview')).json();
  assert.deepEqual(overview.monitor, { enabled: false, lastRunAt: '2026-11-21T10:00:00.000Z', newHits: 0 });
  const rules = (await app.inject('/api/priority-rules')).json();
  assert.equal(rules.signals.thresholds.hitPolishNexus, 40);
  assert.equal(rules.signals.polishWeights.blik, 30);
  assert.equal(rules.signals.suspicionWeights.noKyc, 25);
});
