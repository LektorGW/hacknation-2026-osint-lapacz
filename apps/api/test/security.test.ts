// Zabezpieczenia HTTP: token API (porównanie w stałym czasie), /api/health bez ujawniania konfiguracji,
// nagłówki bezpieczeństwa, CORS tylko dla interfejsu, CSRF, DNS rebinding, limit żądań i zamykanie tylko lokalnie.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createRateLimiter, registerAdminShutdown, registerSecurity, safeEqual, securityFromEnv } from '../src/security.ts';
import { createPgliteDriver, createStorage } from '../src/storage.ts';
import { FIXED_NOW, fakeConnector, fakeProvider } from './helpers.ts';

const TOKEN = 'tajny-token-testowy-0123456789abcdef';
let secured: FastifyInstance;
let open: FastifyInstance;

const make = async (security?: Parameters<typeof buildApp>[0]['security']) => {
  const storage = createStorage(await createPgliteDriver());
  await storage.migrate();
  const app = await buildApp({
    storage,
    connectors: [fakeConnector('github', 'github.com', ['nick'], () => [])],
    chainProviders: [fakeProvider()],
    now: FIXED_NOW,
    ...(security ? { security } : {}),
  });
  app.addHook('onClose', () => storage.close());
  return app;
};

before(async () => {
  secured = await make({ apiToken: TOKEN, rateLimitPerMinute: 2 });
  open = await make();
});
after(async () => {
  await secured.close();
  await open.close();
});

test('porównanie tokenu: poprawne dla równych, fałsz dla różnych długości i treści', () => {
  assert.equal(safeEqual(TOKEN, TOKEN), true);
  assert.equal(safeEqual(TOKEN, `${TOKEN}x`), false);
  assert.equal(safeEqual('', TOKEN), false);
  assert.equal(safeEqual(TOKEN.replace(/.$/, 'X'), TOKEN), false);
});

test('token wymagany dla każdej trasy /api oprócz /api/health; Bearer albo ciasteczko (tylko GET)', async () => {
  const denied = await secured.inject('/api/cases');
  assert.equal(denied.statusCode, 401);
  assert.match(denied.json().error, /Wymagane uwierzytelnienie/);
  assert.equal(denied.headers['www-authenticate'], 'Bearer realm="olcys"');
  assert.equal((await secured.inject({ url: '/api/cases', headers: { authorization: 'Bearer zly-token-0123456789' } })).statusCode, 401);
  assert.equal((await secured.inject({ url: '/api/cases', headers: { authorization: `Bearer ${TOKEN}` } })).statusCode, 200);
  assert.equal((await secured.inject({ url: '/api/cases', headers: { cookie: `inne=1; olcys_token=${encodeURIComponent(TOKEN)}` } })).statusCode, 200);
  // Ciasteczko nie wystarcza do zmiany danych (ochrona przed CSRF).
  const viaCookie = await secured.inject({ method: 'POST', url: '/api/cases', headers: { cookie: `olcys_token=${TOKEN}` }, payload: { name: 'x', identifiers: [{ type: 'nick', value: 'x' }] } });
  assert.equal(viaCookie.statusCode, 401);
  // Nowe trasy też są chronione.
  for (const url of ['/api/audit', '/api/retention/preview', '/api/security/status']) assert.equal((await secured.inject(url)).statusCode, 401, url);
  // Bez skonfigurowanego tokenu wszystko działa jak dotąd.
  assert.equal((await open.inject('/api/cases')).statusCode, 200);
});

test('/api/health przy włączonym tokenie nie ujawnia wersji, źródeł ani konfiguracji', async () => {
  const anonymous = await secured.inject('/api/health');
  assert.equal(anonymous.statusCode, 200);
  assert.deepEqual(anonymous.json(), { status: 'ok', authRequired: true });
  const authorized = (await secured.inject({ url: '/api/health', headers: { authorization: `Bearer ${TOKEN}` } })).json();
  assert.ok(authorized.version && authorized.sources);
  assert.ok((await open.inject('/api/health')).json().version, 'bez tokenu — pełny stan jak dotąd');
});

test('nagłówki bezpieczeństwa i ścisła polityka treści na każdej odpowiedzi API', async () => {
  for (const url of ['/api/health', '/api/cases', '/api/nie-ma']) {
    const response = await open.inject(url);
    assert.equal(response.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(response.headers['referrer-policy'], 'no-referrer', url);
    assert.equal(response.headers['x-frame-options'], 'DENY', url);
    assert.match(String(response.headers['content-security-policy']), /default-src 'none'.*frame-ancestors 'none'/, url);
    assert.equal(response.headers['cache-control'], 'no-store', url);
  }
  // Odpowiedź 401 też ma nagłówki.
  assert.equal((await secured.inject('/api/cases')).headers['x-frame-options'], 'DENY');
});

test('błąd wewnętrzny nie ujawnia śladu stosu ani treści wyjątku', async () => {
  const app = Fastify();
  registerSecurity(app, {});
  app.setErrorHandler((_error, _request, reply) => reply.code(500).send({ error: 'Błąd wewnętrzny serwera.' }));
  app.get('/api/wybuch', async () => {
    throw new Error('sekret: /home/uzytkownik/plik.ts:12');
  });
  const response = await app.inject('/api/wybuch');
  assert.equal(response.statusCode, 500);
  assert.ok(!response.body.includes('sekret') && !response.body.includes('.ts:'));
  // Ten sam kształt daje obsługa błędów aplikacji.
  const real = await open.inject({ method: 'POST', url: '/api/cases', payload: '{"zly json', headers: { 'content-type': 'application/json' } });
  assert.equal(real.statusCode, 400);
  assert.ok(!real.body.includes('at '), 'bez stosu wywołań');
});

test('CORS tylko dla interfejsu; obcy Origin nie może zmieniać danych; obcy Host (DNS rebinding) odrzucony', async () => {
  const fromUi = await open.inject({ url: '/api/cases', headers: { origin: 'http://localhost:5173' } });
  assert.equal(fromUi.headers['access-control-allow-origin'], 'http://localhost:5173');
  const foreign = await open.inject({ url: '/api/cases', headers: { origin: 'https://zla-strona.example' } });
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);

  const csrf = await open.inject({ method: 'POST', url: '/api/monitor/run', headers: { origin: 'https://zla-strona.example' } });
  assert.equal(csrf.statusCode, 403);
  // Interfejs podawany z portu API (ta sama strona) jest dozwolony.
  const same = await open.inject({ method: 'POST', url: '/api/cases', headers: { origin: 'http://localhost:4000', host: 'localhost:4000' }, payload: { name: 'x', identifiers: [{ type: 'nick', value: 'x' }] } });
  assert.equal(same.statusCode, 201);

  assert.equal((await open.inject({ url: '/api/cases', headers: { host: 'atakujacy.example:4000' } })).statusCode, 403);
  assert.equal((await open.inject({ url: '/api/cases', headers: { host: '192.168.1.20:5173' } })).statusCode, 200, 'adres IP w sieci lokalnej dozwolony');
});

test('limit kosztownych żądań na adres IP: 429 z Retry-After', async () => {
  const headers = { authorization: `Bearer ${TOKEN}` };
  const codes: number[] = [];
  for (let index = 0; index < 3; index++) {
    codes.push((await secured.inject({ method: 'POST', url: '/api/quick', headers, payload: { value: '' } })).statusCode);
  }
  assert.deepEqual(codes.slice(0, 2), [400, 400]);
  assert.equal(codes[2], 429);
  const limited = await secured.inject({ method: 'POST', url: '/api/quick', headers, payload: { value: '' } });
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.match(limited.json().error, /Za dużo kosztownych żądań/);
  // Inne trasy nie są objęte limitem.
  assert.equal((await secured.inject({ url: '/api/cases', headers })).statusCode, 200);

  let time = 0;
  const limiter = createRateLimiter(2, 60_000, () => time);
  assert.deepEqual([limiter.take('a'), limiter.take('a'), limiter.take('a') > 0, limiter.take('b')], [0, 0, true, 0]);
  time = 60_001;
  assert.equal(limiter.take('a'), 0, 'okno przesuwa się w czasie');
});

test('zamykanie serwera: tylko wprost na porcie API z tej maszyny, nie przez proxy ani przeglądarkę; z tokenem, gdy ustawiony', async () => {
  const shutdowns: string[] = [];
  const app = Fastify();
  registerSecurity(app, { apiToken: TOKEN });
  registerAdminShutdown(app, { port: 4000, onShutdown: () => shutdowns.push('zamknij') });
  const call = (headers: Record<string, string>, remoteAddress = '127.0.0.1') =>
    app.inject({ method: 'POST', url: '/api/admin/shutdown', remoteAddress, headers: { host: 'localhost:4000', authorization: `Bearer ${TOKEN}`, ...headers } });

  assert.equal((await call({}, '192.168.1.5')).statusCode, 403, 'inny komputer');
  assert.equal((await call({ host: '192.168.1.5:5173' })).statusCode, 403, 'przez proxy interfejsu (Vite)');
  assert.equal((await call({ 'x-forwarded-for': '10.0.0.2' })).statusCode, 403, 'przez pośrednika');
  assert.equal((await call({ origin: 'http://localhost:4000' })).statusCode, 403, 'z przeglądarki');
  assert.equal((await call({ authorization: '' })).statusCode, 401, 'bez tokenu');
  assert.equal(shutdowns.length, 0);
  const ok = await call({});
  assert.equal(ok.statusCode, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(shutdowns, ['zamknij']);
  await app.close();
});

test('konfiguracja ze zmiennych: domyślnie bez tokenu; za krótki token zatrzymuje start', () => {
  const defaults = securityFromEnv({});
  assert.equal(defaults.apiToken, undefined);
  assert.ok(defaults.corsOrigins.includes('http://localhost:5173'));
  assert.equal(defaults.rateLimitPerMinute, 30);
  assert.throws(() => securityFromEnv({ OLCYS_API_TOKEN: 'krotki' }), /za krótki/);
  const custom = securityFromEnv({ OLCYS_API_TOKEN: TOKEN, OLCYS_WEB_ORIGIN: 'https://olcys.example/, http://10.0.0.5:5173', OLCYS_RATE_LIMIT_PER_MIN: '0' });
  assert.deepEqual([custom.apiToken, custom.corsOrigins, custom.rateLimitPerMinute], [TOKEN, ['https://olcys.example', 'http://10.0.0.5:5173'], 0]);
});
