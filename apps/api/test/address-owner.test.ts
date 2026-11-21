// Od samego adresu do osoby: deklaracja własności w treści (reguła tekstowa), pułapki, wyjaśnienia
// braku osoby i rozszerzanie przez portfel. Atrapy łączników — bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SourceCategory } from '@olcys/core';
import { runAnalysis } from '../src/analysis.ts';
import { BTC_A, BTC_B, BTC_C, BTC_D, ETH_A, chainWith, dossierOf, fakeActivity, fakeAi, fakeConnector, fakeProvider } from './helpers.ts';

const WALLET_HINT =
  'Sprawdź powiązane tożsamości, jeśli są: autorów publikujących adresy z tego samego portfela albo wpłacających na ten sam adres wpłat giełdy (heurystyka) — potwierdzenie ich profilu decyzją analityka przypisze im badany adres.';
const query = { identifiers: [{ type: 'crypto_address' as const, value: BTC_A }] };

interface Post {
  url: string;
  author: string;
  text: string;
  category?: SourceCategory;
}

/** Łącznik forum zwracający podane wpisy dla zapytania o adres. */
const forum = (posts: Post[]) =>
  fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) =>
    identifier.value === BTC_A ? posts.map((post) => ({ category: 'forum_post' as const, identityMatch: 'name_only' as const, ...post })) : [],
  );

const analyse = async (posts: Post[], extra: Partial<Parameters<typeof runAnalysis>[0]> = {}) => {
  const result = await runAnalysis({ query, connectors: [forum(posts)], chainProviders: [fakeProvider()], ...extra });
  return { result, dossier: dossierOf(result, query) };
};

test('wpis na forum z deklaracją „przyjmuję na adres” czyni autora kandydatem z wagą wypowiedzi na forum', async () => {
  const { result, dossier } = await analyse([
    { url: 'https://forum.example/t/32', author: 'wilczek_x9', text: `Uczę matematyki online. Od roku przyjmuję od uczniów USDT na adres ${BTC_A} — bez prowizji banku.` },
  ]);
  const [finding] = result.findings;
  assert.equal(finding!.evidence.length, 1);
  assert.deepEqual(finding!.evidence[0]!.ownershipBasis?.rule, 'text_declaration');
  assert.ok(finding!.evidence[0]!.ownershipBasis!.quote.includes('przyjmuję'));
  // Kategoria zostaje „wypowiedź na forum” (50) — reguła nigdy nie podnosi kategorii.
  assert.equal(finding!.evidence[0]!.category, 'forum_post');
  assert.equal(finding!.confidence.score, 50);
  assert.deepEqual(finding!.confidence.ledger.map((entry) => entry.rule), ['base.forum_post', 'basis.text_declaration']);
  assert.ok(finding!.notes!.some((note) => note.startsWith('Deklaracja własności w treści (reguła tekstowa): autor „wilczek_x9”')));
  assert.ok(result.log.some((entry) => entry.message.includes('deklaracja własności w treści (reguła tekstowa) — autor „wilczek_x9” podaje adres jako własny')));

  assert.deepEqual(dossier.persons.map((person) => person.profileIds), [['forum.example|wilczek_x9']]);
  assert.equal(dossier.persons[0]!.probability, 60);
  assert.ok(dossier.findings[0]!.confidence.ledger.some((entry) => entry.rule === 'basis.text_declaration'));
  assert.ok(!dossier.explanations.some((item) => item.kind === 'no_owner'));
});

test('pułapki: przeczenie, ostrzeżenie, rozdanie, opis wpłaty i masowy komentarz nie wskazują nikogo', async () => {
  const traps: [string, Post[]][] = [
    ['„mój adres to nie …”', [{ url: 'https://forum.example/t/1', author: 'ktos', text: `Mój adres to nie ${BTC_A}, tamten ktoś podrobił — mój jest na profilu.` }]],
    [
      'wątek z ostrzeżeniem',
      [
        { url: 'https://forum.example/t/2', author: 'czujny', text: `Uwaga, scam na grupie! Każą wpłacać na ${BTC_A}.` },
        { url: 'https://forum.example/t/2/2', author: 'pytajacy', text: `Ktoś zna ${BTC_A}? Dostałem link z tym adresem.` },
        { url: 'https://forum.example/t/2/3', author: 'poszkodowany', text: `Wysłałem 0,1 BTC na ${BTC_A} i cisza.` },
      ],
    ],
    ['rozdanie', [{ url: 'https://forum.example/t/3', author: 'mega_bonus', text: `MEGA ROZDANIE! Wpłaty na mój adres ${BTC_A}, odsyłamy x2 w godzinę.` }]],
    ['masowy komentarz z „mój adres”', [{ url: 'https://social.example/k/4', author: 'komentator', category: 'mass_comment', text: `Mój adres ${BTC_A} — biorę udział!` }]],
    ['cytat cudzej deklaracji bez wpisu właściciela', [{ url: 'https://forum.example/t/5', author: 'odpowiadajacy', text: `krypto_janek napisał: mój adres do wpłat ${BTC_A}\n\nDzięki, przelew poszedł.` }]],
  ];
  for (const [name, posts] of traps) {
    const { result, dossier } = await analyse(posts);
    assert.equal(result.findings[0]!.evidence.length, 0, name);
    assert.deepEqual(dossier.persons, [], name);
    assert.equal(result.findings[0]!.unrelatedPublishers, posts.length, name);
    // Teczka mówi, dlaczego nie ma osoby, i co zrobić.
    const explanation = dossier.explanations.find((item) => item.kind === 'no_owner');
    assert.ok(explanation, name);
    assert.match(explanation!.text, /pojawia się tylko we wzmiankach lub cytatach/, name);
  }
});

test('odpowiedź cytująca deklarację właściciela: kandydatem jest tylko właściciel, nie cytujący', async () => {
  const { result, dossier } = await analyse([
    { url: 'https://forum.example/t/9', author: 'sprzedawca_rowerow', text: `Rower nadal dostępny. Płatność na ${BTC_A} albo gotówką.` },
    { url: 'https://forum.example/t/9/2', author: 'kupujacy', text: `> Płatność na ${BTC_A} albo gotówką.\nBiorę, przelew dziś wieczorem.` },
    { url: 'https://forum.example/t/9/3', author: 'gapowicz', text: `„Płatność na ${BTC_A}” — czy to na pewno jego adres?` },
  ]);
  assert.deepEqual(result.findings[0]!.evidence.map((item) => item.author), ['sprzedawca_rowerow']);
  assert.equal(result.findings[0]!.unrelatedPublishers, 2);
  assert.deepEqual(dossier.persons.map((person) => person.profileIds), [['forum.example|sprzedawca_rowerow']]);
});

test('odczyt modelu ma pierwszeństwo przed regułą tekstową', async () => {
  const post = { url: 'https://forum.example/t/11', author: 'krypto_janek', text: `Wpłaty na ${BTC_A} — dziękuję za wsparcie!` };
  // Model stwierdza (z cytatem), że adres należy do kogoś innego — reguła ustępuje.
  const vetoed = await analyse([post], { ai: fakeAi(() => ({ ownership: 'third_party_address', quote: 'Wpłaty na' })) });
  assert.equal(vetoed.result.findings[0]!.evidence.length, 0);
  assert.deepEqual(vetoed.dossier.persons, []);
  assert.ok(vetoed.result.log.some((entry) => entry.message.includes('uchyla regułę tekstową')));
  // Model potwierdza własność — podstawą jest model, nie reguła tekstowa.
  const confirmed = await analyse([post], { ai: fakeAi(() => ({ ownership: 'own_address', quote: 'Wpłaty na' })) });
  assert.equal(confirmed.result.findings[0]!.evidence.length, 1);
  assert.equal(confirmed.result.findings[0]!.evidence[0]!.ownershipBasis, undefined);
  // Model bez odczytu (błąd, brak odpowiedzi) — reguła tekstowa działa dalej.
  const silent = await analyse([post], { ai: fakeAi(() => null) });
  assert.equal(silent.result.findings[0]!.evidence[0]!.ownershipBasis?.rule, 'text_declaration');
  // Jawna kategoria źródła (oferta) ma pierwszeństwo: ślad bez wpisu reguły tekstowej.
  const offer = await analyse([{ ...post, category: 'sale_offer' }]);
  assert.deepEqual(offer.result.findings[0]!.confidence.ledger.map((entry) => entry.rule), ['base.sale_offer']);
});

test('wyjaśnienie braku osoby: adres usługi i brak publikacji', async () => {
  const service = await runAnalysis({ query, connectors: [forum([])], chainProviders: [chainWith({ [BTC_A]: { addressClass: 'exchange', label: 'Giełda Testowa: Hot Wallet' } })] });
  const serviceExplanation = dossierOf(service, query).explanations.find((item) => item.kind === 'no_owner');
  assert.match(serviceExplanation!.text, /należy według publicznych etykiet do giełdy lub portfela powierniczego \(„Giełda Testowa: Hot Wallet”\)/);
  assert.ok(serviceExplanation!.suggestions.some((item) => item.startsWith('Podaj adres portfela')));

  const nothing = await runAnalysis({ query, connectors: [forum([])], chainProviders: [fakeProvider()] });
  const [first] = dossierOf(nothing, query).explanations;
  assert.equal(first!.kind, 'no_owner');
  assert.match(first!.text, /^Nie wskazano osoby: w przeszukanych źródłach \(1 źródło\) nie znaleziono żadnej publikacji adresu/);
  assert.deepEqual(first!.suggestions, [
    'Uruchom analizę w trybie głębokim — przeszukuje dodatkowo kilkaset forów.',
    'Włącz źródła wyszukiwania pełnotekstowego (wyszukiwarka internetowa: MARGINALIA_API_KEY=public; wyszukiwarka kodu GitHuba: GITHUB_TOKEN) — szukają pełnego adresu w indeksach stron.',
    'Jeśli znasz nick, e-mail lub profil podejrzewanej osoby, podaj go — analiza sprawdzi, czy publikuje ten adres.',
    WALLET_HINT,
  ]);
  // Gdy osoba jest wskazana — nie ma wyjaśnienia o braku osoby; przy sprawie osoby — też nie.
  const person = await runAnalysis({ query: { identifiers: [{ type: 'nick', value: 'janek' }] }, connectors: [], chainProviders: [] });
  assert.ok(!dossierOf(person, { identifiers: [{ type: 'nick', value: 'janek' }] }).explanations.some((item) => item.kind === 'no_owner'));
});

test('rozszerzanie przez portfel: adresy z tego samego portfela i współwpłacający są sprawdzane w źródłach — jako trop, nie osoba', async () => {
  const links = [
    { address: BTC_B, kind: 'same_wallet', strength: 75, reason: 'heurystyka wspólnych wejść', txids: ['b'.repeat(64)] },
    { address: BTC_C, kind: 'co_depositor', strength: 80, via: BTC_D, service: 'Giełda Testowa', txids: ['c'.repeat(64)] },
  ];
  const provider = {
    ...fakeProvider(),
    getActivity: async (network: 'bitcoin', address: string) => ({ ...fakeActivity(network, address, 'private'), ...(address === BTC_A ? { linkedAddresses: links } : {}) }),
  };
  const sources = fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) =>
    identifier.value === BTC_B
      ? [{ url: 'https://forum.example/u/portfelowy', author: 'portfelowy', category: 'forum_post' as const, text: `Mój adres do napiwków: ${BTC_B}` }]
      : identifier.value === BTC_C
        ? [{ url: 'https://forum.example/u/wplacajacy', author: 'wplacajacy', category: 'own_profile' as const, text: `BTC: ${BTC_C}` }]
        : [],
  );
  const result = await runAnalysis({ query, connectors: [sources], chainProviders: [provider] });
  // Oba powiązane adresy sprawdzono w źródłach (zapytania o adres).
  assert.deepEqual(sources.calls.map((item) => item.value).sort(), [BTC_A, BTC_B, BTC_C].sort());
  const leads = result.intel.pivot ?? [];
  const wallet = leads.find((lead) => lead.value === BTC_B)!;
  assert.equal(wallet.kind, 'linked_address');
  assert.equal(wallet.author, 'portfelowy');
  assert.ok(wallet.path.some((step) => step.includes('ten sam portfel (heurystyka)')));
  const deposit = leads.find((lead) => lead.value === BTC_C)!;
  assert.equal(deposit.author, 'wplacajacy');
  assert.ok(deposit.path.some((step) => step.includes('na ten sam adres wpłat wpłaca także adres')));
  // Publikujący adres powiązany to POWIĄZANA TOŻSAMOŚĆ, nie osoba z adresu sprawy.
  assert.ok(result.intel.sightings.filter((item) => ['portfelowy', 'wplacajacy'].includes(item.author ?? '')).every((item) => item.role === 'linked_identity'));
  const linked = result.findings.find((finding) => finding.address === BTC_B)!;
  assert.equal(linked.linkedOnly, true);
  assert.equal(linked.confidence.score, 0);
  // Wypowiedź z deklaracją dostaje podstawę z reguły tekstowej także w pętli rozszerzania.
  assert.equal(linked.evidence[0]!.ownershipBasis?.rule, 'text_declaration');
  const dossier = dossierOf(result, query);
  assert.deepEqual(dossier.persons, []);
});

test('rozwiązanie odwrotne ENS (dowód kryptograficzny) wskazuje osobę mimo wielu cytujących', async () => {
  const ethQuery = { identifiers: [{ type: 'crypto_address' as const, value: ETH_A }] };
  const ens = fakeConnector('live-ens', 'ens.domains', ['crypto_address'], (identifier) => [
    { url: 'https://app.ens.domains/janek.eth', author: 'janek.eth', category: 'cryptographic_proof' as const, identityMatch: 'name_only' as const, text: `Nazwa ENS: janek.eth\nAdres (ETH): ${identifier.value}`, profile: { handle: 'janek.eth' } },
  ]);
  const commenters = fakeConnector('forum', 'forum.example', ['crypto_address'], (identifier) => [
    ...Array.from({ length: 12 }, (_, index) => ({ url: `https://forum.example/c/${index}`, author: `fan_${index}`, category: 'forum_post' as const, text: `Ciekawe, co robi ${identifier.value}` })),
    // Strona projektu podająca znany adres jako przykład — jawna kategoria „profil”, ale słabsza od dowodu.
    { url: 'https://projekt.example/', author: 'biblioteka', category: 'own_profile' as const, text: `Przykład: getBalance("${identifier.value}")` },
  ]);
  const result = await runAnalysis({ query: ethQuery, connectors: [ens, commenters], chainProviders: [fakeProvider()] });
  const [finding] = result.findings;
  assert.equal(finding!.widelyCited, undefined);
  assert.equal(finding!.confidence.ledger[0]!.rule, 'base.cryptographic_proof');
  const dossier = dossierOf(result, ethQuery);
  // Dowód kryptograficzny potwierdza przynależność profilu (podstawa 90) — wyprzedza autora z samą publikacją (60).
  assert.deepEqual(dossier.persons[0]!.profileIds, ['ens.domains|janek.eth']);
  assert.equal(dossier.persons[0]!.probability, 90);
  assert.ok(dossier.persons.slice(1).every((person) => person.probability < 90));
});

test('reguła tekstowa nie czyta plików kodu, ale czyta README i dokumentację', async () => {
  const posts: Post[] = [
    { url: 'https://github.com/autor-kodu/narzedzie/blob/main/src/config.ts', author: 'autor-kodu', text: `// my wallet for tests\nconst A = "${BTC_A}";` },
    { url: 'https://github.com/autor-readme/projekt/blob/main/README.md', author: 'autor-readme', text: `Plik README.md w repozytorium autor-readme/projekt:\nDonate: ${BTC_A}` },
  ];
  const { result } = await analyse(posts);
  assert.deepEqual(result.findings[0]!.evidence.map((item) => item.author), ['autor-readme']);
  assert.equal(result.findings[0]!.unrelatedPublishers, 1);
});
