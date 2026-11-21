// Uruchamianie OŁCyŚ jednym poleceniem (bez dodatkowych zależności).
//
//   node scripts/run.ts start        produkcja: API + zbudowany interfejs na jednym porcie (pnpm start)
//   node scripts/run.ts demo         jak start, a do tego piaskownica z danymi syntetycznymi (pnpm start:demo)
//   node scripts/run.ts dev          tryb deweloperski: piaskownica + API + Vite (pnpm dev)
//
// Opcje: --config <plik> (domyślnie .env w katalogu głównym), --port <n> (API_PORT), --host <adres> (API_HOST).
// Zmienne ustawione w terminalu mają pierwszeństwo przed plikiem .env.
//
// Zamykanie (Ctrl+C albo SIGTERM): API dostaje żądanie łagodnego zamknięcia (/api/admin/shutdown) i — w Linuksie —
// sygnał SIGTERM; skrypt czeka, aż API zapisze migawkę bazy i zakończy się samo. Dopiero potem zatrzymuje
// piaskownicę i Vite. API nie jest zabijane na siłę (wyjątek: brak reakcji przez OLCYS_STOP_TIMEOUT_MS, domyślnie 120 s).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { portFree } from '../apps/api/src/config-check.ts';
import { ROOT, authHeaders, bold, cyan, dim, flagString, green, loadEnv, localApiBase, paint, parseArgs, red, yellow } from './lib/env.ts';

const args = parseArgs(process.argv.slice(2));
const command = args.positional[0] ?? 'start';
if (!['start', 'demo', 'dev'].includes(command)) {
  console.error(`Nieznane polecenie „${command}”. Dostępne: start, demo, dev.`);
  process.exit(2);
}

let loaded;
try {
  loaded = loadEnv(flagString(args, 'config'));
} catch (error) {
  console.error(red((error as Error).message));
  process.exit(2);
}
const env = loaded.env;
if (flagString(args, 'port')) env.API_PORT = flagString(args, 'port');
if (flagString(args, 'host')) env.API_HOST = flagString(args, 'host');
env.API_PORT ??= '4000';
env.API_HOST ??= '127.0.0.1';

const node = process.execPath;
const apiDir = join(ROOT, 'apps', 'api');
const sandboxDir = join(ROOT, 'apps', 'sandbox');
const webDir = join(ROOT, 'apps', 'web');
const webDist = env.OLCYS_WEB_DIR?.trim() || join(webDir, 'dist');
const truthy = (value: string | undefined) => ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

// Piaskownica: zawsze w trybie demo i dev, w trybie start — gdy OLCYS_START_SANDBOX=1 (zapisuje to kreator).
const withSandbox = command !== 'start' || truthy(env.OLCYS_START_SANDBOX);
const sandboxPort = Number(env.SANDBOX_PORT ?? 4100);
const sandboxEnv: NodeJS.ProcessEnv = { ...env, SANDBOX_PORT: String(sandboxPort), SANDBOX_HOST: env.SANDBOX_HOST ?? '127.0.0.1' };
const apiEnv: NodeJS.ProcessEnv = { ...env };
// Gdy skrypt sam uruchamia piaskownicę, API dostaje jej adres (port z SANDBOX_PORT).
if (withSandbox) apiEnv.SANDBOX_URL = `http://127.0.0.1:${sandboxPort}`;
if (command === 'dev') {
  apiEnv.OLCYS_SERVE_WEB ??= '0';
} else {
  apiEnv.NODE_ENV ??= 'production';
  apiEnv.OLCYS_SERVE_WEB ??= '1';
  if (apiEnv.OLCYS_SERVE_WEB === '1' && !existsSync(join(webDist, 'index.html'))) {
    console.error(red(`Brak zbudowanego interfejsu (${join(webDist, 'index.html')}). Uruchom najpierw: pnpm build`));
    process.exit(1);
  }
}

// ---------- Procesy potomne z prefiksem w dzienniku ----------

interface Child {
  name: string;
  process: ChildProcess;
  exited: Promise<number>;
}
const children: Child[] = [];
const COLORS: Record<string, number> = { api: 35, piaskownica: 33, web: 36 };

function pipe(name: string, stream: NodeJS.ReadableStream | null, target: NodeJS.WriteStream) {
  if (!stream) return;
  const prefix = paint(COLORS[name] ?? 37, `[${name}]`.padEnd(14));
  createInterface({ input: stream }).on('line', (line) => target.write(`${prefix}${line}\n`));
}

function start(name: string, args: string[], cwd: string, childEnv: NodeJS.ProcessEnv): Child {
  const child = spawn(node, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  pipe(name, child.stdout, process.stdout);
  pipe(name, child.stderr, process.stderr);
  const exited = new Promise<number>((done) => child.once('exit', (code, signal) => done(code ?? (signal ? 1 : 0))));
  const entry = { name, process: child, exited };
  children.push(entry);
  exited.then((code) => {
    if (stopping) return;
    if (name === 'api' && code === 0) {
      // Łagodne zamknięcie wywołane z zewnątrz (np. POST /api/admin/shutdown) — kończymy resztę bez błędu.
      console.log(dim('API zakończyło pracę — zatrzymuję pozostałe procesy.'));
      void stopAll(0);
    } else {
      console.error(red(`Proces ${name} zakończył się nieoczekiwanie (kod ${code}) — zatrzymuję pozostałe.`));
      void stopAll(code || 1);
    }
  });
  return entry;
}

async function waitFor(url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
      if (response.status < 500) return true;
    } catch {
      // Jeszcze nie nasłuchuje.
    }
    await new Promise((done) => setTimeout(done, 300));
  }
  return false;
}

// ---------- Zamykanie ----------

let stopping = false;
const stopTimeout = Number(env.OLCYS_STOP_TIMEOUT_MS ?? 120_000);

async function stopApi(api: Child) {
  if (api.process.exitCode !== null) return;
  console.log(dim('Zamykanie API: zapis migawki bazy i zamknięcie sterownika…'));
  try {
    await fetch(`${localApiBase(env)}/api/admin/shutdown`, { method: 'POST', headers: authHeaders(env), signal: AbortSignal.timeout(5000) });
  } catch {
    // API mogło już zacząć zamykanie (Ctrl+C w konsoli trafia też do procesów potomnych).
  }
  if (process.platform !== 'win32') api.process.kill('SIGTERM');
  const finished = await Promise.race([api.exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), stopTimeout))]);
  if (!finished) {
    console.error(red(`API nie zakończyło się w ${Math.round(stopTimeout / 1000)} s — zatrzymanie wymuszone. Zmiany od ostatniej migawki mogły przepaść.`));
    api.process.kill('SIGKILL');
  }
}

async function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  const api = children.find((child) => child.name === 'api');
  if (api) await stopApi(api);
  for (const child of children) {
    if (child.name !== 'api' && child.process.exitCode === null) child.process.kill();
  }
  await Promise.all(children.map((child) => child.exited));
  console.log(green('Zatrzymano.'));
  process.exit(code);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP'] as const) {
  process.on(signal, () => void stopAll(0));
}

// ---------- Start ----------

console.log(bold(`OŁCyŚ — ${command === 'dev' ? 'tryb deweloperski' : command === 'demo' ? 'produkcja z piaskownicą (dane syntetyczne)' : 'produkcja'}`));
console.log(dim(loaded.file ? `Konfiguracja: ${loaded.file}` : 'Konfiguracja: brak pliku .env — wartości domyślne i zmienne terminala.'));

// Zajęte porty zgłaszamy przed startem czegokolwiek (inaczej skrypt mógłby rozmawiać z cudzym procesem).
const busy: string[] = [];
if (!(await portFree(Number(env.API_PORT), env.API_HOST!))) busy.push(`API_PORT=${env.API_PORT} (${env.API_HOST})`);
if (withSandbox && !(await portFree(sandboxPort, sandboxEnv.SANDBOX_HOST!))) busy.push(`SANDBOX_PORT=${sandboxPort}`);
if (command === 'dev' && !(await portFree(Number(env.VITE_PORT ?? 5173), 'localhost'))) busy.push(`VITE_PORT=${env.VITE_PORT ?? 5173}`);
if (busy.length > 0) {
  console.error(red(`Zajęte porty: ${busy.join(', ')}. Działa już inna kopia OŁCyŚ albo inny program — zatrzymaj ją albo zmień port (np. --port 4010, SANDBOX_PORT, VITE_PORT).`));
  process.exit(1);
}

if (withSandbox) {
  start('piaskownica', ['src/server.ts'], sandboxDir, sandboxEnv);
  if (!(await waitFor(`http://127.0.0.1:${sandboxPort}/`, 15_000))) {
    console.error(yellow(`Piaskownica nie odpowiada na porcie ${sandboxPort} — API wystartuje, ale źródła syntetyczne mogą zwracać błędy.`));
  }
}

start('api', ['src/server.ts'], apiDir, apiEnv);

if (command === 'dev') {
  const vite = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) {
    console.error(red('Brak Vite w apps/web/node_modules — uruchom: pnpm install'));
    void stopAll(1);
  } else {
    start('web', [vite], webDir, { ...env, API_PORT: env.API_PORT });
  }
}

const base = localApiBase(env);
const apiChild = children.find((child) => child.name === 'api');
if ((await waitFor(`${base}/api/health`, 120_000, authHeaders(env))) && apiChild?.process.exitCode === null && !stopping) {
  const lines = [''];
  if (command === 'dev') {
    lines.push(`${bold('Interfejs:')} ${cyan(`http://localhost:${env.VITE_PORT ?? 5173}`)}  (Vite, przekierowuje /api do ${base})`);
  } else {
    lines.push(`${bold('Interfejs i API:')} ${cyan(`${base}/`)}`);
  }
  lines.push(`${bold('Stan:')} ${base}/api/health`);
  if (withSandbox) lines.push(`${bold('Piaskownica:')} http://127.0.0.1:${sandboxPort}`);
  lines.push(dim('Ctrl+C — łagodne zamknięcie (zapis bazy).'), '');
  console.log(lines.join('\n'));
}
