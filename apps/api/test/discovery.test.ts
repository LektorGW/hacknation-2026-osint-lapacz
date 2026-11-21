import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnalysis } from '../src/analysis.ts';
import { createLimiter } from '../src/concurrency.ts';
import { BTC_A, BTC_B, BTC_C, ETH_A, fakeConnector, fakeProvider } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };

/** Łańcuch profili: każdy wskazuje następny nick; adres jest dopiero w trzecim kroku. */
const chainOfProfiles = () =>
  fakeConnector('lancuch', 'serwis.example', ['nick'], (identifier) => {
    const next: Record<string, string | undefined> = { krypto_janek: 'krok1', krok1: 'krok2', krok2: 'krok3', krok3: 'krok4' };
    const target = next[identifier.value];
    return [
      {
        url: `https://serwis.example/${identifier.value}`,
        author: identifier.value,
        text: identifier.value === 'krok3' ? `Adres ${BTC_A}` : identifier.value === 'krok1' ? `Adres ${BTC_B}` : 'Profil bez adresu.',
        discoveredIdentifiers: target ? [{ type: 'nick' as const, value: target }] : [],
      },
    ];
  });

test('odkrywanie wielokrokowe: domyślnie trzy kroki, ze ścieżką dojścia', async () => {
  const connector = chainOfProfiles();
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [fakeProvider()] });

  // Krok 0 to identyfikator analityka, potem trzy kroki odkrywania; „krok4” jest już poza zasięgiem.
  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek', 'krok1', 'krok2', 'krok3']);
  assert.deepEqual(result.findings.map((finding) => finding.address).sort(), [BTC_A, BTC_B].sort());

  const trail = result.intel.trail;
  assert.deepEqual(
    trail.map((entry) => [entry.identifier.value, entry.step, entry.via.value, entry.sourceUrl, entry.followed]),
    [
      ['krok1', 1, 'krypto_janek', 'https://serwis.example/krypto_janek', true],
      ['krok2', 2, 'krok1', 'https://serwis.example/krok1', true],
      ['krok3', 3, 'krok2', 'https://serwis.example/krok2', true],
      ['krok4', 4, 'krok3', 'https://serwis.example/krok3', false],
    ],
  );
  assert.ok(result.log.some((entry) => entry.message.includes('Odkryty identyfikator (krok 2)')));
});

test('ocena tożsamości słabnie z każdym krokiem bez odnośnika zwrotnego', async () => {
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [chainOfProfiles()], chainProviders: [fakeProvider()] });
  const distanceOf = (url: string) => result.intel.sightings.find((item) => item.url === url)!.identity.distance;

  assert.equal(distanceOf('https://serwis.example/krypto_janek'), 0);
  assert.equal(distanceOf('https://serwis.example/krok1'), 1);
  assert.equal(distanceOf('https://serwis.example/krok3'), 3);
  const far = result.findings.find((finding) => finding.address === BTC_A)!.evidence[0]!;
  assert.equal(far.identityMatch, 'linked_profile');
  assert.match(far.identityReasons![0]!, /3 krokach bez odnośnika zwrotnego/);
});

test('odnośnik zwrotny do identyfikatora analityka potwierdza profil z dalszego kroku', async () => {
  const connector = fakeConnector('pary', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://serwis.example/a', author: 'krypto_janek', text: 'Profil.', discoveredIdentifiers: [{ type: 'nick' as const, value: 'drugi_profil' }] }]
      : [{ url: 'https://serwis.example/b', author: 'drugi_profil', text: `Mój drugi profil to krypto_janek. Adres ${BTC_C}` }],
  );
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [connector], chainProviders: [fakeProvider()] });

  assert.equal(result.findings[0]!.evidence[0]!.identityMatch, 'verified_link');
  assert.equal(result.intel.sightings.find((item) => item.url === 'https://serwis.example/b')!.identity.mutual, true);
});

test('limit liczby identyfikatorów zatrzymuje odkrywanie i trafia do dziennika', async () => {
  const connector = fakeConnector('szeroki', 'serwis.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [
          {
            url: 'https://serwis.example/krypto_janek',
            text: 'Profil z wieloma odnośnikami.',
            // Powtórzenie tego samego nicku nie może zostać policzone ani wyszukane dwa razy.
            discoveredIdentifiers: ['a1', 'a2', 'A1', 'a3', 'a4', 'a5'].map((value) => ({ type: 'nick' as const, value: `konto_${value}` })),
          },
        ]
      : [],
  );
  const result = await runAnalysis({
    query: { identifiers: [nick] },
    connectors: [connector],
    chainProviders: [],
    maxIdentifiers: 4,
  });

  // 1 podany + 3 odkryte = limit 4.
  assert.deepEqual(connector.calls.map((call) => call.value), ['krypto_janek', 'konto_a1', 'konto_a2', 'konto_a3']);
  assert.deepEqual(result.intel.trail.map((entry) => entry.followed), [true, true, true, false, false]);
  assert.ok(result.log.some((entry) => entry.message.includes('Osiągnięto limit 4 identyfikatorów')));
});

test('limit współbieżności: jednocześnie działa najwyżej tyle zadań, ile dopuszczono', async () => {
  const limited = createLimiter(2);
  let active = 0;
  let peak = 0;
  const results = await Promise.all(
    [1, 2, 3, 4, 5, 6].map((value) =>
      limited(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return value * 2;
      }),
    ),
  );
  assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
  assert.equal(peak, 2);
});

test('nazwa ENS z treści wpisu nie jest śledzona jako nazwa podmiotu, chyba że prowadzi do jego adresu', async () => {
  const ens = { type: 'ens_name' as const, value: 'janek.eth' };
  const resolver = fakeConnector('live-ens', 'ens.domains', ['ens_name'], (identifier) => {
    const records: Record<string, string> = { 'janek.eth': ETH_A, 'foo.eth': BTC_B, 'janek-drugi.eth': ETH_A };
    const address = records[identifier.value];
    return address
      ? [{ url: `https://app.ens.domains/${identifier.value}`, author: identifier.value, category: 'cryptographic_proof' as const, identityMatch: 'verified_link' as const, text: `Rekord adresu: ${address}`,
          // Rekord podmiotu wskazuje jego konto — to identyfikator z profilu.
          discoveredIdentifiers: identifier.value === 'janek.eth' ? [{ type: 'login' as const, value: 'janek_dev' }] : [] }]
      : [];
  });
  const forum = fakeConnector('forum', 'forum.example', ['login'], () => [
    {
      url: 'https://forum.example/t/1',
      author: 'janek_dev',
      category: 'forum_post' as const,
      text: 'Przykład: wyślij środki na foo.eth, a ja używam też janek-drugi.eth.',
      discoveredIdentifiers: [{ type: 'ens_name' as const, value: 'foo.eth' }, { type: 'ens_name' as const, value: 'janek-drugi.eth' }],
    },
  ]);
  // Wyszukiwarka forów nie może być pytana o nazwę z cudzej treści.
  const deepSearch = fakeConnector('deep-search', 'inne.example', ['ens_name'], () => []);
  const result = await runAnalysis({ query: { identifiers: [ens] }, connectors: [resolver, forum, deepSearch], chainProviders: [fakeProvider()] });

  // Cudza nazwa: sprawdzona tylko w rejestrze, odrzucona, bez adresu i bez profilu.
  assert.deepEqual(result.findings.map((finding) => finding.address), [ETH_A]);
  assert.deepEqual(deepSearch.calls.map((call) => call.value), ['janek.eth']);
  const byName = new Map(result.intel.trail.map((entry) => [entry.identifier.value, entry.followed]));
  assert.deepEqual([byName.get('janek_dev'), byName.get('foo.eth'), byName.get('janek-drugi.eth')], [true, false, true]);
  assert.ok(result.log.some((entry) => entry.message.includes('„foo.eth” wymieniono w treści publikacji, ale nie prowadzi do adresu podmiotu')));
  assert.ok(!result.intel.sightings.some((item) => item.url.includes('foo.eth')));
  // Druga nazwa rozwiązuje się na adres podmiotu — zostaje jako jego profil.
  assert.ok(result.intel.sightings.some((item) => item.url === 'https://app.ens.domains/janek-drugi.eth'));
});

test('identyfikatory z cudzej wzmianki przyjętej po danych kontaktowych nie są śledzone', async () => {
  const email = { type: 'email' as const, value: 'jan.kowalski@poczta.example' };
  const deepSearch = fakeConnector('deep-search', 'forum.example', ['email', 'nick'], (identifier) =>
    identifier.type === 'email'
      ? [{ url: 'https://forum.example/t/9', author: 'ktos_inny', category: 'forum_post' as const, text: `Pisać na jan.kowalski@poczta.example, adres ${BTC_A}`, discoveredIdentifiers: [{ type: 'nick' as const, value: 'cudzy_nick' }] }]
      : [],
  );
  const result = await runAnalysis({ query: { identifiers: [email] }, connectors: [deepSearch], chainProviders: [fakeProvider()] });

  assert.equal(result.findings.length, 1);
  assert.deepEqual(deepSearch.calls.map((call) => call.value), ['jan.kowalski@poczta.example']);
  assert.deepEqual(result.intel.trail, []);
});

test('wzmianki: po przekroczeniu progu autorów kolejne źródła wyszukiwawcze są pomijane', async () => {
  const ens = { type: 'ens_name' as const, value: 'janek.eth' };
  const mentions = (service: string, count: number) =>
    fakeConnector(`mon-${service}`, `${service}.example`, ['ens_name'], () =>
      Array.from({ length: count }, (_, index) => ({ url: `https://${service}.example/p/${index}`, author: `fan_${service}_${index}`, category: 'forum_post' as const, identityMatch: 'name_only' as const, text: `podziwiam janek.eth (${index})` })),
    );
  const connectors = [mentions('a', 4), mentions('b', 4), mentions('c', 4), mentions('d', 4)];
  // Jedno zapytanie naraz — kolejność źródeł jest wtedy pewna.
  const result = await runAnalysis({ query: { identifiers: [ens] }, connectors, chainProviders: [], mentionStopAuthors: 6, concurrency: 1 });

  // Po dwóch źródłach jest 8 autorów (> 6): trzecie i czwarte nie są już pytane.
  assert.deepEqual(connectors.map((connector) => connector.calls.length), [1, 1, 0, 0]);
  assert.deepEqual(result.intel.mentions, [{ identifier: ens, documents: 8, authors: 8, services: 2, atLeast: true }]);
  assert.ok(result.log.some((entry) => entry.message.includes('co najmniej 8 niepowiązanych autorów (próg 6)')));
  assert.equal(result.intel.partial, undefined);
});

test('analiza blockchain startuje równolegle z wyszukiwaniem, gdy adres ma mocny ślad', async () => {
  const events: string[] = [];
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
  const profile = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek'
      ? [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}`, discoveredIdentifiers: [{ type: 'nick' as const, value: 'drugi' }] }]
      : [],
  );
  // Drugi krok wyszukiwania trwa długo — analiza łańcucha nie może na niego czekać.
  const slow = fakeConnector('wolny', 'wolny.example', ['nick'], () => []);
  const search = slow.search.bind(slow);
  slow.search = async (identifier, context) => {
    if (identifier.value === 'drugi') {
      events.push('wolne wyszukiwanie: start');
      await slowGate;
      events.push('wolne wyszukiwanie: koniec');
    }
    return search(identifier, context);
  };
  const provider = {
    ...fakeProvider(),
    getActivity: async (network: 'bitcoin', address: string) => {
      events.push('łańcuch: pobrano');
      releaseSlow();
      return fakeProvider().getActivity(network, address, { log() {} });
    },
  };
  const result = await runAnalysis({ query: { identifiers: [nick] }, connectors: [profile, slow], chainProviders: [provider] });

  // Dane łańcucha są gotowe, zanim skończy się wolne wyszukiwanie (które czeka właśnie na nie).
  assert.ok(events.indexOf('łańcuch: pobrano') >= 0 && events.indexOf('łańcuch: pobrano') < events.indexOf('wolne wyszukiwanie: koniec'));
  assert.equal(events.at(-1), 'wolne wyszukiwanie: koniec');
  assert.equal(result.findings[0]!.chain?.profile.address, BTC_A);
});
