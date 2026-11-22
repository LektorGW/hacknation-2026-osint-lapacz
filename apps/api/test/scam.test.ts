// Ostrzeżenia o możliwym oszustwie: reguła tekstowa (PL/EN), wykluczenia, fałszywe rozdanie w tekście
// i w blockchainie, pochodzenie (kopie raz), autorzy ostrzeżeń nigdy właścicielami, zbiory ostrzeżeń,
// poziomy, zatruwanie adresu, raport i graf. Atrapy łączników — bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_RULES } from '@olcys/core';
import type { AnalysisRun, Finding, SubjectQuery } from '@olcys/core';
import type { ScamListAddressFlag } from '@olcys/sources';
import { runAnalysis } from '../src/analysis.ts';
import type { AnalysisResult } from '../src/analysis.ts';
import { buildDossier } from '../src/dossier.ts';
import { renderScamSection } from '../src/report-scam.ts';
import { SCAM_RULES, addressPoisoning, buildScamWarnings, giveawayChainPattern, readScamContext, scamKeyFindings } from '../src/scam.ts';
import type { ScamDocument } from '../src/scam.ts';
import { BTC_A, BTC_B, ETH_A, FIXED_NOW, chainWith, fakeConnector, fakeProvider, finding, run, transfer } from './helpers.ts';

const noLists = { listCheck: () => [], domainCheck: () => [] };
const doc = (url: string, author: string, text: string, service = 'forum.example'): ScamDocument => ({ url, author, text, service });
const bare = (address = BTC_A): Finding => finding(address, 0, []);

/** Teczka z dokumentami analizy (pełne treści, także publikacji innych autorów) — jak w API. */
function dossierWithDocuments(result: AnalysisResult, query: SubjectQuery) {
  const analysisRun: AnalysisRun = { ...run('run-test', result.findings), query, log: result.log };
  return buildDossier({
    caseSummary: { id: 'sprawa-1', name: 'Sprawa testowa', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [], status: 'open' },
    run: analysisRun,
    intel: result.intel,
    decisions: [],
    otherCases: [],
    rules: DEFAULT_RULES,
    now: FIXED_NOW(),
    documents: result.documents,
  });
}

test('rozpoznanie ostrzeżenia przy adresie — po polsku i po angielsku', () => {
  for (const text of [
    `Uwaga! To oszustwo, nie wpłacajcie na ${BTC_A}.`,
    `Zgłoszone jako oszustwo: ${BTC_A} — ukradli mi 0,2 BTC.`,
    `Ten adres ${BTC_A} podszywa się pod giełdę.`,
    `Beware: ${BTC_A} is a scam, reported as phishing.`,
    `Wallet drainer / rug pull — funds went to ${BTC_A}`,
  ]) {
    const reading = readScamContext(text, BTC_A);
    assert.ok(reading?.warning, text);
  }
});

test('bez ostrzeżenia: zwykła wzmianka, własny adres do darowizn, właściciel ostrzegający przed podróbkami', () => {
  for (const text of [
    `Ciekawe, co robi ${BTC_A} — duży obrót w tym tygodniu.`,
    `Mój adres do darowizn: ${BTC_A}. Dzięki za wsparcie projektu!`,
    `Uwaga na oszustów podszywających się pod fundację — nasz jedyny adres to ${BTC_A}.`,
    `Projekt z hackathonu, testowy adres ${BTC_A}`,
    `Ostrzeżenie o oszustwach: Scam Alert: None ${BTC_A}`,
  ]) {
    assert.equal(readScamContext(text, BTC_A), undefined, text);
  }
});

test('fałszywe rozdanie w tekście: obietnica zwrotu i podszywanie się pod znaną osobę', () => {
  const en = readScamContext(`Elon Musk official giveaway! Send 1 BTC to ${BTC_A} and get 2 BTC back.`, BTC_A);
  assert.equal(en?.giveaway, true);
  assert.equal(en?.warning, false, 'sama obietnica to nie ostrzeżenie');
  assert.equal(en?.impersonates, 'elon musk');
  const pl = readScamContext(`Rozdajemy BTC! Wpłać na ${BTC_A}, odeślemy x2 w godzinę.`, BTC_A);
  assert.equal(pl?.giveaway, true);
  assert.equal(pl?.warning, false);
  const warnings = buildScamWarnings({ findings: [bare()], documents: [doc('https://social.example/p/1', 'elon_official_x', `Elon Musk giveaway! Send 1 BTC to ${BTC_A} and get 2 BTC back.`)], ...noLists });
  const [item] = warnings.addresses;
  assert.ok(item!.components.some((component) => component.rule === 'scam.giveaway_text'));
  assert.ok(item!.components.some((component) => component.rule === 'scam.impersonation'));
  assert.ok(item!.interpretation.some((text) => text.includes('możliwa ofiara podszywania się')));
});

test('wzorzec rozdania w blockchainie: wiele wpłat od wielu nadawców, potem szybkie wyprowadzenie', () => {
  const senders = Array.from({ length: 10 }, (_, index) => `1Sender${index}xxxxxxxxxxxxxxxxxxxxxxxx`);
  const inbound = senders.map((counterparty, index) => transfer(index + 1, { direction: 'in', counterparty, time: `2020-07-15T2${Math.min(index, 3)}:0${index % 10}:00Z`, amount: 0.05 + index * 0.01 }));
  const sweep = transfer(50, { direction: 'out', counterparty: '1Sweepxxxxxxxxxxxxxxxxxxxxxxxxxxx', time: '2020-07-16T03:00:00Z', amount: 0.9 });
  const pattern = giveawayChainPattern({ chain: { ...chainActivity(), transfers: [...inbound, sweep] } });
  assert.ok(pattern);
  assert.equal(pattern!.senders, 10);
  assert.equal(pattern!.nearFirstActivity, true);
  assert.match(pattern!.explanation, /^HIPOTEZA/);
  // Kilka zwykłych przelewów — brak wzorca.
  assert.equal(giveawayChainPattern({ chain: { ...chainActivity(), transfers: inbound.slice(0, 3) } }), undefined);
  // Bez wyprowadzenia środków — brak wzorca.
  assert.equal(giveawayChainPattern({ chain: { ...chainActivity(), transfers: inbound } }), undefined);
  // Sam wzorzec w blockchainie (hipoteza) jest poniżej progu ostrzeżenia.
  const only = buildScamWarnings({ findings: [{ ...bare(), chain: { ...chainActivity(), transfers: [...inbound, sweep] } }], ...noLists });
  assert.equal(only.addresses[0]!.level, 'none');
  assert.equal(only.level, 'none');
});

function chainActivity() {
  return { profile: { address: BTC_A, network: 'bitcoin' as const, addressClass: 'private' as const, classificationSource: 'test', isContract: false, txCount: 0, totalReceived: 0, totalSent: 0, balance: 0, nativeAsset: 'BTC' }, transfers: [], cashOuts: [], cashOutPlnByYear: {}, limitations: [] };
}

test('pochodzenie: ta sama treść skopiowana przez kilku autorów liczy się raz', () => {
  const copy = `UWAGA OSZUSTWO! Fałszywa giełda zbiera wpłaty na ${BTC_A}, nie wpłacajcie, zgłoszone na policję.`;
  const copies = buildScamWarnings({
    findings: [bare()],
    documents: [doc('https://forum.example/t/1', 'ala', copy), doc('https://inne.example/p/2', 'ola', copy, 'inne.example'), doc('https://trzecie.example/x', 'ela', copy, 'trzecie.example')],
    ...noLists,
  });
  assert.equal(copies.addresses[0]!.independentSources, 1);
  assert.equal(copies.addresses[0]!.level, 'reports');
  const independent = buildScamWarnings({
    findings: [bare()],
    documents: [
      doc('https://forum.example/t/1', 'ala', copy),
      doc('https://inne.example/p/2', 'ola', `Też straciłam pieniądze, ${BTC_A} to scam — ukradli mi 300 USDT.`, 'inne.example'),
      doc('https://trzecie.example/x', 'ela', `Beware of ${BTC_A}, fake exchange, reported to police.`, 'trzecie.example'),
    ],
    ...noLists,
  });
  assert.equal(independent.addresses[0]!.independentSources, 3);
  assert.equal(independent.addresses[0]!.level, 'strong');
  assert.match(independent.addresses[0]!.statement, /^Ostrzeżenie: adres mógł być wykorzystywany do oszustwa \(zgłoszenia w 3 niezależnych źródłach\)\.$/);
});

test('poziomy: jedno zgłoszenie — „są zgłoszenia”; ostrzeżenie z obietnicą rozdania — silne; brak sygnałów — brak wpisu', () => {
  const one = buildScamWarnings({ findings: [bare()], documents: [doc('https://forum.example/t/1', 'ala', `To oszustwo: ${BTC_A}`)], ...noLists });
  assert.equal(one.level, 'reports');
  assert.equal(one.addresses[0]!.score, SCAM_RULES.warningFirst);
  assert.match(one.addresses[0]!.statement, /zgłoszenia w 1 niezależnym źródle/);
  const quoted = buildScamWarnings({ findings: [bare()], documents: [doc('https://forum.example/t/1', 'ala', `Scam! They promise: send 1 BTC to ${BTC_A} and get 2 BTC back.`)], ...noLists });
  assert.equal(quoted.level, 'strong');
  const nothing = buildScamWarnings({ findings: [bare()], documents: [doc('https://forum.example/t/1', 'ala', `Mój adres: ${BTC_A}`)], ...noLists });
  assert.equal(nothing.level, 'none');
  assert.deepEqual(nothing.addresses, []);
  assert.deepEqual(scamKeyFindings(nothing), []);
});

test('odczyt modelu „warning_about_address” z cytatem liczy się jako publikacja ostrzegająca', () => {
  const withInsight = {
    ...bare(),
    evidence: [
      {
        id: 'e1',
        category: 'forum_post' as const,
        service: 'forum.example',
        url: 'https://forum.example/t/9',
        capturedAt: '2026-11-21T09:00:00.000Z',
        identityMatch: 'name_only' as const,
        title: 'Wątek',
        excerpt: `Coś jest nie tak z ${BTC_A}`,
        contentHash: '1'.repeat(64),
        connectorId: 'forum',
        matchedIdentifier: { type: 'crypto_address' as const, value: BTC_A },
        insight: { ownership: 'warning_about_address' as const, quote: 'Coś jest nie tak', language: 'pl', model: 'atrapa-1', promptVersion: 'p1' },
      },
    ],
  };
  const warnings = buildScamWarnings({ findings: [withInsight], ...noLists });
  assert.equal(warnings.addresses[0]!.publications[0]!.basis, 'model');
  assert.equal(warnings.addresses[0]!.level, 'reports');
});

test('zbiór ostrzeżeń: trafienie adresu to fakt o liście i silne ostrzeżenie', () => {
  const hit: ScamListAddressFlag = {
    address: ETH_A,
    list: 'mew-darklist',
    listLabel: 'MyEtherWallet ethereum-lists — adresy z ostrzeżeniem (addresses-darklist)',
    comment: 'Fake giveaway',
    date: '2020-01-01',
    retrievedAt: '2026-11-22T00:00:00.000Z',
    url: 'https://github.com/MyEtherWallet/ethereum-lists',
    licence: 'MIT',
    status: 'source_fact',
    caveat: 'fakt o liście',
  };
  const warnings = buildScamWarnings({ findings: [finding(ETH_A, 0, [], 'ethereum')], listCheck: () => [hit], domainCheck: () => [] });
  const [item] = warnings.addresses;
  assert.equal(item!.level, 'strong');
  assert.equal(item!.independentSources, 1);
  assert.ok(item!.components.some((component) => component.rule === 'scam.public_list' && component.status === 'source_fact'));
  assert.equal(scamKeyFindings(warnings)[0]!.layer, 'fact');
  // Prawdziwa migawka: adres z listy MEW jest rozpoznawany bez sieci.
  const real = buildScamWarnings({ findings: [finding('0x09750ad360fdb7a2ee23669c4503c974d86d8694', 0, [], 'ethereum')], domainCheck: () => [] });
  assert.equal(real.addresses[0]?.listHits[0]?.list, 'mew-darklist');
});

test('domena phishingowa w publikacji z adresem: składnik z faktem o liście', () => {
  const warnings = buildScamWarnings({
    findings: [bare()],
    documents: [doc('https://forum.example/t/1', 'ala', `Airdrop! Odbierz na https://claim-bonus.example/start i wpłać opłatę na ${BTC_A}`)],
    listCheck: () => [],
    domainCheck: (values) => (values.some((value) => value.includes('claim-bonus.example')) ? [{ domain: 'claim-bonus.example', matched: 'claim-bonus.example', list: 'metamask-phishing', listLabel: 'MetaMask', retrievedAt: '2026-11-22', url: 'https://github.com/MetaMask/eth-phishing-detect', licence: 'DBAD', status: 'source_fact', caveat: 'fakt o liście' }] : []),
  });
  assert.ok(warnings.addresses[0]!.components.some((component) => component.rule === 'scam.phishing_domain'));
});

test('autorzy ostrzeżeń nigdy nie zostają właścicielami — pełna analiza adresu i teczka', async () => {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const posts = [
    { url: 'https://forum.example/t/1', author: 'poszkodowana_ania', text: `Uwaga! Fałszywe rozdanie, wysłałam 0,1 BTC na ${BTC_A} i nic nie wróciło. To oszustwo.` },
    { url: 'https://forum.example/t/2', author: 'swiadek_tomek', text: `Mój adres to nie ${BTC_A}, ktoś podszywa się pod mój profil — nie wpłacajcie tam!` },
    { url: 'https://social.example/p/3', author: 'czujny_marek', text: `Scam alert: ${BTC_A} — fake Elon giveaway, reported.` },
    { url: 'https://social.example/p/4', author: 'promotor_x2', text: `MEGA ROZDANIE Elon Musk! Send 0.1 BTC to ${BTC_A}, get 0.2 BTC back!` },
  ];
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], () => posts.filter((post) => post.url.includes('forum')).map((post) => ({ ...post, category: 'forum_post' as const, identityMatch: 'name_only' as const })));
  const social = fakeConnector('social', 'social.example', ['crypto_address'], () => posts.filter((post) => post.url.includes('social')).map((post) => ({ ...post, category: 'forum_post' as const, identityMatch: 'name_only' as const })));
  const result = await runAnalysis({ query, connectors: [forum, social], chainProviders: [fakeProvider()] });
  assert.equal(result.findings[0]!.evidence.length, 0, 'żaden autor nie jest śladem własności');
  const dossier = dossierWithDocuments(result, query);
  assert.deepEqual(dossier.persons, [], 'brak kandydatów na osobę');
  const scam = dossier.scamWarnings;
  assert.equal(scam.level, 'strong');
  const [item] = scam.addresses;
  assert.equal(item!.independentSources, 3);
  assert.ok(item!.interpretation[0]!.includes('nie są właścicielami adresu'));
  assert.ok(!item!.interpretation.some((text) => text.startsWith('SPRZECZNOŚĆ')));
  assert.match(item!.action, /CERT Polska/);
  // Graf: dopisek przy węźle adresu; kluczowe ustalenie i sekcja raportu.
  const node = dossier.graph.nodes.find((candidate) => candidate.id === `addr:bitcoin:${BTC_A}`);
  assert.match(node!.sublabel ?? '', /^zgłoszenia oszustwa/);
  assert.ok(dossier.keyFindings.some((entry) => entry.text.startsWith('Ostrzeżenie: adres') && entry.layer === 'inference'));
  const html = renderScamSection(scam);
  assert.match(html, /<h2>Ostrzeżenia o możliwym oszustwie<\/h2>/);
  assert.match(html, /https:\/\/forum\.example\/t\/1/);
  // Teczka bez dokumentów (starsza analiza) — działa na fragmentach śladów, bez błędu.
  const older = buildDossier({ caseSummary: { id: 'sprawa-1', name: 'S', createdAt: '2026-11-21T08:00:00.000Z', query, runs: [], status: 'open' }, run: { ...run('r', result.findings), query }, intel: result.intel, decisions: [], otherCases: [], rules: DEFAULT_RULES, now: FIXED_NOW() });
  assert.ok(older.scamWarnings);
});

test('ostrzeżenie na własnym profilu (kategoria „profil”) nie czyni autora właścicielem', async () => {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const wall = fakeConnector('social', 'social.example', ['crypto_address'], () => [
    { url: 'https://social.example/gosia/wpis/1', author: 'gosia', category: 'own_profile' as const, identityMatch: 'name_only' as const, text: `UWAGA! Wysłałam 0,05 BTC na ${BTC_A} i nic nie wróciło. To oszustwo, nie wpłacajcie!` },
    // Właściciel ostrzegający przed podróbkami i wskazujący swój jedyny adres — nadal właściciel.
    { url: 'https://social.example/fundacja', author: 'fundacja', category: 'own_profile' as const, identityMatch: 'name_only' as const, text: `Uwaga na oszustów podszywających się pod nas — nasz jedyny adres to ${BTC_B}.` },
  ]);
  const result = await runAnalysis({ query, connectors: [wall], chainProviders: [fakeProvider()] });
  assert.equal(result.findings.find((item) => item.address === BTC_A)!.evidence.length, 0);
  assert.ok(result.log.some((entry) => entry.message.includes('autor „gosia” ostrzega przed adresem')));
  const dossier = dossierWithDocuments(result, query);
  assert.deepEqual(dossier.persons, []);
  assert.equal(dossier.scamWarnings.addresses[0]!.level, 'reports');
});

test('ostrzeżenie przy adresie podmiotu nie zmienia przypisania jego własnego adresu', async () => {
  // Właściciel podaje adres w profilu; ktoś inny ostrzega przed tym samym adresem — ostrzegający nie zostaje kandydatem.
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], () => [
    { url: 'https://forum.example/u/sprzedawca', author: 'sprzedawca', category: 'own_profile' as const, identityMatch: 'name_only' as const, text: `BTC: ${BTC_A}` },
    { url: 'https://forum.example/t/5', author: 'klient', category: 'forum_post' as const, identityMatch: 'name_only' as const, text: `Uwaga, sprzedawca nie wysłał towaru, oszust! Wpłacałem na ${BTC_A}.` },
  ]);
  const result = await runAnalysis({ query, connectors: [forum], chainProviders: [fakeProvider()] });
  const dossier = dossierWithDocuments(result, query);
  assert.ok(!dossier.persons.some((person) => person.profileIds.includes('forum.example|klient')));
  assert.equal(dossier.scamWarnings.addresses[0]!.level, 'reports');
  assert.match(dossier.scamWarnings.addresses[0]!.interpretation[0]!, /ostrzeżenia go nie wskazują i nie potwierdzają/);
});

test('zatruwanie adresu: sygnał dla kontrahenta-podróbki, nie dla adresu sprawy', () => {
  const genuine = '1AbCdEfGhJkLmNoPqRsTuVwXyZ12345wxyz';
  const fake = `${genuine.slice(0, 6)}${'z'.repeat(genuine.length - 10)}${genuine.slice(-4)}`;
  const transfers = [
    transfer(1, { direction: 'out', counterparty: genuine, time: '2026-01-01T10:00:00Z', amount: 1 }),
    transfer(2, { direction: 'out', counterparty: genuine, time: '2026-02-01T10:00:00Z', amount: 2 }),
    transfer(3, { direction: 'in', counterparty: fake, time: '2026-02-01T10:05:00Z', amount: 0.00001 }),
  ];
  const signals = addressPoisoning({ address: BTC_B, network: 'bitcoin', chain: { ...chainActivity(), transfers } });
  assert.equal(signals.length, 1);
  assert.equal(signals[0]!.lookalike, fake);
  assert.equal(signals[0]!.genuine, genuine);
  const warnings = buildScamWarnings({ findings: [{ ...finding(BTC_B, 0, []), chain: { ...chainActivity(), transfers } }], ...noLists });
  assert.equal(warnings.level, 'none');
  assert.equal(warnings.poisoning.length, 1);
  assert.ok(scamKeyFindings(warnings).some((entry) => entry.text.startsWith('Możliwe zatruwanie adresu')));
  assert.match(renderScamSection(warnings), /zatruwanie adresu/);
});

test('teczka z atrapą łańcucha: brak ostrzeżeń, gdy nic nie wskazuje oszustwa', async () => {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };
  const result = await runAnalysis({ query, connectors: [], chainProviders: [chainWith({})] });
  const dossier = dossierWithDocuments(result, query);
  assert.equal(dossier.scamWarnings.level, 'none');
  assert.equal(renderScamSection(dossier.scamWarnings), '');
});
