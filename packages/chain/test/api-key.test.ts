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
  assert.deepEqual(providers.map((item) => item.id).slice(-2), ['trongrid', 'blockscout-ethereum-fallback'], 'publiczna instancja Ethereum jest zapasem');
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
  const scoped = createChainProviders({ enableLive: true, blockscoutApiKey: KEY, fetch: async (url) => { mixed.push(url); return new Response('not found', { status: 404 }); }, externalLabels: false });
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
