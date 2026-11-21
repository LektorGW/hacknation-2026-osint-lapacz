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
    // Pola dodatkowe pozwalają ogranicznikowi tempa liczyć limit czasu od faktycznego startu żądania, a nie od wejścia do kolejki.
    const init = { signal, headers: { accept: 'application/json', 'user-agent': USER_AGENT }, callerSignal: options.signal, timeoutMs } as QueuedRequestInit;
    response = await fetchImpl(url, init);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timeout.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
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
  if (response.status === 401) {
    throw new ChainProviderError('unavailable', `${options.source}: klucz API został odrzucony (HTTP 401) — sprawdź konfigurację klucza.`);
  }
  if (response.status === 402) {
    throw new ChainProviderError('unavailable', `${options.source}: ta sieć lub wywołanie wymaga wyższego planu API albo wyczerpano dzienny limit kredytów (HTTP 402).`);
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

/** `RequestInit` z polami, które `fetchJson` przekazuje ogranicznikowi tempa. */
export interface QueuedRequestInit extends RequestInit {
  /** Sygnał przerwania od wywołującego (bez limitu czasu). */
  callerSignal?: AbortSignal;
  /** Limit czasu jednego żądania, liczony od jego startu. */
  timeoutMs?: number;
}

export interface HostPolicy {
  /** Najwyżej tyle żądań do hosta naraz (domyślnie bez ograniczenia). */
  maxConcurrent?: number;
  /** Minimalny odstęp między żądaniami do hosta. */
  minIntervalMs: number;
  /** Po odpowiedzi 429 czekamy tyle i ponawiamy żądanie jeden raz. */
  retryAfterMs: number;
}

/**
 * Tempo przyjazne dla publicznych API bez klucza (ustalone próbami na żywo): TronScan
 * i TronGrid odrzucają serie żądań kodem 429, a TronGrid po przekroczeniu limitu blokuje
 * nadawcę na kilka–kilkadziesiąt sekund.
 */
export const DEFAULT_HOST_POLICIES: Record<string, HostPolicy> = {
  'apilist.tronscanapi.com': { minIntervalMs: 450, retryAfterMs: 3000 },
  'api.trongrid.io': { minIntervalMs: 350, retryAfterMs: 5000 },
  // Stronicowanie pełnej historii to dziesiątki żądań z rzędu — trzymamy umiarkowane tempo.
  'blockstream.info': { minIntervalMs: 150, retryAfterMs: 4000 },
  'mempool.space': { minIntervalMs: 250, retryAfterMs: 4000 },
  'eth.blockscout.com': { minIntervalMs: 120, retryAfterMs: 4000 },
  // API Blockscout z kluczem: plan darmowy pozwala na 5 żądań na sekundę.
  // Pomiar na żywo: przy kilkunastu równoczesnych żądaniach brama zrywa połączenia po ~10 s, przy 2–3 odpowiada poprawnie.
  'api.blockscout.com': { minIntervalMs: 220, retryAfterMs: 2000, maxConcurrent: 2 },
};

/**
 * Opakowuje `fetch`: żądania do hostów z tabeli idą jedno po drugim z minimalnym odstępem,
 * a odpowiedź 429 powoduje jedną ponowną próbę po przerwie. Pozostałe hosty bez zmian.
 */
export function createPoliteFetch(fetchImpl: FetchLike, policies: Record<string, HostPolicy> = DEFAULT_HOST_POLICIES): FetchLike {
  const queues = new Map<string, { tail: Promise<unknown>; lastStart: number; active: number; waiting: (() => void)[] }>();
  const pause = (ms: number, signal?: AbortSignal | null) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(signal.reason);
      }, { once: true });
    });
  return (input, init) => {
    let host: string;
    try {
      host = new URL(input).host;
    } catch {
      return fetchImpl(input, init);
    }
    const policy = policies[host];
    if (!policy) return fetchImpl(input, init);
    const queue = queues.get(host) ?? { tail: Promise.resolve(), lastStart: 0, active: 0, waiting: [] };
    queues.set(host, queue);
    // W kolejce stoi tylko START żądania (odstęp między startami). Na odpowiedź nie czekamy —
    // jedno wolne żądanie nie może wstrzymać pozostałych aż do przekroczenia ich limitu czasu.
    const slot = queue.tail.then(async () => {
      if (policy.maxConcurrent !== undefined && queue.active >= policy.maxConcurrent) await new Promise<void>((resolve) => queue.waiting.push(resolve));
      queue.active += 1;
      const wait = queue.lastStart + policy.minIntervalMs - Date.now();
      if (wait > 0) await pause(wait);
      queue.lastStart = Date.now();
    });
    queue.tail = slot.catch(() => undefined);
    const queued = init as QueuedRequestInit | undefined;
    // Limit czasu liczymy od startu żądania; czas w kolejce go nie zużywa.
    const startSignal = () => {
      if (queued?.timeoutMs === undefined) return init?.signal ?? undefined;
      const timer = AbortSignal.timeout(queued.timeoutMs);
      return queued.callerSignal ? AbortSignal.any([queued.callerSignal, timer]) : timer;
    };
    return slot.then(async () => {
      try {
        const response = await fetchImpl(input, { ...init, signal: startSignal() });
        if (response.status !== 429) return response;
        await pause(policy.retryAfterMs);
        queue.lastStart = Date.now();
        return await fetchImpl(input, { ...init, signal: queued?.timeoutMs === undefined ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : startSignal() });
      } finally {
        queue.active -= 1;
        queue.waiting.shift()?.();
      }
    });
  };
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
