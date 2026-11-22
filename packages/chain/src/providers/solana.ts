// Solana przez węzeł JSON-RPC wskazany przez operatora (zmienna SOLANA_RPC_URL).
// Publicznego węzła api.mainnet-beta.solana.com NIE używamy: dokumentacja mówi, że „nie jest przeznaczony
// do zastosowań produkcyjnych”, a regulaminu nie udało się przeczytać (docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. „Sieci blockchain: Litecoin, Solana”).
//
// Zakres: saldo SOL (getBalance), lista podpisów transakcji adresu (getSignaturesForAddress — liczba transakcji,
// daty) oraz rozpisanie najnowszych transakcji (getTransaction, jsonParsed) na przelewy SOL, USDC i USDT
// z różnicy sald przed i po transakcji — ten sam model „zmiany salda adresu”, co dla Bitcoina.

import type { ChainActivity, ChainProvider, ConnectorContext, Network } from '@olcys/core';
import { buildChainActivity } from '../activity.ts';
import type { ActivityOptions, RawTransfer } from '../activity.ts';
import { DEFAULT_REQUEST_BUDGET } from '../deposit.ts';
import { describeRange, inHistoryRange, planHistory, traceBudgetLimit } from '../history.ts';
import type { HistoryOptions } from '../history.ts';
import { ChainProviderError, RequestBudget, fetchJson } from '../http.ts';
import type { FetchLike } from '../http.ts';

/** Stablecoiny SPL rozpisywane na przelewy (adres emitenta tokena → symbol). Inne tokeny są pomijane. */
export const SOLANA_STABLECOINS: Record<string, { symbol: string; decimals: number }> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6 },
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: { symbol: 'USDT', decimals: 6 },
};

const LAMPORTS = 1e9;
/** Najwięcej podpisów na stronę w `getSignaturesForAddress` (limit protokołu). */
export const SOLANA_SIGNATURE_PAGE = 1000;
/** Domyślnie rozpisujemy na przelewy najwyżej tyle najnowszych transakcji (każda to jedno żądanie). */
export const SOLANA_DEFAULT_TRANSACTIONS = 20;

export interface SolanaProviderConfig extends ActivityOptions {
  /** Adres węzła JSON-RPC (może zawierać klucz dostawcy — nigdy nie trafia do opisów ani błędów). */
  rpcUrl: string;
  fetch?: FetchLike;
  /** Łączny budżet żądań na analizę jednego adresu (saldo + podpisy + transakcje). */
  requestBudget?: number;
  /** Ile najnowszych transakcji rozpisać na przelewy (domyślnie 20, nie więcej niż pozwala budżet). */
  maxTransactions?: number;
  /** Domyślny zakres historii; `full` stronicuje listę podpisów. */
  history?: HistoryOptions;
  /** Eksplorator dla ludzi (domyślnie https://explorer.solana.com). */
  explorerUrl?: string;
  timeoutMs?: number;
}

interface SignatureInfo {
  signature: string;
  slot?: number;
  err?: unknown;
  blockTime?: number | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
}

interface ParsedTransaction {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: ({ pubkey: string; signer?: boolean } | string)[] } };
}

/** Czego rozpisanie transakcji nie ujęło — do `limitations`. */
export interface SolanaTransferNotes {
  /** Transakcja zmieniła saldo innego tokena SPL niż USDC/USDT. */
  otherTokens: boolean;
}

const keyOf = (key: { pubkey: string } | string) => (typeof key === 'string' ? key : key.pubkey);

/**
 * Przelewy badanego adresu w jednej transakcji: SOL z różnicy sald konta (bez opłaty, gdy adres ją płacił)
 * oraz USDC/USDT z różnicy sald kont tokenów, których właścicielem jest adres. Kontrahentem jest konto
 * o największej zmianie przeciwnego znaku (dla tokenów — jego właściciel). Zwraca pustą listę, gdy saldo
 * adresu się nie zmieniło.
 */
export function solanaTransfers(tx: ParsedTransaction, signature: string, address: string, explorerUrl: string): { transfers: RawTransfer[]; notes: SolanaTransferNotes } {
  const transfers: RawTransfer[] = [];
  const time = new Date((tx.blockTime ?? 0) * 1000).toISOString();
  const keys = (tx.transaction?.message?.accountKeys ?? []).map(keyOf);
  const meta = tx.meta ?? {};
  const pre = meta.preBalances ?? [];
  const post = meta.postBalances ?? [];
  const url = `${explorerUrl}/tx/${signature}`;

  // SOL: zmiana salda konta adresu; opłatę płaci pierwszy podpisujący (indeks 0).
  const index = keys.indexOf(address);
  if (index >= 0 && pre[index] !== undefined && post[index] !== undefined) {
    const fee = index === 0 ? (meta.fee ?? 0) : 0;
    const delta = post[index]! - pre[index]! + fee;
    if (delta !== 0) {
      const opposite = keys
        .map((key, i) => ({ key, change: (post[i] ?? 0) - (pre[i] ?? 0) + (i === 0 ? (meta.fee ?? 0) : 0) }))
        .filter((item) => item.key !== address && (delta > 0 ? item.change < 0 : item.change > 0))
        .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
      transfers.push({
        txid: signature,
        time,
        direction: delta > 0 ? 'in' : 'out',
        counterparty: opposite?.key ?? 'nieustalony',
        asset: 'SOL',
        amount: Math.abs(delta) / LAMPORTS,
        explorerUrl: url,
      });
    }
  }

  // Tokeny SPL: sumy zmian według (właściciel, emitent).
  const changes = new Map<string, { owner: string; mint: string; units: bigint; decimals: number }>();
  const add = (balance: TokenBalance, sign: 1n | -1n) => {
    if (!balance.owner) return;
    let units: bigint;
    try {
      units = BigInt(balance.uiTokenAmount?.amount ?? '0');
    } catch {
      return;
    }
    const key = `${balance.owner}|${balance.mint}`;
    const entry = changes.get(key) ?? { owner: balance.owner, mint: balance.mint, units: 0n, decimals: balance.uiTokenAmount?.decimals ?? 0 };
    entry.units += sign * units;
    changes.set(key, entry);
  };
  for (const balance of meta.preTokenBalances ?? []) add(balance, -1n);
  for (const balance of meta.postTokenBalances ?? []) add(balance, 1n);
  let otherTokens = false;
  for (const change of changes.values()) {
    if (change.owner !== address || change.units === 0n) continue;
    const coin = SOLANA_STABLECOINS[change.mint];
    if (!coin) {
      otherTokens = true;
      continue;
    }
    const opposite = [...changes.values()]
      .filter((item) => item.mint === change.mint && item.owner !== address && (change.units > 0n ? item.units < 0n : item.units > 0n))
      .sort((a, b) => (b.units < 0n ? -b.units : b.units) > (a.units < 0n ? -a.units : a.units) ? 1 : -1)[0];
    const units = change.units < 0n ? -change.units : change.units;
    transfers.push({
      txid: signature,
      time,
      direction: change.units > 0n ? 'in' : 'out',
      counterparty: opposite?.owner ?? 'nieustalony',
      asset: coin.symbol,
      amount: Number(units) / 10 ** coin.decimals,
      explorerUrl: url,
    });
  }
  return { transfers, notes: { otherTokens } };
}

export class SolanaRpcProvider implements ChainProvider {
  id = 'solana-rpc';
  label: string;
  rpcUrl: string;
  fetchImpl: FetchLike;
  options: ActivityOptions;
  requestBudget: number;
  maxTransactions: number;
  history: HistoryOptions;
  explorerUrl: string;
  timeoutMs: number | undefined;
  private rpcId = 0;

  constructor(config: SolanaProviderConfig) {
    this.rpcUrl = config.rpcUrl;
    let host = 'węzeł operatora';
    try {
      host = new URL(config.rpcUrl).host;
    } catch {
      // Niepoprawny adres zgłosi `fetch` przy pierwszym żądaniu.
    }
    // W opisie wyłącznie host — ścieżka i parametry adresu mogą zawierać klucz dostawcy RPC.
    this.label = `Solana RPC (${host})`;
    this.fetchImpl = config.fetch ?? fetch;
    this.options = { labels: config.labels, rateSource: config.rateSource, cashOut: config.cashOut, sanctions: config.sanctions, deposit: config.deposit, trace: config.trace };
    this.requestBudget = config.requestBudget ?? DEFAULT_REQUEST_BUDGET;
    this.maxTransactions = config.maxTransactions ?? SOLANA_DEFAULT_TRANSACTIONS;
    this.history = config.history ?? {};
    this.explorerUrl = (config.explorerUrl ?? 'https://explorer.solana.com').replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs;
  }

  supports(network: Network): boolean {
    return network === 'solana';
  }

  private async rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    this.rpcId += 1;
    const reply = await fetchJson<{ result?: T; error?: { code?: number; message?: string } }>(this.fetchImpl, this.rpcUrl, {
      source: this.label,
      signal,
      ...(this.timeoutMs ? { timeoutMs: this.timeoutMs } : {}),
      body: { jsonrpc: '2.0', id: this.rpcId, method, params },
    });
    if (reply.error) {
      const code = reply.error.code === 429 || reply.error.code === -32005 ? 'rate_limited' : 'unavailable';
      throw new ChainProviderError(code, `${this.label}: ${method} — błąd węzła ${reply.error.code ?? ''} ${reply.error.message ?? ''}`.trim());
    }
    if (!('result' in reply)) throw new ChainProviderError('invalid_response', `${this.label}: ${method} — odpowiedź bez pola „result”.`);
    return reply.result as T;
  }

  async getActivity(network: Network, address: string, context: ConnectorContext): Promise<ChainActivity> {
    if (!this.supports(network)) throw new ChainProviderError('unavailable', `${this.label}: sieć ${network} nie jest obsługiwana.`);
    const budget = new RequestBudget(traceBudgetLimit(context, this.requestBudget));
    const plan = planHistory(context, this.history);
    const signal = context.signal;
    const limitations: string[] = [];

    budget.take();
    const balance = await this.rpc<{ value?: number }>('getBalance', [address, { commitment: 'finalized' }], signal);
    if (typeof balance?.value !== 'number') throw new ChainProviderError('invalid_response', `${this.label}: getBalance — brak salda w odpowiedzi.`);

    // Lista podpisów od najnowszych; w trybie `full` kolejne strony do końca historii, limitu żądań albo początku okresu.
    budget.take();
    let signatures = await this.rpc<SignatureInfo[]>('getSignaturesForAddress', [address, { limit: SOLANA_SIGNATURE_PAGE, commitment: 'finalized' }], signal);
    if (!Array.isArray(signatures)) throw new ChainProviderError('invalid_response', `${this.label}: getSignaturesForAddress — odpowiedź nie jest listą.`);
    let lastPage = signatures.length;
    let stoppedBy: string | undefined;
    while (plan.mode === 'full' && lastPage === SOLANA_SIGNATURE_PAGE) {
      const oldest = (signatures.at(-1)?.blockTime ?? 0) * 1000;
      if (plan.since !== undefined && oldest < plan.since) break;
      if (!plan.budget.take()) {
        stoppedBy = `limit ${plan.budget.limit} żądań o kolejne strony historii`;
        break;
      }
      const next = await this.rpc<SignatureInfo[]>(
        'getSignaturesForAddress',
        [address, { limit: SOLANA_SIGNATURE_PAGE, before: signatures.at(-1)!.signature, commitment: 'finalized' }],
        signal,
      );
      if (!Array.isArray(next)) break;
      lastPage = next.length;
      signatures = [...signatures, ...next];
    }
    const historyEnd = lastPage < SOLANA_SIGNATURE_PAGE;
    const failed = signatures.filter((item) => item.err != null).length;
    const ranged = plan.since !== undefined || plan.until !== undefined;
    const successful = signatures.filter((item) => item.err == null && (!ranged || inHistoryRange(plan, (item.blockTime ?? 0) * 1000)));

    // Rozpisanie najnowszych transakcji na przelewy — po jednym żądaniu na transakcję.
    const limit = Math.min(this.maxTransactions, budget.remaining);
    const transfers: RawTransfer[] = [];
    let otherTokens = 0;
    let parsed = 0;
    for (const item of successful.slice(0, limit)) {
      if (!budget.take()) break;
      let tx: ParsedTransaction | null;
      try {
        tx = await this.rpc<ParsedTransaction | null>('getTransaction', [item.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'finalized' }], signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        limitations.push(`Solana: nie udało się pobrać transakcji ${item.signature} — ${error instanceof Error ? error.message : String(error)}. Dalsze transakcje pominięto.`);
        break;
      }
      if (!tx) continue;
      parsed += 1;
      const described = solanaTransfers({ ...tx, blockTime: tx.blockTime ?? item.blockTime ?? null }, item.signature, address, this.explorerUrl);
      transfers.push(...described.transfers);
      if (described.notes.otherTokens) otherTokens += 1;
    }

    const counted = signatures.length;
    const countText = historyEnd ? `${counted}` : `co najmniej ${counted}`;
    limitations.push(
      `Solana: liczba transakcji (${countText}) pochodzi z listy podpisów adresu (getSignaturesForAddress, stan „finalized”); ` +
        `na przelewy rozpisano ${parsed} najnowszych udanych transakcji (limit ${this.maxTransactions} i budżet żądań). ` +
        'Przelew to zmiana salda adresu w transakcji: SOL (bez opłaty sieciowej) oraz USDC i USDT; kontrahent to konto o największej zmianie przeciwnego znaku — ' +
        'przy transakcjach z wieloma uczestnikami (giełdy zdecentralizowane, programy) to uproszczenie do weryfikacji w eksploratorze.',
    );
    if (successful.length > parsed) limitations.push(`Solana: ${successful.length - parsed} starszych transakcji nie rozpisano na przelewy — wypłaty z nich nie są uwzględnione.`);
    if (!historyEnd) {
      limitations.push(
        plan.mode === 'full'
          ? `Tryb pełnej historii: lista podpisów przerwana${stoppedBy ? ` — ${stoppedBy}` : ' na początku analizowanego okresu'}; starsze transakcje nie są znane.`
          : `Pobrano jedną stronę listy podpisów (${SOLANA_SIGNATURE_PAGE}); starsze transakcje nie są znane — pełną listę włącza opcja \`history: 'full'\`.`,
      );
    }
    if (ranged) limitations.push(`Analiza ograniczona do okresu ${describeRange(plan)}.`);
    if (failed > 0) limitations.push(`Solana: pominięto ${failed} transakcji zakończonych błędem (nie zmieniły sald poza opłatą).`);
    if (otherTokens > 0) limitations.push(`Solana: w ${otherTokens} transakcjach zmieniło się saldo innych tokenów SPL niż USDC/USDT — te zmiany nie są pokazane jako przelewy.`);
    limitations.push(
      'Solana: zbiór etykiet narzędzia nie zawiera adresów giełd w sieci Solana — wypłata na giełdę jest rozpoznawana wyłącznie po etykiecie dodanej przez analityka; ' +
        'saldo bieżące obejmuje tylko SOL (salda kont tokenów nie są pobierane).',
    );

    const complete = historyEnd && parsed === successful.length && !ranged;
    const sol = balance.value / LAMPORTS;
    return buildChainActivity(
      {
        network,
        address,
        sourceName: this.label,
        isContract: false,
        txCount: counted,
        balance: sol,
        historyComplete: complete,
        balanceInputs: { current: [{ asset: 'SOL', amount: sol }], flows: [], complete: [], networkName: 'Solana' },
        transfers: transfers.sort((a, b) => Date.parse(a.time) - Date.parse(b.time)),
        limitations,
      },
      this.options,
    );
  }
}
