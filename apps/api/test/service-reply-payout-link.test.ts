// Regresja: wypłata na rachunek powiązana w odpowiedzi usługi z konkretną wpłatą (`relatedTxid`) dokumentuje
// wyjście do walut tradycyjnych TYLKO dla adresu tej wpłaty — nie dla wszystkich dopasowanych adresów sprawy.
// Wypłata bez wskazanej wpłaty nadal dotyczy wszystkich dopasowanych adresów, ale ocena mówi to wprost.
// Osoba fikcyjna: Jacek Kowalski.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnalysis } from '../src/analysis.ts';
import { cleanReplyPayload } from '../src/service-reply.ts';
import type { ServiceReply, ServiceReplyInput } from '../src/service-reply.ts';
import { BTC_A, BTC_B, cashOut, chainWith, dossierOf, fakeConnector, transfer } from './helpers.ts';

const EXCHANGE = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const query = { identifiers: [{ type: 'nick' as const, value: 'jacek_k_btc' }] };

const depositA = transfer(11, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-04-01T00:00:00.000Z', amount: 0.5 });
const depositB = transfer(12, { counterparty: EXCHANGE, counterpartyClass: 'exchange', counterpartyLabel: 'Kraken 4', time: '2025-05-01T00:00:00.000Z', amount: 0.2 });

const analyse = () =>
  runAnalysis({
    query,
    connectors: [
      fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
        identifier.value === 'jacek_k_btc'
          ? [
              {
                url: 'https://gitpub.example/jacek_k_btc',
                author: 'jacek_k_btc',
                text: `Jacek Kowalski — programista. Wsparcie: BTC ${BTC_A} albo BTC ${BTC_B}.`,
                profile: { handle: 'jacek_k_btc', displayName: 'Jacek Kowalski' },
              },
            ]
          : [],
      ),
    ],
    chainProviders: [
      chainWith({
        [BTC_A]: { transfers: [depositA], cashOuts: [cashOut(depositA, 100_000)] },
        [BTC_B]: { transfers: [depositB], cashOuts: [cashOut(depositB, 40_000)] },
      }),
    ],
    now: () => new Date('2026-11-21T10:00:00.000Z'),
  });

function reply(id: string, serviceId: string, input: ServiceReplyInput): ServiceReply {
  const cleaned = cleanReplyPayload(input);
  if ('error' in cleaned) throw new Error(cleaned.error);
  return {
    id,
    caseId: 'sprawa-1',
    serviceName: 'Kraken',
    serviceId,
    reference: 'KRK/2026/0077',
    receivedAt: '2026-11-20T12:00:00.000Z',
    recordedAt: '2026-11-21T10:00:00.000Z',
    recordedBy: 'analityk',
    payload: cleaned.payload,
  };
}

const exitStage = (dossier: ReturnType<typeof dossierOf>, address: string) =>
  dossier.indicators.cashOut.find((item) => item.address === address && /Kraken/.test(item.serviceName ?? ''))!;

test('wypłata powiązana z wpłatą jednego adresu dokumentuje wyjście tylko dla tego adresu', async () => {
  const result = await analyse();
  const automatic = dossierOf(result, query);
  const kraken = automatic.serviceLinks.find((link) => /Kraken/.test(link.name))!;
  assert.ok(exitStage(automatic, BTC_A) && exitStage(automatic, BTC_B), 'oba adresy mają ocenę wskaźnika C dla usługi');

  const record = reply('odp-a', kraken.id, {
    matches: [{ network: 'bitcoin', txids: [depositA.txid, depositB.txid] }],
    fiatPayouts: [{ time: '2025-04-02T10:00:00.000Z', amount: 50_000, currency: 'PLN', relatedTxid: depositA.txid }],
  });
  const dossier = dossierOf(result, query, { serviceReplies: [record] });
  const view = dossier.serviceReplies[0]!;

  assert.deepEqual(view.match.addresses.map((item) => item.address).sort(), [BTC_A, BTC_B].sort());
  assert.equal(view.fiatExit.documented, true);
  assert.deepEqual(view.fiatExit.addresses, [`bitcoin:${BTC_A}`]);
  assert.match(view.fiatExit.text, /dla nich wskaźnik C bez zmian/);

  assert.equal(exitStage(dossier, BTC_A).stage, 'documented_fiat_exit');
  assert.notEqual(exitStage(dossier, BTC_B).stage, 'documented_fiat_exit');
  assert.equal(exitStage(dossier, BTC_B).stage, exitStage(automatic, BTC_B).stage);
  assert.ok(!/nie jest powiązana z konkretną wpłatą/.test(exitStage(dossier, BTC_A).statement));

  // Wypłata powiązana z transakcją spoza dopasowanych adresów nie dokumentuje niczego.
  const elsewhere = dossierOf(result, query, {
    serviceReplies: [reply('odp-b', kraken.id, { matches: [{ txids: [depositA.txid, depositB.txid] }], fiatPayouts: [{ time: '2025-04-02T10:00:00.000Z', amount: 1_000, currency: 'PLN', relatedTxid: 'f'.repeat(64) }] })],
  });
  assert.equal(elsewhere.serviceReplies[0]!.fiatExit.documented, false);
  assert.match(elsewhere.serviceReplies[0]!.fiatExit.text, /żadna nie jest powiązana z transakcją dopasowanych adresów/);
  assert.ok(elsewhere.indicators.cashOut.every((item) => item.stage !== 'documented_fiat_exit'));
});

test('wypłata bez wskazanej wpłaty: wyjście udokumentowane dla wszystkich dopasowanych adresów, z zastrzeżeniem', async () => {
  const result = await analyse();
  const kraken = dossierOf(result, query).serviceLinks.find((link) => /Kraken/.test(link.name))!;
  const dossier = dossierOf(result, query, {
    serviceReplies: [reply('odp-c', kraken.id, { matches: [{ txids: [depositA.txid, depositB.txid] }], fiatPayouts: [{ time: '2025-06-02T10:00:00.000Z', amount: 30_000, currency: 'PLN' }] })],
  });
  const view = dossier.serviceReplies[0]!;
  assert.deepEqual(view.fiatExit.addresses.sort(), [`bitcoin:${BTC_A}`, `bitcoin:${BTC_B}`].sort());
  assert.match(view.fiatExit.text, /Wypłata nie jest powiązana w odpowiedzi z konkretną wpłatą/);
  for (const address of [BTC_A, BTC_B]) {
    const exit = exitStage(dossier, address);
    assert.equal(exit.stage, 'documented_fiat_exit');
    assert.match(exit.statement, /nie jest powiązana z konkretną wpłatą/);
  }
});
