// Wspólne narzędzia skryptów wdrożeniowych: katalog repozytorium, wczytanie pliku .env, argumenty wiersza poleceń.
// Bez zależności zewnętrznych — wyłącznie biblioteka standardowa Node 24.

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/** Katalog główny repozytorium (scripts/lib → ../..). */
export const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Zmienne ze ścieżkami: względne wartości w .env są liczone od katalogu głównego repozytorium. */
const PATH_VARS = ['OLCYS_DATA_DIR', 'OLCYS_WEB_DIR', 'OLCYS_BACKUP_DIR', 'LAB_DATA_DIR'];

export interface LoadedEnv {
  env: NodeJS.ProcessEnv;
  /** Ścieżka wczytanego pliku albo null, gdy pliku nie ma. */
  file: string | null;
  /** Zmienne zdefiniowane w pliku (bez wartości — do raportów). */
  fileKeys: string[];
}

/**
 * Wczytuje plik .env (domyślnie <repozytorium>/.env) i łączy ze zmiennymi procesu.
 * Zmienne ustawione w terminalu mają pierwszeństwo przed plikiem. Ścieżki względne są zamieniane na bezwzględne,
 * bo procesy potomne pracują w katalogach modułów (apps/api, apps/sandbox).
 */
export function loadEnv(envFile?: string): LoadedEnv {
  const file = resolve(ROOT, envFile ?? '.env');
  let parsed: Record<string, string> = {};
  let found: string | null = null;
  if (existsSync(file)) {
    parsed = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
    found = file;
  } else if (envFile) {
    throw new Error(`Nie znaleziono pliku konfiguracji: ${file}`);
  }
  const env: NodeJS.ProcessEnv = { ...parsed, ...process.env };
  for (const key of PATH_VARS) {
    const value = env[key]?.trim();
    if (value && !isAbsolute(value)) env[key] = resolve(ROOT, value);
  }
  return { env, file: found, fileKeys: Object.keys(parsed) };
}

export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

/** Prosty parser: `--klucz wartość`, `--klucz=wartość`, `--flaga`, `--no-flaga` (= wartość „false”). */
export function parseArgs(argv: string[], booleanFlags: string[] = []): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    // Samo „--” (separator argumentów przekazywany przez pnpm) pomijamy.
    if (item === '--') continue;
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const body = item.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags.set(body.slice(0, eq), body.slice(eq + 1));
    } else if (body.startsWith('no-')) {
      flags.set(body.slice(3), 'false');
    } else if (booleanFlags.includes(body) || index + 1 >= argv.length || argv[index + 1]!.startsWith('--')) {
      flags.set(body, true);
    } else {
      flags.set(body, argv[index + 1]!);
      index += 1;
    }
  }
  return { positional, flags };
}

export const flagString = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : undefined;
};

/** Kolory w terminalu tylko wtedy, gdy wyjście to terminal i nie ustawiono NO_COLOR. */
export const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
export const paint = (code: number, text: string) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
export const bold = (text: string) => paint(1, text);
export const red = (text: string) => paint(31, text);
export const green = (text: string) => paint(32, text);
export const yellow = (text: string) => paint(33, text);
export const cyan = (text: string) => paint(36, text);
export const dim = (text: string) => paint(2, text);

/** Adres, pod którym skrypty łączą się z API na tej maszynie (0.0.0.0 / :: → pętla zwrotna). */
export function localApiBase(env: NodeJS.ProcessEnv): string {
  const port = Number(env.API_PORT ?? 4000);
  const host = (env.API_HOST ?? '127.0.0.1').trim();
  const local = host === '0.0.0.0' || host === '' || host === 'localhost' ? '127.0.0.1' : host === '::' ? '[::1]' : host.includes(':') ? `[${host}]` : host;
  return `http://${local}:${port}`;
}

/** Nagłówki uwierzytelnienia dla żądań administracyjnych (gdy skonfigurowano token API). */
export function authHeaders(env: NodeJS.ProcessEnv): Record<string, string> {
  const token = env.OLCYS_API_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
