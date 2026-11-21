import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import type { ConnectorContext, SourceDocument } from '@olcys/core';
import { buildApp, detectIdentifierType } from '../src/app.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_C, BTC_EXCHANGE, ETH_A, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

let app: FastifyInstance;

/** Ogłoszenia na „targu”: każdy sprzedawca ma swoje adresy; `discover` zwraca świeże oferty. */
const OFFERS: Record<string, string> = {
  sprzedawca_jeden: `Sprzedam rower, płatność BTC: ${BTC_C}`,
  sprzedawca_dwa: `Skup i sprzedaż. BTC: ${BTC_B}, ETH: ${ETH_A}`,
};
const offer = (author: string) => ({
  url: `https://targ.example/oferta/${author}`,
  author,
  category: 'sale_offer' as const,
  text: OFFERS[author]!,
});

before(async () => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick', 'email'], (identifier) =>
    identifier.value === 'krypto_janek' || identifier.type === 'email'
      ? [
          {
            url: 'https://gitpub.example/krypto_janek',
            author: 'krypto_janek',
            text: `Wsparcie: ${BTC_A}. Konto mam na Kraken.`,
            profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', emails: ['jan.kowalski@poczta.example'] },
            discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_btc' }],
          },
        ]
      : [],
  );
  const targ = {
    ...fakeConnector('targ', 'targ.example', ['nick'], (identifier) => (OFFERS[identifier.value] ? [offer(identifier.value)] : [])),
    async discover(_context: ConnectorContext, _limit: number): Promise<SourceDocument[]> {
      const base = { connectorId: 'targ', service: 'targ.example', fetchedAt: '2026-11-21T09:00:00.000Z', identityMatch: 'exact_identifier' as const };
      const matched = { type: 'nick' as const, value: '' };
      return [
        ...Object.keys(OFFERS).map((author) => ({ ...base, ...offer(author), title: 'Oferta', matchedIdentifier: matched })),
        { ...base, url: 'https://targ.example/oferta/anonim', title: 'Oferta', category: 'sale_offer', text: `Bez autora: ${BTC_A}`, matchedIdentifier: matched },
        { ...base, url: 'https://targ.example/oferta/bez-adresu', title: 'Oferta', author: 'ktos', category: 'sale_offer', text: 'Sprzedam szafę.', matchedIdentifier: matched },
      ];
    },
  };
  app = await buildApp({
    storage,
    connectors: [gitpub, targ],
    chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })],
    now: FIXED_NOW,
  });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

const caseWithRun = async () => {
  const created = (await post('/api/cases', { name: 'Jan K.', identifiers: [{ type: 'nick', value: 'krypto_janek' }] })).json();
  const run = (await post(`/api/cases/${created.id}/runs`)).json();
  return { caseId: created.id as string, runId: run.id as string };
};

test('teczka analizy i sprawy: osoby, usługi, graf, sumy', async () => {
  const { caseId, runId } = await caseWithRun();
  const response = await app.inject(`/api/runs/${runId}/dossier`);
  assert.equal(response.statusCode, 200);
  const dossier = response.json();

  assert.equal(dossier.caseId, caseId);
  assert.equal(dossier.runId, runId);
  assert.equal(dossier.persons[0].fullName, 'Jan Kowalski');
  assert.deepEqual(dossier.subject.knownNames, ['Jan Kowalski']);
  // Ścieżka dojścia do odkrytego identyfikatora.
  assert.deepEqual(dossier.subject.identifiers[1], {
    identifier: { type: 'nick', value: 'janek_btc' },
    origin: 'discovered',
    sourceUrl: 'https://gitpub.example/krypto_janek',
    step: 1,
    via: { type: 'nick', value: 'krypto_janek' },
    followed: true,
  });
  const exchange = dossier.serviceLinks.find((link: { name: string }) => link.name === 'Giełda Testowa');
  assert.equal(exchange.outPln, 132000);
  assert.ok(dossier.serviceLinks.some((link: { name: string; basis: string[] }) => link.name === 'Kraken' && link.basis.includes('web_mention')));
  assert.deepEqual(dossier.totals.cashOutPlnByYear, { '2025': 132000 });
  assert.equal(dossier.totals.linkedAddresses, 1);
  assert.ok(dossier.totals.priority > 0);
  assert.ok(dossier.keyFindings.length >= 3);
  assert.ok(dossier.graph.nodes.length > 0 && dossier.timeline.length > 0);

  assert.deepEqual((await app.inject(`/api/cases/${caseId}/dossier`)).json(), dossier);
  assert.equal((await app.inject('/api/runs/brak/dossier')).statusCode, 404);
  const empty = (await post('/api/cases', { name: 'Pusta', identifiers: [{ type: 'nick', value: 'nikt' }] })).json();
  assert.equal((await app.inject(`/api/cases/${empty.id}/dossier`)).statusCode, 404);
});

test('decyzje analityka: zapis, wpływ na teczkę, usunięcie', async () => {
  const { caseId, runId } = await caseWithRun();
  const scoreOf = async () => (await app.inject(`/api/runs/${runId}/dossier`)).json().findings[0].confidence.score;
  assert.equal(await scoreOf(), 75);

  const created = await post(`/api/cases/${caseId}/decisions`, {
    target: 'profile',
    key: 'gitpub.example|krypto_janek',
    decision: 'confirmed',
    note: ' zgodny <script>alert(1)</script> telefon ',
  });
  assert.equal(created.statusCode, 201);
  const record = created.json();
  assert.deepEqual(
    { ...record, id: '' },
    {
      id: '',
      caseId,
      target: 'profile',
      key: 'gitpub.example|krypto_janek',
      decision: 'confirmed',
      note: 'zgodny <script>alert(1)</script> telefon',
      decidedAt: '2026-11-21T10:00:00.000Z',
      author: 'analityk',
    },
  );
  assert.deepEqual((await app.inject(`/api/cases/${caseId}/decisions`)).json(), [record]);
  // Kolejne pobranie teczki uwzględnia decyzję (pamięć podręczna jest unieważniana).
  assert.equal(await scoreOf(), 85);
  const dossier = (await app.inject(`/api/runs/${runId}/dossier`)).json();
  assert.equal(dossier.profiles[0].decision, 'confirmed');
  assert.equal(dossier.decisions.length, 1);
  // Zapisana analiza się nie zmienia.
  assert.equal((await app.inject(`/api/runs/${runId}`)).json().findings[0].confidence.score, 75);

  const report = (await app.inject(`/api/runs/${runId}/report.html`)).body;
  assert.ok(report.includes('Rejestr decyzji analityka'));
  assert.ok(report.includes('zgodny &lt;script&gt;alert(1)&lt;/script&gt; telefon'));
  assert.ok(!report.includes('<script>'));

  const removed = await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/decisions/${record.id}` });
  assert.equal(removed.statusCode, 204);
  assert.equal(await scoreOf(), 75);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/decisions/${record.id}` })).statusCode, 404);

  for (const payload of [{ target: 'osoba', key: 'x', decision: 'confirmed' }, { target: 'address', key: 'x', decision: 'może' }, { target: 'address', decision: 'rejected' }]) {
    assert.equal((await post(`/api/cases/${caseId}/decisions`, payload)).statusCode, 400);
  }
  assert.equal((await post('/api/cases/brak/decisions', { target: 'address', key: 'x', decision: 'rejected' })).statusCode, 404);
});

test('raport HTML z teczki: nowe sekcje i materiał do zapytania do usługi', async () => {
  const { runId } = await caseWithRun();
  const report = (await app.inject(`/api/runs/${runId}/report.html`)).body;
  for (const expected of [
    'Kluczowe ustalenia',
    'Priorytet sprawy:',
    'Ustalenie osoby',
    'Osoba główna: Jan Kowalski',
    'Powiązania z giełdami, portfelami i usługami',
    'Karta zapytania: Giełda Testowa',
    'Dane, po których usługa może odnaleźć konto klienta',
    'Profile i ocena tożsamości',
    'ścieżka dojścia',
    'Osoby powiązane',
    'Oś czasu',
    'Rejestr decyzji analityka',
    'Fakt źródłowy',
    'Wynik obliczeń',
    'Wniosek do weryfikacji',
  ]) {
    assert.ok(report.includes(expected), `raport powinien zawierać: ${expected}`);
  }
  assert.ok(!/<(script|link|img|iframe)\b/i.test(report));

  const request = await app.inject(`/api/runs/${runId}/service-request/gielda-testowa.html`);
  assert.equal(request.statusCode, 200);
  assert.match(request.headers['content-type'] as string, /text\/html/);
  assert.match(request.headers['content-security-policy'] as string, /default-src 'none'/);
  for (const expected of ['Materiał do zapytania do usługi Giełda Testowa', BTC_A, BTC_EXCHANGE, 'a'.repeat(64), 'materiał pomocniczy', 'Jan Kowalski']) {
    assert.ok(request.body.includes(expected), `materiał powinien zawierać: ${expected}`);
  }
  // Kwota z odstępem tysięcy (spacja nierozdzielająca).
  assert.match(request.body, /132\s000,00\szł/);
  assert.ok(!/<(script|link|img|iframe)\b/i.test(request.body));
  assert.equal((await app.inject(`/api/runs/${runId}/service-request/nie-ma.html`)).statusCode, 404);
});

test('dopisanie identyfikatorów do sprawy: bez powtórzeń, z walidacją', async () => {
  const { caseId } = await caseWithRun();
  const response = await post(`/api/cases/${caseId}/identifiers`, {
    identifiers: [
      { type: 'nick', value: ' janek_btc ' },
      { type: 'nick', value: 'Krypto_Janek' },
      { type: 'crypto_address', value: BTC_B },
    ],
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().query.identifiers, [
    { type: 'nick', value: 'krypto_janek' },
    { type: 'nick', value: 'janek_btc' },
    { type: 'crypto_address', value: BTC_B },
  ]);
  assert.equal(response.json().runs.length, 1);
  assert.equal((await post(`/api/cases/${caseId}/identifiers`, { identifiers: [{ type: 'crypto_address', value: 'zły-adres' }] })).statusCode, 400);
  assert.equal((await post(`/api/cases/${caseId}/identifiers`, { identifiers: [] })).statusCode, 400);
});

test('jedno wywołanie: rozpoznanie typu, sprawa, analiza i teczka', async () => {
  assert.equal(detectIdentifierType('jan.kowalski@poczta.example'), 'email');
  assert.equal(detectIdentifierType('https://gitpub.example/krypto_janek'), 'profile_url');
  assert.equal(detectIdentifierType(BTC_A), 'crypto_address');
  assert.equal(detectIdentifierType('janek.eth'), 'ens_name');
  assert.equal(detectIdentifierType('Jan Kowalski'), 'full_name');
  assert.equal(detectIdentifierType('krypto_janek'), 'nick');

  const response = await post('/api/quick', { value: ' jan.kowalski@poczta.example ' });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.deepEqual(body.case.query.identifiers, [{ type: 'email', value: 'jan.kowalski@poczta.example' }]);
  assert.equal(body.case.runs.length, 1);
  assert.equal(body.dossier.caseId, body.case.id);
  // Profil znaleziony po e-mailu: ustalenie osoby bez udziału analityka.
  assert.equal(body.dossier.persons[0].fullName, 'Jan Kowalski');
  assert.ok(body.dossier.persons[0].probability >= 90);
  assert.equal(body.dossier.findings[0].confidence.score, 85);
  assert.match(body.dossier.keyFindings[0].text, /^Najbardziej prawdopodobna osoba: Jan Kowalski — prawdopodobieństwo 9\d%/);

  // Typ można wymusić; pusty identyfikator jest błędem.
  const forced = (await post('/api/quick', { value: 'krypto_janek', type: 'login' })).json();
  assert.equal(forced.case.query.identifiers[0].type, 'login');
  assert.equal((await post('/api/quick', { value: '   ' })).statusCode, 400);
});

test('przegląd źródeł: ranking wytypowanych podmiotów i założenie sprawy', async () => {
  const response = await post('/api/sweeps', { limit: 5 });
  assert.equal(response.statusCode, 201);
  const sweep = response.json();
  assert.equal(sweep.status, 'completed');
  assert.equal(sweep.documentsScanned, 4);
  assert.deepEqual(sweep.connectors, ['gitpub', 'targ']);
  // Dokument bez autora i dokument bez adresu nie tworzą wskazań.
  assert.deepEqual(sweep.leads.map((lead: { handle: string }) => lead.handle), ['sprzedawca_dwa', 'sprzedawca_jeden']);
  const [first, second] = sweep.leads;
  assert.ok(first.priority >= second.priority);
  assert.equal(first.addresses.length, 2);
  assert.equal(first.topScore, 60);
  assert.equal(first.cashOutPlnTotal, 264000);
  assert.deepEqual(first.services, ['targ.example']);
  assert.deepEqual(first.profileUrls, ['https://targ.example/oferta/sprzedawca_dwa']);
  assert.ok(first.priorityReasons.length > 0);
  assert.ok(sweep.log.some((entry: { message: string }) => entry.message.includes('autorów 2')));

  assert.deepEqual((await app.inject(`/api/sweeps/${sweep.id}`)).json(), sweep);
  const listed = (await app.inject('/api/sweeps')).json().find((item: { id: string }) => item.id === sweep.id);
  assert.deepEqual(listed, { ...sweep, log: [] });

  // Sprawa z wytypowanego podmiotu: analiza z przeglądu jest od razu pierwszą analizą.
  const created = await post(`/api/sweeps/${sweep.id}/leads/${first.id}/case`);
  assert.equal(created.statusCode, 201);
  const summary = created.json();
  assert.deepEqual(summary.query.identifiers, [{ type: 'nick', value: 'sprzedawca_dwa' }]);
  assert.equal(summary.runs.length, 1);
  assert.deepEqual([summary.runs[0].status, summary.runs[0].findingCount, summary.runs[0].topScore], ['completed', 2, 60]);
  const dossier = (await app.inject(`/api/cases/${summary.id}/dossier`)).json();
  assert.equal(dossier.totals.priority, first.priority);
  assert.equal((await app.inject(`/api/runs/${summary.runs[0].id}/report.json`)).json().documents.length, 1);
  assert.equal((await app.inject(`/api/sweeps/${sweep.id}`)).json().leads[0].caseId, summary.id);
  // Powtórzenie nie zakłada drugiej sprawy.
  assert.equal((await post(`/api/sweeps/${sweep.id}/leads/${first.id}/case`)).json().id, summary.id);

  assert.equal((await post(`/api/sweeps/${sweep.id}/leads/brak/case`)).statusCode, 404);
  assert.equal((await app.inject('/api/sweeps/brak')).statusCode, 404);
  assert.equal((await post('/api/sweeps', { connectors: ['nie-ma'] })).statusCode, 400);
});

test('przegląd bez łącznika z metodą discover: pusty wynik z wpisem w dzienniku', async () => {
  const sweep = (await post('/api/sweeps', { connectors: ['gitpub'] })).json();
  assert.equal(sweep.status, 'completed');
  assert.deepEqual(sweep.leads, []);
  assert.equal(sweep.documentsScanned, 0);
  assert.match(sweep.log[0].message, /brak metody discover/);
});

test('zestawienie spraw i jawne reguły ocen', async () => {
  const overview = (await app.inject('/api/overview')).json();
  const cases = (await app.inject('/api/cases')).json();
  assert.equal(overview.cases, cases.length);
  assert.equal(overview.runs, cases.reduce((sum: number, item: { runs: unknown[] }) => sum + item.runs.length, 0));
  assert.ok(overview.linkedAddresses >= 3);
  assert.ok(overview.cashOutPlnByYear['2025'] >= 264000);
  assert.ok(overview.topCases.length > 0 && overview.topCases.length <= 10);
  const priorities = overview.topCases.map((item: { priority: number }) => item.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
  assert.deepEqual(Object.keys(overview.topCases[0]).sort(), ['caseId', 'cashOutPlnTotal', 'name', 'priority', 'topScore']);

  const rules = (await app.inject('/api/priority-rules')).json();
  assert.equal(rules.priority.formula, 'priorytet = 0,35·P + 0,30·S + 0,15·U + 0,10·A + 0,10·Z');
  const weights = Object.values(rules.priority.weights as Record<string, number>).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(weights - 1) < 1e-9);
  assert.equal(rules.persons.joinThreshold, 50);
  assert.equal(rules.services.base.transfer_out, 70);
  assert.equal(typeof rules.relations.shared_address, 'number');
});
