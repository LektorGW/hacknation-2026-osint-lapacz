// Ręczna próba całości na piaskownicy (nie jest częścią `node --test test/*.test.ts`).
// Wymaga działającej piaskownicy: SANDBOX_URL (domyślnie http://localhost:4100).
// Nie otwiera portu — aplikacja jest wywoływana przez `app.inject`, baza żyje w pamięci.
//   node test/e2e-sandbox.manual.ts [identyfikator ...]

import { createChainProviders, getActivityFromProviders, matchService } from '@olcys/chain';
import { createConnectors } from '@olcys/sources';
import { buildApp } from '../src/app.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';

const sandboxUrl = process.env.SANDBOX_URL ?? 'http://localhost:4100';
const storage = createStorage(await createPgliteDriver());
await storage.migrate();
const app = await buildApp({
  storage,
  connectors: createConnectors({ sandboxUrl }),
  chainProviders: createChainProviders({ sandboxUrl }),
  resolveActivity: getActivityFromProviders,
  matchService,
});

const values = process.env.MONITOR || process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['kwrzosek_dev', 'Kacper Wrzosek', 'marek88', 'm.zielonka@skrzynka.example'];
for (const value of values) {
  const started = Date.now();
  const response = await app.inject({ method: 'POST', url: '/api/quick', payload: { value } });
  const { dossier } = response.json();
  console.log(`\n=== ${value} (HTTP ${response.statusCode}, ${Date.now() - started} ms) ===`);
  for (const person of dossier.persons) {
    console.log(`  osoba: ${person.fullName ?? '—'} ${person.probability}% profile=${person.profileIds.join(', ')} adresy=${JSON.stringify(person.addresses)}`);
  }
  for (const finding of dossier.findings) console.log(`  adres: ${finding.address} ${finding.confidence.score}%${finding.confidence.excluded ? ' (wykluczony)' : ''}`);
  for (const link of dossier.serviceLinks) console.log(`  usługa: ${link.name} [${link.kind}] siła ${link.strength} ${link.basis.join('+')} out=${link.outPln ?? '—'} PLN`);
  for (const person of dossier.relatedPersons) console.log(`  powiązana: ${person.handle} ${person.strength} ${person.relations.map((item: { kind: string }) => item.kind).join(',')}`);
  console.log(`  priorytet ${dossier.totals.priority}, graf ${dossier.graph.nodes.length}/${dossier.graph.edges.length}, oś czasu ${dossier.timeline.length}`);
  for (const item of dossier.keyFindings) console.log(`  • [${item.layer}] ${item.text}`);
}

if (process.env.SWEEP) {
  const started = Date.now();
  const sweep = (await app.inject({ method: 'POST', url: '/api/sweeps', payload: { limit: Number(process.env.SWEEP) } })).json();
  console.log(`\n=== przegląd źródeł (${Date.now() - started} ms): dokumentów ${sweep.documentsScanned}, wskazań ${sweep.leads.length} ===`);
  for (const lead of sweep.leads) console.log(`  ${lead.priority} ${lead.handle} wynik ${lead.topScore}% wypłaty ${lead.cashOutPlnTotal} zł`);
}
if (process.env.MONITOR) {
  const started = Date.now();
  const { status, newHits } = (await app.inject({ method: 'POST', url: '/api/monitor/run' })).json();
  console.log(`
=== monitoring (${Date.now() - started} ms): źródeł ${status.sources.length}, dokumentów ${status.totals.documentsSeen}, trafień ${status.totals.hits}, analiz ${status.totals.analyzed} ===`);
  for (const source of status.sources) console.log(`  źródło ${source.connectorId}: dokumentów ${source.documentsSeen}, trafień ${source.hits}${source.lastError ? `, BŁĄD ${source.lastError}` : ''}`);
  for (const hit of newHits) {
    console.log(`  ${hit.polishNexus.score}+${hit.suspicion.score} [${hit.language}] ${hit.status} ${hit.author ?? '—'} @ ${hit.service} adresów ${hit.addresses.length}${hit.lead ? ` → priorytet ${hit.lead.priority}, wynik ${hit.lead.topScore}%` : ''}`);
  }
  const top = newHits[0];
  if (top) {
    console.log('  przesłanki najwyższego trafienia:');
    for (const reason of [...top.polishNexus.reasons, ...top.suspicion.reasons]) console.log(`    ${reason}`);
  }
  const again = (await app.inject({ method: 'POST', url: '/api/monitor/run' })).json();
  console.log(`  drugi przebieg: nowych trafień ${again.newHits.length}`);
}
await app.close();
await storage.close();
