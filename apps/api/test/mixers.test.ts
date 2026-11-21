// Miksery i CoinJoin: ekspozycja adresów sprawy, wskaźniki C i D, graf, ustalenia i raport.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Finding, GraphEdge, GraphNode, InvestigationIndicators, Transfer } from '@olcys/core';
import { combineComponents } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import {
  COINJOIN_RULES,
  MIXER_PRIVACY_NOTE,
  applyMixerGraph,
  applyMixerIndicators,
  buildMixerExposure,
  coinjoinLike,
  coinjoinPattern,
  mixerKeyFindings,
  mixerLabelStatus,
  renderMixerSection,
} from '../src/mixers.ts';
import type { MixerGraphNode } from '../src/mixers.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, BTC_EXCHANGE, cashOut, chainWith, dossierOf, evidence, fakeActivity, fakeConnector, finding, transfer } from './helpers.ts';

const MIXER = '3K35dyL85fR9ht7UgzPfd1gLRRXQtNTqE3';
const PREMIX = ['1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX', '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'];
const CITED = 'Zbiór etykiet testowy; https://etykiety.example/mikser — sprawdzono 2026-11-01';

const toMixer = (index: number, extra: Partial<Transfer> = {}) =>
  transfer(index, { counterparty: MIXER, counterpartyClass: 'mixer', counterpartyLabel: 'WirMix: pula 0,05 BTC', time: '2026-03-10T10:00:00.000Z', amount: 0.3, ...extra });
const toExchange = (index: number, time = '2026-03-12T10:00:00.000Z') =>
  transfer(index, { counterparty: BTC_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Giełda Testowa', time, amount: 0.2 });

/** Adres sprawy z danymi blockchain: przelewy, wskaźniki wypłat (z wyceną) i ograniczenia modułu. */
function chainFinding(address: string, transfers: Transfer[], options: { limitations?: string[]; cashOuts?: ReturnType<typeof cashOut>[] } = {}): Finding {
  return {
    ...finding(address, 85, [evidence(`https://gitpub.example/${address}`)]),
    chain: { ...fakeActivity('bitcoin', address, 'private'), transfers, cashOuts: options.cashOuts ?? [], cashOutPlnByYear: {}, limitations: options.limitations ?? [] },
  };
}

const keys = (...findings: Finding[]) => new Set(findings.map((item) => `${item.network}:${item.address}`));
const noLists = () => [];

test('przelew na oznaczony mikser: poziom „potwierdzony”, etykieta z cytowanego zbioru = fakt źródłowy, wycena PLN z istniejących wycen', () => {
  const exchange = toExchange(2);
  const subject = chainFinding(BTC_A, [toMixer(1, { counterpartyLabelSource: CITED } as Partial<Transfer>), exchange], { cashOuts: [cashOut(exchange, 80_000)] });
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });

  assert.equal(exposure.level, 'confirmed');
  assert.equal(exposure.outgoing.length, 1);
  const [item] = exposure.outgoing;
  assert.equal(item!.status, 'source_fact');
  assert.equal(item!.mixerName, 'WirMix');
  assert.equal(item!.mixerAddress, MIXER);
  // Kurs z wyceny wpłaty na giełdę (0,2 BTC = 80 000 zł) → 0,3 BTC ≈ 120 000 zł.
  assert.equal(item!.valuePln, 120_000);
  assert.match(item!.rateNote!, /przyjęty z wyceny transakcji/);
  assert.equal(exposure.totals.outPln, 120_000);
  assert.equal(exposure.totals.transactions, 1);
  assert.match(exposure.statement, /^Środki przeszły przez mikser \(WirMix, 1 transakcja, ok\. 120 tys\. zł do miksera\) — dalszej drogi nie da się ustalić z blockchainu\.$/);
  // Neutralne zdanie o prywatności — jedno, w ograniczeniach; żadnych wniosków o osobie.
  assert.ok(exposure.limitations.includes(MIXER_PRIVACY_NOTE));
  assert.ok(!/przestęp|prani|nielegal/i.test([exposure.statement, ...exposure.limitations].join(' ')));
});

test('status etykiety: cytowany zbiór → fakt, rozpoznanie po nazwie → hipoteza, klasa od dostawcy → obliczenie', () => {
  assert.equal(mixerLabelStatus(CITED), 'source_fact');
  assert.equal(mixerLabelStatus('WalletExplorer (klasa rozpoznana po nazwie w etykiecie)'), 'hypothesis');
  assert.equal(mixerLabelStatus('Eksplorator sandbox (dane syntetyczne) (klasa podana przez źródło)'), 'computed');
  assert.equal(mixerLabelStatus(undefined), 'computed');
});

test('heurystyka CoinJoin: równe wyjścia do różnych adresów w jednej transakcji — hipoteza z wyjaśnieniem; Whirlpool po nominale', () => {
  const tx = '9'.repeat(64);
  const equal = PREMIX.map((counterparty, index) => ({ ...transfer(10 + index, { counterparty, time: '2026-04-01T08:00:00.000Z', amount: 0.05 }), txid: tx }));
  const subject = chainFinding(BTC_A, equal);
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });

  assert.equal(exposure.level, 'possible');
  assert.equal(exposure.coinjoins.length, 1);
  const [cj] = exposure.coinjoins;
  assert.equal(cj!.status, 'hypothesis');
  assert.equal(cj!.basis, 'equal_outputs');
  assert.equal(cj!.equalOutputs, 4);
  assert.equal(cj!.pattern, 'whirlpool');
  assert.match(cj!.explanation, /^HIPOTEZA: .*4 przelewy o identycznej kwocie 0,05 BTC do 4 różnych adresów.*Whirlpool/);
  assert.ok(exposure.limitations.some((item) => item.startsWith('Heurystyka CoinJoin')));
  assert.equal(mixerKeyFindings(exposure)[0]!.layer, 'inference');

  // Ta sama struktura w Ethereum (model kont) to zwykle wypłata zbiorcza — heurystyki nie stosujemy.
  assert.deepEqual(coinjoinLike('ethereum', BTC_A, equal), []);
  // Dwa równe wyjścia to za mało; wypłata zbiorcza z udziałem giełdy też się nie liczy.
  assert.deepEqual(coinjoinLike('bitcoin', BTC_A, equal.slice(0, COINJOIN_RULES.minEqualOutputs - 1)), []);
  assert.deepEqual(coinjoinLike('bitcoin', BTC_A, [...equal, { ...toExchange(20), txid: tx }]), []);
  assert.equal(coinjoinPattern(0.1, 12), 'wasabi');
  assert.equal(coinjoinPattern(0.0731, 5), undefined);
});

test('przelew z miksera: pochodzenie środków zatarte; ostrzeżenia śledzenia: CoinJoin i mikser za adresem pośrednim', () => {
  const inflow = toMixer(3, { direction: 'in', time: '2026-05-02T10:00:00.000Z', amount: 0.25 });
  const stops = [
    `OSTRZEŻENIE — mikser: środki trafiły do „transakcja typu CoinJoin” (${BTC_A}, tx ${'c'.repeat(64)}). Dalszej drogi środków nie da się wiarygodnie ustalić; użycie miksera wymaga osobnej oceny.`,
    `OSTRZEŻENIE — mikser: środki trafiły do „Tornado Cash: pula 10 ETH” (${BTC_D}, tx ${'d'.repeat(64)}). Dalszej drogi środków nie da się wiarygodnie ustalić; użycie miksera wymaga osobnej oceny.`,
  ];
  const subject = chainFinding(BTC_A, [inflow], { limitations: stops });
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });

  assert.equal(exposure.level, 'confirmed');
  assert.equal(exposure.incoming.length, 1);
  assert.equal(exposure.incoming[0]!.direction, 'from_mixer');
  assert.match(exposure.statement, /pochodzenie środków zatarte/);
  assert.equal(exposure.traceStops.length, 2);
  assert.deepEqual(exposure.coinjoins.map((item) => [item.basis, item.txid]), [['trace', 'c'.repeat(64)]]);
  const indirect = exposure.traceStops.find((item) => !item.coinjoin)!;
  assert.equal(indirect.mixerLabel, 'Tornado Cash: pula 10 ETH');
  assert.equal(indirect.direct, false);
  const texts = mixerKeyFindings(exposure);
  assert.deepEqual(texts.map((item) => item.layer), ['fact', 'inference']);
  assert.match(texts[0]!.text, /1 przelew z miksera — pochodzenie środków zatarte/);
  assert.match(texts[1]!.text, /mikserze za adresem pośrednim/);
});

test('brak ekspozycji: poziom „brak”, bez ograniczeń, ustaleń i sekcji raportu; adres giełdy i adres wykluczony się nie liczą', () => {
  const subject = chainFinding(BTC_A, [toExchange(4), transfer(5, { counterparty: BTC_B, time: '2026-01-01T00:00:00.000Z', amount: 1 })]);
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });
  assert.equal(exposure.level, 'none');
  assert.deepEqual(exposure.limitations, []);
  assert.deepEqual(mixerKeyFindings(exposure), []);
  assert.equal(renderMixerSection(exposure), '');

  // Adres spoza powiązanych i adres o klasie usługi nie dają ekspozycji podmiotu.
  const other = chainFinding(BTC_C, [toMixer(6)]);
  assert.equal(buildMixerExposure({ findings: [other], linkedKeys: new Set(), sanctionsCheck: noLists }).level, 'none');
  const service = { ...other, chain: { ...other.chain!, profile: { ...other.chain!.profile, addressClass: 'exchange' as const } } };
  assert.equal(buildMixerExposure({ findings: [service], linkedKeys: keys(service), sanctionsCheck: noLists }).level, 'none');
});

test('lista sankcyjna: trafienie adresu miksera to fakt o liście z migawki; błąd list nie blokuje oceny', () => {
  const subject = chainFinding(BTC_A, [toMixer(7)]);
  const flag = {
    address: MIXER,
    list: 'ofac-sdn' as const,
    listLabel: 'OFAC SDN',
    entryId: '123',
    entryName: 'BLENDER.IO',
    asset: 'XBT',
    page: 'https://sanctionssearch.ofac.treas.gov/',
    retrievedAt: '2026-11-21T12:00:00.000Z',
    status: 'source_fact' as const,
    label: 'adres na liście sankcyjnej OFAC SDN',
    caveat: 'To fakt o liście, nie ustalenie, kto dziś dysponuje adresem.',
  };
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: () => [flag] });
  assert.deepEqual(exposure.sanctions.map((item) => [item.list, item.entryName]), [['OFAC SDN', 'BLENDER.IO']]);
  assert.match(mixerKeyFindings(exposure)[0]!.text, /figuruje na liście OFAC SDN \(wpis 123: „BLENDER\.IO”, migawka z 2026-11-21\) — fakt o liście\./);
  assert.match(renderMixerSection(exposure), /Adresy mikserów na listach sankcyjnych \(fakt o liście\)/);

  const broken = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: () => { throw new Error('brak migawki'); } });
  assert.equal(broken.level, 'confirmed');
  assert.ok(broken.limitations.some((item) => /Nie udało się sprawdzić adresów mikserów/.test(item)));
});

test('wskaźniki: C dostaje składniki informacyjne mixer_obfuscation i mixer_inflow (waga 0), D — kontekst business.mixer_use; wynik bez zmian', () => {
  const subject = chainFinding(BTC_A, [toMixer(8), toMixer(9, { direction: 'in', time: '2026-06-01T00:00:00.000Z' })]);
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });
  const onchain = { id: `bitcoin:${BTC_A}:onchain`, address: BTC_A, network: 'bitcoin', stage: 'onchain_transfer' as const, txids: [], indicator: combineComponents('cash_out', [{ rule: 'cashout.onchain_transfer', weight: 5, direction: 'supports', source: 'test', evidence: [], explanation: 'x', limitations: [] }]), status: 'computed' as const, statement: '', origin: 'chain' as const };
  const indicators: InvestigationIndicators = {
    accountWallet: [],
    commonOperator: [],
    cashOut: [onchain],
    businessActivity: { indicator: combineComponents('business_activity', []) } as InvestigationIndicators['businessActivity'],
  };
  applyMixerIndicators(indicators, exposure);
  const rules = onchain.indicator.components.map((item) => item.rule);
  assert.deepEqual(rules, ['cashout.onchain_transfer', 'cashout.mixer_obfuscation', 'cashout.mixer_inflow']);
  const obfuscation = onchain.indicator.components[1]!;
  assert.equal(obfuscation.direction, 'contradicts');
  assert.equal(obfuscation.applied, 0);
  assert.match(obfuscation.explanation, /^Droga do walut tradycyjnych przerwana: 1 przelew na adres miksera \(WirMix\)/);
  assert.equal(onchain.indicator.score, 5);
  assert.ok(onchain.indicator.limitations.some((item) => /przeszła przez mikser/.test(item)));
  assert.deepEqual(indicators.businessActivity!.indicator.components.map((item) => [item.rule, item.applied]), [['business.mixer_use', 0]]);
});

test('graf: węzeł miksera ma oznaczenie i podpis, krawędzie „do miksera” / „z miksera” w warstwie blockchain, CoinJoin — węzeł hipotezy', () => {
  const tx = '7'.repeat(64);
  const equal = PREMIX.slice(0, 3).map((counterparty, index) => ({ ...transfer(30 + index, { counterparty, time: '2026-04-01T08:00:00.000Z', amount: 0.01 }), txid: tx }));
  const subject = chainFinding(BTC_A, [toMixer(11), toMixer(12, { direction: 'in', time: '2026-06-01T00:00:00.000Z' }), ...equal]);
  const exposure = buildMixerExposure({ findings: [subject], linkedKeys: keys(subject), sanctionsCheck: noLists });
  const addressNode = `addr:bitcoin:${BTC_A}`;
  // Krawędź „do miksera” istnieje już z powiązań z usługami — dostaje przedrostek; „z miksera” powstaje.
  const graph: { nodes: GraphNode[]; edges: GraphEdge[] } = {
    nodes: [{ id: addressNode, kind: 'address', label: 'adres' }, { id: 'svc:wirmix', kind: 'service', label: 'WirMix', sublabel: 'mikser' }],
    edges: [{ id: 'e1', from: addressNode, to: 'svc:wirmix', kind: 'transfer', label: '1 przel.', status: 'source_fact' }],
  };
  applyMixerGraph(graph, exposure, [{ id: 'wirmix', name: 'WirMix', kind: 'mixer' } as never]);

  const mixer = graph.nodes.find((node) => node.id === 'svc:wirmix') as MixerGraphNode;
  assert.deepEqual(mixer.mixer, { kind: 'labelled' });
  assert.equal(mixer.sublabel, 'mikser — dalsza droga środków nieustalona');
  assert.equal(graph.edges.find((edge) => edge.id === 'e1')!.label, 'do miksera: 1 przel.');
  assert.equal(graph.edges.find((edge) => edge.id === 'e1')!.layer, 'chain');
  const back = graph.edges.find((edge) => edge.from === 'svc:wirmix' && edge.to === addressNode)!;
  assert.match(back.label!, /^z miksera: 1 przelew/);
  assert.equal(back.layer, 'chain');
  const cjNode = graph.nodes.find((node) => node.id === `coinjoin:bitcoin:${tx}`) as MixerGraphNode;
  assert.equal(cjNode.status, 'hypothesis');
  assert.deepEqual(cjNode.mixer, { kind: 'coinjoin' });
  const cjEdge = graph.edges.find((edge) => edge.to === cjNode.id)!;
  assert.equal(cjEdge.status, 'hypothesis');
  assert.equal(cjEdge.label, 'do CoinJoin: 3 × 0,01 BTC (hipoteza)');
});

test('teczka: przelewy do i z miksera w danych blockchain → ekspozycja, ustalenie, wskaźnik C, węzeł miksera w grafie i sekcja raportu', async () => {
  const nick = { type: 'nick' as const, value: 'leon_wir' };
  const query = { identifiers: [nick] };
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/leon_wir', author: 'leon_wir', text: `Wsparcie: ${BTC_A}` }]);
  const exchange = toExchange(41, '2026-03-11T10:00:00.000Z');
  const out = toMixer(42);
  const back = toMixer(43, { direction: 'in', time: '2026-04-20T10:00:00.000Z', amount: 0.28 });
  const chain = chainWith({ [BTC_A]: { transfers: [out, back, exchange], cashOuts: [cashOut(exchange, 80_000)] } });
  const dossier = dossierOf(await runAnalysis({ query, connectors: [gitpub], chainProviders: [chain] }), query);

  const exposure = dossier.mixerExposure;
  assert.equal(exposure.level, 'confirmed');
  assert.deepEqual(exposure.mixers, ['WirMix']);
  assert.equal(exposure.totals.outCount, 1);
  assert.equal(exposure.totals.inCount, 1);
  assert.equal(exposure.outgoing[0]!.valuePln, 120_000);
  assert.ok(dossier.keyFindings.some((item) => item.layer === 'fact' && /^Środki przeszły przez mikser \(WirMix\): 1 przelew do miksera \(ok\. 120 tys\. zł\); 1 przelew z miksera/.test(item.text)));

  const assessment = dossier.indicators.cashOut.find((item) => item.address === BTC_A && item.id.endsWith(':onchain'))!;
  assert.ok(assessment.indicator.components.some((item) => item.rule === 'cashout.mixer_obfuscation'));
  assert.ok(assessment.indicator.components.some((item) => item.rule === 'cashout.mixer_inflow'));

  const node = dossier.graph.nodes.find((item) => (item as Partial<MixerGraphNode>).mixer) as MixerGraphNode;
  assert.equal(node.kind, 'service');
  assert.equal(node.label, 'WirMix');
  const labels = dossier.graph.edges.filter((edge) => edge.from === node.id || edge.to === node.id).map((edge) => edge.label ?? '');
  assert.ok(labels.some((label) => label.startsWith('do miksera')));
  assert.ok(labels.some((label) => label.startsWith('z miksera')));

  const html = renderMixerSection(exposure);
  assert.match(html, /<h2>Miksery i CoinJoin<\/h2>/);
  assert.match(html, new RegExp(out.txid.slice(0, 10)));
  assert.match(html, /https:\/\/explorer\.example\/tx\//);
});

test('teczka bez mikserów: poziom „brak” i niezmienione kluczowe ustalenia', async () => {
  const query = { identifiers: [{ type: 'nick' as const, value: 'czysty' }] };
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/czysty', author: 'czysty', text: `Wsparcie: ${BTC_A}` }]);
  const dossier = dossierOf(await runAnalysis({ query, connectors: [gitpub], chainProviders: [chainWith({ [BTC_A]: { transfers: [toExchange(50)] } })] }), query);
  assert.equal(dossier.mixerExposure.level, 'none');
  assert.ok(!dossier.keyFindings.some((item) => /mikser/i.test(item.text)));
  assert.ok(!dossier.graph.nodes.some((item) => (item as Partial<MixerGraphNode>).mixer));
});
