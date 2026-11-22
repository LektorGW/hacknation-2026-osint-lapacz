// Sprawdzenie ręczne (bez internetu): piaskownica w tym procesie, analiza adresu „rozdania” z data/scam.ts,
// teczka z dokumentami — ostrzeżenia o możliwym oszustwie. Uruchomienie: node test/scam-sandbox.manual.ts

import type { AddressInfo } from 'node:net';
import { DEFAULT_RULES } from '@olcys/core';
import { createChainProviders } from '@olcys/chain';
import { createConnectors } from '@olcys/sources';
import { buildApp } from '../../sandbox/src/app.ts';
import { SCAM_ADDR } from '../../sandbox/data/scam.ts';
import { runAnalysis } from '../src/analysis.ts';
import { buildDossier } from '../src/dossier.ts';

const app = buildApp();
await app.listen({ port: 0, host: '127.0.0.1' });
const sandboxUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
try {
  const query = { identifiers: [{ type: 'crypto_address' as const, value: SCAM_ADDR.giveawayBtc }] };
  const connectors = createConnectors({ sandboxUrl }).filter((connector) => connector.enabledByDefault);
  const result = await runAnalysis({ query, connectors, chainProviders: createChainProviders({ sandboxUrl }) });
  const dossier = buildDossier({
    caseSummary: { id: 's', name: 'Rozdanie', createdAt: new Date().toISOString(), query, runs: [], status: 'open' },
    run: { id: 'r', caseId: 's', startedAt: '', status: 'completed', query, connectors: [], findings: result.findings, log: result.log },
    intel: result.intel,
    decisions: [],
    otherCases: [],
    rules: DEFAULT_RULES,
    now: new Date(),
    documents: result.documents,
  });
  const scam = dossier.scamWarnings;
  console.log('Osoby:', dossier.persons.map((person) => person.profileIds));
  console.log('Poziom:', scam.level, '—', scam.statement);
  for (const item of scam.addresses) {
    console.log(item.address, item.level, item.score, item.components.map((component) => `${component.rule}:${component.weight}`).join(', '));
    for (const pub of item.publications) console.log('  ', pub.kind, pub.origin, pub.author, pub.url, '|', pub.quote);
  }
  console.log('Ustalenia:', dossier.keyFindings.filter((entry) => entry.text.startsWith('Ostrzeżenie')).map((entry) => entry.text));
} finally {
  await app.close();
}
