import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CSV_FILES,
  DEMO_EXPORT_NOTICE,
  EXPORT_FILES,
  addressesTable,
  buildCsvFiles,
  csvCell,
  decisionsTable,
  demoExportFile,
  excelDate,
  exportMeta,
  exportUrl,
  formatNumber,
  isExportDossier,
  relationsTable,
  servicesTable,
  syntheticData,
  toCsv,
} from '../src/export.ts';
import type { ExportDossier } from '../src/export.ts';

const ADDRESS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

const dossier = (connectorId = 'github'): ExportDossier =>
  ({
    caseId: 'sprawa-1',
    runId: 'analiza-1',
    generatedAt: '2026-11-21T10:00:00.000Z',
    subject: { name: 'Jan Kowalski', knownNames: [], identifiers: [] },
    persons: [{ id: 'p1', fullName: 'Jan Kowalski', nameVariants: [], probability: 72, reasons: [], attributes: [], profileIds: ['gh|janek'], addresses: [] }],
    profiles: [{ id: 'gh|janek', service: 'github.com', url: 'https://github.com/janek', handle: 'janek', attributes: {}, identityMatch: 'exact_identifier', identityReasons: ['ten sam e-mail'], identityScore: 85, addresses: [`bitcoin:${ADDRESS}`], evidenceIds: ['e1'] }],
    findings: [
      {
        address: ADDRESS,
        network: 'bitcoin',
        checksumVerified: true,
        subjectProbability: 61,
        evidence: [
          { id: 'e1', category: 'own_profile', service: 'github.com', url: 'https://github.com/janek', capturedAt: '2026-11-20T08:00:00.000Z', publishedAt: '2024-05-01T12:00:00.000Z', identityMatch: 'exact_identifier', title: '+48 600 000 000', excerpt: '…', contentHash: 'a'.repeat(64), connectorId, matchedIdentifier: { type: 'nick', value: 'janek' } },
        ],
        confidence: { score: 74.5, tier: 'prawdopodobne', excluded: false, ledger: [], nextSteps: [], independentSources: 1 },
        unrelatedPublishers: 0,
        chain: {
          profile: { address: ADDRESS, network: 'bitcoin', addressClass: 'private', classificationSource: 'etykiety publiczne', isContract: false, txCount: 1, totalReceived: 1, totalSent: 0.4, balance: 0.6, nativeAsset: 'BTC' },
          transfers: [],
          cashOuts: [],
          cashOutPlnByYear: { '2024': 1000.25, '2025': 2000 },
          limitations: [],
        },
      },
    ],
    relatedPersons: [],
    serviceLinks: [
      { id: 'kraken', name: 'Kraken; Ltd', kind: 'exchange', networks: ['bitcoin'], basis: ['transfer_out'], strength: 80, reasons: ['przelew'], inferredOnly: false, transfersOut: 2, transfersIn: 0, outPln: 3000.456, transfers: [], mentions: [], requestHints: [] },
    ],
    graph: {
      nodes: [
        { id: 'subject', kind: 'subject', label: 'Jan Kowalski' },
        { id: `addr:bitcoin:${ADDRESS}`, kind: 'address', label: '1A1z…fNa' },
      ],
      edges: [{ id: 'e', from: 'subject', to: `addr:bitcoin:${ADDRESS}`, kind: 'publishes', status: 'hypothesis', weight: 66.6, evidence: [{ kind: 'url', value: 'https://github.com/janek' }], explanation: 'Wniosek; do weryfikacji.' }],
    },
    timeline: [],
    totals: { linkedAddresses: 1, excludedAddresses: 0, topScore: 74, cashOutPlnByYear: {}, priority: 10, priorityReasons: [] },
    decisions: [{ id: 'd1', caseId: 'sprawa-1', target: 'link', key: 'a<->b', decision: 'rejected', decidedAt: '2026-11-21T09:00:00.000Z', withdrawnAt: '2026-11-21T09:05:00.000Z', withdrawnBy: 'analityk' }],
    keyFindings: [],
  }) as unknown as ExportDossier;

test('komórka CSV: neutralizacja formuł, cudzysłowy, liczby po polsku, wartości logiczne', () => {
  assert.equal(csvCell('=SUM(A1:A2)'), "'=SUM(A1:A2)");
  assert.equal(csvCell('+48 600'), "'+48 600");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('cytat "x"'), '"cytat ""x"""');
  assert.equal(csvCell('dwa\nwiersze'), '"dwa\nwiersze"');
  assert.equal(csvCell(' spacja'), '" spacja"');
  assert.equal(csvCell(-5), '-5');
  assert.equal(csvCell(0.4), '0,4');
  assert.equal(csvCell(true), 'tak');
  assert.equal(csvCell(undefined), '');
  assert.equal(formatNumber(1 / 3), '0,33333333');
  assert.equal(excelDate('2026-11-21T10:00:00.000Z'), '2026-11-21 10:00:00');
  assert.equal(excelDate('kiedyś'), 'kiedyś');
});

test('tabele: adresy z wypłatami, usługi, relacje ze statusem po polsku, decyzje wycofane', () => {
  const addresses = addressesTable(dossier());
  assert.equal(addresses.header.length, addresses.rows[0]!.length);
  const row = addresses.rows[0]!;
  assert.equal(row[1], 'Bitcoin');
  assert.equal(row[3], 74.5);
  assert.equal(row[7], 61);
  assert.equal(row[11], '2024-05-01 12:00:00');
  assert.equal(row[15], 3000.25);

  const services = toCsv(servicesTable(dossier()));
  assert.ok(services.includes('"Kraken; Ltd";Giełda;80;nie;2;0;3000,46;'));

  const relations = relationsTable(dossier());
  assert.deepEqual(relations.rows[0]!.slice(0, 6), ['Jan Kowalski', ADDRESS, 'publikacja adresu', undefined, 'hipoteza', 67]);

  const decisions = decisionsTable(dossier().decisions);
  assert.equal(decisions.rows[0]![1], 'para kont (wspólny operator)');
  assert.equal(decisions.rows[0]![9], false);
});

test('pliki CSV: komplet, BOM, separator „;”, nagłówek jak liczba kolumn', () => {
  const files = buildCsvFiles(dossier());
  assert.deepEqual(Object.keys(files), [...CSV_FILES]);
  for (const name of CSV_FILES) {
    const text = files[name];
    assert.ok(text.startsWith('﻿'), name);
    assert.ok(text.endsWith('\r\n'), name);
  }
  // Tytuł zaczynający się od „+” trafia do arkusza jako tekst.
  assert.ok(files['zrodla.csv'].includes(";'+48 600 000 000;"));
  assert.ok(files['profile.csv'].includes('janek;github.com;https://github.com/janek;85;Unikalny lub potwierdzony identyfikator;bez decyzji analityka;kandydat główny: Jan Kowalski;72;1;ten sam e-mail'));
});

test('nagłówek teczki: dane syntetyczne i tryb danych', () => {
  assert.equal(syntheticData(dossier()).flag, 'nie');
  assert.equal(syntheticData(dossier('sandbox-forum')).flag, 'tak');
  assert.equal(syntheticData(dossier('sandbox-forum'), ['github']).flag, 'częściowo');
  const meta = exportMeta(dossier('sandbox-forum'), { toolVersion: '0.1.0', generatedAt: '2026-11-21T10:00:00.000Z', caseName: 'Sprawa', run: { connectors: ['sandbox-forum'] }, rulesSha256: 'f'.repeat(64) });
  assert.equal(meta.dataMode.mode, 'sandbox');
  assert.equal(meta.rules.sha256, 'f'.repeat(64));
  assert.equal(meta.case.id, 'sprawa-1');
  assert.equal(meta.run.id, 'analiza-1');
});

test('tryb demo: pliki z przedrostkiem DEMO, teczka z uwagą, bez pakietu ZIP', () => {
  assert.ok(isExportDossier(dossier()));
  assert.ok(!isExportDossier({ caseId: 'x' }));
  assert.ok(!isExportDossier(null));
  const csv = demoExportFile(dossier(), 'adresy.csv', '2026-11-21T10:00:00.000Z')!;
  assert.equal(csv.fileName, 'DEMO-adresy.csv');
  assert.equal(csv.content, buildCsvFiles(dossier())['adresy.csv']);
  const json = JSON.parse(demoExportFile(dossier(), 'teczka.json', '2026-11-21T10:00:00.000Z')!.content);
  assert.equal(json.meta.uwaga, DEMO_EXPORT_NOTICE);
  assert.equal(json.meta.syntheticData.flag, 'tak');
  assert.equal(json.meta.dataMode.mode, 'sandbox');
  assert.equal(json.dossier.caseId, 'sprawa-1');
  assert.equal(demoExportFile(dossier(), 'pakiet.zip', '2026-11-21T10:00:00.000Z'), null);
  assert.equal(exportUrl('a b', 'adresy.csv'), '/api/cases/a%20b/export/adresy.csv');
  assert.equal(EXPORT_FILES.length, CSV_FILES.length + 2);
});
