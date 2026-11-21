// Eksport danych sprawy po stronie usługi: tabele CSV, teczka JSON z nagłówkiem metadanych i pakiet ZIP.
// Kolumny CSV i nagłówek teczki składa ten sam czysty moduł co przeglądarka w trybie demo
// (apps/web/src/export.ts — tylko typy i słowniki etykiet, bez DOM), więc pliki są identyczne.
// Archiwum ZIP pisze minimalny zapis bez zależności: deflate i CRC-32 z `node:zlib`, katalog centralny.

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import { CSV_FILES, EXPORT_FILES, EXPORT_NOTICE, buildCsvFiles, dossierJson, exportMeta } from '../../web/src/export.ts';
import type { CsvFileName, ExportDecision, ExportDossier, ExportMeta } from '../../web/src/export.ts';

export { CSV_FILES, EXPORT_FILES } from '../../web/src/export.ts';
export type { CsvFileName } from '../../web/src/export.ts';

/** Skrót SHA-256 jawnych reguł oceny — wersja reguł w nagłówku eksportu. */
export const rulesSha256 = (rules: unknown): string => createHash('sha256').update(JSON.stringify(rules)).digest('hex');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

// ---------- ZIP ----------

/** Data i czas w formacie MS-DOS — czas lokalny maszyny, tak jak pokazują go programy do archiwów. */
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, when.getFullYear()));
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/** Archiwum ZIP: wpisy skompresowane metodą deflate (8), sumy CRC-32, katalog centralny. Nazwy w UTF-8 (bit 11). */
export function writeZip(entries: { name: string; data: Buffer | string }[], modified: Date): Buffer {
  const { time, date } = dosDateTime(modified);
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : entry.data;
    const compressed = deflateRawSync(raw);
    const checksum = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    parts.push(local, name, compressed);
    directory.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

// ---------- Pliki eksportu ----------

export interface CaseExport {
  meta: ExportMeta;
  csv: Record<CsvFileName, string>;
  json: string;
}

/** Wszystkie pliki eksportu sprawy z jednej teczki. `decisions` — pełny rejestr decyzji (z wycofanymi). */
export function buildCaseExport(
  dossier: ExportDossier,
  input: { toolVersion: string; generatedAt: string; caseName: string; caseCreatedAt?: string; run: { startedAt?: string; finishedAt?: string; connectors: string[] }; rules: unknown; decisions: ExportDecision[] },
): CaseExport {
  const meta = exportMeta(dossier, { ...input, rulesSha256: rulesSha256(input.rules) });
  return { meta, csv: buildCsvFiles(dossier, input.decisions), json: dossierJson(meta, dossier) };
}

/** Plik CZYTAJ-MNIE.txt pakietu: opis plików, format CSV i sumy SHA-256 do sprawdzenia integralności. */
function readme(meta: ExportMeta, files: { name: string; data: Buffer | string }[]): string {
  const description = new Map<string, string>([
    ...EXPORT_FILES.map((file): [string, string] => [file.name, file.description]),
    ['analiza.json', 'Pełny zapis analizy (jak GET /api/runs/:id/report.json): przebieg, reguły, łączniki, decyzje, kopie treści źródeł.'],
  ]);
  return [
    `${meta.tool.name}, wersja ${meta.tool.version}`,
    `Sprawa: ${meta.case.name} (${meta.case.id})`,
    `Analiza: ${meta.run.id}`,
    `Wygenerowano: ${meta.generatedAt}`,
    `Reguły oceny (SHA-256): ${meta.rules.sha256 ?? 'brak'}`,
    `Tryb danych: ${meta.dataMode.label}`,
    `Dane syntetyczne: ${meta.syntheticData.flag} — ${meta.syntheticData.label}`,
    '',
    EXPORT_NOTICE,
    '',
    'Pliki CSV: UTF-8 z BOM, separator „;”, przecinek dziesiętny, daty „RRRR-MM-DD GG:MM:SS” w UTC.',
    'Komórki tekstowe zaczynające się od = + - @ mają na początku apostrof (ochrona przed formułami).',
    '',
    'Pliki i sumy SHA-256:',
    ...files.map((file) => `${sha256(file.data)}  ${file.name}${description.has(file.name) ? ` — ${description.get(file.name)}` : ''}`),
    '',
  ].join('\r\n');
}

/** Pakiet ZIP: tabele CSV, teczka JSON, opcjonalnie pełna analiza (`analiza.json`) i CZYTAJ-MNIE.txt z sumami SHA-256. */
export function buildPackage(content: CaseExport, analysisJson?: string): Buffer {
  const files: { name: string; data: string }[] = [
    ...CSV_FILES.map((name) => ({ name, data: content.csv[name] })),
    { name: 'teczka.json', data: content.json },
    ...(analysisJson ? [{ name: 'analiza.json', data: analysisJson }] : []),
  ];
  const generated = new Date(content.meta.generatedAt);
  return writeZip([...files, { name: 'CZYTAJ-MNIE.txt', data: readme(content.meta, files) }], Number.isNaN(generated.getTime()) ? new Date() : generated);
}
