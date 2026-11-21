import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnalysis } from '../src/analysis.ts';
import { createLimiter } from '../src/concurrency.ts';
import { BTC_A, BTC_B, BTC_C, fakeConnector, fakeProvider } from './helpers.ts';

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
