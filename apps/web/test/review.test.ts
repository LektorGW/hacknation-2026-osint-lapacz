// Kolejka „Do potwierdzenia”: zbieranie pozycji z teczki demo (prawdziwy `demoBackend`), kolejność ważności,
// rozdział na oczekujące i zdecydowane oraz cele i klucze decyzji zgodne z kartami teczki.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Backend } from '../src/api.ts';
import { DEMO_CASE_ID } from '../src/demo-data.ts';
import type { FullDossier } from '../src/proof.ts';

// `api.ts` czyta adres strony przy imporcie — w Node udajemy przeglądarkę w trybie demo, zanim załadujemy moduł.
(globalThis as { location?: unknown }).location ??= { search: '?demo=1' };
const { demoBackend } = (await import('../src/demo-backend.ts')) as { demoBackend: Backend };
const { REVIEW_KIND_ORDER, collectReview, countByKind, decisionNote, isReviewOnly, knownPending, pendingCount, rememberPending } = await import('../src/review.ts');

const load = async (caseId = DEMO_CASE_ID) => (await demoBackend.getCaseDossier(caseId)) as FullDossier;
const addressKeyOf = (item: { network: string; address: string }) => `${item.network}:${item.address}`;

test('teczka demo: kolejka zbiera wypłaty, osobę, adresy, tożsamości i hipotezy operatora', async () => {
  const { pending, decided } = collectReview(await load());
  const kinds = new Set(pending.map((item) => item.kind));
  for (const kind of ['cashout', 'person', 'address', 'identity', 'operator'] as const) assert.ok(kinds.has(kind), `brak rodzaju ${kind}`);
  assert.equal(decided.length, 0, 'bez decyzji nic nie jest zdecydowane');
  for (const item of pending) {
    assert.ok(item.title.endsWith('?'), `tytuł to pytanie: ${item.title}`);
    assert.ok(item.why.length > 10, 'jest „Dlaczego to ważne”');
    assert.ok(item.evidence.length <= 3, 'najwyżej trzy ślady');
    assert.ok(item.confirmEffect.length > 0);
  }
  const counts = countByKind(pending);
  assert.equal(Object.values(counts).reduce((total, value) => total + (value ?? 0), 0), pending.length);
  assert.equal(pendingCount(await load()), pending.length);
});

test('kolejność: najpierw pieniądze, potem osoba, adresy, tożsamości, operatorzy; w rodzaju — od największej kwoty', async () => {
  const { pending } = collectReview(await load());
  const ranks = pending.map((item) => REVIEW_KIND_ORDER.indexOf(item.kind));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(pending[0]!.kind, 'cashout');
  const cash = pending.filter((item) => item.kind === 'cashout').map((item) => item.valuePln ?? 0);
  assert.deepEqual(cash, [...cash].sort((a, b) => b - a));
  assert.match(pending[0]!.title, /^Czy masz dokument wypłaty z adresu .+ przez .+\?$/);
  const person = pending.find((item) => item.kind === 'person')!;
  assert.match(person.title, /^Czy Tomasz Wzorcowy to osoba, której dotyczy sprawa\?$/);
});

test('cele i klucze decyzji zgadzają się z kartami teczki', async () => {
  const dossier = await load();
  const { pending } = collectReview(dossier);
  for (const item of pending.filter((entry) => entry.kind === 'cashout')) {
    assert.equal(item.noteRequired, true, 'udokumentowanie wypłaty wymaga podstawy w notatce');
    assert.deepEqual(item.confirm, item.reject);
    assert.equal(item.confirm[0]!.target, 'cashout');
    assert.ok(dossier.findings.some((finding) => addressKeyOf(finding) === item.confirm[0]!.key), 'klucz `cashout` to `sieć:adres` adresu sprawy');
  }
  const person = pending.find((item) => item.kind === 'person')!;
  assert.deepEqual(person.confirm.map((call) => call.key), dossier.persons[0]!.profileIds);
  assert.ok(person.confirm.every((call) => call.target === 'profile'));
  for (const item of pending.filter((entry) => entry.kind === 'address')) {
    assert.deepEqual(item.reject, [{ target: 'address', key: item.id.slice('address:'.length) }]);
  }
  for (const item of pending.filter((entry) => entry.kind === 'identity')) {
    const identity = (dossier.linkedIdentities ?? []).find((entry) => item.id === `identity:${entry.id}`)!;
    assert.deepEqual(item.confirm, identity.mergeWith, 'potwierdzenie tożsamości wysyła `mergeWith` z usługi');
  }
  const operators = dossier.indicators?.commonOperator ?? [];
  for (const item of pending.filter((entry) => entry.kind === 'operator')) {
    const hypothesis = operators.find((entry) => item.id === `operator:${entry.id}`)!;
    assert.deepEqual(item.confirm, [{ target: 'link', key: hypothesis.id }]);
    assert.notEqual(hypothesis.status, 'auto_grouped', 'pary połączone w osobie głównej rozstrzyga pozycja „Osoba”');
  }
});

test('decyzja przenosi pozycję do „Zdecydowane”, a cofnięcie przywraca ją do kolejki', async () => {
  const before = collectReview(await load());
  const target = before.pending.find((item) => item.kind === 'cashout')!;
  const call = target.confirm[0]!;
  const created = await demoBackend.addDecision(DEMO_CASE_ID, { ...call, decision: 'confirmed', note: decisionNote(target, 'confirmed', 'pismo giełdy z 12.11.2026') });
  const after = collectReview(await load());
  assert.ok(!after.pending.some((item) => item.id === target.id), 'rozstrzygnięta pozycja znika z kolejki');
  const entry = after.decided.find((item) => item.decisionId === created.id)!;
  assert.ok(entry, 'decyzja jest na liście „Zdecydowane”');
  assert.equal(entry.decision, 'confirmed');
  assert.equal(entry.note, 'pismo giełdy z 12.11.2026');
  assert.match(entry.label, /^Wypłata z adresu /);
  await demoBackend.removeDecision(DEMO_CASE_ID, created.id);
  const restored = collectReview(await load());
  assert.ok(restored.pending.some((item) => item.id === target.id), 'po cofnięciu pozycja wraca');
  assert.ok(!restored.decided.some((item) => item.decisionId === created.id), 'wycofana decyzja nie jest „zdecydowana”');
});

test('osoba: potwierdzone konto zamyka pytanie o osobę; częściowe odrzucenie zostawia je z pozostałymi kontami', () => {
  const base = { persons: [{ id: 'o1', fullName: 'Jan Próbny', probability: 70, status: 'hypothesis', profileIds: ['a|x', 'b|y'], reasons: [] }], decisions: [] as unknown[] };
  const decision = (key: string, value: 'confirmed' | 'rejected') => ({ id: `d-${key}`, caseId: 'c', target: 'profile', key, decision: value, decidedAt: '2026-11-21T10:00:00Z' });
  assert.equal(collectReview(base).pending.length, 1);
  assert.equal(collectReview({ ...base, decisions: [decision('a|x', 'confirmed')] }).pending.length, 0);
  const partial = collectReview({ ...base, decisions: [decision('a|x', 'rejected')] }).pending;
  assert.deepEqual(partial[0]!.confirm, [{ target: 'profile', key: 'b|y' }]);
  assert.equal(collectReview({ ...base, decisions: [decision('a|x', 'rejected'), decision('b|y', 'rejected')] }).pending.length, 0);
  assert.equal(collectReview({ ...base, persons: [{ ...base.persons[0]!, status: 'confirmed' }] }).pending.length, 0);
});

test('adres niepotwierdzony: potwierdzenie wysyła `confirmWith`, odrzucenie — sam adres; kwota trafia do pytania', () => {
  const dossier = {
    persons: [{ id: 'o1', fullName: 'Anna Testowa', probability: 90, status: 'confirmed', profileIds: [] }],
    unconfirmedAddresses: [
      {
        address: 'bc1qtestowyadres0000000000000000000k0ze',
        network: 'bitcoin',
        sources: [{ url: 'https://forum.example/post/1', service: 'forum.example', author: 'anna' }],
        reasons: ['adres w podpisie'],
        personAddressProbability: 52,
        chain: { transfers: 3, totalReceived: 1, totalSent: 1, asset: 'BTC', services: ['Giełda'], cashOutPlnTotal: 12000, trails: 1 },
        confirmWith: [
          { target: 'profile', key: 'forum.example|anna' },
          { target: 'address', key: 'bitcoin:bc1qtestowyadres0000000000000000000k0ze' },
        ],
      },
    ],
  };
  const [item] = collectReview(dossier).pending;
  assert.equal(item!.kind, 'address');
  assert.match(item!.title, /^Czy Anna Testowa jest właścicielem adresu bc1qte…k0ze\?$/);
  assert.equal(item!.confirm.length, 2);
  assert.deepEqual(item!.reject, [{ target: 'address', key: 'bitcoin:bc1qtestowyadres0000000000000000000k0ze' }]);
  assert.equal(item!.valuePln, 12000);
  assert.match(item!.confirmEffect, /doliczy adres do sum i dowodu spieniężenia/);
  assert.deepEqual(item!.evidence, [{ label: 'forum.example (anna)', url: 'https://forum.example/post/1' }]);
});

test('organizacje, osoba publiczna, słabe ostrzeżenia i niedopasowane odpowiedzi usług to pozycje do sprawdzenia', () => {
  const dossier = {
    organizations: [{ name: 'Fundacja Przykład', role: 'beneficjent zbiórki', addresses: ['bitcoin:bc1qfundacja000000000000000000000000abcd'], indicator: 45, components: [], evidence: [], status: 'hypothesis' }],
    publicFigure: { name: 'Jan Znany', role: 'poseł', url: 'https://pl.wikipedia.org/wiki/Jan_Znany', score: 35 },
    scamWarnings: [{ url: 'https://ostrzezenia.example/1', weak: true, address: 'bc1qfundacja000000000000000000000000abcd' }, { url: 'https://ostrzezenia.example/2', score: 90 }],
    serviceReplies: [
      { id: 'r1', serviceName: 'Giełda X', reference: 'ZW/1', withdrawn: false, match: { matched: false, addresses: [], text: 'Żaden adres nie pasuje.' } },
      { id: 'r2', serviceName: 'Giełda Y', reference: 'ZW/2', withdrawn: false, match: { matched: true, addresses: [], text: '' } },
    ],
  };
  const { pending } = collectReview(dossier);
  assert.deepEqual(
    pending.map((item) => item.kind),
    ['organization', 'public_figure', 'scam_warning', 'reply'],
  );
  assert.ok(pending.every(isReviewOnly), 'usługa nie zapisuje takich decyzji — kolejka niczego nie wymyśla');
  assert.equal(pending.find((item) => item.kind === 'reply')!.tab, 'uslugi');
  // Osoba publiczna z wywołaniem decyzji od usługi — przyciski działają.
  const withCalls = collectReview({ publicFigure: { name: 'Jan Znany', confirmWith: [{ target: 'profile', key: 'wiki|jan' }] } }).pending[0]!;
  assert.deepEqual(withCalls.confirm, [{ target: 'profile', key: 'wiki|jan' }]);
});

test('dane niepełne albo nieoczekiwane nie psują kolejki', () => {
  for (const input of [null, undefined, 42, 'teczka', [], {}, { persons: 'x', findings: [null, 1], indicators: { cashOut: [{}], commonOperator: [{ status: 'hypothesis' }] }, decisions: [{}] }]) {
    assert.deepEqual(collectReview(input), { pending: [], decided: [] });
  }
});

test('notatka: wpis analityka ma pierwszeństwo, bez niego — notatka z kart teczki', () => {
  const item = { confirmNote: 'Potwierdzono własność adresu', rejectNote: 'To nie jest adres tej osoby' };
  assert.equal(decisionNote(item, 'confirmed', '  '), 'Potwierdzono własność adresu');
  assert.equal(decisionNote(item, 'rejected', ''), 'To nie jest adres tej osoby');
  assert.equal(decisionNote(item, 'confirmed', ' własna notatka '), 'własna notatka');
});

test('licznik na liście spraw: znany tylko po wczytaniu teczki', () => {
  assert.equal(knownPending('sprawa-niewczytana'), undefined);
  rememberPending('sprawa-a', 4);
  assert.equal(knownPending('sprawa-a'), 4);
  rememberPending('sprawa-a', 0);
  assert.equal(knownPending('sprawa-a'), 0);
});
