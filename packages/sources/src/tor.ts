// Łącznik Tor: pobiera WYŁĄCZNIE jawne strony .onion z listy w
// config/onion-sources.json, przez lokalne proxy HTTP Tora (HTTPTunnelPort).
// Nie loguje się, nie wysyła formularzy ani zapytań, nie podąża za odnośnikami —
// czyta podane strony i sprawdza, czy występuje na nich badany identyfikator
// (wyszukiwanie) albo czy zawierają adresy kryptowalutowe (typowanie).

import { readFileSync } from 'node:fs';
import { fetch as undiciFetch, ProxyAgent } from 'undici';
import { extractAddresses } from '@olcys/core';
import type { ConnectorContext, DiscoveringConnector, SourceDocument } from '@olcys/core';
import { htmlToText } from './html.ts';
import { errorMessage, httpGet, isRefusal } from './http.ts';
import type { Fetcher } from './http.ts';

const LABEL = 'Tor (.onion)';
const CONFIG_URL = new URL('../config/onion-sources.json', import.meta.url);

const MAX_SOURCES = 5;
/** Sieć Tor jest wolniejsza od zwykłej — dłuższy limit czasu niż dla pozostałych łączników. */
const TOR_TIMEOUT_MS = 30_000;
/** Ile tekstu wokół wystąpienia identyfikatora trafia do dokumentu. */
const WINDOW_CHARS = 600;
const MAX_WINDOWS = 3;
/** Ile tekstu strony trafia do dokumentu przy typowaniu. */
const MAX_DISCOVER_CHARS = 20_000;

export interface OnionSource {
  url: string;
  label?: string;
}

/** Czyta listę adresów startowych; zwraca też powód, jeśli pliku nie da się użyć. */
export function loadOnionSources(configUrl: URL = CONFIG_URL): { sources: OnionSource[]; problem?: string } {
  try {
    const parsed = JSON.parse(readFileSync(configUrl, 'utf8')) as { sources?: OnionSource[] };
    const sources = (parsed.sources ?? []).filter((source) => typeof source?.url === 'string');
    return { sources };
  } catch (error) {
    return { sources: [], problem: errorMessage(error) };
  }
}

function isOnionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.endsWith('.onion');
  } catch {
    return false;
  }
}

/** Fragmenty tekstu wokół wystąpień frazy — reszta strony dotyczy innych osób. */
export function excerptsAround(text: string, phrase: string): string | null {
  const haystack = text.toLowerCase();
  const needle = phrase.toLowerCase();
  const windows: string[] = [];
  let from = 0;
  while (windows.length < MAX_WINDOWS) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    const end = Math.min(text.length, at + needle.length + WINDOW_CHARS);
    windows.push(text.slice(Math.max(0, at - WINDOW_CHARS), end));
    from = end;
  }
  return windows.length > 0 ? windows.join('\n…\n') : null;
}

export interface TorOptions {
  /** Nadpisuje listę z config/onion-sources.json (testy). */
  sources?: OnionSource[];
  /** Zamiennik `fetch` idącego przez proxy (testy). */
  fetcher?: Fetcher;
}

export function createTorConnector(torProxyUrl: string, options: TorOptions = {}): DiscoveringConnector {
  const { sources, problem } = options.sources ? { sources: options.sources, problem: undefined } : loadOnionSources();
  let fetcher: Fetcher | undefined = options.fetcher;

  /** Tekst jednej strony z listy albo `null` (adres spoza .onion, odmowa, błąd) — powód trafia do dziennika. */
  async function readSource(source: OnionSource, context: ConnectorContext): Promise<string | null> {
    if (!isOnionUrl(source.url)) {
      context.log(`${LABEL}: pominięto ${source.url} — to nie jest adres .onion.`);
      return null;
    }
    // Agent proxy powstaje dopiero przy pierwszym użyciu, bo łącznik jest domyślnie wyłączony.
    if (!fetcher) {
      const dispatcher = new ProxyAgent(torProxyUrl);
      fetcher = (url, init) => undiciFetch(url, { ...init, dispatcher });
    }
    try {
      const page = await httpGet(source.url, context, { fetcher, timeoutMs: TOR_TIMEOUT_MS });
      if (!page.ok) {
        const reason = isRefusal(page.status) ? 'odmowa dostępu' : 'błąd';
        context.log(`${LABEL}: ${source.url} — ${reason} (kod ${page.status}).`);
        return null;
      }
      return htmlToText(page.text);
    } catch (error) {
      context.log(`${LABEL}: ${source.url} — ${errorMessage(error)}`);
      return null;
    }
  }

  /** Wspólny wstęp obu metod: `false`, gdy nie ma czego czytać. */
  function ready(context: ConnectorContext): boolean {
    if (problem) context.log(`${LABEL}: nie można odczytać listy źródeł: ${problem}`);
    if (sources.length === 0) context.log(`${LABEL}: lista źródeł jest pusta — nic do sprawdzenia.`);
    return sources.length > 0;
  }

  return {
    id: 'tor-onion',
    service: 'tor.onion',
    label: LABEL,
    description:
      `Jawne strony .onion z listy config/onion-sources.json (pozycji: ${sources.length}), pobierane przez proxy Tora. ` +
      'Bez logowania i formularzy; dokument powstaje tylko wtedy, gdy strona zawiera badany identyfikator. ' +
      'Typowanie: strony z listy, na których występują adresy kryptowalutowe.',
    accepts: ['nick', 'login', 'email', 'messenger_id', 'full_name', 'crypto_address'],
    enabledByDefault: false,

    async search(identifier, context) {
      if (!ready(context)) return [];
      const phrase = identifier.value.replace(/^@/, '');
      const documents: SourceDocument[] = [];
      for (const source of sources.slice(0, MAX_SOURCES)) {
        const text = await readSource(source, context);
        const excerpt = text === null ? null : excerptsAround(text, phrase);
        if (!excerpt) continue;
        documents.push({
          connectorId: 'tor-onion',
          // Każda witryna .onion jest osobnym źródłem.
          service: new URL(source.url).hostname,
          url: source.url,
          title: source.label ?? source.url,
          text: excerpt,
          fetchedAt: new Date().toISOString(),
          category: 'forum_post',
          // Sama wzmianka na cudzej stronie: nick/e-mail to dokładny identyfikator,
          // nazwisko lub adres — najsłabsze powiązanie.
          identityMatch:
            identifier.type === 'full_name' || identifier.type === 'crypto_address' ? 'name_only' : 'exact_identifier',
          matchedIdentifier: identifier,
        });
      }
      context.log(`${LABEL}: „${phrase}" — dokumentów: ${documents.length}.`);
      return documents;
    },

    async discover(context, limit) {
      if (!ready(context)) return [];
      const wanted = Math.max(1, Math.floor(limit) || 1);
      const documents: SourceDocument[] = [];
      for (const source of sources.slice(0, MAX_SOURCES)) {
        if (documents.length >= wanted) break;
        const text = await readSource(source, context);
        if (text === null || extractAddresses(text).length === 0) continue;
        // Strona nie podaje autora w ustandaryzowany sposób — publikującym jest sama witryna.
        const host = new URL(source.url).hostname;
        documents.push({
          connectorId: 'tor-onion',
          service: host,
          url: source.url,
          title: source.label ?? source.url,
          text: text.slice(0, MAX_DISCOVER_CHARS),
          fetchedAt: new Date().toISOString(),
          author: host,
          category: 'forum_post',
          identityMatch: 'exact_identifier',
          matchedIdentifier: { type: 'nick', value: host },
          profile: { handle: host, urls: [source.url], ...(source.label ? { displayName: source.label } : {}) },
        });
      }
      context.log(`${LABEL}: typowanie — stron z adresami: ${documents.length}.`);
      return documents;
    },
  };
}
