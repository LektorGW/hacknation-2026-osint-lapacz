// Migawka bazy: szyfrowanie AES-256-GCM (zapis i odczyt), wczytanie migawki starszego, niezaszyfrowanego
// formatu, bezpieczny zapis (plik tymczasowy, sprawdzenie, kopia .bak) oraz odmowa startu bez klucza.
// Wyłącznie katalog tymczasowy — żadnych danych użytkownika.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { SnapshotError, decodeSnapshot, encryptSnapshot, isEncryptedSnapshot, parseSnapshotKey, readSnapshot, writeSnapshot } from '../src/security-snapshot.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';

const dir = mkdtempSync(join(tmpdir(), 'olcys-migawka-test-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const KEY_HEX = 'a1'.repeat(32);
const key = parseSnapshotKey(KEY_HEX)!;
const plain = gzipSync(Buffer.from('treść bazy — sprawy, analizy, dowody'.repeat(50), 'utf8'));

test('klucz: 64 znaki szesnastkowe albo base64 32 bajtów; pusty = brak szyfrowania; zły = błąd', () => {
  assert.equal(parseSnapshotKey(undefined), undefined);
  assert.equal(parseSnapshotKey('  '), undefined);
  assert.equal(key.length, 32);
  assert.deepEqual(parseSnapshotKey(key.toString('base64')), key);
  assert.throws(() => parseSnapshotKey('za-krotki'), SnapshotError);
  assert.throws(() => parseSnapshotKey('ab'.repeat(31)), SnapshotError);
});

test('szyfrowanie i odszyfrowanie: ta sama treść; zły klucz i uszkodzenie wykrywane', () => {
  const sealed = encryptSnapshot(plain, key);
  assert.ok(isEncryptedSnapshot(sealed));
  assert.ok(!sealed.includes(Buffer.from('treść bazy')), 'szyfrogram nie zawiera jawnej treści');
  assert.deepEqual(decodeSnapshot(sealed, key), { plain, encrypted: true });
  assert.throws(() => decodeSnapshot(sealed, parseSnapshotKey('b2'.repeat(32))), /zły klucz/);
  const broken = Buffer.from(sealed);
  broken[broken.length - 1] ^= 0xff;
  assert.throws(() => decodeSnapshot(broken, key), SnapshotError);
  assert.throws(() => decodeSnapshot(sealed, undefined), /OLCYS_SNAPSHOT_KEY nie jest ustawiony/);
});

test('migawka starszego formatu (niezaszyfrowana) wczytuje się; z kluczem zostaje zaszyfrowana przy zapisie', () => {
  const file = join(dir, 'stara.migawka.tar.gz');
  writeFileSync(file, plain);
  const logs: string[] = [];
  // Bez klucza: odczyt i zapis jawny, jak dotąd.
  assert.deepEqual(readSnapshot(file, undefined)!.plain, plain);
  writeSnapshot(file, plain, undefined);
  assert.ok(!isEncryptedSnapshot(readFileSync(file)));
  // Z kluczem: odczyt działa, zapis szyfruje i informuje w dzienniku.
  const loaded = readSnapshot(file, key, { log: (message) => logs.push(message) })!;
  assert.deepEqual([loaded.plain.equals(plain), loaded.encrypted], [true, false]);
  writeSnapshot(file, loaded.plain, key, { log: (message) => logs.push(message) });
  assert.ok(isEncryptedSnapshot(readFileSync(file)));
  assert.ok(logs.some((line) => line.includes('zostanie zaszyfrowana')));
  assert.ok(logs.some((line) => line.includes('została zaszyfrowana')));
  assert.deepEqual(readSnapshot(file, key)!.plain, plain);
  assert.ok(!existsSync(`${file}.bak`) && !existsSync(`${file}.tmp`), 'po udanym zapisie nie zostają pliki pośrednie');
});

test('zapis atomowy: przerwany zapis nie niszczy migawki; brak pliku głównego = odczyt kopii .bak', () => {
  const file = join(dir, 'atom.migawka.tar.gz');
  writeSnapshot(file, plain, key);
  // Pozostałość przerwanego zapisu (plik .tmp) nie wpływa na odczyt.
  writeFileSync(`${file}.tmp`, Buffer.from('niedokończony zapis'));
  assert.deepEqual(readSnapshot(file, key)!.plain, plain);
  // Awaria między przeniesieniem starej migawki do .bak a podmianą: odczyt z .bak.
  renameSync(file, `${file}.bak`);
  const logs: string[] = [];
  const recovered = readSnapshot(file, key, { log: (message) => logs.push(message) })!;
  assert.deepEqual(recovered.plain, plain);
  assert.match(recovered.source, /\.bak$/);
  assert.ok(logs.some((line) => line.includes('kopię zapasową .bak')));
  // Kolejny zapis odtwarza plik główny.
  writeSnapshot(file, Buffer.from(gzipSync(Buffer.from('nowa treść'))), key);
  assert.ok(existsSync(file));
});

test('baza PGlite z katalogiem: dane przetrwają zamknięcie, migawka jest zaszyfrowana; bez klucza serwer nie startuje', async () => {
  const dataDir = join(dir, 'baza');
  const first = createStorage(await createPgliteDriver(dataDir, { snapshotKey: key, log: () => {} }));
  await first.migrate();
  const created = await first.createCase('Sprawa poufna', { identifiers: [{ type: 'nick', value: 'poufny_nick' }] }, '2026-11-21T10:00:00.000Z');
  assert.equal(first.encryptedAtRest(), true);
  await first.close();
  const snapshot = readFileSync(`${dataDir}.migawka.tar.gz`);
  assert.ok(isEncryptedSnapshot(snapshot));

  const second = createStorage(await createPgliteDriver(dataDir, { snapshotKey: key, log: () => {} }));
  await second.migrate();
  assert.equal((await second.getCase(created.id))?.name, 'Sprawa poufna');
  await second.close();

  const before = readFileSync(`${dataDir}.migawka.tar.gz`);
  await assert.rejects(createPgliteDriver(dataDir, { log: () => {} }), /OLCYS_SNAPSHOT_KEY nie jest ustawiony/);
  await assert.rejects(createPgliteDriver(dataDir, { snapshotKey: parseSnapshotKey('c3'.repeat(32)), log: () => {} }), /zły klucz/);
  // Nieudane próby nie nadpisały migawki.
  assert.deepEqual(readFileSync(`${dataDir}.migawka.tar.gz`), before);
});
