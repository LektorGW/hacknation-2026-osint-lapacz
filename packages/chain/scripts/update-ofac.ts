// Jednorazowe odświeżenie lokalnej kopii adresów kryptowalutowych z listy
// sankcyjnej OFAC (SDN). Uruchomienie: `node scripts/update-ofac.ts`.
// Plik listy ma kilkadziesiąt MB i bywa serwowany powoli — pobieranie może
// potrwać kilka minut. Do serwera OFAC nie trafiają żadne dane analizy.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { USER_AGENT } from '../src/http.ts';
import { parseSdnXml } from '../src/ofac.ts';
import type { SanctionsFile } from '../src/ofac.ts';

// Adres `https://www.treasury.gov/ofac/downloads/sdn_advanced.xml` zwraca 404;
// działa usługa list sankcyjnych, która przekierowuje do pliku (HTTP 302).
const SOURCES = [
  'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
  'https://www.treasury.gov/ofac/downloads/sdn.xml',
];
const TIMEOUT_MS = 20 * 60_000;
const OUTPUT = fileURLToPath(new URL('../data/ofac-addresses.json', import.meta.url));

async function download(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': USER_AGENT },
  });
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
  if (!text.includes('</sdnList>')) throw new Error(`plik niekompletny (${bytes} bajtów, brak znacznika końca listy)`);
  return text;
}

let saved = false;
for (const url of SOURCES) {
  try {
    console.log(`Pobieram ${url}`);
    const xml = await download(url);
    const { publishDate, addresses } = parseSdnXml(xml);
    if (addresses.length === 0) throw new Error('w pliku nie znaleziono adresów kryptowalutowych');
    const file: SanctionsFile = {
      source: `OFAC SDN (${url})`,
      fetchedAt: new Date().toISOString(),
      ...(publishDate ? { publishDate } : {}),
      addresses,
    };
    writeFileSync(OUTPUT, `${JSON.stringify(file, null, 1)}\n`);
    const perAsset: Record<string, number> = {};
    for (const entry of addresses) perAsset[entry.asset] = (perAsset[entry.asset] ?? 0) + 1;
    console.log(`Zapisano ${addresses.length} adresów do ${OUTPUT}`, perAsset);
    saved = true;
    break;
  } catch (error) {
    console.error(`  nie udało się: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (!saved) {
  console.error('Lista nie została odświeżona — dotychczasowy plik (jeśli był) pozostaje bez zmian.');
  process.exitCode = 1;
}
