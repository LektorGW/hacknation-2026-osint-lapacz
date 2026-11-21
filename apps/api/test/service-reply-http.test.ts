// Trasy odpowiedzi usług na poziomie HTTP: walidacja, maskowanie po stronie serwera, skutki w teczce,
// wycofanie ze śladem audytowym oraz przykładowa odpowiedź z piaskownicy pobierana przez API.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp as buildSandbox } from '../../sandbox/src/app.ts';
import { buildApp } from '../src/app.ts';
import { cleanReplyPayload } from '../src/service-reply.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { BTC_A, BTC_EXCHANGE, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

let app: FastifyInstance;
let appWithoutSandbox: FastifyInstance;
/** Zapytania, które API wysłało do piaskownicy, i odpowiedź, którą atrapa ma zwrócić. */
const sandboxCalls: string[] = [];
let sandboxAnswer: { status: number; body: unknown } = { status: 200, body: {} };

const TXID = 'a'.repeat(64);
const PESEL = '90010112345';
const IBAN = 'PL61109010140000071219812874';

const gitpub = () =>
  fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [
          {
            url: 'https://gitpub.example/krypto_janek',
            author: 'krypto_janek',
            text: `Wsparcie: ${BTC_A}.`,
            profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', emails: ['jan.kowalski@poczta.example'] },
          },
        ]
      : [],
  );

before(async () => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  app = await buildApp({
    storage,
    connectors: [gitpub()],
    chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })],
    now: FIXED_NOW,
    sandboxUrl: 'http://piaskownica.test:4100',
    fetch: (async (input: string | URL | Request) => {
      sandboxCalls.push(String(input));
      return new Response(JSON.stringify(sandboxAnswer.body), { status: sandboxAnswer.status, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  });
  app.addHook('onClose', () => storage.close());
  const plain = createStorage(await createPgliteDriver());
  await plain.migrate();
  appWithoutSandbox = await buildApp({ storage: plain, connectors: [gitpub()], chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })], now: FIXED_NOW });
  appWithoutSandbox.addHook('onClose', () => plain.close());
});
after(async () => {
  await app.close();
  await appWithoutSandbox.close();
});

const post = (url: string, payload?: unknown, target: FastifyInstance = app) => target.inject({ method: 'POST', url, payload: payload as object });

const caseWithRun = async (target: FastifyInstance = app) => {
  const created = (await post('/api/cases', { name: 'Jan K.', identifiers: [{ type: 'nick', value: 'krypto_janek' }] }, target)).json();
  const run = (await post(`/api/cases/${created.id}/runs`, undefined, target)).json();
  return { caseId: created.id as string, runId: run.id as string };
};

const body = (extra: Record<string, unknown> = {}) => ({
  serviceName: 'Giełda Testowa',
  reference: 'GT/2026/15',
  receivedAt: '2026-11-20T12:00:00.000Z',
  payload: {
    matches: [{ network: 'bitcoin', depositAddress: BTC_EXCHANGE, txids: [TXID] }],
    customer: { fullName: 'Jan Kowalski', identifierKind: 'PESEL', identifier: PESEL, accountId: 'GT-1', emails: ['jan.kowalski@poczta.example'] },
    fiatPayouts: [{ time: '2025-03-15T09:00:00.000Z', amount: 131_500, currency: 'PLN', bankAccount: IBAN, relatedTxid: TXID }],
    note: 'odpowiedź na zapytanie z 2 listopada',
  },
  documentText: 'Treść pisma giełdy.',
  ...extra,
});

/** Teczka bez samego rejestru odpowiedzi — do porównania „przed” i „po wycofaniu”. */
const comparable = (dossier: Record<string, unknown>) => {
  const { serviceReplies: _replies, ...rest } = dossier;
  return rest;
};

test('zapis odpowiedzi: maskowanie po stronie serwera, skutki w teczce i raporcie, wycofanie przywraca wynik', async () => {
  const { caseId, runId } = await caseWithRun();
  const before = (await app.inject(`/api/runs/${runId}/dossier`)).json();
  assert.deepEqual(before.serviceReplies, []);
  assert.equal(before.persons[0].status, 'hypothesis');
  assert.deepEqual((await app.inject(`/api/cases/${caseId}/service-replies`)).json(), []);

  const created = await post(`/api/cases/${caseId}/service-replies`, body());
  assert.equal(created.statusCode, 201, created.body);
  const record = created.json();
  assert.deepEqual([record.serviceName, record.serviceId, record.reference, record.recordedBy, record.recordedAt], ['Giełda Testowa', before.serviceLinks[0].id, 'GT/2026/15', 'analityk', '2026-11-21T10:00:00.000Z']);
  // Pełny PESEL i numer rachunku nie trafiają ani do odpowiedzi, ani do bazy, ani do teczki; z treści dokumentu zostaje skrót.
  assert.deepEqual([record.payload.customer.identifierMasked, record.payload.customer.identifier], ['*******2345', undefined]);
  assert.deepEqual([record.payload.fiatPayouts[0].bankAccountMasked, record.payload.fiatPayouts[0].bankAccount], ['PL** **** 2874', undefined]);
  assert.match(record.payload.documentHash, /^[0-9a-f]{64}$/);
  const listed = await app.inject(`/api/cases/${caseId}/service-replies`);
  for (const secret of [PESEL, IBAN, 'Treść pisma giełdy']) assert.ok(!listed.body.includes(secret) && !created.body.includes(secret), secret);
  assert.deepEqual(listed.json().map((item: { id: string; withdrawnAt?: string }) => [item.id, item.withdrawnAt]), [[record.id, undefined]]);

  const dossierResponse = await app.inject(`/api/cases/${caseId}/dossier`);
  assert.ok(!dossierResponse.body.includes(PESEL) && !dossierResponse.body.includes(IBAN));
  const dossier = dossierResponse.json();
  assert.deepEqual([dossier.persons[0].status, dossier.persons[0].confirmedByReply.reference], ['confirmed', 'GT/2026/15']);
  assert.match(dossier.persons[0].reasons[0], /potwierdzone odpowiedzią usługi Giełda Testowa, sygn\. GT\/2026\/15/);
  const view = dossier.serviceReplies[0];
  assert.deepEqual([view.id, view.layer, view.match.matched, view.identity.outcome, view.fiatExit.documented], [record.id, 'external_document', true, 'confirmed', true]);
  const exit = dossier.indicators.cashOut.find((item: { address: string }) => item.address === BTC_A);
  assert.equal(exit.stage, 'documented_fiat_exit');
  assert.ok(exit.indicator.components.some((item: { rule: string; evidence: { value: string }[] }) => item.rule === 'cashout.documented_service_reply' && item.evidence.some((ref) => ref.value === `reply:${record.id}`)));
  assert.ok(dossier.graph.nodes.some((node: { id: string }) => node.id === `reply:${record.id}`));

  const report = await app.inject(`/api/runs/${runId}/report.html`);
  assert.ok(report.body.includes('Odpowiedzi usług (dokumenty spoza OSINT)') && report.body.includes('GT/2026/15') && !report.body.includes(PESEL));
  const bundle = (await app.inject(`/api/runs/${runId}/report.json`)).json();
  assert.equal(bundle.serviceReplies[0].id, record.id);

  // Ta sama sygnatura tej samej usługi drugi raz — konflikt, nie drugi wpis.
  assert.equal((await post(`/api/cases/${caseId}/service-replies`, body())).statusCode, 409);

  // Wycofanie: wynik wraca dokładnie do stanu sprzed odpowiedzi, wpis zostaje w rejestrze z autorem i czasem.
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/service-replies/${record.id}` })).statusCode, 204);
  const restored = (await app.inject(`/api/runs/${runId}/dossier`)).json();
  assert.deepEqual(comparable(restored), comparable(before));
  assert.deepEqual([restored.serviceReplies[0].withdrawn, restored.serviceReplies[0].withdrawnBy], [true, 'analityk']);
  const audit = (await app.inject(`/api/cases/${caseId}/service-replies`)).json();
  assert.deepEqual(audit.map((item: { id: string; withdrawnAt?: string; withdrawnBy?: string }) => [item.id, item.withdrawnAt, item.withdrawnBy]), [[record.id, '2026-11-21T10:00:00.000Z', 'analityk']]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/cases/${caseId}/service-replies/${record.id}` })).statusCode, 404);
  // Po wycofaniu poprawioną odpowiedź o tej samej sygnaturze można wprowadzić ponownie.
  assert.equal((await post(`/api/cases/${caseId}/service-replies`, body())).statusCode, 201);
});

test('walidacja: nieznana usługa, błędne daty i kwoty, limity, pola spoza schematu', async () => {
  const { caseId } = await caseWithRun();
  const url = `/api/cases/${caseId}/service-replies`;
  const error = async (payload: unknown) => {
    const response = await post(url, payload);
    return [response.statusCode, response.json().error as string] as const;
  };

  // Usługa spoza sprawy: odmowa z listą usług; z „force” zapis, ale bez wpływu na wynik (nic nie pasuje).
  const [status, message] = await error(body({ serviceName: 'Kantor Nieznany' }));
  assert.equal(status, 400);
  assert.match(message, /Usługa „Kantor Nieznany” nie występuje wśród usług powiązanych w tej sprawie \(Giełda Testowa\)/);
  const forced = await post(url, body({ serviceName: 'Kantor Nieznany', force: true, payload: { matches: [{ txids: ['b'.repeat(64)] }], customer: { fullName: 'Jan Kowalski' } } }));
  assert.equal(forced.statusCode, 201);
  const dossier = (await app.inject(`/api/cases/${caseId}/dossier`)).json();
  assert.deepEqual([dossier.serviceReplies[0].serviceKnown, dossier.serviceReplies[0].match.matched, dossier.persons[0].status], [false, false, 'hypothesis']);

  for (const [payload, pattern] of [
    [body({ reference: undefined }), /Nieprawidłowe dane wejściowe/],
    [body({ reference: '   ' }), /nie mogą być puste/],
    [body({ receivedAt: 'przedwczoraj' }), /nie jest poprawną datą otrzymania/],
    [body({ receivedAt: '2027-06-01T00:00:00.000Z' }), /nie może być w przyszłości/],
    [body({ payload: { matches: [{ network: 'bitcoin' }] } }), /adres wpłat albo co najmniej jedną transakcję/],
    [body({ payload: { fiatPayouts: [{ time: '2025-01-01', amount: 'dużo', currency: 'PLN' }] } }), /Nieprawidłowe dane wejściowe/],
    [body({ payload: { fiatPayouts: [{ time: '2025-01-01', amount: -5, currency: 'PLN' }] } }), /Nieprawidłowe dane wejściowe/],
    [body({ payload: { fiatPayouts: [{ time: '2025-01-01', amount: 5, currency: 'zł!' }] } }), /nie jest kodem waluty/],
    [body({ payload: { matches: Array.from({ length: 51 }, () => ({ txids: [TXID] })) } }), /Nieprawidłowe dane wejściowe/],
    [body({ payload: { customer: { fullName: 'Jan Kowalski', identifierKind: 'paszport' } } }), /Nieprawidłowe dane wejściowe/],
    [body({ payload: {} }), /Odpowiedź usługi jest pusta/],
    [body({ payload: { matches: [{ txids: [TXID] }], documentHash: 'xyz' } }), /SHA-256/],
  ] as const) {
    const [code, text] = await error(payload);
    assert.equal(code, 400, JSON.stringify(payload).slice(0, 120));
    assert.match(text, pattern);
  }

  // Pole spoza schematu (np. pełny PESEL pod własną nazwą) nie jest zapisywane.
  const extra = await post(url, body({ reference: 'GT/2026/16', payload: { matches: [{ txids: [TXID] }], customer: { fullName: 'Jan Kowalski', pesel: PESEL }, tajne: PESEL } }));
  assert.equal(extra.statusCode, 201, extra.body);
  assert.ok(!(await app.inject(url)).body.includes(PESEL));

  assert.equal((await app.inject('/api/cases/nie-ma/service-replies')).statusCode, 404);
  assert.equal((await post('/api/cases/nie-ma/service-replies', body())).statusCode, 404);
});

test('przykładowa odpowiedź z piaskownicy: tylko przez API, tylko przy skonfigurowanej piaskownicy i tylko oznaczona jako syntetyczna', async () => {
  const { caseId } = await caseWithRun();
  const url = `/api/cases/${caseId}/service-replies/sandbox-sample`;
  const sample = { syntetyczne: true, serviceName: 'Giełda Testowa', reference: 'SYNT/KYC/2025/0001', receivedAt: '2025-04-01T00:00:00.000Z', payload: { syntetyczne: true, matches: [{ txids: [TXID] }], fiatPayouts: [] } };

  sandboxAnswer = { status: 200, body: sample };
  sandboxCalls.length = 0;
  const response = await app.inject(`${url}?variant=inna-osoba`);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual([response.json().syntetyczne, response.json().reference, typeof response.json().serviceId], [true, 'SYNT/KYC/2025/0001', 'string']);
  // API samo wskazuje usługę i adres podmiotu z teczki; przeglądarka nie zna adresu piaskownicy.
  const called = new URL(sandboxCalls[0]!);
  assert.deepEqual(
    [called.origin, called.pathname, called.searchParams.get('usluga'), called.searchParams.get('adres'), called.searchParams.get('wariant')],
    ['http://piaskownica.test:4100', '/_demo/odpowiedz-gieldy', 'Giełda Testowa', BTC_A, 'inna-osoba'],
  );
  // Zwrócony ładunek da się od razu zapisać tą samą trasą co odpowiedź wpisaną ręcznie.
  const { serviceName, reference, receivedAt, payload } = response.json();
  assert.equal((await post(`/api/cases/${caseId}/service-replies`, { serviceName, reference, receivedAt, payload })).statusCode, 201);
  assert.equal((await app.inject(`/api/cases/${caseId}/dossier`)).json().serviceReplies[0].payload.syntetyczne, true);

  // Odpowiedź bez oznaczenia danych syntetycznych jest odrzucana; błąd piaskownicy nie udaje danych.
  sandboxAnswer = { status: 200, body: { ...sample, syntetyczne: false } };
  assert.equal((await app.inject(url)).statusCode, 424);
  sandboxAnswer = { status: 404, body: { error: 'W księdze piaskownicy nie ma wpłat z tego adresu.' } };
  const missing = await app.inject(url);
  assert.deepEqual([missing.statusCode, missing.json().error], [404, 'W księdze piaskownicy nie ma wpłat z tego adresu.']);
  assert.equal((await app.inject(`${url}?service=nieznana`)).statusCode, 404);
  assert.equal((await app.inject(`${url}?variant=cokolwiek`)).statusCode, 400);

  // Bez skonfigurowanej piaskownicy trasa nie działa.
  const other = await caseWithRun(appWithoutSandbox);
  const disabled = await appWithoutSandbox.inject(`/api/cases/${other.caseId}/service-replies/sandbox-sample`);
  assert.equal(disabled.statusCode, 404);
  assert.match(disabled.json().error, /tylko przy skonfigurowanej piaskownicy/);
});

test('piaskownica: syntetyczna odpowiedź giełdy dla wspólnego adresu Kowalskich przechodzi walidację API w obu wariantach', async () => {
  const sandbox = buildSandbox();
  const address = 'bc1q43zhzvxx00twnd5jlg7n4f9x42ped8u6wk2g98';
  const fetchSample = async (variant = '') => sandbox.inject(`/_demo/odpowiedz-gieldy?usluga=${encodeURIComponent('Giełda Bursztyn')}&adres=${address}${variant}`);
  const explorer = (await sandbox.inject(`/explorer/api/address/${address}`)).json() as { transfers: { txid: string; direction: string; counterpartyLabel?: string }[] };
  const deposits = explorer.transfers.filter((item) => item.direction === 'out' && /Bursztyn/.test(item.counterpartyLabel ?? '')).map((item) => item.txid);
  assert.equal(deposits.length, 3);

  const names: string[] = [];
  for (const variant of ['', '&wariant=inna-osoba']) {
    const response = await fetchSample(variant);
    assert.equal(response.statusCode, 200, response.body);
    const sample = response.json();
    assert.deepEqual([sample.syntetyczne, sample.payload.syntetyczne, sample.serviceName], [true, true, 'Giełda Bursztyn']);
    // Transakcje w odpowiedzi to dokładnie wpłaty widoczne w eksploratorze piaskownicy; każda ma wypłatę w złotych.
    assert.deepEqual(sample.payload.matches.flatMap((item: { txids: string[] }) => item.txids).sort(), [...deposits].sort());
    assert.deepEqual(sample.payload.fiatPayouts.map((item: { relatedTxid: string; currency: string }) => [item.relatedTxid, item.currency]).sort(), deposits.map((txid) => [txid, 'PLN']).sort());
    // Identyfikator klienta jest zamaskowany już w piaskownicy, a ładunek przechodzi walidację API bez zmian w treści.
    assert.match(sample.payload.customer.identifierMasked, /^\*{7}\d{4}$/);
    const cleaned = cleanReplyPayload(sample.payload, sample.documentText);
    assert.ok('payload' in cleaned);
    assert.deepEqual(cleaned.payload.matches, sample.payload.matches);
    assert.equal(cleaned.payload.customer?.fullName, sample.payload.customer.fullName);
    names.push(sample.payload.customer.fullName);
  }
  assert.deepEqual(names, ['Rafał Kowalski', 'Julia Kowalska']);
  assert.equal((await sandbox.inject('/_demo/odpowiedz-gieldy?usluga=x')).statusCode, 400);
  assert.equal((await sandbox.inject(`/_demo/odpowiedz-gieldy?usluga=Nieznana&adres=${address}`)).statusCode, 404);
  await sandbox.close();
});
