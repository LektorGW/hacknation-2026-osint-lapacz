// Scenariusz konkursowy od początku do końca na danych syntetycznych:
// jeden identyfikator → profile → adresy → weryfikacja → wskaźniki → odrzucanie błędnych przypisań →
// analiza blockchain → graf → raport. Trzy fikcyjne persony: Jacek Kowalski, Julia Żołądź, Franek Michalski.
// Nic tutaj nie jest wpisane „na sztywno” w wynik — wszystko liczy `runAnalysis` i `buildDossier`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES, linkKey } from '@olcys/core';
import type { CashOutTrail, ChainProvider } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { renderReportHtml } from '../src/report.ts';
import type { CaseSummary, DecisionRecord } from '../src/storage.ts';
import { BTC_A, BTC_C, ETH_A, cashOut, chainWith, decision, dossierOf, fakeConnector, run, transfer } from './helpers.ts';

const ETH_JULIA = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const TRON_JULIA = 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7';
const ETH_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const ETH_EXCHANGE = '0x28C6c06298d514Db089934071355E5743bf21d60';
const MAIL = 'jacek.kowalski@poczta.example';

const JACEK_GIT = 'gitpub.example|jacek_k_btc';
const JACEK_FORUM = 'forum.example|jkowal_dev';
const JULIA = 'targ.example|julia_zoladz';
const FRANEK = 'social.example|franek_m';

const query = { identifiers: [{ type: 'nick' as const, value: 'jacek_k_btc' }] };
const caseSummary: CaseSummary = { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [] };

/** Publiczne źródła scenariusza. `down` wyłącza wskazane źródło (awaria zewnętrznego API). */
function sources(down: string[] = []) {
  const guard = <T>(id: string, docs: T[]): T[] => {
    if (down.includes(id)) throw new Error('503 Service Unavailable');
    return docs;
  };
  return [
    // Jacek: profil znaleziony po nicku; podaje e-mail, adresy BTC i ETH oraz drugi swój nick.
    fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
      guard(
        'gitpub',
        identifier.value === 'jacek_k_btc'
          ? [
              {
                url: 'https://gitpub.example/jacek_k_btc',
                author: 'jacek_k_btc',
                text: `Jacek Kowalski — programista. Wsparcie: BTC ${BTC_A}, ETH ${ETH_A}. Forum: jkowal_dev. Stablecoiny przez kontrakt ${ETH_CONTRACT}.`,
                profile: { handle: 'jacek_k_btc', displayName: 'Jacek Kowalski', emails: [MAIL], location: 'Bydgoszcz' },
                discoveredIdentifiers: [{ type: 'nick' as const, value: 'jkowal_dev' }],
              },
            ]
          : [],
      ),
    ),
    // Drugi profil Jacka odsyła z powrotem do pierwszego (odnośniki wzajemne) i powtarza adres BTC.
    fakeConnector('forum', 'forum.example', ['nick'], (identifier) =>
      guard(
        'forum',
        identifier.value === 'jkowal_dev'
          ? [
              {
                url: 'https://forum.example/u/jkowal_dev',
                author: 'jkowal_dev',
                text: `Na co dzień jacek_k_btc na gitpubie. Rozliczenia za zlecenia przyjmuję na ${BTC_A}.`,
                profile: { handle: 'jkowal_dev', location: 'Bydgoszcz' },
                discoveredIdentifiers: [{ type: 'login' as const, value: 'jacek_k_btc' }],
              },
            ]
          : [],
      ),
    ),
    // Julia: inne nazwisko i nick, własne adresy ETH i TRON, ale ten sam e-mail kontaktowy co Jacek.
    fakeConnector('targ', 'targ.example', ['email'], (identifier) =>
      guard(
        'targ',
        identifier.value === MAIL
          ? [
              {
                url: 'https://targ.example/u/julia_zoladz',
                author: 'julia_zoladz',
                category: 'sale_offer' as const,
                text: `Julia Żołądź — rękodzieło. Kontakt: ${MAIL}. Płatności: ETH ${ETH_JULIA}, USDT (TRON) ${TRON_JULIA}.`,
                profile: { handle: 'julia_zoladz', displayName: 'Julia Żołądź', emails: [MAIL], location: 'Toruń' },
              },
            ]
          : [],
      ),
    ),
    // Franek: osobny profil z własnym adresem BTC, na który Jacek wysłał jeden przelew.
    fakeConnector('social', 'social.example', ['crypto_address'], (identifier) =>
      guard(
        'social',
        identifier.value === BTC_C
          ? [
              {
                url: 'https://social.example/franek_m',
                author: 'franek_m',
                text: `Franek Michalski, grafik. Napiwki: ${BTC_C}`,
                profile: { handle: 'franek_m', displayName: 'Franek Michalski', location: 'Gdynia' },
              },
            ]
          : [],
      ),
    ),
  ];
}

const deposit = transfer(1, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-04-01T00:00:00.000Z', amount: 0.5 });
const toFranek = transfer(2, { counterparty: BTC_C, time: '2025-02-10T00:00:00.000Z', amount: 0.01 });
const jacekEth = transfer(3, { counterparty: ETH_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Binance 14', time: '2025-05-01T00:00:00.000Z', amount: 1, asset: 'ETH' });
const juliaEth = transfer(4, { counterparty: ETH_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Binance 14', time: '2025-06-01T00:00:00.000Z', amount: 2, asset: 'ETH' });
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
  hops: [{ txid: deposit.txid, time: deposit.time, from: BTC_A, to: EXCHANGE, asset: 'BTC', amount: 0.5, explorerUrl: deposit.explorerUrl }],
  reasons: ['Bezpośredni przelew na oznaczony adres giełdy.'],
  openQuestions: ['Dane klienta i wypłaty na rachunek — do potwierdzenia przez usługę.'],
};

const chain = (): ChainProvider =>
  chainWith({
    [BTC_A]: { transfers: [deposit, toFranek], cashOuts: [cashOut(deposit, 150_000)], trails: [trail] },
    [ETH_A]: { transfers: [jacekEth] },
    [ETH_JULIA]: { transfers: [juliaEth] },
    [ETH_CONTRACT]: { addressClass: 'smart_contract', label: 'Tether USD' },
  });

const analyse = (down: string[] = [], chainProviders: ChainProvider[] = [chain()]) =>
  runAnalysis({ query, connectors: sources(down), chainProviders, now: () => new Date('2026-11-21T10:00:00.000Z') });

test('pełny przebieg: jeden nick → konta, adresy, hipotezy, blockchain, graf i raport z kompletną ścieżką dowodową', async () => {
  const result = await analyse();
  const dossier = dossierOf(result, query);

  // ---------- Odkryte konta i ścieżka odkrywania ----------
  assert.deepEqual(result.intel.trail.map((step) => [step.identifier.value, step.step, step.followed])[0], ['jkowal_dev', 1, true]);
  const main = dossier.persons[0]!;
  assert.deepEqual([...main.profileIds].sort(), [JACEK_FORUM, JACEK_GIT].sort());
  assert.equal(main.fullName, 'Jacek Kowalski');
  // Kandydat jest hipotezą narzędzia, nie ustaleniem.
  assert.equal(main.status, 'hypothesis');

  // ---------- Adresy: zweryfikowane sumą kontrolną, kontrakt wykluczony ----------
  const byAddress = new Map(dossier.findings.map((finding) => [finding.address, finding]));
  for (const address of [BTC_A, ETH_A]) {
    assert.equal(byAddress.get(address)!.checksumVerified, true);
    assert.ok(byAddress.get(address)!.confidence.score >= 85, address);
  }
  // BTC w dwóch niezależnych pochodzeniach (własny profil + forum): 85 + 15.
  assert.equal(byAddress.get(BTC_A)!.confidence.independentSources, 2);
  assert.equal(byAddress.get(BTC_A)!.confidence.score, 100);
  // Kontrakt opublikowany w profilu nie jest portfelem prywatnym.
  const contract = byAddress.get(ETH_CONTRACT)!;
  assert.deepEqual([contract.confidence.score, contract.confidence.excluded], [0, true]);
  const contractLink = dossier.indicators.accountWallet.find((link) => link.address === ETH_CONTRACT)!;
  assert.deepEqual([contractLink.notPrivateWallet, contractLink.indicator.score], [true, 0]);
  // Adresy Julii i Franka nie są adresami Jacka.
  for (const address of [ETH_JULIA, TRON_JULIA, BTC_C]) assert.equal(byAddress.has(address), false, address);
  assert.equal(dossier.totals.linkedAddresses, 2);

  // ---------- Wskaźnik A: konto → portfel, osobno dla każdego konta ----------
  const wallet = (account: string, address: string) => dossier.indicators.accountWallet.find((link) => link.accountId === account && link.address === address);
  assert.equal(wallet(JACEK_GIT, BTC_A)!.indicator.score, 85);
  assert.ok(wallet(JACEK_FORUM, BTC_A)!.indicator.score > 0);
  for (const link of dossier.indicators.accountWallet) {
    assert.equal(link.indicator.calibrated, false);
    for (const component of link.indicator.components) {
      assert.ok(component.rule && component.source && component.explanation, component.rule);
      assert.ok(Array.isArray(component.limitations) && Array.isArray(component.evidence), component.rule);
    }
  }

  // ---------- Wskaźnik B: hipotezy wspólnego operatora ----------
  const hypothesis = (a: string, b: string) => dossier.indicators.commonOperator.find((item) => item.id === linkKey(a, b));
  // Dwa konta Jacka: wzajemne odnośniki i ten sam adres — zgrupowane, ale nadal jako wnioskowanie.
  const own = hypothesis(JACEK_GIT, JACEK_FORUM)!;
  assert.equal(own.status, 'auto_grouped');
  assert.ok(own.indicator.components.some((item) => item.rule === 'operator.mutual_links'));
  assert.ok(own.indicator.score < 100);
  // Jacek–Julia: ten sam e-mail to mocna przesłanka, ale sprzeczne deklarowane nazwiska blokują scalenie.
  const julia = hypothesis(JACEK_GIT, JULIA)!;
  assert.equal(julia.status, 'blocked');
  assert.ok(julia.indicator.components.some((item) => item.rule === 'operator.same_email' && item.direction === 'supports'));
  const conflict = julia.indicator.components.find((item) => item.rule === 'operator.conflict.declared_name')!;
  assert.deepEqual([conflict.direction, conflict.blocking], ['contradicts', true]);
  assert.ok(julia.indicator.score <= 45);
  assert.match(julia.statement, /nie jest to ustalenie tożsamości/);
  assert.ok(!main.profileIds.includes(JULIA));
  // Julia jest powiązaną tożsamością-hipotezą z własnymi adresami.
  const identity = dossier.linkedIdentities.find((item) => item.accounts.includes(JULIA))!;
  assert.equal(identity.status, 'hypothesis');
  assert.deepEqual(identity.addresses.map((item) => item.address).sort(), [ETH_JULIA, TRON_JULIA].sort());
  // Wspólna giełda (Binance) u Jacka i Julii nie jest przesłanką wspólnego operatora.
  assert.ok(!julia.indicator.components.some((item) => item.direction === 'supports' && /Binance|giełd/i.test(item.explanation)));
  // Franek: jeden przelew od Jacka nie czyni z niego tej samej osoby ani nie wciąga go do teczki jako tożsamości.
  assert.ok(!main.profileIds.includes(FRANEK));
  assert.ok(!dossier.linkedIdentities.some((item) => item.relation === 'same_person_likely' && item.accounts.includes(FRANEK)));
  const franek = hypothesis(JACEK_GIT, FRANEK);
  assert.ok(franek === undefined || (franek.status === 'hypothesis' && franek.indicator.score < 50));
  // Żadna hipoteza nie jest „potwierdzona” bez decyzji analityka.
  assert.ok(dossier.indicators.commonOperator.every((item) => item.status !== 'confirmed' && item.indicator.score < 100));

  // ---------- Wskaźnik C: blockchain nie dowodzi wypłaty na rachunek ----------
  const kraken = dossier.indicators.cashOut.find((item) => item.address === BTC_A && /Kraken/.test(item.serviceName ?? ''))!;
  assert.ok(['service_interaction', 'cashout_signal'].includes(kraken.stage));
  assert.ok(kraken.txids.includes(deposit.txid));
  assert.equal(kraken.valuePln, 150_000);
  assert.ok(kraken.indicator.limitations.concat(kraken.indicator.components.flatMap((item) => item.limitations)).some((text) => /usług/.test(text)));
  assert.ok(dossier.indicators.cashOut.every((item) => item.stage !== 'documented_fiat_exit'));
  // Adres giełdy ani kontraktu nie jest niczyim portfelem prywatnym w teczce.
  assert.ok(!dossier.findings.some((finding) => [EXCHANGE, ETH_EXCHANGE].includes(finding.address) && !finding.confidence.excluded));

  // ---------- Graf: hipotezy są hipotezami ----------
  const { nodes, edges } = dossier.graph;
  const edge = edges.find((item) => item.kind === 'same_operator' && [item.from, item.to].includes(`profile:${JULIA}`))!;
  assert.equal(edge.status, 'hypothesis');
  assert.ok((edge.evidence ?? []).length > 0);
  assert.ok(nodes.filter((node) => node.kind === 'operator' || node.kind === 'persona' || node.kind === 'person').every((node) => node.status !== 'confirmed'));
  assert.ok(nodes.some((node) => node.kind === 'source' && node.url === 'https://gitpub.example/jacek_k_btc'));
  assert.ok(edges.some((item) => item.layer === 'chain' && item.kind === 'cash_out'));

  // ---------- Raport: komplet sekcji i ścieżka dowodowa ----------
  const html = renderReportHtml(caseSummary, { ...run('run-test', dossier.findings), query }, dossier, [], { connectors: [], rules: DEFAULT_RULES, version: 'test', generatedAt: '2026-11-21T10:00:00.000Z' });
  for (const expected of ['Wskaźnik A — konto → portfel', 'Wskaźnik B — hipotezy wspólnego operatora', 'Wskaźnik C — sygnały wyjścia do walut tradycyjnych', 'Ścieżka dowodowa', 'https://gitpub.example/jacek_k_btc', BTC_A, deposit.txid, 'operator.conflict.declared_name']) {
    assert.ok(html.includes(expected), expected);
  }
  assert.match(html, /nie (jest )?skalibrowanym/);

  // ---------- Kontrola rozszerzania ----------
  const expansion = result.intel.expansion!;
  assert.ok(expansion.requests.connectors > 0 && expansion.requests.connectors <= expansion.limits.maxRequests);
  assert.ok(expansion.stops.length > 0);
  assert.deepEqual(result.intel.sourceErrors ?? [], []);
});

test('decyzje analityka: potwierdzenie i odrzucenie hipotezy przeliczają teczkę; wycofanie przywraca wynik i zostawia ślad', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const key = linkKey(JACEK_GIT, JULIA);
  const snapshot = (dossier: typeof automatic) => ({
    persons: dossier.persons.map((person) => [[...person.profileIds].sort(), person.probability, person.status]),
    findings: dossier.findings.map((finding) => [finding.address, finding.confidence.score]),
    hypotheses: dossier.indicators.commonOperator.map((item) => [item.id, item.status, item.indicator.score]),
    identities: dossier.linkedIdentities.map((item) => [item.id, item.status, item.score]),
    linked: dossier.totals.linkedAddresses,
  });

  // Potwierdzenie: konto Julii przechodzi do operatora głównego, jej adresy stają się adresami podmiotu.
  const confirmDecision = decision('link', key, 'confirmed', 'ten sam rachunek w aktach sprawy');
  const confirmed = dossierOf(result, query, { decisions: [confirmDecision] });
  assert.ok(confirmed.persons[0]!.profileIds.includes(JULIA));
  const confirmedHypothesis = confirmed.indicators.commonOperator.find((item) => item.id === key)!;
  assert.deepEqual([confirmedHypothesis.status, confirmedHypothesis.indicator.score], ['confirmed', 100]);
  assert.equal(confirmedHypothesis.decision?.note, 'ten sam rachunek w aktach sprawy');
  assert.ok(confirmed.findings.some((finding) => finding.address === ETH_JULIA && finding.confidence.score > 0));
  assert.ok(confirmed.totals.linkedAddresses > automatic.totals.linkedAddresses);
  assert.equal(confirmed.graph.edges.find((item) => item.kind === 'same_operator' && [item.from, item.to].includes(`profile:${JULIA}`))!.status, 'confirmed');

  // Odrzucenie: hipoteza zostaje w teczce jako odrzucona, konta osobno.
  const rejected = dossierOf(result, query, { decisions: [decision('link', key, 'rejected')] });
  const rejectedHypothesis = rejected.indicators.commonOperator.find((item) => item.id === key)!;
  assert.deepEqual([rejectedHypothesis.status, rejectedHypothesis.indicator.score], ['rejected', 0]);
  assert.ok(!rejected.persons[0]!.profileIds.includes(JULIA));
  assert.equal(rejected.graph.edges.find((item) => item.kind === 'same_operator' && [item.from, item.to].includes(`profile:${JULIA}`))!.status, 'rejected');
  assert.deepEqual(snapshot(rejected).findings, snapshot(automatic).findings);

  // Wycofanie potwierdzenia: wynik wraca dokładnie do automatycznego, a decyzja i jej wycofanie zostają w rejestrze.
  const withdrawn: DecisionRecord = { ...confirmDecision, withdrawnAt: '2026-11-21T11:00:00.000Z', withdrawnBy: 'analityk' };
  const restored = dossierOf(result, query, { decisions: [withdrawn] });
  assert.deepEqual(snapshot(restored), snapshot(automatic));
  assert.deepEqual(restored.decisions.map((item) => [item.target, item.decision, item.withdrawnAt]), [['link', 'confirmed', '2026-11-21T11:00:00.000Z']]);
});

test('nieaktywne zewnętrzne API: czytelny wynik częściowy, bez wymyślonych danych', async () => {
  const failingChain: ChainProvider = { id: 'eksplorator', label: 'Eksplorator (awaria)', supports: () => true, getActivity: async () => { throw new Error('ECONNREFUSED'); } };
  const result = await analyse(['forum'], [failingChain]);
  const dossier = dossierOf(result, query);

  // Źródła, które odpowiedziały, dają pełnoprawne ślady.
  const btc = dossier.findings.find((finding) => finding.address === BTC_A)!;
  assert.ok(btc.evidence.every((item) => item.service === 'gitpub.example'));
  assert.equal(btc.confidence.independentSources, 1);
  // Bez drugiego profilu nie ma odnośników wzajemnych: profil znany tylko z nicku, więc 85 − 10, a nie więcej.
  assert.equal(btc.confidence.score, 75);
  // Awarie są nazwane, a nie przemilczane.
  const failed = [...new Set(dossier.sourceErrors.map((item) => item.connectorId ?? item.providerId))].sort();
  assert.deepEqual(failed, ['eksplorator', 'forum']);
  assert.ok(dossier.explanations.some((item) => item.kind === 'source_errors'));
  assert.ok(result.log.some((entry) => /forum/.test(entry.message)));
  // Brak danych blockchain to brak danych — żadnych zer, kwot ani ścieżek z niczego.
  for (const finding of dossier.findings) assert.equal(finding.chain, undefined, finding.address);
  assert.deepEqual(dossier.indicators.cashOut, []);
  assert.deepEqual(dossier.cashOutProof, []);
  assert.deepEqual(dossier.totals.cashOutPlnByYear, {});
  // Konto, którego źródło nie odpowiedziało, nie pojawia się w teczce.
  assert.ok(!dossier.profiles.some((profile) => profile.id === JACEK_FORUM));
});
