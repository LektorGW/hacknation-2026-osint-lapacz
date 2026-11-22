// Sprawdzenie konfiguracji przy starcie API i w poleceniu `pnpm run doctor`.
// Wszystkie komunikaty po polsku, z podpowiedzią, co poprawić. Błąd zatrzymuje start, ostrzeżenie — nie.
// Wartości kluczy i haseł nigdy nie są wypisywane.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEncryptedSnapshot, parseSnapshotKey } from './security-snapshot.ts';

export type IssueLevel = 'error' | 'warning' | 'info' | 'ok';

export interface ConfigIssue {
  level: IssueLevel;
  /** Zmienna albo obszar, którego dotyczy wpis. */
  key: string;
  message: string;
}

export interface CheckOptions {
  /** `start` — przy uruchomieniu serwera (zajęty port = błąd); `doctor` — raport (działające API = informacja). */
  context: 'start' | 'doctor';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
/** Minimalna długość tokenu API — ta sama co w security.ts; krótszy da się odgadnąć. */
export const MIN_TOKEN_LENGTH = 16;
const DEFAULT_WEB_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

const truthy = (value: string | undefined) => ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());

/** Plik blokady katalogu danych PGlite — jeden katalog może obsługiwać tylko jeden proces. */
export const lockFileFor = (dataDir: string) => `${resolve(dataDir)}.blokada`;

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): { pid: number; port?: number; started?: string } | null {
  try {
    const lock = JSON.parse(readFileSync(file, 'utf8')) as { pid: number; port?: number; started?: string };
    return processAlive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

/** Czy port jest wolny na danym adresie. */
export function portFree(port: number, host: string): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)));
  });
}

function tcpReachable(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((done) => {
    const socket = new Socket();
    const finish = (ok: boolean) => {
      socket.destroy();
      done(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host, () => finish(true));
  });
}

/** Rozpoznaje dostawcę modelu tak jak moduł @olcys/ai (bez importu, żeby sprawdzenie działało zawsze). */
function aiTarget(env: NodeJS.ProcessEnv): { provider: string; baseUrl: string } | null {
  const requested = (env.AI_PROVIDER ?? '').trim().toLowerCase();
  if (['none', 'off', 'disabled'].includes(requested)) return null;
  if (requested === 'anthropic') return { provider: 'anthropic', baseUrl: env.AI_BASE_URL?.trim() || 'https://api.anthropic.com' };
  if (requested === 'openai-compatible' || requested === 'openai') {
    return { provider: 'openai-compatible', baseUrl: env.AI_BASE_URL?.trim() || (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : '') };
  }
  if (requested) return { provider: requested, baseUrl: env.AI_BASE_URL?.trim() ?? '' };
  const openai = Boolean(env.OPENAI_API_KEY?.trim());
  const anthropic = Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (openai && anthropic) return null;
  if (openai) return { provider: 'openai-compatible', baseUrl: env.AI_BASE_URL?.trim() || 'https://api.openai.com/v1' };
  if (anthropic) return { provider: 'anthropic', baseUrl: env.AI_BASE_URL?.trim() || 'https://api.anthropic.com' };
  return null;
}

const PRIVATE_HOST = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd)|\.local$|\.lan$|\.internal$/i;

function checkUrl(issues: ConfigIssue[], key: string, value: string | undefined, protocols: string[]): URL | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!protocols.includes(url.protocol)) {
      issues.push({ level: 'error', key, message: `${key} ma nieobsługiwany protokół „${url.protocol}” (dozwolone: ${protocols.join(', ')}).` });
      return null;
    }
    return url;
  } catch {
    issues.push({ level: 'error', key, message: `${key} nie jest poprawnym adresem URL.` });
    return null;
  }
}

function checkNumber(issues: ConfigIssue[], env: NodeJS.ProcessEnv, key: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[key]?.trim();
  if (!raw) return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push({ level: 'error', key, message: `${key}=${raw} — oczekiwana liczba całkowita od ${min}${max < Number.MAX_SAFE_INTEGER ? ` do ${max}` : ''}.` });
  }
}

/** Klucz szyfrowania migawki: ta sama reguła co przy odczycie migawki (32 bajty: hex albo base64). */
export function snapshotKeyValid(value: string): boolean {
  try {
    return parseSnapshotKey(value) !== undefined;
  } catch {
    return false;
  }
}

/** Czy plik migawki jest zaszyfrowany (czyta tylko nagłówek). */
function snapshotEncrypted(file: string): boolean {
  const handle = openSync(file, 'r');
  try {
    const head = Buffer.alloc(64);
    const read = readSync(handle, head, 0, head.length, 0);
    return isEncryptedSnapshot(head.subarray(0, read));
  } finally {
    closeSync(handle);
  }
}

/** Pełny przegląd konfiguracji. Nie zmienia niczego na dysku poza plikiem próbnym zapisu. */
export async function checkConfig(env: NodeJS.ProcessEnv, options: CheckOptions): Promise<ConfigIssue[]> {
  const issues: ConfigIssue[] = [];

  // ---------- Node ----------
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 24) issues.push({ level: 'error', key: 'node', message: `Node ${process.versions.node} — wymagany Node 24 lub nowszy (TypeScript uruchamiany natywnie).` });

  // ---------- Port i adres ----------
  const host = (env.API_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const portRaw = (env.API_PORT ?? '4000').trim();
  const port = Number(portRaw);
  const token = env.OLCYS_API_TOKEN?.trim() ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    issues.push({ level: 'error', key: 'API_PORT', message: `API_PORT=${portRaw} — oczekiwany numer portu 1–65535.` });
  } else if (!(await portFree(port, host))) {
    if (options.context === 'start') {
      issues.push({
        level: 'error',
        key: 'API_PORT',
        message: `Port ${port} na adresie ${host} jest zajęty — prawdopodobnie działa już inna kopia OŁCyŚ (sprawdź http://${host.includes(':') ? `[${host}]` : host}:${port}/api/health) albo inny program. Zmień API_PORT albo zatrzymaj tamten proces.`,
      });
    } else {
      issues.push({ level: 'info', key: 'API_PORT', message: `Port ${port} na adresie ${host} jest zajęty (wynik sprawdzenia działającego API poniżej).` });
    }
  }
  if (!LOOPBACK.has(host)) {
    const inContainer = truthy(env.OLCYS_IN_CONTAINER);
    if (!token) {
      issues.push({
        level: inContainer ? 'info' : 'warning',
        key: 'API_HOST',
        message: inContainer
          ? `API nasłuchuje na ${host} wewnątrz kontenera bez tokenu API — dostęp z zewnątrz ogranicza mapowanie portu (domyślnie 127.0.0.1 hosta). Przed otwarciem portu w sieci ustaw OLCYS_API_TOKEN.`
          : `API nasłuchuje na ${host}, czyli jest dostępne z sieci, a token API (OLCYS_API_TOKEN) nie jest ustawiony. Ustaw token albo zostaw API_HOST=127.0.0.1 i udostępnij narzędzie przez serwer pośredniczący z TLS.`,
      });
    } else if (!inContainer) {
      issues.push({ level: 'info', key: 'API_HOST', message: `API nasłuchuje na ${host}. Połączenie nie jest szyfrowane — w sieci zalecany serwer pośredniczący z TLS (np. nginx, Caddy).` });
    }
    if (!env.OLCYS_ALLOWED_HOSTS?.trim() && !inContainer) {
      issues.push({ level: 'info', key: 'OLCYS_ALLOWED_HOSTS', message: 'Dostęp po nazwie serwera (np. http://olcys.kas.local:4000) wymaga wpisania tej nazwy w OLCYS_ALLOWED_HOSTS — adresy IP i localhost są dozwolone zawsze.' });
    }
  }

  // ---------- Token API i klucz migawki ----------
  if (token && token.length < MIN_TOKEN_LENGTH) {
    issues.push({ level: 'error', key: 'OLCYS_API_TOKEN', message: `Token API jest za krótki (${token.length} znaków, wymagane co najmniej ${MIN_TOKEN_LENGTH}). Wygeneruj nowy: pnpm run setup albo node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))".` });
  }
  const snapshotKey = env.OLCYS_SNAPSHOT_KEY?.trim();
  if (snapshotKey && !snapshotKeyValid(snapshotKey)) {
    issues.push({ level: 'error', key: 'OLCYS_SNAPSHOT_KEY', message: 'Klucz szyfrowania migawki ma złą długość — wymagane 32 bajty: 64 znaki szesnastkowe albo base64. Wygeneruj: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))".' });
  }

  // ---------- Baza danych ----------
  const databaseUrl = env.DATABASE_URL?.trim();
  if (databaseUrl) {
    let url: URL | null = null;
    try {
      url = new URL(databaseUrl);
    } catch {
      issues.push({ level: 'error', key: 'DATABASE_URL', message: 'DATABASE_URL nie jest poprawnym adresem. Postać: postgres://uzytkownik:haslo@host:5432/baza (znaki specjalne w haśle zakoduj, np. @ → %40).' });
    }
    if (url) {
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
        issues.push({ level: 'error', key: 'DATABASE_URL', message: `DATABASE_URL ma protokół „${url.protocol}” — oczekiwany postgres:// albo postgresql://.` });
      } else if (!url.hostname && !url.searchParams.get('host')) {
        issues.push({ level: 'error', key: 'DATABASE_URL', message: 'DATABASE_URL nie wskazuje serwera (brak nazwy hosta).' });
      } else {
        const dbName = url.pathname.replace(/^\//, '');
        issues.push({ level: 'ok', key: 'DATABASE_URL', message: `Baza: PostgreSQL na ${url.hostname || url.searchParams.get('host')}${url.port ? `:${url.port}` : ''}${dbName ? `, baza „${dbName}”` : ''}.` });
        if (env.OLCYS_DATA_DIR) issues.push({ level: 'info', key: 'OLCYS_DATA_DIR', message: 'Ustawiono DATABASE_URL — OLCYS_DATA_DIR (PGlite) nie jest używany.' });
        if (snapshotKey) issues.push({ level: 'info', key: 'OLCYS_SNAPSHOT_KEY', message: 'Klucz migawki dotyczy tylko wbudowanej bazy PGlite; przy PostgreSQL szyfrowanie zapewnia serwer bazy.' });
      }
    }
  } else {
    const dataDir = resolve(env.OLCYS_DATA_DIR?.trim() || './data/pg');
    const parent = dirname(dataDir);
    try {
      mkdirSync(parent, { recursive: true });
      const probe = join(parent, `.olcys-proba-zapisu-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
      const snapshot = `${dataDir}.migawka.tar.gz`;
      let snapshotInfo = 'brak migawki — baza zostanie utworzona';
      if (existsSync(snapshot)) {
        const encrypted = snapshotEncrypted(snapshot);
        snapshotInfo = `migawka ${encrypted ? 'szyfrowana ' : ''}${(statSync(snapshot).size / 1024 / 1024).toFixed(1)} MB z ${statSync(snapshot).mtime.toLocaleString('pl-PL')}`;
        if (encrypted && !snapshotKey) {
          issues.push({ level: 'error', key: 'OLCYS_SNAPSHOT_KEY', message: `Migawka ${snapshot} jest zaszyfrowana, a OLCYS_SNAPSHOT_KEY nie jest ustawiony — ustaw ten sam klucz, którym ją zapisano.` });
        } else if (!encrypted && snapshotKey) {
          issues.push({ level: 'info', key: 'OLCYS_SNAPSHOT_KEY', message: 'Migawka nie jest jeszcze zaszyfrowana — zostanie zaszyfrowana przy najbliższym zapisie.' });
        }
      }
      issues.push({ level: 'ok', key: 'OLCYS_DATA_DIR', message: `Baza: wbudowany PGlite w ${dataDir} (${snapshotInfo}).` });
    } catch (error) {
      issues.push({ level: 'error', key: 'OLCYS_DATA_DIR', message: `Katalog danych ${parent} nie pozwala na zapis (${(error as NodeJS.ErrnoException).code ?? 'błąd'}). Wskaż inny katalog w OLCYS_DATA_DIR albo nadaj uprawnienia użytkownikowi usługi.` });
    }
    const lock = readLock(lockFileFor(dataDir));
    if (lock) {
      issues.push({
        level: options.context === 'start' ? 'error' : 'info',
        key: 'OLCYS_DATA_DIR',
        message:
          options.context === 'start'
            ? `Katalog danych ${dataDir} jest używany przez inny proces OŁCyŚ (PID ${lock.pid}${lock.port ? `, port ${lock.port}` : ''}). Dwa procesy na jednej bazie PGlite uszkodzą dane — zatrzymaj tamten proces albo wskaż inny OLCYS_DATA_DIR.`
            : `Katalog danych jest używany przez działające API (PID ${lock.pid}${lock.port ? `, port ${lock.port}` : ''}).`,
      });
    }
  }

  // ---------- Retencja, archiwa, limity ----------
  checkNumber(issues, env, 'OLCYS_RETENTION_DAYS_CLOSED', 1, 36_500);
  checkNumber(issues, env, 'CORPUS_RETENTION_DAYS', 1, 36_500);
  checkNumber(issues, env, 'CORPUS_MAX_ROWS', 1);
  checkNumber(issues, env, 'OLCYS_RATE_LIMIT_PER_MIN', 0);
  const archiveDir = env.OLCYS_ARCHIVE_DIR?.trim();
  if (archiveDir) {
    try {
      mkdirSync(archiveDir, { recursive: true });
      const probe = join(archiveDir, `.olcys-proba-zapisu-${process.pid}`);
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    } catch (error) {
      issues.push({ level: 'error', key: 'OLCYS_ARCHIVE_DIR', message: `Katalog archiwów ${resolve(archiveDir)} nie pozwala na zapis (${(error as NodeJS.ErrnoException).code ?? 'błąd'}).` });
    }
  }

  // ---------- Źródła ----------
  const live = truthy(env.ENABLE_LIVE);
  if (env.ENABLE_LIVE?.trim() && !live && !['0', 'false', 'no'].includes(env.ENABLE_LIVE.trim().toLowerCase())) {
    issues.push({ level: 'warning', key: 'ENABLE_LIVE', message: `ENABLE_LIVE=${env.ENABLE_LIVE} nie jest rozpoznawane — źródła publiczne pozostają wyłączone (dozwolone: 1, true, yes).` });
  }
  const sandboxRaw = env.SANDBOX_URL === undefined ? 'http://localhost:4100' : env.SANDBOX_URL.trim();
  if (sandboxRaw && ['off', 'none', '0', 'false', 'nie'].includes(sandboxRaw.toLowerCase())) {
    issues.push({ level: 'warning', key: 'SANDBOX_URL', message: `SANDBOX_URL=${sandboxRaw} nie jest adresem. Aby wyłączyć piaskownicę, ustaw pustą wartość: „SANDBOX_URL=”.` });
  } else {
    checkUrl(issues, 'SANDBOX_URL', sandboxRaw, ['http:', 'https:']);
  }
  checkUrl(issues, 'LAB_URL', env.LAB_URL, ['http:', 'https:']);
  checkUrl(issues, 'TOR_PROXY_URL', env.TOR_PROXY_URL, ['http:']);
  const sandboxOn = Boolean(sandboxRaw) && !['off', 'none', '0', 'false', 'nie'].includes(sandboxRaw.toLowerCase());
  const families = [sandboxOn ? 'dane syntetyczne (piaskownica)' : '', env.LAB_URL?.trim() ? 'laboratorium tożsamości' : '', live ? 'publiczne źródła w internecie' : ''].filter(Boolean);
  issues.push({ level: 'ok', key: 'źródła', message: families.length > 0 ? `Dostępne dane: ${families.join(', ')}.` : 'Brak źródeł danych: piaskownica wyłączona i ENABLE_LIVE nieustawione — analizy niczego nie znajdą.' });
  if (live && !env.OLCYS_CONTACT?.trim()) {
    issues.push({ level: 'warning', key: 'OLCYS_CONTACT', message: 'Włączone są źródła publiczne, a OLCYS_CONTACT nie jest ustawione. Zasady Wikimedia (Wikidata) wymagają kontaktu w nagłówku User-Agent — podaj e-mail albo stronę zespołu, inaczej zapytania mogą być blokowane.' });
  }
  if (!live) {
    for (const key of ['GITHUB_TOKEN', 'CEIDG_API_TOKEN', 'MARGINALIA_API_KEY', 'MOJEEK_API_KEY', 'BLOCKSCOUT_API_KEY']) {
      if (env[key]?.trim()) issues.push({ level: 'info', key, message: `${key} jest ustawiony, ale ENABLE_LIVE nie — klucz nie będzie używany.` });
    }
  }

  // ---------- Model językowy ----------
  const target = aiTarget(env);
  if (target) {
    if (!target.baseUrl) {
      issues.push({ level: 'warning', key: 'AI_BASE_URL', message: 'Wybrano model zgodny z API OpenAI bez AI_BASE_URL — model nie zostanie włączony.' });
    } else {
      const url = checkUrl(issues, 'AI_BASE_URL', target.baseUrl, ['http:', 'https:']);
      if (url) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        if (target.provider !== 'anthropic' && !env.AI_MODEL?.trim()) {
          issues.push({ level: 'warning', key: 'AI_MODEL', message: 'Brak AI_MODEL — model zgodny z API OpenAI wymaga nazwy modelu; model nie zostanie włączony.' });
        }
        if (LOOPBACK.has(hostname)) {
          issues.push({ level: 'ok', key: 'AI_BASE_URL', message: `Model językowy działa na tej maszynie (${url.host}) — dane analizy nie opuszczają serwera.` });
        } else if (PRIVATE_HOST.test(hostname)) {
          issues.push({ level: 'info', key: 'AI_BASE_URL', message: `Model językowy działa w sieci wewnętrznej (${url.host}) — fragmenty publikacji z analiz są wysyłane do tego serwera.` });
        } else {
          issues.push({ level: 'warning', key: 'AI_BASE_URL', message: `Model językowy działa poza tą maszyną (${url.host}) — dane analizy (fragmenty publikacji) są wysyłane do wskazanego dostawcy.` });
        }
      }
    }
  } else if (env.OPENAI_API_KEY?.trim() && env.ANTHROPIC_API_KEY?.trim() && !env.AI_PROVIDER) {
    issues.push({ level: 'info', key: 'AI_PROVIDER', message: 'Ustawiono OPENAI_API_KEY i ANTHROPIC_API_KEY bez AI_PROVIDER — model językowy pozostaje wyłączony.' });
  }

  // ---------- Interfejs ----------
  const webDir = resolve(env.OLCYS_WEB_DIR?.trim() || DEFAULT_WEB_DIR);
  if (truthy(env.OLCYS_SERVE_WEB) && !existsSync(join(webDir, 'index.html'))) {
    issues.push({ level: 'warning', key: 'OLCYS_SERVE_WEB', message: `Interfejs nie jest zbudowany (brak ${join(webDir, 'index.html')}) — uruchom „pnpm build”. API działa bez interfejsu.` });
  }

  return issues;
}

const LABELS: Record<IssueLevel, string> = { error: 'BŁĄD', warning: 'UWAGA', info: 'info', ok: 'OK' };

export function formatIssues(issues: ConfigIssue[], color = false): string {
  const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const colors: Record<IssueLevel, number> = { error: 31, warning: 33, info: 36, ok: 32 };
  return issues.map((issue) => `  ${paint(colors[issue.level], LABELS[issue.level].padEnd(5))} ${issue.message}`).join('\n');
}

/**
 * Wywoływane z server.ts przed otwarciem bazy: wypisuje ostrzeżenia, a przy błędach kończy proces z kodem 1.
 * Zakłada też blokadę katalogu danych PGlite (usuwaną przy zakończeniu procesu).
 */
export async function checkConfigOrExit(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (truthy(env.OLCYS_SKIP_CONFIG_CHECK)) return;
  const issues = await checkConfig(env, { context: 'start' });
  const shown = issues.filter((issue) => issue.level === 'error' || issue.level === 'warning');
  const color = Boolean(process.stderr.isTTY) && !env.NO_COLOR;
  if (shown.length > 0) console.error(`Sprawdzenie konfiguracji OŁCyŚ:\n${formatIssues(shown, color)}`);
  if (issues.some((issue) => issue.level === 'error')) {
    console.error('Start przerwany — popraw konfigurację (plik .env albo zmienne środowiskowe). Pełny raport: pnpm run doctor');
    process.exit(1);
  }
  if (!env.DATABASE_URL?.trim()) {
    const lockFile = lockFileFor(env.OLCYS_DATA_DIR?.trim() || './data/pg');
    try {
      writeFileSync(lockFile, JSON.stringify({ pid: process.pid, port: Number(env.API_PORT ?? 4000), started: new Date().toISOString() }));
      process.on('exit', () => {
        try {
          const current = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid: number };
          if (current.pid === process.pid) rmSync(lockFile, { force: true });
        } catch {
          // Blokada już usunięta.
        }
      });
    } catch {
      // Brak blokady nie zatrzymuje startu — sprawdzenie zapisu wyżej zgłosiłoby problem z katalogiem.
    }
  }
}

// ---------- Sprawdzenia łączności (pnpm run doctor --online) ----------

const userAgent = (env: NodeJS.ProcessEnv) => `OLCyS-research/0.1 (${env.OLCYS_CONTACT?.trim() || 'hackathon KAS; kontakt przez organizatora'})`;

async function probe(url: string, init: RequestInit = {}, timeoutMs = 8000): Promise<{ ok: boolean; status?: number; ms: number; error?: string; body?: unknown }> {
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    let body: unknown;
    if ((response.headers.get('content-type') ?? '').includes('json')) body = await response.json().catch(() => undefined);
    else await response.arrayBuffer().catch(() => undefined);
    return { ok: response.status < 400, status: response.status, ms: Date.now() - started, body };
  } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    return { ok: false, ms: Date.now() - started, error: cause ?? (error instanceof Error ? error.name : 'błąd') };
  }
}

/** Sprawdza działające API pod lokalnym adresem (stan, wersja, tryb). */
export async function checkRunningApi(env: NodeJS.ProcessEnv): Promise<ConfigIssue[]> {
  const host = (env.API_HOST ?? '127.0.0.1').trim();
  const local = host === '0.0.0.0' || host === 'localhost' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  const base = `http://${local}:${Number(env.API_PORT ?? 4000)}`;
  const token = env.OLCYS_API_TOKEN?.trim();
  const result = await probe(`${base}/api/health`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, 4000);
  if (!result.ok) {
    return [{ level: 'info', key: 'API', message: `API nie odpowiada pod ${base} (${result.status ?? result.error}) — nie działa albo port zajmuje inny program.` }];
  }
  const health = (result.body ?? {}) as { status?: string; version?: string; mode?: string; dataMode?: string; database?: string };
  return [{ level: health.status === 'ok' ? 'ok' : 'warning', key: 'API', message: `API działa pod ${base}: stan ${health.status ?? '?'}, baza ${health.database ?? '?'}, tryb ${health.dataMode ?? health.mode ?? '?'}, wersja ${health.version ?? '?'}.` }];
}

/** Łączność z usługami wskazanymi w konfiguracji. Wysyła tylko zapytania kontrolne, bez danych spraw. */
export async function checkConnectivity(env: NodeJS.ProcessEnv): Promise<ConfigIssue[]> {
  const headers = { 'User-Agent': userAgent(env) };
  const tasks: Promise<ConfigIssue>[] = [];
  const add = (key: string, label: string, url: string, init: RequestInit = {}) =>
    tasks.push(
      probe(url, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } }).then((result) => ({
        level: result.ok ? 'ok' : 'warning',
        key,
        message: result.ok ? `${label}: odpowiada (${result.status}, ${result.ms} ms).` : `${label}: brak połączenia (${result.status ?? result.error}, ${url.replace(/\?.*$/, '')}).`,
      })),
    );

  const sandbox = env.SANDBOX_URL === undefined ? 'http://localhost:4100' : env.SANDBOX_URL.trim();
  if (sandbox && /^https?:/i.test(sandbox)) add('SANDBOX_URL', 'Piaskownica', sandbox);
  if (env.LAB_URL?.trim()) add('LAB_URL', 'Laboratorium tożsamości', env.LAB_URL.trim());

  if (env.TOR_PROXY_URL?.trim()) {
    tasks.push(
      (async () => {
        try {
          const url = new URL(env.TOR_PROXY_URL!.trim());
          const ok = await tcpReachable(url.hostname, Number(url.port || 80));
          return { level: ok ? 'ok' : 'warning', key: 'TOR_PROXY_URL', message: ok ? `Proxy Tora (${url.host}): port otwarty.` : `Proxy Tora (${url.host}): brak połączenia.` } as ConfigIssue;
        } catch {
          return { level: 'warning', key: 'TOR_PROXY_URL', message: 'Proxy Tora: niepoprawny adres.' } as ConfigIssue;
        }
      })(),
    );
  }

  if (env.DATABASE_URL?.trim()) {
    tasks.push(
      (async () => {
        try {
          const { default: pg } = await import('pg');
          const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });
          await client.connect();
          const result = await client.query<{ version: string }>('select version() as version');
          await client.end();
          return { level: 'ok', key: 'DATABASE_URL', message: `PostgreSQL: połączenie działa (${String(result.rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ')}).` } as ConfigIssue;
        } catch (error) {
          return { level: 'error', key: 'DATABASE_URL', message: `PostgreSQL: nie udało się połączyć (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}).` } as ConfigIssue;
        }
      })(),
    );
  }

  const target = aiTarget(env);
  if (target?.baseUrl) {
    const key = env.AI_API_KEY?.trim() || (target.provider === 'anthropic' ? env.ANTHROPIC_API_KEY?.trim() : env.OPENAI_API_KEY?.trim());
    if (target.provider === 'anthropic') {
      add('AI_BASE_URL', 'Model językowy (Anthropic)', `${target.baseUrl.replace(/\/+$/, '')}/v1/models`, { headers: key ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : {} });
    } else {
      add('AI_BASE_URL', 'Model językowy (lista modeli)', `${target.baseUrl.replace(/\/+$/, '')}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
    }
  }

  if (truthy(env.ENABLE_LIVE)) {
    const github = env.GITHUB_TOKEN?.trim();
    add('ENABLE_LIVE', 'GitHub API', 'https://api.github.com/rate_limit', { headers: github ? { Authorization: `Bearer ${github}` } : {} });
    add('ENABLE_LIVE', 'Blockstream (Bitcoin)', 'https://blockstream.info/api/blocks/tip/height');
    add('ENABLE_LIVE', 'Blockscout (Ethereum)', 'https://eth.blockscout.com/api/v2/stats');
    add('ENABLE_LIVE', 'TronScan (Tron)', 'https://apilist.tronscanapi.com/api/system/status');
    add('ENABLE_LIVE', 'Litecoin Space (Litecoin)', 'https://litecoinspace.org/api/blocks/tip/height');
    add('ENABLE_LIVE', 'NBP (kursy walut)', 'https://api.nbp.pl/api/exchangerates/tables/a/?format=json');
    add('ENABLE_LIVE', 'Binance (ceny)', 'https://api.binance.com/api/v3/ping');
    add('ENABLE_LIVE', 'Wikidata', 'https://www.wikidata.org/w/api.php?action=query&meta=siteinfo&format=json');
    add('ENABLE_LIVE', 'Wykaz podatników VAT', 'https://wykazpodatnikowvat.mf.gov.pl/');
    add('ENABLE_LIVE', 'KRS', 'https://api-krs.ms.gov.pl/');
    if (env.BLOCKSCOUT_API_KEY?.trim()) add('BLOCKSCOUT_API_KEY', 'Blockscout z kluczem', 'https://api.blockscout.com/');
    if (env.MARGINALIA_API_KEY?.trim()) add('MARGINALIA_API_KEY', 'Marginalia Search', 'https://api.marginalia.nu/');
  }

  if (tasks.length === 0) return [{ level: 'info', key: 'łączność', message: 'Konfiguracja nie wskazuje żadnych usług do sprawdzenia.' }];
  return Promise.all(tasks);
}
