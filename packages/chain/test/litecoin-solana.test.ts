// Litecoin (litecoinspace.org, API Esplora) i Solana (węzeł JSON-RPC operatora) — atrapy `fetch`, bez sieci.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createChainProviders, getActivityFromProviders } from '../src/index.ts';
import { DEFAULT_HOST_POLICIES } from '../src/http.ts';
import type { FetchLike } from '../src/http.ts';
import { createLabelSet } from '../src/labels.ts';
import { EsploraProvider } from '../src/providers/esplora.ts';
import { SolanaRpcProvider, solanaTransfers } from '../src/providers/solana.ts';
import { BINANCE_PAIRS, StaticRateSource } from '../src/valuation.ts';
import { mockFetch, testContext } from './helpers.ts';

// ---------- Litecoin ----------

const LTC_SITE = 'https://litecoinspace.org';
const LTC_SUBJECT = 'LbNzkvEjayzxfvfJMXcDnVboRL3QmyorVR';
const LTC_SENDER = 'MAjp69WNyhGGGWZS1kSFWcAPuFDByCoghi';
const LTC_EXCHANGE = 'ltc1q0yws8mlw9pkhyu5e99232u50tfs8t5pm6gj8g3';
const LTC_OTHER = 'LcERhRYB4TUVWdKnP4ZJxHksVXSSuYBbdC';

const ltcRates = new StaticRateSource({ source: 'tabela testowa', rates: { LTC: { '2026-03': 400 } } });

const ltcRoutes = {
  [`${LTC_SITE}/api/address/${LTC_SUBJECT}`]: { chain_stats: { funded_txo_sum: 500_000_000, spent_txo_sum: 300_000_000, tx_count: 2 } },
  [`${LTC_SITE}/api/address/${LTC_SUBJECT}/txs`]: [
    {
      txid: 'ltc-out',
      status: { confirmed: true, block_time: Date.parse('2026-03-12T10:00:00Z') / 1000 },
      vin: [{ txid: 'ltc-in', vout: 0, prevout: { scriptpubkey_address: LTC_SUBJECT, value: 500_000_000, scriptpubkey_type: 'p2pkh' } }],
      vout: [
        { scriptpubkey_address: LTC_EXCHANGE, value: 300_000_000, scriptpubkey_type: 'v0_p2wpkh' },
        { scriptpubkey_address: LTC_OTHER, value: 199_990_000, scriptpubkey_type: 'p2pkh' },
      ],
    },
    {
      txid: 'ltc-in',
      status: { confirmed: true, block_time: Date.parse('2026-03-10T10:00:00Z') / 1000 },
      vin: [{ txid: 'zrodlo', vout: 1, prevout: { scriptpubkey_address: LTC_SENDER, value: 600_000_000, scriptpubkey_type: 'p2sh' } }],
      vout: [
        { scriptpubkey_address: LTC_SUBJECT, value: 500_000_000, scriptpubkey_type: 'p2pkh' },
        { scriptpubkey_address: LTC_SENDER, value: 99_990_000, scriptpubkey_type: 'p2sh' },
      ],
    },
  ],
};

test('litecoin: profil, przelewy LTC, odnośniki litecoinspace.org i wypłata na oznaczoną giełdę z wyceną', async () => {
  const mock = mockFetch(ltcRoutes);
  const labels = createLabelSet([{ network: 'litecoin', address: LTC_EXCHANGE, label: 'Giełda testowa', addressClass: 'exchange' }], 'etykiety testowe');
  const provider = new EsploraProvider({ id: 'ltc', label: 'Litecoin Space (Litecoin)', network: 'litecoin', siteUrl: LTC_SITE, fetch: mock.fetch, labels, rateSource: ltcRates });
  assert.equal(provider.supports('litecoin'), true);
  assert.equal(provider.supports('bitcoin'), false);
  assert.equal(provider.supports('bitcoin-testnet'), false, 'sieć testowa tylko dla Bitcoina');

  const activity = await provider.getActivity('litecoin', LTC_SUBJECT, testContext());
  assert.equal(activity.profile.network, 'litecoin');
  assert.equal(activity.profile.nativeAsset, 'LTC');
  assert.equal(activity.profile.txCount, 2);
  assert.equal(activity.profile.balance, 2);
  assert.deepEqual(
    activity.transfers.map((item) => [item.txid, item.direction, item.counterparty, item.asset, item.amount]),
    [
      ['ltc-in', 'in', LTC_SENDER, 'LTC', 5],
      ['ltc-out', 'out', LTC_EXCHANGE, 'LTC', 3],
    ],
  );
  assert.equal(activity.transfers[0]!.explorerUrl, `${LTC_SITE}/tx/ltc-in`);
  assert.equal(activity.cashOuts.length, 1);
  assert.equal(activity.cashOuts[0]!.asset, 'LTC');
  assert.equal(activity.cashOuts[0]!.valuePln, 1200);
  assert.ok(activity.limitations.some((item) => item.startsWith('Litecoin: kontrahent transakcji')));
  assert.ok(activity.limitations.some((item) => /nie zawiera adresów giełd w sieci Litecoin/.test(item)));
  assert.ok(!activity.limitations.some((item) => /^Bitcoin:/.test(item)), 'opisy nie mówią o Bitcoinie');
  assert.ok(mock.calls.every((url) => url.startsWith(`${LTC_SITE}/api/`)));
});

test('litecoin: fabryka kieruje adresy L… do litecoinspace.org; host ma ostrożne tempo; LTC i SOL mają pary Binance', async () => {
  const mock = mockFetch(ltcRoutes);
  const providers = createChainProviders({ enableLive: true, fetch: mock.fetch, findLinks: false, rateSource: ltcRates });
  const activity = await getActivityFromProviders(providers, 'litecoin', LTC_SUBJECT, testContext());
  assert.equal(activity.profile.nativeAsset, 'LTC');
  assert.equal(activity.transfers.length, 2);
  assert.ok(mock.calls.length > 0 && mock.calls.every((url) => new URL(url).host === 'litecoinspace.org'), mock.calls.join(', '));
  assert.ok(DEFAULT_HOST_POLICIES['litecoinspace.org']);
  assert.equal(BINANCE_PAIRS.LTC, 'LTCUSDT');
  assert.equal(BINANCE_PAIRS.SOL, 'SOLUSDT');
});

// ---------- Solana ----------

const SOL_SUBJECT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_SENDER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_EXCHANGE = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const SYSTEM = '11111111111111111111111111111111';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const OTHER_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const RPC = 'https://rpc.example.com/klucz-tajny?api-key=tajne';
const t = (iso: string) => Date.parse(iso) / 1000;

const solTransactions: Record<string, unknown> = {
  'sig-in': {
    blockTime: t('2026-04-01T08:00:00Z'),
    meta: { err: null, fee: 5000, preBalances: [5_000_000_000, 1_000_000_000, 1], postBalances: [2_999_995_000, 3_000_000_000, 1], preTokenBalances: [], postTokenBalances: [] },
    transaction: { message: { accountKeys: [{ pubkey: SOL_SENDER, signer: true }, { pubkey: SOL_SUBJECT, signer: false }, { pubkey: SYSTEM, signer: false }] } },
  },
  'sig-usdc': {
    blockTime: t('2026-04-02T08:00:00Z'),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [3_000_000_000, 2_039_280, 2_039_280, 1],
      postBalances: [2_999_995_000, 2_039_280, 2_039_280, 1],
      preTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: SOL_SUBJECT, uiTokenAmount: { amount: '150000000', decimals: 6 } },
        { accountIndex: 2, mint: USDC, owner: SOL_EXCHANGE, uiTokenAmount: { amount: '0', decimals: 6 } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: USDC, owner: SOL_SUBJECT, uiTokenAmount: { amount: '50000000', decimals: 6 } },
        { accountIndex: 2, mint: USDC, owner: SOL_EXCHANGE, uiTokenAmount: { amount: '100000000', decimals: 6 } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: SOL_SUBJECT, signer: true }, 'ataSubject', 'ataExchange', SOL_SENDER] } },
  },
  'sig-other': {
    blockTime: t('2026-04-03T08:00:00Z'),
    meta: {
      err: null,
      fee: 5000,
      preBalances: [2_999_995_000, 2_039_280],
      postBalances: [2_999_990_000, 2_039_280],
      preTokenBalances: [{ accountIndex: 1, mint: OTHER_MINT, owner: SOL_SUBJECT, uiTokenAmount: { amount: '10', decimals: 5 } }],
      postTokenBalances: [{ accountIndex: 1, mint: OTHER_MINT, owner: SOL_SUBJECT, uiTokenAmount: { amount: '0', decimals: 5 } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: SOL_SUBJECT, signer: true }, 'ataOther'] } },
  },
};

/** Atrapa węzła JSON-RPC: odpowiada według metody z treści żądania POST. */
function fakeRpc(overrides: Record<string, unknown> = {}): { fetch: FetchLike; calls: { url: string; method: string; params: unknown[] }[] } {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(init?.method, 'POST');
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ url, method: body.method, params: body.params });
    const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (body.method in overrides) {
      const value = overrides[body.method];
      if (value instanceof Response) return value;
      return reply(value);
    }
    if (body.method === 'getBalance') return reply({ context: { slot: 1 }, value: 2_999_990_000 });
    if (body.method === 'getSignaturesForAddress') {
      return reply([
        { signature: 'sig-other', blockTime: t('2026-04-03T08:00:00Z'), err: null },
        { signature: 'sig-failed', blockTime: t('2026-04-02T12:00:00Z'), err: { InstructionError: [0, 'Custom'] } },
        { signature: 'sig-usdc', blockTime: t('2026-04-02T08:00:00Z'), err: null },
        { signature: 'sig-in', blockTime: t('2026-04-01T08:00:00Z'), err: null },
      ]);
    }
    if (body.method === 'getTransaction') return reply(solTransactions[String(body.params[0])] ?? null);
    return new Response('nieznana metoda', { status: 400 });
  };
  return { fetch: fetchImpl, calls };
}

const solRates = new StaticRateSource({ source: 'tabela testowa', rates: { USDC: { '2026-04': 3.6 }, SOL: { '2026-04': 600 } } });

test('solana: saldo, liczba transakcji, przelewy SOL i USDC, pominięte tokeny i transakcje z błędem', async () => {
  const rpc = fakeRpc();
  const labels = createLabelSet([{ network: 'solana', address: SOL_EXCHANGE, label: 'Giełda testowa (Solana)', addressClass: 'exchange' }], 'etykiety testowe');
  const provider = new SolanaRpcProvider({ rpcUrl: RPC, fetch: rpc.fetch, labels, rateSource: solRates });
  const activity = await provider.getActivity('solana', SOL_SUBJECT, testContext());

  assert.equal(activity.profile.network, 'solana');
  assert.equal(activity.profile.nativeAsset, 'SOL');
  assert.equal(activity.profile.txCount, 4);
  assert.equal(activity.profile.balance, 2.99999);
  assert.deepEqual(
    activity.transfers.map((item) => [item.txid, item.direction, item.counterparty, item.asset, item.amount]),
    [
      ['sig-in', 'in', SOL_SENDER, 'SOL', 2],
      ['sig-usdc', 'out', SOL_EXCHANGE, 'USDC', 100],
    ],
  );
  assert.equal(activity.transfers[0]!.explorerUrl, 'https://explorer.solana.com/tx/sig-in');
  assert.equal(activity.cashOuts.length, 1);
  assert.equal(activity.cashOuts[0]!.valuePln, 360);
  assert.ok(activity.limitations.some((item) => /pominięto 1 transakcji zakończonych błędem/.test(item)));
  assert.ok(activity.limitations.some((item) => /w 1 transakcjach zmieniło się saldo innych tokenów SPL/.test(item)));
  assert.ok(activity.limitations.some((item) => /liczba transakcji \(4\)/.test(item)));
  // Transakcji z błędem nie pobieramy; saldo + podpisy + 3 transakcje = 5 żądań.
  assert.deepEqual(rpc.calls.map((call) => call.method), ['getBalance', 'getSignaturesForAddress', 'getTransaction', 'getTransaction', 'getTransaction']);
  assert.ok(rpc.calls.every((call) => call.url === RPC && JSON.stringify(call.params).includes('finalized')));
  // Klucz z adresu węzła nie trafia do opisów.
  assert.ok(!JSON.stringify(activity).includes('tajne'));
});

test('solana: limit rozpisywanych transakcji i pełna strona podpisów („co najmniej”)', async () => {
  const many = Array.from({ length: 1000 }, (_, index) => ({ signature: `sig-${index}`, blockTime: t('2026-04-01T08:00:00Z') - index, err: null }));
  const rpc = fakeRpc({ getSignaturesForAddress: many, getTransaction: null });
  const provider = new SolanaRpcProvider({ rpcUrl: RPC, fetch: rpc.fetch, maxTransactions: 3 });
  const activity = await provider.getActivity('solana', SOL_SUBJECT, testContext());
  assert.equal(rpc.calls.filter((call) => call.method === 'getTransaction').length, 3);
  assert.ok(activity.limitations.some((item) => /co najmniej 1000/.test(item)));
  assert.ok(activity.limitations.some((item) => /Pobrano jedną stronę listy podpisów/.test(item)));
  assert.equal(activity.profile.firstSeen, undefined, 'niepełna historia — bez daty pierwszej transakcji');
});

test('solana: błąd węzła nie ujawnia adresu z kluczem; błąd JSON-RPC jest czytelny', async () => {
  const denied = new SolanaRpcProvider({ rpcUrl: RPC, fetch: fakeRpc({ getBalance: new Response('x', { status: 401 }) }).fetch });
  await assert.rejects(denied.getActivity('solana', SOL_SUBJECT, testContext()), (error: Error) => /Solana RPC \(rpc\.example\.com\)/.test(error.message) && !error.message.includes('tajne'));
  const limited = new SolanaRpcProvider({
    rpcUrl: RPC,
    fetch: async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Node is behind' } }), { status: 200 }),
  });
  await assert.rejects(limited.getActivity('solana', SOL_SUBJECT, testContext()), (error: Error & { code?: string }) => error.code === 'rate_limited' && /getBalance/.test(error.message));
});

test('solana: bez węzła RPC operatora — zero zapytań i jawny powód w ograniczeniach', async () => {
  const mock = mockFetch({});
  const providers = createChainProviders({ enableLive: true, fetch: mock.fetch });
  const activity = await getActivityFromProviders(providers, 'solana', SOL_SUBJECT, testContext());
  assert.equal(mock.calls.length, 0);
  assert.equal(activity.profile.nativeAsset, 'SOL');
  assert.match(activity.limitations[0] ?? '', /Sieć Solana: aktywność adresu NIE została sprawdzona.*SOLANA_RPC_URL/);
});

test('solana: rozpisanie transakcji — adres płacący opłatę nie ma przelewu SOL, gdy zmieniła się tylko opłata', () => {
  const { transfers } = solanaTransfers(solTransactions['sig-usdc'] as never, 'sig-usdc', SOL_SUBJECT, 'https://explorer.solana.com');
  assert.deepEqual(transfers.map((item) => item.asset), ['USDC']);
});
