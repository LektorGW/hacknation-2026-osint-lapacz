// Archiwum sprawy: jeden plik ZIP z kompletem materiału przed zamknięciem lub usunięciem sprawy.
//
// Zawartość:
//   MANIFEST.json            — lista plików z SHA-256 i rozmiarem, metadane generowania, wersja narzędzia, skrót reguł,
//   CZYTAJ-MNIE.txt          — opis i sumy kontrolne w formacie `sha256sum`,
//   sprawa.json              — sprawa (identyfikatory wejściowe, stan, powód zamknięcia),
//   pakiet.zip               — pakiet eksportu ostatniej analizy (ten sam co „Pakiet ZIP” w teczce),
//   raport.html, raport.json — raport ostatniej analizy (te same co trasy /api/runs/:id/report.*),
//   analizy/<id>.json        — każda analiza sprawy (pełny wynik),
//   dowody/<id>/<sha256>.txt — kopie treści źródeł dokładnie w postaci, z której policzono skrót śladu,
//   dowody/<id>/spis.json    — opis kopii (adres, tytuł, serwis, czasy pobrania i archiwizacji),
//   decyzje.json, odpowiedzi-uslug.json, rozwiniecia-sieci.json, dziennik-audytu.json.
// W bazie zostaje tylko skrót SHA-256 archiwum i metadane — plik trafia na dysk wyłącznie przy OLCYS_ARCHIVE_DIR.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { rulesSha256, writeZip } from './export.ts';
import { internalHeaders } from './security.ts';
import type { CaseArchiveMeta, CaseSummary, Storage } from './storage.ts';

export const ARCHIVE_FORMAT = 'olcys-archiwum-sprawy/1';

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export interface ManifestFile {
  name: string;
  sha256: string;
  bytes: number;
}

export interface ArchiveManifest {
  format: string;
  tool: { name: string; version: string };
  generatedAt: string;
  rulesSha256: string;
  case: { id: string; name: string; createdAt: string; status: string; closedAt?: string; closedReason?: string };
  counts: { runs: number; documents: number; decisions: number; serviceReplies: number; networkExpansions: number; auditEntries: number };
  /** Kopie treści, których skrót SHA-256 różni się od zapisanego w analizie (powinno być 0). */
  evidenceMismatches: number;
  files: ManifestFile[];
}

export interface BuiltArchive {
  zip: Buffer;
  sha256: string;
  manifest: ArchiveManifest;
  meta: CaseArchiveMeta;
}

/** Bezpieczna nazwa wpisu ZIP z identyfikatora technicznego (bez ścieżek i znaków specjalnych). */
const entryId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'brak';

export async function buildCaseArchive(input: {
  app: FastifyInstance;
  storage: Storage;
  summary: CaseSummary;
  toolVersion: string;
  rules: unknown;
  generatedAt: string;
}): Promise<BuiltArchive> {
  const { app, storage, summary, generatedAt } = input;
  const files: { name: string; data: Buffer }[] = [];
  const add = (name: string, data: Buffer | string) => files.push({ name, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data });
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  add('sprawa.json', json({
    id: summary.id,
    name: summary.name,
    createdAt: summary.createdAt,
    status: summary.status,
    ...(summary.closedAt ? { closedAt: summary.closedAt } : {}),
    ...(summary.closedReason ? { closedReason: summary.closedReason } : {}),
    query: summary.query,
    runs: summary.runs,
  }));

  // Raporty i pakiet eksportu z istniejących tras — te same pliki, które analityk pobiera z teczki.
  const latest = summary.runs.filter((run) => run.status === 'completed').at(-1);
  const internal = async (url: string) => {
    const response = await app.inject({ method: 'GET', url, headers: internalHeaders() });
    return response.statusCode === 200 ? response.rawPayload : null;
  };
  if (latest) {
    const id = encodeURIComponent(latest.id);
    const pakiet = await internal(`/api/cases/${encodeURIComponent(summary.id)}/export/pakiet.zip?run=${id}`);
    if (pakiet) add('pakiet.zip', pakiet);
    const html = await internal(`/api/runs/${id}/report.html`);
    if (html) add('raport.html', html);
    const report = await internal(`/api/runs/${id}/report.json`);
    if (report) add('raport.json', report);
  }

  let documents = 0;
  let mismatches = 0;
  for (const brief of summary.runs) {
    const run = await storage.getRun(brief.id);
    if (run) add(`analizy/${entryId(brief.id)}.json`, json(run));
    const copies = await storage.listDocuments(brief.id);
    if (copies.length === 0) continue;
    const index: Record<string, unknown>[] = [];
    for (const copy of copies) {
      const text = Buffer.from(copy.text, 'utf8');
      const matches = sha256(text) === copy.contentHash;
      if (!matches) mismatches += 1;
      const name = `dowody/${entryId(brief.id)}/${entryId(copy.contentHash)}.txt`;
      // Ta sama treść pod kilkoma adresami URL — jedna kopia, kilka wpisów w spisie.
      if (!files.some((file) => file.name === name)) add(name, text);
      index.push({
        plik: name,
        contentHash: copy.contentHash,
        zgodnyZeSkrotem: matches,
        url: copy.url,
        title: copy.title,
        service: copy.service,
        connectorId: copy.connectorId,
        ...(copy.author ? { author: copy.author } : {}),
        ...(copy.publishedAt ? { publishedAt: copy.publishedAt } : {}),
        ...(copy.archivedAt ? { archivedAt: copy.archivedAt } : {}),
        fetchedAt: copy.fetchedAt,
      });
      documents += 1;
    }
    add(`dowody/${entryId(brief.id)}/spis.json`, json(index));
  }

  const [decisions, replies, expansions, audit] = await Promise.all([
    storage.listDecisions(summary.id),
    storage.listServiceReplies(summary.id),
    storage.listNetworkExpansions(summary.id),
    storage.listAudit({ caseId: summary.id, limit: 5000 }),
  ]);
  add('decyzje.json', json(decisions));
  add('odpowiedzi-uslug.json', json(replies));
  add('rozwiniecia-sieci.json', json(expansions));
  add('dziennik-audytu.json', json(audit));

  const manifest: ArchiveManifest = {
    format: ARCHIVE_FORMAT,
    tool: { name: 'OŁCyŚ — OSINTowy Łapacz Cyfrowych Śladów', version: input.toolVersion },
    generatedAt,
    rulesSha256: rulesSha256(input.rules),
    case: {
      id: summary.id,
      name: summary.name,
      createdAt: summary.createdAt,
      status: summary.status,
      ...(summary.closedAt ? { closedAt: summary.closedAt } : {}),
      ...(summary.closedReason ? { closedReason: summary.closedReason } : {}),
    },
    counts: {
      runs: summary.runs.length,
      documents,
      decisions: decisions.length,
      serviceReplies: replies.length,
      networkExpansions: expansions.length,
      auditEntries: audit.length,
    },
    evidenceMismatches: mismatches,
    files: files.map((file) => ({ name: file.name, sha256: sha256(file.data), bytes: file.data.length })),
  };
  const manifestText = json(manifest);
  const readme = [
    `${manifest.tool.name}, wersja ${manifest.tool.version}`,
    `Archiwum sprawy: ${summary.name} (${summary.id})`,
    `Wygenerowano: ${generatedAt}`,
    `Reguły oceny (SHA-256): ${manifest.rulesSha256}`,
    `Format: ${ARCHIVE_FORMAT}`,
    '',
    'Archiwum zawiera komplet materiału sprawy: analizy, kopie treści źródeł (dowody), decyzje analityka,',
    'odpowiedzi usług, rozwinięcia sieci i dziennik audytu. MANIFEST.json opisuje każdy plik (SHA-256, rozmiar).',
    'Skrót SHA-256 całego archiwum jest zapisany w bazie narzędzia — pozwala wykazać, że plik nie został zmieniony.',
    '',
    'Sumy SHA-256 (format sha256sum):',
    `${sha256(manifestText)}  MANIFEST.json`,
    ...manifest.files.map((file) => `${file.sha256}  ${file.name}`),
    '',
  ].join('\r\n');

  const when = new Date(generatedAt);
  const zip = writeZip(
    [{ name: 'MANIFEST.json', data: manifestText }, { name: 'CZYTAJ-MNIE.txt', data: readme }, ...files],
    Number.isNaN(when.getTime()) ? new Date() : when,
  );
  const digest = sha256(zip);
  return {
    zip,
    sha256: digest,
    manifest,
    meta: {
      generatedAt,
      bytes: zip.length,
      files: files.length + 2,
      manifestSha256: sha256(manifestText),
      toolVersion: input.toolVersion,
      rulesSha256: manifest.rulesSha256,
    },
  };
}

/** Nazwa pliku archiwum: wyłącznie czas i skrót — bez nazwy sprawy ani innych danych z żądania. */
export const archiveFileName = (generatedAt: string, digest: string): string =>
  `olcys-archiwum-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${digest.slice(0, 16)}.zip`;

/** Ścieżka pliku w katalogu archiwów; odrzuca nazwy spoza wzorca i wyjście poza katalog (path traversal). */
export function archivePath(dir: string, name: string): string {
  if (!/^olcys-archiwum-\d{1,14}-[0-9a-f]{16}\.zip$/.test(name)) throw new Error('Nieprawidłowa nazwa pliku archiwum.');
  const base = resolve(dir);
  const full = resolve(base, name);
  if (!full.startsWith(base + sep)) throw new Error('Ścieżka archiwum wychodzi poza katalog archiwów.');
  return full;
}

/** Zapis archiwum do OLCYS_ARCHIVE_DIR (plik tymczasowy + zmiana nazwy). Zwraca nazwę pliku. */
export function storeArchive(dir: string, archive: BuiltArchive): string {
  mkdirSync(resolve(dir), { recursive: true });
  const name = archiveFileName(archive.meta.generatedAt, archive.sha256);
  const full = archivePath(dir, name);
  writeFileSync(`${full}.tmp`, archive.zip, { mode: 0o600 });
  renameSync(`${full}.tmp`, full);
  return name;
}

/** Odczyt zapisanego archiwum ze sprawdzeniem skrótu; `null`, gdy pliku nie ma. */
export function loadStoredArchive(dir: string, name: string, expectedSha256: string): Buffer | null {
  const full = archivePath(dir, name);
  if (!existsSync(full)) return null;
  const data = readFileSync(full);
  if (sha256(data) !== expectedSha256) throw new Error('Plik archiwum na dysku nie zgadza się ze skrótem SHA-256 zapisanym w bazie.');
  return data;
}

/** Odczyt wpisów ZIP zapisanych przez `writeZip` (deflate) — do sprawdzania archiwum i w testach. */
export function readZipEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('To nie jest archiwum ZIP.');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localName = zip.readUInt16LE(local + 26);
    const localExtra = zip.readUInt16LE(local + 28);
    const data = zip.subarray(local + 30 + localName + localExtra, local + 30 + localName + localExtra + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : Buffer.from(data));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Sprawdza archiwum: każdy plik z manifestu istnieje i ma zgodny SHA-256. Zwraca listę rozbieżności. */
export function verifyArchive(zip: Buffer): string[] {
  const entries = readZipEntries(zip);
  const manifestData = entries.get('MANIFEST.json');
  if (!manifestData) return ['brak MANIFEST.json'];
  const manifest = JSON.parse(manifestData.toString('utf8')) as ArchiveManifest;
  const problems: string[] = [];
  for (const file of manifest.files) {
    const data = entries.get(file.name);
    if (!data) problems.push(`brak pliku ${file.name}`);
    else if (sha256(data) !== file.sha256) problems.push(`niezgodny SHA-256: ${file.name}`);
  }
  return problems;
}

