// Adresy organów państwa (zajęcia), znane incydenty i pochodzenie środków. Bez internetu.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildChainActivity } from '../src/activity.ts';
import type { ChainActivityWithQuestions, RawTransfer } from '../src/activity.ts';
import { traceFundingSources } from '../src/funding.ts';
import type { FundingSearch } from '../src/funding.ts';
import { RequestBudget } from '../src/http.ts';
import { classify, createLabelSet, getDefaultLabels, loadLabelFile } from '../src/labels.ts';
import type { IncomingNode } from '../src/links.ts';
import { createSanctionsList } from '../src/ofac.ts';
import { StaticRateSource } from '../src/valuation.ts';

const SUBJECT = '1SubjectAddress00000000000000000000';
const GOV = 'bc1qgovernmentwallet000000000000000000000';
const EXCHANGE = '1ExchangeHotWallet00000000000000000';
const HACK = '1IncidentAddress0000000000000000000';
const SOURCE = 'https://example.test/komunikat (dokładny adres)';
const labels = createLabelSet(
  [
    { network: 'bitcoin', address: GOV, label: 'Rząd USA: środki zajęte po włamaniu', addressClass: 'institutional', category: 'law_enforcement', source: SOURCE, checkedAt: '2026-11-21' },
    { network: 'bitcoin', address: EXCHANGE, label: 'Zonda: portfel giełdy', addressClass: 'exchange', kind: 'exchange_deposit' },
    { network: 'bitcoin', address: HACK, label: 'Incydent: adres sprawcy włamania', addressClass: 'unknown', category: 'incident', source: SOURCE },
  ],
  'zbiór testowy',
);
const noSanctions = createSanctionsList({ addresses: [] });
const rates = new StaticRateSource({ source: 'tabela testowa', rates: { BTC: { '2022-02': 150000, '2022-03': 160000 } } });
const move = (txid: string, time: string, direction: 'in' | 'out', counterparty: string, amount: number, extra: Partial<RawTransfer> = {}): RawTransfer => ({
  txid, time, direction, counterparty, asset: 'BTC', amount, explorerUrl: `https://example.test/tx/${txid}`, ...extra,
});
const pad = (name: string) => `1${name}`.padEnd(34, 'x');

test('zbiór etykiet: kategorie organu państwa i incydentu wymagają źródła; wbudowane wpisy mają źródło i datę', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olcys-labels-'));
  try {
    const file = join(dir, 'labels.json');
    const entry = { network: 'bitcoin', address: GOV, label: 'Organ', addressClass: 'institutional', category: 'law_enforcement' };
    writeFileSync(file, JSON.stringify({ labels: [entry] }));
    assert.throws(() => loadLabelFile(file), /wpis 1: kategoria "law_enforcement" wymaga pola "source"/);
    writeFileSync(file, JSON.stringify({ labels: [{ ...entry, source: SOURCE, category: 'policja' }] }));
    assert.throws(() => loadLabelFile(file), /nieznana kategoria "policja"/);
    writeFileSync(file, JSON.stringify({ labels: [{ ...entry, source: SOURCE }] }));
    assert.equal(loadLabelFile(file).entries[0]?.category, 'law_enforcement');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Adres rządu USA ze środkami z Bitfinex: klasa z core (`institutional`) + kategoria + źródło.
  const known = classify('bitcoin', 'bc1qazcm763858nkj2dj986etajv6wquslv8uxwczt', { labels: getDefaultLabels() });
  assert.equal(known.addressClass, 'institutional');
  assert.equal(known.category, 'law_enforcement');
  assert.equal(known.kind, undefined, 'organ państwa nie jest usługą wymiany');
  assert.match(known.source ?? '', /merklescience\.com.*justice\.gov.*sprawdzono 2026-11-21/);
  assert.match(known.label ?? '', /^Rząd USA: środki zajęte po włamaniu na Bitfinex/);
  assert.equal(classify('bitcoin', '1HQ3Go3ggs8pFnXuHVHRytPCq5fGG8Hbhx', { labels: getDefaultLabels() }).category, 'incident');
});

test('przelew do organu państwa to wskaźnik zajęcia, a nie wypłata: brak w `cashOuts`, `trails` i sumach PLN', async () => {
  const activity = (await buildChainActivity(
    {
      network: 'bitcoin',
      address: SUBJECT,
      sourceName: 'źródło testowe',
      transfers: [
        move('in1', '2022-01-10T10:00:00Z', 'in', pad('Sender'), 600),
        move('seize', '2022-02-01T04:57:00Z', 'out', GOV, 567.48646001),
        move('cash', '2022-03-05T10:00:00Z', 'out', EXCHANGE, 2),
      ],
      limitations: [],
    },
    { labels, sanctions: noSanctions, rateSource: rates },
  )) as ChainActivityWithQuestions;

  assert.deepEqual(activity.cashOuts.map((item) => item.txid), ['cash']);
  assert.deepEqual(activity.trails?.map((trail) => trail.hops[0]?.txid), ['cash']);
  assert.deepEqual(activity.cashOutPlnByYear, { '2022': 320000 });

  assert.equal(activity.seizures?.length, 1);
  const seizure = activity.seizures![0]!;
  assert.deepEqual([seizure.txid, seizure.amount, seizure.asset, seizure.counterparty, seizure.valuePln], ['seize', 567.48646001, 'BTC', GOV, 85122969]);
  assert.equal(seizure.counterpartyLabel, 'Rząd USA: środki zajęte po włamaniu');
  assert.equal(seizure.labelSource, `${SOURCE} — sprawdzono 2026-11-21`);
  assert.match(seizure.explanation, /przekazanie środków organowi państwa \(zajęcie\), a NIE spieniężenie/);
  assert.match(seizure.valuation ?? '', /^Szacunek: 567,48646001 BTC × /);
  assert.equal(activity.transfers.find((item) => item.txid === 'seize')?.counterpartyClass, 'institutional');
  assert.ok(activity.limitations.some((item) => /^Wskaźniki zajęcia \(1\) wynikają z PUBLICZNEJ ETYKIETY adresu docelowego/.test(item)));

  // Bez przelewu do organu państwa pola nie ma.
  const plain = (await buildChainActivity(
    { network: 'bitcoin', address: SUBJECT, sourceName: 'źródło testowe', transfers: [move('cash', '2022-03-05T10:00:00Z', 'out', EXCHANGE, 2)], limitations: [] },
    { labels, sanctions: noSanctions, rateSource: rates },
  )) as ChainActivityWithQuestions;
  assert.equal(plain.seizures, undefined);
});

function funding(extra: Partial<FundingSearch> & { nodes?: Record<string, IncomingNode> }) {
  const asked: string[] = [];
  const budget = new RequestBudget(8);
  const { nodes = {}, ...rest } = extra;
  const search: FundingSearch = {
    network: 'bitcoin',
    address: SUBJECT,
    transfers: [],
    txCount: 10,
    historyComplete: true,
    labels,
    sanctions: noSanctions,
    sourceName: 'źródło testowe',
    budget,
    fetchIncoming: async (address) => {
      asked.push(address);
      return nodes[address] ?? { incoming: [] };
    },
    ...rest,
  };
  return { search, asked, budget };
}

test('pochodzenie środków: największe wpływy, zatrzymanie na etykiecie, drugi krok wstecz jako heurystyka', async () => {
  const mid = pad('Middle');
  const quiet = pad('Quiet');
  const busy = pad('Busy');
  const { search, asked } = funding({
    transfers: [
      move('a1', '2022-01-01T10:00:00Z', 'in', EXCHANGE, 50),
      move('a2', '2022-01-05T10:00:00Z', 'in', EXCHANGE, 10),
      move('b1', '2022-01-10T10:00:00Z', 'in', mid, 30),
      move('c1', '2022-01-12T10:00:00Z', 'in', quiet, 8),
      move('d1', '2022-01-13T10:00:00Z', 'in', busy, 2),
      move('out', '2022-02-01T10:00:00Z', 'out', GOV, 100),
    ],
    nodes: {
      // Adres pośredni: wcześniej zasilony głównie z adresu znanego incydentu; późniejszy wpływ się nie liczy.
      [mid]: { incoming: [move('m1', '2022-01-08T10:00:00Z', 'in', HACK, 29), move('m2', '2022-01-09T10:00:00Z', 'in', pad('Other'), 2), move('m3', '2022-03-01T10:00:00Z', 'in', pad('Later'), 500)] },
      [quiet]: { incoming: [] },
      [busy]: { incoming: [], txCount: 9000 },
    },
  });
  const result = await traceFundingSources(search);
  assert.deepEqual(result.sources.map((item) => [item.address, item.amount, item.share, item.hops, item.category ?? item.addressClass, item.via]), [
    [EXCHANGE, 60, 0.6, 1, 'exchange', undefined],
    [HACK, 30, 0.3, 2, 'incident', mid],
    [quiet, 8, 0.08, 1, 'unknown', undefined],
    [busy, 2, 0.02, 1, 'unknown', undefined],
  ]);
  assert.deepEqual(result.sources[0]?.txids, ['a1', 'a2']);
  assert.equal(result.sources[0]?.label, 'Zonda: portfel giełdy');
  assert.match(result.sources[1]?.reason ?? '', /^HEURYSTYKA: adres pośredni .* otrzymał wcześniej 29 BTC z tego adresu — to jego największe źródło wpływów$/);
  assert.equal(result.sources[1]?.labelSource, SOURCE);
  assert.match(result.sources[2]?.reason ?? '', /w pobranej historii nie widać, skąd sam otrzymał środki/);
  assert.match(result.sources[3]?.reason ?? '', /o dużej aktywności \(9000 transakcji\) — prawdopodobnie usługa; dalej nie śledzimy/);
  // O adres z etykietą nie pytamy — tam ścieżka wstecz się kończy.
  assert.deepEqual(asked, [mid, quiet, busy]);
  assert.ok(result.limitations.some((item) => /drugi krok wstecz jest heurystyką/.test(item)));
});

test('pochodzenie środków: lista sankcyjna, limit nadawców, budżet i próg aktywności adresu', async () => {
  const listed = pad('Sanctioned');
  const sanctions = createSanctionsList({ addresses: [{ address: listed, asset: 'XBT', entity: 'PRZYKŁADOWY PODMIOT' }], source: 'OFAC SDN (test)' });
  const many = Array.from({ length: 8 }, (_, index) => move(`s${index}`, '2022-01-10T10:00:00Z', 'in', pad(`Sender${index}`), 10 - index));
  const first = funding({ transfers: [move('x', '2022-01-01T10:00:00Z', 'in', listed, 100), ...many], sanctions });
  first.budget.limit = 2;
  const result = await traceFundingSources(first.search);
  assert.equal(result.sources[0]?.category, 'sanctioned');
  assert.match(result.sources[0]?.label ?? '', /^Lista sankcyjna OFAC \(SDN\): PRZYKŁADOWY PODMIOT/);
  assert.equal(result.sources[0]?.hops, 1);
  assert.equal(first.asked.length, 2, 'budżet dwóch żądań');
  assert.ok(result.limitations.some((item) => /analizę przerwano — wyczerpano budżet 2 żądań na pochodzenie środków/.test(item)));
  assert.ok(result.limitations.some((item) => /zbadano 5 z 9 nadawców \(największe wpływy\) — \d+% wpływów BTC/.test(item)));

  // Adres o setkach transakcji nie jest analizowany wstecz.
  const big = funding({ transfers: many, txCount: 1164 });
  const skipped = await traceFundingSources(big.search);
  assert.deepEqual(skipped.sources, []);
  assert.ok(skipped.limitations.some((item) => /nie analizowano wstecz — adres ma 1164 transakcji \(próg 200\)/.test(item)));
  assert.equal(big.asked.length, 0);

  // Jeden krok: nadawca bez etykiety zostaje źródłem, bez zapytań.
  const oneHop = funding({ transfers: many.slice(0, 2), options: { maxHops: 1 } });
  const direct = await traceFundingSources(oneHop.search);
  assert.deepEqual(direct.sources.map((item) => item.hops), [1, 1]);
  assert.equal(oneHop.asked.length, 0);
});
