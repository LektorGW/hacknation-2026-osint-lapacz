// Zabezpieczenia warstwy HTTP:
//  - opcjonalny token API (OLCYS_API_TOKEN): każde żądanie /api/* wymaga `Authorization: Bearer <token>`
//    (porównanie w stałym czasie); wyjątek: /api/health, które wtedy nie ujawnia konfiguracji;
//  - CORS wyłącznie dla skonfigurowanych adresów interfejsu i ochrona przed CSRF (obcy `Origin` przy zmianie danych);
//  - nagłówki bezpieczeństwa każdej odpowiedzi (CSP, nosniff, brak Referer, zakaz osadzania w ramkach);
//  - prosty limit żądań na adres IP dla kosztownych tras (analiza, rozwijanie sieci, eksporty, archiwum);
//  - zamykanie serwera żądaniem wyłącznie z tej samej maszyny, bez pośrednika i (jeśli ustawiono) z tokenem.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Domyślne adresy interfejsu (Vite dev i podgląd) — tylko z nich przeglądarka może czytać odpowiedzi API. */
export const DEFAULT_WEB_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

/** Ciasteczko z tokenem — wyłącznie dla żądań GET (otwarcie raportu lub pobranie pliku w nowej karcie). */
export const TOKEN_COOKIE = 'olcys_token';

/** Domyślny limit kosztownych żądań na adres IP w oknie jednej minuty. */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export interface SecurityOptions {
  /** Token API; brak = brak uwierzytelniania (stanowisko lokalne, jak dotąd). */
  apiToken?: string;
  /** Adresy (origin) interfejsu dopuszczone przez CORS. */
  corsOrigins?: string[];
  /** Limit kosztownych żądań na IP na minutę; 0 wyłącza limit. */
  rateLimitPerMinute?: number;
  /** Dodatkowe nazwy hostów API (nagłówek Host), np. nazwa serwera w sieci; adresy IP i `localhost` są zawsze dozwolone. */
  allowedHosts?: string[];
}

/** Konfiguracja bezpieczeństwa ze zmiennych środowiskowych (wartości tokenu nigdy nie są logowane). */
export function securityFromEnv(env: NodeJS.ProcessEnv): Required<Pick<SecurityOptions, 'corsOrigins' | 'rateLimitPerMinute'>> & SecurityOptions {
  const token = env.OLCYS_API_TOKEN?.trim();
  if (token !== undefined && token !== '' && token.length < 16) {
    throw new Error('OLCYS_API_TOKEN jest za krótki — użyj co najmniej 16 znaków (np. 32 losowe bajty szesnastkowo).');
  }
  const origins = (env.OLCYS_WEB_ORIGIN ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  const limit = env.OLCYS_RATE_LIMIT_PER_MIN === undefined || env.OLCYS_RATE_LIMIT_PER_MIN === '' ? DEFAULT_RATE_LIMIT_PER_MINUTE : Number(env.OLCYS_RATE_LIMIT_PER_MIN);
  const hosts = (env.OLCYS_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    ...(token ? { apiToken: token } : {}),
    ...(hosts.length > 0 ? { allowedHosts: hosts } : {}),
    corsOrigins: origins.length > 0 ? origins : DEFAULT_WEB_ORIGINS,
    rateLimitPerMinute: Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : DEFAULT_RATE_LIMIT_PER_MINUTE,
  };
}

/** Porównanie napisów w stałym czasie (niezależnym od miejsca pierwszej różnicy i od długości). */
export function safeEqual(given: string, expected: string): boolean {
  const left = createHash('sha256').update(given, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right) && given.length === expected.length;
}

/**
 * Znacznik żądań wewnętrznych (`app.inject` z innej trasy, np. pakiet ZIP składany z raportu JSON):
 * losowy na proces, nigdy nie opuszcza serwera. Takie żądania nie są ponownie liczone do limitu ani audytu.
 */
const INTERNAL_HEADER = 'x-olcys-wewnetrzne';
const INTERNAL_SECRET = randomBytes(24).toString('hex');
export const internalHeaders = (): Record<string, string> => ({ [INTERNAL_HEADER]: INTERNAL_SECRET });
export const isInternalRequest = (request: FastifyRequest): boolean => {
  const value = request.headers[INTERNAL_HEADER];
  return typeof value === 'string' && safeEqual(value, INTERNAL_SECRET);
};

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Czy żądanie ma poprawny token (nagłówek Bearer; dla GET także ciasteczko). Bez skonfigurowanego tokenu — zawsze tak. */
export function isAuthorized(request: FastifyRequest, token: string | undefined): boolean {
  if (!token) return true;
  if (isInternalRequest(request)) return true;
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return safeEqual(match[1]!.trim(), token);
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    const fromCookie = cookieValue(request.headers.cookie, TOKEN_COOKIE);
    if (fromCookie) return safeEqual(fromCookie, token);
  }
  return false;
}

/** Nagłówki bezpieczeństwa: API nie serwuje treści aktywnych, a raporty HTML mają własną, równie ścisłą politykę. */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
/** Polityka treści dla odpowiedzi API (JSON, pliki) i raportów HTML: nic się nie wykonuje, nic nie jest doczytywane, brak osadzania. */
export const API_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Kosztowne trasy objęte limitem: metoda + wzorzec trasy Fastify. */
export const RATE_LIMITED_ROUTES: { method: string; url: string }[] = [
  { method: 'POST', url: '/api/cases/:id/runs' },
  { method: 'POST', url: '/api/quick' },
  { method: 'POST', url: '/api/cases/:id/network/expand' },
  { method: 'GET', url: '/api/cases/:id/export/:file' },
  { method: 'GET', url: '/api/runs/:id/report.html' },
  { method: 'GET', url: '/api/runs/:id/report.json' },
  { method: 'POST', url: '/api/cases/:id/archive' },
  { method: 'POST', url: '/api/sweeps' },
  { method: 'POST', url: '/api/monitor/run' },
];

/** Licznik w oknie przesuwnym (w pamięci procesu): `take` zwraca liczbę sekund do odczekania albo 0. */
export function createRateLimiter(perWindow: number, windowMs = 60_000, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    take(key: string): number {
      if (perWindow <= 0) return 0;
      const time = now();
      const recent = (hits.get(key) ?? []).filter((at) => time - at < windowMs);
      if (recent.length >= perWindow) {
        hits.set(key, recent);
        return Math.max(1, Math.ceil((recent[0]! + windowMs - time) / 1000));
      }
      recent.push(time);
      hits.set(key, recent);
      // Okresowe sprzątanie kluczy bez aktywności — pamięć nie rośnie bez końca.
      if (hits.size > 10_000) for (const [entry, times] of hits) if (times.every((at) => time - at >= windowMs)) hits.delete(entry);
      return 0;
    },
  };
}

/**
 * Czy żądanie dotyczy API: zarejestrowana trasa pod `/api/` albo ścieżka, która po zdekodowaniu
 * i usunięciu zdublowanych ukośników zaczyna się od `/api/` (także żądania bez trasy — 404 pod /api).
 */
export function isApiRequest(rawPath: string, routeUrl: string | undefined): boolean {
  if (routeUrl?.startsWith('/api/')) return true;
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // Niepoprawne kodowanie — oceniamy surową ścieżkę (router i tak odrzuci żądanie).
  }
  return decoded.replace(/\/{2,}/g, '/').toLowerCase().startsWith('/api/');
}

/** Rejestruje uwierzytelnianie, ochronę przed CSRF, limit żądań i nagłówki bezpieczeństwa. */
export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const token = options.apiToken;
  const origins = new Set((options.corsOrigins ?? DEFAULT_WEB_ORIGINS).map((item) => item.toLowerCase()));
  const limiter = createRateLimiter(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE);
  const limited = new Set(RATE_LIMITED_ROUTES.map((route) => `${route.method} ${route.url}`));
  const namedHosts = new Set(
    [...(options.corsOrigins ?? DEFAULT_WEB_ORIGINS), ...(options.allowedHosts ?? [])].map((item) => {
      try {
        return new URL(item.includes('://') ? item : `http://${item}`).hostname.toLowerCase();
      } catch {
        return item.toLowerCase();
      }
    }),
  );
  /** Dozwolone: literał IP, `localhost` i nazwy z konfiguracji (adresy interfejsu, OLCYS_ALLOWED_HOSTS) — jak w serwerze Vite. */
  const hostAllowed = (host: string | undefined): boolean => {
    if (!host) return true;
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      return false;
    }
    const bare = hostname.replace(/^\[|\]$/g, '');
    return isIP(bare) !== 0 || bare === 'localhost' || bare.endsWith('.localhost') || namedHosts.has(hostname);
  };

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    // Ochrona według zarejestrowanej trasy, nie surowego URL: router dekoduje i normalizuje ścieżkę
    // (np. `/%61pi/cases` trafia do `/api/cases`), więc sam prefiks surowego adresu dałoby się ominąć.
    const path = request.url.split('?')[0]!;
    const route = request.routeOptions.url;
    if (!isApiRequest(path, route)) return;
    // DNS rebinding: obca domena wskazująca na 127.0.0.1 nie może rozmawiać z API jak „ta sama strona”.
    if (!hostAllowed(request.headers.host)) {
      return reply.code(403).send({ error: 'Niedozwolona nazwa hosta w żądaniu (nagłówek Host).' });
    }
    // CSRF: przeglądarka dołącza `Origin` do żądań zmieniających dane — obca strona nie może nic zmienić ani zamknąć serwera.
    // Ta sama strona co API (interfejs podawany z portu API) jest zawsze dozwolona.
    const origin = request.headers.origin;
    const sameOrigin = typeof origin === 'string' && typeof request.headers.host === 'string' && origin.toLowerCase().replace(/^https?:\/\//, '') === request.headers.host.toLowerCase();
    if (STATE_CHANGING.has(request.method) && typeof origin === 'string' && !sameOrigin && !origins.has(origin.toLowerCase())) {
      return reply.code(403).send({ error: 'Żądanie z niedozwolonej strony (Origin) zostało odrzucone.' });
    }
    if (token && (route ?? path) !== '/api/health' && !isAuthorized(request, token)) {
      return reply
        .code(401)
        .header('WWW-Authenticate', 'Bearer realm="olcys"')
        .send({ error: 'Wymagane uwierzytelnienie: podaj token API (nagłówek Authorization: Bearer …).' });
    }
  });

  // Limit przed walidacją treści: liczą się także żądania odrzucone jako błędne.
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (reply.sent) return;
    const route = `${request.method} ${request.routeOptions.url ?? ''}`;
    if (!limited.has(route) || isInternalRequest(request)) return;
    const wait = limiter.take(`${request.ip}|${route}`);
    if (wait > 0) {
      return reply
        .code(429)
        .header('Retry-After', String(wait))
        .send({ error: `Za dużo kosztownych żądań z tego adresu — spróbuj ponownie za ${wait} s.` });
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(name)) reply.header(name, value);
    // Polityka treści tylko dla odpowiedzi API (interfejs podawany z tego samego portu ma własne zasoby i skrypty).
    if (!isApiRequest(request.url.split('?')[0]!, request.routeOptions.url)) return payload;
    // Trasy z własną polityką (np. raport HTML) zostawiają swoją, uzupełnioną o zakaz osadzania; reszta dostaje ścisłą politykę API.
    const own = reply.getHeader('Content-Security-Policy');
    if (typeof own !== 'string' || !own) reply.header('Content-Security-Policy', API_CSP);
    else if (!own.includes('frame-ancestors')) reply.header('Content-Security-Policy', `${own}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`);
    if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    return payload;
  });
}

/** Czy żądanie przyszło wprost z tej maszyny na port API — nie przez pośrednika (np. proxy Vite) ani z przeglądarki. */
export function isDirectLocalRequest(request: FastifyRequest, port: number): boolean {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip);
  const host = String(request.headers.host ?? '').toLowerCase();
  const hostOk = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host);
  const proxied = request.headers['x-forwarded-for'] !== undefined || request.headers.forwarded !== undefined;
  const browser = request.headers.origin !== undefined || request.headers['sec-fetch-site'] !== undefined;
  return local && hostOk && !proxied && !browser;
}

/** `POST /api/admin/shutdown` — łagodne zamknięcie (Windows nie dostarcza sygnałów); token obowiązuje przez hak `onRequest`. */
export function registerAdminShutdown(app: FastifyInstance, options: { port: number; onShutdown: () => void }): void {
  app.post('/api/admin/shutdown', async (request, reply) => {
    if (!isDirectLocalRequest(request, options.port)) {
      return reply.code(403).send({ error: 'Zamknięcie jest dostępne tylko lokalnie, bezpośrednio na porcie API (nie przez pośrednika ani przeglądarkę).' });
    }
    setImmediate(options.onShutdown);
    return { status: 'closing' };
  });
}
