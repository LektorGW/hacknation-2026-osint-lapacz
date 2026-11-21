// Zbiór etykiet znanych adresów i klasyfikacja adresu.
// Klasyfikacja decyduje, czy adres w ogóle można przypisać osobie (giełdy,
// kontrakty, miksery są wykluczane) oraz czy przelew na niego jest oznaką wypłaty.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressClass, CashOutKind, Network } from '@olcys/core';

export interface LabelEntry {
  address: string;
  network: Network;
  label: string;
  addressClass: AddressClass;
  /** Rodzaj usługi istotny dla wykrywania wypłat. */
  kind?: CashOutKind;
  /** Symbol tokena emitowanego przez kontrakt — pozwala odróżnić prawdziwy USDT od podróbki. */
  asset?: string;
}

export interface LabelSet {
  /** Nazwa zbioru, trafia do `classificationSource`. */
  name: string;
  lookup(network: Network, address: string): LabelEntry | undefined;
}

const NETWORKS: Network[] = ['bitcoin', 'bitcoin-testnet', 'ethereum', 'tron'];
const CLASSES: AddressClass[] = ['private', 'unknown', 'exchange', 'smart_contract', 'charity', 'mixer', 'institutional'];
const KINDS: CashOutKind[] = ['exchange_deposit', 'p2p_service', 'payment_gateway', 'crypto_card', 'stablecoin_swap'];

/** Adresy EVM i bech32 nie rozróżniają wielkości liter; Base58 rozróżnia. */
export function normalizeAddress(address: string): string {
  return /^(0x|bc1|tb1)/i.test(address) ? address.toLowerCase() : address;
}

export function createLabelSet(entries: LabelEntry[], name: string): LabelSet {
  const byKey = new Map<string, LabelEntry>();
  for (const entry of entries) {
    byKey.set(`${entry.network}:${normalizeAddress(entry.address)}`, entry);
  }
  return {
    name,
    lookup: (network, address) => byKey.get(`${network}:${normalizeAddress(address)}`),
  };
}

/** Wczytuje plik etykiet i odrzuca go z czytelnym komunikatem, gdy wpis jest błędny. */
export function loadLabelFile(path: string): { name: string; entries: LabelEntry[] } {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown; labels?: unknown };
  if (!Array.isArray(parsed.labels)) {
    throw new Error(`Plik etykiet ${path}: brak tablicy "labels".`);
  }
  const entries = parsed.labels.map((raw: Partial<LabelEntry>, index) => {
    const where = `Plik etykiet ${path}, wpis ${index + 1}`;
    if (typeof raw.address !== 'string' || raw.address === '') throw new Error(`${where}: brak pola "address".`);
    if (typeof raw.label !== 'string' || raw.label === '') throw new Error(`${where}: brak pola "label".`);
    if (!NETWORKS.includes(raw.network as Network)) throw new Error(`${where}: nieznana sieć "${raw.network}".`);
    if (!CLASSES.includes(raw.addressClass as AddressClass)) {
      throw new Error(`${where}: nieznana klasa adresu "${raw.addressClass}".`);
    }
    if (raw.kind !== undefined && !KINDS.includes(raw.kind)) throw new Error(`${where}: nieznany rodzaj "${raw.kind}".`);
    return raw as LabelEntry;
  });
  return { name: typeof parsed.name === 'string' ? parsed.name : path, entries };
}

/**
 * Zbiór wbudowany (`data/labels.json`) uzupełniony o etykiety analityka
 * (`data/labels.local.json`, jeśli istnieje). Wpis analityka zastępuje wbudowany.
 */
export function loadDefaultLabels(): LabelSet {
  const builtIn = loadLabelFile(fileURLToPath(new URL('../data/labels.json', import.meta.url)));
  const localPath = fileURLToPath(new URL('../data/labels.local.json', import.meta.url));
  const local = existsSync(localPath) ? loadLabelFile(localPath).entries : [];
  return createLabelSet([...builtIn.entries, ...local], builtIn.name);
}

let defaultLabels: LabelSet | undefined;

export function getDefaultLabels(): LabelSet {
  defaultLabels ??= loadDefaultLabels();
  return defaultLabels;
}

// Nazwy usług rozpoznawane w etykietach zwracanych przez źródło danych, gdy samo
// źródło nie podaje klasy adresu (np. znacznik „Binance 14” w eksploratorze).
// Lista jest jawna i edytowalna: `data/service-keywords.json`.

export type ServiceCategory = 'exchange' | 'p2p' | 'payment_gateway' | 'crypto_card';

export interface ServiceKeyword {
  name: string;
  category: ServiceCategory;
  keywords: string[];
}

const SERVICE_CATEGORIES: ServiceCategory[] = ['exchange', 'p2p', 'payment_gateway', 'crypto_card'];

interface ServiceMatcher extends ServiceKeyword {
  pattern: RegExp;
}

let serviceMatchers: ServiceMatcher[] | undefined;

function getServiceMatchers(): ServiceMatcher[] {
  if (serviceMatchers) return serviceMatchers;
  const path = fileURLToPath(new URL('../data/service-keywords.json', import.meta.url));
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { services?: ServiceKeyword[] };
  serviceMatchers = (parsed.services ?? [])
    .filter((item) => SERVICE_CATEGORIES.includes(item.category) && Array.isArray(item.keywords) && item.keywords.length > 0)
    .map((item) => {
      const words = item.keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
      // Całe słowa: „gate” nie może pasować do „gateway” ani „Stargate”.
      return { ...item, pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'iu') };
    });
  return serviceMatchers;
}

/** Usługa rozpoznana po nazwie w podanej kategorii (domyślnie w dowolnej). */
export function matchService(text: string | undefined, category?: ServiceCategory): ServiceKeyword | undefined {
  if (!text) return undefined;
  return getServiceMatchers().find((item) => (category === undefined || item.category === category) && item.pattern.test(text));
}

const MIXER_NAMES = /(tornado|mixer|mikser|wasabi|samourai|bitcoinfog|bitcoin fog|sinbad|blender\.io|chipmixer)/i;

const KIND_BY_CATEGORY: { category: ServiceCategory; kind: CashOutKind }[] = [
  { category: 'crypto_card', kind: 'crypto_card' },
  { category: 'p2p', kind: 'p2p_service' },
  { category: 'payment_gateway', kind: 'payment_gateway' },
];

/** Rodzaj usługi wypłaty wynikający z klasy adresu lub słów kluczowych etykiety. */
export function inferKind(label: string | undefined, addressClass: AddressClass): CashOutKind | undefined {
  const byKeyword = label
    ? (KIND_BY_CATEGORY.find((item) => matchService(label, item.category))?.kind ??
      (/stablecoin/i.test(label) ? ('stablecoin_swap' as const) : undefined))
    : undefined;
  return byKeyword ?? (addressClass === 'exchange' ? 'exchange_deposit' : undefined);
}

export interface ClassifyHints {
  /** Zbiór etykiet; domyślnie wbudowany. */
  labels?: LabelSet;
  /** Etykieta i klasa podane przez źródło danych (eksplorator, API). */
  sourceLabel?: string;
  sourceClass?: AddressClass;
  sourceKind?: CashOutKind;
  /** Nazwa źródła danych, do `classificationSource`. */
  sourceName?: string;
  /** Czy pod adresem jest kod kontraktu. */
  isContract?: boolean;
  /** Liczba transakcji adresu; brak wartości oznacza brak danych o historii. */
  txCount?: number;
}

export interface Classification {
  addressClass: AddressClass;
  label?: string;
  kind?: CashOutKind;
  classificationSource: string;
}

/**
 * Kolejność rozstrzygania: zbiór etykiet → etykieta/klasa ze źródła danych →
 * kod kontraktu → historia transakcji bez etykiety (adres prywatny) → brak danych.
 */
export function classify(network: Network, address: string, hints: ClassifyHints = {}): Classification {
  const labels = hints.labels ?? getDefaultLabels();
  const source = hints.sourceName ?? 'źródło danych';

  const entry = labels.lookup(network, address);
  if (entry) {
    return {
      addressClass: entry.addressClass,
      label: entry.label,
      kind: entry.kind ?? inferKind(entry.label, entry.addressClass),
      classificationSource: labels.name,
    };
  }

  if (hints.sourceClass && hints.sourceClass !== 'unknown') {
    return {
      addressClass: hints.sourceClass,
      label: hints.sourceLabel,
      kind: hints.sourceKind ?? inferKind(hints.sourceLabel, hints.sourceClass),
      classificationSource: `${source} (klasa podana przez źródło)`,
    };
  }

  if (hints.isContract) {
    return {
      addressClass: 'smart_contract',
      label: hints.sourceLabel,
      kind: hints.sourceKind ?? inferKind(hints.sourceLabel, 'smart_contract'),
      classificationSource: `${source} (pod adresem jest kod kontraktu)`,
    };
  }

  if (hints.sourceLabel) {
    // Źródło podało samą nazwę. Rozpoznajemy tylko jednoznaczne nazwy; w pozostałych
    // przypadkach zostawiamy `unknown`, żeby analityk zweryfikował adres ręcznie.
    const addressClass: AddressClass = matchService(hints.sourceLabel, 'exchange')
      ? 'exchange'
      : MIXER_NAMES.test(hints.sourceLabel)
        ? 'mixer'
        : 'unknown';
    return {
      addressClass,
      label: hints.sourceLabel,
      kind: hints.sourceKind ?? inferKind(hints.sourceLabel, addressClass),
      classificationSource:
        addressClass === 'unknown'
          ? `${source} (etykieta bez klasy — wymaga ręcznej weryfikacji)`
          : `${source} (klasa rozpoznana po nazwie w etykiecie)`,
    };
  }

  if (hints.sourceKind) {
    return { addressClass: 'unknown', kind: hints.sourceKind, classificationSource: `${source} (rodzaj usługi podany przez źródło)` };
  }

  if ((hints.txCount ?? 0) > 0) {
    return {
      addressClass: 'private',
      classificationSource: `${source} (historia transakcji, brak etykiety i kodu kontraktu)`,
    };
  }

  return { addressClass: 'unknown', classificationSource: 'brak danych o adresie' };
}
