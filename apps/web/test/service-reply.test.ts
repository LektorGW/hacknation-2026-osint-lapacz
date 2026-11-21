// Odpowiedź usługi w interfejsie: walidacja formularza i wklejonego JSON po stronie przeglądarki oraz pełny
// przebieg w trybie DEMO (zapis → skutki w teczce → wycofanie) przez prawdziwy `demoBackend`, bez wyników wpisanych na sztywno.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Backend } from '../src/api.ts';
import { DEMO_CASE_ID } from '../src/demo-data.ts';
import type { FullDossier } from '../src/proof.ts';
import { bodyFromForm, emptyReplyForm, formFromSample, formHints, isExternalDocumentText, maskBankAccount, maskIdentifier, parseReplyJson } from '../src/service-reply.ts';

// `api.ts` czyta adres strony przy imporcie — w Node udajemy przeglądarkę w trybie demo, zanim załadujemy moduł.
(globalThis as { location?: unknown }).location ??= { search: '?demo=1' };
const { demoBackend } = (await import('../src/demo-backend.ts')) as { demoBackend: Backend };

const NOW = new Date('2026-11-21T10:00:00Z');
const service = { id: 'gielda-testowa', name: 'Giełda Testowa' };

test('formularz: pełne dane składają się w żądanie, a błędy są zdaniami dla analityka', () => {
  const form = {
    ...emptyReplyForm('2026-11-20'),
    reference: ' GT/2026/15 ',
    fullName: 'Jan Kowalski',
    identifier: '90010112345',
    emails: 'jan@poczta.example, jan@poczta.example',
    network: 'bitcoin',
    depositAddresses: 'bc1qadres\n',
    txids: 'aa\naa\nbb',
    payouts: '2025-03-15; 131 500,50; pln; PL61 1090 1014 0000 0712 1981 2874; aa',
  };
  const built = bodyFromForm(form, service, NOW);
  assert.ok(built.ok, JSON.stringify(built));
  assert.deepEqual(built.value.payload.matches, [
    { network: 'bitcoin', depositAddress: 'bc1qadres' },
    { network: 'bitcoin', txids: ['aa', 'bb'] },
  ]);
  assert.deepEqual(built.value.payload.fiatPayouts, [{ time: '2025-03-15T00:00:00.000Z', amount: 131_500.5, currency: 'PLN', bankAccount: 'PL61 1090 1014 0000 0712 1981 2874', relatedTxid: 'aa' }]);
  assert.deepEqual(built.value.payload.customer, { fullName: 'Jan Kowalski', identifierKind: 'PESEL', identifier: '90010112345', emails: ['jan@poczta.example'] });
  assert.deepEqual([built.value.serviceId, built.value.reference], ['gielda-testowa', 'GT/2026/15']);

  const bad = bodyFromForm({ ...emptyReplyForm('2027-06-01'), emails: 'nie-mail', payouts: 'wczoraj; 5; PLN\n2025-01-01; 0; PLN\n2025-01-01; 5; złote' }, service, NOW);
  assert.ok(!bad.ok);
  for (const pattern of [/sygnaturę/, /nie może być w przyszłości/, /Wypłata 1: niepoprawna data/, /Wypłata 2: kwota/, /Wypłata 3: podaj trzyliterowy kod waluty/, /nie wygląda na adres e-mail/]) {
    assert.ok(bad.errors.some((error) => pattern.test(error)), String(pattern));
  }
  const empty = bodyFromForm({ ...emptyReplyForm('2026-11-20'), reference: 'X/1' }, service, NOW);
  assert.ok(!empty.ok && /Odpowiedź jest pusta/.test(empty.errors[0]!));
  // Podpowiedzi uprzedzają, czego odpowiedź w tej postaci nie zmieni.
  assert.equal(formHints(emptyReplyForm()).length, 3);
  assert.deepEqual(formHints(form).map((hint) => /wypłat/.test(hint)), []);
});

test('wklejony JSON: sprawdzany przed wypełnieniem formularza; pełna odpowiedź i sam ładunek', () => {
  for (const [text, pattern] of [
    ['', /Wklej treść JSON/],
    ['{ nie json', /To nie jest poprawny JSON/],
    ['[1, 2]', /musi być obiektem/],
    ['{ "foo": 1 }', /Brak pól odpowiedzi/],
    ['{ "matches": [{ "network": "bitcoin" }] }', /adres wpłat albo co najmniej jedną transakcję/],
    ['{ "matches": "abc" }', /musi być listą/],
    ['{ "customer": { "identifierKind": "paszport" } }', /dozwolone wartości to PESEL, NIP, dokument, inne/],
    ['{ "fiatPayouts": [{ "time": "wczoraj", "amount": -1, "currency": "złote" }] }', /time: oczekiwana data/],
    ['{ "receivedAt": "kiedyś", "payload": { "note": "x" } }', /receivedAt: oczekiwana data/],
  ] as const) {
    const parsed = parseReplyJson(text);
    assert.ok(!parsed.ok && parsed.errors.some((error) => pattern.test(error)), text);
  }

  const full = parseReplyJson(
    JSON.stringify({
      syntetyczne: true,
      reference: 'SYNT/KYC/2025/0001',
      receivedAt: '2025-04-20T10:00:00.000Z',
      payload: { matches: [{ network: 'bitcoin', txids: ['aa', 'bb'] }], customer: { fullName: 'Rafał Kowalski', identifierMasked: '*******1234' }, fiatPayouts: [{ time: '2025-04-02T10:00:00Z', amount: 1000, currency: 'PLN' }] },
    }),
  );
  assert.ok(full.ok);
  const form = formFromSample(full.value, '2026-11-21');
  assert.deepEqual([form.reference, form.receivedAt, form.fullName, form.identifier, form.network, form.txids, form.synthetic], ['SYNT/KYC/2025/0001', '2025-04-20', 'Rafał Kowalski', '*******1234', 'bitcoin', 'aa\nbb', true]);
  assert.equal(form.payouts, '2025-04-02T10:00:00Z; 1000; PLN');
  // Formularz wypełniony z JSON składa się z powrotem w to samo żądanie.
  const rebuilt = bodyFromForm(form, service, NOW);
  assert.ok(rebuilt.ok);
  assert.deepEqual(rebuilt.value.payload.matches, [{ network: 'bitcoin', txids: ['aa', 'bb'] }]);
  assert.equal(rebuilt.value.payload.syntetyczne, true);

  const bare = parseReplyJson('{ "matches": [{ "txids": ["cc"] }] }');
  assert.ok(bare.ok && bare.value.payload.matches![0]!.txids![0] === 'cc' && bare.value.reference === undefined);
});

test('maskowanie w przeglądarce działa jak w usłudze analizy; znacznik dokumentu spoza OSINT', () => {
  assert.equal(maskIdentifier('90010112345'), '*******2345');
  assert.equal(maskIdentifier('*******2345'), '*******2345');
  assert.equal(maskBankAccount('PL61 1090 1014 0000 0712 1981 2874'), 'PL** **** 2874');
  assert.equal(isExternalDocumentText('Dokument spoza OSINT — odpowiedź usługi X'), true);
  assert.equal(isExternalDocumentText('Najbardziej prawdopodobna osoba: Jan'), false);
});

/** Teczka bez samego rejestru odpowiedzi — do porównania „przed” i „po wycofaniu”. */
const comparable = (dossier: FullDossier) => {
  const { serviceReplies: _replies, ...rest } = dossier;
  return JSON.parse(JSON.stringify(rest)) as unknown;
};

test('tryb DEMO: przykładowa odpowiedź zgodna z kandydatem potwierdza osobę i dokumentuje wyjście; wycofanie przywraca teczkę', async () => {
  const before = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  assert.deepEqual(before.serviceReplies, []);
  const link = before.serviceLinks.find((item) => item.transfers.some((transfer) => transfer.direction === 'out'))!;
  assert.ok(link, 'teczka demo ma usługę z wpłatami');

  const sample = await demoBackend.getServiceReplySample(DEMO_CASE_ID, link.id);
  assert.equal(sample.syntetyczne, true);
  const built = bodyFromForm(formFromSample(sample, '2026-11-21'), link, NOW);
  assert.ok(built.ok, JSON.stringify(built));
  const saved = await demoBackend.addServiceReply(DEMO_CASE_ID, built.value);
  await assert.rejects(demoBackend.addServiceReply(DEMO_CASE_ID, built.value), /jest już zapisana/);

  const after = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  const view = after.serviceReplies!.find((item) => item.id === saved.id)!;
  assert.deepEqual([view.layer, view.match.matched, view.identity.outcome, view.fiatExit.documented, view.withdrawn], ['external_document', true, 'confirmed', true, false]);
  const main = after.persons[0] as FullDossier['persons'][number] & { confirmedByReply?: { replyId: string } };
  assert.deepEqual([main.status, main.confirmedByReply?.replyId], ['confirmed', saved.id]);
  assert.match(main.reasons[0]!, new RegExp(`potwierdzone odpowiedzią usługi ${link.name}, sygn\\.`));
  const exits = after.indicators!.cashOut.filter((item) => item.stage === 'documented_fiat_exit');
  assert.ok(exits.length > 0, 'wskaźnik C na ostatnim szczeblu');
  assert.ok(exits.every((item) => item.indicator.components[0]!.evidence.some((ref) => ref.value === `reply:${saved.id}`)));
  assert.ok(after.graph.nodes.some((node) => node.id === `reply:${saved.id}` && node.kind === 'source'));
  assert.ok(after.graph.edges.some((edge) => edge.to === `reply:${saved.id}` && edge.kind === 'documented_by' && edge.status === 'confirmed'));
  assert.ok(after.keyFindings.some((item) => isExternalDocumentText(item.text)));

  await demoBackend.withdrawServiceReply(DEMO_CASE_ID, saved.id);
  const restored = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  assert.deepEqual(comparable(restored), comparable(before));
  assert.deepEqual(restored.serviceReplies!.map((item) => [item.id, item.withdrawn]), [[saved.id, true]]);
  await assert.rejects(demoBackend.withdrawServiceReply(DEMO_CASE_ID, saved.id));
});

test('tryb DEMO: konto innej osoby nie potwierdza kandydata i jest sprzecznością; odpowiedź bez wypłat nie daje ostatniego szczebla', async () => {
  const before = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  const link = before.serviceLinks.find((item) => item.transfers.some((transfer) => transfer.direction === 'out'))!;

  const other = await demoBackend.getServiceReplySample(DEMO_CASE_ID, link.id, 'inna-osoba');
  const otherBody = bodyFromForm(formFromSample(other, '2026-11-21'), link, NOW);
  assert.ok(otherBody.ok);
  const saved = await demoBackend.addServiceReply(DEMO_CASE_ID, otherBody.value);
  const after = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  const view = after.serviceReplies!.find((item) => item.id === saved.id)!;
  assert.equal(view.identity.outcome, 'other_person');
  assert.match(view.contradiction!, /^Sprzeczność: konto w usłudze/);
  const main = after.persons[0] as FullDossier['persons'][number] & { replyContradictions?: string[] };
  assert.deepEqual([main.status, main.probability], [before.persons[0]!.status, before.persons[0]!.probability]);
  assert.deepEqual(main.replyContradictions, [view.contradiction]);
  await demoBackend.withdrawServiceReply(DEMO_CASE_ID, saved.id);

  // Ta sama odpowiedź zgodna z kandydatem, ale bez wypłat: osoba potwierdzona, wskaźnik C bez zmian.
  const sample = await demoBackend.getServiceReplySample(DEMO_CASE_ID, link.id);
  const form = { ...formFromSample(sample, '2026-11-21'), reference: 'DEMO/BEZ-WYPLAT/1', payouts: '' };
  const noPayouts = bodyFromForm(form, link, NOW);
  assert.ok(noPayouts.ok);
  const kyc = await demoBackend.addServiceReply(DEMO_CASE_ID, noPayouts.value);
  const confirmed = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  assert.equal(confirmed.persons[0]!.status, 'confirmed');
  assert.deepEqual(
    confirmed.indicators!.cashOut.map((item) => [item.id, item.stage]),
    before.indicators!.cashOut.map((item) => [item.id, item.stage]),
  );
  await demoBackend.withdrawServiceReply(DEMO_CASE_ID, kyc.id);

  // Niedopasowana: zapisana, pokazana, niczego nie zmienia.
  const stray = await demoBackend.addServiceReply(DEMO_CASE_ID, { serviceName: link.name, serviceId: link.id, reference: 'DEMO/OBCA/1', receivedAt: '2026-11-20T00:00:00.000Z', payload: { matches: [{ txids: ['f'.repeat(64)] }], customer: { fullName: before.persons[0]!.fullName ?? 'X Y' }, fiatPayouts: [{ time: '2025-01-01T00:00:00.000Z', amount: 5, currency: 'PLN' }] } });
  const unchanged = (await demoBackend.getCaseDossier(DEMO_CASE_ID)) as FullDossier;
  assert.equal(unchanged.serviceReplies!.find((item) => item.id === stray.id)!.match.matched, false);
  assert.deepEqual(comparable(unchanged), comparable(before));
  await demoBackend.withdrawServiceReply(DEMO_CASE_ID, stray.id);
});
