import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Identifier, StoredEvidence } from '@olcys/core';
import { effectiveUnrelatedPublishers, runAnalysis } from '../src/analysis.ts';
import { BTC_A, BTC_C, dossierOf, fakeConnector, fakeProvider } from './helpers.ts';

const nick: Identifier = { type: 'nick', value: 'krypto_janek' };

/** Własny profil podmiotu: jeden wpis podaje własny adres, drugi OSTRZEGA przed cudzym adresem. */
const ownProfileWithWarning = () => [
  fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie projektu: ${BTC_A}`, profile: { handle: 'krypto_janek' } },
    {
      url: 'https://gitpub.example/krypto_janek/wpis/2',
      author: 'krypto_janek',
      text: `Uwaga! Nie wpłacajcie na ten adres ${BTC_C}, to oszust podszywający się pode mnie.`,
      profile: { handle: 'krypto_janek' },
    },
  ]),
];

test('ostrzeżenie na własnym profilu przed adresem nie jest podstawą własności (bez modelu)', async () => {
  const query = { identifiers: [nick] };
  const result = await runAnalysis({ query, connectors: ownProfileWithWarning(), chainProviders: [fakeProvider()] });

  // Zwykła publikacja własnego adresu — bez zmian.
  const own = result.findings.find((finding) => finding.address === BTC_A)!;
  assert.ok(own.evidence.length > 0);
  assert.ok(own.confidence.score > 0);

  // Adres, przed którym autor ostrzega: brak śladu własności, wynik 0 i adnotacja.
  const warned = result.findings.find((finding) => finding.address === BTC_C)!;
  assert.equal(warned.evidence.length, 0);
  assert.equal(warned.confidence.score, 0);
  assert.ok((warned as { notes?: string[] }).notes?.some((note) => note.includes('OSTRZEGA przed tym adresem')));

  // W teczce adres nie jest przypisany osobie.
  const dossier = dossierOf(result, query);
  assert.equal(dossier.findings.find((finding) => finding.address === BTC_C)!.confidence.score, 0);
  assert.ok(!dossier.persons.some((person) => person.addresses.some((item) => item.key === `bitcoin:${BTC_C}`)));
  assert.ok(dossier.persons[0]!.addresses.some((item) => item.key === `bitcoin:${BTC_A}`));
});

test('potwierdzony profil ostrzegający przed adresem nie znosi reguły adresu współdzielonego', () => {
  const evidence = (excerpt: string) =>
    ({ id: 'ev-1', category: 'own_profile', identityMatch: 'verified_link', url: 'https://gitpub.example/a', excerpt, contentHash: 'x', service: 'gitpub.example' }) as unknown as StoredEvidence;

  // Publikacja własnego adresu przez potwierdzony profil: cytowania nie obniżają wyniku (bez zmian).
  assert.equal(effectiveUnrelatedPublishers([evidence(`Wsparcie projektu: ${BTC_A}`)], 12, BTC_A), 0);
  // Ostrzeżenie przed adresem: liczba niezależnych cytujących zostaje.
  const warning = evidence(`Nie wpłacajcie na ten adres ${BTC_A}, to oszust!`);
  assert.equal(effectiveUnrelatedPublishers([warning], 12, BTC_A), 12);
  // Bez wskazanego adresu (wywołanie z teczki) — odczyt z adresów we fragmencie.
  assert.equal(effectiveUnrelatedPublishers([warning], 12), 12);
  // Dowód kryptograficzny nadal ma pierwszeństwo.
  assert.equal(effectiveUnrelatedPublishers([{ ...warning, category: 'cryptographic_proof' } as StoredEvidence], 12, BTC_A), 0);
});
