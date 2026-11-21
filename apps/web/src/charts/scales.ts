// Skale i podziałki wykresów — czyste funkcje bez DOM.

/** Najbliższa „okrągła” wartość nie mniejsza od podanej (1, 2, 2,5, 5 × 10ⁿ). */
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value) ?? 10;
  return step * magnitude;
}

/** Równe podziałki od zera do `max` włącznie. */
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, index) => (max * index) / count);
}

export function linearScale(domain: [number, number], range: [number, number]): (value: number) => number {
  const span = domain[1] - domain[0];
  return (value) => (span === 0 ? range[0] : range[0] + ((value - domain[0]) / span) * (range[1] - range[0]));
}

/** Podział odcinka na `count` pasm z odstępem będącym ułamkiem szerokości kroku. */
export function bandScale(count: number, range: [number, number], padding = 0.25) {
  const step = count > 0 ? (range[1] - range[0]) / count : 0;
  const width = step * (1 - padding);
  return { width, start: (index: number) => range[0] + index * step + (step - width) / 2 };
}

/** Słupki skumulowane: `series[s][c]` → dla każdej serii odcinki `[od, do]` kolejnych kategorii. */
export function stackSeries(series: number[][]): [number, number][][] {
  const categories = Math.max(0, ...series.map((values) => values.length));
  const totals = new Array<number>(categories).fill(0);
  return series.map((values) =>
    Array.from({ length: categories }, (_, index): [number, number] => {
      const from = totals[index]!;
      totals[index] = from + (values[index] ?? 0);
      return [from, totals[index]!];
    }),
  );
}

/** Skala czasu dla dat ISO; przy jednym punkcie w czasie zwraca środek zakresu. */
export function timeScale(times: string[], range: [number, number]): (iso: string) => number {
  const stamps = times.map((iso) => Date.parse(iso)).filter((stamp) => !Number.isNaN(stamp));
  const min = Math.min(...stamps);
  const max = Math.max(...stamps);
  if (stamps.length === 0 || min === max) return () => (range[0] + range[1]) / 2;
  const scale = linearScale([min, max], range);
  return (iso) => scale(Date.parse(iso));
}
