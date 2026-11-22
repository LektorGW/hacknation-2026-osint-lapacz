// Publiczne zbiory ostrzeżeń o oszustwach — migawki lokalne (adres ani domena nie opuszczają systemu).
//
// Zbiory (licencje sprawdzone 22.11.2026, docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja „Ostrzeżenia o możliwym oszustwie”):
//   - MyEtherWallet ethereum-lists, `addresses-darklist.json` (MIT) — adresy Ethereum, które według
//     opiekunów listy „zasługują na ostrzeżenie” (phishing, fałszywe rozdania, podszywanie się);
//   - MetaMask eth-phishing-detect, `config.json` (DBAD 1.2) — domeny phishingowe (lista dozwolonych ma pierwszeństwo).
// Trafienie to FAKT O LIŚCIE z dnia migawki (`source_fact`): zgłoszenie społeczności, nie ustalenie organu
// i nie wskazanie właściciela adresu. Brak trafienia niczego nie dowodzi.
// Odświeżanie: `node packages/sources/src/scam/odswiez.ts`.

import { readFileSync } from 'node:fs';

export const SCAM_SOURCES = {
  'mew-darklist': {
    label: 'MyEtherWallet ethereum-lists — adresy z ostrzeżeniem (addresses-darklist)',
    page: 'https://github.com/MyEtherWallet/ethereum-lists',
    download: 'https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json',
    licence: 'MIT (Copyright (c) 2020 MyEtherWallet)',
    purpose: 'lista adresów, które według opiekunów „zasługują na ostrzeżenie” (README: „A list of addresses that deserve to be accompanied by a warning.”); wpisy dodawane przez społeczność',
  },
  'metamask-phishing': {
    label: 'MetaMask eth-phishing-detect — domeny phishingowe',
    page: 'https://github.com/MetaMask/eth-phishing-detect',
    download: 'https://raw.githubusercontent.com/MetaMask/eth-phishing-detect/main/src/config.json',
    licence: "DON'T BE A DICK PUBLIC LICENSE 1.2 (atrybucja: źródło podane przy każdym trafieniu)",
    purpose: 'lista domen stron phishingowych i podszywających się pod usługi kryptowalutowe (pole `blacklist`, z listą dozwolonych `whitelist`)',
  },
} as const;

export type ScamListId = keyof typeof SCAM_SOURCES;

export interface ScamAddressSnapshot {
  list: 'mew-darklist';
  retrievedAt: string;
  sourceUrl: string;
  entries: { address: string; comment: string; date?: string }[];
}

export interface ScamDomainSnapshot {
  list: 'metamask-phishing';
  retrievedAt: string;
  sourceUrl: string;
  version?: number;
  blacklist: string[];
  whitelist: string[];
}

export const SCAM_LIST_CAVEAT =
  'Wpis w społecznościowym zbiorze ostrzeżeń z dnia migawki — fakt o liście (zgłoszenie), nie ustalenie organu i nie wskazanie właściciela adresu. Brak wpisu niczego nie dowodzi.';

export interface ScamListAddressFlag {
  address: string;
  list: ScamListId;
  listLabel: string;
  /** Opis wpisu tak, jak podał zbiór (oryginalny język). */
  comment: string;
  /** Data wpisu według zbioru. */
  date?: string;
  retrievedAt: string;
  url: string;
  licence: string;
  status: 'source_fact';
  caveat: string;
}

export interface ScamListDomainFlag {
  /** Sprawdzana domena (host). */
  domain: string;
  /** Wpis listy, który pasuje (ta sama domena albo domena nadrzędna). */
  matched: string;
  list: ScamListId;
  listLabel: string;
  retrievedAt: string;
  url: string;
  licence: string;
  status: 'source_fact';
  caveat: string;
}

export interface LoadedScamLists {
  addresses: Map<string, ScamAddressSnapshot['entries'][number]>;
  addressSnapshot?: { retrievedAt: string; count: number };
  blacklist: Set<string>;
  whitelist: Set<string>;
  domainSnapshot?: { retrievedAt: string; count: number };
  /** Zbiory, których migawki nie udało się wczytać. */
  missing: ScamListId[];
}

const DATA_DIR = new URL('./data/', import.meta.url);

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(new URL(file, DATA_DIR), 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Zbiory z podanych migawek (testy) albo z plików w `data/`. */
export function loadScamLists(input: { addresses?: ScamAddressSnapshot; domains?: ScamDomainSnapshot } = {}): LoadedScamLists {
  const addressSnapshot = input.addresses ?? readJson<ScamAddressSnapshot>('mew-darklist.json');
  const domainSnapshot = input.domains ?? readJson<ScamDomainSnapshot>('metamask-phishing.json');
  const missing: ScamListId[] = [];
  if (!addressSnapshot) missing.push('mew-darklist');
  if (!domainSnapshot) missing.push('metamask-phishing');
  return {
    addresses: new Map((addressSnapshot?.entries ?? []).map((entry) => [entry.address.toLowerCase(), entry])),
    ...(addressSnapshot ? { addressSnapshot: { retrievedAt: addressSnapshot.retrievedAt, count: addressSnapshot.entries.length } } : {}),
    blacklist: new Set(domainSnapshot?.blacklist ?? []),
    whitelist: new Set(domainSnapshot?.whitelist ?? []),
    ...(domainSnapshot ? { domainSnapshot: { retrievedAt: domainSnapshot.retrievedAt, count: domainSnapshot.blacklist.length } } : {}),
    missing,
  };
}

let cached: LoadedScamLists | undefined;
export function getDefaultScamLists(): LoadedScamLists {
  cached ??= loadScamLists();
  return cached;
}

/** Adresy (Ethereum i sieci EVM — bez rozróżniania wielkości liter) wpisane do zbioru ostrzeżeń. */
export function scamListAddressFlags(addresses: string[], lists: LoadedScamLists = getDefaultScamLists()): ScamListAddressFlag[] {
  const source = SCAM_SOURCES['mew-darklist'];
  const flags: ScamListAddressFlag[] = [];
  const seen = new Set<string>();
  for (const address of addresses) {
    const key = address.trim().toLowerCase();
    if (seen.has(key) || !/^0x[0-9a-f]{40}$/.test(key)) continue;
    seen.add(key);
    const entry = lists.addresses.get(key);
    if (!entry) continue;
    flags.push({
      address,
      list: 'mew-darklist',
      listLabel: source.label,
      comment: entry.comment,
      ...(entry.date ? { date: entry.date } : {}),
      retrievedAt: lists.addressSnapshot?.retrievedAt ?? '',
      url: source.page,
      licence: source.licence,
      status: 'source_fact',
      caveat: SCAM_LIST_CAVEAT,
    });
  }
  return flags;
}

/** Host z adresu URL albo z samej nazwy domeny; `undefined`, gdy to nie domena. */
export function hostOf(value: string): string | undefined {
  const text = value.trim().toLowerCase();
  let host = text;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(text) ? text : `http://${text}`).hostname;
  } catch {
    return undefined;
  }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) ? host : undefined;
}

/** Domeny (lub adresy URL) z listy phishingowej — ta sama domena albo domena nadrzędna; lista dozwolonych ma pierwszeństwo. */
export function scamListDomainFlags(values: string[], lists: LoadedScamLists = getDefaultScamLists()): ScamListDomainFlag[] {
  const source = SCAM_SOURCES['metamask-phishing'];
  const flags: ScamListDomainFlag[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const host = hostOf(value);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const labels = host.split('.');
    const candidates = labels.slice(0, -1).map((_, index) => labels.slice(index).join('.'));
    if (candidates.some((item) => lists.whitelist.has(item))) continue;
    const matched = candidates.find((item) => lists.blacklist.has(item));
    if (!matched) continue;
    flags.push({
      domain: host,
      matched,
      list: 'metamask-phishing',
      listLabel: source.label,
      retrievedAt: lists.domainSnapshot?.retrievedAt ?? '',
      url: source.page,
      licence: source.licence,
      status: 'source_fact',
      caveat: SCAM_LIST_CAVEAT,
    });
  }
  return flags;
}
