// Jedno miejsce składania `ChainActivity`: profil adresu, przelewy, wskaźniki
// wypłat z wyceną, sumy per rok podatkowy i ograniczenia danych. Dostawcy
// dostarczają tylko surowe dane (`RawAddressData`).

import type {
  AddressClass,
  AddressCluster,
  CashOutIndicator,
  CashOutKind,
  CashOutTrail,
  ChainActivity,
  ChainProvider,
  ConnectorContext,
  Network,
} from '@olcys/core';
import { detectCashOuts, formatAmount } from './cashout.ts';
import type { CashOutOptions, ClassifiedTransfer } from './cashout.ts';
import { DEFAULT_DEPOSIT_OPTIONS, describeInferredDeposit } from './deposit.ts';
import type { DepositOptions, InferredDeposit } from './deposit.ts';
import { classify, getDefaultLabels } from './labels.ts';
import type { LabelSet } from './labels.ts';
import { getDefaultSanctions, sanctionLabel, sanctionWarning } from './ofac.ts';
import { trailConfidence } from './trace.ts';
import type { TraceOptions, TracedTrail } from './trace.ts';
import type { SanctionsList } from './ofac.ts';
import { StaticRateSource, summarizeByTaxYear, usesSampleRate, valueAmount, valueCashOuts } from './valuation.ts';
import type { RateSource } from './valuation.ts';

export const NATIVE_ASSET: Record<Network, string> = {
  bitcoin: 'BTC',
  // Monety sieci testowej nie mają wartości, więc dostają osobny symbol i nie są wyceniane.
  'bitcoin-testnet': 'tBTC',
  ethereum: 'ETH',
  tron: 'TRX',
};

export interface RawTransfer {
  txid: string;
  time: string;
  direction: 'in' | 'out';
  counterparty: string;
  asset: string;
  amount: number;
  explorerUrl: string;
  /** Co źródło danych wie o kontrahencie. */
  counterpartyLabel?: string;
  counterpartyClass?: AddressClass;
  counterpartyKind?: CashOutKind;
  counterpartyIsContract?: boolean;
  /** Źródło etykiety kontrahenta, gdy inne niż źródło danych o adresie (np. `WalletExplorer`). */
  counterpartyLabelSource?: string;
  /** Nazwa ENS kontrahenta — pokazywana jako etykieta, ale bez wpływu na klasę adresu. */
  counterpartyEns?: string;
  /** Źródło etykiet już sprawdziło tego kontrahenta i nie ma dla niego etykiety. */
  counterpartyLabelChecked?: boolean;
}

/** Surowe dane o adresie w postaci wspólnej dla wszystkich dostawców. */
export interface RawAddressData {
  network: Network;
  address: string;
  /** Nazwa źródła danych, do `classificationSource`. */
  sourceName: string;
  isContract?: boolean;
  label?: string;
  addressClass?: AddressClass;
  /** Źródło etykiety/klasy, gdy inne niż `sourceName` (np. `Blockscout`, `WalletExplorer`). */
  labelSource?: string;
  /** Nazwa ENS adresu — pokazywana jako etykieta, ale bez wpływu na klasę adresu. */
  ensName?: string;
  /** Przelewy, po których adres pośredni przekazał środki na giełdę (wnioskowanie). */
  inferredDeposits?: InferredDeposit[];
  /** Ścieżki środków ustalone śledzeniem w głąb (przed wyceną). */
  trails?: TracedTrail[];
  /** Inne adresy tego samego portfela (heurystyki) albo opis, dlaczego klastra nie ma. */
  cluster?: AddressCluster;
  /** Wartości podane przez źródło; brakujące liczymy z pobranych przelewów. */
  txCount?: number;
  totalReceived?: number;
  totalSent?: number;
  balance?: number;
  /** `false`, gdy pobrano tylko część historii — wtedy nie podajemy daty pierwszej transakcji. */
  historyComplete?: boolean;
  transfers: RawTransfer[];
  limitations: string[];
}

/** Zależności wspólne dla dostawców; wszystkie mają bezpieczne wartości domyślne. */
export interface ActivityOptions {
  labels?: LabelSet;
  rateSource?: RateSource;
  cashOut?: CashOutOptions;
  /** Lista sankcyjna; domyślnie lokalna kopia listy OFAC SDN. */
  sanctions?: SanctionsList;
  /** Ustawienia wnioskowania o indywidualnych adresach wpłat na giełdy. */
  deposit?: DepositOptions;
  /** Ustawienia śledzenia środków w głąb (rozszerzają `deposit`). */
  trace?: TraceOptions;
}

const roundAmount = (value: number) => Math.round(value * 1e8) / 1e8;

export async function buildChainActivity(raw: RawAddressData, options: ActivityOptions = {}): Promise<ChainActivity> {
  const labels = options.labels ?? getDefaultLabels();
  const rateSource = options.rateSource ?? new StaticRateSource();
  const sanctions = options.sanctions ?? getDefaultSanctions();
  const nativeAsset = NATIVE_ASSET[raw.network];
  const warnings: string[] = [];
  const inferred = raw.inferredDeposits ?? [];
  const inferredFor = (txid: string, counterparty: string) =>
    inferred.find((item) => item.txid === txid && item.counterparty === counterparty);
  const windowHours = options.trace?.windowHours ?? options.deposit?.windowHours ?? DEFAULT_DEPOSIT_OPTIONS.windowHours;
  /** Skąd pochodzi klasyfikacja kontrahenta danego przelewu — do opisu ścieżek. */
  const labelSources = new Map<string, string>();

  const transfers: ClassifiedTransfer[] = raw.transfers
    .map((transfer) => {
      // Kontrahent bez etykiety zostaje `unknown`; dalej badamy tylko odbiorców największych przelewów.
      const counterparty = classify(raw.network, transfer.counterparty, {
        labels,
        sourceLabel: transfer.counterpartyLabel,
        sourceClass: transfer.counterpartyClass,
        sourceKind: transfer.counterpartyKind,
        sourceName: transfer.counterpartyLabelSource ?? raw.sourceName,
        isContract: transfer.counterpartyIsContract,
      });
      labelSources.set(`${transfer.txid}|${transfer.counterparty}`, counterparty.classificationSource);
      const deposit = transfer.direction === 'out' ? inferredFor(transfer.txid, transfer.counterparty) : undefined;
      let label =
        counterparty.label ??
        (deposit ? `Prawdopodobny adres wpłat giełdy „${deposit.exchangeLabel}” (wnioskowanie)` : undefined) ??
        (transfer.counterpartyEns ? `ENS: ${transfer.counterpartyEns}` : undefined);
      const sanctioned = sanctions.lookup(transfer.counterparty);
      if (sanctioned) {
        label = label ? `${sanctionLabel(sanctioned)} — ${label}` : sanctionLabel(sanctioned);
        const warning = sanctionWarning(sanctions, sanctioned, 'kontrahent');
        if (!warnings.includes(warning)) warnings.push(warning);
      }
      return {
        txid: transfer.txid,
        time: transfer.time,
        direction: transfer.direction,
        counterparty: transfer.counterparty,
        counterpartyClass: counterparty.addressClass,
        ...(label ? { counterpartyLabel: label } : {}),
        ...(counterparty.kind ? { counterpartyKind: counterparty.kind } : {}),
        asset: transfer.asset,
        amount: transfer.amount,
        explorerUrl: transfer.explorerUrl,
      };
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const native = transfers.filter((transfer) => transfer.asset === nativeAsset);
  const sum = (direction: 'in' | 'out') =>
    roundAmount(native.filter((t) => t.direction === direction).reduce((total, t) => total + t.amount, 0));
  const totalReceived = raw.totalReceived ?? sum('in');
  const totalSent = raw.totalSent ?? sum('out');
  const txCount = raw.txCount ?? new Set(transfers.map((transfer) => transfer.txid)).size;

  const classification = classify(raw.network, raw.address, {
    labels,
    sourceLabel: raw.label,
    sourceClass: raw.addressClass,
    sourceName: raw.labelSource ?? raw.sourceName,
    isContract: raw.isContract,
    txCount,
  });
  let profileLabel = classification.label ?? (raw.ensName ? `ENS: ${raw.ensName}` : undefined);
  let classificationSource = classification.classificationSource;
  const sanctionedSubject = sanctions.lookup(raw.address);
  if (sanctionedSubject) {
    profileLabel = profileLabel ? `${sanctionLabel(sanctionedSubject)} — ${profileLabel}` : sanctionLabel(sanctionedSubject);
    classificationSource = `${classificationSource}; ${sanctions.source}`;
    warnings.unshift(sanctionWarning(sanctions, sanctionedSubject, 'badany adres'));
  }

  // Wskaźniki bezpośrednie (kontrahent z etykietą) i oparte na wnioskowaniu (adres pośredni).
  const detected = detectCashOuts(transfers, options.cashOut);
  for (const transfer of transfers) {
    if (transfer.direction !== 'out') continue;
    const deposit = inferredFor(transfer.txid, transfer.counterparty);
    if (!deposit || detected.some((item) => item.txid === transfer.txid && item.counterparty === transfer.counterparty)) continue;
    detected.push({
      kind: 'exchange_deposit',
      txid: transfer.txid,
      time: transfer.time,
      asset: transfer.asset,
      amount: transfer.amount,
      counterparty: transfer.counterparty,
      ...(transfer.counterpartyLabel ? { counterpartyLabel: transfer.counterpartyLabel } : {}),
      explanation: describeInferredDeposit(deposit, `${formatAmount(transfer.amount)} ${transfer.asset}`, windowHours),
      explorerUrl: transfer.explorerUrl,
    });
  }

  // Ścieżki środków: bezpośrednie (z przelewów na oznaczone adresy usług) i ustalone śledzeniem.
  const traced = raw.trails ?? [];
  const tracedHops = new Set(traced.flatMap((trail) => trail.hops.map((hop) => `${hop.txid}|${hop.to}`)));
  const direct: TracedTrail[] = [];
  for (const transfer of transfers) {
    const kind = transfer.counterpartyKind ?? (transfer.counterpartyClass === 'exchange' ? 'exchange_deposit' : undefined);
    if (transfer.direction !== 'out' || !kind || kind === 'stablecoin_swap' || !transfer.counterpartyLabel) continue;
    if (inferredFor(transfer.txid, transfer.counterparty) || tracedHops.has(`${transfer.txid}|${transfer.counterparty}`)) continue;
    // Token o niezweryfikowanym kontrakcie nie jest podstawą ścieżki — nie wiadomo, co naprawdę przesłano.
    if (transfer.asset.includes('niezweryfikowany')) continue;
    const classified = { classificationSource: labelSources.get(`${transfer.txid}|${transfer.counterparty}`) ?? raw.sourceName };
    const labelBy = classified.classificationSource === labels.name ? 'curated' : /^WalletExplorer/.test(classified.classificationSource) ? 'wallet_heuristic' : 'explorer_tag';
    const scored = trailConfidence({ steps: [], labelBy, amountRatio: 1, elapsedHours: 0 });
    const day = transfer.time.slice(0, 10);
    direct.push({
      id: `${raw.network}:${transfer.txid}:${transfer.txid}:${transfer.counterparty}`,
      sourceAddress: raw.address,
      network: raw.network,
      hops: [
        {
          txid: transfer.txid,
          time: transfer.time,
          from: raw.address,
          to: transfer.counterparty,
          asset: transfer.asset,
          amount: transfer.amount,
          toLabel: transfer.counterpartyLabel,
          toClass: transfer.counterpartyClass,
          explorerUrl: transfer.explorerUrl,
        },
      ],
      serviceName: transfer.counterpartyLabel,
      serviceKind: kind,
      asset: transfer.asset,
      amount: transfer.amount,
      confidence: scored.confidence,
      reasons: [`Bezpośredni przelew na adres usługi „${transfer.counterpartyLabel}”; etykieta: ${classified.classificationSource}.`, ...scored.reasons],
      openQuestions: [
        `${transfer.counterpartyLabel} może potwierdzić właściciela konta, na które wpłynęło ${formatAmount(transfer.amount)} ${transfer.asset} ${day} (tx ${transfer.txid}).`,
        'Czy po tej wpłacie nastąpiła sprzedaż i wypłata na rachunek bankowy (historia konta w usłudze, wyciąg bankowy)?',
      ],
    });
  }
  const allTrails = [...direct, ...traced].sort((a, b) => Date.parse(a.hops[0]!.time) - Date.parse(b.hops[0]!.time));

  // Ścieżka, której żaden krok nie ma jeszcze wskaźnika wypłaty, dostaje własny wskaźnik
  // (np. wpłata na giełdę z adresu reszty). Istniejących wskaźników nie dublujemy.
  for (const trail of traced) {
    if (trail.hops.some((hop) => detected.some((item) => item.txid === hop.txid))) continue;
    const last = trail.hops.at(-1)!;
    const intermediates = trail.hops.length - 1;
    const indicator: CashOutIndicator = {
      kind: trail.serviceKind,
      txid: last.txid,
      time: last.time,
      asset: trail.asset,
      amount: trail.amount,
      counterparty: last.to,
      counterpartyLabel: trail.serviceName,
      explanation:
        (intermediates > 0 || last.inferred
          ? `WNIOSKOWANIE (nie ustalony fakt): ${formatAmount(trail.amount)} ${trail.asset} dotarło do usługi „${trail.serviceName}” ` +
            `ścieżką o ${trail.hops.length} krokach zaczynającą się od portfela podmiotu (pewność ścieżki ${trail.confidence}/100). `
          : `Przelew ${formatAmount(trail.amount)} ${trail.asset} na adres usługi „${trail.serviceName}” (jedno z wyjść transakcji). `) +
        trail.hops
          .map((hop, index) => `Krok ${index + 1}: ${hop.from} → ${hop.to}, ${formatAmount(hop.amount)} ${hop.asset}, tx ${hop.txid}${hop.reason ? ` (${hop.reason})` : ''}.`)
          .join(' '),
      explorerUrl: last.explorerUrl,
    };
    detected.push(indicator);
  }
  detected.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const cashOuts = await valueCashOuts(detected, rateSource);
  const trails: CashOutTrail[] = await Promise.all(
    allTrails.map(async (trail) => {
      const last = trail.hops.at(-1)!;
      const valued = await valueAmount(rateSource, trail.asset, trail.amount, last.time);
      return valued ? { ...trail, valuePln: valued.valuePln, valuation: valued.valuation } : trail;
    }),
  );
  const limitations = [...warnings, ...raw.limitations];
  if (cashOuts.length > 0) {
    limitations.push(
      'Kwoty w PLN są szacunkiem po kursie przybliżonym do dnia transakcji (opis kursu przy każdym wskaźniku). ' +
        'Nie stanowią ustalenia przychodu ani podstawy opodatkowania — wymagają weryfikacji na podstawie danych giełdy lub banku.',
    );
  }
  const sampled = cashOuts.filter(usesSampleRate).length;
  if (sampled > 0) {
    limitations.push(
      `${sampled} z ${cashOuts.length} wskaźników wyceniono KURSEM PRZYKŁADOWYM (tabela demonstracyjna), a nie rynkowym — ` +
        'te kwoty PLN nie nadają się do żadnych ustaleń; powtórz analizę z dostępem do kursów Binance i NBP.',
    );
  }
  const unvalued = cashOuts.filter((cashOut) => cashOut.valuePln === undefined).length;
  if (unvalued > 0) {
    limitations.push(
      `Dla ${unvalued} wskaźników wypłaty brak kursu — nie są ujęte w sumach PLN.` +
        (rateSource.lastFailure ? ` Ostatni błąd źródła kursów: ${rateSource.lastFailure}.` : ''),
    );
  }

  const complete = raw.historyComplete ?? true;
  const firstSeen = complete ? transfers[0]?.time : undefined;
  const lastSeen = transfers.at(-1)?.time;

  return {
    profile: {
      address: raw.address,
      network: raw.network,
      addressClass: classification.addressClass,
      ...(profileLabel ? { label: profileLabel } : {}),
      classificationSource,
      isContract: raw.isContract ?? false,
      txCount,
      ...(firstSeen ? { firstSeen } : {}),
      ...(lastSeen ? { lastSeen } : {}),
      totalReceived,
      totalSent,
      balance: raw.balance ?? roundAmount(totalReceived - totalSent),
      nativeAsset,
    },
    transfers,
    cashOuts,
    cashOutPlnByYear: summarizeByTaxYear(cashOuts),
    limitations,
    ...(trails.length > 0 ? { trails } : {}),
    ...(raw.cluster ? { cluster: raw.cluster } : {}),
  };
}

/** Aktywność adresu, o którym żadne źródło nie ma danych: klasa wynika najwyżej ze zbioru etykiet. */
export function unknownActivity(
  network: Network,
  address: string,
  limitations: string[],
  options: ActivityOptions = {},
): Promise<ChainActivity> {
  return buildChainActivity(
    { network, address, sourceName: 'brak źródła danych', transfers: [], limitations },
    options,
  );
}

/**
 * Pyta dostawców po kolei i zwraca pierwszą udaną odpowiedź. Błąd dostawcy
 * (np. „nieznany adres” z sandboxa) trafia do dziennika analizy, a próbę
 * podejmuje następny. Gdy nikt nie ma danych, wynik ma klasę `unknown`, zera
 * i powody w `limitations` — analiza nie jest przerywana.
 */
export async function getActivityFromProviders(
  providers: ChainProvider[],
  network: Network,
  address: string,
  context: ConnectorContext,
  options: ActivityOptions = {},
): Promise<ChainActivity> {
  const failures: string[] = [];
  for (const provider of providers) {
    if (!provider.supports(network, address)) continue;
    try {
      const activity = await provider.getActivity(network, address, context);
      context.log(`Dane blockchain dla ${address}: ${provider.label}.`);
      return activity;
    } catch (error) {
      if (context.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${provider.label}: ${reason}`);
      context.log(`Dostawca „${provider.label}” nie zwrócił danych dla ${address}: ${reason}`);
    }
  }
  const limitations =
    failures.length > 0
      ? [`Brak danych blockchain dla adresu — żaden dostawca nie odpowiedział poprawnie. ${failures.join(' ')}`]
      : [`Brak danych blockchain dla adresu — żaden skonfigurowany dostawca nie obsługuje sieci ${network}.`];
  return unknownActivity(network, address, limitations, options);
}
