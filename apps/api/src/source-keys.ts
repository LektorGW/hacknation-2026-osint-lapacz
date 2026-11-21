// Które źródła działają wyłącznie z kluczem API i czy klucz jest ustawiony.
// Wartości kluczy nigdy nie opuszczają procesu — API podaje tylko nazwy zmiennych środowiskowych
// i informację „ustawiony / nieustawiony”.

import type { SourceConnector } from '@olcys/core';

/** Zmienne środowiskowe z kluczami źródeł; `server.ts` podaje, które z nich są ustawione. */
export const SOURCE_KEY_ENV = ['GITHUB_TOKEN', 'CEIDG_API_TOKEN', 'MARGINALIA_API_KEY', 'MOJEEK_API_KEY'] as const;
export type SourceKeyEnv = (typeof SOURCE_KEY_ENV)[number];

/** Stan kluczy: nazwa zmiennej → czy ustawiona (i, dla Mojeek, czy spełniony warunek prawa przechowywania). */
export type ConfiguredKeys = Partial<Record<SourceKeyEnv, boolean>>;

/**
 * Źródła, które bez klucza nic nie zwracają (łącznik istnieje, ale pomija zapytania).
 * Pozostałe łączniki GitHuba działają bez tokenu — token tylko podnosi limit zapytań, więc nie są tu wymienione.
 */
const BY_ID: Record<string, readonly SourceKeyEnv[]> = {
  'live-github-search': ['GITHUB_TOKEN'],
  // Łącznik powstaje tylko z tokenem; gdy jest na liście, token jest ustawiony.
  'live-ceidg': ['CEIDG_API_TOKEN'],
  // Wyszukiwarka internetowa: wystarczy jeden z dostawców.
  'web-search': ['MARGINALIA_API_KEY', 'MOJEEK_API_KEY'],
};

/** Źródło monitoringu oparte na wyszukiwarce GitHuba (silnik `github-search`) też wymaga tokenu — rozpoznajemy je po opisie silnika. */
const GITHUB_SEARCH_SOURCE = /wyłącznie z tokenem \(GITHUB_TOKEN\)/;

export function requiredKeys(connector: Pick<SourceConnector, 'id' | 'description'>): readonly SourceKeyEnv[] {
  const known = BY_ID[connector.id];
  if (known) return known;
  if (connector.id.startsWith('mon-') && GITHUB_SEARCH_SOURCE.test(connector.description)) return ['GITHUB_TOKEN'];
  return [];
}

export interface SourceKeyInfo {
  requiresKey: boolean;
  /** Klucz jest ustawiony i źródło może z niego korzystać; dla źródeł bez klucza zawsze `false`. */
  keyConfigured: boolean;
  /** Nazwy zmiennych środowiskowych z kluczem (bez wartości); tylko dla źródeł wymagających klucza. */
  keyEnv?: string[];
}

/**
 * Metadane klucza dla jednego źródła. Bez informacji z `server.ts` (np. w testach) o ustawieniu klucza
 * świadczy sam łącznik: źródła wymagające klucza są domyślnie włączone wyłącznie wtedy, gdy klucz podano.
 */
export function sourceKeyInfo(connector: Pick<SourceConnector, 'id' | 'description' | 'enabledByDefault'>, configured?: ConfiguredKeys): SourceKeyInfo {
  const keys = requiredKeys(connector);
  if (keys.length === 0) return { requiresKey: false, keyConfigured: false };
  const keyConfigured = connector.id === 'live-ceidg' || (configured ? keys.some((name) => configured[name] === true) : connector.enabledByDefault);
  return { requiresKey: true, keyConfigured, keyEnv: [...keys] };
}
