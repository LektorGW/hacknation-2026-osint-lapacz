// Ręczna próba łączników live na PRAWDZIWYCH serwisach (to nie jest test).
// Używaj wyłącznie kont osób i organizacji publicznych, które same publikują te dane.
//
//   node scripts/live-check.ts                         — domyślny zestaw, po jednym zapytaniu na serwis
//   node scripts/live-check.ts live-ens ens_name=vitalik.eth live-keybase nick=chris
//   node scripts/live-check.ts --record plik.json …    — zapisuje surowe odpowiedzi
//   node scripts/live-check.ts --replay plik.json …    — odtwarza zapisane odpowiedzi (bez sieci dla znanych adresów)
//
// Token GitHub (opcjonalny) jest czytany ze zmiennej GITHUB_TOKEN.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extractAddresses } from '@olcys/core';
import type { Identifier, IdentifierType } from '@olcys/core';
import { createConnectors } from '../src/index.ts';
import type { Fetcher } from '../src/index.ts';

interface Recorded {
  status: number;
  contentType: string;
  location: string;
  bodyBase64: string;
}

const DEFAULT_CHECKS: [string, string][] = [
  ['live-keybase', 'nick=chris'],
  ['live-ens', 'ens_name=vitalik.eth'],
  ['live-fediverse', 'nick=Gargron@mastodon.social'],
  ['live-telegram', 'messenger_id=durov'],
  ['live-github', 'login=torvalds'],
  ['live-github-gists', 'login=torvalds'],
  ['live-gravatar', 'nick=matt'],
  ['live-bitcointalk', 'profile_url=https://bitcointalk.org/index.php?action=profile;u=35'],
  ['live-www', 'profile_url=https://eugenrochko.com/'],
  ['live-wayback', 'profile_url=https://bitcoin.org/en/'],
];

const args = process.argv.slice(2);
let recordPath: string | undefined;
let replayPath: string | undefined;
const checks: [string, string][] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--record') recordPath = args[++i];
  else if (args[i] === '--replay') replayPath = args[++i];
  else if (args[i + 1]) checks.push([args[i]!, args[++i]!]);
}

const tape: Record<string, Recorded> =
  replayPath && existsSync(replayPath) ? (JSON.parse(readFileSync(replayPath, 'utf8')) as Record<string, Recorded>) : {};
let liveRequests = 0;

const NO_BODY = new Set([204, 205, 304]);
const toResponse = (item: Recorded) =>
  new Response(NO_BODY.has(item.status) ? null : Buffer.from(item.bodyBase64, 'base64'), {
    status: item.status,
    headers: { ...(item.contentType ? { 'content-type': item.contentType } : {}), ...(item.location ? { location: item.location } : {}) },
  });

const fetcher: Fetcher = async (url, init) => {
  const known = replayPath ? tape[url] : undefined;
  if (known) return toResponse(known);
  liveRequests += 1;
  const response = await fetch(url, init);
  const item: Recorded = {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    location: response.headers.get('location') ?? '',
    bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
  };
  tape[url] = item;
  return toResponse(item);
};

const connectors = createConnectors({ enableLive: true, githubToken: process.env.GITHUB_TOKEN, fetcher });

for (const [connectorId, spec] of checks.length > 0 ? checks : DEFAULT_CHECKS) {
  const connector = connectors.find((item) => item.id === connectorId);
  const separator = spec.indexOf('=');
  const identifier: Identifier = { type: spec.slice(0, separator) as IdentifierType, value: spec.slice(separator + 1) };
  console.log(`\n=== ${connectorId} ← ${identifier.type} „${identifier.value}" ===`);
  if (!connector) {
    console.log(`  nieznany łącznik; dostępne: ${connectors.map((item) => item.id).join(', ')}`);
    continue;
  }
  if (!connector.accepts.includes(identifier.type)) console.log(`  UWAGA: łącznik nie deklaruje typu ${identifier.type}`);
  const before = liveRequests;
  const started = Date.now();
  const documents = await connector.search(identifier, { log: (message) => console.log(`  [dziennik] ${message}`) });
  console.log(`  dokumentów: ${documents.length}; żądań do sieci: ${liveRequests - before}; czas: ${Date.now() - started} ms`);
  for (const document of documents) {
    const addresses = extractAddresses(document.text);
    console.log(`  - ${document.title}`);
    console.log(`    url: ${document.url}`);
    console.log(
      `    service: ${document.service}; autor: ${document.author ?? '—'}; kategoria: ${document.category}; powiązanie: ${document.identityMatch}` +
        `${document.publishedAt ? `; opublikowano: ${document.publishedAt}` : ''}${document.archivedAt ? `; kopia z: ${document.archivedAt}` : ''}`,
    );
    console.log(`    tekst: ${document.text.length} znaków; adresów: ${addresses.length}${addresses.length > 0 ? ` (${addresses.map((item) => `${item.network}:${item.address}`).join(', ')})` : ''}`);
    const discovered = document.discoveredIdentifiers ?? [];
    console.log(`    odkryte identyfikatory: ${discovered.length > 0 ? discovered.map((item) => `${item.type}=${item.value}`).join(', ') : 'brak'}`);
    console.log(`    początek: ${document.text.slice(0, 240).replace(/\n/g, ' ⏎ ')}`);
  }
}

if (recordPath) {
  writeFileSync(recordPath, JSON.stringify(tape, null, 1));
  console.log(`\nZapisano ${Object.keys(tape).length} odpowiedzi w ${recordPath}.`);
}
