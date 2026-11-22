// Klucz API Blockscout: trasy przez api.blockscout.com, klucz wyłącznie w nagłówku, brak wycieku wartości.
// Klucz w testach jest zmyślony.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChainProviderError, fetchJson } from '../src/http.ts';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { createKeyedFetch, loadEvmNetworks, resolveEvmNetworks } from '../src/networks.ts';
import type { MultiChainActivity } from '../src/networks.ts';
import { testContext } from './helpers.ts';

const KEY = 'proapi_TEST-not-a-real-key-123';
const SUBJECT = `0x${'1'.repeat(40)}`;

test('rejestr z kluczem: sieci tylko-z-kluczem dochodzą, obsługiwane idą przez api.blockscout.com/<chainId>', () => {
  const without = resolveEvmNetworks(false);
  const withKey = resolveEvmNetworks(true);
  assert.ok(!without.some((item) => item.id === 'arbitrum' || item.id === 'gnosis'));
  assert.ok(without.every((item) => !item.apiUrl.includes('api.blockscout.com')));
  assert.equal(without.find((item) => item.id === 'ethereum')?.apiUrl, 'https://eth.blockscout.com');

  assert.equal(withKey.find((item) => item.id === 'ethereum')?.apiUrl, 'https://api.blockscout.com/1');
  assert.equal(withKey.find((item) => item.id === 'arbitrum')?.apiUrl, 'https://api.blockscout.com/42161');
  assert.equal(withKey.find((item) => item.id === 'gnosis')?.nativeAsset, 'XDAI');
  // ZKsync: API z kluczem odmawia na planie darmowym, więc zostaje publiczna instancja.
  assert.equal(withKey.find((item) => item.id === 'zksync')?.apiUrl, 'https://zksync.blockscout.com');
  // Odnośniki dla ludzi nadal prowadzą do eksploratora sieci, nie do API.
  assert.equal(withKey.find((item) => item.id === 'arbitrum')?.explorerUrl, 'https://arbitrum.blockscout.com');

  const registry = loadEvmNetworks();
  assert.deepEqual(registry.keyed.map((item) => item.id), ['arbitrum', 'gnosis']);
  for (const id of ['base', 'polygon']) {
    assert.match(registry.unavailable.find((item) => item.id === id)?.reason ?? '', /HTTP 402 .*wymaga płatnego planu/);
  }
  assert.match(registry.unavailable.find((item) => item.id === 'bnb')?.reason ?? '', /HTTP 404 „Network not supported”/);
});

test('klucz trafia wyłącznie do nagłówka żądań do api.blockscout.com; inne hosty go nie dostają', async () => {
  const seen: { url: string; authorization?: string; agent?: string }[] = [];
  const { fetch: keyed, usage } = createKeyedFetch(async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen.push({ url, authorization: headers.authorization, agent: headers['user-agent'] });
    return new Response('{}', { status: 200, headers: { 'x-credits-remaining': '99980' } });
  }, KEY);
  await fetchJson(keyed, 'https://api.blockscout.com/1/api/v2/addresses/0xabc', { source: 'test' });
  await fetchJson(keyed, 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT', { source: 'test' });
  assert.deepEqual(seen, [
    { url: 'https://api.blockscout.com/1/api/v2/addresses/0xabc', authorization: `Bearer ${KEY}`, agent: 'OLCyS-research/0.1' },
    { url: 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT', authorization: undefined, agent: 'OLCyS-research/0.1' },
  ]);
  assert.deepEqual(usage, { calls: 1, creditsRemaining: 99980 });

  // Błąd sieci nie może zdradzić klucza, nawet gdyby biblioteka wpisała go do komunikatu.
  const failing = createKeyedFetch(async () => {
    throw new Error(`connect failed for Bearer ${KEY}`);
  }, KEY);
  await assert.rejects(fetchJson(failing.fetch, 'https://api.blockscout.com/1/api/v2/stats', { source: 'Blockscout' }), (error: unknown) => {
    assert.ok(error instanceof ChainProviderError);
    assert.ok(!error.message.includes(KEY));
    assert.match(error.message, /Bearer \*\*\*/);
    return true;
  });
});

test('analiza z kluczem: żądania EVM idą przez api.blockscout.com, a klucza nie ma w adresach ani w wyniku', async () => {
  const urls: string[] = [];
  let authorized = 0;
  const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null });
  const base = `https://api.blockscout.com/1/api/v2/addresses/${SUBJECT}`;
  const routes: Record<string, unknown> = {
    [base]: { ...party(SUBJECT), coin_balance: '1000000000000000000' },
    [`${base}/transactions`]: { items: [{ hash: '0xt1', timestamp: '2025-05-01T08:00:00.000000Z', from: party(`0x${'9'.repeat(40)}`), to: party(SUBJECT), value: '1000000000000000000', status: 'ok' }], next_page_params: null },
    [`${base}/token-transfers?type=ERC-20`]: { items: [], next_page_params: null },
    [`${base}/token-balances`]: [],
    [`https://api.blockscout.com/42161/api/v2/addresses/${SUBJECT}/counters`]: { transactions_count: '7', token_transfers_count: '2' },
    [`https://api.blockscout.com/42161/api/v2/addresses/${SUBJECT}`]: { coin_balance: '250000000000000000' },
    // Sieć wymagająca płatnego planu odpowiada 402 — analiza trwa dalej.
    [`https://api.blockscout.com/10/api/v2/addresses/${SUBJECT}/counters`]: { status: 402 },
  };
  const fetchImpl = async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (((init?.headers ?? {}) as Record<string, string>).authorization === `Bearer ${KEY}`) authorized += 1;
    const route = routes[url];
    if (route === undefined) return new Response('not found', { status: 404 });
    if (typeof route === 'object' && route !== null && 'status' in route && Object.keys(route).length === 1) return new Response('{"error":"Featured chain requires plan"}', { status: (route as { status: number }).status });
    return new Response(JSON.stringify(route), { status: 200 });
  };
  const providers = createChainProviders({ enableLive: true, blockscoutApiKey: KEY, blockscoutKeyScope: 'all', fetch: fetchImpl, externalLabels: false, findLinks: false });
  assert.deepEqual(providers.map((item) => item.id).slice(-3), ['blockscout-ethereum', 'trongrid', 'esplora-litecoinspace'], 'obie drogi do Ethereum są w jednym dostawcy');
  const activity = (await getActivityFromProviders(providers, 'ethereum', SUBJECT, testContext())) as MultiChainActivity;

  assert.equal(activity.profile.balance, 1);
  assert.deepEqual(activity.networks?.map((item) => [item.networkId, item.txCount, item.balance]), [['ethereum', 1, 1], ['arbitrum', 7, 0.25]]);
  assert.equal(activity.networks?.[1]?.explorerUrl, `https://arbitrum.blockscout.com/address/${SUBJECT}`);
  assert.ok(activity.limitations.some((item) => /nie udało się sprawdzić .*OP Mainnet \(Optimism\) \(HTTP 402\)/.test(item)));

  const keyedCalls = urls.filter((url) => url.startsWith('https://api.blockscout.com/'));
  assert.ok(keyedCalls.length >= 6);
  assert.equal(authorized, keyedCalls.length, 'każde żądanie do API z kluczem niesie nagłówek, inne go nie mają');
  assert.ok(!urls.some((url) => url.includes('eth.blockscout.com')), 'z kluczem Ethereum nie idzie przez publiczną instancję');
  // Wartość klucza nie występuje w żadnym adresie ani nigdzie w wyniku analizy.
  assert.ok(urls.every((url) => !url.includes(KEY) && !url.includes('apikey')));
  assert.ok(!JSON.stringify(activity).includes(KEY));

  // Tryb domyślny (`required`): Ethereum przez publiczną instancję, klucz tylko dla sieci niedostępnych bez niego.
  const mixed: string[] = [];
  const scoped = createChainProviders({ enableLive: true, blockscoutApiKey: KEY, fetch: async (url) => { mixed.push(url); return new Response('bad gateway', { status: url.includes('eth.blockscout.com') ? 502 : 404 }); }, externalLabels: false });
  await getActivityFromProviders(scoped, 'ethereum', SUBJECT, testContext());
  assert.ok(mixed.some((url) => url.startsWith(`https://eth.blockscout.com/api/v2/addresses/${SUBJECT}`)));
  assert.ok(mixed.some((url) => url.startsWith('https://api.blockscout.com/42161/')) && mixed.some((url) => url.startsWith('https://api.blockscout.com/100/')));
  assert.ok(!mixed.some((url) => url.startsWith('https://api.blockscout.com/10/')), 'Optimism ma publiczną instancję, więc nie zużywa kredytów');
  // Gdy publiczna instancja zawiedzie, Ethereum próbuje jeszcze wspólnego API z kluczem.
  assert.ok(mixed.some((url) => url.startsWith(`https://api.blockscout.com/1/api/v2/addresses/${SUBJECT}`)));

  // Bez klucza zachowanie jak dotąd: publiczna instancja, brak nagłówka.
  const plain: string[] = [];
  const noKey = createChainProviders({ enableLive: true, blockscoutApiKey: '  ', fetch: async (url) => { plain.push(url); return new Response('not found', { status: 404 }); }, externalLabels: false });
  await getActivityFromProviders(noKey, 'ethereum', SUBJECT, testContext());
  assert.ok(plain.some((url) => url.startsWith('https://eth.blockscout.com/')) && !plain.some((url) => url.includes('api.blockscout.com')));
});

test('odpowiedzi 401 i 402 mają czytelny opis bez szczegółów żądania', async () => {
  const reply = (status: number) => async () => new Response('{}', { status });
  await assert.rejects(fetchJson(reply(401), 'https://api.blockscout.com/1/api/v2/stats', { source: 'Blockscout (Ethereum)' }), /Blockscout \(Ethereum\): klucz API został odrzucony \(HTTP 401\)/);
  await assert.rejects(fetchJson(reply(402), 'https://api.blockscout.com/8453/api/v2/stats', { source: 'Blockscout (Base)' }), /wymaga wyższego planu API albo wyczerpano dzienny limit kredytów \(HTTP 402\)/);
});

test('dwie drogi do Ethereum: po awarii publicznej instancji przez 10 minut pytamy od razu API z kluczem', async () => {
  const { FailoverProvider } = await import('../src/networks.ts');
  const { BlockscoutProvider, EVM_REQUEST_TIMEOUT_MS } = await import('../src/providers/blockscout.ts');
  const party = (hash: string) => ({ hash, is_contract: false, metadata: null, name: null });
  const calls: { url: string; timeoutMs?: number }[] = [];
  let publicBroken: 'timeout' | 'json' | 'ok' = 'timeout';
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, timeoutMs: (init as { timeoutMs?: number } | undefined)?.timeoutMs });
    if (url.startsWith('https://eth.blockscout.com/') && publicBroken === 'timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    if (url.startsWith('https://eth.blockscout.com/') && publicBroken === 'json') return new Response('<html>Just a moment…</html>', { status: 200 });
    if (url.endsWith(SUBJECT)) return new Response(JSON.stringify({ ...party(SUBJECT), coin_balance: '2000000000000000000' }), { status: 200 });
    return new Response(JSON.stringify({ items: [], next_page_params: null }), { status: 200 });
  };
  let clock = Date.parse('2026-11-21T12:00:00Z');
  const route = (apiUrl: string) => new BlockscoutProvider({ fetch: fetchImpl, chain: { id: 'ethereum', name: 'Ethereum', chainId: 1, nativeAsset: 'ETH', apiUrl, explorerUrl: 'https://eth.blockscout.com', stablecoins: [] } });
  const failover = new FailoverProvider({
    primary: route('https://eth.blockscout.com'),
    secondary: route('https://api.blockscout.com/1'),
    primaryRoute: 'publiczna instancja eth.blockscout.com',
    secondaryRoute: 'API Blockscout z kluczem (api.blockscout.com)',
    now: () => clock,
  });
  const hosts = () => calls.splice(0).map((call) => new URL(call.url).host);
  const logged = testContext();

  // 1. Publiczna instancja przekracza czas → dane z API z kluczem, z jasnym wpisem o drodze.
  const first = await failover.getActivity('ethereum', SUBJECT, logged);
  assert.equal(first.profile.balance, 2);
  assert.match(first.limitations[0] ?? '', /^Droga danych: API Blockscout z kluczem \(api\.blockscout\.com\) — publiczna instancja eth\.blockscout\.com zawiodła \(Blockscout \(Ethereum\): brak odpowiedzi w ciągu 25 s\.\)\.$/);
  assert.ok(logged.messages.some((message) => /przez 10 min dane pobierane będą drogą: API Blockscout z kluczem/.test(message)));
  const firstHosts = hosts();
  assert.ok(firstHosts.includes('eth.blockscout.com') && firstHosts.includes('api.blockscout.com'));

  // 2. W ciągu 10 minut publiczna instancja nie jest w ogóle pytana — bez czekania na jej limit czasu.
  clock += 9 * 60_000;
  const second = await failover.getActivity('ethereum', SUBJECT, testContext());
  assert.deepEqual([...new Set(hosts())], ['api.blockscout.com']);
  assert.match(second.limitations[0] ?? '', /^Droga danych: API Blockscout z kluczem .* zawiodła niedawno .* przez najbliższe 1 min jest pomijana\.$/);

  // 3. Po 10 minutach próbujemy publicznej ponownie; gdy działa, wracamy do niej.
  clock += 2 * 60_000;
  publicBroken = 'ok';
  const third = await failover.getActivity('ethereum', SUBJECT, testContext());
  assert.deepEqual([...new Set(hosts())], ['eth.blockscout.com']);
  assert.equal(third.limitations[0], 'Droga danych: publiczna instancja eth.blockscout.com.');

  // 4. Niepoprawny JSON (np. strona blokady) też przełącza drogę; „nieznany adres” (404) — nie.
  publicBroken = 'json';
  const fourth = await failover.getActivity('ethereum', SUBJECT, testContext());
  assert.match(fourth.limitations[0] ?? '', /zawiodła \(Blockscout \(Ethereum\): odpowiedź nie jest poprawnym JSON-em\.\)/);
  assert.ok(failover.skipPrimaryUntil > clock);
  const unknown = new FailoverProvider({
    primary: new BlockscoutProvider({ fetch: async () => new Response('not found', { status: 404 }) }),
    secondary: route('https://api.blockscout.com/1'),
    primaryRoute: 'publiczna',
    secondaryRoute: 'kluczowa',
  });
  await assert.rejects(unknown.getActivity('ethereum', SUBJECT, testContext()), /nieznany adres \(HTTP 404\)/);
  assert.equal(unknown.skipPrimaryUntil, 0);

  // Limit czasu żądań do eksploratorów EVM: domyślnie 25 s, konfigurowalny.
  assert.equal(EVM_REQUEST_TIMEOUT_MS, 25_000);
  calls.length = 0;
  await route('https://api.blockscout.com/1').getActivity('ethereum', SUBJECT, testContext());
  assert.ok(calls.length >= 3 && calls.every((call) => call.timeoutMs === 25_000));
  calls.length = 0;
  const custom = createChainProviders({ enableLive: true, fetch: fetchImpl, evmTimeoutMs: 40_000, externalLabels: false, findLinks: false, evmNetworks: false });
  publicBroken = 'ok';
  await getActivityFromProviders(custom, 'ethereum', SUBJECT, testContext());
  assert.ok(calls.filter((call) => call.url.includes('blockscout')).every((call) => call.timeoutMs === 40_000));
});
