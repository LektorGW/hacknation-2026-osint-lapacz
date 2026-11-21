import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runAnalysis } from '../src/analysis.ts';
import { detectServiceMentions, normalizeServiceLabel } from '../src/services.ts';
import { BTC_A, BTC_D, cashOut, chainWith, dossierOf, fakeConnector, transfer } from './helpers.ts';

const nick = { type: 'nick' as const, value: 'krypto_janek' };
const WALLET_1 = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const WALLET_2 = '12c6DSiU4Rq3P4ZxziKxzrL5LmMBrzjrJX';
const WALLET_3 = '1HLoD9E4SDFFPDiYfNYnkBLQ85Y51J3Zb1';

const exchange = { counterpartyClass: 'exchange' as const };
// Trzy różne etykiety portfeli tej samej giełdy.
const toBinance = [
  transfer(1, { counterparty: WALLET_1, counterpartyLabel: 'Binance 14', time: '2024-05-10T08:00:00.000Z', amount: 0.3, ...exchange }),
  transfer(2, { counterparty: WALLET_2, counterpartyLabel: 'Binance: Hot Wallet', time: '2025-03-14T10:22:00.000Z', amount: 0.4, ...exchange }),
  transfer(3, { counterparty: WALLET_2, counterpartyLabel: 'Binance-Hot 2', time: '2025-06-01T12:00:00.000Z', amount: 0.2, ...exchange }),
];
const fromKraken = transfer(4, { counterparty: WALLET_3, counterpartyLabel: 'Kraken 4', direction: 'in', time: '2024-01-02T09:00:00.000Z', amount: 1, ...exchange });
// Adres pośredni bez publicznej etykiety — tak oznacza go moduł danych blockchain.
const viaDeposit = transfer(5, {
  counterparty: BTC_D,
  counterpartyLabel: 'Prawdopodobny adres wpłat giełdy „Bybit: Hot Wallet” (wnioskowanie)',
  time: '2025-08-20T15:00:00.000Z',
  amount: 0.1,
});

const chain = chainWith({
  [BTC_A]: {
    transfers: [...toBinance, fromKraken, viaDeposit],
    cashOuts: [
      cashOut(toBinance[0]!, 60_000),
      cashOut(toBinance[1]!, 132_000),
      cashOut(toBinance[2]!, 70_000),
      cashOut(viaDeposit, 40_000, {
        explanation:
          `WNIOSKOWANIE (nie ustalony fakt): przelew 0,1 BTC na adres ${BTC_D}, który nie ma publicznej etykiety. ` +
          `Ten adres pośredni przekazał środki (100% kwoty przelewu) do portfela giełdy „Bybit: Hot Wallet” (${WALLET_3}) po 2 h.`,
      }),
    ],
  },
});

const dossierFor = async (profileText: string) => {
  const profile = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: profileText },
  ]);
  const query = { identifiers: [nick] };
  return dossierOf(await runAnalysis({ query, connectors: [profile], chainProviders: [chain] }), query);
};

test('wiele etykiet portfeli jednej giełdy tworzy jedno powiązanie z usługą', async () => {
  const dossier = await dossierFor(`Wsparcie: ${BTC_A}`);
  const binance = dossier.serviceLinks.filter((link) => link.name === 'Binance');

  assert.equal(binance.length, 1);
  const [link] = binance;
  assert.equal(link!.kind, 'exchange');
  assert.deepEqual(link!.basis, ['transfer_out']);
  assert.equal(link!.transfersOut, 3);
  assert.equal(link!.outPln, 262_000);
  assert.equal(link!.inferredOnly, false);
  assert.deepEqual([link!.firstSeen, link!.lastSeen], ['2024-05-10T08:00:00.000Z', '2025-06-01T12:00:00.000Z']);
  // Lista przelewów jest chronologiczna i wskazuje obie strony.
  assert.deepEqual(link!.transfers.map((item) => item.serviceAddress), [WALLET_1, WALLET_2, WALLET_2]);
  assert.ok(link!.transfers.every((item) => item.subjectAddress === BTC_A && item.direction === 'out'));
  // Usługi wypłat są na początku, od najmocniejszego powiązania.
  assert.equal(dossier.serviceLinks[0]!.name, 'Binance');

  assert.equal(normalizeServiceLabel('Binance-Hot 2'), 'Binance');
  assert.equal(normalizeServiceLabel('Giełda Testowa: Hot Wallet'), 'Giełda Testowa');
  assert.equal(normalizeServiceLabel('Kantor Kowalski 12'), 'Kantor Kowalski');
});

test('przelew przychodzący z giełdy jest powiązaniem „źródło środków”', async () => {
  const kraken = (await dossierFor(`Wsparcie: ${BTC_A}`)).serviceLinks.find((link) => link.name === 'Kraken')!;

  assert.deepEqual(kraken.basis, ['transfer_in']);
  assert.equal(kraken.transfersIn, 1);
  assert.equal(kraken.transfersOut, 0);
  assert.equal(kraken.inPln, undefined);
  assert.equal(kraken.strength, 60);
  assert.ok(kraken.requestHints.some((hint) => hint.includes('Wypłaty z adresu usługi Kraken') && hint.includes(fromKraken.txid)));
});

test('adres wpłat z wnioskowania: powiązanie oznaczone jako wyłącznie wnioskowanie', async () => {
  const bybit = (await dossierFor(`Wsparcie: ${BTC_A}`)).serviceLinks.find((link) => link.name === 'Bybit')!;

  assert.deepEqual(bybit.basis, ['deposit_address']);
  assert.equal(bybit.inferredOnly, true);
  assert.equal(bybit.strength, 50);
  assert.equal(bybit.transfers[0]!.viaAddress, BTC_D);
  assert.equal(bybit.transfers[0]!.serviceAddress, WALLET_3);
  assert.ok(bybit.reasons.some((reason) => reason.includes('wyłącznie na wnioskowaniu')));
  // „Na tacy”: adres wpłat i identyfikator transakcji, po których giełda znajdzie konto.
  const hint = bybit.requestHints.find((item) => item.startsWith('Adres wpłat'))!;
  assert.ok(hint.includes(BTC_D));
  assert.ok(hint.includes(viaDeposit.txid));
  assert.ok(hint.includes('2025-08-20'));
  assert.ok(bybit.requestHints.some((item) => item.includes('krypto_janek')));
});

test('wzmianka i odnośnik polecający w treści profilu; portfel jako sposób przechowywania', async () => {
  const text = `Wsparcie: ${BTC_A}. Handluję na Bybit, rejestracja: https://www.bybit.com/invite?ref=AB12CD . Oszczędności trzymam na Ledger Nano.`;
  const dossier = await dossierFor(text);
  const bybit = dossier.serviceLinks.find((link) => link.name === 'Bybit')!;
  const ledger = dossier.serviceLinks.find((link) => link.name === 'Ledger')!;

  assert.deepEqual(bybit.basis, ['deposit_address', 'account_link', 'web_mention']);
  assert.equal(bybit.inferredOnly, false);
  assert.ok(bybit.mentions.some((mention) => mention.excerpt.includes('ref=AB12CD') && mention.url === 'https://gitpub.example/krypto_janek'));
  assert.ok(bybit.mentions.every((mention) => mention.evidenceId?.startsWith('ev-')));
  assert.ok(bybit.requestHints.some((hint) => hint.includes('odnośnik polecający') && hint.includes('ref=AB12CD')));

  assert.equal(ledger.kind, 'wallet');
  assert.deepEqual(ledger.basis, ['web_mention']);
  assert.equal(ledger.transfers.length, 0);
  assert.equal(ledger.outPln, undefined);
  assert.equal(ledger.strength, 20);

  // Nazwa w adresie URL nie liczy się drugi raz jako wzmianka; słowo „gate” w „gateway” nie jest giełdą.
  assert.deepEqual(
    detectServiceMentions('Profil: https://p2p.binance.com/pl/advertiserDetail?advertiserNo=s123 i payment gateway').map((item) => [item.service, item.basis]),
    [['Binance', 'account_link']],
  );
});

test('siła powiązania rośnie, gdy są dwie niezależne podstawy (blockchain i publiczna treść)', async () => {
  const chainOnly = (await dossierFor(`Wsparcie: ${BTC_A}`)).serviceLinks.find((link) => link.name === 'Bybit')!;
  const both = (await dossierFor(`Wsparcie: ${BTC_A}. Konto mam na Bybit.`)).serviceLinks.find((link) => link.name === 'Bybit')!;

  assert.equal(both.strength, chainOnly.strength + 15);
  assert.ok(both.reasons.some((reason) => reason.includes('Dwie niezależne podstawy')));
});

test('teczka: usługi w kluczowych ustaleniach, priorytecie i grafie', async () => {
  const dossier = await dossierFor(`Wsparcie: ${BTC_A}`);

  assert.match(dossier.keyFindings[1]!.text, /^Podmiot jest powiązany z usługą Binance \(giełda\): 3 przelewy do usługi o szacunkowej wartości 262 tys\. zł w latach 2024–2025/);
  assert.ok(dossier.totals.priorityReasons.some((reason) => reason.startsWith('Powiązania z usługami wypłat: 3')));

  // Jeden węzeł na usługę, bez względu na liczbę jej adresów.
  const services = dossier.graph.nodes.filter((node) => node.kind === 'service');
  assert.deepEqual(services.map((node) => node.label).sort(), ['Binance', 'Bybit', 'Kraken']);
  const edge = dossier.graph.edges.find((item) => item.to === 'svc:binance')!;
  assert.equal(edge.kind, 'cash_out');
  assert.equal(edge.from, `addr:bitcoin:${BTC_A}`);
  assert.match(edge.label!, /3 przel\., ok\. 262 tys\. zł/);
  assert.equal(edge.weight, 100);
  assert.ok(dossier.graph.edges.some((item) => item.from === 'svc:kraken' && item.kind === 'transfer'));
});

test('kontrakty i adresy techniczne nie są usługami', async () => {
  const contract = { counterpartyClass: 'smart_contract' as const };
  const ZERO = '0x0000000000000000000000000000000000000000';
  const HOOK = '0x4816c12A0000000000000000000000000000Fe2A';
  const UNKNOWN = '0xAF6681cD000000000000000000000000BAbA765B';
  const TOKEN = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
  const transfers = [
    transfer(11, { counterparty: ZERO, counterpartyLabel: 'Adres zerowy (emisja i spalanie tokenów)', direction: 'in', time: '2024-01-01T00:00:00.000Z', amount: 5, asset: 'UNI', ...contract }),
    transfer(12, { counterparty: HOOK, counterpartyLabel: 'CMDHook', direction: 'in', time: '2024-02-01T00:00:00.000Z', amount: 1, asset: 'ETH', ...contract }),
    transfer(13, { counterparty: UNKNOWN, direction: 'out', time: '2024-03-01T00:00:00.000Z', amount: 2, asset: 'ETH', ...contract }),
    // Kontrakt tokena jest nośnikiem przelewu, nie kontrahentem.
    transfer(14, { counterparty: TOKEN, counterpartyLabel: 'Tether USD', direction: 'out', time: '2024-04-01T00:00:00.000Z', amount: 100, asset: 'USDT', ...contract }),
    // Znany protokół wymiany z listy usług pozostaje usługą.
    transfer(15, { counterparty: ROUTER, counterpartyLabel: 'Uniswap V2: Router 2', direction: 'out', time: '2024-05-01T00:00:00.000Z', amount: 3, asset: 'ETH', ...contract }),
    transfer(16, { counterparty: WALLET_1, counterpartyLabel: 'Binance 14', time: '2024-06-01T00:00:00.000Z', amount: 0.3, counterpartyClass: 'exchange' }),
  ];
  const profile = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}` }]);
  const query = { identifiers: [nick] };
  const dossier = dossierOf(await runAnalysis({ query, connectors: [profile], chainProviders: [chainWith({ [BTC_A]: { transfers } })] }), query);

  assert.deepEqual(dossier.serviceLinks.map((link) => link.name), ['Binance', 'Uniswap', 'Kontrakty i protokoły (2)']);
  const contracts = dossier.serviceLinks.at(-1)!;
  assert.deepEqual([contracts.id, contracts.kind, contracts.strength], ['kontrakty-i-protokoly', 'defi', 10]);
  // Dwa nierozpoznane kontrakty; adres zerowy i kontrakt tokena pominięte całkiem.
  assert.deepEqual(contracts.transfers.map((item) => item.serviceAddress), [HOOK, UNKNOWN]);
  assert.deepEqual([contracts.transfersIn, contracts.transfersOut], [1, 1]);
  assert.deepEqual(contracts.requestHints, []);
  assert.ok(contracts.reasons.some((reason) => reason.includes('nie jest adresatem zapytania')));
  // Wpis zbiorczy nie jest węzłem grafu ani nie wpływa na priorytet.
  assert.deepEqual(dossier.graph.nodes.filter((node) => node.kind === 'service').map((node) => node.label).sort(), ['Binance', 'Uniswap']);
  assert.ok(dossier.totals.priorityReasons.some((reason) => reason.startsWith('Powiązania z usługami wypłat: 1,')));
});
