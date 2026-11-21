// Kontrolowane rozszerzanie analizy: głębokość, budżet zapytań, powtórzenia, wiarygodność źródeł,
// powody zatrzymania, niedostępne źródła i powtarzalność. Wszystko przez `runAnalysis` na atrapach.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAddress } from '@olcys/core';
import type { ChainProvider } from '@olcys/core';
import { DEFAULT_MAX_REQUESTS, EXPANSION_RELIABILITY, runAnalysis } from '../src/analysis.ts';
import type { ActivityResolver, AnalysisResult } from '../src/analysis.ts';
import type { ExpansionStop } from '../src/intel.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, FIXED_NOW, chainWith, fakeActivity, fakeConnector, fakeProvider, transfer } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };

/** Dostawca liczący wywołania — do sprawdzenia, że adres nie jest analizowany dwa razy. */
function countingProvider(inner: ChainProvider = fakeProvider()): ChainProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    id: inner.id,
    label: inner.label,
    supports: (network, address) => inner.supports(network, address),
    calls,
    getActivity: async (network, address, context) => {
      calls.push(address);
      return inner.getActivity(network, address, context);
    },
  };
}

const stopsOf = (result: AnalysisResult, stage: string, reason: ExpansionStop['reason']) =>
  result.intel.expansion!.stops.filter((stop) => stop.stage === stage && stop.reason === reason);

/** Profil → drugi profil → adres: najkrótsza pełna ścieżka od jednego identyfikatora do blockchaina. */
const twoProfiles = () =>
  fakeConnector('profile', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: 'Moje drugie konto: janek_portfel.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_portfel' }] }]
      : identifier.value === 'janek_portfel'
        ? [{ url: 'https://serwis.example/janek_portfel', author: 'janek_portfel', text: `To też ja, krypto_janek. Wpłaty: ${BTC_A}` }]
        : [],
  );

test('jeden identyfikator → profil → kolejny identyfikator → drugi profil → adres → blockchain, z powodem zatrzymania', async () => {
  const connector = twoProfiles();
  const provider = countingProvider();
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [provider], now: FIXED_NOW });

  // Ścieżka dojścia: profil znaleziony wprost wskazał drugie konto, a ono opublikowało adres.
  assert.deepEqual(result.intel.trail, [
    { identifier: { type: 'nick', value: 'janek_portfel' }, step: 1, sourceUrl: 'https://serwis.example/krypto_janek', sourceService: 'serwis.example', via: nick, match: 'linked_profile', followed: true },
  ]);
  assert.deepEqual(result.intel.sightings.map((item) => [item.url, item.step, item.role, item.identity.match]), [
    ['https://serwis.example/krypto_janek', 0, 'subject', 'same_handle'],
    ['https://serwis.example/janek_portfel', 1, 'subject', 'verified_link'],
  ]);
  const [finding] = result.findings;
  assert.deepEqual([finding!.address, finding!.checksumVerified, finding!.evidence[0]!.url], [BTC_A, true, 'https://serwis.example/janek_portfel']);
  assert.equal(finding!.chain!.profile.address, BTC_A);
  assert.deepEqual(provider.calls, [BTC_A]);

  // Zatrzymanie naturalne: nie ma już nowych tropów, żaden limit nie zadziałał.
  const { expansion } = result.intel;
  assert.deepEqual(expansion!.stops.map((stop) => [stop.stage, stop.reason]), [['search', 'no_new_leads'], ['pivot', 'no_new_leads']]);
  assert.match(expansion!.stops[0]!.detail, /po kroku 1/);
  assert.deepEqual(expansion!.requests, { connectors: 2, chain: 1, budget: DEFAULT_MAX_REQUESTS });
  assert.equal(result.intel.sourceErrors, undefined);
  assert.equal(result.intel.partial, undefined);

  // Parametry do powtórzenia analizy.
  assert.deepEqual(expansion!.run, {
    startedAt: '2026-11-21T10:00:00.000Z',
    finishedAt: '2026-11-21T10:00:00.000Z',
    identifiers: [nick],
    connectors: ['profile'],
    chainProviders: ['atrapa-chain'],
    rulesHash: expansion!.run.rulesHash,
  });
  assert.match(expansion!.run.rulesHash, /^[0-9a-f]{16}$/);
  assert.deepEqual([expansion!.limits.discoveryDepth, expansion!.limits.maxIdentifiers, expansion!.limits.maxRequests, expansion!.limits.maxCounterparties, expansion!.limits.maxChainAddresses, expansion!.limits.pivotSteps], [3, 40, DEFAULT_MAX_REQUESTS, 10, 15, 2]);
  assert.ok(result.log.some((entry) => entry.message.startsWith('Kontrola rozszerzania: zapytań do źródeł 2, do dostawców danych blockchain 1')));
});

test('limit głębokości: identyfikator spoza zasięgu nie jest wyszukiwany i ma powód zatrzymania', async () => {
  const connector = twoProfiles();
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [fakeProvider()], discoveryDepth: 0 });

  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek']);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.intel.trail.map((entry) => [entry.identifier.value, entry.followed, entry.stopReason]), [['janek_portfel', false, 'depth_limit']]);
  const [stop] = stopsOf(result, 'search', 'depth_limit');
  assert.equal(stop!.skipped, 1);
  assert.match(stop!.detail, /limit głębokości odkrywania \(kroków: 0\).*nick „janek_portfel”/);
  // Limit zadziałał, więc to nie jest „brak nowych tropów”.
  assert.deepEqual(stopsOf(result, 'search', 'no_new_leads'), []);
});

test('limit liczby identyfikatorów: nadmiarowe mają powód zatrzymania', async () => {
  const connector = fakeConnector('szeroki', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: 'Profil.', discoveredIdentifiers: ['a1', 'a2', 'a3', 'a4'].map((value) => ({ type: 'nick' as const, value: `konto_${value}` })) }]
      : [],
  );
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [], maxIdentifiers: 3 });

  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek', 'konto_a1', 'konto_a2']);
  assert.deepEqual(result.intel.trail.map((entry) => entry.stopReason), [undefined, undefined, 'identifier_limit', 'identifier_limit']);
  assert.equal(stopsOf(result, 'search', 'identifier_limit')[0]!.skipped, 2);
});

test('budżet zapytań: po wyczerpaniu nic więcej nie jest odpytywane, a wynik mówi dlaczego', async () => {
  const first = twoProfiles();
  const second = fakeConnector('drugi', 'drugi.example', ['nick', 'crypto_address'], () => []);
  const provider = countingProvider();
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [first, second], chainProviders: [provider], maxRequests: 3 });

  // Trzy zapytania: oba łączniki o identyfikator analityka i pierwszy o odkryte konto.
  assert.deepEqual([first.calls.map((call) => call.value), second.calls.map((call) => call.value)], [['krypto_janek', 'janek_portfel'], ['krypto_janek']]);
  assert.deepEqual(provider.calls, []);
  assert.deepEqual(result.intel.expansion!.requests, { connectors: 3, chain: 0, budget: 3 });

  // Adres znaleziono, ale bez danych z łańcucha — i bez zmyślonych liczb.
  const [finding] = result.findings;
  assert.deepEqual([finding!.address, finding!.chain, finding!.chainSkipped], [BTC_A, undefined, true]);
  assert.ok(finding!.notes!.some((note) => note.includes('wyczerpano budżet zapytań analizy (3)')));

  const reasons = result.intel.expansion!.stops.filter((stop) => stop.reason === 'request_budget');
  assert.deepEqual(reasons.map((stop) => [stop.stage, stop.skipped]), [['search', 1], ['occurrences', 1], ['chain', 1]]);
  assert.equal(result.log.filter((entry) => entry.message.startsWith('Wyczerpano budżet zapytań analizy (3)')).length, 1);
  // Budżet to nie limit czasu: `partial` zachowuje dotychczasowe znaczenie.
  assert.equal(result.intel.partial, undefined);
});

test('kontrahenci: portfel z wieloma kontrahentami nie uruchamia nieograniczonych zapytań', async () => {
  // 30 różnych, poprawnych adresów kontrahentów (adresy Ethereum mają tę samą postać dla dowolnych cyfr).
  const counterparties = Array.from({ length: 30 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`);
  const subject = validateAddress('0x00000000000000000000000000000000000000aa')!.address;
  const profile = fakeConnector('profile', 'serwis.example', ['nick'], () => [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: `Portfel: ${subject}` }]);
  const addresses = fakeConnector('adresy', 'adresy.example', ['crypto_address'], () => []);
  const provider = countingProvider(
    chainWith({ [subject]: { transfers: counterparties.map((counterparty, index) => transfer(index + 1, { counterparty, time: '2025-01-01T00:00:00.000Z', amount: 100 - index })) } }),
  );
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [profile, addresses], chainProviders: [provider], maxCounterparties: 4 });

  // Adres podmiotu + czterech największych kontrahentów; pozostałych 26 nikt nie odpytuje.
  assert.deepEqual(addresses.calls.map((call) => call.value), [subject, ...counterparties.slice(0, 4)]);
  assert.deepEqual(result.intel.checkedCounterparties, counterparties.slice(0, 4).map((address) => `ethereum:${address}`));
  // Kontrahenci nie dostają własnej analizy łańcucha — graf nie rośnie o ich kontrahentów.
  assert.deepEqual(provider.calls, [subject]);
  assert.deepEqual(result.findings.map((finding) => finding.address), [subject]);

  const [stop] = stopsOf(result, 'counterparties', 'counterparty_limit');
  assert.equal(stop!.skipped, 26);
  assert.match(stop!.detail, /Sprawdzono 4 największych wartością kontrahentów bez etykiety z 30 \(limit 4\) — nie rozwijamy grafu po wszystkich kontrahentach/);
  assert.equal(result.intel.expansion!.requests.connectors, 6);
});

test('limit adresów z analizą blockchain ma powód zatrzymania', async () => {
  const profile = fakeConnector('profile', 'serwis.example', ['nick'], () => [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: `Adresy: ${BTC_A}, ${BTC_B}, ${BTC_C}` }]);
  const provider = countingProvider();
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [profile], chainProviders: [provider], maxChainAddresses: 2 });

  assert.equal(provider.calls.length, 2);
  assert.equal(result.findings.filter((finding) => finding.chainSkipped).length, 1);
  assert.equal(stopsOf(result, 'chain', 'chain_address_limit')[0]!.skipped, 1);
});

test('powtórzenia: to samo zapytanie i ten sam adres nie są wykonywane drugi raz', async () => {
  const email = { type: 'email' as const, value: 'janek@poczta.example' };
  // Dwa profile wskazują to samo konto i publikują ten sam adres; profil podaje e-mail znany już analitykowi,
  // więc pętla rozszerzania chciałaby zapytać o niego ponownie.
  const connector = fakeConnector('profile', 'serwis.example', ['nick', 'email', 'crypto_address'], (identifier) => {
    if (identifier.value === 'krypto_janek') {
      return [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: `Adres ${BTC_A}`, profile: { handle: 'krypto_janek', emails: [email.value] }, discoveredIdentifiers: [{ type: 'nick' as const, value: 'wspolne_konto' }] }];
    }
    if (identifier.value === email.value) {
      return [{ url: 'https://serwis.example/kontakt', author: 'krypto_janek', text: `Kontakt ${email.value}, adres ${BTC_A}`, discoveredIdentifiers: [{ type: 'nick' as const, value: 'Wspolne_Konto' }] }];
    }
    if (identifier.value === 'wspolne_konto') return [{ url: 'https://serwis.example/wspolne_konto', author: 'wspolne_konto', text: 'Bez adresu.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'krypto_janek' }] }];
    return [];
  });
  const provider = countingProvider();
  const result = await runAnalysis({ query: { identifiers: [nick, email] }, connectors: [connector], chainProviders: [provider] });

  const asked = connector.calls.map((call) => `${call.type}:${call.value.toLowerCase()}`);
  assert.deepEqual(asked, ['nick:krypto_janek', `email:${email.value}`, 'nick:wspolne_konto', `crypto_address:${BTC_A.toLowerCase()}`]);
  assert.equal(new Set(asked).size, asked.length);
  // Adres z dwóch publikacji: jedna analiza łańcucha, dwa ślady.
  assert.deepEqual(provider.calls, [BTC_A]);
  assert.equal(result.findings[0]!.evidence.length, 2);

  const { duplicates, duplicatesSkipped, requests } = result.intel.expansion!;
  // Ponowne zapytanie o e-mail (rozszerzanie) i ponowne wskazanie tego samego konta przez drugi profil.
  assert.deepEqual(duplicates, { queries: 1, identifiers: 1, documents: 0 });
  assert.equal(duplicatesSkipped, 2);
  assert.deepEqual(requests, { connectors: 4, chain: 1, budget: DEFAULT_MAX_REQUESTS });
});

test('wiarygodność źródeł: identyfikatory z masowych komentarzy i słabo przypisanych dokumentów nie są rozwijane', async () => {
  assert.deepEqual(EXPANSION_RELIABILITY, { lowReliabilityCategories: ['mass_comment'], weakMatches: ['name_only', 'common_handle'], weakFollowSteps: 1 });
  const connector = fakeConnector('profile', 'serwis.example', ['nick'], (identifier) => {
    if (identifier.value === 'krypto_janek') {
      return [
        { url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'posrednie_konto' }] },
        // Masowy komentarz podmiotu (rozdanie): konto z jego treści nie jest tropem.
        { url: 'https://serwis.example/rozdanie/1', author: 'krypto_janek', category: 'mass_comment' as const, text: 'Biorę udział! Obserwujcie też konto_z_rozdania.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'konto_z_rozdania' }] },
      ];
    }
    if (identifier.value === 'posrednie_konto') {
      // Profil z drugiego kroku dopasowany tylko po nazwisku: nie wiadomo, czy to ta sama osoba.
      return [{ url: 'https://serwis.example/posrednie_konto', author: 'posrednie_konto', identityMatch: 'name_only' as const, text: 'Jan Kowalski, hodowca.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'konto_imiennika' }] }];
    }
    return [{ url: `https://serwis.example/${identifier.value}`, author: identifier.value, text: `Cudzy adres ${BTC_A}` }];
  });
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [fakeProvider()] });

  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek', 'posrednie_konto']);
  // Cudzy adres nie trafił do wyniku, bo do jego profilu nikt nie doszedł.
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.intel.trail.map((entry) => [entry.identifier.value, entry.followed, entry.stopReason]), [
    ['posrednie_konto', true, undefined],
    ['konto_z_rozdania', false, 'low_reliability'],
    ['konto_imiennika', false, 'low_reliability'],
  ]);
  const [stop] = stopsOf(result, 'search', 'low_reliability');
  assert.equal(stop!.skipped, 2);
  assert.match(stop!.detail, /nick „konto_z_rozdania”, nick „konto_imiennika”/);
  assert.ok(result.log.some((entry) => entry.message.includes('„konto_z_rozdania”') && entry.message.includes('masowy komentarz')));
  assert.ok(result.log.some((entry) => entry.message.includes('„konto_imiennika”') && entry.message.includes('słabo przypisany podmiotowi')));
});

test('wiarygodność źródeł: trop analityka po samym nazwisku idzie o jeden krok i dziedziczy słabą ocenę', async () => {
  const fullName = { type: 'full_name' as const, value: 'Jan Kowalski' };
  const connector = fakeConnector('profile', 'serwis.example', ['full_name', 'nick'], (identifier) => {
    if (identifier.type === 'full_name') return [{ url: 'https://serwis.example/jkowalski', author: 'jkowalski', identityMatch: 'name_only' as const, text: 'Jan Kowalski.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'jk_portfel' }] }];
    if (identifier.value === 'jk_portfel') return [{ url: 'https://serwis.example/jk_portfel', author: 'jk_portfel', text: `Adres ${BTC_B}`, discoveredIdentifiers: [{ type: 'nick' as const, value: 'jk_trzecie' }] }];
    return [{ url: 'https://serwis.example/jk_trzecie', author: 'jk_trzecie', text: `Adres ${BTC_C}` }];
  });
  const result = await runAnalysis({ query: { identifiers: [fullName] }, connectors: [connector], chainProviders: [fakeProvider()] });

  // Pierwszy krok od identyfikatora analityka jest wykonywany, łańcuch „słaby → słaby” już nie.
  assert.deepEqual(connector.calls.map((call) => call.value), ['Jan Kowalski', 'jk_portfel']);
  assert.deepEqual(result.intel.trail.map((entry) => [entry.identifier.value, entry.match, entry.followed, entry.stopReason]), [
    ['jk_portfel', 'name_only', true, undefined],
    ['jk_trzecie', 'name_only', false, 'low_reliability'],
  ]);
  assert.deepEqual(result.findings.map((finding) => [finding.address, finding.evidence[0]!.identityMatch]), [[BTC_B, 'name_only']]);
});

test('identyfikator ze źródła niewiarygodnego jest rozwijany, gdy wskaże go także źródło wiarygodne', async () => {
  const connector = fakeConnector('profile', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [
          { url: 'https://serwis.example/rozdanie/2', author: 'krypto_janek', category: 'mass_comment' as const, text: 'Rozdanie.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_portfel' }] },
          { url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: 'Drugie konto: janek_portfel.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_portfel' }] },
        ]
      : [{ url: 'https://serwis.example/janek_portfel', author: 'janek_portfel', text: `Adres ${BTC_A}` }],
  );
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [fakeProvider()] });

  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek', 'janek_portfel']);
  assert.deepEqual(result.intel.trail.map((entry) => [entry.sourceUrl, entry.followed, entry.stopReason]), [['https://serwis.example/krypto_janek', true, undefined]]);
  assert.deepEqual(stopsOf(result, 'search', 'low_reliability'), []);
});

test('niedostępne źródło i niedostępny dostawca danych: czytelny wynik częściowy, bez zmyślonych danych', async () => {
  const working = twoProfiles();
  const broken = fakeConnector('zepsute', 'zepsute.example', ['nick', 'crypto_address'], () => {
    throw new Error('HTTP 503 Service Unavailable');
  });
  const hanging = fakeConnector('milczace', 'milczace.example', ['nick'], () => []);
  hanging.search = () => new Promise(() => {});
  const failingProvider: ChainProvider = {
    id: 'eksplorator-niedostepny',
    label: 'Eksplorator niedostępny',
    supports: () => true,
    getActivity: async () => {
      throw new Error('ECONNREFUSED');
    },
  };
  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [working, broken, hanging],
    chainProviders: [failingProvider],
    timeoutMs: 40,
    connectorTimeouts: { milczace: 20 },
    now: FIXED_NOW,
  });

  // Ustalenia z działającego źródła są nienaruszone.
  const [finding] = result.findings;
  assert.deepEqual([finding!.address, finding!.evidence.length, finding!.evidence[0]!.url], [BTC_A, 1, 'https://serwis.example/janek_portfel']);
  assert.deepEqual(result.intel.sightings.map((item) => item.url), ['https://serwis.example/krypto_janek', 'https://serwis.example/janek_portfel']);

  // Brak danych z łańcucha to brak danych: żadnych sald, przelewów ani klasyfikacji.
  assert.deepEqual([finding!.chain, finding!.chainUnavailable, finding!.chainSkipped], [undefined, true, undefined]);
  assert.ok(finding!.notes!.some((note) => note.startsWith('Dane blockchain niedostępne: żaden dostawca danych nie odpowiedział') && note.includes('eksplorator-niedostepny: ECONNREFUSED') && note.includes('to brak danych, a nie brak aktywności')));
  assert.ok(!JSON.stringify(result.findings).includes('totalReceived'));

  assert.deepEqual(result.intel.sourceErrors, [
    { connectorId: 'milczace', stage: 'search', message: 'przekroczono limit czasu 20 ms', count: 2 },
    { connectorId: 'zepsute', stage: 'search', message: 'HTTP 503 Service Unavailable', count: 2 },
    { connectorId: 'zepsute', stage: 'occurrences', message: 'HTTP 503 Service Unavailable', count: 1 },
    { providerId: 'eksplorator-niedostepny', stage: 'chain', message: 'ECONNREFUSED', count: 1, addresses: [`bitcoin:${BTC_A}`] },
  ]);
  assert.deepEqual(result.intel.expansion!.stops.filter((stop) => stop.reason === 'source_error').map((stop) => [stop.stage, stop.skipped]), [['search', 4], ['occurrences', 1], ['chain', 1]]);
  // Limit czasu całej analizy nie zadziałał — `partial` zachowuje swoje znaczenie, awarie źródeł są w `sourceErrors`.
  assert.equal(result.intel.partial, undefined);
  assert.ok(result.log.some((entry) => entry.message.startsWith('WYNIK CZĘŚCIOWY — nie odpowiedziały: milczace (search, 2×: przekroczono limit czasu 20 ms); zepsute')));
  assert.ok(result.log.some((entry) => entry.message.includes(`${BTC_A}: dane blockchain NIEDOSTĘPNE`) && entry.message.includes('żadnych kwot nie przyjęto')));
});

test('wynik zastępczy strategii wyboru dostawcy (same zera) nie jest przyjmowany, gdy nikt nie odpowiedział', async () => {
  const failing: ChainProvider = { id: 'pierwszy', label: 'Pierwszy', supports: () => true, getActivity: async () => { throw new Error('nieznany adres'); } };
  const backup = countingProvider();
  // Strategia jak w module danych blockchain: próbuje po kolei, a gdy nikt nie odpowie — zwraca pusty opis adresu.
  const resolver: ActivityResolver = async (providers, network, address, context) => {
    for (const provider of providers) {
      try {
        return await provider.getActivity(network, address, context);
      } catch {
        // kolejny dostawca
      }
    }
    return { ...fakeActivity(network, address, 'unknown'), transfers: [], cashOuts: [], cashOutPlnByYear: {}, limitations: ['Brak danych blockchain dla adresu.'] };
  };
  const connectors = () => [fakeConnector('profile', 'serwis.example', ['nick'], () => [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: `Adres ${BTC_A}` }])];

  const none = await runAnalysis({ query: { identifiers: [nick] }, connectors: connectors(), chainProviders: [failing], resolveActivity: resolver });
  assert.deepEqual([none.findings[0]!.chain, none.findings[0]!.chainUnavailable], [undefined, true]);
  assert.deepEqual(none.intel.sourceErrors, [{ providerId: 'pierwszy', stage: 'chain', message: 'nieznany adres', count: 1, addresses: [`bitcoin:${BTC_A}`] }]);

  // Gdy odpowie drugi dostawca, błąd pierwszego nie jest awarią: dane są i nie ma wpisu o błędzie.
  const fallback = await runAnalysis({ query: { identifiers: [nick] }, connectors: connectors(), chainProviders: [failing, backup], resolveActivity: resolver });
  assert.equal(fallback.findings[0]!.chain!.profile.address, BTC_A);
  assert.deepEqual([fallback.findings[0]!.chainUnavailable, fallback.intel.sourceErrors], [undefined, undefined]);
  assert.deepEqual(fallback.intel.expansion!.requests.chain, 2);
});

test('źródło, które samo zgłasza błąd w dzienniku i zwraca pustą listę, też trafia do wykazu awarii', async () => {
  const quiet = fakeConnector('ciche', 'ciche.example', ['nick'], () => []);
  quiet.search = async (identifier, context) => {
    context.log(`Ciche źródło: błąd podczas wyszukiwania „${identifier.value}": fetch failed`);
    return [];
  };
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [quiet], chainProviders: [] });

  assert.deepEqual(result.intel.sourceErrors, [{ connectorId: 'ciche', stage: 'search', message: 'Ciche źródło: błąd podczas wyszukiwania „krypto_janek": fetch failed', count: 1, reported: true }]);
});

test('pętla rozszerzania: limit zapytań na krok i limit kroków mają powody zatrzymania', async () => {
  // Profil podmiotu podaje trzy adresy e-mail; każdy prowadzi do innej tożsamości z własnym e-mailem.
  const emails = ['pierwszy@poczta.example', 'drugi@poczta.example', 'trzeci@poczta.example'];
  const connector = fakeConnector('profile', 'serwis.example', ['nick', 'email'], (identifier) => {
    if (identifier.value === 'krypto_janek') return [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: 'Profil.', profile: { handle: 'krypto_janek', emails } }];
    const index = emails.indexOf(identifier.value);
    if (index >= 0) return [{ url: `https://serwis.example/inna_${index}`, author: `inna_tozsamosc_${index}`, text: `Kontakt: ${identifier.value}`, profile: { handle: `inna_tozsamosc_${index}`, emails: [`dalszy_${index}@poczta.example`] } }];
    return [];
  });
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [], pivot: { steps: 1, queriesPerStep: 2 } });

  assert.deepEqual(connector.calls.filter((call) => call.type === 'email').map((call) => call.value), emails.slice(0, 2));
  assert.deepEqual(result.intel.pivot!.map((lead) => [lead.step, lead.value, lead.author]), [[1, emails[0], 'inna_tozsamosc_0'], [1, emails[1], 'inna_tozsamosc_1']]);
  assert.deepEqual(result.intel.expansion!.stops.filter((stop) => stop.stage === 'pivot').map((stop) => [stop.reason, stop.skipped]), [['depth_limit', 2], ['query_limit', 1]]);
});

test('powtarzalność: te same dane wejściowe dają ten sam wynik niezależnie od kolejności odpowiedzi źródeł', async () => {
  const counterparties = [BTC_C, BTC_D];
  /** Ta sama treść źródeł, ale każde uruchomienie dostaje inne opóźnienia odpowiedzi. */
  const analyse = async (delays: Record<string, number>) => {
    const delayed = <T extends ReturnType<typeof fakeConnector>>(connector: T): T => {
      const search = connector.search.bind(connector);
      let call = 0;
      connector.search = async (identifier, context) => {
        // Kolejne zapytania do tego samego źródła też kończą się w innej kolejności.
        const wait = (delays[connector.id] ?? 0) + ((call++ * 7) % 5) * (delays.spread ?? 0);
        await new Promise((resolve) => setTimeout(resolve, wait));
        return search(identifier, context);
      };
      return connector;
    };
    const profiles = delayed(
      fakeConnector('profile', 'serwis.example', ['nick', 'email'], (identifier) => {
        if (identifier.value === 'krypto_janek') {
          return [{ url: 'https://serwis.example/krypto_janek', author: 'krypto_janek', text: `Adresy: ${BTC_A} oraz ${BTC_B}`, profile: { handle: 'krypto_janek', emails: ['janek@poczta.example'] }, discoveredIdentifiers: [{ type: 'nick' as const, value: 'janek_portfel' }] }];
        }
        if (identifier.value === 'janek_portfel') return [{ url: 'https://serwis.example/janek_portfel', author: 'janek_portfel', text: `To ja, krypto_janek: ${BTC_B}` }];
        if (identifier.value === 'janek@poczta.example') return [{ url: 'https://serwis.example/inna', author: 'inna_tozsamosc', category: 'sale_offer' as const, text: 'Kontakt: janek@poczta.example', profile: { handle: 'inna_tozsamosc' } }];
        return [];
      }),
    );
    const forum = delayed(
      fakeConnector('forum', 'forum.example', ['nick', 'crypto_address'], (identifier) =>
        identifier.value === BTC_A || identifier.value === BTC_B
          ? ['ala', 'ola'].map((author) => ({ url: `https://forum.example/${author}/${identifier.value}`, author, category: 'forum_post' as const, text: `Widziałam adres ${identifier.value}` }))
          : [],
      ),
    );
    const market = delayed(
      fakeConnector('targ', 'targ.example', ['crypto_address'], (identifier) =>
        counterparties.includes(identifier.value) ? [{ url: `https://targ.example/oferta/${identifier.value}`, author: `sprzedawca_${identifier.value.slice(-4)}`, category: 'sale_offer' as const, text: `Wpłaty na ${identifier.value}` }] : [],
      ),
    );
    const chain = chainWith({
      [BTC_A]: { transfers: counterparties.map((counterparty, index) => transfer(index + 1, { counterparty, time: '2025-02-01T00:00:00.000Z', amount: 5 - index })) },
    });
    const { findings, intel } = await runAnalysis({ query: { identifiers: [nick] }, connectors: [profiles, forum, market], chainProviders: [chain], now: FIXED_NOW });
    // Pomiary czasu z natury różnią się między uruchomieniami.
    const { timings, slowestQueries, ...stable } = intel;
    assert.ok(timings && slowestQueries);
    return { findings, intel: stable };
  };

  const first = await analyse({ profile: 0, forum: 12, targ: 4, spread: 3 });
  const second = await analyse({ profile: 9, forum: 0, targ: 14, spread: 1 });
  assert.deepEqual(second, first);

  // Wynik nie jest pusty: adresy, współpublikujący, kontrahenci i trop z rozszerzania.
  assert.deepEqual(first.findings.map((finding) => finding.address).sort(), [BTC_A, BTC_B].sort());
  assert.deepEqual(first.intel.sightings.map((item) => item.role).sort(), ['co_publisher', 'co_publisher', 'co_publisher', 'co_publisher', 'counterparty_publisher', 'counterparty_publisher', 'linked_identity', 'subject', 'subject']);
  assert.deepEqual(first.intel.checkedCounterparties, counterparties.map((address) => `bitcoin:${address}`));
  assert.equal(first.intel.pivot!.length, 1);
});
