// Ręczna próba: przeliczenie zapisanych trafień monitoringu nowymi regułami na KOPII migawki bazy
// (plik migawki jest tylko czytany; działający serwer i jego baza pozostają nietknięte).
//   node test/recheck-snapshot.manual.ts <ścieżka do .migawka.tar.gz>
// LIVE=1 włącza sprawdzanie adresów kontraktów u publicznych dostawców danych blockchain.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import * as chain from '@olcys/chain';
import type { ChainProvider, WatchHit } from '@olcys/core';
import { createMonitor } from '../src/monitor.ts';
import { createStorage } from '../src/storage.ts';

const snapshot = process.argv[2];
if (!snapshot) throw new Error('Podaj ścieżkę do pliku migawki bazy.');
const db = new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]) });
await db.waitReady;
const storage = createStorage({ query: async (sql, params) => (await db.query<Record<string, unknown>>(sql, params)).rows, close: () => db.close() });
await storage.migrate();

const enableLive = process.env.LIVE === '1';
const labels = chain.loadLabelFile(fileURLToPath(new URL('../data/labels.json', import.meta.resolve('@olcys/chain')))).entries;
const monitor = createMonitor({
  storage,
  connectors: [],
  chainProviders: enableLive ? (chain.createChainProviders as (config: Record<string, unknown>) => ChainProvider[])({ enableLive }) : [],
  resolveActivity: chain.getActivityFromProviders,
  addressLabels: labels.map(({ address, network, label, addressClass }) => ({ address, network, label, addressClass })),
  now: () => new Date(),
});

type Hit = WatchHit & { basis?: string; dismissReason?: string };
const summarize = (hits: Hit[]) => ({
  wszystkie: hits.length,
  nowe: hits.filter((hit) => hit.status === 'new').length,
  odrzucone: hits.filter((hit) => hit.status === 'dismissed').length,
  przeanalizowane: hits.filter((hit) => hit.status === 'analyzed').length,
});
const before = (await storage.listHits()) as Hit[];
console.log('przed:', JSON.stringify(summarize(before)));
console.log(
  '  nowe z adresem i związkiem z Polską = 0:', before.filter((hit) => hit.status === 'new' && hit.addresses.length > 0 && hit.polishNexus.score === 0).length,
  '| „polskie” bez adresu:', before.filter((hit) => hit.status === 'new' && hit.addresses.length === 0 && hit.polishNexus.score >= 40).length,
);

const started = Date.now();
const result = await monitor.recheck();
console.log(`recheck (${Date.now() - started} ms):`, JSON.stringify(result));

const after = (await storage.listHits()) as Hit[];
const kept = after.filter((hit) => hit.status === 'new');
console.log('po:', JSON.stringify(summarize(after)));
const count = (basis: string) => kept.filter((hit) => hit.basis === basis).length;
console.log(`  zostaje ${kept.length}: własny adres ${count('own_address')}, oferta + Polska ${count('offer_poland')}, adres + Polska ${count('address_poland')}`);
console.log(`  ze związkiem z Polską ≥ 40: ${kept.filter((hit) => hit.polishNexus.score >= 40).length}; z adresem: ${kept.filter((hit) => hit.addresses.length > 0).length}; bez autora: ${kept.filter((hit) => !hit.author).length}`);
const reasons = new Map<string, number>();
for (const hit of after.filter((item) => item.status === 'dismissed' && item.dismissReason)) {
  const key = hit.dismissReason!.replace(/^Nie spełnia kryteriów po zmianie reguł: Nie spełnia kryteriów trafienia: /, '');
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
console.log('  powody odrzucenia:', JSON.stringify([...reasons.entries()]));
const top = [...kept].sort((a, b) => b.polishNexus.score + b.suspicion.score - (a.polishNexus.score + a.suspicion.score)).slice(0, 5);
for (const hit of top) console.log(`  ${hit.polishNexus.score}+${hit.suspicion.score} [${hit.basis}] ${hit.service} — ${hit.title.slice(0, 80)} (autor: ${hit.author ?? '—'}, adresów ${hit.addresses.length})`);
const real = kept.filter((hit) => !hit.connectorId.startsWith('sandbox-'));
console.log(`  w tym ze źródeł prawdziwych: ${real.length}`);
for (const hit of [...real].sort((a, b) => b.polishNexus.score + b.suspicion.score - (a.polishNexus.score + a.suspicion.score)).slice(0, 8)) {
  console.log(`    ${hit.polishNexus.score}+${hit.suspicion.score} [${hit.basis}] ${hit.service} — ${hit.title.slice(0, 70)} (autor: ${hit.author ?? '—'}, adresów ${hit.addresses.length})`);
  // WHY=1: pierwsza przesłanka sygnałów — do oceny, czy reguła trafia w to, co powinna.
  if (process.env.WHY) console.log(`        ${(hit.suspicion.reasons[0] ?? '').slice(0, 170)}`);
}
await storage.close();
