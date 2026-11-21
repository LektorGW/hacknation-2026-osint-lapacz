import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutTrail, ChainProvider, Identifier } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { handleStem, linkedAddressesOf } from '../src/pivot.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, cashOut, chainWith, decision, dossierOf, fakeActivity, fakeAi, fakeConnector, fakeProvider, transfer } from './helpers.ts';

const email: Identifier = { type: 'email', value: 'rafal.kowalski@poczta.example' };
const query = { identifiers: [email] };
const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const DEPOSIT = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';

/** Profil podmiotu znaleziony po e-mailu, z adresem, telefonem i stroną. */
const subjectProfile = (extra: Record<string, unknown> = {}) =>
  fakeConnector('gitpub', 'gitpub.example', ['email'], () => [
    {
      url: 'https://gitpub.example/rkowalski92',
      author: 'rkowalski92',
      text: `Wsparcie: ${BTC_A}`,
      profile: { handle: 'rkowalski92', displayName: 'Rafał Kowalski', emails: ['rafal.kowalski@poczta.example'], phones: ['+48 600 100 200'], location: 'Radom', ...extra },
    },
  ]);

test('ta sama osoba pod innym nazwiskiem: ten sam adres publikowany jako własny', async () => {
  // Wyszukiwanie wystąpień adresu znajduje ofertę innej osoby z tym samym adresem do wpłaty.
  const targ = fakeConnector('targ', 'targ.example', ['crypto_address'], (identifier) =>
    identifier.value === BTC_A
      ? [
          { url: 'https://targ.example/oferta/9', author: 'julka_k', category: 'sale_offer' as const, text: `Sprzedam telefon, wpłata na ${BTC_A}`, profile: { handle: 'julka_k', displayName: 'Julia Kowalska' } },
          // Komentarz o adresie to wzmianka — jego autor nie jest powiązaną tożsamością.
          { url: 'https://targ.example/komentarz/1', author: 'gapowicz', category: 'forum_post' as const, text: `Ktoś zna ${BTC_A}?` },
        ]
      : [],
  );
  const result = await runAnalysis({ query, connectors: [subjectProfile(), targ], chainProviders: [fakeProvider()] });
  const dossier = dossierOf(result, query);

  // Inne imię i nazwisko: nie jest scalana z osobą główną…
  assert.deepEqual(dossier.persons.map((person) => person.fullName), ['Rafał Kowalski']);
  assert.deepEqual(dossier.profiles.map((profile) => profile.id), ['gitpub.example|rkowalski92']);
  // …tylko pokazana jako powiązana tożsamość z wynikiem, dowodami i ścieżką.
  assert.equal(dossier.linkedIdentities.length, 1);
  const [identity] = dossier.linkedIdentities;
  assert.deepEqual([identity!.id, identity!.displayName, identity!.fullName, identity!.relation, identity!.score], ['tozsamosc:julka_k', 'Julia Kowalska', 'Julia Kowalska', 'same_person_likely', 85]);
  assert.deepEqual(identity!.handles, ['julka_k']);
  assert.deepEqual(identity!.reasons[0]!.evidence, [{ kind: 'address', value: BTC_A }, { kind: 'url', value: 'https://targ.example/oferta/9' }]);
  assert.deepEqual(identity!.path, ['adres 1A1zP1eP5Q…v7DivfNa podmiotu', 'ten sam adres publikowany jako własny', 'profil „julka_k” (targ.example) (https://targ.example/oferta/9)']);
  assert.deepEqual(identity!.addresses, [{ address: BTC_A, network: 'bitcoin', basis: 'shared_with_subject' }]);
  assert.deepEqual(identity!.mergeWith, [{ target: 'profile', key: 'targ.example|julka_k' }]);
  assert.match(identity!.note, /ta sama osoba pod inną nazwą, osoba bliska albo podstawiona/);
  assert.ok(dossier.keyFindings.some((item) => item.text.startsWith('Powiązana tożsamość: „Julia Kowalska” — prawdopodobnie ta sama osoba (siła 85/100).')));
  const node = dossier.graph.nodes.find((item) => item.id === 'identity:tozsamosc:julka_k')!;
  assert.deepEqual([node.kind, node.label, node.score], ['person', 'Julia Kowalska', 85]);
  assert.ok(dossier.graph.edges.some((edge) => edge.to === node.id && edge.kind === 'related' && edge.from === `addr:bitcoin:${BTC_A}` && edge.inferred));

  // „To ta sama osoba”: tożsamość scala się z osobą główną i znika z listy powiązanych.
  const merged = dossierOf(result, query, { decisions: [decision('profile', 'targ.example|julka_k', 'confirmed')] });
  assert.deepEqual(merged.linkedIdentities, []);
  assert.deepEqual(merged.persons[0]!.profileIds.sort(), ['gitpub.example|rkowalski92', 'targ.example|julka_k']);
  // „Inna osoba”: zostaje jako powiązana, z odnotowaną decyzją.
  const kept = dossierOf(result, query, { decisions: [decision('profile', 'targ.example|julka_k', 'rejected')] });
  assert.equal(kept.linkedIdentities[0]!.decision, 'rejected');
  assert.equal(kept.persons.length, 1);
});

test('rozszerzanie z profilu: wspólny e-mail i telefon prowadzą do kolejnych tożsamości, z własnymi sumami', async () => {
  const deposit = transfer(1, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-04-01T00:00:00.000Z', amount: 1 });
  const trail: CashOutTrail = {
    id: 'sciezka-firmy', sourceAddress: BTC_B, network: 'bitcoin', serviceName: 'Kraken 4', serviceKind: 'exchange_deposit', asset: 'BTC', amount: 1, valuePln: 300_000, confidence: 95,
    hops: [{ txid: deposit.txid, time: deposit.time, from: BTC_B, to: EXCHANGE, asset: 'BTC', amount: 1, explorerUrl: deposit.explorerUrl }], reasons: [], openQuestions: [],
  };
  // Indeks własny: inna nazwa z e-mailem podmiotu (i własnym adresem), a dalej — z telefonem tej drugiej.
  const corpus = fakeConnector('corpus', 'indeks', ['email', 'full_name', 'nick', 'crypto_address'], (identifier) => {
    if (identifier.value === 'rafal.kowalski@poczta.example') {
      return [{ url: 'https://ogloszenia.example/firma', service: 'ogloszenia.example', author: 'jk_handel', category: 'sale_offer' as const, text: `Kontakt: rafal.kowalski@poczta.example, wpłaty: ${BTC_B}`, profile: { handle: 'jk_handel', displayName: 'Julia Kowalska', phones: ['511 222 333'] } }];
    }
    if (identifier.value.replace(/\D/g, '') === '511222333') {
      return [{ url: 'https://forum.example/u/trzecia', service: 'forum.example', author: 'trzecia_osoba', text: 'Dzwońcie: 511-222-333', profile: { handle: 'trzecia_osoba' } }];
    }
    return [];
  });
  const chain = chainWith({ [BTC_B]: { transfers: [deposit], cashOuts: [cashOut(deposit, 300_000)], trails: [trail] } });
  // Podmiot znany tylko z nicka: jego e-mail pochodzi z profilu i dopiero rozszerzanie po niego sięga.
  const query = { identifiers: [{ type: 'nick' as const, value: 'rkowalski92' }] };
  const byNick = () => {
    const connector = subjectProfile();
    connector.accepts = ['nick'];
    return connector;
  };
  const result = await runAnalysis({ query, connectors: [byNick(), corpus], chainProviders: [chain] });

  // Adres drugiej tożsamości jest w analizie, ale nie jako adres podmiotu.
  const linkedOnly = result.findings.find((finding) => finding.address === BTC_B)!;
  assert.deepEqual([linkedOnly.linkedOnly, linkedOnly.confidence.score, linkedOnly.linkedScore], [true, 0, 70]);
  assert.deepEqual(result.intel.pivot!.map((lead) => [lead.step, lead.kind, lead.attribute, lead.author]), [
    [1, 'shared_attribute', 'email', 'jk_handel'],
    [2, 'shared_attribute', 'phone', 'trzecia_osoba'],
  ]);
  assert.deepEqual(result.intel.timings!.map((item) => item.stage).includes('pivot'), true);

  const dossier = dossierOf(result, query);
  assert.deepEqual(dossier.findings.map((finding) => finding.address), [BTC_A]);
  const [first, second] = dossier.linkedIdentities;
  assert.deepEqual([first!.displayName, first!.relation, first!.score], ['Julia Kowalska', 'same_person_likely', 85]);
  assert.deepEqual(first!.reasons[0]!.evidence, [{ kind: 'attribute', value: 'rafal.kowalski@poczta.example' }, { kind: 'url', value: 'https://ogloszenia.example/firma' }]);
  assert.deepEqual(first!.addresses, [{ address: BTC_B, network: 'bitcoin', basis: 'published' }]);
  // Sumy powiązanej tożsamości liczone osobno i dodatkowo łącznie z osobą główną.
  assert.deepEqual(first!.cashOutPlnByYear, { '2025': 300_000 });
  assert.deepEqual(first!.cashOutProof.map((proof) => [proof.serviceName, proof.amount, proof.trailConfidence, proof.hops]), [['Kraken', 1, 95, 1]]);
  assert.deepEqual(dossier.totals.cashOutPlnByYear, {});
  assert.deepEqual(dossier.totals.cashOutPlnByYearWithLikelySame, { '2025': 300_000 });
  assert.deepEqual([dossier.totals.cashOutPlnTotal, dossier.totals.cashOutPlnTotalWithLikelySame], [0, 300_000]);
  // Drugi krok: tożsamość znaleziona przez telefon pierwszej — ścieżka pokazuje całą drogę.
  assert.equal(second!.displayName, 'trzecia_osoba');
  assert.equal(second!.path.length, 5);
  assert.ok(second!.path[1]!.includes('ten sam e-mail') && second!.path[3]!.includes('ten sam telefon 511 222 333'));

  // Scalenie pierwszej tożsamości: jej adres staje się adresem podmiotu.
  const merged = dossierOf(result, query, { decisions: [decision('profile', 'ogloszenia.example|jk_handel', 'confirmed')] });
  assert.deepEqual(merged.findings.map((finding) => finding.address).sort(), [BTC_A, BTC_B].sort());
  assert.ok(merged.findings.every((finding) => finding.confidence.score >= 70));
  assert.deepEqual(merged.persons[0]!.profileIds.sort(), ['gitpub.example|rkowalski92', 'ogloszenia.example|jk_handel']);
  assert.deepEqual(merged.totals.cashOutPlnByYear, { '2025': 300_000 });
  assert.ok(!merged.linkedIdentities.some((identity) => identity.handles.includes('jk_handel')));

  // Limity: jeden krok nie dochodzi do trzeciej osoby; zero kroków wyłącza pętlę.
  const oneStep = await runAnalysis({ query, connectors: [byNick(), corpus], chainProviders: [chain], pivot: { steps: 1, queriesPerStep: 12 } });
  assert.deepEqual(oneStep.intel.pivot!.map((lead) => lead.author), ['jk_handel']);
  const off = await runAnalysis({ query, connectors: [byNick(), corpus], chainProviders: [chain], pivot: { steps: 0, queriesPerStep: 12 } });
  assert.equal(off.intel.pivot, undefined);
  assert.ok(!off.findings.some((finding) => finding.linkedOnly));
  // Limit zapytań na krok: profil ma dwie cechy (e-mail, telefon), a wolno zadać jedno pytanie.
  const capped = await runAnalysis({ query, connectors: [byNick(), corpus], chainProviders: [chain], pivot: { steps: 1, queriesPerStep: 1 } });
  assert.ok(capped.log.some((entry) => entry.message.includes('Rozszerzanie, krok 1: tropów do sprawdzenia 1 (limit 1 na krok)')));
});

test('rozszerzanie z adresu: adresy powiązane w blockchainie i ich publikacje', async () => {
  const links = [
    { address: BTC_B, kind: 'co_depositor', strength: 80, via: DEPOSIT, service: 'Kraken', txids: ['a1', 'a2'] },
    { address: BTC_C, kind: 'co_depositor', strength: 70, via: DEPOSIT, service: 'Kraken', txids: ['b1'] },
    { address: BTC_D, kind: 'funded_by', strength: 60, txids: ['c1'] },
    { address: EXCHANGE, kind: 'same_wallet', strength: 20, txids: [] },
    { address: 'x', kind: 'nieznany', strength: 99 },
  ];
  const provider: ChainProvider = {
    ...fakeProvider(),
    getActivity: async (network, address) => ({ ...fakeActivity(network, address, 'private'), ...(address === BTC_A ? { linkedAddresses: links } : {}) }),
  };
  assert.deepEqual(linkedAddressesOf(await provider.getActivity('bitcoin', BTC_A, { log() {} })).map((item) => [item.address, item.kind]), [
    [BTC_B, 'co_depositor'], [BTC_C, 'co_depositor'], [BTC_D, 'funded_by'], [EXCHANGE, 'same_wallet'],
  ]);
  assert.deepEqual(linkedAddressesOf(undefined), []);

  const targ = fakeConnector('targ', 'targ.example', ['crypto_address'], (identifier) =>
    identifier.value === BTC_B ? [{ url: 'https://targ.example/u/julka_k', author: 'julka_k', text: `Mój adres: ${BTC_B}`, profile: { handle: 'julka_k', displayName: 'Julia Kowalska' } }] : [],
  );
  const result = await runAnalysis({ query, connectors: [subjectProfile({ phones: [] }), targ], chainProviders: [provider] });
  // Powiązanie poniżej progu siły (20) i nieznany rodzaj nie są sprawdzane.
  assert.deepEqual(targ.calls.map((call) => call.value).sort(), [BTC_A, BTC_B, BTC_C, BTC_D].sort());

  const dossier = dossierOf(result, query);
  const byName = new Map(dossier.linkedIdentities.map((identity) => [identity.displayName, identity]));
  // Współwpłacający na ten sam adres wpłat giełdy, który publikuje swój adres: prawdopodobnie ta sama osoba.
  const published = byName.get('Julia Kowalska')!;
  assert.deepEqual([published.relation, published.score], ['same_person_likely', 85]);
  assert.deepEqual(published.reasons[0]!.evidence, [
    { kind: 'address', value: BTC_B }, { kind: 'address', value: DEPOSIT }, { kind: 'txid', value: 'a1' }, { kind: 'txid', value: 'a2' }, { kind: 'url', value: 'https://targ.example/u/julka_k' },
  ]);
  assert.deepEqual(published.path, [
    'adres 1A1zP1eP5Q…v7DivfNa podmiotu',
    'adres wpłat usługi Kraken 12c6DSiU4R…MBrzjrJX',
    'na ten sam adres wpłat wpłaca także adres bc1qar0srr…wf5mdq'.replace('bc1qar0srr…wf5mdq', `${BTC_B.slice(0, 10)}…${BTC_B.slice(-8)}`),
    `adres ${BTC_B.slice(0, 10)}…${BTC_B.slice(-8)} opublikowany jako własny przez „julka_k” w serwisie targ.example (https://targ.example/u/julka_k)`,
  ]);
  // Ten sam adres wpłat bez publikacji: możliwa ta sama osoba albo bliska — tożsamość bez profilu.
  const unpublished = byName.get(`Nieznany właściciel adresu ${BTC_C.slice(0, 10)}…${BTC_C.slice(-8)}`)!;
  assert.deepEqual([unpublished.relation, unpublished.score, unpublished.profiles.length], ['possibly_same_or_close', 55, 0]);
  assert.deepEqual(unpublished.addresses, [{ address: BTC_C, network: 'bitcoin', basis: 'linked:co_depositor' }]);
  // Jednokierunkowe finansowanie to słaby trop (30 < 50): nie tworzy karty, jest tylko policzone.
  assert.equal(byName.has(`Nieznany właściciel adresu ${BTC_D.slice(0, 10)}…${BTC_D.slice(-8)}`), false);
  assert.equal(dossier.weakLeadsHidden, 1);
  assert.ok(result.intel.pivot!.some((lead) => lead.value === BTC_D && lead.link?.kind === 'funded_by'));
});

test('różne imiona i nazwiska nie są scalane automatycznie, nawet przy wspólnym e-mailu', async () => {
  const second = fakeConnector('forum', 'forum.example', ['email'], () => [
    { url: 'https://forum.example/u/julka', author: 'julka', text: `Mój adres ${BTC_C}`, profile: { handle: 'julka', displayName: 'Julia Kowalska', emails: ['rafal.kowalski@poczta.example'], location: 'Radom' } },
  ]);
  const result = await runAnalysis({ query, connectors: [subjectProfile(), second], chainProviders: [fakeProvider()], pivot: { steps: 0, queriesPerStep: 0 } });
  const dossier = dossierOf(result, query);

  // Oba profile znaleziono po e-mailu podmiotu, ale podają różne osoby — dwie karty zamiast jednej.
  assert.equal(dossier.persons.length, 2);
  const identity = dossier.linkedIdentities.find((item) => item.handles.includes('julka') || item.handles.includes('rkowalski92'))!;
  assert.equal(identity.relation, 'same_person_likely');
  // E-mail (mocna) + to samo nazwisko i miejscowość (średnia): 85 + 3.
  assert.equal(identity.score, 88);
  assert.ok(identity.reasons.some((reason) => reason.text.startsWith('Ten sam e-mail rafal.kowalski@poczta.example')));
  assert.ok(identity.reasons.some((reason) => reason.text.startsWith('To samo nazwisko i ta sama miejscowość (Radom)')));
  // Decyzja analityka scala.
  const merged = dossierOf(result, query, { decisions: identity.mergeWith.map((item) => decision('profile', item.key, 'confirmed')) });
  assert.equal(merged.persons[0]!.profileIds.length, 2);
  assert.deepEqual(merged.linkedIdentities, []);
});

test('rdzeń nazwy konta jest słabym tropem', async () => {
  assert.equal(handleStem('rkowalski92'), 'rkowalski');
  assert.equal(handleStem('kowalski_r_pl'), 'kowalski_r');
  assert.equal(handleStem('rkowalski'), undefined);
  assert.equal(handleStem('ab12'), undefined);

  const profiles = fakeConnector('profile', 'social.example', ['nick'], (identifier) =>
    identifier.value === 'rkowalski' ? [{ url: 'https://social.example/rkowalski', author: 'rkowalski', text: 'Cześć.', profile: { handle: 'rkowalski' } }] : [],
  );
  const result = await runAnalysis({ query, connectors: [subjectProfile({ phones: [] }), profiles], chainProviders: [fakeProvider()] });
  // Trop zostaje w materiale analizy i w dzienniku…
  assert.deepEqual(result.intel.pivot!.map((lead) => [lead.kind, lead.value, lead.author]), [['handle_pattern', 'rkowalski', 'rkowalski']]);
  assert.ok(result.log.some((entry) => entry.message.startsWith('Trop (handle_pattern)')));
  // …ale sam w sobie nie tworzy powiązanej tożsamości ani węzła grafu — to mogłaby być przypadkowa osoba.
  const dossier = dossierOf(result, query);
  assert.deepEqual(dossier.linkedIdentities, []);
  assert.equal(dossier.weakLeadsHidden, 1);
  assert.ok(!dossier.graph.nodes.some((node) => node.label === 'rkowalski'));
  assert.ok(!dossier.keyFindings.some((item) => item.text.includes('rkowalski”')));

  // Niezależne potwierdzenie (ta sama strona WWW w obu profilach) czyni z tropu tożsamość.
  const site = 'https://kowalski-foto.example';
  const confirmedProfiles = fakeConnector('profile', 'social.example', ['nick'], (identifier) =>
    identifier.value === 'rkowalski' ? [{ url: 'https://social.example/rkowalski', author: 'rkowalski', text: 'Cześć.', profile: { handle: 'rkowalski', urls: [site] } }] : [],
  );
  const confirmed = await runAnalysis({ query, connectors: [subjectProfile({ phones: [], urls: [site] }), confirmedProfiles], chainProviders: [fakeProvider()] });
  const [identity] = dossierOf(confirmed, query).linkedIdentities;
  assert.deepEqual([identity!.displayName, identity!.relation, identity!.score], ['rkowalski', 'possibly_same_or_close', 55]);
});

test('zgodność stylu według modelu: najwyżej +10 do relacji „możliwe”, sama nie tworzy tożsamości', async () => {
  const site = 'https://kowalski-foto.example';
  const style = (likelihood: number) => {
    const ai = fakeAi();
    ai.compareAuthors = async () => {
      ai.calls.comparisons++;
      return { likelihood, reasons: ['te same zwroty'], model: 'atrapa-1' };
    };
    return ai;
  };
  // Druga tożsamość publikuje własny adres (jest więc treść do porównania) i ma tę samą stronę WWW.
  const other = (urls: string[]) =>
    fakeConnector('profile', 'social.example', ['nick'], (identifier) =>
      identifier.value === 'rkowalski' ? [{ url: 'https://social.example/rkowalski', author: 'rkowalski', text: `Mój adres ${BTC_C}`, profile: { handle: 'rkowalski', urls } }] : [],
    );
  const run = (ai: ReturnType<typeof fakeAi> | undefined, urls: string[]) =>
    runAnalysis({ query, connectors: [subjectProfile({ phones: [], urls: [site] }), other(urls)], chainProviders: [fakeProvider()], ai });

  const plain = dossierOf(await run(undefined, [site]), query).linkedIdentities[0]!;
  assert.equal(plain.score, 55);

  const ai = style(80);
  const result = await run(ai, [site]);
  assert.equal(ai.calls.comparisons, 1);
  const boosted = dossierOf(result, query).linkedIdentities[0]!;
  // 55 (wspólna strona WWW) + 8 (styl 80% → +8, najwyżej +10).
  assert.deepEqual([boosted.relation, boosted.score], ['possibly_same_or_close', 63]);
  assert.ok(boosted.reasons.some((reason) => reason.text.startsWith('Model atrapa-1: podobny styl wypowiedzi (80%) — przesłanka dodatkowa (+8)')));
  assert.equal(dossierOf(await run(style(100), [site]), query).linkedIdentities[0]!.score, 65);

  // Bez innej podstawy sam odczyt stylu (i sama podobna nazwa konta) nie tworzy tożsamości.
  const alone = dossierOf(await run(style(95), []), query);
  assert.deepEqual(alone.linkedIdentities, []);
  assert.equal(alone.weakLeadsHidden, 1);
});
