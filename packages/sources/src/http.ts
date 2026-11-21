// Wspólny, „grzeczny" klient HTTP wszystkich łączników: jawny User-Agent,
// limit czasu, limit rozmiaru, ogranicznik tempa na host, limit liczby żądań
// na jedno wyszukiwanie, dekodowanie znaków i ochrona przed adresami prywatnymi.
// `fetch` jest wstrzykiwany, więc testy nie łączą się z internetem.

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ConnectorContext } from '@olcys/core';

export const USER_AGENT = 'OLCyS-research/0.1 (hackathon KAS; kontakt przez organizatora)';
export const DEFAULT_TIMEOUT_MS = 10_000;
/** Minimalny odstęp między żądaniami do tego samego hosta. */
export const DEFAULT_MIN_INTERVAL_MS = 400;
/** Najwyżej tyle żądań wykonuje jeden łącznik dla jednego identyfikatora. */
export const DEFAULT_REQUEST_LIMIT = 4;
/** Większych odpowiedzi nie pobieramy w całości — adresy z profilu mieszczą się dużo wcześniej. */
export const DEFAULT_MAX_BYTES = 1_048_576;
const DEFAULT_MAX_REDIRECTS = 3;

export interface HttpResult {
  status: number;
  ok: boolean;
  text: string;
  /** Typ treści bez parametrów, małymi literami (np. `text/html`); pusty, gdy serwer go nie podał. */
  contentType: string;
  /** Adres, z którego faktycznie pochodzi odpowiedź (po przekierowaniach śledzonych ręcznie). */
  url: string;
  /** Powód odrzucenia odpowiedzi przez klienta (zły typ treści, adres prywatny, za dużo przekierowań). */
  rejected?: string;
}

/** Minimalny wspólny kształt odpowiedzi `fetch` — globalnego, z pakietu undici i atrap w testach. */
export interface FetchResponse {
  status: number;
  ok: boolean;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  arrayBuffer?(): Promise<ArrayBuffer>;
  body?: unknown;
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'follow' | 'manual' },
) => Promise<FetchResponse>;

export interface GetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Nadpisuje `fetch` klienta (np. łącznik Tor idzie przez proxy). */
  fetcher?: Fetcher;
  maxBytes?: number;
  /** Kodowanie używane, gdy ani nagłówek, ani znacznik <meta> go nie podają. */
  encoding?: string;
  /** Dozwolone typy treści; inne odpowiedzi są odrzucane bez pobierania treści. */
  allowedContentTypes?: string[];
  /**
   * Tylko hosty publiczne: przed każdym żądaniem (także po przekierowaniu) nazwa jest
   * rozwiązywana w DNS i odrzucana, gdy wskazuje adres prywatny, loopback lub link-local.
   * Włącza ręczne śledzenie przekierowań.
   */
  publicOnly?: boolean;
  /** Ręczne śledzenie przekierowań z limitem; bez tej opcji przekierowania obsługuje `fetch`. */
  maxRedirects?: number;
}

// ---------- Ogranicznik tempa ----------

export interface RateLimiter {
  wait(host: string, signal?: AbortSignal): Promise<void>;
}

/** Kolejne żądania do tego samego hosta dzieli co najmniej `minIntervalMs`. */
export function createRateLimiter(minIntervalMs: number): RateLimiter {
  const nextSlot = new Map<string, number>();
  return {
    async wait(host, signal) {
      if (minIntervalMs <= 0) return;
      const now = Date.now();
      const at = Math.max(now, nextSlot.get(host) ?? 0);
      nextSlot.set(host, at + minIntervalMs);
      if (at > now) await sleep(at - now, undefined, { signal });
    },
  };
}

/** Wspólny dla całego procesu: dwa łączniki pytające ten sam host też się nie ścigają. */
const sharedLimiter = createRateLimiter(DEFAULT_MIN_INTERVAL_MS);

// ---------- Ochrona przed adresami prywatnymi (SSRF) ----------

function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Adresy, pod które łącznik nie może zaglądać: prywatne, loopback, link-local, multiemisja. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version !== 6) return true;
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (lower === '::' || lower === '::1') return true;
  // Adresy IPv4 zapisane szesnastkowo w IPv6 (::ffff:7f00:1) oraz NAT64 — odrzucamy w całości.
  if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return true;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
}

export type HostLookup = (hostname: string) => Promise<{ address: string }[]>;

const systemLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true });

/** Sprawdzenie bez DNS: literały IP i nazwy, które z definicji nie są publiczne. */
export function staticHostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return 'pusta nazwa hosta';
  if (isIP(host)) return isPrivateAddress(host) ? `adres ${host} nie jest publiczny` : null;
  if (host === 'localhost' || /\.(localhost|local|internal|lan|home|onion)$/.test(host) || !host.includes('.')) {
    return `host „${host}" nie jest publiczną nazwą`;
  }
  return null;
}

/** Zwraca powód odrzucenia hosta albo `null`, gdy wszystkie jego adresy są publiczne. */
export async function publicHostProblem(hostname: string, lookup: HostLookup = systemLookup): Promise<string | null> {
  const fixed = staticHostProblem(hostname);
  if (fixed) return fixed;
  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return null;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    return `nie udało się rozwiązać nazwy „${host}"`;
  }
  if (addresses.length === 0) return `nazwa „${host}" nie ma adresu`;
  const bad = addresses.find((entry) => isPrivateAddress(entry.address));
  return bad ? `host „${host}" wskazuje adres niepubliczny (${bad.address})` : null;
}

// ---------- Treść odpowiedzi ----------

async function readBody(response: FetchResponse, maxBytes: number): Promise<Uint8Array> {
  const stream = response.body as { getReader?: () => ReadableStreamDefaultReader<Uint8Array> } | null | undefined;
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    // Po osiągnięciu limitu reszty odpowiedzi nie pobieramy.
    if (size >= maxBytes) await reader.cancel().catch(() => undefined);
    const all = new Uint8Array(Math.min(size, maxBytes));
    let offset = 0;
    for (const chunk of chunks) {
      const part = chunk.subarray(0, Math.min(chunk.byteLength, all.byteLength - offset));
      all.set(part, offset);
      offset += part.byteLength;
      if (offset >= all.byteLength) break;
    }
    return all;
  }
  if (response.arrayBuffer) return new Uint8Array(await response.arrayBuffer()).subarray(0, maxBytes);
  return new TextEncoder().encode(await response.text()).subarray(0, maxBytes);
}

async function discardBody(response: FetchResponse): Promise<void> {
  const stream = response.body as { cancel?: () => Promise<void> } | null | undefined;
  if (stream && typeof stream.cancel === 'function') await stream.cancel().catch(() => undefined);
}

/** Dekoduje bajty: kodowanie z nagłówka, potem ze znacznika <meta>, potem domyślne łącznika, na końcu UTF-8. */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string, fallbackEncoding?: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentTypeHeader)?.[1];
  let charset = fromHeader;
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    charset = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
  }
  for (const candidate of [charset, fallbackEncoding, 'utf-8']) {
    if (!candidate) continue;
    try {
      return new TextDecoder(candidate).decode(bytes);
    } catch {
      // Nieznana nazwa kodowania — próbujemy następnej.
    }
  }
  return new TextDecoder().decode(bytes);
}

// ---------- Klient ----------

export interface HttpClientConfig {
  /** Zamiennik `fetch` — w testach atrapa z zapisanymi odpowiedziami. */
  fetcher?: Fetcher;
  /** Odstęp między żądaniami do jednego hosta; domyślnie wspólny ogranicznik 400 ms. */
  minIntervalMs?: number;
  /** Wyłącza ochronę przed hostami prywatnymi (wyłącznie testy). */
  allowPrivateHosts?: boolean;
  lookup?: HostLookup;
}

export interface SessionOptions {
  /** Nazwa łącznika we wpisach dziennika. */
  label: string;
  limit?: number;
  /** Treść wpisu przy 403/429 (np. wskazówka o tokenie). */
  refusalMessage?: (status: number) => string;
}

export interface SessionGetOptions extends GetOptions {
  /** 404 jest oczekiwanym wynikiem sondy — bez wpisu w dzienniku. */
  quietMissing?: boolean;
}

/** Jedno wyszukiwanie łącznika: budżet żądań i obsługa odmów bez wyjątków. */
export interface HttpSession {
  /** Treść udanej odpowiedzi albo `null` (błąd, odmowa, limit) — powód trafia do dziennika. */
  get(url: string, options?: SessionGetOptions): Promise<HttpResult | null>;
  /** Kod ostatniej odpowiedzi; 0, gdy żądanie się nie odbyło lub zakończyło wyjątkiem. */
  readonly lastStatus: number;
  /** Czy którykolwiek host odmówił (403/429). */
  readonly refused: boolean;
  readonly used: number;
}

export interface HttpClient {
  get(url: string, context: ConnectorContext, options?: GetOptions): Promise<HttpResult>;
  session(context: ConnectorContext, options: SessionOptions): HttpSession;
}

const defaultFetcher: Fetcher = (target, init) => fetch(target, init);

export function createHttpClient(config: HttpClientConfig = {}): HttpClient {
  const limiter = config.minIntervalMs === undefined ? sharedLimiter : createRateLimiter(config.minIntervalMs);

  async function get(url: string, context: ConnectorContext, options: GetOptions = {}): Promise<HttpResult> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
    const fetcher = options.fetcher ?? config.fetcher ?? defaultFetcher;
    const manual = options.publicOnly === true || options.maxRedirects !== undefined;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const rejected = (current: string, status: number, reason: string): HttpResult => ({
      status,
      ok: false,
      text: '',
      contentType: '',
      url: current,
      rejected: reason,
    });

    let current = url;
    for (let hop = 0; ; hop++) {
      const target = new URL(current);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return rejected(current, 0, `nieobsługiwany protokół ${target.protocol}`);
      }
      if (options.publicOnly && !config.allowPrivateHosts) {
        const problem = await publicHostProblem(target.hostname, config.lookup);
        if (problem) return rejected(current, 0, problem);
      }
      await limiter.wait(target.host, signal);
      const response = await fetcher(current, {
        headers: { 'User-Agent': USER_AGENT, ...options.headers },
        signal,
        redirect: manual ? 'manual' : 'follow',
      });

      const location = response.headers?.get('location');
      if (manual && response.status >= 300 && response.status < 400 && location) {
        await discardBody(response);
        if (hop >= maxRedirects) return rejected(current, response.status, `więcej niż ${maxRedirects} przekierowania`);
        current = new URL(location, current).toString();
        continue;
      }

      const header = response.headers?.get('content-type') ?? '';
      const contentType = header.split(';')[0]!.trim().toLowerCase();
      if (response.ok && options.allowedContentTypes && !options.allowedContentTypes.includes(contentType)) {
        await discardBody(response);
        return rejected(current, response.status, `nieobsługiwany typ treści „${contentType || 'brak'}"`);
      }
      const bytes = await readBody(response, options.maxBytes ?? DEFAULT_MAX_BYTES);
      return {
        status: response.status,
        ok: response.ok,
        text: decodeBody(bytes, header, options.encoding),
        contentType,
        url: current,
      };
    }
  }

  function session(context: ConnectorContext, options: SessionOptions): HttpSession {
    const limit = options.limit ?? DEFAULT_REQUEST_LIMIT;
    const refusedHosts = new Set<string>();
    let used = 0;
    let lastStatus = 0;
    let limitLogged = false;

    return {
      get lastStatus() {
        return lastStatus;
      },
      get refused() {
        return refusedHosts.size > 0;
      },
      get used() {
        return used;
      },
      async get(url, getOptions = {}) {
        lastStatus = 0;
        let host: string;
        try {
          host = new URL(url).host;
        } catch {
          context.log(`${options.label}: niepoprawny adres „${url}".`);
          return null;
        }
        // Po odmowie nie ponawiamy i nie próbujemy jej obchodzić.
        if (refusedHosts.has(host)) return null;
        if (used >= limit) {
          if (!limitLogged) context.log(`${options.label}: wyczerpano limit ${limit} żądań na identyfikator.`);
          limitLogged = true;
          return null;
        }
        used += 1;
        let result: HttpResult;
        try {
          result = await get(url, context, getOptions);
        } catch (error) {
          const name = error instanceof Error ? error.name : '';
          const reason =
            name === 'TimeoutError' || name === 'AbortError' ? 'przekroczono limit czasu lub przerwano' : errorMessage(error);
          context.log(`${options.label}: ${host} — ${reason}.`);
          return null;
        }
        lastStatus = result.status;
        if (result.rejected) {
          context.log(`${options.label}: ${host} — odrzucono: ${result.rejected}.`);
          return null;
        }
        if (isRefusal(result.status)) {
          refusedHosts.add(host);
          context.log(
            options.refusalMessage?.(result.status) ??
              `${options.label}: ${host} — odmowa lub limit żądań (kod ${result.status}); pomijam to źródło.`,
          );
          return null;
        }
        if (!result.ok) {
          if (!(result.status === 404 && getOptions.quietMissing)) {
            context.log(`${options.label}: ${host} — kod ${result.status}${result.status === 404 ? ' (brak zasobu)' : ''}.`);
          }
          return null;
        }
        return result;
      },
    };
  }

  return { get, session };
}

// ---------- Zgodność z wcześniejszymi łącznikami (piaskownica, Tor) ----------

const plainClient = createHttpClient({ minIntervalMs: 0 });

/** Pojedyncze pobranie bez ogranicznika tempa — dla lokalnej piaskownicy i łącznika Tor. */
export function httpGet(url: string, context: ConnectorContext, options: GetOptions = {}): Promise<HttpResult> {
  return plainClient.get(url, context, options);
}

/** 403 i 429 oznaczają „nie teraz" — nie ponawiamy i nie próbujemy tego obchodzić. */
export function isRefusal(status: number): boolean {
  return status === 403 || status === 429;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bezpieczne parsowanie JSON: `null` zamiast wyjątku. */
export function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
