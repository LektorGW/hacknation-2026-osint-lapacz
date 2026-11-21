// Dostawcy łącznika `web-search`. Każdy ma własny indeks stron i oficjalne API, którego regulamin
// pozwala na zapytania automatyczne i przechowanie wyników (uzasadnienie i cytaty:
// docs/ZRODLA-PODSTAWA-PRAWNA.md). Klucz API trafia wyłącznie do hosta danego dostawcy
// i nigdy do dziennika.
//
// Świadomie NIE ma tu: Brave Search API (regulamin zabrania przechowywania wyników), Google
// Programmable Search (zamknięte dla nowych klientów, wygaszane 1.01.2027), Bing (wycofane),
// wyszukiwania u dostawców modeli językowych (brak dosłownego fragmentu strony, zasady użycia
// ograniczają zastosowania organów ścigania) ani usług typu SerpAPI (pobieranie stron wyników
// cudzej wyszukiwarki przez pośrednika).

import { parseJson } from '../http.ts';
import type { WebSearchProvider, WebSearchResult } from './web-search.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

// ---------- Marginalia Search ----------

const MARGINALIA_HOST = 'api2.marginalia-search.com';

interface MarginaliaResponse {
  license?: unknown;
  results?: { url?: unknown; title?: unknown; description?: unknown }[];
}

export function parseMarginalia(json: unknown): WebSearchResult[] {
  const results = (json as MarginaliaResponse | null)?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((item) => ({ url: text(item?.url), title: text(item?.title), snippet: text(item?.description) }))
    .filter((item) => item.url !== '');
}

/**
 * Marginalia Search — niezależna wyszukiwarka z własnym indeksem (głównie małe, niekomercyjne strony).
 * Klucz niekomercyjny: wyniki na licencji CC BY-NC-SA 4.0; klucz `public` jest wspólny i często trafia w limit.
 */
export function createMarginaliaProvider(config: { apiKey: string }): WebSearchProvider {
  return {
    id: 'marginalia',
    label: 'Marginalia Search',
    host: MARGINALIA_HOST,
    // Dokumentacja nie podaje liczby zapytań na minutę; klucz wspólny odpowiada 429/503 po przekroczeniu.
    minIntervalMs: 2000,
    terms: 'wyniki Marginalia Search na licencji CC BY-NC-SA 4.0 (użycie niekomercyjne, z podaniem źródła: marginalia-search.com).',
    async search({ query, count, session }) {
      const url = `https://${MARGINALIA_HOST}/search?query=${encodeURIComponent(query)}&count=${Math.min(Math.max(count, 1), 100)}`;
      const response = await session.get(url, { headers: { 'API-Key': config.apiKey, Accept: 'application/json' }, minIntervalMs: 2000 });
      return response ? parseMarginalia(parseJson(response.text)) : null;
    },
  };
}

// ---------- Mojeek ----------

const MOJEEK_HOST = 'www.mojeek.com';

interface MojeekResponse {
  response?: {
    status?: unknown;
    results?: { url?: unknown; title?: unknown; desc?: unknown; pdate?: unknown; timestamp?: unknown }[];
  };
}

const isoFromUnix = (value: unknown): string | undefined => {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
};

/** Zwraca wyniki albo komunikat błędu z pola `status` (np. „ERROR: Daily Limit Reached"). */
export function parseMojeek(json: unknown): { results: WebSearchResult[]; error?: string } {
  const response = (json as MojeekResponse | null)?.response;
  if (!response) return { results: [], error: 'odpowiedź bez pola „response"' };
  const status = text(response.status);
  if (status !== 'OK') return { results: [], error: status || 'brak statusu' };
  const results = Array.isArray(response.results) ? response.results : [];
  return {
    results: results
      .map((item) => {
        const publishedAt = isoFromUnix(item?.pdate);
        return { url: text(item?.url), title: text(item?.title), snippet: text(item?.desc), ...(publishedAt ? { publishedAt } : {}) };
      })
      .filter((item) => item.url !== ''),
  };
}

/**
 * Mojeek — brytyjska wyszukiwarka z własnym indeksem i robotem respektującym robots.txt.
 * Regulamin API pozwala przechowywać wyniki tylko w planie z prawem przechowywania („storage rights"),
 * dlatego dostawca powstaje wyłącznie, gdy użytkownik potwierdzi taki plan (MOJEEK_STORAGE_RIGHTS=1).
 */
export function createMojeekProvider(config: { apiKey: string }): WebSearchProvider {
  return {
    id: 'mojeek',
    label: 'Mojeek',
    host: MOJEEK_HOST,
    // Plan Startup: 5 zapytań na sekundę; trzymamy się dużo niżej.
    minIntervalMs: 1000,
    terms: 'wyniki Mojeek Search API w planie z prawem przechowywania; prawa do treści stron pozostają przy ich wydawcach.',
    async search({ query, count, session, context }) {
      // Klucz jest parametrem adresu (tak wymaga API) — adres żądania nie trafia do dziennika, klient zapisuje tylko host.
      const url =
        `https://${MOJEEK_HOST}/search?fmt=json&t=${Math.min(Math.max(count, 1), 10)}&s=1&lb=PL&lbb=100&rb=PL&rbb=10` +
        `&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(config.apiKey)}`;
      const response = await session.get(url, { headers: { Accept: 'application/json' }, minIntervalMs: 1000 });
      if (!response) return null;
      const parsed = parseMojeek(parseJson(response.text));
      if (parsed.error) {
        context.log(`Wyszukiwarka internetowa (API) — Mojeek: ${parsed.error.slice(0, 120)}.`);
        return null;
      }
      return parsed.results;
    },
  };
}
