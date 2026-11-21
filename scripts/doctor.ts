// Diagnoza instalacji OŁCyŚ: `pnpm run doctor` (uwaga: samo `pnpm doctor` to wbudowane polecenie pnpm).
//
//   node scripts/doctor.ts [--config <plik>] [--online]
//
// Wypisuje ten sam raport, który API sprawdza przy starcie, oraz stan instalacji (zależności, zbudowany interfejs,
// działające API). Z --online sprawdza też łączność z usługami wskazanymi w konfiguracji (piaskownica, PostgreSQL,
// model językowy, a przy ENABLE_LIVE=1 — wybrane źródła publiczne). Bez --online nie łączy się z internetem.
// Kod wyjścia: 1, gdy jest co najmniej jeden błąd.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkConfig, checkConnectivity, checkRunningApi, formatIssues, type ConfigIssue } from '../apps/api/src/config-check.ts';
import { ROOT, bold, dim, flagString, loadEnv, parseArgs, red, useColor } from './lib/env.ts';

const args = parseArgs(process.argv.slice(2), ['online']);
let loaded;
try {
  loaded = loadEnv(flagString(args, 'config'));
} catch (error) {
  console.error(red((error as Error).message));
  process.exit(2);
}
const env = { ...loaded.env };
// API uruchamiane jest w katalogu apps/api — domyślny katalog danych liczymy tak samo.
if (!env.DATABASE_URL?.trim() && !env.OLCYS_DATA_DIR?.trim()) env.OLCYS_DATA_DIR = join(ROOT, 'apps', 'api', 'data', 'pg');

const section = (title: string, issues: ConfigIssue[]) => {
  console.log(`\n${bold(title)}`);
  console.log(formatIssues(issues, useColor));
};

console.log(bold('OŁCyŚ — diagnoza instalacji'));
console.log(dim(loaded.file ? `Konfiguracja: ${loaded.file} (${loaded.fileKeys.length} zmiennych)` : 'Konfiguracja: brak pliku .env — wartości domyślne i zmienne terminala.'));

// ---------- Instalacja ----------
const install: ConfigIssue[] = [];
const rootPackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines?: { node?: string } };
install.push({ level: 'ok', key: 'node', message: `Node ${process.versions.node} (wymagane ${rootPackage.engines?.node ?? '>=24'}).` });
const modules: [string, string][] = [
  ['apps/api', 'fastify'],
  ['apps/api', '@electric-sql/pglite'],
  ['apps/api', 'pg'],
  ['packages/sources', 'undici'],
  ['apps/sandbox', 'fastify'],
];
const missing = modules.filter(([dir, name]) => !existsSync(join(ROOT, dir, 'node_modules', name, 'package.json')));
install.push(
  missing.length === 0
    ? { level: 'ok', key: 'zależności', message: 'Zależności zainstalowane.' }
    : { level: 'error', key: 'zależności', message: `Brak zależności (${missing.map(([dir, name]) => `${dir}: ${name}`).join(', ')}) — uruchom: pnpm install --frozen-lockfile` },
);
const webIndex = join(env.OLCYS_WEB_DIR?.trim() || join(ROOT, 'apps', 'web', 'dist'), 'index.html');
install.push(
  existsSync(webIndex)
    ? { level: 'ok', key: 'interfejs', message: `Interfejs zbudowany (${webIndex}).` }
    : { level: 'warning', key: 'interfejs', message: 'Interfejs nie jest zbudowany — „pnpm start” go wymaga. Uruchom: pnpm build' },
);
if (!loaded.file) install.push({ level: 'info', key: '.env', message: 'Brak pliku .env — utworzy go kreator: pnpm run setup' });
section('Instalacja', install);

// ---------- Konfiguracja ----------
const config = await checkConfig(env, { context: 'doctor' });
section('Konfiguracja', config);

// ---------- Działające API ----------
section('Działające API', await checkRunningApi(env));

// ---------- Łączność ----------
let online: ConfigIssue[] = [];
if (args.flags.has('online')) {
  console.log(dim('\nSprawdzanie łączności (zapytania kontrolne, bez danych spraw)…'));
  online = await checkConnectivity(env);
  section('Łączność', online);
} else {
  console.log(dim('\nŁączność nie była sprawdzana — dodaj --online (pnpm run doctor -- --online).'));
}

const all = [...install, ...config, ...online];
const errors = all.filter((issue) => issue.level === 'error').length;
const warnings = all.filter((issue) => issue.level === 'warning').length;
console.log(`\n${bold('Podsumowanie:')} ${errors} błędów, ${warnings} ostrzeżeń.`);
process.exit(errors > 0 ? 1 : 0);
