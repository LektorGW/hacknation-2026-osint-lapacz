// Ręczna próba głębokiego wyszukiwania na PRAWDZIWYCH danych (to nie jest test).
// Używaj wyłącznie identyfikatorów osób i organizacji publicznych, które same publikują
// swoje adresy (np. adres darowizn fundacji, nazwa ENS osoby publicznej). Wyników nie zapisuje.
//
//   node scripts/deep-check.ts <typ> <wartość> [--budget 45] [--connectors id1,id2] [--show 8]
//   node scripts/deep-check.ts crypto_address 1Archive1n2C579dMsAu3iC6tWzuQJz8dN
//   node scripts/deep-check.ts nick vbuterin --connectors deep-search,live-wayback-twitter
//
// Domyślnie uruchamia: deep-search, live-github-search (gdy jest GITHUB_TOKEN), live-walletexplorer,
// live-bitcoinwhoswho i live-wayback-twitter — te, które przyjmują podany typ identyfikatora.

import { extractAddresses } from '@olcys/core';
import type { Identifier, IdentifierType, SourceDocument } from '@olcys/core';
import { createConnectors } from '../src/index.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const [type, value] = args.filter((arg, index) => !arg.startsWith('--') && !(index > 0 && args[index - 1]!.startsWith('--'))) as [IdentifierType, string];
if (!type || !value) {
  console.error('Użycie: node scripts/deep-check.ts <typ> <wartość> [--budget 45] [--connectors id1,id2] [--show 8]');
  process.exit(1);
}
const budgetMs = Number(option('--budget') ?? 45) * 1000;
const show = Number(option('--show') ?? 8);
const wanted = option('--connectors')?.split(',') ?? ['deep-search', 'live-github-search', 'live-walletexplorer', 'live-bitcoinwhoswho', 'live-wayback-twitter'];

const identifier: Identifier = { type, value };
const connectors = createConnectors({ enableLive: true, githubToken: process.env.GITHUB_TOKEN, deepSearch: { budgetMs } }).filter(
  (connector) => wanted.includes(connector.id) && connector.accepts.includes(type),
);

console.log(`\n=== ${type} „${value}" — łączniki: ${connectors.map((connector) => connector.id).join(', ') || 'brak'} ===`);
const all: SourceDocument[] = [];
for (const connector of connectors) {
  const started = Date.now();
  let hitLines = 0;
  const documents = await connector.search(identifier, {
    log: (message) => {
      // Wpisy o pojedynczych trafieniach pokazujemy do limitu, podsumowania zawsze.
      const isHit = /znaleziono w|wypowiedzi konta/.test(message);
      if (!isHit || hitLines++ < show) console.log(`  [dziennik] ${message}`);
    },
  });
  all.push(...documents);
  const authors = new Set(documents.map((document) => `${document.service}|${document.author ?? ''}`));
  const withAddresses = documents.filter((document) => extractAddresses(document.text).length > 0).length;
  console.log(
    `  ${connector.id}: dokumentów ${documents.length}, autorów ${authors.size}, serwisów ${new Set(documents.map((document) => document.service)).size}, ` +
      `z adresem ${withAddresses}, czas ${Math.round((Date.now() - started) / 100) / 10} s`,
  );
}

console.log(`\n  Przykładowe dokumenty (${Math.min(show, all.length)} z ${all.length}):`);
for (const document of all.slice(0, show)) {
  console.log(`  - [${document.service}] ${document.author ?? '—'} · ${document.category} · ${document.identityMatch} · ${document.publishedAt?.slice(0, 10) ?? 'bez daty'}`);
  console.log(`    ${document.url}`);
  console.log(`    ${document.title.slice(0, 90)} — ${document.text.replace(/\s+/g, ' ').slice(0, 140)}`);
  const profile = document.profile;
  if (profile && (profile.displayName || profile.location)) console.log(`    profil: ${[profile.displayName, profile.location].filter(Boolean).join(', ')}`);
}
