// Odpowiedź usługi (dokument spoza OSINT) zamyka łańcuch „osoba → adres → usługa → potwierdzony właściciel konta
// i wypłata na rachunek”. Wszystko liczy `runAnalysis` i `buildDossier` na danych syntetycznych — bez wyników
// wpisanych na sztywno. Osoby fikcyjne: Jacek Kowalski (podmiot) i Julia Żołądź (powiązana tożsamość).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES } from '@olcys/core';
import type { CashOutTrail } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { renderReportHtml } from '../src/report.ts';
import { SERVICE_REPLY_LABEL, cleanReplyPayload, maskBankAccount, maskIdentifier, sameFullName, sameSurname } from '../src/service-reply.ts';
import type { ServiceReply, ServiceReplyInput } from '../src/service-reply.ts';
import type { CaseSummary } from '../src/storage.ts';
import { BTC_A, ETH_A, cashOut, chainWith, decision, dossierOf, fakeConnector, run, transfer } from './helpers.ts';

const ETH_JULIA = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const MAIL = 'jacek.kowalski@poczta.example';
const JULIA = 'targ.example|julia_zoladz';

const query = { identifiers: [{ type: 'nick' as const, value: 'jacek_k_btc' }] };
const caseSummary: CaseSummary = { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [] };

const sources = () => [
  fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'jacek_k_btc'
      ? [
          {
            url: 'https://gitpub.example/jacek_k_btc',
            author: 'jacek_k_btc',
            text: `Jacek Kowalski — programista. Wsparcie: BTC ${BTC_A}, ETH ${ETH_A}.`,
            profile: { handle: 'jacek_k_btc', displayName: 'Jacek Kowalski', emails: [MAIL], location: 'Bydgoszcz' },
          },
        ]
      : [],
  ),
  // Julia: inne nazwisko, własny adres, ale ten sam e-mail kontaktowy co Jacek — powiązana tożsamość.
  fakeConnector('targ', 'targ.example', ['email'], (identifier) =>
    identifier.value === MAIL
      ? [
          {
            url: 'https://targ.example/u/julia_zoladz',
            author: 'julia_zoladz',
            category: 'sale_offer' as const,
            text: `Julia Żołądź — rękodzieło. Kontakt: ${MAIL}. Płatności: ETH ${ETH_JULIA}.`,
            profile: { handle: 'julia_zoladz', displayName: 'Julia Żołądź', emails: [MAIL], location: 'Toruń' },
          },
        ]
      : [],
  ),
];

// Trzy wpłaty z adresu Jacka na oznaczony adres giełdy; pierwsza opisana także jako ścieżka środków.
const deposits = [
  transfer(1, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-04-01T00:00:00.000Z', amount: 0.5 }),
  transfer(2, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-05-01T00:00:00.000Z', amount: 0.2 }),
  transfer(3, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-06-01T00:00:00.000Z', amount: 0.1 }),
];
const trail: CashOutTrail = {
  id: 'sciezka-jacka',
  sourceAddress: BTC_A,
  network: 'bitcoin',
  serviceName: 'Kraken 4',
  serviceKind: 'exchange_deposit',
  asset: 'BTC',
  amount: 0.5,
  valuePln: 150_000,
  confidence: 95,
  hops: [{ txid: deposits[0]!.txid, time: deposits[0]!.time, from: BTC_A, to: EXCHANGE, asset: 'BTC', amount: 0.5, explorerUrl: deposits[0]!.explorerUrl }],
  reasons: ['Bezpośredni przelew na oznaczony adres giełdy.'],
  openQuestions: ['Dane klienta i wypłaty na rachunek — do potwierdzenia przez usługę.'],
};

const analyse = () =>
  runAnalysis({
    query,
    connectors: sources(),
    chainProviders: [chainWith({ [BTC_A]: { transfers: deposits, cashOuts: deposits.map((item) => cashOut(item, 100_000)), trails: [trail] } })],
    now: () => new Date('2026-11-21T10:00:00.000Z'),
  });

/** Odpowiedź tak, jak zapisuje ją API: ładunek przechodzi przez tę samą walidację i maskowanie. */
function reply(id: string, serviceId: string, input: ServiceReplyInput, extra: Partial<ServiceReply> = {}): ServiceReply {
  const cleaned = cleanReplyPayload(input);
  if ('error' in cleaned) throw new Error(cleaned.error);
  return {
    id,
    caseId: 'sprawa-1',
    serviceName: 'Kraken',
    serviceId,
    reference: 'KRK/2026/0042',
    receivedAt: '2026-11-20T12:00:00.000Z',
    recordedAt: '2026-11-21T10:00:00.000Z',
    recordedBy: 'analityk',
    payload: cleaned.payload,
    ...extra,
  };
}

const payouts = deposits.map((item, index) => ({ time: `2025-0${index + 4}-02T10:00:00.000Z`, amount: 50_000 - index * 10_000, currency: 'pln', bankAccount: 'PL61109010140000071219812874', relatedTxid: item.txid }));
const jacek = { fullName: 'Jacek Kowalski', identifierKind: 'PESEL' as const, identifier: '90010112345', accountId: 'KRK-7781', emails: [MAIL] };

/** Teczka bez pól, które z definicji różnią się po wprowadzeniu odpowiedzi (sam rejestr odpowiedzi). */
const withoutRegister = (dossier: ReturnType<typeof dossierOf>) => {
  const { serviceReplies: _replies, ...rest } = dossier;
  return JSON.parse(JSON.stringify(rest)) as unknown;
};

test('odpowiedź z danymi KYC zgodnymi z kandydatem i wypłatami: osoba potwierdzona, wskaźnik C na ostatnim szczeblu, graf i raport', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  assert.equal(automatic.persons[0]!.status, 'hypothesis');
  assert.ok(automatic.indicators.cashOut.every((item) => item.stage !== 'documented_fiat_exit'));
  assert.deepEqual(automatic.serviceReplies, []);

  const record = reply('odp-1', kraken.id, { matches: [{ network: 'bitcoin', txids: deposits.map((item) => item.txid) }], customer: jacek, fiatPayouts: payouts });
  const dossier = dossierOf(result, query, { serviceReplies: [record] });

  // Rejestr: dokument spoza OSINT, dopasowany, z jawnymi skutkami.
  const view = dossier.serviceReplies[0]!;
  assert.deepEqual([view.layer, view.layerLabel, view.withdrawn, view.serviceKnown], ['external_document', SERVICE_REPLY_LABEL, false, true]);
  assert.equal(view.match.matched, true);
  assert.deepEqual(view.match.addresses.map((item) => [item.address, item.by, item.txids.length]), [[BTC_A, ['txid'], 3]]);
  assert.equal(view.identity.outcome, 'confirmed');
  assert.deepEqual([view.fiatExit.documented, view.fiatExit.payouts], [true, 3]);
  assert.equal(view.contradiction, undefined);

  // Osoba: potwierdzona odpowiedzią usługi, z sygnaturą w przesłance.
  const main = dossier.persons[0]!;
  assert.deepEqual([main.fullName, main.status, main.probability], ['Jacek Kowalski', 'confirmed', 100]);
  assert.match(main.reasons[0]!, /potwierdzone odpowiedzią usługi Kraken, sygn\. KRK\/2026\/0042/);
  assert.deepEqual(main.confirmedByReply, { replyId: 'odp-1', serviceName: 'Kraken', reference: 'KRK/2026/0042' });

  // Adres: własność liczona jak potwierdzona przez analityka.
  const btc = dossier.findings.find((finding) => finding.address === BTC_A)!;
  assert.equal(btc.confirmedByReply?.replyId, 'odp-1');
  assert.equal(btc.decision, undefined);
  assert.ok(btc.annotations!.some((text) => /Własność adresu potwierdzona odpowiedzią usługi Kraken, sygn\. KRK\/2026\/0042/.test(text)));
  const proof = dossier.cashOutProof.find((item) => item.address === BTC_A)!;
  assert.deepEqual([proof.addressBasis, proof.personAddressProbability, proof.serviceReply?.outcome, proof.serviceReply?.fiatExitDocumented], ['confirmed', 100, 'confirmed', true]);
  assert.ok(proof.components[0]!.includes('potwierdzony odpowiedzią usługi Kraken'));

  // Wskaźnik C: ostatni szczebel, a dowodem jest odpowiedź (nie decyzja analityka o adresie).
  const exit = dossier.indicators.cashOut.find((item) => item.address === BTC_A && /Kraken/.test(item.serviceName ?? ''))!;
  assert.deepEqual([exit.stage, exit.status, exit.indicator.score], ['documented_fiat_exit', 'confirmed', 100]);
  const component = exit.indicator.components.find((item) => item.rule === 'cashout.documented_service_reply')!;
  assert.ok(component.evidence.some((item) => item.kind === 'decision' && item.value === 'reply:odp-1'));
  assert.match(component.explanation, /sygn\. KRK\/2026\/0042.*3 wypłaty na rachunek bankowy/);
  assert.match(exit.statement, /dokument spoza OSINT/);
  assert.ok(!exit.indicator.components.some((item) => item.rule === 'cashout.documented_offchain'));

  // Graf: węzeł źródła dla odpowiedzi, krawędzie potwierdzeń od usługi, adresu i podmiotu.
  const { nodes, edges } = dossier.graph;
  const node = nodes.find((item) => item.id === 'reply:odp-1')!;
  assert.deepEqual([node.kind, node.label, node.status], ['source', 'Odpowiedź usługi Kraken', 'confirmed']);
  const incoming = edges.filter((edge) => edge.to === 'reply:odp-1');
  assert.ok(incoming.every((edge) => edge.kind === 'documented_by' && edge.status === 'confirmed'));
  assert.ok(incoming.some((edge) => edge.from === `svc:${kraken.id}`));
  assert.ok(incoming.some((edge) => edge.from === `addr:bitcoin:${BTC_A}`));
  assert.ok(incoming.some((edge) => edge.from === 'subject' && /tożsamość potwierdzona/.test(edge.label ?? '')));

  // Kluczowe ustalenia i oś czasu nazywają źródło: dokument spoza OSINT.
  assert.ok(dossier.keyFindings.some((item) => /^Osoba potwierdzona odpowiedzią usługi Kraken, sygn\. KRK\/2026\/0042 \(dokument spoza OSINT/.test(item.text)));
  assert.ok(dossier.keyFindings.some((item) => /^Dokument spoza OSINT — odpowiedź usługi Kraken/.test(item.text)));
  const events = dossier.timeline.filter((event) => /według odpowiedzi usługi Kraken \(dokument spoza OSINT\)/.test(event.title));
  assert.deepEqual(events.map((event) => [event.layer, event.kind, event.valuePln]), [['fact', 'cash_out', undefined], ['fact', 'cash_out', undefined], ['fact', 'cash_out', undefined]]);
  // Kwoty z dokumentu nie zmieniają szacunków liczonych z blockchaina.
  assert.deepEqual(dossier.totals.cashOutPlnByYear, automatic.totals.cashOutPlnByYear);

  // Raport: osobna sekcja i warstwa; pełny PESEL ani numer rachunku nie występują nigdzie.
  const html = renderReportHtml(caseSummary, { ...run('run-test', dossier.findings), query }, dossier, [], { connectors: [], rules: DEFAULT_RULES, version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' });
  for (const expected of ['Odpowiedzi usług (dokumenty spoza OSINT)', 'KRK/2026/0042', '*******2345', 'PL** **** 2874', deposits[2]!.txid, 'potwierdzony odpowiedzią usługi Kraken', 'znacznik dokument', 'cashout.documented_service_reply']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.ok(!html.includes('90010112345') && !JSON.stringify(dossier).includes('90010112345'));
  assert.ok(!JSON.stringify(dossier).includes('PL61109010140000071219812874'));
});

test('odpowiedź wskazująca inną osobę: kandydat główny NIE jest potwierdzony, sprzeczność jest jawna i wskazuje powiązaną tożsamość', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  const identity = automatic.linkedIdentities.find((item) => item.accounts.includes(JULIA))!;
  const record = reply('odp-2', kraken.id, { matches: [{ depositAddress: EXCHANGE }], customer: { fullName: 'Julia Żołądź', identifier: 'ABC123456', identifierKind: 'dokument' }, fiatPayouts: payouts.slice(0, 1) });
  const dossier = dossierOf(result, query, { serviceReplies: [record] });

  const main = dossier.persons[0]!;
  assert.deepEqual([main.status, main.probability, main.confirmedByReply], ['hypothesis', automatic.persons[0]!.probability, undefined]);
  const view = dossier.serviceReplies[0]!;
  assert.deepEqual(view.match.addresses.map((item) => [item.address, item.by]), [[BTC_A, ['deposit_address']]]);
  assert.deepEqual([view.identity.outcome, view.identity.holderName, view.identity.linkedIdentityId], ['other_person', 'Julia Żołądź', identity.id]);
  assert.match(view.contradiction!, /^Sprzeczność: konto w usłudze Kraken.*należy według odpowiedzi \(sygn\. KRK\/2026\/0042\) do innej osoby: „Julia Żołądź”, a nie do kandydata głównego \(„Jacek Kowalski”\)/);
  assert.match(view.contradiction!, /powiązana tożsamość z tej sprawy/);
  assert.deepEqual(main.replyContradictions, [view.contradiction]);
  assert.ok(main.reasons.includes(view.contradiction!));
  assert.ok(dossier.keyFindings.some((item) => item.text.includes('Sprzeczność: konto w usłudze Kraken')));

  // Adres i ustalenie dla tej usługi są oznaczone; własność adresu nie jest potwierdzona.
  const btc = dossier.findings.find((finding) => finding.address === BTC_A)!;
  assert.equal(btc.confirmedByReply, undefined);
  assert.ok(btc.annotations!.some((text) => /należy do innej osoby \(„Julia Żołądź”\) — własność adresu NIE została potwierdzona/.test(text)));
  const proof = dossier.cashOutProof.find((item) => item.address === BTC_A)!;
  assert.deepEqual([proof.serviceReply?.outcome, proof.serviceReply?.holderName, proof.addressBasis], ['other_person', 'Julia Żołądź', 'published']);
  assert.equal(proof.combinedConfidence, automatic.cashOutProof.find((item) => item.address === BTC_A)!.combinedConfidence);
  // Wynik adresu i sumy pozostają bez zmian — odpowiedź nie dodała niczego na korzyść kandydata.
  assert.equal(btc.confidence.score, automatic.findings.find((finding) => finding.address === BTC_A)!.confidence.score);
  assert.deepEqual(dossier.totals, automatic.totals);

  // Wypłata jest udokumentowana, ale z zastrzeżeniem, że otrzymał ją właściciel konta — inna osoba.
  const exit = dossier.indicators.cashOut.find((item) => item.address === BTC_A && /Kraken/.test(item.serviceName ?? ''))!;
  assert.equal(exit.stage, 'documented_fiat_exit');
  assert.ok(exit.indicator.limitations.some((text) => /właścicielem konta jest inna osoba \(„Julia Żołądź”\)/.test(text)));

  // Graf: właścicielem konta jest węzeł powiązanej tożsamości; od podmiotu nie ma krawędzi potwierdzenia.
  const incoming = dossier.graph.edges.filter((edge) => edge.to === 'reply:odp-2');
  assert.ok(incoming.some((edge) => edge.from === `identity:${identity.id}` && /właściciel konta/.test(edge.label ?? '')));
  assert.ok(!incoming.some((edge) => edge.from === 'subject' || edge.from.startsWith('operator:')));

  // Osoba nieznana w sprawie: też sprzeczność, bez wskazania tożsamości.
  const stranger = dossierOf(result, query, { serviceReplies: [reply('odp-3', kraken.id, { matches: [{ txids: [deposits[0]!.txid] }], customer: { fullName: 'Adam Nowak' } })] });
  assert.equal(stranger.persons[0]!.status, 'hypothesis');
  assert.match(stranger.serviceReplies[0]!.contradiction!, /Tej osoby nie ma wśród tożsamości znalezionych w sprawie/);
  assert.equal(stranger.serviceReplies[0]!.identity.linkedIdentityId, undefined);
  assert.ok(stranger.graph.nodes.some((node) => node.id === 'holder:odp-3' && node.label === 'Adam Nowak'));
});

test('odpowiedź bez wypłat: właściciel konta potwierdzony, ale wskaźnik C zostaje poniżej ostatniego szczebla', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  const dossier = dossierOf(result, query, { serviceReplies: [reply('odp-4', kraken.id, { matches: [{ txids: [deposits[1]!.txid] }], customer: { fullName: 'KOWALSKI Jacek' } })] });

  assert.equal(dossier.persons[0]!.status, 'confirmed');
  const view = dossier.serviceReplies[0]!;
  assert.deepEqual([view.identity.outcome, view.fiatExit.documented], ['confirmed', false]);
  assert.match(view.fiatExit.text, /nie zawiera żadnej wypłaty na rachunek/);
  assert.ok(dossier.indicators.cashOut.every((item) => item.stage !== 'documented_fiat_exit'));
  assert.deepEqual(
    dossier.indicators.cashOut.map((item) => [item.id, item.stage, item.indicator.score]),
    automatic.indicators.cashOut.map((item) => [item.id, item.stage, item.indicator.score]),
  );
  assert.deepEqual(dossier.timeline.length, automatic.timeline.length);

  // Odpowiedź bez danych klienta, z wypłatą: wyjście udokumentowane, o tożsamości nic się nie zmienia.
  const anonymous = dossierOf(result, query, { serviceReplies: [reply('odp-5', kraken.id, { matches: [{ txids: [deposits[1]!.txid] }], fiatPayouts: payouts.slice(0, 1) })] });
  assert.deepEqual([anonymous.persons[0]!.status, anonymous.persons[0]!.probability], ['hypothesis', automatic.persons[0]!.probability]);
  assert.equal(anonymous.serviceReplies[0]!.identity.outcome, 'no_customer_data');
  assert.equal(anonymous.findings.find((finding) => finding.address === BTC_A)!.confirmedByReply, undefined);
  assert.ok(anonymous.indicators.cashOut.some((item) => item.address === BTC_A && item.stage === 'documented_fiat_exit'));
});

test('odpowiedź niedopasowana do danych sprawy: zapisana i pokazana, ale nie zmienia żadnego wyniku', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  const record = reply('odp-6', kraken.id, { matches: [{ txids: ['f'.repeat(64)] }, { depositAddress: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy' }], customer: jacek, fiatPayouts: payouts });
  const dossier = dossierOf(result, query, { serviceReplies: [record] });

  const view = dossier.serviceReplies[0]!;
  assert.deepEqual([view.match.matched, view.identity.outcome, view.fiatExit.documented, view.withdrawn], [false, 'not_applied', false, false]);
  assert.match(view.match.text, /^Nie dopasowano do danych sprawy/);
  assert.deepEqual(withoutRegister(dossier), withoutRegister(automatic));

  // Zgodna transakcja w innej sieci niż wskazana przez usługę to nie jest dopasowanie.
  const wrongNetwork = dossierOf(result, query, { serviceReplies: [reply('odp-7', kraken.id, { matches: [{ network: 'ethereum', txids: [deposits[0]!.txid] }], customer: jacek })] });
  assert.equal(wrongNetwork.serviceReplies[0]!.match.matched, false);
  // Adres odrzucony przez analityka: decyzja analityka ma pierwszeństwo przed dokumentem.
  const rejected = dossierOf(result, query, {
    decisions: [decision('address', `bitcoin:${BTC_A}`, 'rejected')],
    serviceReplies: [reply('odp-8', kraken.id, { matches: [{ txids: [deposits[0]!.txid] }], customer: jacek, fiatPayouts: payouts })],
  });
  assert.deepEqual([rejected.serviceReplies[0]!.match.matched, rejected.persons[0]!.status], [false, 'hypothesis']);
  assert.ok(rejected.indicators.cashOut.every((item) => item.stage !== 'documented_fiat_exit'));
});

test('wycofanie odpowiedzi przywraca dokładnie poprzednią teczkę i zostawia ślad audytowy', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  const record = reply('odp-9', kraken.id, { matches: [{ txids: deposits.map((item) => item.txid) }], customer: jacek, fiatPayouts: payouts });
  const applied = dossierOf(result, query, { serviceReplies: [record] });
  assert.notDeepEqual(withoutRegister(applied), withoutRegister(automatic));

  const withdrawn: ServiceReply = { ...record, withdrawnAt: '2026-11-21T11:00:00.000Z', withdrawnBy: 'analityk' };
  const restored = dossierOf(result, query, { serviceReplies: [withdrawn] });
  assert.deepEqual(withoutRegister(restored), withoutRegister(automatic));
  const view = restored.serviceReplies[0]!;
  assert.deepEqual([view.withdrawn, view.withdrawnAt, view.withdrawnBy, view.match.matched, view.identity.outcome], [true, '2026-11-21T11:00:00.000Z', 'analityk', false, 'not_applied']);
  // Raport nadal wymienia wycofany dokument — w rejestrze, bez wpływu na wynik.
  const html = renderReportHtml(caseSummary, { ...run('run-test', restored.findings), query }, restored, [], { connectors: [], rules: DEFAULT_RULES, version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' });
  assert.ok(html.includes('Odpowiedzi wycofane (ślad audytowy — nie wpływają na wynik)') && html.includes('KRK/2026/0042'));
  assert.ok(!html.includes('potwierdzony odpowiedzią usługi'));
});

test('maskowanie i walidacja ładunku: pełny identyfikator ani numer rachunku nigdy nie są zapisywane', () => {
  assert.equal(maskIdentifier('90010112345'), '*******2345');
  assert.equal(maskIdentifier(' 900 101 123 45 '), '*******2345');
  // Wartość już zamaskowana zostaje zamaskowana; krótka nie jest odsłaniana w całości.
  assert.equal(maskIdentifier('*******2345'), '*******2345');
  assert.equal(maskIdentifier('AB12'), '***12');
  assert.equal(maskBankAccount('PL61 1090 1014 0000 0712 1981 2874'), 'PL** **** 2874');
  assert.equal(maskBankAccount('PL** **** 2874'), 'PL** **** 2874');

  const cleaned = cleanReplyPayload(
    {
      matches: [{ network: ' Bitcoin ', depositAddress: ` ${EXCHANGE} `, txids: [' aa ', 'aa', ''] }],
      customer: { fullName: '  Jacek   Kowalski ', identifierKind: 'PESEL', identifier: '90010112345', emails: [MAIL, MAIL], phones: [] },
      fiatPayouts: [{ time: '2025-04-02', amount: 1200.5, currency: 'pln', bankAccount: 'PL61109010140000071219812874' }],
      note: '  ',
    },
    'treść pisma',
  );
  assert.ok('payload' in cleaned);
  const { payload } = cleaned;
  assert.deepEqual(payload.matches, [{ network: 'bitcoin', depositAddress: EXCHANGE, txids: ['aa'] }]);
  assert.deepEqual(payload.customer, { fullName: 'Jacek Kowalski', identifierKind: 'PESEL', identifierMasked: '*******2345', emails: [MAIL] });
  assert.deepEqual(payload.fiatPayouts, [{ time: '2025-04-02T00:00:00.000Z', amount: 1200.5, currency: 'PLN', bankAccountMasked: 'PL** **** 2874' }]);
  // Skrót liczony po stronie serwera z przesłanej treści; sama treść nie trafia do ładunku.
  assert.match(payload.documentHash!, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(payload).includes('treść pisma') && !JSON.stringify(payload).includes('90010112345'));

  for (const [input, message] of [
    [{ matches: [{ network: 'bitcoin' }] }, /adres wpłat albo co najmniej jedną transakcję/],
    [{ fiatPayouts: [{ time: 'wczoraj', amount: 1, currency: 'PLN' }] }, /nie jest poprawną datą wypłaty/],
    [{ fiatPayouts: [{ time: '2025-01-01', amount: 0, currency: 'PLN' }] }, /większą od zera/],
    [{ fiatPayouts: [{ time: '2025-01-01', amount: 5, currency: 'zł' }] }, /nie jest kodem waluty/],
    [{ matches: [{ txids: ['aa'] }], documentHash: 'abc' }, /SHA-256/],
    [{}, /Odpowiedź usługi jest pusta/],
  ] as const) {
    const outcome = cleanReplyPayload(input as ServiceReplyInput);
    assert.ok('error' in outcome && message.test(outcome.error), JSON.stringify(input));
  }

  // Porównanie nazwisk: kolejność wyrazów i znaki diakrytyczne nie mają znaczenia; forma żeńska to to samo nazwisko, ale inna osoba.
  assert.equal(sameFullName('Jacek Kowalski', 'KOWALSKI Jacek'), true);
  assert.equal(sameFullName('Julia Żołądź', 'julia zoladz'), true);
  assert.equal(sameFullName('Jacek Kowalski', 'Jacek Piotr Kowalski'), true);
  assert.equal(sameFullName('Rafał Kowalski', 'Julia Kowalska'), false);
  assert.equal(sameSurname('Rafał Kowalski', 'Julia Kowalska'), true);
});
