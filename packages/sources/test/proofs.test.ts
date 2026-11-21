// Podpisane wiadomości w treści publikacji: wykrywanie, weryfikacja i zasada dowodowa.
// Klucze powstają w teście (w pamięci); żadnych połączeń z siecią.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeConfidence, extractAddresses } from '@olcys/core';
import type { Evidence, SourceDocument } from '@olcys/core';
import { createTestWallet, signBitcoinMessage, signEthereumMessage, signTronMessage } from '../../core/test/signing-helpers.ts';
import { htmlToText } from '../src/html.ts';
import { createConnectors } from '../src/index.ts';
import { applyOwnershipProofs, findOwnershipProofs, proofUrl, PROOF_NOTE_PREFIX } from '../src/proof-text.ts';

const owner = createTestWallet();
const stranger = createTestWallet();

const block = (address: string, message: string, signature: string) =>
  ['-----BEGIN BITCOIN SIGNED MESSAGE-----', message, '-----BEGIN SIGNATURE-----', address, signature, '-----END BITCOIN SIGNED MESSAGE-----'].join('\n');

const doc = (text: string, overrides: Partial<SourceDocument> = {}): SourceDocument => ({
  connectorId: 'test',
  service: 'forum.example',
  url: 'https://forum.example/u/jan_tester',
  title: 'Profil jan_tester',
  text,
  fetchedAt: '2026-11-21T10:00:00.000Z',
  author: 'jan_tester',
  category: 'own_profile',
  identityMatch: 'exact_identifier',
  matchedIdentifier: { type: 'nick', value: 'jan_tester' },
  profile: { handle: 'jan_tester', displayName: 'Jan Testowy' },
  discoveredIdentifiers: [{ type: 'email', value: 'jan@tester.example' }],
  ...overrides,
});

/** Ślady dla jednego adresu — tak jak buduje je analiza: każdy dokument z adresem to jeden ślad. */
const evidenceFor = (documents: SourceDocument[], address: string): Evidence[] =>
  documents
    .filter((document) => extractAddresses(document.text).some((found) => found.address === address))
    .map((document, i) => ({
      id: `e${i}`,
      category: document.category,
      service: document.service,
      url: document.url,
      capturedAt: document.fetchedAt,
      identityMatch: document.identityMatch,
    }));

describe('findOwnershipProofs — rozpoznawane zapisy', () => {
  const message = 'Ja, jan_tester, potwierdzam, że to mój adres. 2026-11-21';

  test('klasyczny blok BEGIN BITCOIN SIGNED MESSAGE (P2PKH, P2SH-P2WPKH, P2WPKH)', () => {
    const cases = [
      [owner.p2pkh, 'p2pkh', 'bitcoin-message/p2pkh'],
      [owner.p2shP2wpkh, 'p2sh-p2wpkh', 'bitcoin-message/p2sh-p2wpkh'],
      [owner.p2wpkh, 'p2wpkh', 'bitcoin-message/p2wpkh'],
    ] as const;
    for (const [address, kind, scheme] of cases) {
      const text = `Moje dane.\n${block(address, message, signBitcoinMessage(owner.privateKey, message, kind))}\nKoniec.`;
      const [proof, ...rest] = findOwnershipProofs(text);
      assert.equal(rest.length, 0);
      assert.deepEqual(
        { address: proof!.address, network: proof!.network, message: proof!.message, valid: proof!.valid, scheme: proof!.scheme, format: proof!.format },
        { address, network: 'bitcoin', message, valid: true, scheme, format: 'signed_block' },
      );
      assert.match(proof!.excerpt, /BEGIN BITCOIN SIGNED MESSAGE/);
    }
  });

  test('blok po zamianie HTML na tekst i blok spłaszczony do jednego wiersza', () => {
    const signature = signBitcoinMessage(owner.privateKey, message, 'p2wpkh');
    const html = `<p>Dowód:</p><pre>${block(owner.p2wpkh, message, signature)}</pre>`;
    assert.equal(findOwnershipProofs(htmlToText(html))[0]!.valid, true);
    const flat = block(owner.p2wpkh, message, signature).replace(/\n/g, ' ');
    assert.equal(findOwnershipProofs(flat)[0]!.valid, true);
    // Wariant z etykietami w części podpisu (np. Electrum, Bitcoin-Qt).
    const labelled = ['-----BEGIN BITCOIN SIGNED MESSAGE-----', message, '-----BEGIN BITCOIN SIGNATURE-----', 'Version: Bitcoin-qt (1.0)', `Address: ${owner.p2wpkh}`, '', signature, '-----END BITCOIN SIGNATURE-----'].join('\n');
    assert.equal(findOwnershipProofs(labelled)[0]!.valid, true);
  });

  test('JSON w stylu Etherscan: {"address","msg","sig"}', () => {
    const signature = signEthereumMessage(owner.privateKey, message);
    const json = JSON.stringify({ address: owner.ethereum, msg: message, sig: signature, version: '2' });
    const [proof] = findOwnershipProofs(`Podpis do sprawdzenia: ${json} — dziękuję.`);
    assert.deepEqual([proof!.address, proof!.network, proof!.valid, proof!.scheme, proof!.format], [owner.ethereum, 'ethereum', true, 'eip191-personal-sign', 'json']);
    // Adres zapisany małymi literami też jest rozpoznawany (zapis kanoniczny EIP-55 w wyniku).
    const lower = JSON.stringify({ address: owner.ethereum.toLowerCase(), message, signature });
    assert.deepEqual([findOwnershipProofs(lower)[0]!.address, findOwnershipProofs(lower)[0]!.valid], [owner.ethereum, true]);
  });

  test('trójka Address / Message / Signature — po angielsku, po polsku i w jednym wierszu', () => {
    const btc = signBitcoinMessage(owner.privateKey, message, 'p2pkh');
    const english = `Address: ${owner.p2pkh}\nMessage: ${message}\nSignature: ${btc}`;
    assert.deepEqual([findOwnershipProofs(english)[0]!.valid, findOwnershipProofs(english)[0]!.format], [true, 'labelled_triple']);
    const polish = `Wiadomość: „${message}"\nAdres: ${owner.p2pkh}\nPodpis: ${btc}`;
    assert.equal(findOwnershipProofs(polish)[0]!.valid, true);
    assert.equal(findOwnershipProofs(polish)[0]!.message, message);
    const tron = signTronMessage(owner.privateKey, message);
    const oneLine = `Dowód — Adres: ${owner.tron} Wiadomość: ${message} Podpis: ${tron}`;
    assert.deepEqual([findOwnershipProofs(oneLine)[0]!.network, findOwnershipProofs(oneLine)[0]!.valid, findOwnershipProofs(oneLine)[0]!.scheme], ['tron', true, 'tip191-sign-message-v2']);
  });

  test('podpis cudzym kluczem albo zmieniona wiadomość — dowód nieważny, z powodem', () => {
    const foreign = block(owner.p2wpkh, message, signBitcoinMessage(stranger.privateKey, message, 'p2wpkh'));
    const [bad] = findOwnershipProofs(foreign);
    assert.equal(bad!.valid, false);
    assert.match(bad!.reason!, /nie weryfikuje się dla tego adresu/);
    const altered = block(owner.p2wpkh, `${message} (dopisek)`, signBitcoinMessage(owner.privateKey, message, 'p2wpkh'));
    assert.equal(findOwnershipProofs(altered)[0]!.valid, false);
  });

  test('tekst bez podpisów i śmieci nie dają wyników ani wyjątków', () => {
    assert.deepEqual(findOwnershipProofs('Zwykły opis profilu z adresem bc1qxhvk23usdd66dddy8lvafvv47v5aa9jz6kl0ze.'), []);
    assert.deepEqual(findOwnershipProofs('Signature: brak\nAddress: nie ma\nMessage: nic'), []);
    assert.deepEqual(findOwnershipProofs('-----BEGIN BITCOIN SIGNED MESSAGE-----\nx\n-----BEGIN SIGNATURE-----\nnic\n-----END BITCOIN SIGNED MESSAGE-----'), []);
    assert.deepEqual(findOwnershipProofs('{"sig": 5, "address": []}'), []);
    assert.deepEqual(findOwnershipProofs(undefined as unknown as string), []);
  });
});

describe('applyOwnershipProofs — zasada dowodowa', () => {
  const message = 'Konto jan_tester na forum.example należy do mnie — podpisano 2026-11-21.';
  const signature = signBitcoinMessage(owner.privateKey, message, 'p2wpkh');
  const otherAddress = stranger.p2pkh;

  test('1) podpis poprawny, wiadomość wymienia konto publikujące → osobny dokument cryptographic_proof, wynik 95', () => {
    const source = doc(`Zbieram też na ${otherAddress}.\n${block(owner.p2wpkh, message, signature)}`);
    const [original, proof, ...rest] = applyOwnershipProofs(source);
    assert.equal(rest.length, 0);
    // Dokument pierwotny: kategoria bez zmian, dopisana uwaga.
    assert.equal(original!.category, 'own_profile');
    assert.equal(original!.url, source.url);
    assert.ok(original!.text.startsWith(source.text));
    assert.match(original!.text, /Podpis poprawny: wiadomość wymieniająca konto „jan_tester"/);
    assert.deepEqual(original!.discoveredIdentifiers, source.discoveredIdentifiers);
    // Dokument-dowód: tylko podpisany adres, ten sam serwis i autor, osobny adres URL.
    assert.equal(proof!.category, 'cryptographic_proof');
    assert.equal(proof!.url, `${source.url}?podpis=${owner.p2wpkh}`);
    // Adres z parametrami (np. profil forum) i z fragmentem.
    assert.equal(proofUrl('https://forum.example/index.php?action=profile;u=3#top', owner.p2wpkh), `https://forum.example/index.php?action=profile;u=3&podpis=${owner.p2wpkh}`);
    assert.deepEqual([proof!.service, proof!.author, proof!.identityMatch, proof!.connectorId], [source.service, source.author, source.identityMatch, source.connectorId]);
    assert.equal(proof!.discoveredIdentifiers, undefined);
    assert.deepEqual(extractAddresses(proof!.text).map((found) => found.address), [owner.p2wpkh]);
    assert.ok(proof!.text.includes(signature) && proof!.text.includes(message));

    const all = [original!, proof!];
    const proven = computeConfidence({ evidence: evidenceFor(all, owner.p2wpkh), addressClass: 'private' });
    assert.equal(proven.score, 95);
    assert.equal(proven.ledger[0]!.rule, 'base.cryptographic_proof');
    // Ten sam serwis: dowód nie jest drugim niezależnym źródłem.
    assert.equal(proven.independentSources, 1);
    // Drugi adres z tej samej publikacji nie korzysta z cudzego dowodu.
    assert.equal(computeConfidence({ evidence: evidenceFor(all, otherAddress), addressClass: 'private' }).score, 85);
  });

  test('1) wiadomość może wymieniać nazwę wyświetlaną zamiast nicka; liczą się całe słowa', () => {
    const named = 'Jan Testowy potwierdza ten adres.';
    const byName = applyOwnershipProofs(doc(block(owner.p2wpkh, named, signBitcoinMessage(owner.privateKey, named, 'p2wpkh'))));
    assert.equal(byName.length, 2);
    const partial = 'Konto jan_tester_2 potwierdza ten adres.';
    const other = applyOwnershipProofs(doc(block(owner.p2wpkh, partial, signBitcoinMessage(owner.privateKey, partial, 'p2wpkh'))));
    assert.equal(other.length, 1);
  });

  test('2) podpis sfałszowany (cudzy podpis przy własnym adresie) → bez podniesienia, uwaga w treści', () => {
    const forged = doc(block(stranger.p2wpkh, message, signature));
    const result = applyOwnershipProofs(forged);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.category, 'own_profile');
    assert.ok(result[0]!.text.includes(PROOF_NOTE_PREFIX));
    assert.match(result[0]!.text, /UWAGA: podpis nie weryfikuje się dla tego adresu/);
    assert.match(result[0]!.text, /możliwa podróbka albo skopiowany cudzy podpis/);
    assert.equal(computeConfidence({ evidence: evidenceFor(result, stranger.p2wpkh), addressClass: 'private' }).score, 85);
  });

  test('3) podpis poprawny, ale wiadomość nie wymienia konta publikującego → bez podniesienia, uwaga', () => {
    // Cały blok skopiowany z cudzego profilu: podpis jest prawdziwy, lecz nie wiąże adresu z tym kontem.
    const copied = doc(block(owner.p2wpkh, message, signature), {
      author: 'zupelnie_inny',
      url: 'https://forum.example/u/zupelnie_inny',
      profile: { handle: 'zupelnie_inny' },
    });
    const result = applyOwnershipProofs(copied);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.category, 'own_profile');
    assert.match(result[0]!.text, /Podpis jest poprawny dla adresu .* ale podpisana wiadomość nie wymienia konta publikującego \(„zupelnie_inny"\)/);
    assert.match(result[0]!.text, /podpis można skopiować/);
    assert.equal(result.some((item) => item.category === 'cryptographic_proof'), false);
  });

  test('4) publikacja bez podpisu wraca nietknięta; dokument-dowód nie jest przetwarzany drugi raz', () => {
    const plain = doc(`Mój adres: ${owner.p2wpkh}`);
    assert.deepEqual(applyOwnershipProofs(plain), [plain]);
    assert.equal(applyOwnershipProofs(plain)[0], plain);
    const [original, proof] = applyOwnershipProofs(doc(block(owner.p2wpkh, message, signature)));
    assert.deepEqual(applyOwnershipProofs(proof!), [proof]);
    assert.deepEqual(applyOwnershipProofs(original!), [original]);
  });

  test('kategoria słabsza niż profil (komentarz) też dostaje osobny dowód tylko dla podpisanego adresu', () => {
    const comment = doc(block(owner.p2wpkh, message, signature), { category: 'mass_comment' });
    const [original, proof] = applyOwnershipProofs(comment);
    assert.equal(original!.category, 'mass_comment');
    assert.equal(proof!.category, 'cryptographic_proof');
  });
});

describe('createConnectors stosuje zasadę dowodową do wyników łączników', () => {
  test('profil Mastodon z podpisaną wiadomością w opisie → dodatkowy dokument-dowód', async () => {
    const message = 'jan_tester@mastodon.example to moje konto. Podpisano kluczem portfela.';
    const signature = signEthereumMessage(owner.privateKey, message);
    const note = `<p>Programista.</p><p>{"address":"${owner.ethereum}","msg":"${message}","sig":"${signature}"}</p>`;
    const connectors = createConnectors({
      enableLive: true,
      minRequestIntervalMs: 0,
      allowPrivateHosts: true,
      fediverseInstances: ['mastodon.example'],
      monitorSources: [],
      fetcher: async (url) =>
        url === 'https://mastodon.example/api/v1/accounts/lookup?acct=jan_tester'
          ? new Response(JSON.stringify({ username: 'jan_tester', note, url: 'https://mastodon.example/@jan_tester', fields: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('nie ma', { status: 404, headers: { 'content-type': 'text/plain' } }),
    });
    const fediverse = connectors.find((connector) => connector.id === 'live-fediverse')!;
    const documents = await fediverse.search({ type: 'nick', value: 'jan_tester' }, { log: () => undefined });
    assert.deepEqual(documents.map((document) => document.category), ['own_profile', 'cryptographic_proof']);
    assert.equal(documents[1]!.url, `https://mastodon.example/@jan_tester?podpis=${owner.ethereum}`);
    assert.equal(documents[1]!.service, 'mastodon.example');
  });
});
