// Kreator instalacji OŁCyŚ: `pnpm run setup` (uwaga: samo `pnpm setup` to wbudowane polecenie pnpm).
//
//   node scripts/setup.ts                 pytania w terminalu
//   node scripts/setup.ts --yes           bez pytań, wartości domyślne (+ opcje poniżej)
//
// Kroki: sprawdzenie Node i pnpm → `pnpm install --frozen-lockfile` → budowa interfejsu → pytania → zapis .env.
// Istniejący plik .env nie jest nadpisywany bez --force (wtedy powstaje kopia .env.kopia-<data>).
//
// Opcje (każda zastępuje pytanie):
//   --config <plik>        gdzie zapisać konfigurację (domyślnie .env w katalogu głównym)
//   --force                  nadpisz istniejący plik (z kopią zapasową)
//   --skip-install           bez instalacji zależności;  --skip-build  bez budowy interfejsu
//   --mode demo|live|both    dane syntetyczne / źródła publiczne / oba (przełączane w interfejsie)
//   --port <n>  --host <adres>  --data-dir <katalog> (lub --dir)
//   --database-url <postgres://…>   zamiast wbudowanej bazy PGlite
//   --token <wartość> | --no-token      --snapshot-key <hex> | --no-snapshot-key
//   --retention-days <n>     --contact <e-mail lub strona>     --allowed-hosts <nazwa[,nazwa]>
//   --github-token, --ceidg-token, --marginalia-key, --blockscout-key <wartość>
//   --ai none|local|external  --ai-provider openai-compatible|anthropic  --ai-base-url  --ai-model  --ai-api-key

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ROOT, bold, cyan, dim, flagString, green, parseArgs, red, yellow } from './lib/env.ts';

const args = parseArgs(process.argv.slice(2), ['yes', 'force', 'skip-install', 'skip-build', 'help']);
if (args.flags.has('help')) {
  console.log('Kreator instalacji OŁCyŚ. Opcje: zobacz nagłówek pliku scripts/setup.ts albo docs/WDROZENIE.md.');
  process.exit(0);
}
const interactive = !args.flags.has('yes') && Boolean(process.stdin.isTTY);
const disabled = (name: string) => args.flags.get(name) === 'false';
// `--no-<opcja>` zapisuje wartość „false” — dla wartości tekstowych oznacza „brak”, nie tekst „false”.
const flag = (name: string) => (disabled(name) ? undefined : flagString(args, name));

const step = (text: string) => console.log(`\n${bold(cyan('▶'))} ${bold(text)}`);
const fail = (text: string): never => {
  console.error(red(`\n${text}`));
  process.exit(1);
};

console.log(bold('OŁCyŚ — kreator instalacji'));
console.log(dim(interactive ? 'Enter przyjmuje wartość domyślną w nawiasie kwadratowym.' : 'Tryb bez pytań: wartości domyślne i opcje z wiersza poleceń.'));

// ---------- 1. Wersje ----------
step('Sprawdzanie wersji');
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 24) fail(`Node ${process.versions.node} — wymagany Node 24 lub nowszy (https://nodejs.org).`);
console.log(`  Node ${process.versions.node} ${green('OK')}`);
// W Windows pnpm to skrypt .cmd — wymaga powłoki; polecenia są stałe, bez danych od użytkownika.
const shellRun = (command: string, options: Parameters<typeof spawnSync>[2] = {}) =>
  process.platform === 'win32' ? spawnSync(command, { ...options, shell: true }) : spawnSync(command.split(' ')[0]!, command.split(' ').slice(1), options);
const pnpm = shellRun('pnpm --version', { encoding: 'utf8' });
const pnpmVersion = pnpm.status === 0 ? String(pnpm.stdout).trim() : '';
const needPnpm = !args.flags.has('skip-install') || !args.flags.has('skip-build');
if (!pnpmVersion) {
  if (needPnpm) fail('Nie znaleziono pnpm. Instalacja: corepack enable && corepack prepare pnpm@12.21.0 --activate (albo npm install -g pnpm@12).');
  console.log(yellow('  pnpm nie znaleziony (pomijam — instalacja i budowa wyłączone).'));
} else {
  const major = Number(pnpmVersion.split('.')[0]);
  console.log(`  pnpm ${pnpmVersion} ${major >= 10 ? green('OK') : yellow('(zalecany 12 — plik blokady powstał w pnpm 12)')}`);
}

const run = (title: string, command: string, commandArgs: string[]) => {
  step(title);
  console.log(dim(`  ${command} ${commandArgs.join(' ')}`));
  const result = shellRun([command, ...commandArgs].join(' '), { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) fail(`Polecenie nie powiodło się (kod ${result.status}). Popraw błąd i uruchom kreator ponownie.`);
};

// ---------- 2. Zależności i interfejs ----------
if (!args.flags.has('skip-install')) run('Instalacja zależności', 'pnpm', ['install', '--frozen-lockfile']);
if (!args.flags.has('skip-build')) run('Budowa interfejsu (apps/web/dist)', 'pnpm', ['--filter', '@olcys/web', 'build']);

// ---------- 3. Pytania ----------
step('Konfiguracja');
const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;

async function ask(question: string, fallback: string, validate?: (value: string) => string | null): Promise<string> {
  if (!rl) {
    const problem = validate?.(fallback);
    if (problem) fail(`${question}: ${problem}`);
    return fallback;
  }
  for (;;) {
    const answer = (await rl.question(`  ${question}${fallback ? ` ${dim(`[${fallback}]`)}` : ''}: `)).trim() || fallback;
    const problem = validate?.(answer);
    if (!problem) return answer;
    console.log(red(`    ${problem}`));
  }
}

async function choose(question: string, options: { value: string; label: string }[], fallback: string): Promise<string> {
  if (!rl) return fallback;
  console.log(`  ${question}`);
  options.forEach((option, index) => console.log(`    ${index + 1}) ${option.label}${option.value === fallback ? dim(' (domyślnie)') : ''}`));
  for (;;) {
    const answer = (await rl.question(`  Wybór ${dim(`[${options.findIndex((option) => option.value === fallback) + 1}]`)}: `)).trim();
    if (!answer) return fallback;
    const picked = options[Number(answer) - 1] ?? options.find((option) => option.value === answer);
    if (picked) return picked.value;
    console.log(red('    Podaj numer z listy.'));
  }
}

async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!rl) return fallback;
  const answer = (await rl.question(`  ${question} ${dim(fallback ? '[T/n]' : '[t/N]')}: `)).trim().toLowerCase();
  if (!answer) return fallback;
  return ['t', 'tak', 'y', 'yes'].includes(answer);
}

const validPort = (value: string) => (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535 ? null : 'Podaj numer portu 1–65535.');
const validDatabaseUrl = (value: string) => {
  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) return 'Adres musi zaczynać się od postgres:// albo postgresql://';
    if (!url.hostname) return 'Brak nazwy serwera w adresie.';
    return null;
  } catch {
    return 'Niepoprawny adres. Postać: postgres://uzytkownik:haslo@host:5432/olcys';
  }
};
const validUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol) ? null : 'Adres musi zaczynać się od http:// albo https://';
  } catch {
    return 'Niepoprawny adres URL.';
  }
};
const validDays = (value: string) => (!value || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 36_500) ? null : 'Podaj liczbę dni (1–36500) albo zostaw puste.');

const modeFlag = flag('mode');
if (modeFlag && !['demo', 'live', 'both'].includes(modeFlag)) fail('--mode: dozwolone demo, live, both.');
const mode =
  modeFlag ??
  (await choose(
    'Jakie dane mają być dostępne?',
    [
      { value: 'demo', label: 'tylko dane syntetyczne (piaskownica, bez internetu)' },
      { value: 'live', label: 'tylko publiczne źródła w internecie' },
      { value: 'both', label: 'oba — przełączane w interfejsie bez restartu' },
    ],
    'both',
  ));
const live = mode !== 'demo';
const sandbox = mode !== 'live';

const port = flag('port') ?? (await ask('Port HTTP (API i interfejs)', '4000', validPort));
if (validPort(port)) fail(`--port: ${validPort(port)}`);
const host = flag('host') ?? (await ask('Adres nasłuchu (127.0.0.1 = tylko ten komputer, 0.0.0.0 = cała sieć)', '127.0.0.1'));

const dataRootRaw = flag('data-dir') ?? flag('dir') ?? (await ask('Katalog danych (baza, migawki, kopie zapasowe)', join(ROOT, '.data-olcys')));
const dataRoot = isAbsolute(dataRootRaw) ? dataRootRaw : resolve(ROOT, dataRootRaw);

let databaseUrl = flag('database-url') ?? '';
if (!databaseUrl && rl) {
  const database = await choose(
    'Baza danych:',
    [
      { value: 'pglite', label: 'wbudowana (PGlite) — nic do instalowania, dobra na jedno stanowisko' },
      { value: 'postgres', label: 'PostgreSQL 14+ — zalecany do pracy na prawdziwych danych i monitoringu' },
    ],
    'pglite',
  );
  if (database === 'postgres') databaseUrl = await ask('Adres bazy (postgres://uzytkownik:haslo@host:5432/olcys)', '', validDatabaseUrl);
}
if (databaseUrl && validDatabaseUrl(databaseUrl)) fail(`--database-url: ${validDatabaseUrl(databaseUrl)}`);

const remote = !['127.0.0.1', 'localhost', '::1'].includes(host);
let token = flag('token') ?? '';
if (!token && !disabled('token')) {
  if (
    await confirm(
      remote
        ? 'Wygenerować token API? (zalecane — API będzie dostępne z sieci; interfejs poprosi o token przy pierwszym otwarciu)'
        : 'Wygenerować token API? (każde żądanie API wymaga tokenu; interfejs poprosi o niego przy pierwszym otwarciu)',
      true,
    )
  ) {
    token = randomBytes(32).toString('base64url');
  }
}
if (token && token.length < 16) fail('Token API musi mieć co najmniej 16 znaków.');
// Nazwa serwera w adresie (nagłówek Host) musi być dozwolona — adresy IP i localhost są dozwolone zawsze.
const allowedHosts = flag('allowed-hosts') ?? (remote ? await ask('Nazwy serwera, pod którymi otwierane będzie narzędzie (po przecinku; puste = tylko adres IP)', '') : '');

let snapshotKey = flag('snapshot-key') ?? '';
if (!databaseUrl && !snapshotKey && !disabled('snapshot-key')) {
  if (await confirm('Szyfrować migawkę bazy kluczem (klucz trafi do .env — zrób jego kopię, bez niego migawki nie da się odczytać)?', true)) {
    snapshotKey = randomBytes(32).toString('hex');
  }
}

const retention = flag('retention-days') ?? (await ask('Po ilu dniach usuwać zamknięte sprawy (puste = nie usuwać)', '', validDays));
if (validDays(retention)) fail(`--retention-days: ${validDays(retention)}`);

const keys: Record<string, string> = {};
let contact = flag('contact') ?? '';
if (live) {
  if (!contact) contact = await ask('Kontakt do nagłówka User-Agent (e-mail lub strona; wymagają go m.in. zasady Wikimedia)', '');
  const optional: [string, string, string][] = [
    ['GITHUB_TOKEN', 'github-token', 'Token GitHub bez uprawnień (wyższy limit, wyszukiwarka GitHuba)'],
    ['CEIDG_API_TOKEN', 'ceidg-token', 'Token API Hurtowni danych CEIDG'],
    ['MARGINALIA_API_KEY', 'marginalia-key', 'Klucz Marginalia Search („public” = klucz wspólny)'],
    ['BLOCKSCOUT_API_KEY', 'blockscout-key', 'Klucz API Blockscout (Arbitrum, Gnosis)'],
  ];
  if (rl) console.log(dim('  Klucze opcjonalne — Enter pomija.'));
  for (const [variable, name, label] of optional) {
    const value = flag(name) ?? (await ask(label, ''));
    if (value) keys[variable] = value;
  }
}

// ---------- Model językowy ----------
const aiFlag = flag('ai');
if (aiFlag && !['none', 'local', 'external'].includes(aiFlag)) fail('--ai: dozwolone none, local, external.');
const aiChoice =
  aiFlag ??
  (await choose(
    'Model językowy (pomocniczy, opcjonalny — wszystkie wyniki liczą jawne reguły):',
    [
      { value: 'none', label: 'brak' },
      { value: 'local', label: 'model lokalny (Ollama, LM Studio, vLLM — serwer zgodny z API OpenAI, AI_BASE_URL)' },
      { value: 'external', label: 'usługa zewnętrzna — dane analizy (fragmenty publikacji) są wysyłane do wskazanego dostawcy' },
    ],
    'none',
  ));
const ai: Record<string, string> = {};
if (aiChoice === 'local') {
  ai.AI_PROVIDER = 'openai-compatible';
  ai.AI_BASE_URL = flag('ai-base-url') ?? (await ask('Adres serwera modelu (Ollama: http://127.0.0.1:11434/v1, LM Studio: http://127.0.0.1:1234/v1)', 'http://127.0.0.1:11434/v1', validUrl));
  ai.AI_MODEL = flag('ai-model') ?? (await ask('Nazwa modelu (np. bielik-11b-v2.3-instruct, llama3.1:8b)', '', (value) => (value ? null : 'Nazwa modelu jest wymagana.')));
} else if (aiChoice === 'external') {
  ai.AI_PROVIDER = flag('ai-provider') ?? (await choose('Rodzaj usługi:', [{ value: 'openai-compatible', label: 'zgodna z API OpenAI' }, { value: 'anthropic', label: 'Anthropic' }], 'openai-compatible'));
  if (ai.AI_PROVIDER === 'openai-compatible') {
    ai.AI_BASE_URL = flag('ai-base-url') ?? (await ask('Adres API', 'https://api.openai.com/v1', validUrl));
    ai.AI_MODEL = flag('ai-model') ?? (await ask('Nazwa modelu', '', (value) => (value ? null : 'Nazwa modelu jest wymagana.')));
  } else {
    const model = flag('ai-model') ?? (await ask('Nazwa modelu (puste = domyślny)', ''));
    if (model) ai.AI_MODEL = model;
  }
  const key = flag('ai-api-key') ?? (await ask('Klucz API', ''));
  if (key) ai.AI_API_KEY = key;
}
rl?.close();

// ---------- 4. Zapis .env ----------
step('Zapis konfiguracji');
const envFile = resolve(ROOT, flag('config') ?? '.env');
if (existsSync(envFile)) {
  if (!args.flags.has('force')) {
    fail(`Plik ${envFile} już istnieje — nie nadpisuję. Uruchom z --force (powstanie kopia zapasowa) albo wskaż inny plik: --config <ścieżka>.`);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const backup = `${envFile}.kopia-${stamp}`;
  copyFileSync(envFile, backup);
  console.log(`  Kopia poprzedniego pliku: ${backup}`);
}

// Wartości ze spacją, #, cudzysłowem albo $ trafiają w apostrofy (bez interpretacji ukośników — ważne dla ścieżek Windows).
const quote = (value: string) => (/[\s#"'$`]/.test(value) ? (value.includes("'") ? `"${value}"` : `'${value}'`) : value);
const line = (key: string, value: string | undefined, comment?: string) => [comment ? `# ${comment}` : '', value === undefined ? `# ${key}=` : `${key}=${quote(value)}`].filter(Boolean).join('\n');
const now = new Date().toISOString();
const sections = [
  `# OŁCyŚ — konfiguracja wygenerowana przez kreator (pnpm run setup) ${now}.`,
  '# Plik zawiera sekrety — nie dodawaj go do repozytorium i ogranicz dostęp. Opis zmiennych: .env.example, docs/WDROZENIE.md.',
  '',
  '# ---------- Serwer ----------',
  line('API_PORT', port),
  line('API_HOST', host),
  line('OLCYS_API_TOKEN', token || undefined, 'Token API (Authorization: Bearer …). Pusty = bez tokenu.'),
  line('OLCYS_ALLOWED_HOSTS', allowedHosts || undefined, 'Dodatkowe nazwy hosta (po przecinku); adresy IP i localhost są dozwolone zawsze.'),
  '',
  '# ---------- Dane ----------',
  databaseUrl ? line('DATABASE_URL', databaseUrl, 'Zewnętrzny PostgreSQL.') : line('OLCYS_DATA_DIR', join(dataRoot, 'pg'), 'Wbudowana baza PGlite; migawka obok: <katalog>.migawka.tar.gz'),
  databaseUrl ? '' : line('OLCYS_SNAPSHOT_KEY', snapshotKey || undefined, 'Klucz szyfrowania migawki (64 znaki szesnastkowe). ZRÓB KOPIĘ — bez niego migawki nie da się odczytać.'),
  line('OLCYS_BACKUP_DIR', join(dataRoot, 'kopie'), 'Katalog kopii zapasowych (pnpm run backup).'),
  line('OLCYS_RETENTION_DAYS_CLOSED', retention || undefined, 'Po ilu dniach od zamknięcia usuwać sprawy (1–36500); puste = nie usuwać.'),
  line('OLCYS_ARCHIVE_DIR', undefined, `Pliki archiwów spraw na serwerze (np. ${join(dataRoot, 'archiwa')}); puste = archiwum tylko do pobrania.`),
  '',
  '# ---------- Źródła danych ----------',
  `# Tryb wybrany w kreatorze: ${mode === 'demo' ? 'dane syntetyczne' : mode === 'live' ? 'publiczne źródła' : 'oba (przełączane w interfejsie)'}.`,
  line('SANDBOX_URL', sandbox ? 'http://127.0.0.1:4100' : '', sandbox ? 'Piaskownica z danymi syntetycznymi.' : 'Pusta wartość wyłącza piaskownicę.'),
  line('OLCYS_START_SANDBOX', sandbox ? '1' : '0', '1 = „pnpm start” uruchamia też piaskownicę.'),
  line('ENABLE_LIVE', live ? '1' : undefined, 'Źródła i eksploratory w prawdziwym internecie.'),
  line('OLCYS_CONTACT', contact || undefined, 'Kontakt w nagłówku User-Agent (e-mail lub strona).'),
  ...['GITHUB_TOKEN', 'CEIDG_API_TOKEN', 'MARGINALIA_API_KEY', 'BLOCKSCOUT_API_KEY'].map((key) => line(key, keys[key])),
  '',
  '# ---------- Model językowy (domyślnie wyłączony) ----------',
  ...(Object.keys(ai).length > 0 ? Object.entries(ai).map(([key, value]) => line(key, value)) : [line('AI_PROVIDER', undefined, 'openai-compatible | anthropic | none'), line('AI_BASE_URL', undefined), line('AI_MODEL', undefined)]),
  '',
];
mkdirSync(dirname(envFile), { recursive: true });
writeFileSync(envFile, sections.filter((item, index, all) => !(item === '' && all[index - 1] === '')).join('\n'), { encoding: 'utf8', mode: 0o600 });
try {
  chmodSync(envFile, 0o600);
} catch {
  // Windows: uprawnienia według ACL katalogu.
}
if (!databaseUrl) mkdirSync(dataRoot, { recursive: true });
console.log(`  Zapisano: ${green(envFile)}`);

// ---------- 5. Podsumowanie ----------
const envArg = flag('config') ? ` -- --config ${envFile}` : '';
console.log(`
${bold('Podsumowanie')}
  Dane:            ${mode === 'demo' ? 'syntetyczne (piaskownica)' : mode === 'live' ? 'publiczne źródła w internecie' : 'syntetyczne i publiczne — przełącznik w interfejsie'}
  Adres:           http://${host === '0.0.0.0' ? '<adres-serwera>' : host}:${port}/
  Baza:            ${databaseUrl ? 'PostgreSQL' : `PGlite w ${join(dataRoot, 'pg')}`}${snapshotKey ? ', migawka szyfrowana' : ''}
  Token API:       ${token ? `ustawiony — wartość OLCYS_API_TOKEN w ${envFile} (wpisz ją w interfejsie)` : 'brak'}
  Retencja spraw:  ${retention ? `${retention} dni` : 'wyłączona'}
  Model językowy:  ${aiChoice === 'none' ? 'wyłączony' : aiChoice === 'local' ? `lokalny (${ai.AI_BASE_URL})` : `usługa zewnętrzna (${ai.AI_BASE_URL ?? ai.AI_PROVIDER})`}
${live && !contact ? yellow('  Uwaga: bez OLCYS_CONTACT zapytania do Wikidata mogą być blokowane.\n') : ''}${snapshotKey ? yellow('  Zrób kopię pliku .env w bezpiecznym miejscu — zawiera klucz migawki.\n') : ''}
${bold('Dalej')}
  pnpm run doctor${envArg}          sprawdzenie konfiguracji (z --online także łączności)
  pnpm start${envArg}               uruchomienie: API + interfejs${sandbox ? ' + piaskownica' : ''}
  pnpm run backup${envArg}          kopia zapasowa bazy
  node scripts/install-service.ts   instrukcja instalacji jako usługa systemowa
`);
