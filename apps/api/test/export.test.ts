import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { SubjectQuery } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { runAnalysis } from '../src/analysis.ts';
import { CSV_FILES, buildCaseExport, buildPackage, rulesSha256, writeZip } from '../src/export.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { BTC_A, BTC_EXCHANGE, FIXED_NOW, cashOut, chainWith, dossierOf, fakeConnector, fakeProvider, transfer } from './helpers.ts';

/** Odczyt archiwum ZIP w teście: katalog centralny, rozpakowanie i sprawdzenie CRC-32 każdego wpisu. */
function unzip(buffer: Buffer): Map<string, Buffer> {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'brak końca katalogu centralnego');
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    const method = buffer.readUInt16LE(pointer + 10);
    const checksum = buffer.readUInt32LE(pointer + 16);
    const compressed = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const local = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + buffer.readUInt16LE(pointer + 30) + buffer.readUInt16LE(pointer + 32);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    assert.equal(method, 8);
    const data = inflateRawSync(buffer.subarray(start, start + compressed));
    assert.equal(data.length, size, `rozmiar ${name}`);
    assert.equal(crc32(data), checksum, `CRC-32 ${name}`);
    files.set(name, data);
  }
  return files;
}

/** Wiersze CSV z separatorem „;” (bez obsługi cudzysłowów wielowierszowych — wystarcza w testach). */
const lines = (csv: string) => csv.replace(/^﻿/, '').trimEnd().split('\r\n');
const cells = (line: string) => line.split(';');

const query: SubjectQuery = { identifiers: [{ type: 'nick', value: 'krypto_janek' }] };

const scenario = async () => {
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], () => [
    { url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', title: '=HYPERLINK("http://zly.example")', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'krypto_janek', displayName: 'Jan Kowalski' } },
  ]);
  const deposit = transfer(1, { counterparty: BTC_EXCHANGE, counterpartyLabel: 'Giełda Testowa', counterpartyClass: 'exchange', time: '2025-03-14T10:22:00.000Z', amount: 0.4 });
  const chain = chainWith({ [BTC_A]: { transfers: [deposit], cashOuts: [cashOut(deposit, 132000.5)], label: 'Portfel prywatny' } });
  return dossierOf(await runAnalysis({ query, connectors: [gitpub], chainProviders: [chain] }), query);
};

const exportOf = async (connectors = ['gitpub']) =>
  buildCaseExport(await scenario(), {
    toolVersion: '9.9.9',
    generatedAt: '2026-11-21T10:00:00.000Z',
    caseName: 'Jan K.',
    run: { connectors },
    rules: { wagi: [1, 2] },
    decisions: [
      { id: 'd1', caseId: 'sprawa-1', target: 'address', key: `bitcoin:${BTC_A}`, decision: 'confirmed', note: '=1+1', decidedAt: '2026-11-21T09:30:00.000Z', author: 'analityk' },
      { id: 'd2', caseId: 'sprawa-1', target: 'profile', key: 'gitpub.example|krypto_janek', decision: 'rejected', decidedAt: '2026-11-21T09:00:00.000Z', author: 'analityk', withdrawnAt: '2026-11-21T09:10:00.000Z', withdrawnBy: 'analityk' },
    ],
  });

test('eksport CSV: BOM, separator „;”, przecinek dziesiętny, kolumny adresów i transakcji', async () => {
  const { csv } = await exportOf();
  for (const name of CSV_FILES) {
    assert.ok(csv[name].startsWith('﻿'), `${name} bez BOM`);
    assert.ok(csv[name].endsWith('\r\n'));
  }
  const addresses = lines(csv['adresy.csv']);
  assert.equal(cells(addresses[0]!)[0], 'Adres');
  assert.ok(cells(addresses[0]!).includes('Wskaźnik Pewności (0–100)'));
  const row = cells(addresses.find((line) => line.startsWith(BTC_A))!);
  assert.equal(row[1], 'Bitcoin');
  assert.equal(row[2], 'zweryfikowana');
  assert.match(row[3]!, /^\d+$/);
  assert.equal(row[9], '1');
  assert.equal(row[11], '2026-11-21 09:00:00');
  assert.equal(row[15], '132000,5');
  assert.equal(row[16], 'Portfel prywatny');

  const tx = cells(lines(csv['transakcje.csv']).find((line) => line.includes(BTC_EXCHANGE))!);
  assert.deepEqual(tx.slice(3, 13), ['2025-03-14 10:22:00', 'wychodzący', BTC_EXCHANGE, 'Giełda Testowa', 'atrapa etykiet', 'giełda lub portfel powierniczy', 'BTC', '0,4', '132000,5', 'Wpłata na giełdę']);
});

test('eksport CSV: ochrona przed formułami w arkuszu i poprawne cudzysłowy', async () => {
  const { csv } = await exportOf();
  // Tytuł publikacji z formułą trafia do arkusza jako tekst: apostrof na początku, cudzysłowy podwojone.
  assert.ok(csv['zrodla.csv'].includes(`"'=HYPERLINK(""http://zly.example"")"`));
  assert.ok(!/(^|;)=/m.test(csv['zrodla.csv'].replace(/^﻿/, '')));
  // Notatka decyzji „=1+1” też jest neutralizowana.
  assert.ok(csv['decyzje.csv'].includes(";'=1+1;"));
  const source = lines(csv['zrodla.csv'])[1]!;
  assert.ok(source.includes('0'.repeat(64)) || /[0-9a-f]{64}/.test(source), 'brak skrótu SHA-256 treści');
});

test('decyzje.csv zawiera także decyzje wycofane; relacje.csv ma status po polsku', async () => {
  const { csv } = await exportOf();
  const decisions = lines(csv['decyzje.csv']);
  assert.equal(decisions.length, 3);
  assert.deepEqual(cells(decisions[1]!).slice(1, 4), ['adres', `bitcoin:${BTC_A}`, 'potwierdzono']);
  assert.ok(decisions[2]!.endsWith(';2026-11-21 09:10:00;analityk;nie'));
  assert.ok(decisions[1]!.endsWith(';;;tak'));

  const relations = lines(csv['relacje.csv']);
  assert.equal(cells(relations[0]!)[4], 'Status');
  const statuses = new Set(relations.slice(1).map((line) => cells(line)[4]));
  assert.ok(statuses.has('fakt źródłowy'));
  assert.ok([...statuses].every((status) => ['fakt źródłowy', 'wynik obliczeń', 'hipoteza', 'potwierdzone przez analityka', 'odrzucone'].includes(status!)));
});

test('teczka.json: nagłówek z wersją reguł, trybem danych i flagą danych syntetycznych', async () => {
  const live = await exportOf();
  const parsed = JSON.parse(live.json);
  assert.equal(parsed.meta.case.name, 'Jan K.');
  assert.equal(parsed.meta.run.id, 'run-test');
  assert.equal(parsed.meta.tool.version, '9.9.9');
  assert.equal(parsed.meta.rules.sha256, rulesSha256({ wagi: [1, 2] }));
  assert.match(parsed.meta.rules.sha256, /^[0-9a-f]{64}$/);
  assert.equal(parsed.meta.dataMode.mode, 'live');
  assert.equal(parsed.meta.syntheticData.flag, 'nie');
  assert.equal(parsed.dossier.findings[0].address, BTC_A);

  const sandbox = JSON.parse((await exportOf(['sandbox-forum'])).json);
  // Łącznik atrapy „gitpub” w śladach to źródło niesyntetyczne — dane częściowo syntetyczne.
  assert.equal(sandbox.meta.syntheticData.flag, 'częściowo');
  assert.deepEqual(sandbox.meta.syntheticData.sources, ['sandbox-forum']);
});

test('pakiet ZIP: poprawne archiwum, sumy CRC-32 i SHA-256 w CZYTAJ-MNIE.txt', async () => {
  const content = await exportOf();
  const files = unzip(buildPackage(content, '{"run":1}'));
  assert.deepEqual([...files.keys()], [...CSV_FILES, 'teczka.json', 'analiza.json', 'CZYTAJ-MNIE.txt']);
  assert.equal(files.get('adresy.csv')!.toString('utf8'), content.csv['adresy.csv']);
  const readme = files.get('CZYTAJ-MNIE.txt')!.toString('utf8');
  for (const name of [...CSV_FILES, 'teczka.json', 'analiza.json']) {
    const hash = createHash('sha256').update(files.get(name)!).digest('hex');
    assert.ok(readme.includes(`${hash}  ${name}`), `brak sumy ${name}`);
  }
  assert.ok(readme.includes('separator „;”'));
  // Pusty zestaw też daje poprawne archiwum.
  assert.equal(unzip(writeZip([], new Date('2026-11-21T10:00:00Z'))).size, 0);
});

// ---------- HTTP ----------

let app: FastifyInstance;

before(async () => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const gitpub = fakeConnector('gitpub', 'gitpub.example', ['nick'], (identifier) =>
    identifier.value === 'krypto_janek' ? [{ url: 'https://gitpub.example/krypto_janek', author: 'krypto_janek', text: `Wsparcie: ${BTC_A}`, profile: { handle: 'krypto_janek' } }] : [],
  );
  app = await buildApp({ storage, connectors: [gitpub], chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })], now: FIXED_NOW });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const post = (url: string, payload?: unknown) => app.inject({ method: 'POST', url, payload: payload as object });

test('HTTP: wszystkie pliki eksportu sprawy, z decyzją wycofaną i pakietem ZIP', async () => {
  const created = (await post('/api/cases', { name: 'Jan Kowalski', identifiers: [{ type: 'nick', value: 'krypto_janek' }] })).json();
  const run = (await post(`/api/cases/${created.id}/runs`)).json();
  const decision = (await post(`/api/cases/${created.id}/decisions`, { target: 'address', key: `bitcoin:${BTC_A}`, decision: 'rejected', note: 'pomyłka' })).json();
  await app.inject({ method: 'DELETE', url: `/api/cases/${created.id}/decisions/${decision.id}` });

  for (const name of CSV_FILES) {
    const response = await app.inject(`/api/cases/${created.id}/export/${name}`);
    assert.equal(response.statusCode, 200, name);
    assert.match(String(response.headers['content-type']), /^text\/csv; charset=utf-8/);
    assert.match(String(response.headers['content-disposition']), new RegExp(`attachment; filename="Jan-Kowalski-${name.replace('.', '\\.')}"`));
    assert.ok(response.body.startsWith('﻿'));
  }
  const decisions = lines((await app.inject(`/api/cases/${created.id}/export/decyzje.csv`)).body);
  assert.equal(decisions.length, 2);
  assert.ok(decisions[1]!.includes(';pomyłka;') && decisions[1]!.endsWith(';analityk;nie'));

  const json = (await app.inject(`/api/cases/${created.id}/export/teczka.json`)).json();
  assert.equal(json.meta.case.id, created.id);
  assert.equal(json.meta.run.id, run.id);
  assert.deepEqual(json.meta.run.connectors, ['gitpub', 'corpus']);
  assert.equal(json.meta.generatedAt, FIXED_NOW().toISOString());
  assert.equal(json.dossier.runId, run.id);

  const zip = await app.inject(`/api/cases/${created.id}/export/pakiet.zip`);
  assert.equal(zip.statusCode, 200);
  assert.equal(zip.headers['content-type'], 'application/zip');
  const files = unzip(zip.rawPayload);
  assert.equal(JSON.parse(files.get('analiza.json')!.toString('utf8')).run.id, run.id);
  assert.equal(files.get('decyzje.csv')!.toString('utf8'), (await app.inject(`/api/cases/${created.id}/export/decyzje.csv`)).body);
});

test('HTTP: sprawa bez analizy, nieznany plik i obca analiza', async () => {
  const created = (await post('/api/cases', { name: 'Pusta', identifiers: [{ type: 'nick', value: 'nikt' }] })).json();
  assert.equal((await app.inject(`/api/cases/${created.id}/export/adresy.csv`)).statusCode, 404);
  assert.equal((await app.inject(`/api/cases/${created.id}/export/hasla.txt`)).statusCode, 400);
  assert.equal((await app.inject(`/api/cases/${created.id}/export/adresy.csv?run=obca`)).statusCode, 404);
  assert.equal((await app.inject('/api/cases/nie-ma/export/adresy.csv')).statusCode, 404);
});
