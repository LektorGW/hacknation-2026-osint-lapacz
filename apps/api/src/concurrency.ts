// Ograniczanie współbieżności: źródła publiczne odpytujemy równolegle, ale nie
// więcej niż kilka zapytań naraz — szybciej dla analityka, bez zalewania serwisów.

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/** Zwraca funkcję uruchamiającą zadania tak, by jednocześnie działało najwyżej `limit`. */
export function createLimiter(limit: number): Limiter {
  const slots = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (task) => {
    if (active < slots) active++;
    // Zwalniający przekazuje swoje miejsce czekającemu, więc licznik się nie zmienia.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** `Promise.all` z limitem współbieżności; kolejność wyników jak kolejność wejścia. */
export function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const limiter = createLimiter(limit);
  return Promise.all(items.map((item, index) => limiter(() => run(item, index))));
}
