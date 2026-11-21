// Stan posiadania — WYNIK OBLICZEŃ, nie odczyt z rejestru: saldo bieżące podaje
// źródło danych, a saldo na koniec roku podatkowego (31 grudnia) wyliczamy wstecz
// od salda bieżącego, odejmując przelewy późniejsze. Wynik podajemy tylko wtedy,
// gdy pobrana historia danego aktywa jest pełna I zgadza się z saldem bieżącym.

import type { Network } from '@olcys/core';
import { polishDate, valueAmount } from './valuation.ts';
import type { RateSource } from './valuation.ts';

export interface BalanceEntry {
  asset: string;
  amount: number;
  network: Network;
  /** Identyfikator sieci EVM z rejestru (`data/evm-networks.json`), gdy inna niż Ethereum mainnet. */
  chain?: string;
  /** `current` — saldo bieżące ze źródła danych; `year_end` — saldo na 31 grudnia wyliczone z historii. */
  kind: 'current' | 'year_end';
  /** Chwila, której dotyczy saldo: czas pobrania (ISO 8601) albo `RRRR-12-31`. */
  asOf: string;
  valuePln?: number;
  valuation?: string;
  /** Skąd pochodzi liczba. */
  basis: string;
}

/** Zmiana salda: dodatnia = wpływ, ujemna = wypływ (w jednostkach aktywa). */
export interface BalanceFlow {
  asset: string;
  time: string;
  delta: number;
}

export interface BalanceInputs {
  /** Salda bieżące podane przez źródło danych. */
  current: { asset: string; amount: number }[];
  /** Wszystkie zmiany sald z pobranej historii. */
  flows: BalanceFlow[];
  /** Aktywa, dla których pobrano CAŁĄ historię. */
  complete: string[];
  chain?: string;
  /** Nazwa sieci do opisów. */
  networkName?: string;
}

/** Dopuszczalna rozbieżność między sumą historii a saldem bieżącym. */
export const BALANCE_TOLERANCE = 0.005;
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;

export async function computeBalances(
  network: Network,
  inputs: BalanceInputs,
  rateSource: RateSource,
  now: Date = new Date(),
): Promise<{ balances: BalanceEntry[]; limitations: string[] }> {
  const balances: BalanceEntry[] = [];
  const limitations: string[] = [];
  const where = inputs.networkName ? ` (${inputs.networkName})` : '';
  const chain = inputs.chain ? { chain: inputs.chain } : {};
  const valued = async (entry: BalanceEntry, time: string): Promise<BalanceEntry> => {
    if (entry.amount <= 0) return entry;
    const value = await valueAmount(rateSource, entry.asset, entry.amount, time);
    return value ? { ...entry, valuePln: value.valuePln, valuation: value.valuation } : entry;
  };

  const thisYear = Number(polishDate(now.toISOString()).slice(0, 4));
  for (const current of inputs.current) {
    balances.push(
      await valued(
        { asset: current.asset, amount: round8(current.amount), network, ...chain, kind: 'current', asOf: now.toISOString(), basis: `saldo bieżące podane przez źródło danych${where}` },
        now.toISOString(),
      ),
    );
    const flows = inputs.flows.filter((flow) => flow.asset === current.asset);
    if (flows.length === 0) continue;
    if (!inputs.complete.includes(current.asset)) {
      limitations.push(
        `Stan posiadania${where}: nie wyliczono sald ${current.asset} na koniec lat — pobrana historia tego aktywa nie jest pełna ` +
          '(pełną historię włącza opcja `history: \'full\'`).',
      );
      continue;
    }
    // Kontrola: suma całej historii musi dać saldo bieżące, inaczej czegoś w historii brakuje (opłaty, transakcje wewnętrzne).
    const total = flows.reduce((sum, flow) => sum + flow.delta, 0);
    const gap = Math.abs(total - current.amount);
    if (gap > Math.max(1e-6, Math.abs(current.amount) * BALANCE_TOLERANCE, Math.abs(total) * BALANCE_TOLERANCE)) {
      limitations.push(
        `Stan posiadania${where}: nie wyliczono sald ${current.asset} na koniec lat — suma pobranych przelewów (${round8(total)}) nie zgadza się ` +
          `z saldem bieżącym (${round8(current.amount)}); w historii brakuje składników, których źródło nie podaje w przelewach ` +
          '(opłaty transakcyjne, transakcje wewnętrzne kontraktów).',
      );
      continue;
    }
    const years = [...new Set(flows.map((flow) => Number(polishDate(flow.time).slice(0, 4))))].filter((year) => year < thisYear).sort();
    for (const year of years) {
      // Wstecz od salda bieżącego: odejmujemy wszystko, co wydarzyło się po 31 grudnia danego roku (czasu polskiego).
      const later = flows.filter((flow) => Number(polishDate(flow.time).slice(0, 4)) > year).reduce((sum, flow) => sum + flow.delta, 0);
      const amount = round8(Math.max(0, current.amount - later));
      balances.push(
        await valued(
          {
            asset: current.asset,
            amount,
            network,
            ...chain,
            kind: 'year_end',
            asOf: `${year}-12-31`,
            basis: `wynik obliczeń${where}: saldo bieżące pomniejszone o przelewy po 31 grudnia ${year} r. (pełna historia, zgodna z saldem bieżącym)`,
          },
          `${year}-12-31T22:00:00Z`,
        ),
      );
    }
  }
  if (balances.length > 0) {
    limitations.push(
      `Stan posiadania${where} to wynik obliczeń: salda bieżące pochodzą ze źródła danych, a salda na 31 grudnia są wyliczone wstecz z pobranej historii ` +
        'przelewów. Wartości w PLN są szacunkiem (kurs z opisu wyceny) i nie stanowią ustalenia majątku.',
    );
  }
  return { balances, limitations };
}
