import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutTrail } from '@olcys/core';
import { buildChain, progressView, proofSummary, proofTier, sortProofs } from '../src/proof.ts';
import type { CashOutProof, RunProgress } from '../src/proof.ts';

const progress = (change: Partial<RunProgress>): RunProgress => ({
  status: 'running',
  stage: 'search',
  connectorsDone: 0,
  connectorsTotal: 0,
  documents: 0,
  addresses: 0,
  ...change,
});

test('postęp: etap wyszukiwania liczony z liczników źródeł', () => {
  const start = progressView(progress({}));
  assert.equal(start.percent, 0);
  assert.equal(start.current, 0);
  assert.equal(start.steps[0]!.state, 'active');
  assert.ok(start.steps.slice(1).every((step) => step.state === 'pending'));

  const half = progressView(progress({ connectorsDone: 200, connectorsTotal: 400, documents: 37 }));
  assert.ok(half.percent > 0 && half.percent < 45);
  assert.equal(half.steps[0]!.detail, '200 z 400 źródeł · dokumenty: 37');

  const over = progressView(progress({ connectorsDone: 500, connectorsTotal: 400 }));
  assert.equal(over.percent, 45);
});

test('postęp: kolejne etapy przesuwają pasek monotonicznie aż do 100%', () => {
  const stages = ['search', 'occurrences', 'chain', 'counterparties', 'scoring', 'ai', 'saving', 'done'] as const;
  const views = stages.map((stage) => progressView(progress({ stage, connectorsDone: 6, connectorsTotal: 6, addresses: 3 })));
  for (let index = 1; index < views.length; index += 1) {
    assert.ok(views[index]!.percent >= views[index - 1]!.percent, stages[index]);
    assert.ok(views[index]!.current > views[index - 1]!.current, stages[index]);
  }
  assert.equal(views.at(-1)!.percent, 100);
  assert.ok(views.at(-1)!.steps.every((step) => step.state === 'done'));
  const chain = views[2]!;
  assert.deepEqual(chain.steps.map((step) => step.state).slice(0, 4), ['done', 'done', 'active', 'pending']);
  assert.equal(chain.steps[1]!.detail, 'adresy: 3');
});

test('postęp: zakończenie, błąd i nieznany etap', () => {
  assert.equal(progressView(progress({ status: 'completed', stage: 'saving' })).percent, 100);
  const failed = progressView(progress({ status: 'failed', stage: 'failed', error: 'limit' }));
  assert.equal(failed.failed, true);
  assert.equal(failed.current, 0);
  const unknown = progressView(progress({ stage: 'nowy-etap' as RunProgress['stage'] }));
  assert.equal(unknown.current, 0);
  assert.equal(unknown.failed, false);
});

const trail = (hops: CashOutTrail['hops'], valuePln?: number): CashOutTrail => ({
  id: 't',
  sourceAddress: 'adres-osoby',
  network: 'bitcoin',
  hops,
  serviceName: 'Giełda Testowa',
  serviceKind: 'exchange_deposit',
  asset: 'BTC',
  amount: 1,
  valuePln,
  confidence: 90,
  reasons: [],
  openQuestions: [],
});

const hop = (from: string, to: string, extra: Partial<CashOutTrail['hops'][number]> = {}): CashOutTrail['hops'][number] => ({
  txid: `${from}>${to}`,
  time: '2026-01-01T00:00:00Z',
  from,
  to,
  asset: 'BTC',
  amount: 1,
  explorerUrl: 'http://localhost/tx',
  ...extra,
});

test('łańcuch kroków: role adresów, etykieta usługi i kroki wnioskowane', () => {
  const direct = buildChain(trail([hop('adres-osoby', 'gielda', { toLabel: 'Giełda Testowa: Hot Wallet' })]));
  assert.deepEqual(direct.source, { address: 'adres-osoby', role: 'source' });
  assert.equal(direct.steps.length, 1);
  assert.deepEqual(direct.steps[0]!.to, { address: 'gielda', role: 'service', label: 'Giełda Testowa: Hot Wallet' });
  assert.equal(direct.steps[0]!.inferred, false);

  const long = buildChain(
    trail([hop('adres-osoby', 'posredni'), hop('posredni', 'zbiorczy', { reason: 'adres przelotowy' }), hop('zbiorczy', 'gielda', { inferred: true, reason: 'wzorzec' })]),
  );
  assert.deepEqual(long.steps.map((step) => step.to.role), ['intermediate', 'intermediate', 'service']);
  assert.deepEqual(long.steps.map((step) => step.inferred), [false, false, true]);
  // Ostatni krok bez etykiety adresu dostaje nazwę usługi ze ścieżki.
  assert.equal(long.steps[2]!.to.label, 'Giełda Testowa');
  assert.equal(long.steps[0]!.to.label, undefined);
  assert.equal(long.steps[2]!.reason, 'wzorzec');
  assert.deepEqual(buildChain(trail([])).steps, []);
});

const proof = (id: string, combinedConfidence: number, serviceName: string, valuePln?: number): CashOutProof => ({
  id,
  person: null,
  address: 'adres-osoby',
  network: 'bitcoin',
  addressBasis: 'published',
  personAddressProbability: 100,
  trailConfidence: combinedConfidence,
  combinedConfidence,
  tier: proofTier(combinedConfidence),
  components: [],
  layer: 'calculation',
  serviceName,
  statement: id,
  trail: trail([hop('adres-osoby', 'gielda')], valuePln),
});

test('ustalenia: kolejność po łącznej pewności i podsumowanie', () => {
  const proofs = [proof('a', 52, 'Giełda A', 1000), proof('b', 80, 'Giełda B'), proof('c', 52, 'Giełda A', 5000), proof('d', 20, 'Kantor', 300)];
  assert.deepEqual(sortProofs(proofs).map((item) => item.id), ['b', 'c', 'a', 'd']);
  const summary = proofSummary(proofs);
  assert.equal(summary.totalPln, 6300);
  assert.equal(summary.unvalued, 1);
  assert.deepEqual(summary.services, ['Giełda A', 'Giełda B', 'Kantor']);
  assert.equal(summary.topConfidence, 80);
  assert.equal(summary.strongest!.id, 'b');
  assert.deepEqual(proofSummary([]), { totalPln: 0, unvalued: 0, services: [], topConfidence: 0, strongest: undefined });
});

test('poziomy łącznej pewności', () => {
  assert.deepEqual([95, 80, 79, 60, 52, 40, 39, 0].map(proofTier), ['bardzo wysoka', 'bardzo wysoka', 'wysoka', 'wysoka', 'średnia', 'średnia', 'niska', 'niska']);
});

test('sugestie z wyjaśnień: rozpoznanie działania po treści zdania', async () => {
  const { suggestionAction } = await import('../src/proof.ts');
  assert.equal(suggestionAction('Uruchom tryb głęboki, żeby poszukać kolejnych publikacji.'), 'deep');
  assert.equal(suggestionAction('Powtórz analizę w trybie głębokim.'), 'deep');
  assert.equal(suggestionAction('Potwierdź adres, jeśli wiesz, że należy do podmiotu.'), 'confirm');
  assert.equal(suggestionAction('Podaj identyfikator osoby (nick, e-mail, adres profilu), a nie nazwę usługi.'), 'add_identifier');
  assert.equal(suggestionAction('Dodaj drugi identyfikator: e-mail albo adres profilu.'), 'add_identifier');
  assert.equal(suggestionAction('Zapytaj operatora giełdy o dane klienta.'), null);
});

test('ustalenia warunkowe są oddzielone i sortowane po pewności po potwierdzeniu', async () => {
  const { splitProofs } = await import('../src/proof.ts');
  const proofs = [
    proof('pewne-niskie', 30, 'A'),
    { ...proof('warunkowe-slabe', 10, 'B'), ownerUnconfirmed: true, confidenceIfConfirmed: 60 },
    proof('pewne-wysokie', 90, 'A'),
    { ...proof('warunkowe-mocne', 5, 'C'), ownerUnconfirmed: true, confidenceIfConfirmed: 95 },
  ];
  const { firm, conditional } = splitProofs(proofs);
  assert.deepEqual(firm.map((item) => item.id), ['pewne-wysokie', 'pewne-niskie']);
  assert.deepEqual(conditional.map((item) => item.id), ['warunkowe-mocne', 'warunkowe-slabe']);
});

test('okres analizy: czyszczenie pól, błąd kolejności i opis', async () => {
  const { cleanPeriod, periodLabel } = await import('../src/proof.ts');
  assert.deepEqual(cleanPeriod('', ''), {});
  assert.deepEqual(cleanPeriod('2025-01-01', ''), { period: { from: '2025-01-01' } });
  assert.deepEqual(cleanPeriod('2025-01-01', '2025-12-31'), { period: { from: '2025-01-01', to: '2025-12-31' } });
  assert.ok(cleanPeriod('2026-01-01', '2025-12-31').error);
  assert.equal(periodLabel(undefined), undefined);
  assert.equal(periodLabel({}), undefined);
  assert.equal(periodLabel({ from: '2025-01-01T00:00:00Z', to: '2025-12-31' }), '2025-01-01 – 2025-12-31');
  assert.equal(periodLabel({ to: '2025-12-31' }), 'do 2025-12-31');
});

test('stronicowanie długich list', async () => {
  const { paginate } = await import('../src/proof.ts');
  const items = Array.from({ length: 841 }, (_, index) => index);
  assert.equal(paginate(items, 1, 50).pages, 17);
  assert.deepEqual(paginate(items, 17, 50).items, items.slice(800));
  assert.equal(paginate(items, 99, 50).page, 17);
  assert.equal(paginate(items, 0, 50).page, 1);
  assert.deepEqual(paginate([], 3, 50), { items: [], page: 1, pages: 1 });
});

test('powiązane tożsamości: kolejność, skrót, identyfikatory nowej sprawy i druga suma', async () => {
  const { basisText, explorerForTxid, identityHeadline, identityIdentifiers, isAddressLead, likelySameTotal, sortIdentities } = await import('../src/identities.ts');
  type Identity = Parameters<typeof isAddressLead>[0];
  const identity = (id: string, score: number, change: Partial<Identity> = {}): Identity => ({
    id,
    displayName: id,
    handles: [id],
    relation: 'possibly_same_or_close',
    score,
    reasons: [],
    profiles: [{ id: `s|${id}`, service: 's.example', url: `https://s.example/u/${id}`, attributes: {}, identityMatch: 'linked_profile', identityReasons: [], identityScore: 0, addresses: [], evidenceIds: [] }],
    addresses: [],
    cashOutPlnByYear: {},
    cashOutProof: [],
    path: [],
    note: '',
    mergeWith: [],
    ...change,
  });
  const list = [
    identity('slaba', 40),
    identity('odrzucona', 95, { decision: 'rejected' }),
    identity('julia', 85, { relation: 'same_person_likely', fullName: 'Julia Kowalska' }),
    identity('trop', 90, { profiles: [], handles: [], addresses: [{ address: 'bc1qtrop', network: 'bitcoin', basis: 'linked:transfer' }] }),
  ];
  assert.deepEqual(sortIdentities(list).map((item) => item.id), ['trop', 'julia', 'slaba', 'odrzucona']);
  assert.deepEqual(identityHeadline(list), ['julia — hipoteza: możliwy wspólny operator — mocne przesłanki (85)', 'slaba — hipoteza: możliwy wspólny operator albo osoba bliska (40)']);
  assert.equal(isAddressLead(list[3]!), true);
  assert.deepEqual(identityIdentifiers(list[2]!), [
    { type: 'full_name', value: 'Julia Kowalska' },
    { type: 'nick', value: 'julia' },
    { type: 'profile_url', value: 'https://s.example/u/julia' },
  ]);
  assert.deepEqual(identityIdentifiers(list[3]!), [{ type: 'crypto_address', value: 'bc1qtrop' }]);

  assert.equal(likelySameTotal({ cashOutPlnByYear: { '2025': 100 }, cashOutPlnTotalWithLikelySame: 150 }), 150);
  assert.equal(likelySameTotal({ cashOutPlnByYear: { '2025': 100 }, cashOutPlnTotal: 100, cashOutPlnTotalWithLikelySame: 100.2 }), undefined);
  assert.equal(likelySameTotal({ cashOutPlnByYear: { '2025': 100 } }), undefined);

  assert.equal(basisText('published'), 'opublikowany jako własny');
  assert.equal(basisText('linked:shared_deposit'), 'wskazany przez dane blockchain: wspólny adres wpłat giełdy');
  assert.equal(basisText('linked:nowy_rodzaj'), 'wskazany przez dane blockchain: nowy_rodzaj');
  assert.equal(explorerForTxid([], 'abc'), undefined);
});
