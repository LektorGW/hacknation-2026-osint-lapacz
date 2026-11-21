// Cykl życia sprawy: zamknięcie (tylko do odczytu), przywrócenie, archiwum z manifestem, usunięcie
// blokowane powiązaniami, usunięcie ze wszystkich tabel ze śladem bez danych osobowych oraz dziennik audytu.
// Wyłącznie baza w pamięci — żadnych danych na dysku.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { readZipEntries, verifyArchive } from '../src/archive.ts';
import type { ArchiveManifest } from '../src/archive.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import type { SqlDriver, Storage } from '../src/storage.ts';
import { BTC_A, BTC_B, BTC_EXCHANGE, ETH_A, FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

let app: FastifyInstance;
let storage: Storage;
let driver: SqlDriver;

// Sprawy alfa, beta i delta publikują ten sam adres BTC_B (powiązanie), gamma ma własny adres ETH_A.
const PUBLISHED: Record<string, string> = { alfa_nick: BTC_B, beta_nick: BTC_B, delta_nick: BTC_B, gamma_nick: ETH_A };

before(async () => {
  driver = await createPgliteDriver();
  storage = createStorage(driver);
  await storage.migrate();
  const github = fakeConnector('github', 'github.com', ['nick'], (identifier) => [
    {
      url: `https://github.com/${identifier.value}`,
      text: `Wpłaty: ${PUBLISHED[identifier.value] ?? BTC_A}, giełda ${BTC_EXCHANGE}`,
      author: identifier.value,
      publishedAt: '2025-01-01T00:00:00.000Z',
    },
  ]);
  app = await buildApp({ storage, connectors: [github], chainProviders: [fakeProvider({ [BTC_EXCHANGE]: 'exchange' })], now: FIXED_NOW });
  app.addHook('onClose', () => storage.close());
});
after(() => app.close());

const json = (method: 'POST' | 'DELETE' | 'GET', url: string, payload?: unknown) => app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });

async function caseWithRun(name: string, nick: string): Promise<string> {
  const created = await json('POST', '/api/cases', { name, identifiers: [{ type: 'nick', value: nick }] });
  assert.equal(created.statusCode, 201, created.body);
  const id = created.json().id as string;
  const run = await json('POST', `/api/cases/${id}/runs`, {});
  assert.equal(run.statusCode, 201, run.body);
  return id;
}

test('zamknięcie czyni sprawę tylko do odczytu, przywrócenie zdejmuje blokadę', async () => {
  const id = await caseWithRun('Sprawa Alfa', 'alfa_nick');
  assert.equal((await json('GET', `/api/cases/${id}`)).json().status, 'open');

  assert.equal((await json('POST', `/api/cases/${id}/close`, { reason: '  ' })).statusCode, 400);
  const closed = await json('POST', `/api/cases/${id}/close`, { reason: 'Postępowanie umorzone' });
  assert.equal(closed.statusCode, 200, closed.body);
  assert.deepEqual([closed.json().status, closed.json().closedReason, closed.json().closedAt], ['closed', 'Postępowanie umorzone', FIXED_NOW().toISOString()]);
  assert.equal((await json('POST', `/api/cases/${id}/close`, { reason: 'drugi raz' })).statusCode, 409);

  // Każda zmiana zamkniętej sprawy: 409 z komunikatem po polsku.
  for (const [method, url, payload] of [
    ['POST', `/api/cases/${id}/runs`, {}],
    ['POST', `/api/cases/${id}/decisions`, { target: 'address', key: `bitcoin:${BTC_B}`, decision: 'confirmed' }],
    ['POST', `/api/cases/${id}/identifiers`, { identifiers: [{ type: 'nick', value: 'inny' }] }],
    ['POST', `/api/cases/${id}/network/expand`, { nodeId: 'x' }],
    ['POST', `/api/cases/${id}/schedule`, { everyMinutes: 60 }],
  ] as const) {
    const response = await json(method, url, payload);
    assert.equal(response.statusCode, 409, `${method} ${url}: ${response.body}`);
    assert.match(response.json().error, /tylko do odczytu/);
  }
  // Odczyt działa jak dotąd.
  assert.equal((await json('GET', `/api/cases/${id}/dossier`)).statusCode, 200);

  const reopened = await json('POST', `/api/cases/${id}/reopen`);
  assert.equal(reopened.statusCode, 200);
  assert.equal(reopened.json().status, 'open');
  assert.equal(reopened.json().closedAt, undefined);
  const decision = await json('POST', `/api/cases/${id}/decisions`, { target: 'address', key: `bitcoin:${BTC_B}`, decision: 'confirmed' });
  assert.equal(decision.statusCode, 201, decision.body);
});

test('archiwum: manifest z SHA-256 każdego pliku, kopie dowodów zgodne ze skrótem, w bazie tylko skrót', async () => {
  const id = await caseWithRun('Sprawa Archiwum', 'gamma_nick');
  assert.equal((await json('POST', `/api/cases/${id}/archive`)).statusCode, 409, 'otwartej sprawy nie archiwizujemy');
  await json('POST', `/api/cases/${id}/close`, { reason: 'Koniec czynności' });

  const response = await json('POST', `/api/cases/${id}/archive`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['content-type'], 'application/zip');
  const zip = response.rawPayload;
  const digest = createHash('sha256').update(zip).digest('hex');
  assert.equal(response.headers['x-olcys-archive-sha256'], digest);
  assert.deepEqual(verifyArchive(zip), []);

  const entries = readZipEntries(zip);
  const manifest = JSON.parse(entries.get('MANIFEST.json')!.toString('utf8')) as ArchiveManifest;
  assert.equal(manifest.case.id, id);
  assert.equal(manifest.evidenceMismatches, 0);
  assert.ok(manifest.rulesSha256.match(/^[0-9a-f]{64}$/));
  for (const name of ['sprawa.json', 'pakiet.zip', 'raport.html', 'raport.json', 'decyzje.json', 'odpowiedzi-uslug.json', 'rozwiniecia-sieci.json', 'dziennik-audytu.json']) {
    assert.ok(entries.has(name), `brak ${name}`);
  }
  const evidence = [...entries.keys()].filter((name) => name.startsWith('dowody/') && name.endsWith('.txt'));
  assert.ok(evidence.length > 0, 'brak kopii dowodów');
  for (const name of evidence) {
    // Nazwa pliku = SHA-256 treści, z której policzono skrót śladu.
    assert.equal(createHash('sha256').update(entries.get(name)!).digest('hex'), name.split('/').at(-1)!.replace('.txt', ''));
  }
  // Pakiet eksportu wewnątrz archiwum zawiera pełną analizę (wewnętrzne żądanie przechodzi przez zabezpieczenia).
  assert.ok(readZipEntries(entries.get('pakiet.zip')!).has('analiza.json'));

  const after = (await json('GET', `/api/cases/${id}`)).json();
  assert.deepEqual([after.status, after.archiveSha256, after.archive.bytes], ['archived', digest, zip.length]);
  assert.equal(after.archive.storedAs, undefined, 'bez OLCYS_ARCHIVE_DIR plik nie jest zapisywany na dysku');

  const latest = await json('GET', `/api/cases/${id}/archive/latest`);
  assert.equal(latest.statusCode, 200);
  assert.equal(createHash('sha256').update(latest.rawPayload).digest('hex'), digest);
});

test('usunięcie: potwierdzenie nazwą, tylko zamknięta sprawa, blokada przez powiązanie z otwartą sprawą', async () => {
  // Sprawa Alfa z pierwszego testu jest wtedy zamknięta — blokuje tylko Beta.
  await json('POST', `/api/cases/${(await storage.listCases()).find((item) => item.name === 'Sprawa Alfa')!.id}/close`, { reason: 'koniec' });
  const alfa = await caseWithRun('Sprawa Delta', 'delta_nick');
  const beta = await caseWithRun('Sprawa Beta', 'beta_nick');

  assert.equal((await json('DELETE', `/api/cases/${alfa}`, { confirm: 'Sprawa Delta' })).statusCode, 409, 'otwartej nie wolno usunąć');
  await json('POST', `/api/cases/${alfa}/close`, { reason: 'Zakończona' });
  assert.equal((await json('DELETE', `/api/cases/${alfa}`, { confirm: 'zła nazwa' })).statusCode, 400);
  assert.equal((await json('DELETE', `/api/cases/${alfa}`)).statusCode, 400, 'bez potwierdzenia');

  const links = (await json('GET', `/api/cases/${alfa}/links`)).json();
  assert.equal(links.blocking, true);
  assert.equal(links.deletable, false);
  const toBeta = links.links.find((link: { caseId: string }) => link.caseId === beta);
  assert.ok(toBeta, 'powiązanie z drugą sprawą');
  assert.equal(toBeta.blocking, true);
  assert.ok(toBeta.reasons.some((reason: { kind: string; values: string[] }) => reason.kind === 'adres' && reason.values.includes(BTC_B)));

  const blocked = await json('DELETE', `/api/cases/${alfa}`, { confirm: 'Sprawa Delta' });
  assert.equal(blocked.statusCode, 409);
  assert.match(blocked.json().error, /Nie można usunąć — sprawa jest powiązana z: „Sprawa Beta”/);
  assert.ok(blocked.json().links.some((link: { caseId: string }) => link.caseId === beta));
  assert.ok(await storage.getCase(alfa), 'sprawa nadal istnieje');

  // Po zamknięciu drugiej sprawy powiązanie przestaje blokować.
  await json('POST', `/api/cases/${beta}/close`, { reason: 'Zakończona' });
  const nowLinks = (await json('GET', `/api/cases/${alfa}/links`)).json();
  assert.deepEqual([nowLinks.blocking, nowLinks.deletable], [false, true]);
  assert.equal((await json('DELETE', `/api/cases/${alfa}`, { confirm: 'Sprawa Delta' })).statusCode, 200);
});

test('usunięcie niepowiązanej sprawy kasuje jej wiersze we wszystkich tabelach; ślad bez danych osobowych', async () => {
  const id = await caseWithRun('Jan Kowalski — sprawa Omega', 'gamma_nick');
  // Materiał w każdej tabeli sprawy: decyzja, odpowiedź usługi, rozwinięcie sieci, obserwacja.
  assert.equal((await json('POST', `/api/cases/${id}/decisions`, { target: 'address', key: `ethereum:${ETH_A}`, decision: 'confirmed', note: 'Jan Kowalski' })).statusCode, 201);
  const replyBody = { serviceName: 'Giełda Testowa', reference: 'GT/1', receivedAt: '2026-11-20T12:00:00.000Z', payload: { note: 'odpowiedź' }, force: true };
  const reply = await json('POST', `/api/cases/${id}/service-replies`, replyBody);
  assert.equal(reply.statusCode, 201, reply.body);
  const runId = (await storage.getCase(id))!.runs[0]!.id;
  await storage.addNetworkExpansion({
    id: 'rozw-1', caseId: id, nodeId: 'n', relations: [], depth: 1, budget: { limit: 1, used: 0 }, startedAt: FIXED_NOW().toISOString(), finishedAt: FIXED_NOW().toISOString(),
    requestedBy: 'analityk', results: { nodes: [], edges: [], runs: [] }, stops: [], sourceErrors: [], runId,
  });
  assert.equal((await json('POST', `/api/cases/${id}/schedule`, { everyMinutes: 60 })).statusCode, 200);
  assert.ok((await storage.listDocuments(runId)).length > 0, 'kopie treści przed usunięciem');

  await json('POST', `/api/cases/${id}/close`, { reason: 'Jan Kowalski — umorzenie' });
  await json('POST', `/api/cases/${id}/archive`);
  const archived = (await storage.getCase(id))!;
  const deleted = await json('DELETE', `/api/cases/${id}`, { confirm: 'Jan Kowalski — sprawa Omega' });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const tombstone = deleted.json().tombstone;
  assert.equal(tombstone.archiveSha256, archived.archiveSha256);
  assert.ok(tombstone.counts.documents > 0 && tombstone.counts.decisions === 1 && tombstone.counts.service_replies === 1 && tombstone.counts.network_expansions === 1);

  // Żadna tabela z kolumną case_id / run_id nie ma już wierszy tej sprawy (poza dziennikiem audytu).
  const tables = await driver.query("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name IN ('case_id', 'run_id')");
  for (const row of tables) {
    if (row.table_name === 'audit_log') continue;
    const value = row.column_name === 'case_id' ? id : runId;
    const [count] = await driver.query(`SELECT COUNT(*) AS n FROM "${String(row.table_name)}" WHERE ${String(row.column_name)} = $1`, [value]);
    assert.equal(Number(count!.n), 0, `${String(row.table_name)} nadal ma wiersze sprawy`);
  }
  assert.equal(await storage.getCase(id), null);
  assert.equal((await json('GET', `/api/cases/${id}`)).statusCode, 404);
  const [watch] = await driver.query("SELECT data FROM monitor_config WHERE id = 'config:case-watch'");
  assert.ok(!JSON.stringify(watch?.data ?? {}).includes(id), 'obserwacja usunięta');

  // Ślad: identyfikator techniczny, czas, skrót archiwum, liczby — bez nazwy, nicka i treści.
  const stored = JSON.stringify(await storage.getTombstone(id));
  for (const personal of ['Kowalski', 'gamma_nick', 'Omega', ETH_A, 'umorzenie']) assert.ok(!stored.includes(personal), `ślad zawiera „${personal}”`);

  // Dziennik audytu zostaje i nie zawiera danych osobowych.
  const audit = (await json('GET', `/api/audit?caseId=${id}`)).json().entries as { action: string }[];
  const actions = audit.map((entry) => entry.action);
  for (const action of ['decyzja.dodana', 'odpowiedz-uslugi.dodana', 'sprawa.zamknieta', 'sprawa.zarchiwizowana', 'sprawa.usunieta']) assert.ok(actions.includes(action), `brak wpisu ${action}`);
  const auditText = JSON.stringify(audit);
  for (const personal of ['Kowalski', 'gamma_nick', 'Omega', ETH_A, 'umorzenie']) assert.ok(!auditText.includes(personal), `audyt zawiera „${personal}”`);
});

test('audyt: wycofania, pobrania eksportów i raportów; wewnętrzne żądania nie dublują wpisów', async () => {
  const id = await caseWithRun('Sprawa Audyt', 'audyt_nick');
  const decision = (await json('POST', `/api/cases/${id}/decisions`, { target: 'address', key: `bitcoin:${BTC_A}`, decision: 'rejected' })).json();
  assert.equal((await json('DELETE', `/api/cases/${id}/decisions/${decision.id}`)).statusCode, 204);
  assert.equal((await json('GET', `/api/cases/${id}/export/pakiet.zip`)).statusCode, 200);
  const runId = (await storage.getCase(id))!.runs[0]!.id;
  assert.equal((await json('GET', `/api/runs/${runId}/report.html`)).statusCode, 200);

  const entries = (await json('GET', `/api/audit?caseId=${id}`)).json().entries as { action: string; target?: string; details: Record<string, unknown>; actor: string }[];
  assert.ok(entries.every((entry) => entry.actor === 'analityk'));
  assert.deepEqual(
    entries.map((entry) => entry.action),
    ['decyzja.dodana', 'decyzja.wycofana', 'eksport.pobrany', 'raport.pobrany'],
    'pakiet.zip pobiera wewnętrznie raport JSON — to nie jest osobne pobranie',
  );
  assert.equal(entries[1]!.target, decision.id);
  assert.equal(entries[2]!.details.plik, 'pakiet.zip');
});
