import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { DEFAULT_RULES } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_EXCHANGE, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

const PROFILE = 'https://github.com/krypto_janek';
let app: FastifyInstance;
// Treść profilu zmienia się między analizami — tak testujemy porównywanie.
let currentAddress = BTC_B;

before(async () => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const github = fakeConnector('github', 'github.com', ['nick'], () => [
    {
      url: PROFILE,
      title: 'Profil <script>alert(1)</script>',
      text: `Donate: ${currentAddress}, giełda ${BTC_EXCHANGE}`,
      author: 'krypto_janek',
      publishedAt: '2025-01-01T00:00:00.000Z',
    },
    {
      url: PROFILE,
      title: 'Profil (archiwum)',
      text: `Donate: ${BTC_A}, giełda ${BTC_EXCHANGE}`,
      author: 'krypto_janek',
      archivedAt: '2024-01-05T12:00:00.000Z',
    },
  ]);
  const optional = { ...fakeConnector('dodatkowy', 'inne.example', ['nick'], () => []), enabledByDefault: false };
  app = await buildApp({
    storage,
    connectors: [github, optional],
    chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })],
    now: FIXED_NOW,
  });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const createCase = async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: 'Jan K.', identifiers: [{ type: 'nick', value: ' krypto_janek ' }] },
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string };
};

test('zdrowie, łączniki i reguły', async () => {
  assert.equal((await app.inject('/api/health')).json().status, 'ok');
  assert.deepEqual((await app.inject('/api/rules')).json(), DEFAULT_RULES);
  const connectors = (await app.inject('/api/connectors')).json();
  assert.deepEqual(connectors[0], {
    id: 'github',
    service: 'github.com',
    label: 'Atrapa github',
    description: 'Opis łącznika github',
    accepts: ['nick'],
    enabledByDefault: true,
  });
});

test('sprawa → analiza → raport HTML i pakiet JSON', async () => {
  const created = await createCase();

  const runResponse = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs` });
  assert.equal(runResponse.statusCode, 201);
  const run = runResponse.json();
  assert.equal(run.status, 'completed');
  // Bez wskazania łączników działają tylko domyślnie włączone.
  assert.deepEqual(run.connectors, ['github']);
  assert.deepEqual(run.findings.map((finding: { address: string }) => finding.address).sort(), [BTC_A, BTC_B, BTC_EXCHANGE].sort());
  assert.equal(run.findings.at(-1).address, BTC_EXCHANGE);

  assert.deepEqual((await app.inject(`/api/runs/${run.id}`)).json(), run);
  const summary = (await app.inject(`/api/cases/${created.id}`)).json();
  assert.equal(summary.query.identifiers[0].value, 'krypto_janek');
  assert.deepEqual(summary.runs, [
    { id: run.id, startedAt: '2026-11-21T10:00:00.000Z', status: 'completed', findingCount: 3, topScore: 75 },
  ]);
  assert.ok((await app.inject('/api/cases')).json().some((item: { id: string }) => item.id === created.id));

  const replacements = (await app.inject(`/api/runs/${run.id}/replacements`)).json();
  assert.equal(replacements.length, 1);
  assert.deepEqual([replacements[0].from, replacements[0].to], [BTC_A, BTC_B]);

  const report = await app.inject(`/api/runs/${run.id}/report.html`);
  assert.equal(report.statusCode, 200);
  assert.match(report.headers['content-type'] as string, /text\/html/);
  const html = report.body;
  for (const expected of [
    BTC_A,
    BTC_B,
    BTC_EXCHANGE,
    'Fakt źródłowy',
    'Wynik obliczeń',
    'Wniosek do weryfikacji',
    'Opis łącznika github',
    'Powód odrzucenia',
    'Podmiany adresów w czasie',
    'Rok podatkowy',
    'nie rozstrzygnięciem',
  ]) {
    assert.ok(html.includes(expected), `raport powinien zawierać: ${expected}`);
  }
  // Treść ze źródła nie może trafić do raportu jako działający znacznik.
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  // Raport jest samodzielny: żadnych zasobów zewnętrznych.
  assert.ok(!/<(script|link|img|iframe)\b/i.test(html));

  const bundle = (await app.inject(`/api/runs/${run.id}/report.json`)).json();
  assert.deepEqual(bundle.run, run);
  assert.deepEqual(bundle.rules, DEFAULT_RULES);
  assert.equal(typeof bundle.tool.version, 'string');
  assert.equal(bundle.documents.length, 2);
  assert.ok(bundle.documents.every((doc: { contentHash: string }) => /^[0-9a-f]{64}$/.test(doc.contentHash)));
});

test('porównanie dwóch analiz tej samej sprawy', async () => {
  const created = await createCase();
  currentAddress = BTC_B;
  const first = (await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: {} })).json();
  currentAddress = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';
  const second = (await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { connectors: ['github'] } })).json();
  currentAddress = BTC_B;

  const explicit = await app.inject(`/api/cases/${created.id}/diff?from=${first.id}&to=${second.id}`);
  assert.equal(explicit.statusCode, 200);
  const diff = explicit.json();
  assert.deepEqual(diff.removedAddresses, [BTC_B]);
  assert.deepEqual(diff.addedAddresses, ['0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe']);

  const other = await createCase();
  assert.equal((await app.inject(`/api/cases/${other.id}/diff`)).statusCode, 400);
  assert.equal((await app.inject(`/api/cases/${other.id}/diff?from=${first.id}&to=${second.id}`)).statusCode, 404);
});

test('błędne dane wejściowe i brakujące zasoby dają błąd po polsku', async () => {
  const invalid = [
    { name: 'Bez identyfikatorów', identifiers: [] },
    { name: 'Zły typ', identifiers: [{ type: 'pesel', value: '1' }] },
    { name: 'Zły adres', identifiers: [{ type: 'crypto_address', value: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb' }] },
    { identifiers: [{ type: 'nick', value: 'x' }] },
  ];
  for (const payload of invalid) {
    const response = await app.inject({ method: 'POST', url: '/api/cases', payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
    assert.equal(typeof response.json().error, 'string');
  }

  const created = await createCase();
  const unknownConnector = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/runs`, payload: { connectors: ['nie-ma'] } });
  assert.equal(unknownConnector.statusCode, 400);
  assert.match(unknownConnector.json().error, /Nieznane łączniki/);

  for (const url of ['/api/cases/brak', '/api/runs/brak', '/api/runs/brak/report.html', '/api/nic']) {
    const response = await app.inject(url);
    assert.equal(response.statusCode, 404, url);
    assert.equal(typeof response.json().error, 'string');
  }
});

test('harmonogram cyklicznych analiz: włączenie i wyłączenie', async () => {
  const created = await createCase();
  const scheduled = await app.inject({ method: 'POST', url: `/api/cases/${created.id}/schedule`, payload: { everyMinutes: 30 } });
  assert.deepEqual(scheduled.json().schedule, { everyMinutes: 30, nextRunAt: '2026-11-21T10:30:00.000Z' });
  assert.equal((await app.inject(`/api/cases/${created.id}`)).json().schedule.everyMinutes, 30);

  const removed = await app.inject({ method: 'DELETE', url: `/api/cases/${created.id}/schedule` });
  assert.equal(removed.json().schedule, undefined);
  assert.equal((await app.inject({ method: 'POST', url: `/api/cases/${created.id}/schedule`, payload: { everyMinutes: 0 } })).statusCode, 400);
});
