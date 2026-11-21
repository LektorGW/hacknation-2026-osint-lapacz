// Adresy kryptowalutowe z listy sankcyjnej OFAC (SDN). Lista jest publiczna;
// lokalną kopię (`data/ofac-addresses.json`) odświeża `scripts/update-ofac.ts`.
// Sprawdzenie odbywa się lokalnie — badany adres nie jest nigdzie wysyłany.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeAddress } from './labels.ts';

export const OFAC_LABEL = 'Lista sankcyjna OFAC (SDN)';

export interface SanctionedAddress {
  address: string;
  /** Oznaczenie waluty z listy, np. `XBT`, `ETH`, `TRX`, `USDT`. */
  asset: string;
  /** Nazwa podmiotu objętego sankcjami, tak jak na liście. */
  entity: string;
}

export interface SanctionsFile {
  source: string;
  /** Czas pobrania listy (ISO 8601). */
  fetchedAt: string;
  /** Data publikacji podana w pliku listy. */
  publishDate?: string;
  addresses: SanctionedAddress[];
}

export interface SanctionsList {
  source: string;
  fetchedAt?: string;
  size: number;
  lookup(address: string): SanctionedAddress | undefined;
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/**
 * Wyciąga adresy kryptowalutowe z pliku `SDN.XML`: identyfikatory typu
 * „Digital Currency Address - XBT/ETH/TRX/USDT…” wraz z nazwą wpisu.
 */
export function parseSdnXml(xml: string): { publishDate?: string; addresses: SanctionedAddress[] } {
  const publishDate = /<Publish_Date>([^<]+)<\/Publish_Date>/.exec(xml)?.[1]?.trim();
  const addresses: SanctionedAddress[] = [];
  const seen = new Set<string>();
  for (const entry of xml.split('<sdnEntry>').slice(1)) {
    if (!entry.includes('Digital Currency Address')) continue;
    // Nazwa wpisu stoi przed listami aliasów i identyfikatorów.
    const head = entry.slice(0, entry.search(/<(programList|idList|akaList|addressList)>/));
    const first = /<firstName>([^<]*)<\/firstName>/.exec(head)?.[1];
    const last = /<lastName>([^<]*)<\/lastName>/.exec(head)?.[1];
    const entity = decodeXml([first, last].filter(Boolean).join(' ')) || 'podmiot bez nazwy';
    const pattern = /<idType>Digital Currency Address - ([^<]+)<\/idType>\s*<idNumber>([^<]+)<\/idNumber>/g;
    for (const match of entry.matchAll(pattern)) {
      const asset = decodeXml(match[1]!);
      const address = decodeXml(match[2]!);
      const key = `${asset}:${normalizeAddress(address)}`;
      if (address === '' || seen.has(key)) continue;
      seen.add(key);
      addresses.push({ address, asset, entity });
    }
  }
  return { ...(publishDate ? { publishDate } : {}), addresses };
}

export function createSanctionsList(file: Pick<SanctionsFile, 'addresses'> & Partial<SanctionsFile>): SanctionsList {
  const byAddress = new Map<string, SanctionedAddress>();
  for (const entry of file.addresses) byAddress.set(normalizeAddress(entry.address), entry);
  return {
    source: file.source ?? OFAC_LABEL,
    ...(file.fetchedAt ? { fetchedAt: file.fetchedAt } : {}),
    size: byAddress.size,
    lookup: (address) => byAddress.get(normalizeAddress(address)),
  };
}

let defaultSanctions: SanctionsList | undefined;

/** Lokalna kopia listy; pusta, gdy pliku jeszcze nie pobrano. */
export function getDefaultSanctions(): SanctionsList {
  if (defaultSanctions) return defaultSanctions;
  const path = fileURLToPath(new URL('../data/ofac-addresses.json', import.meta.url));
  let file: SanctionsFile | undefined;
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SanctionsFile;
      if (Array.isArray(parsed.addresses)) file = parsed;
    } catch {
      // Uszkodzony plik traktujemy jak brak listy.
    }
  }
  defaultSanctions = createSanctionsList(file ?? { addresses: [] });
  return defaultSanctions;
}

/** Etykieta adresu z listy, z nazwą podmiotu i datą pobrania kopii. */
export function sanctionLabel(entry: SanctionedAddress): string {
  return `${OFAC_LABEL}: ${entry.entity}`;
}

/** Ostrzeżenie do `limitations` — trafienie wymaga potwierdzenia w aktualnej liście. */
export function sanctionWarning(list: SanctionsList, entry: SanctionedAddress, role: 'badany adres' | 'kontrahent'): string {
  const copy = list.fetchedAt ? ` (kopia listy pobrana ${list.fetchedAt.slice(0, 10)})` : '';
  return (
    `OSTRZEŻENIE — ${OFAC_LABEL}: ${role} ${entry.address} figuruje na liście jako adres ${entry.asset} ` +
    `podmiotu „${entry.entity}”${copy}. Potwierdź w aktualnej liście OFAC przed wykorzystaniem tej informacji.`
  );
}
