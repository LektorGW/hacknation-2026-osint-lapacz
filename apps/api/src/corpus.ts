// Własny indeks publikacji i łącznik wewnętrzny `corpus`. Monitoring zapisuje tu każdą
// pobraną publikację, a analiza osoby lub adresu przeszukuje indeks bez wychodzenia do
// sieci — korzysta więc ze wszystkiego, co narzędzie kiedykolwiek widziało.

import { extractAddresses } from '@olcys/core';
import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { sha256Hex } from './analysis.ts';
import type { CorpusDocument, Storage } from './storage.ts';

export const CORPUS_CONNECTOR_ID = 'corpus';
export const DEFAULT_CORPUS_RETENTION_DAYS = 30;
export const DEFAULT_CORPUS_MAX_ROWS = 200_000;
/** Najwyżej tyle publikacji zwraca jedno zapytanie do indeksu. */
const SEARCH_LIMIT = 50;
/** Krótsza fraza trafiałaby w przypadkowe fragmenty słów. */
const MIN_PHRASE_LENGTH = 4;

export interface CorpusSettings {
  retentionDays: number;
  maxRows: number;
}

/** Publikacja ze źródła w postaci zapisywanej do indeksu (z adresami wykrytymi w treści). */
export function toCorpusDocument(doc: SourceDocument, normalizeText: (text: string) => string = (text) => text): CorpusDocument {
  return {
    url: doc.url,
    service: doc.service,
    connectorId: doc.connectorId,
    ...(doc.author ? { author: doc.author } : {}),
    ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
    fetchedAt: doc.fetchedAt,
    title: doc.title,
    text: doc.text,
    contentHash: sha256Hex(doc.text),
    category: doc.category,
    ...(doc.profile ? { profile: doc.profile } : {}),
    addresses: extractAddresses(normalizeText(doc.text)).map((item) => ({ network: item.network, address: item.address })),
  };
}

/** Usuwa publikacje starsze niż okres przechowywania i nadmiar ponad limit wierszy. */
export function pruneCorpus(storage: Storage, settings: CorpusSettings, now: Date): Promise<number> {
  const olderThan = new Date(now.getTime() - settings.retentionDays * 86_400_000).toISOString();
  return storage.pruneCorpus(olderThan, settings.maxRows);
}

/**
 * Łącznik do indeksu: adres i nick autora dopasowywane dokładnie, pozostałe identyfikatory
 * jako fraza w treści. Dopasowanie po frazie nie dowodzi autorstwa — ocenia je analiza.
 */
export function createCorpusConnector(storage: Storage): SourceConnector {
  return {
    id: CORPUS_CONNECTOR_ID,
    service: 'indeks własny',
    label: 'Indeks publikacji (monitoring)',
    description:
      'Publikacje zapisane przez cykliczny monitoring źródeł. Wyszukiwanie bez połączenia z siecią: dokładny adres kryptowalutowy, ' +
      'dokładna nazwa autora albo fraza w treści (e-mail, imię i nazwisko, adres profilu).',
    accepts: ['nick', 'login', 'crypto_address', 'email', 'full_name', 'messenger_id', 'profile_url', 'ens_name'],
    enabledByDefault: true,
    async search(identifier: Identifier, context): Promise<SourceDocument[]> {
      const value = identifier.value.trim().replace(/^@/, '');
      const byAuthor = identifier.type === 'nick' || identifier.type === 'login' || identifier.type === 'messenger_id';
      if (!byAuthor && identifier.type !== 'crypto_address' && value.length < MIN_PHRASE_LENGTH) return [];
      const found = await storage.searchCorpus(
        identifier.type === 'crypto_address' ? { address: value } : byAuthor ? { author: value } : { phrase: value },
        SEARCH_LIMIT,
      );
      if (found.length === SEARCH_LIMIT) context.log(`indeks zwrócił limit ${SEARCH_LIMIT} publikacji — wynik może być niepełny.`);
      return found.map((doc) => ({
        connectorId: CORPUS_CONNECTOR_ID,
        // Usługą pozostaje serwis pochodzenia: to on wyznacza niezależność źródeł.
        service: doc.service,
        url: doc.url,
        title: doc.title,
        text: doc.text,
        fetchedAt: doc.fetchedAt,
        ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
        ...(doc.author ? { author: doc.author } : {}),
        category: doc.category,
        identityMatch: byAuthor ? 'same_handle' : identifier.type === 'full_name' ? 'name_only' : 'exact_identifier',
        matchedIdentifier: identifier,
        ...(doc.profile ? { profile: doc.profile } : {}),
      }));
    },
  };
}
