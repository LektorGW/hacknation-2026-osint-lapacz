// Wskaźniki możliwego wyjścia do walut tradycyjnych (wypłaty).
// Wskaźnik to poszlaka dla analityka, nie dowód: mówi, że środki trafiły do
// miejsca, w którym zwykle zamienia się kryptowaluty na pieniądze.

import type { CashOutIndicator, CashOutKind, Transfer } from '@olcys/core';

/** Przelew z rozpoznanym rodzajem usługi po stronie kontrahenta. */
export interface ClassifiedTransfer extends Transfer {
  counterpartyKind?: CashOutKind;
}

export interface CashOutOptions {
  /**
   * Próg „znacznej wartości” dla zamiany na stablecoiny, w jednostkach waluty
   * (np. `{ BTC: 0.05 }`). Waluty spoza tabeli nie są oceniane.
   */
  significantAmounts?: Record<string, number>;
  /** Ile minut po wyjściu środków szukamy przyjścia stablecoinów. */
  swapWindowMinutes?: number;
  stablecoins?: string[];
}

/** Progi odpowiadają z grubsza 10 tys. zł — poniżej zamiana nie jest zgłaszana. */
export const DEFAULT_CASHOUT_OPTIONS: Required<CashOutOptions> = {
  significantAmounts: { BTC: 0.03, ETH: 1, TRX: 10_000 },
  swapWindowMinutes: 30,
  stablecoins: ['USDT', 'USDC', 'DAI'],
};

const DIRECT_EXPLANATIONS: Record<Exclude<CashOutKind, 'stablecoin_swap'>, string> = {
  exchange_deposit:
    'Środki wysłano na adres giełdy kryptowalut. Giełdy pozwalają sprzedać kryptowaluty i wypłacić pieniądze ' +
    'na rachunek bankowy, dlatego taki przelew jest typową oznaką wypłaty na waluty tradycyjne.',
  p2p_service:
    'Środki wysłano na adres serwisu wymiany bezpośredniej (P2P). W takich serwisach kryptowaluty sprzedaje się ' +
    'innej osobie za przelew bankowy lub gotówkę.',
  payment_gateway:
    'Środki wysłano na adres bramki płatniczej. Bramka zamienia kryptowaluty na zwykłe pieniądze dla sprzedawcy, ' +
    'co oznacza zapłatę kryptowalutą za towar lub usługę.',
  crypto_card:
    'Środki wysłano na adres obsługujący kartę płatniczą zasilaną kryptowalutami. Doładowanie takiej karty pozwala ' +
    'wydawać kryptowaluty jak zwykłe pieniądze.',
};

export const formatAmount = (amount: number) => amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 });

function describeCounterparty(transfer: ClassifiedTransfer): string {
  return transfer.counterpartyLabel ? `„${transfer.counterpartyLabel}” (${transfer.counterparty})` : transfer.counterparty;
}

function indicator(transfer: ClassifiedTransfer, kind: CashOutKind, explanation: string): CashOutIndicator {
  return {
    kind,
    txid: transfer.txid,
    time: transfer.time,
    asset: transfer.asset,
    amount: transfer.amount,
    counterparty: transfer.counterparty,
    ...(transfer.counterpartyLabel ? { counterpartyLabel: transfer.counterpartyLabel } : {}),
    explanation,
    explorerUrl: transfer.explorerUrl,
  };
}

export function detectCashOuts(transfers: ClassifiedTransfer[], options: CashOutOptions = {}): CashOutIndicator[] {
  const significantAmounts = options.significantAmounts ?? DEFAULT_CASHOUT_OPTIONS.significantAmounts;
  const windowMs = (options.swapWindowMinutes ?? DEFAULT_CASHOUT_OPTIONS.swapWindowMinutes) * 60_000;
  const stablecoins = new Set((options.stablecoins ?? DEFAULT_CASHOUT_OPTIONS.stablecoins).map((s) => s.toUpperCase()));
  const isStablecoin = (asset: string) => stablecoins.has(asset.toUpperCase());

  const ordered = [...transfers].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const stableInflows = ordered.filter((t) => t.direction === 'in' && isStablecoin(t.asset));
  // Jedno przyjście stablecoinów potwierdza najwyżej jedną zamianę.
  const usedInflows = new Set<ClassifiedTransfer>();
  const result: CashOutIndicator[] = [];

  for (const transfer of ordered) {
    if (transfer.direction !== 'out') continue;
    const kind =
      transfer.counterpartyKind ?? (transfer.counterpartyClass === 'exchange' ? 'exchange_deposit' : undefined);
    const sent = `${formatAmount(transfer.amount)} ${transfer.asset}`;

    if (kind && kind !== 'stablecoin_swap') {
      result.push(indicator(transfer, kind, `Przelew ${sent} na adres ${describeCounterparty(transfer)}. ${DIRECT_EXPLANATIONS[kind]}`));
      continue;
    }

    // Zamiana na stablecoiny: liczy się tylko wyjście waluty o zmiennym kursie i znacznej wartości.
    if (isStablecoin(transfer.asset)) continue;
    const threshold = significantAmounts[transfer.asset.toUpperCase()];
    if (threshold === undefined || transfer.amount < threshold) continue;
    const isSwapTarget = kind === 'stablecoin_swap' || transfer.counterpartyClass === 'smart_contract';
    if (!isSwapTarget) continue;

    const sentAt = Date.parse(transfer.time);
    const inflow = stableInflows.find((candidate) => {
      if (usedInflows.has(candidate)) return false;
      const delay = Date.parse(candidate.time) - sentAt;
      return candidate.txid === transfer.txid || (delay >= 0 && delay <= windowMs);
    });
    if (!inflow && kind !== 'stablecoin_swap') continue;
    if (inflow) usedInflows.add(inflow);

    const received = inflow
      ? ` W krótkim czasie na badany adres wpłynęło ${formatAmount(inflow.amount)} ${inflow.asset}.`
      : '';
    result.push(
      indicator(
        transfer,
        'stablecoin_swap',
        `Przelew ${sent} na adres ${describeCounterparty(transfer)} — usługi wymiany kryptowalut.${received} ` +
          'Wygląda to na zamianę znacznej wartości na stablecoiny, czyli tokeny o stałym kursie do dolara. ' +
          'Taka zamiana utrwala zysk i często poprzedza wypłatę na rachunek bankowy.',
      ),
    );
  }

  return result;
}
