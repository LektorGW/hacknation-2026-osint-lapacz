// Wspólne operacje na identyfikatorach: normalizacja nicków, rozpoznawanie
// adresów profili i budowanie listy identyfikatorów odkrytych w dokumencie.

import type { Identifier } from '@olcys/core';

/** Nick lub login bez wiodącego `@` i odstępów. */
export const cleanHandle = (value: string): string => value.trim().replace(/^@/, '');

export const sameHandle = (a: string, b: string): boolean => cleanHandle(a).toLowerCase() === cleanHandle(b).toLowerCase();

/** Adres http(s) z wartości identyfikatora; brakujący schemat uzupełniamy o https. */
export function parseHttpUrl(value: string): URL | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || /^(?:mailto|tel|sms|javascript|data):/i.test(trimmed)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.hostname.includes('.') || url.hostname === 'localhost' || /^[\d.]+$|^\[/.test(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** Nazwa hosta jako `service`: małe litery, bez `www.` — taka sama dla strony na żywo i jej kopii w archiwum. */
export const serviceOf = (url: URL): string => url.hostname.toLowerCase().replace(/^www\./, '');

/**
 * Nazwa konta z identyfikatora: nick/login/komunikator wprost, a dla `profile_url`
 * pierwszy człon ścieżki — tylko gdy adres wskazuje jeden z hostów obsługiwanych przez łącznik.
 */
export function handleFromIdentifier(identifier: Identifier, hosts: string[]): string | null {
  if (identifier.type !== 'profile_url') return cleanHandle(identifier.value) || null;
  const url = parseHttpUrl(identifier.value);
  if (!url || !hosts.includes(serviceOf(url))) return null;
  const first = url.pathname.split('/').filter(Boolean)[0];
  return first ? cleanHandle(decodeURIComponent(first)) || null : null;
}

/** Adresy techniczne, które nie identyfikują osoby (np. `123+login@users.noreply.github.com`). */
export const isTechnicalEmail = (email: string): boolean => /(^|[.@+_-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon)([.@+_-]|$)/i.test(email);

/**
 * Usuwa powtórzenia, identyfikator, po którym dokument został znaleziony, oraz wartości
 * techniczne: adresy „noreply" i odnośniki do samego serwisu (`ownHosts`).
 */
export function dedupeIdentifiers(identifiers: Identifier[], exclude?: Identifier, ownHosts: string[] = []): Identifier[] {
  // Ten sam adres z http i https, z „www." lub bez, to jeden identyfikator; zostaje wersja https.
  const key = (item: Identifier) => {
    const value = item.value.trim().toLowerCase().replace(/\/+$/, '');
    return `${item.type}:${item.type === 'profile_url' ? value.replace(/^https?:\/\/(?:www\.)?/, '') : value}`;
  };
  const excluded = exclude ? key(exclude) : undefined;
  const kept = new Map<string, Identifier>();
  for (const item of identifiers) {
    const itemKey = key(item);
    if (!item.value.trim() || itemKey === excluded) continue;
    if (item.type === 'email' && isTechnicalEmail(item.value)) continue;
    if (item.type === 'profile_url' && ownHosts.length > 0) {
      const url = parseHttpUrl(item.value);
      if (url && ownHosts.includes(serviceOf(url))) continue;
    }
    const previous = kept.get(itemKey);
    if (!previous || (/^http:/i.test(previous.value) && /^https:/i.test(item.value))) kept.set(itemKey, item);
  }
  return [...kept.values()];
}

/** Odnośnik z profilu jako identyfikator `profile_url`; `null` dla adresów innych niż http(s). */
export function profileUrlIdentifier(href: string): Identifier | null {
  if (!/^https?:\/\//i.test(href.trim())) return null;
  const url = parseHttpUrl(href);
  return url ? { type: 'profile_url', value: url.toString() } : null;
}

/** Zwraca pole tylko wtedy, gdy lista nie jest pusta — do rozwinięcia w literale dokumentu. */
export function discoveredField(identifiers: Identifier[]): { discoveredIdentifiers?: Identifier[] } {
  return identifiers.length > 0 ? { discoveredIdentifiers: identifiers } : {};
}
