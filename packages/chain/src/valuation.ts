// Szacunkowa wycena wypłat w PLN. Wynik jest zawsze SZACUNKIEM pomocniczym dla
// analityka: nie jest ustaleniem przychodu ani podstawy opodatkowania.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CashOutIndicator } from '@olcys/core';
import { createLimiter, fetchJson } from './http.ts';
import type { FetchLike } from './http.ts';

export interface RateQuote {
  /** Kurs: ile PLN za jednostkę waluty. */
  rate: number;
  /** Opis źródła kursu, pokazywany analitykowi. */
  source: string;
  /** Składniki kursu rynkowego: cena w USD i kurs USD/PLN, każdy z własnym źródłem i datą. */
  usd?: { price: number; priceSource: string; pln: number; plnSource: string };
  /** `true`, gdy kurs pochodzi z tabeli przykładowej, a nie z rynku ani z NBP. */
  sample?: boolean;
  /** Dopisek do opisu wyceny, np. powód użycia kursu przykładowego. */
  note?: string;
}

export interface RateSource {
  getRatePln(asset: string, date: string): Promise<RateQuote | null>;
  /** Powód ostatniego nieudanego pobrania kursu, jeśli źródło go zna. */
  lastFailure?: string;
}

const warsawDateFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' });

/** Data kalendarzowa w Polsce (`RRRR-MM-DD`) — o roku podatkowym decyduje czas polski, nie UTC. */
export function polishDate(time: string): string {
  return warsawDateFormat.format(new Date(time));
}

export interface RateTable {
  source: string;
  /** Waluta → miesiąc `RRRR-MM` → kurs w PLN. */
  rates: Record<string, Record<string, number>>;
}

function loadBuiltInTable(): RateTable {
  return JSON.parse(readFileSync(new URL('../data/rates-pln.json', import.meta.url), 'utf8')) as RateTable;
}

/**
 * Kursy z wbudowanej tabeli przybliżonych średnich miesięcznych.
 * DANE PRZYKŁADOWE DO DEMONSTRACJI — nie są to kursy urzędowe.
 */
export class StaticRateSource implements RateSource {
  table: RateTable;
  /** Czy kursy są przykładowe; wbudowana tabela zawsze jest. */
  sample: boolean;

  constructor(table?: RateTable, sample: boolean = table === undefined) {
    this.table = table ?? loadBuiltInTable();
    this.sample = sample;
  }

  async getRatePln(asset: string, date: string): Promise<RateQuote | null> {
    const month = polishDate(date).slice(0, 7);
    const rate = this.table.rates[asset.toUpperCase()]?.[month];
    if (rate === undefined) return null;
    return { rate, source: `${this.table.source}, miesiąc ${month}`, ...(this.sample ? { sample: true } : {}) };
  }
}

const NBP_USD_STABLECOINS = new Set(['USDT', 'USDC']);
/** Tokeny liczone jako 1 USD w wycenie rynkowej. */
export const USD_STABLECOINS = new Set(['USDT', 'USDC', 'DAI']);
const NBP_LOOKBACK_DAYS = 5;

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Starsze, uproszczone źródło: kurs średni USD z NBP z DNIA TRANSAKCJI (przy braku
 * tabeli cofa się do pięciu dni), tylko dla stablecoinów. Zostaje dla zgodności;
 * domyślnie używane jest `MarketRateSource`, które stosuje regułę dnia roboczego
 * poprzedzającego transakcję. Do NBP trafia wyłącznie data.
 */
export class NbpRateSource implements RateSource {
  fetchImpl: FetchLike;
  cache = new Map<string, Promise<RateQuote | null>>();

  constructor(fetchImpl: FetchLike = fetch) {
    this.fetchImpl = fetchImpl;
  }

  getRatePln(asset: string, date: string): Promise<RateQuote | null> {
    const symbol = asset.toUpperCase();
    if (!NBP_USD_STABLECOINS.has(symbol)) return Promise.resolve(null);
    const day = polishDate(date);
    let usd = this.cache.get(day);
    if (!usd) {
      usd = this.fetchUsd(day);
      this.cache.set(day, usd);
    }
    return usd.then((quote) => quote && { rate: quote.rate, source: `${quote.source}; przyjęto 1 ${symbol} = 1 USD` });
  }

  private async fetchUsd(day: string): Promise<RateQuote | null> {
    for (let back = 0; back <= NBP_LOOKBACK_DAYS; back++) {
      const tableDay = shiftDate(day, -back);
      try {
        const body = await fetchJson<{ rates?: { no?: string; mid?: number }[] }>(
          this.fetchImpl,
          `https://api.nbp.pl/api/exchangerates/rates/a/usd/${tableDay}/?format=json`,
          { source: 'NBP' },
        );
        const entry = body.rates?.[0];
        if (typeof entry?.mid !== 'number') return null;
        return { rate: entry.mid, source: `kurs średni USD NBP z ${tableDay} (tabela ${entry.no ?? 'A'})` };
      } catch (error) {
        // 404 = brak tabeli tego dnia (weekend, święto); inne błędy kończą próby.
        if ((error as { code?: string }).code !== 'not_found') return null;
      }
    }
    return null;
  }
}

/** Pary notowań Binance używane do wyceny; pozostałe waluty nie są wyceniane kursem rynkowym. */
export const BINANCE_PAIRS: Record<string, string> = {
  BTC: 'BTCUSDT',
  ETH: 'ETHUSDT',
  WETH: 'ETHUSDT',
  TRX: 'TRXUSDT',
  // Waluty natywne innych sieci EVM — pary potwierdzone w API Binance (xDAI nie ma pary, więc nie jest wyceniany).
  POL: 'POLUSDT',
  BNB: 'BNBUSDT',
  CELO: 'CELOUSDT',
};
/** Ile dni wstecz od dnia poprzedzającego transakcję szukamy tabeli NBP. */
export const NBP_PRECEDING_LOOKBACK_DAYS = 7;
export const SAMPLE_RATE_WARNING = 'UWAGA: KURS PRZYKŁADOWY';
const FAILURE_RETRY_MS = 60_000;

export interface NbpTableRate {
  mid: number;
  /** Numer tabeli A, np. `051/A/NBP/2025`. */
  no: string;
  /** Dzień, z którego pochodzi tabela. */
  effectiveDate: string;
}

interface RateCacheFile {
  binance: Record<string, number>;
  nbp: Record<string, NbpTableRate>;
}

export interface MarketRateOptions {
  fetch?: FetchLike;
  /** Źródło zapasowe przy błędzie sieci; jego kurs jest wyraźnie oznaczany w opisie wyceny. */
  fallback?: RateSource;
  /** Plik pamięci podręcznej (JSON); bez niego kursy są pamiętane tylko w procesie. */
  cacheFile?: string;
  /** Maksymalna liczba równoczesnych żądań do API kursów. */
  concurrency?: number;
  binanceUrl?: string;
  nbpUrl?: string;
  now?: () => Date;
}

/**
 * Kurs rynkowy: cena zamknięcia dnia (UTC) w USDT z publicznego API Binance
 * × kurs średni USD/PLN z tabeli A NBP z OSTATNIEGO DNIA ROBOCZEGO
 * POPRZEDZAJĄCEGO dzień transakcji (reguła przeliczania walut obcych w podatku
 * dochodowym). USDT, USDC i DAI są liczone jako 1 USD. Do API trafia wyłącznie
 * para walutowa i data. Wynik nadal jest szacunkiem, nie ustaleniem przychodu.
 */
export class MarketRateSource implements RateSource {
  fetchImpl: FetchLike;
  fallback: RateSource | undefined;
  cacheFile: string | undefined;
  binanceUrl: string;
  nbpUrl: string;
  now: () => Date;
  private limit: <T>(task: () => Promise<T>) => Promise<T>;
  private pending = new Map<string, { promise: Promise<unknown>; failedAt?: number }>();
  private stored: RateCacheFile | undefined;
  /** Powód ostatniego nieudanego pobrania kursu — do opisu, dlaczego wskaźnik nie ma wyceny. */
  lastFailure: string | undefined;

  constructor(options: MarketRateOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.fallback = options.fallback;
    this.cacheFile = options.cacheFile;
    this.binanceUrl = (options.binanceUrl ?? 'https://api.binance.com').replace(/\/+$/, '');
    this.nbpUrl = (options.nbpUrl ?? 'https://api.nbp.pl').replace(/\/+$/, '');
    this.now = options.now ?? (() => new Date());
    this.limit = createLimiter(options.concurrency ?? 3);
  }

  async getRatePln(asset: string, date: string): Promise<RateQuote | null> {
    const symbol = asset.toUpperCase();
    const stable = USD_STABLECOINS.has(symbol);
    const pair = BINANCE_PAIRS[symbol];
    if (!stable && !pair) return null;
    if (Number.isNaN(Date.parse(date))) return null;

    try {
      const utcDay = new Date(date).toISOString().slice(0, 10);
      const [price, table] = await Promise.all([
        stable ? Promise.resolve(1) : this.closePriceUsd(pair!, utcDay),
        this.usdPlnBefore(polishDate(date)),
      ]);
      const unfinished = !stable && utcDay >= this.now().toISOString().slice(0, 10);
      const priceSource = stable
        ? `założenie: 1 ${symbol} = 1 USD`
        : `Binance ${pair}, cena zamknięcia dnia ${utcDay} UTC${unfinished ? ' — dzień niezakończony, cena bieżąca' : ''}`;
      const plnSource =
        `NBP, kurs średni, tabela A nr ${table.no} z ${table.effectiveDate} — ` +
        'ostatni dzień roboczy poprzedzający dzień transakcji';
      return {
        rate: price * table.mid,
        source: `${priceSource}; ${plnSource}`,
        usd: { price, priceSource, pln: table.mid, plnSource },
      };
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
      this.lastFailure = reason;
      const quote = await this.fallback?.getRatePln(asset, date);
      if (!quote) return null;
      return {
        ...quote,
        sample: quote.sample ?? true,
        note: `Nie udało się pobrać kursu rynkowego (${reason}), dlatego użyto kursu zastępczego.`,
      };
    }
  }

  /** Cena zamknięcia dziennej świecy Binance rozpoczynającej się o 00:00 UTC podanego dnia. */
  closePriceUsd(pair: string, utcDay: string): Promise<number> {
    return this.cached('binance', `${pair}:${utcDay}`, async () => {
      const start = Date.parse(`${utcDay}T00:00:00Z`);
      const rows = await this.request<unknown[][]>(
        `${this.binanceUrl}/api/v3/klines?symbol=${pair}&interval=1d&startTime=${start}&limit=1`,
        'Binance',
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      const close = Array.isArray(row) ? Number(row[4]) : Number.NaN;
      if (!Array.isArray(row) || row[0] !== start || !Number.isFinite(close) || close <= 0) {
        throw new Error(`Binance: brak notowania ${pair} z dnia ${utcDay}`);
      }
      // Niezakończonej świecy nie utrwalamy — jej cena jeszcze się zmieni.
      return { value: close, persist: utcDay < this.now().toISOString().slice(0, 10) };
    });
  }

  /**
   * Kurs średni USD z ostatniego dnia roboczego PRZED podanym dniem (czasu polskiego):
   * jedno zapytanie o zakres od 7 dni wstecz do dnia poprzedniego, bierzemy najnowszą tabelę.
   */
  usdPlnBefore(polishDay: string): Promise<NbpTableRate> {
    return this.cached('nbp', polishDay, async () => {
      const missing = `NBP: brak tabeli kursów w ${NBP_PRECEDING_LOOKBACK_DAYS} dniach przed ${polishDay}`;
      const from = shiftDate(polishDay, -NBP_PRECEDING_LOOKBACK_DAYS);
      const to = shiftDate(polishDay, -1);
      let body: { rates?: { no?: string; effectiveDate?: string; mid?: number }[] };
      try {
        body = await this.request(`${this.nbpUrl}/api/exchangerates/rates/a/usd/${from}/${to}/?format=json`, 'NBP', 3);
      } catch (error) {
        if ((error as { code?: string }).code === 'not_found') throw new Error(missing);
        // Zapytanie o zakres zawiodło mimo ponowień — cofamy się dzień po dniu pojedynczymi zapytaniami.
        const single = await this.usdPlnDayByDay(polishDay);
        if (single) return { value: single, persist: true };
        throw error;
      }
      const entry = (body.rates ?? [])
        .filter((item) => typeof item.mid === 'number' && typeof item.effectiveDate === 'string' && item.effectiveDate < polishDay)
        .sort((a, b) => a.effectiveDate!.localeCompare(b.effectiveDate!))
        .at(-1);
      if (!entry) throw new Error(missing);
      return { value: { mid: entry.mid!, no: entry.no ?? 'A', effectiveDate: entry.effectiveDate! }, persist: true };
    });
  }

  /** Zapasowa droga: tabela z dnia poprzedniego, a przy jej braku (404) z kolejnych wcześniejszych dni. */
  private async usdPlnDayByDay(polishDay: string): Promise<NbpTableRate | undefined> {
    for (let back = 1; back <= NBP_PRECEDING_LOOKBACK_DAYS; back++) {
      const day = shiftDate(polishDay, -back);
      try {
        const body = await this.request<{ rates?: { no?: string; effectiveDate?: string; mid?: number }[] }>(
          `${this.nbpUrl}/api/exchangerates/rates/a/usd/${day}/?format=json`,
          'NBP',
          1,
        );
        const entry = body.rates?.[0];
        if (typeof entry?.mid === 'number') return { mid: entry.mid, no: entry.no ?? 'A', effectiveDate: entry.effectiveDate ?? day };
      } catch (error) {
        // 404 = brak tabeli tego dnia (weekend, święto); inny błąd kończy próby.
        if ((error as { code?: string }).code !== 'not_found') return undefined;
      }
    }
    return undefined;
  }

  /**
   * Żądanie z ograniczeniem równoległości; po przekroczeniu limitu czasu jedna ponowna próba.
   * `retryUnavailable` to liczba dodatkowych prób po błędzie 5xx — API NBP sporadycznie
   * odpowiada HTTP 500 na poprawne zapytanie, a ponowienie po chwili zwykle się udaje.
   */
  private request<T>(url: string, source: string, retryUnavailable = 0): Promise<T> {
    return this.limit(async () => {
      let timeouts = 1;
      let unavailable = retryUnavailable;
      for (;;) {
        try {
          return await fetchJson<T>(this.fetchImpl, url, { source });
        } catch (error) {
          const code = (error as { code?: string }).code;
          const status = /HTTP 5\d\d/.test(error instanceof Error ? error.message : '');
          if (code === 'timeout' && timeouts > 0) timeouts -= 1;
          else if (code === 'unavailable' && status && unavailable > 0) {
            unavailable -= 1;
            // Coraz dłuższa przerwa: 0,5 s, 1 s, 1,5 s…
            await new Promise((resolve) => setTimeout(resolve, 500 * (retryUnavailable - unavailable)));
          } else throw error;
        }
      }
    });
  }

  private cached<T>(
    section: keyof RateCacheFile,
    key: string,
    load: () => Promise<{ value: T; persist: boolean }>,
  ): Promise<T> {
    const stored = this.readStored()[section] as Record<string, T>;
    if (stored[key] !== undefined) return Promise.resolve(stored[key]);
    const id = `${section}:${key}`;
    const known = this.pending.get(id);
    // Nieudane pobranie ponawiamy dopiero po chwili, żeby jedna analiza nie zasypała API.
    if (known && (known.failedAt === undefined || Date.now() - known.failedAt < FAILURE_RETRY_MS)) {
      return known.promise as Promise<T>;
    }
    const entry: { promise: Promise<unknown>; failedAt?: number } = { promise: Promise.resolve() };
    entry.promise = load().then(
      ({ value, persist }) => {
        if (persist) {
          stored[key] = value;
          this.writeStored();
        }
        return value;
      },
      (error) => {
        entry.failedAt = Date.now();
        throw error;
      },
    );
    this.pending.set(id, entry);
    return entry.promise as Promise<T>;
  }

  private readStored(): RateCacheFile {
    if (this.stored) return this.stored;
    this.stored = { binance: {}, nbp: {} };
    if (this.cacheFile && existsSync(this.cacheFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.cacheFile, 'utf8')) as Partial<RateCacheFile>;
        this.stored = { binance: parsed.binance ?? {}, nbp: parsed.nbp ?? {} };
      } catch {
        // Uszkodzony plik pamięci podręcznej pomijamy — kursy zostaną pobrane ponownie.
      }
    }
    return this.stored;
  }

  private writeStored(): void {
    if (!this.cacheFile || !this.stored) return;
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true });
      writeFileSync(this.cacheFile, `${JSON.stringify(this.stored, null, 1)}\n`);
    } catch {
      // Brak możliwości zapisu nie przerywa wyceny.
    }
  }
}

/** Pyta kolejne źródła i zwraca pierwszy dostępny kurs. */
export class FallbackRateSource implements RateSource {
  sources: RateSource[];

  constructor(sources: RateSource[]) {
    this.sources = sources;
  }

  async getRatePln(asset: string, date: string): Promise<RateQuote | null> {
    for (const source of this.sources) {
      const quote = await source.getRatePln(asset, date);
      if (quote) return quote;
    }
    return null;
  }
}

const formatNumber = (value: number, digits: number) =>
  value.toLocaleString('pl-PL', { maximumFractionDigits: digits });

/** Opis wyceny jednej kwoty: działanie, źródła kursów i daty; kurs przykładowy jest wyraźnie oznaczony. */
export function describeValuation(amount: number, asset: string, time: string, quote: RateQuote, valuePln: number): string {
  const amountText = `${formatNumber(amount, 8)} ${asset}`;
  const result = `${valuePln.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} PLN`;
  const day = polishDate(time);
  if (quote.usd && !quote.sample) {
    return (
      `Szacunek: ${amountText} × ${formatNumber(quote.usd.price, 4)} USD (${quote.usd.priceSource}) ` +
      `× ${formatNumber(quote.usd.pln, 4)} PLN/USD (${quote.usd.plnSource}) = ${result}. Data transakcji: ${day}.`
    );
  }
  const sample = quote.sample
    ? ` ${SAMPLE_RATE_WARNING} (dane demonstracyjne — nie jest to kurs rynkowy ani urzędowy).${quote.note ? ` ${quote.note}` : ''}`
    : '';
  return (
    `Szacunek: ${amountText} × ${formatNumber(quote.rate, 4)} PLN = ${result}. ` +
    `Kurs: ${quote.source}. Data transakcji: ${day}.${sample}`
  );
}

/** Szacunkowa wartość kwoty w PLN wraz z opisem; `null`, gdy nie ma kursu. */
export async function valueAmount(
  rateSource: RateSource,
  asset: string,
  amount: number,
  time: string,
): Promise<{ valuePln: number; valuation: string; sample: boolean } | null> {
  const quote = await rateSource.getRatePln(asset, time);
  if (!quote) return null;
  const valuePln = Math.round(amount * quote.rate * 100) / 100;
  return { valuePln, valuation: describeValuation(amount, asset, time, quote, valuePln), sample: quote.sample === true };
}

/** Uzupełnia wskaźniki o szacunkową wartość w PLN; bez kursu zostawia je bez wyceny. */
export async function valueCashOuts(cashOuts: CashOutIndicator[], rateSource: RateSource): Promise<CashOutIndicator[]> {
  return Promise.all(
    cashOuts.map(async (cashOut) => {
      const valued = await valueAmount(rateSource, cashOut.asset, cashOut.amount, cashOut.time);
      if (!valued) return cashOut;
      return { ...cashOut, valuePln: valued.valuePln, valuation: valued.valuation };
    }),
  );
}

/** Czy wskaźnik wyceniono kursem przykładowym (a nie rynkowym). */
export function usesSampleRate(cashOut: CashOutIndicator): boolean {
  return cashOut.valuation?.includes(SAMPLE_RATE_WARNING) === true;
}

/** Suma szacunkowych wypłat w PLN w podziale na lata podatkowe (rok kalendarzowy w Polsce). */
export function summarizeByTaxYear(cashOuts: CashOutIndicator[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const cashOut of cashOuts) {
    if (cashOut.valuePln === undefined) continue;
    const year = polishDate(cashOut.time).slice(0, 4);
    totals[year] = Math.round(((totals[year] ?? 0) + cashOut.valuePln) * 100) / 100;
  }
  return totals;
}
