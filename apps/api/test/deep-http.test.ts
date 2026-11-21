import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ConnectorContext, DiscoveringConnector, SourceDocument, WatchHit } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { toCorpusDocument } from '../src/corpus.ts';
import { mergeInsight } from '../src/monitor.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_C, FIXED_NOW, fakeAi, fakeConnector, fakeProvider, run } from './helpers.ts';
import type { FakeAi } from './helpers.ts';

let app: FastifyInstance;
let storage: Storage;
let ai: FakeAi;
/** Bramka wstrzymująca wyszukiwanie — pozwala zobaczyć analizę w trakcie. */
let gate: Promise<void> | undefined;

const FORUM_POSTS = [
  { url: 'https://forum.example/t/1', author: 'marek_krk', text: `Sprzedam BTC za gotówkę w Krakowie, możliwy BLIK. Wpłata na adres ${BTC_C}. Kontakt: marek@krakow-btc.example` },
  { url: 'https://forum.example/t/2', author: 'crypto_mike', text: 'Which hardware wallet do you recommend for a beginner?' },
];

before(async () => {
  storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek' ? [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}` }] : [],
  );
  const slowSearch = gitpub.search.bind(gitpub);
  gitpub.search = async (identifier, context) => {
    await gate;
    return slowSearch(identifier, context);
  };
  // Pojedyncze źródło monitoringu z wyszukiwaniem: w analizie nie bierze udziału w żadnym trybie —
  // te same hosty pyta zbiorczo wyszukiwarka forów.
  const monitorSource = { ...fakeConnector('mon-forum-x', 'forum-x.example', ['nick'], () => []), enabledByDefault: false };
  // Wyszukiwarka forów: wyłączona domyślnie, dołączana tylko w trybie głębokim.
  const deepSearch = {
    ...fakeConnector('deep-search', 'forum.example', ['nick'], (identifier) =>
      identifier.value === 'krypto_janek' ? [{ url: 'https://forum.example/t/77', author: 'krypto_janek', category: 'forum_post' as const, text: `Sprzedam, płatność ${BTC_B}` }] : [],
    ),
    enabledByDefault: false,
  };
  // Źródło monitoringu bez wyszukiwania: publikacje trafiają do analizy wyłącznie przez indeks własny.
  const forum: DiscoveringConnector = {
    ...fakeConnector('forum', 'forum.example', [], () => []),
    async discover(_context: ConnectorContext, _limit: number): Promise<SourceDocument[]> {
      return FORUM_POSTS.map((post) => ({
        connectorId: 'forum',
        service: 'forum.example',
        title: 'Wątek',
        fetchedAt: '2026-11-21T09:00:00.000Z',
        category: 'forum_post',
        identityMatch: 'exact_identifier',
        matchedIdentifier: { type: 'nick', value: post.author },
        ...post,
      }));
    },
  };
  const deepProvider = { ...fakeProvider(), id: 'gleboki', getActivity: async (network: 'bitcoin', address: string) => ({ ...(await fakeProvider().getActivity(network, address, { log() {} })), limitations: ['Tryb głęboki.'] }) };
  ai = fakeAi((input) => (input.text.includes('BLIK') ? { polishNexus: { score: 90, reasons: ['oferta dla kupujących z Krakowa'] }, offer: { side: 'sell', asset: 'BTC', paymentMethods: ['gotówka', 'BLIK'], location: 'Kraków' }, quote: 'Sprzedam BTC za gotówkę' } : {}));
  app = await buildApp({
    storage,
    connectors: [gitpub, deepSearch, forum, monitorSource],
    chainProviders: [fakeProvider()],
    deepChainProviders: [deepProvider],
    ai,
    // Atrapa działa w procesie — jak model lokalny, bez anonimizacji faktów.
    aiLocal: true,
    corpus: { retentionDays: 30, maxRows: 1000 },
    now: FIXED_NOW,
  });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const send = (method: 'POST' | 'PUT', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object });
const newCase = async (value = 'krypto_janek') => (await send('POST', '/api/cases', { name: value, identifiers: [{ type: 'nick', value }] })).json().id as string;

test('stan usługi obejmuje bazę danych', async () => {
  const health = (await app.inject('/api/health')).json();
  assert.deepEqual([health.status, health.database], ['ok', 'ok']);
});

test('analiza w tle: odpowiedź od razu, postęp po etapach, wynik po zakończeniu', async () => {
  const caseId = await newCase();
  let release!: () => void;
  gate = new Promise((resolve) => (release = resolve));

  const started = await send('POST', `/api/cases/${caseId}/runs`, { async: true });
  assert.equal(started.statusCode, 202);
  const { id, status } = started.json();
  assert.equal(status, 'running');
  assert.equal((await app.inject(`/api/runs/${id}`)).json().status, 'running');

  const during = (await app.inject(`/api/runs/${id}/progress`)).json();
  assert.deepEqual([during.runId, during.caseId, during.status, during.depth, during.stage], [id, caseId, 'running', 'standard', 'search']);
  assert.equal(during.connectorsDone < during.connectorsTotal || during.connectorsTotal === 0, true);

  release();
  gate = undefined;
  let progress = during;
  for (let attempt = 0; attempt < 200 && progress.status === 'running'; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    progress = (await app.inject(`/api/runs/${id}/progress`)).json();
  }
  assert.deepEqual([progress.status, progress.stage, progress.addresses], ['completed', 'done', 1]);
  assert.ok(progress.connectorsTotal > 0);
  assert.equal(progress.connectorsDone, progress.connectorsTotal);
  assert.ok(progress.documents >= 1);

  const finished = (await app.inject(`/api/runs/${id}`)).json();
  assert.equal(finished.status, 'completed');
  assert.equal(finished.findings[0].address, BTC_A);
  assert.equal((await app.inject(`/api/cases/${caseId}/dossier`)).json().runId, id);

  // Analiza zapisana przed uruchomieniem serwera: znany jest tylko stan końcowy.
  await storage.saveRun({ ...run('run-dawny', []), caseId });
  const old = (await app.inject('/api/runs/run-dawny/progress')).json();
  assert.deepEqual([old.status, old.stage, old.depth], ['completed', 'done', 'standard']);
  assert.equal((await app.inject('/api/runs/brak/progress')).statusCode, 404);
});

test('tryb głęboki: dodatkowe źródła i dostawcy; tryb standardowy bez zmian', async () => {
  const caseId = await newCase();
  const standard = (await send('POST', `/api/cases/${caseId}/runs`, {})).json();
  assert.deepEqual(standard.connectors, ['gitpub', 'forum', 'corpus']);
  assert.equal(standard.depth, undefined);
  assert.deepEqual(standard.findings.map((finding: { address: string }) => finding.address), [BTC_A]);

  const response = await send('POST', `/api/cases/${caseId}/runs`, { depth: 'deep' });
  assert.equal(response.statusCode, 201);
  const deep = response.json();
  assert.equal(deep.depth, 'deep');
  assert.deepEqual(deep.connectors, ['gitpub', 'deep-search', 'forum', 'corpus']);
  assert.deepEqual(deep.findings.map((finding: { address: string }) => finding.address).sort(), [BTC_A, BTC_B].sort());
  assert.deepEqual(deep.findings[0].chain.limitations, ['Tryb głęboki.']);
  const progress = (await app.inject(`/api/runs/${deep.id}/progress`)).json();
  assert.equal(progress.depth, 'deep');
  // Po zakończeniu postęp zawiera pomiar czasu faz i najwolniejsze zapytania.
  assert.deepEqual(progress.timings.map((item: { stage: string }) => item.stage), ['search-0', 'occurrences', 'chain', 'counterparties', 'pivot', 'scoring', 'ai']);
  assert.ok(progress.slowestQueries.length > 0 && progress.slowestQueries.length <= 10);
  assert.deepEqual(Object.keys(progress.slowestQueries[0]).sort(), ['connectorId', 'documents', 'identifier', 'ms']);
  assert.equal((await send('POST', `/api/cases/${caseId}/runs`, { depth: 'bardzo' })).statusCode, 400);

  // To samo jednym wywołaniem — także w tle.
  const quick = await send('POST', '/api/quick', { value: 'krypto_janek', depth: 'deep' });
  assert.equal(quick.statusCode, 201);
  assert.equal(quick.json().dossier.findings.length, 2);
  const background = await send('POST', '/api/quick', { value: 'krypto_janek', async: true });
  assert.equal(background.statusCode, 202);
  assert.deepEqual(Object.keys(background.json()).sort(), ['case', 'run']);
  assert.equal(background.json().run.status, 'running');
});

test('model językowy: stan, odczyty przy śladach, streszczenie teczki, reguły', async () => {
  const caseId = await newCase();
  const done = (await send('POST', `/api/cases/${caseId}/runs`)).json();
  assert.equal(done.findings[0].evidence[0].insight.model, 'atrapa-1');

  const dossier = (await app.inject(`/api/runs/${done.id}/dossier`)).json();
  assert.deepEqual(dossier.summary, { text: `Streszczenie ${dossier.keyFindings.length} ustaleń.`, model: 'atrapa-1', promptVersion: 's1' });
  assert.deepEqual(ai.calls.summaries.at(-1), dossier.keyFindings.map((item: { text: string }) => item.text));
  assert.deepEqual(dossier.cashOutProof, []);
  assert.equal(dossier.partial, false);
  const report = (await app.inject(`/api/runs/${done.id}/report.html`)).body;
  assert.ok(report.includes('Streszczenie wygenerowane przez model językowy (atrapa-1'));
  assert.ok(report.includes('Dowód spieniężenia'));

  const state = (await app.inject('/api/ai')).json();
  assert.deepEqual([state.enabled, state.provider, state.model], [true, 'atrapa', 'atrapa-1']);
  assert.ok(state.usage.analyzePublication >= 1 && state.usage.summarize >= 1);
  assert.equal(state.usage.errors, 0);

  const rules = (await app.inject('/api/priority-rules')).json();
  assert.equal(rules.ai.maxPublicationsPerAnalysis, 40);
  assert.ok(rules.ai.rules.length >= 5);
  assert.equal(rules.proof.formula, 'łączna pewność ustalenia = P(osoba–adres) × P(ścieżka) / 100');
  assert.deepEqual([rules.analysis.depth.standard.maxChainAddresses, rules.analysis.depth.deep.maxChainAddresses], [15, 40]);

  // Decyzja dla pojedynczego śladu jest przyjmowana przez API.
  const decided = await send('POST', `/api/cases/${caseId}/decisions`, { target: 'evidence', key: done.findings[0].evidence[0].id, decision: 'rejected' });
  assert.equal(decided.statusCode, 201);
  assert.equal((await app.inject(`/api/runs/${done.id}/dossier`)).json().findings[0].evidence.length, 0);

  // Model poza tą maszyną dostaje fakty bez danych osobowych i adresów; w odpowiedzi znaczniki wracają.
  const remoteStorage = createStorage(await createPgliteDriver());
  await remoteStorage.migrate();
  const remoteAi = fakeAi();
  remoteAi.summarize = async (facts) => {
    remoteAi.calls.summaries.push(facts);
    return { text: `Dotyczy: ${/\[(?:OSOBA|NICK)-\d+\]/.exec(facts.join(' '))?.[0]}, adres ${/\[ADRES-\d+\]/.exec(facts.join(' '))?.[0]}.`, model: 'zdalny', promptVersion: 's1' };
  };
  const profile = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}` }]);
  const remote = await buildApp({ storage: remoteStorage, connectors: [profile], chainProviders: [fakeProvider()], ai: remoteAi, now: FIXED_NOW });
  const viaRemote = (await remote.inject({ method: 'POST', url: '/api/quick', payload: { value: 'krypto_janek' } })).json();
  const sent = remoteAi.calls.summaries.at(-1)!.join(' ');
  assert.ok(!sent.includes('krypto_janek') && !sent.includes(BTC_A) && !sent.includes(BTC_A.slice(0, 10)));
  assert.ok(/\[(?:OSOBA|NICK)-\d+\]/.test(sent) && /\[ADRES-\d+\]/.test(sent));
  assert.match(viaRemote.dossier.summary.text, /^Dotyczy: krypto_janek, adres 1A1zP1eP5Q/);
  await remote.close();
  await remoteStorage.close();

  // Bez modelu: te same trasy, wynik wyłącznie z reguł.
  const plainStorage = createStorage(await createPgliteDriver());
  await plainStorage.migrate();
  const plain = await buildApp({ storage: plainStorage, connectors: [], chainProviders: [], now: FIXED_NOW });
  const disabled = (await plain.inject('/api/ai')).json();
  assert.deepEqual([disabled.enabled, disabled.provider, disabled.model], [false, null, null]);
  const quick = (await plain.inject({ method: 'POST', url: '/api/quick', payload: { value: 'nikt' } })).json();
  assert.equal(quick.dossier.summary, null);
  await plain.close();
  await plainStorage.close();
});

test('indeks publikacji: monitoring zapisuje, analiza osoby i adresu z niego korzysta', async () => {
  const { newHits } = (await send('POST', '/api/monitor/run')).json();
  // Do indeksu trafia każda pobrana publikacja, nie tylko trafienia.
  assert.equal(newHits.length, 1);
  const stats = (await app.inject('/api/corpus/stats')).json();
  assert.deepEqual(
    { ...stats, oldestFetchedAt: undefined, newestFetchedAt: undefined },
    { documents: 2, addresses: 1, services: 1, retentionDays: 30, maxRows: 1000, oldestFetchedAt: undefined, newestFetchedAt: undefined },
  );
  assert.equal(stats.newestFetchedAt, '2026-11-21T09:00:00.000Z');

  // Odczyt modelu uzupełnia trafienie: większa z ocen, oferta z oznaczeniem „model”.
  const [hit] = newHits;
  assert.equal(hit.insight.model, 'atrapa-1');
  assert.ok(hit.polishNexus.reasons.some((reason: string) => reason === 'Model atrapa-1: oferta dla kupujących z Krakowa'));
  assert.ok(hit.suspicion.reasons.some((reason: string) => reason.startsWith('Model atrapa-1: oferta (sprzedaż) — BTC; płatność: gotówka, BLIK; miejscowość: Kraków')));

  // Źródło „forum” nie umie wyszukiwać — dokumenty autora pochodzą wyłącznie z indeksu.
  const byAuthor = (await send('POST', '/api/quick', { value: 'marek_krk' })).json();
  assert.equal(byAuthor.dossier.findings[0].address, BTC_C);
  const [found] = byAuthor.dossier.findings[0].evidence;
  assert.deepEqual([found.connectorId, found.service, found.url], ['corpus', 'forum.example', 'https://forum.example/t/1']);

  // Analiza samego adresu znajduje publikację w indeksie, ale wypowiedź na forum to wzmianka —
  // jej autor nie jest wskazywany jako właściciel.
  const byAddress = (await send('POST', '/api/quick', { value: BTC_C, period: { from: '2024-01-01', to: '2025-12-31' } })).json();
  assert.equal(byAddress.case.query.identifiers[0].type, 'crypto_address');
  assert.deepEqual(byAddress.dossier.persons, []);
  assert.deepEqual(byAddress.dossier.mentions, [{ identifier: { type: 'crypto_address', value: BTC_C }, documents: 1, authors: 1, services: 1 }]);
  assert.match(byAddress.dossier.keyFindings[0].text, /^Adres jest wymieniany w cudzych publikacjach \(co najmniej 1 autor w 1 serwisie\) — nie da się wskazać właściciela/);
  // Okres wskazany przez analityka jest zapisany przy analizie i opisany w adnotacji adresu.
  assert.deepEqual((await app.inject(`/api/runs/${byAddress.dossier.runId}`)).json().period, { from: '2024-01-01', to: '2025-12-31' });
  assert.ok(byAddress.dossier.findings[0].annotations.some((note: string) => note.includes('pełna historia adresu') && note.includes('od 2024-01-01 do 2025-12-31')));
  assert.equal((await send('POST', '/api/quick', { value: BTC_C, period: { from: 'wczoraj' } })).statusCode, 400);
  assert.equal((await send('POST', '/api/quick', { value: BTC_C, period: { from: '2025-01-01', to: '2024-01-01' } })).statusCode, 400);
  // Fraza w treści: e-mail podany w poście.
  const byEmail = (await send('POST', '/api/quick', { value: 'marek@krakow-btc.example' })).json();
  assert.equal(byEmail.dossier.findings[0].address, BTC_C);
});

test('indeks publikacji: wyszukiwanie dokładne i po frazie, retencja po wieku i liczbie', async () => {
  const index = createStorage(await createPgliteDriver());
  await index.migrate();
  const doc = (url: string, author: string, text: string, fetchedAt: string) =>
    toCorpusDocument({ connectorId: 'mon-x', service: 'forum.example', url, title: 'T', text, fetchedAt, author, category: 'forum_post', identityMatch: 'same_handle', matchedIdentifier: { type: 'nick', value: author } });
  await index.saveCorpusDocuments([
    doc('https://f.example/1', 'Ala_Kot', `Adres ${BTC_A}, 100% pewności`, '2026-11-01T00:00:00.000Z'),
    doc('https://f.example/2', 'ala_kot', `Drugi adres ${BTC_B}`, '2026-11-10T00:00:00.000Z'),
    doc('https://f.example/3', 'ola', `Cytuję ${BTC_A}`, '2026-11-20T00:00:00.000Z'),
    // Powtórka adresu URL jest pomijana.
    doc('https://f.example/3', 'ola', 'inna treść', '2026-11-21T00:00:00.000Z'),
  ]);

  assert.deepEqual((await index.searchCorpus({ address: BTC_A }, 10)).map((item) => item.url), ['https://f.example/3', 'https://f.example/1']);
  assert.deepEqual((await index.searchCorpus({ author: '@ALA_KOT' }, 10)).map((item) => item.url), ['https://f.example/2', 'https://f.example/1']);
  assert.deepEqual((await index.searchCorpus({ phrase: 'DRUGI adres' }, 10)).map((item) => item.url), ['https://f.example/2']);
  // Znaki wieloznaczne w frazie są traktowane dosłownie.
  assert.deepEqual((await index.searchCorpus({ phrase: '100% pewności' }, 10)).length, 1);
  assert.deepEqual((await index.searchCorpus({ phrase: '1_0' }, 10)).length, 0);
  const [first] = await index.searchCorpus({ author: 'ola' }, 10);
  assert.deepEqual(first!.addresses, [{ network: 'bitcoin', address: BTC_A }]);
  assert.match(first!.contentHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(await index.corpusStats(), { documents: 3, addresses: 2, services: 1, oldestFetchedAt: '2026-11-01T00:00:00.000Z', newestFetchedAt: '2026-11-20T00:00:00.000Z' });

  // Retencja: najpierw wiek, potem limit liczby wierszy (zostają najnowsze).
  assert.equal(await index.pruneCorpus('2026-11-05T00:00:00.000Z', 1000), 1);
  assert.equal(await index.pruneCorpus('2000-01-01T00:00:00.000Z', 1), 1);
  assert.deepEqual((await index.searchCorpus({ phrase: 'cytuję' }, 10)).map((item) => item.url), ['https://f.example/3']);
  assert.equal((await index.corpusStats()).addresses, 1);
  await index.close();
});

test('monitoring: łączenie odczytu modelu z ocenami z reguł', () => {
  const hit: WatchHit = {
    id: 'h1',
    detectedAt: '2026-11-21T10:00:00.000Z',
    connectorId: 'mon-x',
    service: 'forum.example',
    url: 'https://forum.example/t/9',
    title: 'WTS',
    excerpt: '…',
    language: 'und',
    addresses: [],
    polishNexus: { score: 25, reasons: ['Polskie miasto lub region: „Warsaw” (+25)'] },
    suspicion: { score: 25, reasons: ['Gotówka lub transakcja osobista: „cash” (+25)'] },
    status: 'new',
  };
  const merged = mergeInsight(hit, {
    ownership: 'own_address',
    language: 'en',
    quote: 'selling 2 BTC',
    model: 'm1',
    promptVersion: 'p1',
    translationPl: 'Sprzedam 2 BTC za gotówkę w Warszawie.',
    polishNexus: { score: 70, reasons: ['autor pisze, że mieszka w Warszawie'] },
    offer: { side: 'sell', asset: 'BTC', amount: 2, currency: 'BTC', paymentMethods: ['cash'], location: 'Warsaw' },
  });
  assert.deepEqual(merged.polishNexus, { score: 70, reasons: ['Polskie miasto lub region: „Warsaw” (+25)', 'Model m1: autor pisze, że mieszka w Warszawie'] });
  // Reguły nie wykryły oferty — model dokłada ją z oznaczeniem źródła.
  assert.equal(merged.suspicion.score, 55);
  assert.equal(merged.suspicion.reasons.at(-1), 'Model m1: oferta (sprzedaż) — kwota 2 BTC; płatność: cash; miejscowość: Warsaw. Cytat: „selling 2 BTC” (+30)');
  assert.deepEqual([merged.language, merged.translationPl], ['en', 'Sprzedam 2 BTC za gotówkę w Warszawie.']);
  // Gdy reguły same wykryły ofertę, model dodaje tylko opis.
  const known = mergeInsight({ ...hit, suspicion: { score: 30, reasons: ['Oferta kupna, sprzedaży lub wymiany kryptowalut: „selling BTC” (+30)'] } }, { ownership: 'unclear', language: 'en', quote: '', model: 'm1', promptVersion: 'p1', offer: { side: 'buy', paymentMethods: [] } });
  assert.equal(known.suspicion.score, 30);
  assert.equal(known.polishNexus.score, 25);
});
