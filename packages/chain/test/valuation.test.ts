import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CashOutIndicator } from '@olcys/core';
import {
  FallbackRateSource,
  NbpRateSource,
  StaticRateSource,
  polishDate,
  summarizeByTaxYear,
  valueCashOuts,
} from '../src/valuation.ts';
import { mockFetch } from './helpers.ts';

const table = {
  source: 'tabela testowa',
  rates: { BTC: { '2025-03': 300000, '2026-01': 350000 }, USDT: { '2025-03': 4 } },
};

function cashOut(partial: Partial<CashOutIndicator>): CashOutIndicator {
  return {
    kind: 'exchange_deposit',
    txid: 'tx',
    time: '2025-03-14T10:22:00Z',
    asset: 'BTC',
    amount: 0.5,
    counterparty: 'addr',
    explanation: 'opis',
    explorerUrl: 'https://example.test/tx',
    ...partial,
  };
}

const nbpUrl = (day: string) => `https://api.nbp.pl/api/exchangerates/rates/a/usd/${day}/?format=json`;

test('tabela statyczna: kurs z miesiąca transakcji, brak kursu daje null', async () => {
  const source = new StaticRateSource(table);
  const quote = await source.getRatePln('btc', '2025-03-14T10:22:00Z');
  assert.equal(quote?.rate, 300000);
  assert.match(quote?.source ?? '', /tabela testowa, miesiąc 2025-03/);
  assert.equal(await source.getRatePln('BTC', '2023-01-01T00:00:00Z'), null);
  assert.equal(await source.getRatePln('DOGE', '2025-03-14T10:22:00Z'), null);
});

test('wbudowana tabela jest oznaczona jako dane przykładowe i obejmuje lata 2024–2026', async () => {
  const source = new StaticRateSource();
  assert.match(source.table.source, /dane demonstracyjne, nie kursy urzędowe/);
  for (const asset of ['BTC', 'ETH', 'TRX', 'USDT', 'USDC']) {
    for (const date of ['2024-01-15T12:00:00Z', '2025-06-15T12:00:00Z', '2026-12-15T12:00:00Z']) {
      const quote = await source.getRatePln(asset, date);
      assert.ok(quote && quote.rate > 0, `${asset} ${date}`);
    }
  }
});

test('NBP: kurs USD dla stablecoina; przy 404 cofa się o kolejne dni', async () => {
  // 2025-03-16 to niedziela: brak tabeli w niedzielę i sobotę, jest piątkowa.
  const mock = mockFetch({ [nbpUrl('2025-03-14')]: { rates: [{ no: '051/A/NBP/2025', mid: 3.85 }] } });
  const source = new NbpRateSource(mock.fetch);
  const quote = await source.getRatePln('USDT', '2025-03-16T09:00:00Z');
  assert.equal(quote?.rate, 3.85);
  assert.match(quote?.source ?? '', /NBP z 2025-03-14/);
  assert.match(quote?.source ?? '', /1 USDT = 1 USD/);
  assert.deepEqual(mock.calls, [nbpUrl('2025-03-16'), nbpUrl('2025-03-15'), nbpUrl('2025-03-14')]);

  await source.getRatePln('USDC', '2025-03-16T15:00:00Z');
  assert.equal(mock.calls.length, 3, 'kurs z tego samego dnia jest pobierany raz');
});

test('NBP: pomija inne waluty i poddaje się po 5 dniach wstecz lub przy błędzie usługi', async () => {
  const none = mockFetch({});
  const source = new NbpRateSource(none.fetch);
  assert.equal(await source.getRatePln('BTC', '2025-03-14T10:00:00Z'), null);
  assert.equal(none.calls.length, 0);
  assert.equal(await source.getRatePln('USDT', '2025-03-14T10:00:00Z'), null);
  assert.equal(none.calls.length, 6);

  const failing = mockFetch({ [nbpUrl('2025-03-14')]: { status: 503 } });
  assert.equal(await new NbpRateSource(failing.fetch).getRatePln('USDT', '2025-03-14T10:00:00Z'), null);
  assert.equal(failing.calls.length, 1);
});

test('źródło zapasowe: tabela statyczna zastępuje NBP, gdy ten nie ma kursu', async () => {
  const source = new FallbackRateSource([new NbpRateSource(mockFetch({}).fetch), new StaticRateSource(table)]);
  assert.equal((await source.getRatePln('USDT', '2025-03-14T10:00:00Z'))?.rate, 4);
  assert.equal((await source.getRatePln('BTC', '2025-03-14T10:00:00Z'))?.rate, 300000);
});

test('wycena wypłat: wartość, opis szacunku z kursem, źródłem i datą', async () => {
  const [valued, unvalued] = await valueCashOuts(
    [cashOut({}), cashOut({ asset: 'DOGE' })],
    new StaticRateSource(table),
  );
  assert.equal(valued?.valuePln, 150000);
  assert.match(valued?.valuation ?? '', /^Szacunek: 0,5 BTC × /);
  assert.match(valued?.valuation ?? '', /tabela testowa, miesiąc 2025-03/);
  assert.match(valued?.valuation ?? '', /Data transakcji: 2025-03-14/);
  assert.equal(unvalued?.valuePln, undefined);
  assert.equal(unvalued?.valuation, undefined);
});

test('sumy per rok podatkowy liczą się według czasu polskiego i pomijają pozycje bez wyceny', () => {
  const totals = summarizeByTaxYear([
    cashOut({ valuePln: 1000.1 }),
    cashOut({ valuePln: 2000.2, time: '2025-11-02T08:00:00Z' }),
    // 31 grudnia 23:30 UTC to już 1 stycznia w Polsce.
    cashOut({ valuePln: 500, time: '2025-12-31T23:30:00Z' }),
    cashOut({ time: '2025-06-01T08:00:00Z' }),
  ]);
  assert.deepEqual(totals, { '2025': 3000.3, '2026': 500 });
  assert.equal(polishDate('2025-12-31T23:30:00Z'), '2026-01-01');
});
