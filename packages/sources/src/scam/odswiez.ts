// Odświeżenie migawek publicznych zbiorów ostrzeżeń o oszustwach (katalog data/). Po jednym żądaniu na zbiór,
// z jawnym nagłówkiem User-Agent; do wydawców zbiorów nie trafiają żadne dane analizy (pobieramy cały plik,
// sprawdzanie adresów i domen odbywa się lokalnie).
//
// Uruchomienie:  node packages/sources/src/scam/odswiez.ts [--pliki <katalog>]
//   --pliki <katalog>  zamiast pobierać, czyta wcześniej pobrane pliki: addresses-darklist.json, config.json
//
// Zbiory i podstawa prawna: docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja „Ostrzeżenia o możliwym oszustwie”. CryptoScamDB (brak licencji), Chainabuse
// (regulaminu nie udało się przeczytać) i adresy ScamSniffer (porzucone od 02.2024) NIE są pobierane.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { USER_AGENT } from '../http.ts';
import { SCAM_SOURCES } from './index.ts';
import type { ScamAddressSnapshot, ScamDomainSnapshot } from './index.ts';

const DATA_DIR = new URL('./data/', import.meta.url);
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const localDir = argument('--pliki');

async function load(url: string, file: string): Promise<string> {
  if (localDir) return readFileSync(join(localDir, file), 'utf8');
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

const retrievedAt = new Date().toISOString();

// 1. MyEtherWallet ethereum-lists — „addresses-darklist.json” (licencja MIT).
{
  const source = SCAM_SOURCES['mew-darklist'];
  const raw = JSON.parse(await load(source.download, 'addresses-darklist.json')) as { address?: string; comment?: string; date?: string }[];
  const entries = raw
    .filter((item) => typeof item.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(item.address.trim()))
    .map((item) => ({ address: item.address!.trim(), comment: (item.comment ?? '').trim().slice(0, 300), ...(item.date ? { date: item.date } : {}) }));
  const snapshot: ScamAddressSnapshot = { list: 'mew-darklist', retrievedAt, sourceUrl: source.download, entries };
  writeFileSync(new URL('mew-darklist.json', DATA_DIR), `${JSON.stringify(snapshot)}\n`);
  console.log(`mew-darklist: ${entries.length} adresów (odrzucono ${raw.length - entries.length} wpisów bez poprawnego adresu)`);
}

// 2. MetaMask eth-phishing-detect — lista domen phishingowych (licencja DBAD 1.2), bez list rozmytych.
{
  const source = SCAM_SOURCES['metamask-phishing'];
  const raw = JSON.parse(await load(source.download, 'config.json')) as { blacklist?: string[]; whitelist?: string[]; version?: number };
  const clean = (items: string[] | undefined) => [...new Set((items ?? []).map((item) => item.trim().toLowerCase()).filter((item) => /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(item)))].sort();
  const snapshot: ScamDomainSnapshot = { list: 'metamask-phishing', retrievedAt, sourceUrl: source.download, ...(raw.version !== undefined ? { version: raw.version } : {}), blacklist: clean(raw.blacklist), whitelist: clean(raw.whitelist) };
  writeFileSync(new URL('metamask-phishing.json', DATA_DIR), `${JSON.stringify(snapshot)}\n`);
  console.log(`metamask-phishing: ${snapshot.blacklist.length} domen na liście, ${snapshot.whitelist.length} na liście dozwolonych`);
}
