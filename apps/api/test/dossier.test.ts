import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkKey } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { computePriority } from '../src/priority.ts';
import { BTC_A, BTC_B, BTC_EXCHANGE, FIXED_NOW, cashOut, chainWith, decision, dossierOf, evidence, fakeConnector, finding, run, transfer } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };
const query = { identifiers: [nick] };
const TRADER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const BROKER = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';

const toExchange = (valueIndex: number, time = '2025-03-14T10:22:00.000Z') =>
  transfer(valueIndex, { counterparty: BTC_EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Giełda Testowa', time, amount: 0.4 });

/** Podmiot z profilem i wpisem na forum, kontrahentem z własnym profilem oraz wspólnym pośrednikiem. */
const scenario = async (cashOutPln = 132_000) => {
  const deposit = toExchange(1);
  const toTrader = transfer(2, { counterparty: TRADER, time: '2025-02-01T09:00:00.000Z', amount: 0.5 });
  const toBroker = transfer(3, { counterparty: BROKER, direction: 'in', time: '2024-12-24T18:00:00.000Z', amount: 0.05 });
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    {
      url: 'https://gitpub.example/krypto_janek',
      author: 'krypto_janek',
      text: `Wsparcie: ${BTC_A}`,
      publishedAt: '2024-06-01T00:00:00.000Z',
      profile: { handle: 'krypto_janek', createdAt: '2023-01-15T00:00:00.000Z' },
    },
  ]);
  const forum = fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) => {
    if (identifier.value === BTC_A) {
      return [
        { url: 'https://forum.example/p/janek', author: 'krypto_janek', category: 'forum_post' as const, text: `Mój adres ${BTC_A}` },
        { url: 'https://forum.example/p/ala', author: 'ala_zbiera', category: 'forum_post' as const, text: `Wpłaty też na ${BTC_A}` },
      ];
    }
    if (identifier.value === TRADER) {
      return [
        { url: 'https://forum.example/u/bartek_p2p', author: 'bartek_p2p', text: `Skup BTC, mój adres: ${TRADER}` },
        // Cudza wypowiedź o adresie kontrahenta nie czyni z autora osoby powiązanej.
        { url: 'https://forum.example/p/plotkarz', author: 'plotkarz', category: 'forum_post' as const, text: `Ktoś widział ${TRADER}?` },
      ];
    }
    return [];
  });
  const chain = chainWith({ [BTC_A]: { transfers: [deposit, toTrader, toBroker], cashOuts: [cashOut(deposit, cashOutPln)] } });
  return { result: await runAnalysis({ query, connectors: [gitpub, forum], chainProviders: [chain] }), forum };
};

test('osoby powiązane: wspólny adres, kontrahent z profilem, wspólny pośrednik z inną sprawą', async () => {
  const { result, forum } = await scenario();
  // Kontrahentów bez etykiety sprawdzamy w źródłach; giełda ma etykietę, więc nie.
  assert.deepEqual(forum.calls.map((call) => call.value).sort(), [BROKER, BTC_A, TRADER].sort());

  const otherRun = {
    ...run('run-inna', [
      {
        ...finding(BTC_B, 85, [evidence('https://gitpub.example/inny')]),
        chain: { ...result.findings[0]!.chain!, transfers: [transfer(9, { counterparty: BROKER, time: '2025-01-01T00:00:00.000Z', amount: 1 })], cashOuts: [] },
      },
    ]),
    caseId: 'sprawa-2',
  };
  const dossier = dossierOf(result, query, { otherCases: [{ caseId: 'sprawa-2', caseName: 'Adam N.', run: otherRun }] });

  const byHandle = new Map(dossier.relatedPersons.map((person) => [person.handle, person]));
  const trader = byHandle.get('bartek_p2p')!;
  assert.equal(trader.relations[0]!.kind, 'transacted');
  assert.equal(trader.strength, 70);
  assert.match(trader.relations[0]!.description, /wysłał na niego łącznie 0,5 BTC/);
  assert.deepEqual(trader.profileUrls, ['https://forum.example/u/bartek_p2p']);

  const coPublisher = byHandle.get('ala_zbiera')!;
  assert.equal(coPublisher.relations[0]!.kind, 'shared_address');
  assert.equal(coPublisher.relations[0]!.via, `bitcoin:${BTC_A}`);
  assert.equal(coPublisher.strength, 60);

  const otherCase = byHandle.get('Adam N.')!;
  assert.equal(otherCase.caseId, 'sprawa-2');
  assert.equal(otherCase.relations[0]!.kind, 'common_counterparty');
  assert.equal(otherCase.strength, 40);
  // Ranking malejąco po sile powiązania.
  assert.deepEqual(dossier.relatedPersons.map((person) => person.strength), [70, 60, 40]);

  // Wcześniejsza sprawa tego samego podmiotu (ten sam identyfikator albo te same adresy) nie jest osobą powiązaną.
  const sameIdentifier = { caseId: 'sprawa-3', caseName: 'Jan K. (stara)', run: { ...otherRun, caseId: 'sprawa-3', query } };
  const sameAddresses = {
    caseId: 'sprawa-4',
    caseName: 'Jan K. po adresie',
    run: { ...run('run-adres', [{ ...finding(BTC_A, 85, [evidence('https://gitpub.example/krypto_janek')]), chain: result.findings[0]!.chain }]), caseId: 'sprawa-4', query: { identifiers: [{ type: 'full_name' as const, value: 'Jan Kowalski' }] } },
  };
  const repeated = dossierOf(result, query, { otherCases: [sameIdentifier, sameAddresses] });
  assert.ok(repeated.relatedPersons.every((person) => !person.caseId));
});

test('graf: wszystkie rodzaje węzłów, krawędzie tylko między istniejącymi węzłami', async () => {
  const { result } = await scenario();
  const { nodes, edges } = dossierOf(result, query).graph;

  assert.deepEqual([...new Set(nodes.map((node) => node.kind))].sort(), ['address', 'identifier', 'operator', 'person', 'persona', 'profile', 'service', 'source', 'subject']);
  for (const kind of ['has_identifier', 'found_profile', 'publishes', 'cash_out', 'related']) {
    assert.ok(edges.some((edge) => edge.kind === kind), `brak krawędzi ${kind}`);
  }
  const ids = new Set(nodes.map((node) => node.id));
  assert.equal(ids.size, nodes.length);
  assert.ok(edges.every((edge) => ids.has(edge.from) && ids.has(edge.to)));
  assert.equal(new Set(edges.map((edge) => edge.id)).size, edges.length);
  // Wnioskowania są oznaczone, fakty nie.
  assert.ok(edges.filter((edge) => edge.kind === 'related').every((edge) => edge.inferred === true));
  assert.ok(edges.filter((edge) => edge.kind === 'publishes').every((edge) => !edge.inferred));
  assert.equal(nodes.find((node) => node.kind === 'address')!.score, 90);
});

test('oś czasu: chronologicznie, z warstwą przy każdym zdarzeniu', async () => {
  const { result } = await scenario();
  const { timeline } = dossierOf(result, query);

  const times = timeline.map((event) => new Date(event.time).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.deepEqual(
    timeline.slice(0, 5).map((event) => [event.kind, event.layer]),
    [
      ['account_created', 'fact'],
      ['publication', 'fact'],
      ['transfer_in', 'fact'],
      ['transfer_out', 'fact'],
      ['cash_out', 'inference'],
    ],
  );
  const payout = timeline.find((event) => event.kind === 'cash_out')!;
  assert.equal(payout.valuePln, 132_000);
  // Przelew będący wskaźnikiem wypłaty nie jest powtórzony jako zwykły wypływ.
  assert.equal(timeline.filter((event) => event.kind === 'transfer_out').length, 1);
});

test('podmiana adresu trafia na oś czasu i do kluczowych ustaleń', async () => {
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_B}` },
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}`, archivedAt: '2025-03-05T12:00:00.000Z' },
  ]);
  const dossier = dossierOf(await runAnalysis({ query, connectors: [gitpub], chainProviders: [chainWith({})] }), query);

  const swap = dossier.timeline.find((event) => event.kind === 'address_replaced')!;
  assert.equal(swap.layer, 'fact');
  assert.equal(swap.address, BTC_B);
  assert.ok(dossier.keyFindings.some((item) => item.layer === 'fact' && /Między 5 marca 2025 r\. a 21 listopada 2026 r\. adres .* został podmieniony/.test(item.text)));
  // Obie wersje to jeden profil.
  assert.equal(dossier.profiles.length, 1);
});

test('kluczowe ustalenia: od osoby, przez usługi, po adres — zdaniami dla laika', async () => {
  const { result } = await scenario();
  const dossier = dossierOf(result, query);
  const texts = dossier.keyFindings.map((item) => item.text);

  assert.ok(texts.length >= 3 && texts.length <= 7);
  assert.match(texts[0]!, /^Najbardziej prawdopodobna osoba posługuje się nazwą „krypto_janek”/);
  assert.equal(dossier.keyFindings[0]!.layer, 'inference');
  assert.match(texts[1]!, /^Podmiot jest powiązany z usługą Giełda Testowa \(giełda\): 1 przelew do usługi o szacunkowej wartości 132 tys\. zł w 2025 r\./);
  assert.ok(texts.some((text) => /^Adres 1A1zP1eP5Q…v7DivfNa opublikowano na własnym profilu w serwisie gitpub\.example i we wpisie na forum forum\.example \(Wskaźnik Pewności 90%/.test(text)));
  assert.ok(texts.some((text) => text.includes('Łączna szacunkowa wartość możliwych wypłat') && text.includes('132 tys. zł')));
  assert.ok(dossier.keyFindings.every((item) => ['fact', 'calculation', 'inference'].includes(item.layer)));

  // Bez żadnych znalezisk nadal są co najmniej trzy zdania.
  const empty = dossierOf(await runAnalysis({ query, connectors: [], chainProviders: [] }), query);
  assert.equal(empty.keyFindings.length, 3);
  assert.equal(empty.totals.priority, 0);
});

test('priorytet: jawne składniki; większe wypłaty nigdy nie obniżają priorytetu', async () => {
  const small = dossierOf((await scenario(8_000)).result, query);
  const large = dossierOf((await scenario(900_000)).result, query);
  assert.ok(large.totals.priority > small.totals.priority);
  assert.equal(large.totals.priorityReasons.length, 6);
  // Pewność łączy Wskaźnik Pewności (adres–autor) z prawdopodobieństwem, że adres należy do osoby ze sprawy.
  const best = large.findings[0]!;
  assert.equal(best.subjectProbability, Math.round((large.persons[0]!.probability * large.persons[0]!.addresses[0]!.probability) / 100));
  assert.ok(best.subjectProbability < best.confidence.score);
  assert.ok(
    large.totals.priorityReasons[0]!.startsWith(
      `Pewność najlepszego adresu: Wskaźnik Pewności 90% i prawdopodobieństwo, że adres należy do osoby ze sprawy, ${best.subjectProbability}% → średnia`,
    ),
  );
  assert.ok(large.keyFindings.some((item) => item.text.includes(`łączne prawdopodobieństwo, że adres należy do osoby ze sprawy: ${best.subjectProbability}%`)));
  assert.deepEqual(large.totals.cashOutPlnByYear, { '2025': 900_000 });

  const base = { topScore: 80, independentSources: 2, serviceStrengths: [70], lastCashOutAt: '2025-03-14T10:22:00.000Z', now: FIXED_NOW() };
  let previous = -1;
  for (const cashOutPlnTotal of [0, 1, 500, 10_000, 99_999, 100_000, 1_000_000, 50_000_000]) {
    const { priority } = computePriority({ ...base, cashOutPlnTotal });
    assert.ok(priority >= previous, `priorytet spadł przy ${cashOutPlnTotal} zł`);
    assert.ok(priority >= 0 && priority <= 100);
    previous = priority;
  }
  // Stara wypłata waży mniej niż świeża; brak danych daje zero.
  const recent = computePriority({ ...base, cashOutPlnTotal: 100_000 }).priority;
  const old = computePriority({ ...base, cashOutPlnTotal: 100_000, lastCashOutAt: '2019-01-01T00:00:00.000Z' }).priority;
  assert.ok(old < recent);
  assert.equal(computePriority({ topScore: 0, cashOutPlnTotal: 0, independentSources: 0, serviceStrengths: [], now: FIXED_NOW() }).priority, 0);
});

test('decyzje: odrzucenie profilu obniża wynik adresu, potwierdzenie podnosi, usunięcie przywraca', async () => {
  const { result } = await scenario();
  const scoreOf = (decisions = [] as ReturnType<typeof decision>[]) =>
    dossierOf(result, query, { decisions }).findings.find((item) => item.address === BTC_A)!.confidence.score;

  // Automatycznie: 85 (własny profil) − 10 (sam nick) + 15 (drugie źródło).
  assert.equal(scoreOf(), 90);
  const rejectProfile = decision('profile', 'gitpub.example|krypto_janek', 'rejected');
  // Zostaje sam wpis na forum.
  assert.equal(scoreOf([rejectProfile]), 50);
  assert.equal(scoreOf([decision('profile', 'gitpub.example|krypto_janek', 'confirmed')]), 100);
  // Obowiązuje najnowsza decyzja; po usunięciu wszystkich wynik wraca.
  assert.equal(scoreOf([rejectProfile, decision('profile', 'gitpub.example|krypto_janek', 'confirmed')]), 100);
  assert.equal(scoreOf([]), 90);
  // Zapisana analiza pozostaje nietknięta.
  assert.equal(result.findings[0]!.confidence.score, 90);
  assert.equal(result.findings[0]!.evidence.length, 2);

  const rejected = dossierOf(result, query, { decisions: [rejectProfile] });
  assert.equal(rejected.profiles.find((profile) => profile.id === 'gitpub.example|krypto_janek')!.decision, 'rejected');
  assert.equal(rejected.decisions.length, 1);
});

test('decyzje: odrzucony adres wypada z sum i priorytetu, z adnotacją', async () => {
  const { result } = await scenario();
  const before = dossierOf(result, query);
  const after = dossierOf(result, query, { decisions: [decision('address', `bitcoin:${BTC_A}`, 'rejected', 'adres zbiórki')] });
  const [item] = after.findings;

  assert.equal(item!.confidence.excluded, true);
  assert.equal(item!.confidence.score, 0);
  assert.equal(item!.decision, 'rejected');
  assert.equal(item!.confidence.ledger.at(-1)!.rule, 'decision.address_rejected');
  assert.match(item!.annotations!.at(-1)!, /Adres odrzucony przez analityka .*adres zbiórki/);
  assert.deepEqual([before.totals.linkedAddresses, after.totals.linkedAddresses], [1, 0]);
  assert.deepEqual([before.totals.excludedAddresses, after.totals.excludedAddresses], [0, 1]);
  assert.deepEqual(after.totals.cashOutPlnByYear, {});
  assert.equal(after.serviceLinks.length, 0);
  assert.ok(after.totals.priority < before.totals.priority);
  assert.ok(after.graph.nodes.find((node) => node.kind === 'address')!.excluded);

  // Potwierdzenie adresu jest tylko odnotowane.
  const confirmed = dossierOf(result, query, { decisions: [decision('address', BTC_A, 'confirmed')] });
  assert.equal(confirmed.findings[0]!.confidence.score, 90);
  assert.equal(confirmed.findings[0]!.decision, 'confirmed');
});

// ---------- Decyzje o parach kont (hipoteza wspólnego operatora) ----------

const mail = { type: 'email' as const, value: 'jan.kowalski@poczta.example' };
const GITPUB = 'gitpub.example|jkowalski';
const FORUM = 'forum.example|krypto_janek';
const TARG = 'targ.example|julka_k';

/** Dwa konta z tym samym e-mailem (automatycznie jedna osoba) oraz oferta innej osoby z adresem podmiotu. */
const linkScenario = async () => {
  const linkQuery = { identifiers: [mail, nick] };
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    { url: 'https://gitpub.example/jkowalski', author: 'jkowalski', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'jkowalski', displayName: 'Jan Kowalski', emails: [mail.value] } },
  ]);
  const forum = fakeConnector('forum', 'forum.example', ['nick'], () => [
    { url: 'https://forum.example/u/krypto_janek', author: 'krypto_janek', category: 'sale_offer' as const, text: `Sprzedam, płatność ${BTC_B}`, profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski', emails: [mail.value] } },
  ]);
  const targ = fakeConnector('targ', 'targ.example', ['crypto_address'], (identifier) =>
    identifier.value === BTC_A
      ? [{ url: 'https://targ.example/oferta/9', author: 'julka_k', category: 'sale_offer' as const, text: `Sprzedam telefon, wpłata na ${BTC_A}`, profile: { handle: 'julka_k', displayName: 'Julia Kowalska' } }]
      : [],
  );
  const result = await runAnalysis({ query: linkQuery, connectors: [gitpub, forum, targ], chainProviders: [chainWith({})] });
  return { result, linkQuery };
};

test('decyzja „to nie ten sam operator” rozdziela konta i przelicza osoby, tożsamości, wskaźniki i graf', async () => {
  const { result, linkQuery } = await linkScenario();
  const auto = dossierOf(result, linkQuery);
  const pair = (dossier: typeof auto, x: string, y: string) => dossier.indicators.commonOperator.find((item) => item.id === linkKey(x, y))!;

  // Automatycznie: wspólny e-mail łączy oba konta w jedną osobę; adres drugiego konta liczy się podmiotowi.
  assert.deepEqual([...auto.persons[0]!.profileIds].sort(), [FORUM, GITPUB]);
  assert.equal(pair(auto, GITPUB, FORUM).status, 'auto_grouped');
  assert.equal(auto.totals.linkedAddresses, 2);

  // Klucz w dowolnej kolejności i wielkości liter wskazuje tę samą parę.
  const reject = decision('link', `${FORUM.toUpperCase()}<->${GITPUB}`, 'rejected', 'różne osoby — ustalenia z akt');
  const rejected = dossierOf(result, linkQuery, { decisions: [reject] });
  assert.equal(rejected.persons.length, 2);
  assert.deepEqual(rejected.persons.map((person) => person.profileIds), [[GITPUB], [FORUM]]);
  assert.match(rejected.persons[0]!.blockedMerges![0]!.reason, /decyzja analityka: konta .* nie mają wspólnego operatora/);
  // Hipoteza: status, wyzerowany wskaźnik, decyzja i składnik z jej identyfikatorem.
  const hypothesis = pair(rejected, GITPUB, FORUM);
  assert.deepEqual([hypothesis.status, hypothesis.indicator.score, hypothesis.decision!.decision, hypothesis.decision!.id, hypothesis.decision!.note], ['rejected', 0, 'rejected', reject.id, 'różne osoby — ustalenia z akt']);
  const veto = hypothesis.indicator.components.find((item) => item.rule === 'operator.conflict.analyst_rejected')!;
  assert.deepEqual([veto.blocking, veto.evidence[0]], [true, { kind: 'decision', value: reject.id }]);
  // Przesłanki pozostają widoczne — decyzja ich nie ukrywa.
  assert.ok(hypothesis.indicator.components.some((item) => item.rule === 'operator.same_email'));
  // Odłączone konto jest powiązaną tożsamością z odnotowanym odrzuceniem.
  const identity = rejected.linkedIdentities.find((item) => item.accounts.includes(FORUM))!;
  assert.deepEqual([identity.id, identity.status, identity.decision, identity.accounts], [`tozsamosc:${FORUM}`, 'rejected', 'rejected', [FORUM]]);
  // Adres znany tylko z odłączonego konta przestaje być adresem podmiotu.
  assert.equal(auto.findings.find((item) => item.address === BTC_B)!.confidence.score, 70);
  assert.equal(rejected.findings.find((item) => item.address === BTC_B)!.confidence.score, 0);
  assert.equal(rejected.totals.linkedAddresses, 1);
  assert.notDeepEqual(rejected.graph, auto.graph);
  assert.notDeepEqual(rejected.keyFindings, auto.keyFindings);
  // Pozostałe hipotezy są nietknięte.
  assert.deepEqual(pair(rejected, GITPUB, TARG), pair(auto, GITPUB, TARG));
});

test('potwierdzenie pary kont scala je mimo różnych nazwisk; wycofanie decyzji przywraca wynik automatyczny i zostaje w rejestrze', async () => {
  const { result, linkQuery } = await linkScenario();
  const auto = dossierOf(result, linkQuery);
  const key = linkKey(GITPUB, TARG);

  // Automatycznie: ten sam adres publikowany jako własny, ale różne nazwiska — hipoteza zablokowana, konto osobno.
  const before = auto.indicators.commonOperator.find((item) => item.id === key)!;
  assert.equal(before.status, 'blocked');
  assert.ok(before.indicator.score <= 45);
  assert.ok(before.indicator.components.some((item) => item.rule === 'operator.conflict.declared_name' && item.blocking));
  assert.ok(!auto.persons[0]!.profileIds.includes(TARG));
  assert.ok(auto.linkedIdentities.some((identity) => identity.accounts.includes(TARG) && identity.status === 'hypothesis'));
  assert.equal(auto.persons[0]!.status, 'hypothesis');

  const confirm = decision('link', key, 'confirmed', 'ten sam numer rachunku w aktach');
  const confirmed = dossierOf(result, linkQuery, { decisions: [confirm] });
  assert.deepEqual([...confirmed.persons[0]!.profileIds].sort(), [FORUM, GITPUB, TARG]);
  assert.equal(confirmed.persons[0]!.status, 'confirmed');
  assert.ok(confirmed.persons[0]!.reasons.some((reason) => reason.includes('decyzją analityka o wspólnym operatorze')));
  assert.ok(!confirmed.linkedIdentities.some((identity) => identity.accounts.includes(TARG)));
  const after = confirmed.indicators.commonOperator.find((item) => item.id === key)!;
  assert.deepEqual([after.status, after.indicator.score, after.decision!.id], ['confirmed', 100, confirm.id]);
  assert.ok(after.indicator.components.some((item) => item.rule === 'operator.analyst_confirmed'));
  assert.match(after.statement, /przyjęty decyzją analityka/);
  assert.notDeepEqual(confirmed.graph, auto.graph);

  // Wycofanie: wpis zostaje w rejestrze z czasem i autorem wycofania, a wynik jest dokładnie automatyczny.
  const withdrawnRecord = { ...confirm, withdrawnAt: '2026-11-21T11:00:00.000Z', withdrawnBy: 'analityk' };
  const withdrawn = dossierOf(result, linkQuery, { decisions: [withdrawnRecord] });
  assert.deepEqual(withdrawn.decisions, [withdrawnRecord]);
  assert.deepEqual({ ...withdrawn, decisions: [] }, { ...auto, decisions: [] });
  // Nowa decyzja po wycofanej działa normalnie, a historia zachowuje oba wpisy.
  const again = dossierOf(result, linkQuery, { decisions: [withdrawnRecord, { ...decision('link', key, 'rejected'), id: 'd-druga' }] });
  assert.equal(again.indicators.commonOperator.find((item) => item.id === key)!.status, 'rejected');
  assert.equal(again.decisions.length, 2);
});

test('wyjście do walut tradycyjnych: ostatni szczebel tylko po decyzji analityka; wycofanie przywraca poprzedni', async () => {
  const { result } = await scenario();
  const key = `bitcoin:${BTC_A}`;
  const order = ['onchain_transfer', 'service_interaction', 'cashout_signal', 'documented_fiat_exit'];
  const best = (decisions: ReturnType<typeof decision>[]) => {
    const items = dossierOf(result, query, { decisions }).indicators.cashOut.filter((item) => item.address === BTC_A);
    return items.sort((a, b) => order.indexOf(b.stage) - order.indexOf(a.stage))[0]!;
  };

  // Same dane blockchain (wpłata na giełdę) nie dają udokumentowanego wyjścia.
  const auto = best([]);
  assert.ok(order.indexOf(auto.stage) < order.indexOf('documented_fiat_exit'));
  assert.notEqual(auto.status, 'confirmed');
  // Decyzja z podstawą spoza blockchaina: najwyższy szczebel, status „potwierdzone”.
  const documented = decision('cashout', key, 'confirmed', 'odpowiedź giełdy z 3.11.2026 — wypłata na rachunek');
  assert.deepEqual([best([documented]).stage, best([documented]).status], ['documented_fiat_exit', 'confirmed']);
  // Decyzja „odrzucony” jest tylko odnotowana; wycofanie przywraca wynik automatyczny, a wpis zostaje w rejestrze.
  assert.deepEqual(best([decision('cashout', key, 'rejected')]), auto);
  const withdrawn = { ...documented, withdrawnAt: '2026-11-21T11:00:00.000Z', withdrawnBy: 'analityk' };
  assert.deepEqual(best([withdrawn]), auto);
  assert.deepEqual(dossierOf(result, query, { decisions: [withdrawn] }).decisions, [withdrawn]);
});

test('źródła, które nie odpowiedziały: teczka wykazuje je wprost i nie udaje pełnego wyniku', async () => {
  const { result } = await scenario();
  const clean = dossierOf(result, query);
  assert.deepEqual(clean.sourceErrors, []);
  assert.ok(!clean.explanations.some((item) => item.kind === 'source_errors'));
  assert.deepEqual(clean.expansion, result.intel.expansion);

  const sourceErrors = [
    { connectorId: 'forum', stage: 'search', message: 'fetch failed', count: 2 },
    { providerId: 'atrapa-chain', stage: 'chain', message: 'limit zapytań', count: 1, addresses: [`bitcoin:${BTC_A}`] },
  ];
  // Adres bez danych dostawcy: brak danych, a nie „brak aktywności”.
  const findings = result.findings.map((item) => ({ ...item, chain: undefined, chainUnavailable: true }));
  const dossier = dossierOf({ ...result, findings, intel: { ...result.intel, sourceErrors } }, query);
  assert.deepEqual(dossier.sourceErrors, sourceErrors);
  const note = dossier.explanations.find((item) => item.kind === 'source_errors')!;
  assert.match(note.text, /^Część źródeł nie odpowiedziała \(forum, atrapa-chain\): wynik jest częściowy; brakujących danych nie uzupełniano\. Dla 1 adresu nie ma danych z blockchaina — to brak danych, a nie brak aktywności\./);
  // Bez danych z blockchaina nie ma sum ani wniosku „brak wypłat”.
  assert.deepEqual(dossier.totals.cashOutPlnByYear, {});
  assert.ok(dossier.explanations.some((item) => item.kind === 'chain_skipped'));
  assert.ok(!dossier.explanations.some((item) => item.kind === 'no_cash_out'));
  assert.deepEqual(dossier.indicators.cashOut, []);
});
