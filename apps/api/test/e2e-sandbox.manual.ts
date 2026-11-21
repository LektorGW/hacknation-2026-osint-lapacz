// Ręczna próba całości (nie jest częścią `node --test test/*.test.ts`). Nie otwiera portu —
// aplikacja jest wywoływana przez `app.inject`, baza żyje w pamięci.
//   node test/e2e-sandbox.manual.ts [identyfikator ...]
// Zmienne: SANDBOX_URL (domyślnie http://localhost:4100; `off` wyłącza piaskownicę),
//   LIVE=1 — źródła w prawdziwym internecie, DEPTH=deep — analiza głęboka,
//   SWEEP=<limit> — przegląd źródeł, MONITOR=1 — przebieg monitoringu.

import * as chain from '@olcys/chain';
import * as sources from '@olcys/sources';
import type { ChainProvider } from '@olcys/core';
import { buildApp } from '../src/app.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';

const sandboxUrl = process.env.SANDBOX_URL === 'off' ? undefined : (process.env.SANDBOX_URL ?? 'http://localhost:4100');
const enableLive = process.env.LIVE === '1';
const depth = process.env.DEPTH === 'deep' ? 'deep' : 'standard';
const storage = createStorage(await createPgliteDriver());
await storage.migrate();
const createProviders = chain.createChainProviders as (config: Record<string, unknown>) => ChainProvider[];
const app = await buildApp({
  storage,
  connectors: sources.createConnectors({ sandboxUrl, enableLive, githubToken: process.env.GITHUB_TOKEN || undefined }),
  chainProviders: createProviders({ sandboxUrl, enableLive }),
  deepChainProviders: createProviders({ sandboxUrl, enableLive, depth: 'deep' }),
  resolveActivity: chain.getActivityFromProviders,
  matchService: chain.matchService,
  normalizeText: (sources as { normalizeAddressText?: (text: string) => string }).normalizeAddressText,
});

const defaults = ['kwrzosek_dev', 'Kacper Wrzosek', 'marek88', 'm.zielonka@skrzynka.example'];
const values = process.env.MONITOR || process.argv.slice(2).length > 0 ? process.argv.slice(2) : defaults;
for (const value of values) {
  const started = Date.now();
  const response = await app.inject({ method: 'POST', url: '/api/quick', payload: { value, depth } });
  const body = response.json();
  console.log(`\n=== ${value} [${depth}] (HTTP ${response.statusCode}, ${Date.now() - started} ms) ===`);
  if (!body.dossier) {
    console.log(JSON.stringify(body));
    continue;
  }
  const { dossier } = body;
  const run = (await app.inject(`/api/runs/${dossier.runId}`)).json();
  console.log(`  łączniki: ${run.connectors.length}; wpisów dziennika: ${run.log.length}; wynik częściowy: ${dossier.partial}`);
  for (const person of dossier.persons.slice(0, 6)) {
    console.log(`  osoba: ${person.fullName ?? '—'} ${person.probability}% profile=${person.profileIds.join(', ')} adresy=${JSON.stringify(person.addresses)}`);
  }
  if (dossier.persons.length > 6) console.log(`  … oraz ${dossier.persons.length - 6} dalszych kandydatów`);
  for (const mention of dossier.mentions) console.log(`  wzmianki: ${mention.identifier.type} „${mention.identifier.value}” — ${mention.documents} publikacji, ${mention.authors} autorów, ${mention.services} serwisów`);
  for (const finding of dossier.findings.slice(0, 12)) {
    console.log(`  adres: ${finding.address} ${finding.confidence.score}% (osoba–adres ${finding.subjectProbability}%)${finding.confidence.excluded ? ' wykluczony' : ''}${finding.widelyCited ? ' powszechnie cytowany' : ''}${finding.chainSkipped ? ' bez łańcucha' : ''} cytujących=${finding.unrelatedPublishers}`);
    for (const note of finding.annotations ?? []) console.log(`      · ${note.slice(0, 200)}`);
  }
  if (dossier.findings.length > 12) console.log(`  … oraz ${dossier.findings.length - 12} dalszych adresów`);
  for (const proof of dossier.cashOutProof.slice(0, 5)) console.log(`  dowód: ${proof.statement} [${proof.tier}, ${proof.addressBasis}]`);
  for (const link of dossier.serviceLinks.slice(0, 10)) console.log(`  usługa: ${link.name} [${link.kind}] siła ${link.strength} ${link.basis.join('+')} out=${link.outPln ?? '—'} PLN`);
  for (const identity of dossier.linkedIdentities ?? []) {
    console.log(`  tożsamość: ${identity.displayName} [${identity.relation}] siła ${identity.score}; wypłaty ${JSON.stringify(identity.cashOutPlnByYear)}`);
    console.log(`      ścieżka: ${identity.path.join(' → ').slice(0, 300)}`);
    console.log(`      przesłanka: ${identity.reasons[0].text.slice(0, 220)}`);
  }
  for (const person of dossier.relatedPersons.slice(0, 5)) console.log(`  powiązana: ${person.handle} ${person.strength} ${person.relations.map((item: { kind: string }) => item.kind).join(',')}`);
  console.log(`  priorytet ${dossier.totals.priority}, graf ${dossier.graph.nodes.length}/${dossier.graph.edges.length}, oś czasu ${dossier.timeline.length}`);
  for (const item of dossier.keyFindings) console.log(`  • [${item.layer}] ${item.text}`);
  const timing = (await app.inject(`/api/runs/${dossier.runId}/progress`)).json();
  console.log(`  czasy faz: ${(timing.timings ?? []).map((item: { stage: string; ms: number }) => `${item.stage} ${(item.ms / 1000).toFixed(1)} s`).join(', ')}`);
  for (const query of timing.slowestQueries ?? []) console.log(`  wolne zapytanie: ${query.connectorId} ${query.identifier.type} „${query.identifier.value}” ${(query.ms / 1000).toFixed(1)} s, dokumentów ${query.documents}`);
  if (process.env.LOG) for (const entry of run.log.filter((item: { message: string }) => /limit|wzmianki|Krok|Odkryty|Czas faz|pominięto|Start analizy|Rozszerz|Trop|0x5E0361/.test(item.message) && !/403/.test(item.message)).slice(0, 60)) console.log(`  dziennik: ${entry.message.slice(0, 220)}`);
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
  console.log(`\n=== monitoring (${Date.now() - started} ms): źródeł ${status.sources.length}, dokumentów ${status.totals.documentsSeen}, trafień ${status.totals.hits}, analiz ${status.totals.analyzed} ===`);
  for (const hit of newHits.slice(0, 15)) {
    console.log(`  ${hit.polishNexus.score}+${hit.suspicion.score} [${hit.language}] ${hit.status} ${hit.author ?? '—'} @ ${hit.service} adresów ${hit.addresses.length}${hit.lead ? ` → priorytet ${hit.lead.priority}, wynik ${hit.lead.topScore}%` : ''}`);
  }
  console.log(`  indeks publikacji: ${JSON.stringify((await app.inject('/api/corpus/stats')).json())}`);
  const again = (await app.inject({ method: 'POST', url: '/api/monitor/run' })).json();
  console.log(`  drugi przebieg: nowych trafień ${again.newHits.length}`);
}
await app.close();
await storage.close();
