// Źródła prawdziwych danych: kursy rynkowe, etykiety z serwisów publicznych,
// lista sankcyjna i wnioskowanie o adresach wpłat. Wszystko na zapisanych
// przykładowych odpowiedziach — testy nie łączą się z internetem.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildChainActivity } from '../src/activity.ts';
import { findLikelyDepositAddresses } from '../src/deposit.ts';
import { RequestBudget } from '../src/http.ts';
import { createChainProviders } from '../src/index.ts';
import { classify, createLabelSet, matchService } from '../src/labels.ts';
import { createSanctionsList, parseSdnXml } from '../src/ofac.ts';
import { TronScanTagClient, WalletExplorerClient } from '../src/party-labels.ts';
import { BlockscoutProvider, parseBlockscoutParty } from '../src/providers/blockscout.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { TronGridProvider } from '../src/providers/trongrid.ts';
import { MarketRateSource, StaticRateSource, valueAmount, valueCashOuts } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

const noLabels = createLabelSet([], 'zbiór testowy');
const noSanctions = createSanctionsList({ addresses: [] });
const sampleTable = new StaticRateSource({ source: 'tabela testowa', rates: { BTC: { '2025-03': 300000 }, ETH: { '2025-05': 10000 } } });

// ---------- Kursy rynkowe: Binance × NBP ----------

const klineUrl = (pair: string, day: string) =>
  `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${Date.parse(`${day}T00:00:00Z`)}&limit=1`;
const kline = (day: string, close: string) => [[Date.parse(`${day}T00:00:00Z`), '1', '2', '0.5', close, '10']];
const nbpRange = (from: string, to: string) => `https://api.nbp.pl/api/exchangerates/rates/a/usd/${from}/${to}/?format=json`;
// Zapisana odpowiedź NBP: tabele z tygodnia 10–14 marca 2025 (15 i 16 marca to weekend).
const nbpWeek = {
  table: 'A',
  code: 'USD',
  rates: [
    { no: '047/A/NBP/2025', effectiveDate: '2025-03-10', mid: 3.8573 },
    { no: '048/A/NBP/2025', effectiveDate: '2025-03-11', mid: 3.8481 },
    { no: '049/A/NBP/2025', effectiveDate: '2025-03-12', mid: 3.8496 },
    { no: '050/A/NBP/2025', effectiveDate: '2025-03-13', mid: 3.8568 },
    { no: '051/A/NBP/2025', effectiveDate: '2025-03-14', mid: 3.8509 },
  ],
};
const now = () => new Date('2026-11-21T12:00:00Z');

test('kurs rynkowy: zamknięcie dnia Binance × kurs NBP z dnia roboczego PRZED transakcją (sobota → piątek)', async () => {
  const mock = mockFetch({
    [klineUrl('BTCUSDT', '2025-03-15')]: kline('2025-03-15', '84338.44000000'),
    [nbpRange('2025-03-08', '2025-03-14')]: nbpWeek,
  });
  const source = new MarketRateSource({ fetch: mock.fetch, now });
  const quote = await source.getRatePln('BTC', '2025-03-15T10:00:00Z');
  assert.equal(quote?.usd?.price, 84338.44);
  assert.equal(quote?.usd?.pln, 3.8509);
  assert.equal(quote?.sample, undefined);

  const valued = await valueAmount(source, 'BTC', 0.3, '2025-03-15T10:00:00Z');
  assert.equal(valued?.valuePln, Math.round(0.3 * 84338.44 * 3.8509 * 100) / 100);
  assert.equal(valued?.sample, false);
  assert.match(
    valued?.valuation ?? '',
    /^Szacunek: 0,3 BTC × 84\s338,44 USD \(Binance BTCUSDT, cena zamknięcia dnia 2025-03-15 UTC\) × 3,8509 PLN\/USD \(NBP, kurs średni, tabela A nr 051\/A\/NBP\/2025 z 2025-03-14 — ostatni dzień roboczy poprzedzający dzień transakcji\) = 97\s433,67 PLN\. Data transakcji: 2025-03-15\.$/,
  );
  assert.equal(mock.calls.length, 2, 'powtórna wycena korzysta z pamięci podręcznej');
});

test('kurs rynkowy: dzień powszedni bierze tabelę z dnia poprzedniego, niedziela i poniedziałek — piątkową', async () => {
  const mock = mockFetch({
    [nbpRange('2025-03-07', '2025-03-13')]: { rates: nbpWeek.rates.slice(0, 4) },
    [nbpRange('2025-03-09', '2025-03-15')]: nbpWeek,
    [nbpRange('2025-03-10', '2025-03-16')]: nbpWeek,
  });
  const source = new MarketRateSource({ fetch: mock.fetch, now });
  // Piątek 14 marca: kurs z czwartku 13 marca, NIE z dnia transakcji.
  assert.equal((await source.usdPlnBefore('2025-03-14')).effectiveDate, '2025-03-13');
  assert.equal((await source.usdPlnBefore('2025-03-16')).effectiveDate, '2025-03-14');
  assert.equal((await source.usdPlnBefore('2025-03-17')).effectiveDate, '2025-03-14');
  // O dniu decyduje czas polski: 16 marca 23:30 UTC to już poniedziałek 17 marca w Polsce.
  const stable = await source.getRatePln('USDT', '2025-03-16T23:30:00Z');
  assert.equal(stable?.rate, 3.8509);
  assert.match(stable?.source ?? '', /założenie: 1 USDT = 1 USD; NBP.*z 2025-03-14/);
  assert.equal(mock.calls.length, 3);
  assert.ok(mock.calls.every((url) => url.startsWith('https://api.nbp.pl/')), 'stablecoin nie wymaga notowania Binance');
  assert.equal(await source.getRatePln('DOGE', '2025-03-14T10:00:00Z'), null);
});

test('kurs rynkowy: błąd sieci → kurs przykładowy z wyraźnym dopiskiem; bez zapasu brak wyceny', async () => {
  const failing = mockFetch({
    [klineUrl('BTCUSDT', '2025-03-15')]: { status: 503 },
    [nbpRange('2025-03-08', '2025-03-14')]: nbpWeek,
  });
  const source = new MarketRateSource({ fetch: failing.fetch, fallback: new StaticRateSource(), now });
  const quote = await source.getRatePln('BTC', '2025-03-15T10:00:00Z');
  assert.equal(quote?.sample, true);
  const [valued] = await valueCashOuts(
    [{ kind: 'exchange_deposit', txid: 't', time: '2025-03-15T10:00:00Z', asset: 'BTC', amount: 0.3, counterparty: 'a', explanation: 'x', explorerUrl: 'u' }],
    source,
  );
  assert.match(valued?.valuation ?? '', /UWAGA: KURS PRZYKŁADOWY \(dane demonstracyjne — nie jest to kurs rynkowy ani urzędowy\)/);
  assert.match(valued?.valuation ?? '', /Nie udało się pobrać kursu rynkowego \(Binance: usługa chwilowo niedostępna \(HTTP 503\)\)/);
  assert.doesNotMatch(valued?.valuation ?? '', /Binance BTCUSDT, cena zamknięcia/);
  assert.equal(failing.calls.length, 2, 'nieudane pobranie nie jest ponawiane w tej samej analizie');

  // Brak tabeli NBP w całym oknie 7 dni (404) i brak źródła zapasowego.
  const noTable = mockFetch({ [klineUrl('ETHUSDT', '2025-03-15')]: kline('2025-03-15', '1900') });
  assert.equal(await new MarketRateSource({ fetch: noTable.fetch, now }).getRatePln('ETH', '2025-03-15T10:00:00Z'), null);
  // Świeca z innego dnia niż żądany nie jest przyjmowana.
  const wrongDay = mockFetch({
    [klineUrl('ETHUSDT', '2025-03-15')]: kline('2025-03-16', '1900'),
    [nbpRange('2025-03-08', '2025-03-14')]: nbpWeek,
  });
  assert.equal(await new MarketRateSource({ fetch: wrongDay.fetch, now }).getRatePln('ETH', '2025-03-15T10:00:00Z'), null);
});

test('kurs rynkowy: plik pamięci podręcznej oszczędza zapytań przy powtórnej analizie', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'olcys-rates-'));
  const cacheFile = join(dir, 'cache', 'rates.json');
  try {
    const routes = {
      [klineUrl('ETHUSDT', '2025-03-15')]: kline('2025-03-15', '1937.50'),
      [nbpRange('2025-03-08', '2025-03-14')]: nbpWeek,
    };
    const first = mockFetch(routes);
    const a = await new MarketRateSource({ fetch: first.fetch, cacheFile, now }).getRatePln('ETH', '2025-03-15T10:00:00Z');
    assert.equal(first.calls.length, 2);
    const stored = JSON.parse(readFileSync(cacheFile, 'utf8'));
    assert.equal(stored.binance['ETHUSDT:2025-03-15'], 1937.5);
    assert.equal(stored.nbp['2025-03-15'].effectiveDate, '2025-03-14');

    const second = mockFetch({});
    const b = await new MarketRateSource({ fetch: second.fetch, cacheFile, now }).getRatePln('ETH', '2025-03-15T10:00:00Z');
    assert.equal(second.calls.length, 0);
    assert.equal(b?.rate, a?.rate);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createChainProviders: bez sieci kurs przykładowy jest oznaczony; z enableLive domyślne są kursy rynkowe', async () => {
  const offline = createChainProviders({ sandboxUrl: 'http://localhost:4100', fetch: mockFetch({}).fetch });
  const offlineSource = (offline[0] as unknown as { options: { rateSource: unknown } }).options.rateSource;
  assert.ok(offlineSource instanceof StaticRateSource);
  const valued = await valueAmount(offlineSource, 'BTC', 1, '2025-03-15T10:00:00Z');
  assert.equal(valued?.sample, true);
  assert.match(valued?.valuation ?? '', /UWAGA: KURS PRZYKŁADOWY/);

  const live = createChainProviders({ enableLive: true, fetch: mockFetch({}).fetch });
  for (const provider of live) {
    const source = (provider as unknown as { options: { rateSource: unknown } }).options.rateSource;
    assert.ok(source instanceof MarketRateSource);
    assert.equal(source.cacheFile, undefined, 'z podmienionym fetch nic nie trafia na dysk');
    assert.ok(source.fallback instanceof StaticRateSource);
  }
});

// ---------- Etykiety Blockscout ----------

// Zapisany opis strony transakcji z eth.blockscout.com (portfel „Binance 14”).
const BINANCE14 = '0x28C6c06298d514Db089934071355E5743bf21d60';
const binanceParty = {
  ens_domain_name: null,
  hash: BINANCE14,
  implementations: [{ address_hash: '0x63e842B054Bd624a465454D533C33F573e9c6fAe', name: null }],
  is_contract: false,
  is_scam: false,
  is_verified: false,
  metadata: {
    tags: [
      { meta: { main_entity: 'Binance' }, name: 'Binance: Hot Wallet', ordinal: 10, slug: 'binance-hot-wallet', tagType: 'name' },
      { meta: {}, name: 'HOT WALLET', ordinal: 0, slug: 'hot-wallet', tagType: 'generic' },
      { meta: {}, name: 'Exchange', ordinal: 0, slug: 'exchange', tagType: 'generic' },
      { meta: {}, name: 'Binance 14', ordinal: 0, slug: 'binance-14', tagType: 'name' },
      { meta: {}, name: 'Binance', ordinal: 0, slug: 'binance', tagType: 'protocol' },
    ],
  },
  name: null,
  private_tags: [],
  proxy_type: 'eip7702',
  public_tags: [],
};
const plainParty = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null, private_tags: [], public_tags: [], proxy_type: null, ens_domain_name: null });

test('Blockscout: znaczniki adresu → etykieta i klasa; konto z delegacją EIP-7702 nie jest kontraktem', () => {
  assert.deepEqual(parseBlockscoutParty(binanceParty), { label: 'Binance: Hot Wallet', addressClass: 'exchange', isContract: false });

  // Zapisana odpowiedź dla adresu vitalik.eth: `is_contract: true` wynika wyłącznie z delegacji EIP-7702.
  const vitalik = { hash: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', is_contract: true, proxy_type: 'eip7702', ens_domain_name: 'vitalik.eth', metadata: null, name: null, private_tags: [], public_tags: [] };
  assert.deepEqual(parseBlockscoutParty(vitalik), { isContract: false, ens: 'vitalik.eth' });

  // Kontrakt tokena wydanego przez giełdę: sama nazwa nie czyni go giełdą.
  const token = { hash: '0x1', is_contract: true, name: 'Binance USD', metadata: null, public_tags: [] };
  assert.deepEqual(parseBlockscoutParty(token), { label: 'Binance USD', isContract: true });
  // Nazwa giełdy bez znacznika „Exchange” na zwykłym koncie wystarcza; znacznik publiczny też jest czytany.
  assert.equal(parseBlockscoutParty({ hash: '0x2', public_tags: [{ display_name: 'Kraken 4' }] }).addressClass, 'exchange');
  assert.equal(parseBlockscoutParty({ hash: '0x3', metadata: { tags: [{ name: 'Exchange', slug: 'exchange', tagType: 'generic' }] } }).addressClass, 'exchange');
  assert.equal(parseBlockscoutParty({ hash: '0x4', metadata: { tags: [{ name: 'Stargate: Router', tagType: 'name' }] } }).addressClass, undefined);
  assert.deepEqual(parseBlockscoutParty(null), { isContract: false });

  assert.equal(matchService('Gate.io 3', 'exchange')?.name, 'Gate');
  assert.equal(matchService('Payment gateway', 'exchange'), undefined);
  assert.equal(matchService('Zonda (BitBay) hot wallet')?.category, 'exchange');
  assert.equal(classify('bitcoin', '1x', { labels: noLabels, sourceLabel: 'Huobi.com-2', sourceName: 'WalletExplorer' }).addressClass, 'exchange');
});

const ETH_SUBJECT = '0x1111111111111111111111111111111111111111';
const ETH_HOP = '0x2222222222222222222222222222222222222222';
const ETH_OTHER = '0x3333333333333333333333333333333333333333';
const BS = 'https://eth.blockscout.com/api/v2/addresses';
const ethTx = (hash: string, timestamp: string, from: object, to: object, eth: number) => ({
  hash,
  timestamp,
  from,
  to,
  value: String(BigInt(Math.round(eth * 1e6)) * 10n ** 12n),
  status: 'ok',
});

function blockscoutRoutes(forwardTime: string, forwardEth = 1.999) {
  return {
    [`${BS}/${ETH_SUBJECT}`]: { ...plainParty(ETH_SUBJECT), coin_balance: '1000000000000000000', ens_domain_name: 'badany.eth' },
    [`${BS}/${ETH_SUBJECT}/transactions`]: {
      items: [
        ethTx('0xdirect', '2025-05-12T08:00:00.000000Z', plainParty(ETH_SUBJECT), binanceParty, 0.5),
        ethTx('0xdeposit', '2025-05-10T08:00:00.000000Z', plainParty(ETH_SUBJECT), plainParty(ETH_HOP), 2),
      ],
      next_page_params: null,
    },
    [`${BS}/${ETH_SUBJECT}/token-transfers?type=ERC-20`]: { items: [], next_page_params: null },
    [`${BS}/${ETH_HOP}/transactions?filter=from`]: {
      items: [ethTx('0xsweep', forwardTime, plainParty(ETH_HOP), binanceParty, forwardEth)],
      next_page_params: null,
    },
  };
}

test('Blockscout: przelew na oznaczony portfel giełdy jest wypłatą, źródłem klasyfikacji jest Blockscout', async () => {
  const mock = mockFetch(blockscoutRoutes('2025-05-10T11:00:00.000000Z'));
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource: sampleTable, labels: noLabels, sanctions: noSanctions });
  const activity = await provider.getActivity('ethereum', ETH_SUBJECT, testContext());

  assert.equal(activity.profile.addressClass, 'private');
  assert.equal(activity.profile.label, 'ENS: badany.eth');
  const direct = activity.transfers.find((t) => t.txid === '0xdirect');
  assert.equal(direct?.counterpartyClass, 'exchange');
  assert.equal(direct?.counterpartyLabel, 'Binance: Hot Wallet');
  // Bez włączonego badania dalszej drogi środków adres pośredni nie jest sprawdzany.
  assert.deepEqual(activity.cashOuts.map((c) => c.txid), ['0xdirect']);
  assert.equal(mock.calls.length, 3);

  const exchange = await new BlockscoutProvider({
    fetch: mockFetch({
      [`${BS}/${BINANCE14}`]: { status: 504 },
      [`${BS}/${BINANCE14}/transactions`]: { items: [ethTx('0xin', '2025-05-12T08:00:00.000000Z', plainParty(ETH_OTHER), binanceParty, 1)] },
      [`${BS}/${BINANCE14}/token-transfers?type=ERC-20`]: { items: [] },
    }).fetch,
    rateSource: sampleTable,
    labels: noLabels,
    sanctions: noSanctions,
  }).getActivity('ethereum', BINANCE14, testContext());
  // Dane adresu niedostępne (504): etykieta i klasa pochodzą ze znaczników w transakcjach.
  assert.equal(exchange.profile.addressClass, 'exchange');
  assert.equal(exchange.profile.label, 'Binance: Hot Wallet');
  assert.match(exchange.profile.classificationSource, /^Blockscout \(klasa podana przez źródło\)$/);
  assert.ok(exchange.limitations.some((item) => /Nie udało się pobrać danych adresu .*HTTP 504/.test(item)));
});

// ---------- Prawdopodobny adres wpłat na giełdę ----------

test('adres wpłat: środki przekazane na giełdę w oknie czasu → wskaźnik oznaczony jako wnioskowanie', async () => {
  const mock = mockFetch(blockscoutRoutes('2025-05-10T11:00:00.000000Z'));
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource: sampleTable, labels: noLabels, sanctions: noSanctions, followDeposits: true });
  const activity = await provider.getActivity('ethereum', ETH_SUBJECT, testContext());

  assert.deepEqual(activity.cashOuts.map((c) => c.txid), ['0xdeposit', '0xdirect']);
  const inferred = activity.cashOuts[0]!;
  assert.equal(inferred.kind, 'exchange_deposit');
  assert.equal(inferred.counterparty, ETH_HOP);
  assert.match(inferred.explanation, /^WNIOSKOWANIE \(nie ustalony fakt\)/);
  assert.match(inferred.explanation, /adres pośredni przekazał środki \(100% kwoty przelewu\) do portfela giełdy „Binance: Hot Wallet”/);
  assert.match(inferred.explanation, /po 3 h, w oknie 48 h od wpłaty — to prawdopodobny indywidualny adres wpłat/);
  assert.match(inferred.counterpartyLabel ?? '', /Prawdopodobny adres wpłat giełdy „Binance: Hot Wallet” \(wnioskowanie\)/);
  assert.equal(inferred.valuePln, 20000);
  // Sam adres pośredni pozostaje bez klasy — nie udajemy, że to potwierdzony adres giełdy.
  assert.equal(activity.transfers.find((t) => t.txid === '0xdeposit')?.counterpartyClass, 'unknown');
  assert.ok(activity.limitations.some((item) => /są WNIOSKOWANIEM z dalszej drogi środków/.test(item)));
  assert.equal(mock.calls.length, 4, 'jedno dodatkowe żądanie na adres pośredni');
  assert.deepEqual(activity.cashOutPlnByYear, { '2025': 25000 });
});

test('adres wpłat: brak trafienia, gdy środki wyszły po oknie czasu, tylko w części albo nie na giełdę', async () => {
  const run = async (routes: Record<string, unknown>, deposit?: object) => {
    const provider = new BlockscoutProvider({ fetch: mockFetch(routes).fetch, rateSource: sampleTable, labels: noLabels, sanctions: noSanctions, followDeposits: true, deposit });
    return provider.getActivity('ethereum', ETH_SUBJECT, testContext());
  };
  const late = await run(blockscoutRoutes('2025-05-13T09:00:00.000000Z'));
  assert.deepEqual(late.cashOuts.map((c) => c.txid), ['0xdirect']);
  assert.ok(!late.limitations.some((item) => /WNIOSKOWANIEM/.test(item)));
  // To samo przekazanie mieści się w oknie wydłużonym do 96 h.
  assert.equal((await run(blockscoutRoutes('2025-05-13T09:00:00.000000Z'), { windowHours: 96 })).cashOuts.length, 2);

  const partial = await run(blockscoutRoutes('2025-05-10T11:00:00.000000Z', 1));
  assert.deepEqual(partial.cashOuts.map((c) => c.txid), ['0xdirect']);

  const routes = blockscoutRoutes('2025-05-10T11:00:00.000000Z');
  routes[`${BS}/${ETH_HOP}/transactions?filter=from`] = {
    items: [ethTx('0xsweep', '2025-05-10T11:00:00.000000Z', plainParty(ETH_HOP), plainParty(ETH_OTHER), 1.999)],
    next_page_params: null,
  };
  assert.deepEqual((await run(routes)).cashOuts.map((c) => c.txid), ['0xdirect']);
  assert.deepEqual((await run(blockscoutRoutes('2025-05-10T11:00:00.000000Z'), { enabled: false })).cashOuts.map((c) => c.txid), ['0xdirect']);
});

test('adres wpłat: wyczerpany budżet żądań przerywa wyszukiwanie i jest odnotowany', async () => {
  const mock = mockFetch(blockscoutRoutes('2025-05-10T11:00:00.000000Z'));
  const provider = new BlockscoutProvider({ fetch: mock.fetch, rateSource: sampleTable, labels: noLabels, sanctions: noSanctions, followDeposits: true, requestBudget: 3 });
  const activity = await provider.getActivity('ethereum', ETH_SUBJECT, testContext());
  assert.deepEqual(activity.cashOuts.map((c) => c.txid), ['0xdirect']);
  assert.equal(mock.calls.length, 3);
  assert.ok(activity.limitations.some((item) => /przerwano: wyczerpano budżet 3 żądań na jedną analizę adresu\. Sprawdzono 0 z 1 kontrahentów/.test(item)));

  // Sześciu kontrahentów bez etykiety, budżet na dwa żądania: bada się odbiorców największych kwot.
  const asked: string[] = [];
  const transfers = [1, 6, 3, 2, 5, 4].map((amount) => ({
    txid: `t${amount}`,
    time: '2025-05-10T08:00:00Z',
    direction: 'out' as const,
    counterparty: `0x${String(amount).repeat(40)}`,
    asset: 'ETH',
    amount,
    explorerUrl: 'u',
  }));
  const budget = new RequestBudget(2);
  const result = await findLikelyDepositAddresses({
    network: 'ethereum',
    address: ETH_SUBJECT,
    transfers,
    labels: noLabels,
    sourceName: 'test',
    budget,
    fetchOutgoing: async (counterparty) => {
      asked.push(counterparty);
      return [];
    },
  });
  assert.deepEqual(asked, [`0x${'6'.repeat(40)}`, `0x${'5'.repeat(40)}`]);
  assert.equal(budget.remaining, 0);
  assert.deepEqual(result.deposits, []);
  assert.match(result.limitations[0] ?? '', /Sprawdzono 2 z 6 kontrahentów bez etykiety/);
});

// ---------- WalletExplorer (Bitcoin) ----------

const WE = 'https://www.walletexplorer.com/api/1/address-lookup';
const weUrl = (address: string) => `${WE}?address=${address}&caller=OLCyS-research`;
const BTC_SUBJECT = 'bc1qsubject0000000000000000000000000000';
const BTC_KRAKEN = '3KrakenDepositAddr00000000000000000';
const BTC_HOP = 'bc1qhop000000000000000000000000000000000';
const BTC_SWEEP = '1BinanceSweepWallet0000000000000000';
const ESPLORA = 'https://blockstream.info/api/address';
const btcTx = (txid: string, time: string, from: string, outputs: [string, number][]) => ({
  txid,
  status: { confirmed: true, block_time: Date.parse(time) / 1000 },
  vin: [{ prevout: { scriptpubkey_address: from, value: outputs.reduce((sum, [, value]) => sum + value, 0) + 1000 } }],
  vout: outputs.map(([scriptpubkey_address, value]) => ({ scriptpubkey_address, value })),
});

test('WalletExplorer: nazwa portfela, portfel bez nazwy, pamięć podręczna', async () => {
  // Zapisane odpowiedzi serwisu: adres portfela Binance i adres portfela bez nazwy.
  const mock = mockFetch({
    [weUrl('1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s')]: { found: true, label: 'Binance.com', wallet_id: '00000b55c1bcbc1f', updated_to_block: 976785 },
    [weUrl('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo')]: { found: true, wallet_id: '011cf39664426f5d', updated_to_block: 976785 },
    [weUrl('1Limit')]: { status: 429 },
  });
  const client = new WalletExplorerClient({ fetch: mock.fetch, minIntervalMs: 0 });
  assert.equal(await client.lookup('1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s'), 'Binance.com');
  assert.equal(await client.lookup('34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'), undefined);
  assert.equal(await client.lookup('1NDyJtNTjmwk5xPNhjgAMu4HDHigtobu1s'), 'Binance.com');
  assert.equal(mock.calls.length, 2);
  await assert.rejects(client.lookup('1Limit'), /WalletExplorer: przekroczono limit zapytań/);
});

function esploraProvider(routes: Record<string, unknown>, extra: object = {}) {
  const mock = mockFetch(routes);
  const provider = new EsploraProvider({
    id: 'esplora-blockstream',
    label: 'Blockstream Esplora (Bitcoin)',
    siteUrl: 'https://blockstream.info',
    fetch: mock.fetch,
    rateSource: sampleTable,
    labels: noLabels,
    sanctions: noSanctions,
    labelLookup: new WalletExplorerClient({ fetch: mock.fetch, minIntervalMs: 0 }),
    ...extra,
  });
  return { mock, provider };
}

test('Bitcoin: etykieta WalletExplorer kontrahenta daje wypłatę na giełdę ze źródłem „WalletExplorer”', async () => {
  const { mock, provider } = esploraProvider({
    [`${ESPLORA}/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 60_000_000, spent_txo_sum: 50_001_000, tx_count: 1 } },
    [`${ESPLORA}/${BTC_SUBJECT}/txs`]: [btcTx('tx1', '2025-03-14T10:00:00Z', BTC_SUBJECT, [[BTC_KRAKEN, 50_000_000]])],
    [weUrl(BTC_SUBJECT)]: { found: true, wallet_id: 'aa' },
    [weUrl(BTC_KRAKEN)]: { found: true, label: 'Kraken.com', wallet_id: 'bb' },
  });
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.equal(activity.profile.addressClass, 'private');
  assert.equal(activity.transfers[0]?.counterpartyClass, 'exchange');
  assert.equal(activity.transfers[0]?.counterpartyLabel, 'Kraken.com');
  assert.equal(activity.cashOuts.length, 1);
  assert.equal(activity.cashOuts[0]?.valuePln, 150000);
  assert.ok(activity.limitations.some((item) => /Etykiety WalletExplorer dotyczą portfeli wyznaczonych heurystyką/.test(item)));
  assert.deepEqual(mock.calls.slice(2), [weUrl(BTC_SUBJECT), weUrl(BTC_KRAKEN)]);

  // Badany adres należący do nazwanego portfela giełdy: klasa i źródło klasyfikacji z WalletExplorer.
  const own = esploraProvider({
    [`${ESPLORA}/${BTC_KRAKEN}`]: { chain_stats: { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 } },
    [weUrl(BTC_KRAKEN)]: { found: true, label: 'Kraken.com', wallet_id: 'bb' },
  });
  const profile = (await own.provider.getActivity('bitcoin', BTC_KRAKEN, testContext())).profile;
  assert.equal(profile.addressClass, 'exchange');
  assert.equal(profile.classificationSource, 'WalletExplorer (klasa rozpoznana po nazwie w etykiecie)');

  // Błąd serwisu etykiet (429) nie wywraca analizy — trafia do ograniczeń.
  const limited = esploraProvider({
    [`${ESPLORA}/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 60_000_000, spent_txo_sum: 50_001_000, tx_count: 1 } },
    [`${ESPLORA}/${BTC_SUBJECT}/txs`]: [btcTx('tx1', '2025-03-14T10:00:00Z', BTC_SUBJECT, [[BTC_KRAKEN, 50_000_000]])],
    [weUrl(BTC_SUBJECT)]: { status: 429 },
  });
  const degraded = await limited.provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.equal(degraded.transfers.length, 1);
  assert.equal(degraded.cashOuts.length, 0);
  assert.ok(degraded.limitations.some((item) => /WalletExplorer: sprawdzono etykiety 0 z 1 kontrahentów \(błąd serwisu — WalletExplorer: przekroczono limit zapytań/.test(item)));
});

test('Bitcoin: adres pośredni zamieciony do portfela giełdy (etykieta odbiorcy z WalletExplorer)', async () => {
  const { mock, provider } = esploraProvider(
    {
      [`${ESPLORA}/${BTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 120_000_000, spent_txo_sum: 100_001_000, tx_count: 1 } },
      [`${ESPLORA}/${BTC_SUBJECT}/txs`]: [btcTx('tx1', '2025-03-14T10:00:00Z', BTC_SUBJECT, [[BTC_HOP, 100_000_000]])],
      [`${ESPLORA}/${BTC_HOP}/txs`]: [
        btcTx('sweep', '2025-03-14T16:30:00Z', BTC_HOP, [[BTC_SWEEP, 99_990_000]]),
        btcTx('tx1', '2025-03-14T10:00:00Z', BTC_SUBJECT, [[BTC_HOP, 100_000_000]]),
      ],
      [weUrl(BTC_SUBJECT)]: { found: false },
      [weUrl(BTC_HOP)]: { found: true, wallet_id: 'cc' },
      [weUrl(BTC_SWEEP)]: { found: true, label: 'Binance.com', wallet_id: 'dd' },
    },
    { followDeposits: true },
  );
  const activity = await provider.getActivity('bitcoin', BTC_SUBJECT, testContext());
  assert.equal(activity.cashOuts.length, 1);
  const inferred = activity.cashOuts[0]!;
  assert.match(inferred.explanation, /^WNIOSKOWANIE/);
  assert.match(inferred.explanation, /do portfela giełdy „Binance\.com” \(1BinanceSweepWallet0000000000000000\) po 6,5 h/);
  assert.match(inferred.explanation, /Etykieta giełdy: WalletExplorer/);
  assert.equal(inferred.valuePln, 300000);
  assert.equal(mock.calls.length, 6);
});

// ---------- TronScan ----------

test('Tron: publiczny znacznik TronScan kontrahenta → wypłata na giełdę; kontrakt bez znacznika', async () => {
  const TRON_SUBJECT = 'TSubjectAddress0000000000000000000';
  const TRON_BINANCE = 'TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi';
  const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
  const grid = `https://api.trongrid.io/v1/accounts/${TRON_SUBJECT}`;
  const tag = (address: string) => `https://apilist.tronscanapi.com/api/account/tag?address=${address}`;
  const mock = mockFetch({
    [grid]: { data: [{ balance: 5_000_000 }] },
    [`${grid}/transactions?limit=50&only_confirmed=true`]: { data: [] },
    [`${grid}/transactions/trc20?limit=50&only_confirmed=true`]: {
      data: [{ transaction_id: 'trx1', block_timestamp: Date.parse('2025-06-03T12:00:00Z'), from: TRON_SUBJECT, to: TRON_BINANCE, value: '1500000000', token_info: { symbol: 'USDT', address: USDT, decimals: 6 } }],
    },
    // Zapisane odpowiedzi TronScan.
    [tag(TRON_SUBJECT)]: { blueTag: '', greyTag: '', redTag: '', publicTag: '', chainTags: {} },
    [tag(TRON_BINANCE)]: { blueTag: '', greyTag: '', redTag: '', publicTag: 'Binance-Hot 2', chainTags: {} },
    [tag(USDT)]: { msg: 'Contracts are not supported yet.', code: '1000' },
  });
  const tronScan = new TronScanTagClient({ fetch: mock.fetch, minIntervalMs: 0 });
  assert.equal(await tronScan.lookup(USDT), undefined);
  const labels = createLabelSet([{ network: 'tron', address: USDT, label: 'Tether: kontrakt tokena USDT (TRC-20)', addressClass: 'smart_contract', asset: 'USDT' }], 'zbiór testowy');
  const provider = new TronGridProvider({ fetch: mock.fetch, rateSource: new StaticRateSource({ source: 'tabela testowa', rates: { USDT: { '2025-06': 3.7 } } }), labels, sanctions: noSanctions, labelLookup: tronScan, followDeposits: true });
  const activity = await provider.getActivity('tron', TRON_SUBJECT, testContext());
  assert.equal(activity.transfers[0]?.counterpartyLabel, 'Binance-Hot 2');
  assert.equal(activity.transfers[0]?.counterpartyClass, 'exchange');
  assert.equal(activity.cashOuts[0]?.kind, 'exchange_deposit');
  assert.equal(activity.cashOuts[0]?.valuePln, 5550);
});

// ---------- Lista sankcyjna OFAC ----------

// Fragment w układzie pliku SDN.XML (treść skrócona).
const SDN_SAMPLE = `<?xml version="1.0" standalone="yes"?>
<sdnList>
  <publshInformation><Publish_Date>11/20/2026</Publish_Date><Record_Count>2</Record_Count></publshInformation>
  <sdnEntry>
    <uid>36</uid>
    <lastName>AEROCARIBBEAN AIRLINES</lastName>
    <sdnType>Entity</sdnType>
    <programList><program>CUBA</program></programList>
    <akaList><aka><uid>12</uid><lastName>AERO-CARIBBEAN</lastName></aka></akaList>
  </sdnEntry>
  <sdnEntry>
    <uid>25308</uid>
    <firstName>Jan</firstName>
    <lastName>PRZYKŁADOWY &amp; SPÓŁKA</lastName>
    <sdnType>Individual</sdnType>
    <programList><program>CYBER2</program></programList>
    <akaList><aka><uid>99</uid><lastName>INNY ALIAS</lastName></aka></akaList>
    <idList>
      <id><uid>1</uid><idType>Passport</idType><idNumber>X123</idNumber></id>
      <id>
        <uid>2</uid>
        <idType>Digital Currency Address - XBT</idType>
        <idNumber>1SankcyjnyAdresBitcoin000000000000</idNumber>
      </id>
      <id><uid>3</uid><idType>Digital Currency Address - ETH</idType><idNumber>0xABCDEF0000000000000000000000000000000001</idNumber></id>
      <id><uid>4</uid><idType>Digital Currency Address - ETH</idType><idNumber>0xabcdef0000000000000000000000000000000001</idNumber></id>
    </idList>
  </sdnEntry>
</sdnList>`;

test('OFAC: parser listy SDN wyciąga adresy kryptowalutowe z nazwą podmiotu', () => {
  const parsed = parseSdnXml(SDN_SAMPLE);
  assert.equal(parsed.publishDate, '11/20/2026');
  assert.deepEqual(parsed.addresses, [
    { address: '1SankcyjnyAdresBitcoin000000000000', asset: 'XBT', entity: 'Jan PRZYKŁADOWY & SPÓŁKA' },
    { address: '0xABCDEF0000000000000000000000000000000001', asset: 'ETH', entity: 'Jan PRZYKŁADOWY & SPÓŁKA' },
  ]);
  const list = createSanctionsList({ ...parsed, source: 'OFAC SDN (test)', fetchedAt: '2026-11-21T12:00:00Z' });
  assert.equal(list.size, 2);
  assert.equal(list.lookup('0xabcdef0000000000000000000000000000000001')?.asset, 'ETH');
  assert.equal(list.lookup('1sankcyjnyadresbitcoin000000000000'), undefined, 'adresy Base58 rozróżniają wielkość liter');
});

test('OFAC: adres z listy dostaje etykietę i ostrzeżenie — jako badany adres i jako kontrahent', async () => {
  const sanctions = createSanctionsList({ ...parseSdnXml(SDN_SAMPLE), source: 'OFAC SDN (test)', fetchedAt: '2026-11-21T12:00:00Z' });
  const listed = '0xabcdef0000000000000000000000000000000001';
  const transfer = { txid: 't1', time: '2025-05-10T08:00:00Z', direction: 'out' as const, asset: 'ETH', amount: 1, explorerUrl: 'u' };

  const subject = await buildChainActivity(
    { network: 'ethereum', address: listed, sourceName: 'źródło testowe', transfers: [{ ...transfer, counterparty: ETH_OTHER }], limitations: ['inne ograniczenie'] },
    { labels: noLabels, sanctions, rateSource: sampleTable },
  );
  assert.equal(subject.profile.label, 'Lista sankcyjna OFAC (SDN): Jan PRZYKŁADOWY & SPÓŁKA');
  assert.equal(subject.profile.addressClass, 'private', 'klasa adresu nie jest zmieniana przez listę');
  assert.match(subject.profile.classificationSource, /; OFAC SDN \(test\)$/);
  assert.match(subject.limitations[0] ?? '', /^OSTRZEŻENIE — Lista sankcyjna OFAC \(SDN\): badany adres 0xABCDEF0+1 figuruje na liście jako adres ETH podmiotu „Jan PRZYKŁADOWY & SPÓŁKA” \(kopia listy pobrana 2026-11-21\)/);

  const counterparty = await buildChainActivity(
    {
      network: 'ethereum',
      address: ETH_SUBJECT,
      sourceName: 'źródło testowe',
      transfers: [
        { ...transfer, counterparty: listed, counterpartyLabel: 'Jakaś nazwa' },
        { ...transfer, txid: 't2', counterparty: listed },
      ],
      limitations: [],
    },
    { labels: noLabels, sanctions, rateSource: sampleTable },
  );
  assert.equal(counterparty.profile.label, undefined);
  assert.equal(counterparty.transfers[0]?.counterpartyLabel, 'Lista sankcyjna OFAC (SDN): Jan PRZYKŁADOWY & SPÓŁKA — Jakaś nazwa');
  assert.equal(counterparty.limitations.filter((item) => /OSTRZEŻENIE — Lista sankcyjna OFAC \(SDN\): kontrahent/.test(item)).length, 1);

  const clean = await buildChainActivity(
    { network: 'ethereum', address: ETH_SUBJECT, sourceName: 'źródło testowe', transfers: [{ ...transfer, counterparty: ETH_OTHER }], limitations: [] },
    { labels: noLabels, sanctions, rateSource: sampleTable },
  );
  assert.ok(!clean.limitations.some((item) => /OFAC/.test(item)));
});
