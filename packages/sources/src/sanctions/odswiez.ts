// Odświeżenie migawek oficjalnych list ryzyka (katalog data/). Po jednym żądaniu na listę, z jawnym
// nagłówkiem User-Agent; do wydawców list nie trafiają żadne dane analizy.
//
// Uruchomienie:  node packages/sources/src/sanctions/odswiez.ts [--pliki <katalog>] [--tylko ofac-sdn,ue-fsf,…]
//   --pliki <katalog>  zamiast pobierać, czyta wcześniej pobrane pliki: sdn.xml, eu.xml, uk.xml, mswia.html, hrtc-pl.html
//   --tylko <listy>    odświeża tylko wskazane listy
//
// Listy i podstawa prawna: docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 9. Lista Rady Bezpieczeństwa ONZ, Interpol,
// FATF i OpenSanctions NIE są pobierane (werdykt „nie” — tamże). Adresy kryptowalutowe OFAC odświeża
// osobno `node packages/chain/scripts/update-ofac.ts` (packages/chain/data/ofac-addresses.json).

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RiskListSnapshot } from '../../../core/src/sanctions/index.ts';
import { USER_AGENT } from '../http.ts';
import { parseEuFsf, parseEuHighRiskCountries, parseMswiaList, parseOfacSdn, parseUkSanctions } from './parse.ts';
import { SNAPSHOT_FILES } from './index.ts';

const TIMEOUT_MS = 20 * 60_000;

const SOURCES = {
  'ofac-sdn': {
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    file: 'sdn.xml',
    page: 'https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists',
    entryUrl: 'https://sanctionssearch.ofac.treas.gov/Details.aspx?id={id}',
    label: 'OFAC SDN (Departament Skarbu USA)',
    authority: 'Office of Foreign Assets Control, U.S. Department of the Treasury',
    licence: 'utwór rządu federalnego USA — bez ochrony prawem autorskim (17 U.S.C. § 105); lista publikowana do powszechnego stosowania',
    complete: '</sdnList>',
  },
  'ue-fsf': {
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
    file: 'eu.xml',
    page: 'https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions',
    label: 'Skonsolidowana lista sankcji finansowych UE',
    authority: 'Komisja Europejska (DG FISMA), Financial Sanctions Files',
    licence: 'CC BY 4.0 — decyzja Komisji 2011/833/UE o ponownym wykorzystywaniu dokumentów Komisji; źródło: © Unia Europejska',
    complete: '</export>',
  },
  'uk-sanctions': {
    url: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.xml',
    file: 'uk.xml',
    page: 'https://www.gov.uk/government/publications/the-uk-sanctions-list',
    entryUrl: 'https://sanctionslist.fcdo.gov.uk/docs/UK-Sanctions-List.html#{id}',
    label: 'UK Sanctions List (FCDO)',
    authority: 'Foreign, Commonwealth & Development Office (Wielka Brytania)',
    licence: 'Open Government Licence v3.0 — „Contains public sector information licensed under the Open Government Licence v3.0.”',
    complete: '</Designations>',
  },
  mswia: {
    url: 'https://www.gov.pl/web/mswia/lista-osob-i-podmiotow-objetych-sankcjami',
    file: 'mswia.html',
    page: 'https://www.gov.pl/web/mswia/lista-osob-i-podmiotow-objetych-sankcjami',
    label: 'Lista osób i podmiotów objętych sankcjami (MSWiA)',
    authority: 'Minister Spraw Wewnętrznych i Administracji — art. 2 ust. 1 ustawy z 13.04.2022 (Dz.U. 2022 poz. 835 ze zm.)',
    licence: 'informacja publiczna publikowana w BIP (art. 2 ust. 1 ustawy z 13.04.2022); ponowne wykorzystanie — ustawa z 11.08.2021 o otwartych danych, art. 5',
    complete: '</html>',
  },
  'ue-wysokie-ryzyko': {
    url: 'https://eur-lex.europa.eu/legal-content/PL/TXT/HTML/?uri=CELEX:02016R1675-20260129',
    file: 'hrtc-pl.html',
    page: 'https://eur-lex.europa.eu/legal-content/PL/ALL/?uri=CELEX:32016R1675',
    label: 'Państwa trzecie wysokiego ryzyka (UE, rozporządzenie delegowane 2016/1675)',
    authority: 'Komisja Europejska — rozporządzenie delegowane (UE) 2016/1675 z późn. zm. (odzwierciedla wykazy FATF)',
    licence: 'EUR-Lex: CC BY 4.0 (decyzja 2011/833/UE); tekst autentyczny — wyłącznie Dziennik Urzędowy UE',
    complete: '</html>',
  },
} as const;

type ListId = keyof typeof SOURCES;

const argument = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};

const filesDir = argument('--pliki');
const only = argument('--tylko')?.split(',').map((item) => item.trim()) as ListId[] | undefined;
const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));

async function download(url: string, complete: string): Promise<string> {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': USER_AGENT } });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let reported = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
    if (bytes - reported >= 5_000_000) {
      reported = bytes;
      console.log(`  pobrano ${(bytes / 1e6).toFixed(0)} MB…`);
    }
  }
  text += decoder.decode();
  if (!text.includes(complete)) throw new Error(`plik niekompletny (${bytes} bajtów, brak „${complete}”)`);
  return text;
}

/** Zapis: nagłówek czytelny, jeden wpis w wierszu (małe różnice przy kolejnych odświeżeniach). */
function writeSnapshot(path: string, snapshot: RiskListSnapshot) {
  const { entries, jurisdictions, ...header } = snapshot;
  const head = JSON.stringify(header, null, 1).replace(/\n}$/, '');
  const lines = [
    `${head},`,
    ` "entries": [${entries.length === 0 ? ']' : ''}`,
    ...entries.map((entry, index) => `  ${JSON.stringify(entry)}${index < entries.length - 1 ? ',' : ''}`),
    ...(entries.length > 0 ? [' ]'] : []),
  ];
  if (jurisdictions) {
    lines[lines.length - 1] += ',';
    lines.push(' "jurisdictions": [', ...jurisdictions.map((item, index) => `  ${JSON.stringify(item)}${index < jurisdictions.length - 1 ? ',' : ''}`), ' ]');
  }
  lines.push('}');
  writeFileSync(path, `${lines.join('\n')}\n`);
}

let failed = 0;
for (const [list, source] of Object.entries(SOURCES) as [ListId, (typeof SOURCES)[ListId]][]) {
  if (only && !only.includes(list)) continue;
  try {
    let content: string;
    let retrievedAt = new Date().toISOString();
    if (filesDir) {
      const path = join(filesDir, source.file);
      if (!existsSync(path)) throw new Error(`brak pliku ${path}`);
      content = readFileSync(path, 'utf8');
      // Data pobrania = czas zapisu pliku pobranego wcześniej.
      retrievedAt = statSync(path).mtime.toISOString();
      console.log(`Czytam ${path}`);
    } else {
      console.log(`Pobieram ${source.url}`);
      content = await download(source.url, source.complete);
      retrievedAt = new Date().toISOString();
    }
    const base = {
      list,
      label: source.label,
      authority: source.authority,
      source: source.url,
      page: source.page,
      ...('entryUrl' in source ? { entryUrl: source.entryUrl } : {}),
      retrievedAt,
      licence: source.licence,
    };
    let snapshot: RiskListSnapshot;
    if (list === 'ue-wysokie-ryzyko') {
      const { jurisdictions, unknown } = parseEuHighRiskCountries(content);
      if (unknown.length > 0) console.warn(`  nie rozpoznano państw: ${unknown.join(', ')}`);
      if (jurisdictions.length === 0) throw new Error('w załączniku nie znaleziono państw');
      // Wersja skonsolidowana z adresu CELEX (…-RRRRMMDD).
      const version = /-(\d{4})(\d{2})(\d{2})$/.exec(source.url);
      snapshot = { ...base, ...(version ? { publishedAt: `${version[1]}-${version[2]}-${version[3]}` } : {}), kind: 'jurisdiction', entries: [], jurisdictions };
    } else {
      const parsed =
        list === 'ofac-sdn' ? parseOfacSdn(content) : list === 'ue-fsf' ? parseEuFsf(content) : list === 'uk-sanctions' ? parseUkSanctions(content) : parseMswiaList(content, source.page);
      if (parsed.entries.length === 0) throw new Error('w pliku nie znaleziono wpisów');
      snapshot = { ...base, ...(parsed.publishedAt ? { publishedAt: parsed.publishedAt } : {}), kind: 'sanctions', entries: parsed.entries };
    }
    const output = join(DATA_DIR, SNAPSHOT_FILES[list]);
    writeSnapshot(output, snapshot);
    const size = readFileSync(output).byteLength;
    console.log(`  zapisano ${snapshot.entries.length || snapshot.jurisdictions?.length} wpisów → ${output} (${(size / 1e6).toFixed(2)} MB)`);
  } catch (error) {
    failed += 1;
    console.error(`  ${list}: nie udało się — ${error instanceof Error ? error.message : String(error)}; dotychczasowa migawka bez zmian.`);
  }
}
if (failed > 0) process.exitCode = 1;
