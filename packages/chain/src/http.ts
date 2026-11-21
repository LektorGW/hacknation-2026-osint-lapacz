// Pobieranie JSON z publicznego API z limitem czasu i czytelnymi błędami.
// W adresie żądania jest wyłącznie badany adres — żadne inne dane analizy.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ProviderErrorCode = 'not_found' | 'rate_limited' | 'unavailable' | 'timeout' | 'invalid_response';

export class ChainProviderError extends Error {
  code: ProviderErrorCode;

  constructor(code: ProviderErrorCode, message: string) {
    super(message);
    this.name = 'ChainProviderError';
    this.code = code;
  }
}

export const REQUEST_TIMEOUT_MS = 10_000;
/** Nagłówek przedstawiający narzędzie publicznym API; nie zawiera danych analizy. */
export const USER_AGENT = 'OLCyS-research/0.1';

/**
 * Licznik żądań do publicznych API w ramach analizy jednego adresu. Po wyczerpaniu
 * dodatkowe kroki (etykiety kontrahentów, adresy pośrednie) są przerywane.
 */
export class RequestBudget {
  limit: number;
  used = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  /** Rezerwuje jedno żądanie; `false`, gdy budżet jest wyczerpany. */
  take(): boolean {
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

/** Ogranicza liczbę równoczesnych zadań (np. żądań do jednego API). */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= concurrency) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

export interface FetchJsonOptions {
  /** Nazwa źródła do komunikatów błędów. */
  source: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function fetchJson<T>(fetchImpl: FetchLike, url: string, options: FetchJsonOptions): Promise<T> {
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new ChainProviderError('timeout', `${options.source}: brak odpowiedzi w ciągu ${timeoutMs / 1000} s.`);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ChainProviderError('unavailable', `${options.source}: nie udało się połączyć (${reason}).`);
  }

  if (response.status === 404) {
    throw new ChainProviderError('not_found', `${options.source}: nieznany adres (HTTP 404).`);
  }
  if (response.status === 429) {
    throw new ChainProviderError(
      'rate_limited',
      `${options.source}: przekroczono limit zapytań publicznego API (HTTP 429). Spróbuj ponownie później.`,
    );
  }
  if (response.status >= 500) {
    throw new ChainProviderError('unavailable', `${options.source}: usługa chwilowo niedostępna (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    throw new ChainProviderError('unavailable', `${options.source}: żądanie odrzucone (HTTP ${response.status}).`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ChainProviderError('invalid_response', `${options.source}: odpowiedź nie jest poprawnym JSON-em.`);
  }
}

/** Przelicza kwotę w najmniejszych jednostkach (satoshi, wei, sun) bez utraty części całkowitej. */
export function fromBaseUnits(value: string | number, decimals: number): number {
  let units: bigint;
  try {
    units = BigInt(value);
  } catch {
    return 0;
  }
  const scale = 10n ** BigInt(decimals);
  return Number(units / scale) + Number(units % scale) / Number(scale);
}
