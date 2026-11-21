// Ręczna próba monitoringu na PRAWDZIWYCH źródłach (to nie jest test): jeden oszczędny
// przebieg `discover` po włączonych wpisach rejestru config/monitor-sources/*.json.
// Na końcu wypisuje zestawienie i zapisuje je do config/monitor-sources/STATUS.md.
//
//   node scripts/monitor-check.ts                  — cały rejestr
//   node scripts/monitor-check.ts --only id1,id2   — wybrane wpisy (bez zapisu STATUS.md)
//   node scripts/monitor-check.ts --engine reddit  — jeden silnik (bez zapisu STATUS.md)
//   node scripts/monitor-check.ts --all            — także wpisy wyłączone (bez zapisu STATUS.md)
//   node scripts/monitor-check.ts --limit 20 --concurrency 8 --budget 900
//   node scripts/monitor-check.ts --json plik      — pełne wyniki (bez treści postów) do pliku
//   node scripts/monitor-check.ts --no-status      — bez zapisu STATUS.md
//
// Token GitHub (opcjonalny, tylko dla silnika github-search) jest czytany z GITHUB_TOKEN.

import { writeFileSync } from 'node:fs';
import { extractAddresses } from '@olcys/core';
import { createConnectors, loadMonitorSources, monitorSourceCommunity, monitorSourceHost, runMonitorPass, summarizeMonitorSources } from '../src/index.ts';
import type { MonitorPassResult, MonitorSourceConfig } from '../src/index.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const limit = Number(option('--limit') ?? 20);
const concurrency = Number(option('--concurrency') ?? 8);
const budgetMs = Number(option('--budget') ?? 900) * 1000;
const only = option('--only')?.split(',').map((item) => item.trim());
const engineFilter = option('--engine');
const partial = Boolean(only || engineFilter || args.includes('--all'));

const registry = loadMonitorSources();
let sources: MonitorSourceConfig[] = registry.sources;
if (args.includes('--all')) sources = sources.map((source) => ({ ...source, enabled: true }));
if (only) sources = sources.filter((source) => only.includes(source.id));
if (engineFilter) sources = sources.filter((source) => source.engine === engineFilter);

const connectors = createConnectors({ enableLive: true, monitorSources: sources, githubToken: process.env.GITHUB_TOKEN });
let done = 0;
const pass = await runMonitorPass(connectors, {
  limit,
  concurrency,
  budgetMs,
  onResult: (result) => {
    done += 1;
    if (done % 25 === 0) console.error(`… ${done} źródeł, ostatnie: ${result.source.id} (${result.status})`);
  },
});

const STATUS_LABEL: Record<MonitorPassResult['status'], string> = {
  ok: 'działa',
  empty: 'pusto',
  refused: 'odmowa (403/429)',
  skipped_refused_host: 'pominięte — host odmówił w tym przebiegu',
  skipped_budget: 'pominięte — budżet czasu',
  error: 'błąd',
};

const withAddresses = (result: MonitorPassResult) => result.documents.filter((document) => extractAddresses(document.text).length > 0).length;
const withAuthor = (result: MonitorPassResult) => result.documents.filter((document) => document.author).length;
const reason = (result: MonitorPassResult) =>
  result.messages
    .map((line) => line.replace(`${result.source.label}: `, ''))
    .join(' | ')
    .replace(/\|/g, '/')
    .slice(0, 160);

const responding = pass.results.filter((result) => result.status === 'ok');
const all = summarizeMonitorSources(registry.sources);
const tried = summarizeMonitorSources(pass.results.map((result) => result.source));
const working = summarizeMonitorSources(responding.map((result) => result.source));
const date = new Date().toISOString().slice(0, 10);
const table = (totals: Record<string, number>) => Object.entries(totals).map(([key, value]) => `${key}: ${value}`).join(', ') || '—';
const statusCounts: Record<string, number> = {};
for (const result of pass.results) statusCounts[STATUS_LABEL[result.status]] = (statusCounts[STATUS_LABEL[result.status]] ?? 0) + 1;

const lines: string[] = [
  '# Monitoring: stan rejestru źródeł',
  '',
  `Próba z ${date} (\`node scripts/monitor-check.ts\`): jeden przebieg \`discover\`, limit ${limit} postów na źródło, ${concurrency} hostów naraz, czas ${Math.round(pass.durationMs / 1000)} s.`,
  '',
  '## Trzy liczby',
  '',
  '| | Odrębne hosty | Odrębne społeczności | Wpisy |',
  '|---|---|---|---|',
  `| Rejestr — wpisy włączone | ${all.hosts} | ${all.communities} | ${all.enabledEntries} (wszystkich: ${all.entries}) |`,
  `| Rejestr — bez wpisów o niskiej trafności | ${all.relevantHosts} | ${all.relevantCommunities} | ${all.relevantEntries} |`,
  `| Odpowiedziały w próbie (zwróciły publikacje) | ${working.hosts} | ${working.communities} | ${working.enabledEntries} |`,
  `| Odpowiedziały w próbie — bez wpisów o niskiej trafności | ${working.relevantHosts} | ${working.relevantCommunities} | ${working.relevantEntries} |`,
  '',
  'Host: dla forów, kanałów RSS i Discourse — host strony; Reddit i Telegram to po jednym hoście; dla Mastodona i Lemmy — host instancji. ' +
    'Społeczność: host forum, subreddit, kanał Telegram, społeczność Lemmy na instancji. ' +
    'Niska trafność: wpisy, których `note` zawiera „niska trafność” lub „niższa trafność” (ogólne fora niezwiązane z krypto, powtórzone strumienie federowanych hashtagów).',
  '',
  '## Wynik próby',
  '',
  `- Źródeł w próbie: ${pass.results.length}; ${table(statusCounts)}.`,
  `- Publikacji łącznie: ${pass.results.reduce((sum, result) => sum + result.documents.length, 0)}, w tym z adresem kryptowalutowym: ${pass.results.reduce((sum, result) => sum + withAddresses(result), 0)}.`,
  `- Żądań łącznie: ${pass.results.reduce((sum, result) => sum + result.requests, 0)}.`,
  `- Hosty, które odmówiły (reszta ich kolejki pominięta): ${pass.refusedHosts.join(', ') || 'brak'}.`,
  `- Pliki rejestru: ${registry.files.join(', ') || 'brak'}.`,
  '',
  '## Wpisy włączone według silnika, języka i regionu',
  '',
  '| | Rejestr | Odpowiedziały |',
  '|---|---|---|',
  `| Silnik | ${table(all.byEngine)} | ${table(working.byEngine)} |`,
  `| Język | ${table(all.byLanguage)} | ${table(working.byLanguage)} |`,
  `| Region | ${table(all.byRegion)} | ${table(working.byRegion)} |`,
  '',
  '## Źródła, które nie zwróciły publikacji',
  '',
];
const failing = pass.results.filter((result) => result.status !== 'ok');
if (failing.length === 0) lines.push('Brak.');
else {
  lines.push('| Źródło (id) | Silnik | Wynik | Powód |', '|---|---|---|---|');
  for (const result of failing) lines.push(`| ${result.source.label} (\`${result.source.id}\`) | ${result.source.engine} | ${STATUS_LABEL[result.status]} | ${reason(result) || '—'} |`);
}
lines.push('', '## Ostrzeżenia rejestru (wpisy błędne i powtórzone)', '');
if (registry.warnings.length === 0) lines.push('Brak.');
else for (const warning of registry.warnings) lines.push(`- ${warning}`);
lines.push('', '## Źródła działające', '', '| Źródło (id) | Silnik | Host | Język | Posty | Z autorem | Z adresami | Najnowszy |', '|---|---|---|---|---|---|---|---|');
for (const result of responding) {
  lines.push(
    `| ${result.source.label} (\`${result.source.id}\`) | ${result.source.engine} | ${monitorSourceCommunity(result.source) || monitorSourceHost(result.source)} | ${result.source.language ?? '—'} | ` +
      `${result.documents.length} | ${withAuthor(result)} | ${withAddresses(result)} | ${result.documents[0]?.publishedAt?.slice(0, 10) ?? '—'} |`,
  );
}
const report = `${lines.join('\n')}\n`;

console.log(report);
if (partial) console.log(`(Próba częściowa: ${tried.enabledEntries} wpisów — STATUS.md bez zmian.)`);
else if (!args.includes('--no-status')) {
  const target = new URL('../config/monitor-sources/STATUS.md', import.meta.url);
  writeFileSync(target, report);
  console.log(`Zapisano ${target.pathname}`);
}

const jsonPath = option('--json');
if (jsonPath) {
  writeFileSync(
    jsonPath,
    JSON.stringify(
      pass.results.map((result) => ({
        id: result.source.id,
        engine: result.source.engine,
        status: result.status,
        posts: result.documents.length,
        withAuthor: withAuthor(result),
        withAddresses: withAddresses(result),
        requests: result.requests,
        ms: result.durationMs,
        messages: result.messages,
        sample: result.documents.slice(0, 2).map((document) => ({ url: document.url, author: document.author, title: document.title.slice(0, 80), profile: document.profile })),
      })),
      null,
      1,
    ),
  );
}
