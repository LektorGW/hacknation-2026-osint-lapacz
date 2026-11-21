// Łączniki piaskownicy sprawdzane na prawdziwym serwerze piaskownicy,
// uruchamianym lokalnie na losowym porcie. Żadnych połączeń z internetem.

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { computeConfidence, extractAddresses, validateAddress, verifySignedMessage } from '@olcys/core';
import type { AddressClass, Evidence, Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { buildApp } from '../../../apps/sandbox/src/app.ts';
import { ADDR } from '../../../apps/sandbox/data/scenario.ts';
import { FORGED_PROOF, PROOF_ADDR, SIGNED_PROOFS } from '../../../apps/sandbox/data/proofs.ts';
import { createConnectors } from '../src/index.ts';

const app = buildApp();
let sandboxUrl = '';
let connectors: SourceConnector[] = [];
const logLines: string[] = [];
const context = { log: (message: string) => void logLines.push(message) };

before(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  sandboxUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  connectors = createConnectors({ sandboxUrl });
});

after(async () => {
  await app.close();
});

/** Przeszukuje wszystkie łączniki wszystkimi identyfikatorami — jak jedna runda analizy. */
async function searchAll(...identifiers: Identifier[]): Promise<SourceDocument[]> {
  const documents: SourceDocument[] = [];
  for (const identifier of identifiers) {
    for (const connector of connectors) {
      if (connector.accepts.includes(identifier.type)) documents.push(...(await connector.search(identifier, context)));
    }
  }
  return documents;
}

const withAddress = (documents: SourceDocument[], address: string) =>
  documents.filter((document) => extractAddresses(document.text).some((found) => found.address === address));

const allAddresses = (documents: SourceDocument[]) =>
  new Set(documents.flatMap((document) => extractAddresses(document.text).map((found) => found.address)));

const toEvidence = (documents: SourceDocument[]): Evidence[] =>
  documents.map((document, i) => ({
    id: `e${i}`,
    category: document.category,
    service: document.service,
    url: document.url,
    capturedAt: document.fetchedAt,
    identityMatch: document.identityMatch,
  }));

async function explorer(address: string) {
  const response = await fetch(`${sandboxUrl}/explorer/api/address/${address}`);
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

describe('createConnectors', () => {
  test('piaskownica: siedem łączników o różnych id i serwisach (oraz lokalne rejestry publiczne)', () => {
    const sandbox = connectors.filter((connector) => connector.id.startsWith('sandbox-'));
    assert.equal(sandbox.length, 7);
    assert.equal(new Set(sandbox.map((connector) => connector.id)).size, 7);
    assert.equal(new Set(sandbox.map((connector) => connector.service)).size, 7);
    assert.ok(sandbox.every((connector) => connector.enabledByDefault));
    assert.deepEqual(connectors.filter((connector) => !connector.id.startsWith('sandbox-')).map((connector) => connector.id), ['rejestry-publiczne']);
  });

  test('bez konfiguracji powstaje tylko lokalny łącznik rejestrów; live i Tor tylko na życzenie', async () => {
    assert.deepEqual(createConnectors({}).map((c) => c.id), ['rejestry-publiczne']);
    const live = createConnectors({ enableLive: true });
    // Łączniki stałe mają przedrostek „live-", źródła z rejestru monitoringu — „mon-"; dalej łączniki katalogu search/.
    const searchIds = ['deep-search', 'rejestry-publiczne', 'web-search'];
    assert.ok(live.length >= 2 && live.every((c) => c.id.startsWith('live-') || c.id.startsWith('mon-') || searchIds.includes(c.id)));
    assert.ok(live.filter((c) => c.id.startsWith('mon-')).every((c) => !c.enabledByDefault));
    for (const id of ['live-github', 'live-wayback']) assert.ok(live.some((c) => c.id === id), id);

    const [tor] = createConnectors({ torProxyUrl: 'http://127.0.0.1:9' });
    assert.equal(tor!.id, 'tor-onion');
    assert.equal(tor!.enabledByDefault, false);
    // Domyślna lista źródeł .onion jest pusta, więc łącznik niczego nie pobiera.
    const lines: string[] = [];
    assert.deepEqual(await tor!.search({ type: 'nick', value: 'ktokolwiek' }, { log: (m) => void lines.push(m) }), []);
    assert.match(lines.join('\n'), /lista źródeł jest pusta/);
  });
});

describe('scenariusze piaskownicy', () => {
  test('a) ten sam adres na własnym profilu i w ogłoszeniu — dwa niezależne źródła', async () => {
    const documents = await searchAll({ type: 'login', value: 'kwrzosek_dev' });
    const hits = withAddress(documents, ADDR.kacperBtc);
    assert.deepEqual(hits.map((d) => [d.service, d.category, d.identityMatch]).sort(), [
      ['gitpub.sandbox', 'own_profile', 'exact_identifier'],
      ['targ.sandbox', 'sale_offer', 'exact_identifier'],
    ]);
    assert.equal(computeConfidence({ evidence: toEvidence(hits), addressClass: 'private' }).score, 100);

    const profile = hits.find((d) => d.service === 'gitpub.sandbox')!;
    assert.equal(profile.author, 'kwrzosek_dev');
    assert.equal(profile.publishedAt, '2024-01-20T10:00:00Z');
    assert.deepEqual(profile.discoveredIdentifiers, [{ type: 'email', value: 'kacper.wrzosek@poczta.example' }]);
    assert.ok(allAddresses(documents).has(ADDR.kacperEth));
    assert.ok(!allAddresses(documents).has(ADDR.namesakeBtc));
  });

  test('a) eksplorator: wypłaty na giełdę w trzech latach podatkowych, zamiana na stablecoiny, P2P', async () => {
    const btc = (await explorer(ADDR.kacperBtc)).body;
    assert.equal(btc.network, 'bitcoin');
    const deposits = btc.transfers.filter((t: any) => t.direction === 'out' && t.counterparty === ADDR.exchangeBtc);
    assert.deepEqual([...new Set(deposits.map((t: any) => t.time.slice(0, 4)))], ['2024', '2025', '2026']);
    assert.equal(deposits[0].counterpartyLabel, 'Giełda Bursztyn: Hot Wallet');
    assert.equal(deposits[0].counterpartyClass, 'exchange');
    assert.ok(btc.transfers.some((t: any) => t.counterpartyLabel === 'KantorKrypto P2P' && t.counterpartyKind === 'p2p_service'));
    assert.equal((await explorer(ADDR.p2pBtc)).body.kind, 'p2p_service');
    assert.equal((await explorer(ADDR.swapEth)).body.kind, 'stablecoin_swap');

    const eth = (await explorer(ADDR.kacperEth.toLowerCase())).body;
    assert.equal(eth.address, ADDR.kacperEth);
    assert.ok(eth.transfers.some((t: any) => t.direction === 'in' && t.asset === 'USDT' && t.counterparty === ADDR.swapEth));
    for (const label of ['PlatnosciPay Gateway', 'KartaCoin: doładowanie karty']) {
      assert.ok(eth.transfers.some((t: any) => t.counterpartyLabel === label), label);
    }
  });

  test('b) adres giełdy i smart kontraktu z forum — wykluczone', async () => {
    const documents = await searchAll({ type: 'nick', value: 'bkruk_trader' });
    for (const address of [ADDR.exchangeBtc, ADDR.stableEth]) {
      const hits = withAddress(documents, address);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]!.category, 'forum_post');
      const { body } = await explorer(address);
      const result = computeConfidence({ evidence: toEvidence(hits), addressClass: body.addressClass as AddressClass });
      assert.equal(result.excluded, true);
      assert.equal(result.score, 0);
    }
    assert.equal((await explorer(ADDR.stableEth)).body.isContract, true);
  });

  test('c) zbieżność nazwisk — trafienia po samym nazwisku są oznaczone name_only', async () => {
    const documents = await searchAll({ type: 'full_name', value: 'Kacper Wrzosek' });
    assert.ok(documents.length >= 3);
    assert.ok(documents.every((d) => d.identityMatch === 'name_only'));
    assert.ok(documents.every((d) => d.discoveredIdentifiers === undefined));
    assert.deepEqual([...new Set(documents.map((d) => d.author))].sort(), ['kwrzosek_dev', 'wrzosek_ryby']);

    const namesake = withAddress(documents, ADDR.namesakeBtc);
    assert.ok(namesake.every((d) => d.service === 'spolecznosc.sandbox'));
    assert.equal(computeConfidence({ evidence: toEvidence(namesake), addressClass: 'private' }).score, 65);
  });

  test('d) adres z giveawayu — masowy komentarz i wielu niepowiązanych publikujących', async () => {
    const documents = await searchAll({ type: 'nick', value: 'oli_stepniak' });
    const hits = withAddress(documents, ADDR.giveawayTron);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.category, 'mass_comment');
    assert.equal(hits[0]!.identityMatch, 'exact_identifier');
    // Dokument to pojedynczy komentarz — bez komentarzy innych osób.
    assert.ok(!hits[0]!.text.includes('krypto_janusz77'));

    const publishers = await searchAll({ type: 'crypto_address', value: ADDR.giveawayTron });
    const others = new Set(publishers.map((d) => d.author).filter((author) => author !== 'oli_stepniak'));
    assert.equal(others.size, 7);
    assert.ok(publishers.every((d) => d.identityMatch === 'name_only'));
    const result = computeConfidence({ evidence: toEvidence(hits), addressClass: 'unknown', unrelatedPublishers: others.size });
    assert.equal(result.score, 0);
  });

  test('e) podmiana adresu — nowy na żywo, stary tylko w archiwum', async () => {
    const documents = await searchAll({ type: 'nick', value: 'dsroka' });
    const live = documents.filter((d) => d.connectorId === 'sandbox-www');
    const archived = documents.filter((d) => d.connectorId === 'sandbox-archiwum');
    assert.equal(live.length, 1);
    assert.deepEqual([...allAddresses(live)], [ADDR.dominikNewBtc]);

    assert.deepEqual(archived.map((d) => d.archivedAt), ['2024-05-12T03:14:00Z', '2025-03-02T01:40:00Z', '2025-09-20T02:05:00Z']);
    // Kopia archiwalna dziedziczy serwis i kategorię oryginału — nie jest niezależnym źródłem.
    assert.ok(archived.every((d) => d.service === 'www.sandbox' && d.category === 'own_profile' && d.publishedAt === undefined));
    // Adres kopii wzorem Wayback Machine: z końcówki da się odzyskać adres oryginału.
    assert.equal(archived[0]!.url, `${sandboxUrl}/archiwum/web/20240512031400/${live[0]!.url}`);
    assert.ok(archived.every((d) => d.author === 'dsroka'));
    assert.deepEqual([...allAddresses(archived.slice(0, 2))], [ADDR.dominikOldBtc]);
    assert.deepEqual([...allAddresses(archived.slice(2))], [ADDR.dominikNewBtc]);
    assert.equal(computeConfidence({ evidence: toEvidence(withAddress(documents, ADDR.dominikNewBtc)), addressClass: 'private' }).score, 85);
  });

  test('e) faza „before" pokazuje stan sprzed podmiany', async () => {
    const earlier = buildApp({ phase: 'before' });
    await earlier.listen({ port: 0, host: '127.0.0.1' });
    try {
      const url = `http://127.0.0.1:${(earlier.server.address() as AddressInfo).port}`;
      const documents: SourceDocument[] = [];
      for (const connector of createConnectors({ sandboxUrl: url })) {
        documents.push(...(await connector.search({ type: 'nick', value: 'dsroka' }, context)));
      }
      assert.equal(documents.length, 3);
      assert.deepEqual([...allAddresses(documents)], [ADDR.dominikOldBtc]);
    } finally {
      await earlier.close();
    }
  });

  test('f) łańcuch tożsamości: e-mail → profil z nickiem → profil z adresem → konto powiązane', async () => {
    const first = await searchAll({ type: 'email', value: 'm.zielonka@skrzynka.example' });
    assert.equal(first.length, 1);
    assert.equal(first[0]!.service, 'spolecznosc.sandbox');
    assert.equal(first[0]!.identityMatch, 'exact_identifier');
    assert.equal(allAddresses(first).size, 0);
    assert.deepEqual(first[0]!.discoveredIdentifiers, [
      { type: 'nick', value: 'marta.zielonka' },
      { type: 'nick', value: 'zielonka_codes' },
    ]);

    const second = await searchAll({ type: 'nick', value: 'zielonka_codes' });
    assert.deepEqual(second.map((d) => [d.author, d.identityMatch]), [
      ['zielonka_codes', 'exact_identifier'],
      ['zielonka-labs', 'linked_profile'],
    ]);
    assert.deepEqual([...allAddresses(second.slice(0, 1))], [ADDR.martaEth]);
    assert.deepEqual([...allAddresses(second.slice(1))], [ADDR.martaLabsTron]);
    assert.equal(computeConfidence({ evidence: toEvidence(second.slice(1)), addressClass: 'private' }).score, 80);
  });

  test('g) adres tylko w komunikatorze i w stopce wiadomości', async () => {
    const documents = await searchAll({ type: 'messenger_id', value: '@hubi_serwis' });
    const hits = withAddress(documents, ADDR.hubertTron);
    assert.deepEqual([...new Set(hits.map((d) => d.service))].sort(), ['forum.sandbox', 'komunikator.sandbox']);
    assert.ok(hits.every((d) => d.category === 'settlement_message' && d.identityMatch === 'exact_identifier'));
    assert.equal(hits.filter((d) => d.service === 'komunikator.sandbox').length, 2);
    assert.equal(computeConfidence({ evidence: toEvidence(hits), addressClass: 'private' }).score, 80);
    assert.deepEqual([...allAddresses(documents)], [ADDR.hubertTron]);
  });

  test('h) osoba bez adresów — są dokumenty, nie ma adresów', async () => {
    const documents = await searchAll(
      { type: 'full_name', value: 'Zofia Mielcarz' },
      { type: 'nick', value: 'zosia_mielcarz' },
      { type: 'email', value: 'zofia.mielcarz@listy.example' },
    );
    assert.ok(documents.length >= 4);
    assert.equal(allAddresses(documents).size, 0);
  });

  test('nieznany identyfikator — pusty wynik bez błędu', async () => {
    assert.deepEqual(await searchAll({ type: 'nick', value: 'nie_ma_takiego_konta' }), []);
  });

  test('niedostępna piaskownica — pusty wynik i wpis w dzienniku', async () => {
    const lines: string[] = [];
    const [offline] = createConnectors({ sandboxUrl: 'http://127.0.0.1:9' });
    assert.deepEqual(await offline!.search({ type: 'nick', value: 'dsroka' }, { log: (m) => void lines.push(m) }), []);
    assert.match(lines.join('\n'), /błąd podczas wyszukiwania/);
  });
});

describe('scenariusze „dowody i ich podróbki" (data/proofs.ts)', () => {
  /** Ślady z fragmentem treści wokół adresu — po nim ocena rozpoznaje kopie tej samej publikacji. */
  const toEvidenceWithExcerpt = (documents: SourceDocument[], address: string): Evidence[] =>
    toEvidence(documents).map((item, i) => ({
      ...item,
      excerpt: extractAddresses(documents[i]!.text).find((found) => found.address === address)!.context,
    }));

  test('dane scenariusza: podpisy Norberta Szpaka są poprawne, „dowód" fałszerza — nie', () => {
    assert.deepEqual(verifySignedMessage(SIGNED_PROOFS.szpakBtc.address, SIGNED_PROOFS.szpakBtc.message, SIGNED_PROOFS.szpakBtc.signature), {
      valid: true,
      scheme: 'bitcoin-message/p2wpkh',
    });
    assert.equal(verifySignedMessage(SIGNED_PROOFS.szpakEth.address, SIGNED_PROOFS.szpakEth.message, SIGNED_PROOFS.szpakEth.signature).valid, true);
    assert.equal(verifySignedMessage(FORGED_PROOF.address, FORGED_PROOF.message, FORGED_PROOF.signature).valid, false);
  });

  test('i) podpisana wiadomość na własnym profilu → dowód kryptograficzny, 95', async () => {
    const documents = await searchAll({ type: 'login', value: 'szpak_nody' });
    assert.deepEqual(
      documents.map((d) => [d.category, d.url.replace(sandboxUrl, '')]),
      [
        ['own_profile', '/gitpub/szpak_nody'],
        ['cryptographic_proof', `/gitpub/szpak_nody?podpis=${PROOF_ADDR.szpakBtc}`],
        ['cryptographic_proof', `/gitpub/szpak_nody?podpis=${PROOF_ADDR.szpakEth}`],
      ],
    );
    assert.ok(documents.every((d) => d.service === 'gitpub.sandbox' && d.author === 'szpak_nody' && d.identityMatch === 'exact_identifier'));
    assert.equal((documents[0]!.text.match(/Podpis poprawny: wiadomość wymieniająca konto „szpak_nody"/g) ?? []).length, 2);
    for (const address of [PROOF_ADDR.szpakBtc, PROOF_ADDR.szpakEth]) {
      const hits = withAddress(documents, address);
      assert.deepEqual(hits.map((d) => d.category), ['own_profile', 'cryptographic_proof']);
      const result = computeConfidence({ evidence: toEvidence(hits), addressClass: 'private' });
      assert.equal(result.score, 95);
      assert.equal(result.ledger[0]!.rule, 'base.cryptographic_proof');
      assert.equal(result.independentSources, 1);
    }
    // Dokument-dowód zawiera wyłącznie podpisany adres.
    assert.deepEqual(extractAddresses(documents[1]!.text).map((found) => found.address), [PROOF_ADDR.szpakBtc]);
  });

  test('ii) sfałszowany dowód (cudzy podpis przy własnym adresie) → bez podniesienia, uwaga w treści', async () => {
    const documents = await searchAll({ type: 'nick', value: 'krypto_baron' });
    assert.deepEqual(documents.map((d) => [d.service, d.category]), [['spolecznosc.sandbox', 'own_profile']]);
    assert.match(documents[0]!.text, /UWAGA: podpis nie weryfikuje się dla tego adresu/);
    assert.ok(documents[0]!.text.includes(PROOF_ADDR.baronBtc));
    const result = computeConfidence({ evidence: toEvidence(withAddress(documents, PROOF_ADDR.baronBtc)), addressClass: 'private' });
    assert.equal(result.score, 85);
    assert.equal(result.ledger[0]!.rule, 'base.own_profile');
    // Adres prawdziwego właściciela podpisu nie pojawia się u fałszerza.
    assert.ok(!allAddresses(documents).has(PROOF_ADDR.szpakBtc));
  });

  test('iii) ta sama oferta w trzech serwisach → jedno pochodzenie, bez premii za synergię', async () => {
    const documents = await searchAll({ type: 'nick', value: 'fjaskula_usdt' });
    const hits = withAddress(documents, PROOF_ADDR.jaskulaTron);
    assert.deepEqual(hits.map((d) => [d.service, d.category]).sort(), [
      ['forum.sandbox', 'forum_post'],
      ['komunikator.sandbox', 'settlement_message'],
      ['targ.sandbox', 'sale_offer'],
    ]);
    const result = computeConfidence({ evidence: toEvidenceWithExcerpt(hits, PROOF_ADDR.jaskulaTron), addressClass: 'private' });
    assert.equal(result.provenance!.length, 1);
    assert.equal(result.independentSources, 1);
    assert.deepEqual(result.ledger.map((entry) => entry.rule), ['base.sale_offer', 'independence.copies_merged']);
    assert.equal(result.score, 70);
    // Bez rozpoznania kopii te same trzy serwisy dałyby 70 + 15 + 5 = 90.
    assert.equal(computeConfidence({ evidence: toEvidence(hits), addressClass: 'private' }).score, 90);
  });

  test('iv) ten sam nick u dwóch różnych osób w dwóch serwisach — różne dane, różne adresy', async () => {
    const documents = await searchAll({ type: 'nick', value: 'wilczek_x9' });
    const targ = documents.find((d) => d.service === 'targ.sandbox')!;
    const forum = documents.find((d) => d.service === 'forum.sandbox')!;
    assert.equal(documents.length, 2);
    assert.deepEqual([targ.profile!.displayName, targ.profile!.location, targ.profile!.emails], ['Adam Wilczek', 'Gdynia', ['adam@wilczek-rowery.example']]);
    assert.deepEqual([forum.profile!.displayName, forum.profile!.location, forum.profile!.emails], ['Beata Wilczyńska', 'Przemyśl', ['beata.w@przemysl-net.example']]);
    assert.deepEqual([...allAddresses([targ])], [PROOF_ADDR.wilczekBtc]);
    assert.deepEqual([...allAddresses([forum])], [PROOF_ADDR.wilczynskaTron]);
    // Łącznik niczego nie przesądza (oba trafienia to dokładny nick); rozdziela je analiza po atrybutach profilu.
    assert.ok(documents.every((d) => d.identityMatch === 'exact_identifier'));
    // W eksploratorze adresy obu osób nie mają wspólnych kontrahentów poza anonimowymi wpłacającymi.
    const btc = (await explorer(PROOF_ADDR.wilczekBtc)).body;
    assert.ok(btc.transfers.every((t: any) => t.counterparty !== PROOF_ADDR.wilczynskaTron));
  });

  test('adresy części „dowody" mają poprawne sumy kontrolne i są znane eksploratorowi', async () => {
    for (const address of Object.values(PROOF_ADDR)) {
      assert.ok(validateAddress(address)?.checksumVerified, address);
      assert.equal((await explorer(address)).status, 200, address);
    }
  });
});

describe('fikcyjny eksplorator', () => {
  test('każdy adres scenariusza ma poprawną sumę kontrolną i jest znany eksploratorowi', async () => {
    for (const address of Object.values(ADDR)) {
      const valid = validateAddress(address);
      assert.ok(valid?.checksumVerified, address);
      const { status, body } = await explorer(address);
      assert.equal(status, 200, address);
      assert.equal(body.network, valid.network);
      assert.ok(Array.isArray(body.transfers));
    }
  });

  test('nieznany adres → 404', async () => {
    assert.equal((await explorer('bc1q85m02hqt8wygl7m85yjwmv5rnsx7kmq7ws4476')).status, 404);
  });
});
