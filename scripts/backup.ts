// Kopia zapasowa i przywracanie bazy OŁCyŚ: `pnpm run backup`.
//
//   node scripts/backup.ts [--config <plik>] [--dir <katalog>] [--keep <n>] [--wait-fresh]
//   node scripts/backup.ts restore <plik-kopii> [--config <plik>]
//
// Wbudowana baza PGlite: trwałym zapisem jest migawka <OLCYS_DATA_DIR>.migawka.tar.gz, zapisywana przez API co minutę
// i przy zamknięciu, zawsze przez plik tymczasowy i zmianę nazwy — skopiowanie jej w dowolnej chwili daje spójną kopię
// (najwyżej sprzed minuty). --wait-fresh czeka na następny zapis migawki (do 75 s), żeby kopia była możliwie świeża.
// Działa także, gdy API jest uruchomione. Kopia jest sprawdzana (rozpakowanie gzip w locie).
//
// PostgreSQL (DATABASE_URL): kopia narzędziem pg_dump (format własny, przywracanie: pg_restore). Hasło trafia do
// pg_dump przez zmienną PGPASSWORD, nie w wierszu poleceń.
//
// Rotacja: zostaje --keep najnowszych kopii (domyślnie OLCYS_BACKUP_KEEP albo 7).
// Plik .env NIE jest kopiowany (zawiera sekrety) — przechowuj go osobno; bez OLCYS_SNAPSHOT_KEY szyfrowanej migawki
// nie da się odczytać.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { decodeSnapshot, isEncryptedSnapshot, parseSnapshotKey } from '../apps/api/src/security-snapshot.ts';
import { ROOT, bold, dim, flagString, green, loadEnv, parseArgs, red, yellow } from './lib/env.ts';

const args = parseArgs(process.argv.slice(2), ['wait-fresh']);
let loaded;
try {
  loaded = loadEnv(flagString(args, 'config'));
} catch (error) {
  console.error(red((error as Error).message));
  process.exit(2);
}
const env = loaded.env;
const fail = (text: string): never => {
  console.error(red(text));
  process.exit(1);
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const dataDir = resolve(env.OLCYS_DATA_DIR?.trim() || join(ROOT, 'apps', 'api', 'data', 'pg'));
const backupDir = resolve(flagString(args, 'dir') ?? env.OLCYS_BACKUP_DIR?.trim() ?? join(dirname(dataDir), 'kopie'));
const keep = Number(flagString(args, 'keep') ?? env.OLCYS_BACKUP_KEEP ?? 7);
if (!Number.isInteger(keep) || keep < 1) fail('--keep: podaj liczbę całkowitą ≥ 1.');

/** Plik migawki (szyfrowana ma tę samą nazwę i znacznik na początku); `.bak` istnieje tylko w trakcie zapisu. */
const snapshotFile = `${dataDir}.migawka.tar.gz`;
function snapshotFiles(): string[] {
  return [snapshotFile, `${snapshotFile}.bak`].filter((file) => existsSync(file) && statSync(file).isFile());
}

/** Sprawdza kopię: odszyfrowanie (gdy szyfrowana, kluczem z konfiguracji) i rozpakowanie gzip. */
async function verifySnapshot(file: string): Promise<{ encrypted: boolean; bytes: number }> {
  const data = readFileSync(file);
  const encrypted = isEncryptedSnapshot(data);
  const key = parseSnapshotKey(env.OLCYS_SNAPSHOT_KEY);
  if (encrypted && !key) return { encrypted, bytes: -1 };
  const { plain } = decodeSnapshot(data, key);
  let bytes = 0;
  await pipeline(
    Readable.from([plain]),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        bytes += chunk.length;
        done();
      },
    }),
  );
  return { encrypted, bytes };
}

function lockedBy(): number | null {
  try {
    const lock = JSON.parse(readFileSync(`${dataDir}.blokada`, 'utf8')) as { pid: number };
    process.kill(lock.pid, 0);
    return lock.pid;
  } catch {
    return null;
  }
}

function rotate(prefix: string) {
  const copies = readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix))
    // Kolejność po nazwie (zawiera datę i godzinę) — kopia pliku zachowuje czas modyfikacji źródła.
    .sort()
    .reverse()
    .map((name) => join(backupDir, name));
  for (const old of copies.slice(keep)) {
    rmSync(old, { force: true });
    console.log(dim(`  Usunięto starą kopię: ${basename(old)}`));
  }
}

// ---------- Przywracanie ----------
if (args.positional[0] === 'restore') {
  const source = args.positional[1];
  if (!source) fail('Podaj plik kopii: node scripts/backup.ts restore <plik>');
  const file = resolve(source!);
  if (!existsSync(file)) fail(`Nie ma pliku ${file}.`);
  if (env.DATABASE_URL?.trim()) {
    console.log(`PostgreSQL — przywracanie narzędziem pg_restore (najpierw zatrzymaj API):
  pg_restore --clean --if-exists --no-owner --dbname "<DATABASE_URL>" "${file}"`);
    process.exit(0);
  }
  const pid = lockedBy();
  if (pid) fail(`API działa (PID ${pid}) i korzysta z tej bazy. Zatrzymaj je (Ctrl+C albo POST /api/admin/shutdown) i powtórz.`);
  let checked: { encrypted: boolean; bytes: number };
  try {
    checked = await verifySnapshot(file);
  } catch (error) {
    fail(`Plik kopii nie daje się odczytać (${(error as Error).message}) — nie przywracam.`);
  }
  if (checked!.bytes < 0) fail('Kopia jest zaszyfrowana, a OLCYS_SNAPSHOT_KEY nie jest ustawiony — ustaw klucz, którym ją zapisano.');
  const target = snapshotFile;
  mkdirSync(dirname(target), { recursive: true });
  for (const current of snapshotFiles()) {
    const aside = `${current}.przed-przywroceniem-${stamp()}`;
    renameSync(current, aside);
    console.log(`  Dotychczasowa migawka odłożona: ${aside}`);
  }
  copyFileSync(file, target);
  console.log(green(`Przywrócono: ${target}`));
  console.log('Uruchom API (pnpm start) — baza zostanie wczytana z przywróconej migawki.');
  process.exit(0);
}

// ---------- Kopia ----------
mkdirSync(backupDir, { recursive: true });
console.log(bold('OŁCyŚ — kopia zapasowa'));

if (env.DATABASE_URL?.trim()) {
  const url = new URL(env.DATABASE_URL.trim());
  const password = decodeURIComponent(url.password);
  url.password = '';
  const target = join(backupDir, `olcys-pg-${stamp()}.dump`);
  const probe = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    fail(`Nie znaleziono pg_dump. Zainstaluj klienta PostgreSQL (np. apt install postgresql-client) albo wykonaj kopię na serwerze bazy:
  pg_dump --format=custom --file olcys.dump "<DATABASE_URL>"
W Dockerze (profil postgres): docker compose exec postgres pg_dump -U olcys --format=custom olcys > olcys.dump`);
  }
  console.log(dim(`  pg_dump → ${target}`));
  const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--file', target, '--dbname', url.toString()], {
    stdio: 'inherit',
    env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) },
  });
  if (result.status !== 0) fail('pg_dump zakończył się błędem.');
  console.log(green(`Kopia: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`));
  rotate('olcys-pg-');
  process.exit(0);
}

let snapshots = snapshotFiles();
if (snapshots.length === 0) fail(`Brak migawki bazy obok ${dataDir} — API jeszcze nie zapisało danych albo OLCYS_DATA_DIR wskazuje inny katalog.`);
let snapshot = snapshots.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]!;
const running = lockedBy();

if (args.flags.has('wait-fresh') && running) {
  const before = statSync(snapshot).mtimeMs;
  console.log(dim('  Czekam na następny zapis migawki (do 75 s)…'));
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 1000));
    snapshots = snapshotFiles();
    const newest = snapshots.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (newest && statSync(newest).mtimeMs > before) {
      snapshot = newest;
      await new Promise((done) => setTimeout(done, 500));
      break;
    }
  }
}

const age = Math.round((Date.now() - statSync(snapshot).mtimeMs) / 1000);
const target = join(backupDir, `olcys-migawka-${stamp()}.tar.gz`);
copyFileSync(snapshot, target);
let encrypted = false;
try {
  const checked = await verifySnapshot(target);
  encrypted = checked.encrypted;
  console.log(
    dim(checked.bytes < 0 ? '  Kopia szyfrowana — bez OLCYS_SNAPSHOT_KEY w konfiguracji sprawdzono tylko nagłówek.' : `  Sprawdzono: kopia ${encrypted ? 'odszyfrowuje się i ' : ''}rozpakowuje poprawnie (${(checked.bytes / 1024 / 1024).toFixed(0)} MB danych).`),
  );
} catch (error) {
  rmSync(target, { force: true });
  fail(`Skopiowana migawka nie daje się odczytać (${(error as Error).message}) — spróbuj ponownie za minutę.`);
}
console.log(green(`Kopia: ${target} (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB)`));
console.log(dim(`  Stan bazy sprzed ${age} s${running ? ` (API działa, PID ${running}; migawka zapisywana co minutę)` : ' (API zatrzymane — kopia pełna)'}.`));
if (encrypted) console.log(yellow('  Migawka jest szyfrowana — do przywrócenia potrzebny jest ten sam OLCYS_SNAPSHOT_KEY.'));
rotate('olcys-migawka-');
console.log(dim(`  Przywracanie: node scripts/backup.ts restore "${target}"`));
