// Rozpoznawanie typu identyfikatora wpisanego w jedno pole szybkiego wyszukiwania.
import type { Identifier, IdentifierType } from '@olcys/core';

const CRYPTO_PATTERNS = [
  /^(bc1|tb1)[02-9ac-hj-np-z]{20,87}$/i, // Bitcoin bech32
  /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/, // Bitcoin base58
  /^0x[0-9a-fA-F]{40}$/, // Ethereum
  /^T[1-9A-HJ-NP-Za-km-z]{33}$/, // Tron
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_WITH_SCHEME = /^https?:\/\/\S+$/i;
/** Domena ze ścieżką bez schematu, np. `kodhub.example/t-wzorcowy`. */
const BARE_URL = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;
const NAME_WORD = /^\p{Lu}[\p{L}'’-]+$/u;

/** Typ identyfikatora odgadnięty z formatu; analityk może go poprawić przed utworzeniem sprawy. */
export function detectIdentifierType(raw: string): IdentifierType {
  const value = raw.trim();
  if (URL_WITH_SCHEME.test(value) || BARE_URL.test(value)) return 'profile_url';
  if (CRYPTO_PATTERNS.some((pattern) => pattern.test(value))) return 'crypto_address';
  if (!/\s/.test(value) && /^[^@/]+\.eth$/i.test(value)) return 'ens_name';
  if (EMAIL.test(value)) return 'email';
  const words = value.split(/\s+/);
  if (words.length >= 2 && words.length <= 4 && words.every((word) => NAME_WORD.test(word))) return 'full_name';
  return 'nick';
}

/** Wartość w postaci, w jakiej trafia do sprawy: bez zbędnych znaków, URL ze schematem. */
export function normalizeIdentifier(type: IdentifierType, raw: string): Identifier {
  let value = raw.trim().replace(/\s+/g, ' ');
  if (type === 'nick' || type === 'login') value = value.replace(/^@/, '');
  if (type === 'profile_url' && !URL_WITH_SCHEME.test(value)) value = `https://${value}`;
  if (type === 'email' || type === 'ens_name') value = value.toLowerCase();
  return { type, value };
}

/** Domyślna nazwa sprawy zakładanej z jednego identyfikatora. */
export function suggestCaseName(identifier: Identifier): string {
  const { type, value } = identifier;
  if (type === 'crypto_address') return `Adres ${value.slice(0, 8)}…${value.slice(-6)}`;
  if (type === 'profile_url') return value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return value;
}
