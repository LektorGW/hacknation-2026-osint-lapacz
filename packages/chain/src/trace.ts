// Śledzenie środków w głąb: od przelewu wychodzącego z adresu podmiotu do
// adresu z etykietą usługi wymiany (giełda, P2P, bramka, karta). Każde przejście
// przez adres pośredni opiera się na jawnej, ostrożnej regule i jest opisane
// w `reason` kroku. Ścieżka z krokami pośrednimi to WNIOSKOWANIE, nie dowód.
//
// Reguły przejścia:
//  (a) adres przelotowy — otrzymał kwotę i w oknie czasu przekazał dalej ≥ ~90%;
//  (b) łańcuch reszty w Bitcoinie — płatność do usługi + reszta wracająca do portfela;
//  (c) adres wpłat giełdy — zamiecenie na oznaczony portfel giełdy (jeden krok);
//  (d) zamiana na stablecoin w kontrakcie wymiany, po której stablecoin idzie dalej.
// Ścieżka KOŃCZY SIĘ na adresie o dużej liczbie transakcji (usługa bez etykiety),
// na kontrakcie, w mikserze (z ostrzeżeniem) i po wyczerpaniu budżetu żądań.

import type { CashOutKind, CashOutTrail, FlowHop, Network } from '@olcys/core';
import type { RawTransfer } from './activity.ts';
import { DEFAULT_CLUSTER_LIMIT, commonInputAddresses, detectChange, looksLikeCoinJoin } from './cluster.ts';
import type { UtxoTx } from './cluster.ts';
import { DEFAULT_DEPOSIT_OPTIONS } from './deposit.ts';
import type { DepositOptions, InferredDeposit } from './deposit.ts';
import { ChainProviderError } from './http.ts';
import type { RequestBudget } from './http.ts';
import { classify, matchService, normalizeAddress } from './labels.ts';
import type { Classification, LabelSet } from './labels.ts';
import { isQueryableAddress } from './party-labels.ts';
import type { LabelLookup } from './party-labels.ts';

export interface TraceOptions extends DepositOptions {
  /** Maksymalna liczba kroków ścieżki (łącznie z krokiem do usługi). */
  maxHops?: number;
  /** Powyżej tylu transakcji adres pośredni uznajemy za usługę i kończymy ścieżkę. */
  maxNodeTxCount?: number;
  /** W ciągu ilu godzin po zamianie stablecoin musi zostać przekazany dalej. */
  swapForwardHours?: number;
  /** Maksymalny rozmiar klastra adresów portfela (Bitcoin). */
  clusterLimit?: number;
  /**
   * Bitcoin: ile godzin adres pośredni może przetrzymać środki. Powiązanie jest tu ścisłe
   * (wydano dokładnie to wyjście, które otrzymał), więc okno jest dłuższe niż w modelu kont;
   * dłuższy czas obniża pewność ścieżki.
   */
  utxoHoldHours?: number;
  /** Bitcoin: ile wyjść jednej transakcji wypływu najwyżej śledzimy osobno. */
  maxBranches?: number;
  /** Bitcoin: wyjście jest „istotne”, gdy ma co najmniej taką część wartości wypływu (0–1). */
  minBranchShare?: number;
}

export const DEFAULT_TRACE_OPTIONS: Required<TraceOptions> = {
  ...DEFAULT_DEPOSIT_OPTIONS,
  maxHops: 4,
  maxNodeTxCount: 200,
  swapForwardHours: 72,
  clusterLimit: DEFAULT_CLUSTER_LIMIT,
  utxoHoldHours: 30 * 24,
  maxBranches: 4,
  minBranchShare: 0.05,
};

/** Ścieżka przed wyceną w PLN. */
export type TracedTrail = Omit<CashOutTrail, 'valuePln' | 'valuation'>;

export interface TraceResult {
  trails: TracedTrail[];
  /** Jednokrokowe przypadki „adres wpłat giełdy” w dotychczasowym formacie wskaźników. */
  deposits: InferredDeposit[];
  limitations: string[];
  /**
   * Pytania do wyjaśnienia poza łańcuchem dla ścieżek, które urwały się bez wyniku —
   * przede wszystkim: dokąd trafiła największa część środków. `txid` to przelew z portfela podmiotu.
   */
  openQuestions: { txid: string; text: string }[];
}

// ---------- Wzór pewności ----------

/** Rodzaj ogniwa pośredniego na ścieżce. */
export type TrailStep = 'passthrough' | 'deposit_sweep' | 'change' | 'swap' | 'cluster';

export interface ConfidenceInput {
  /** Ogniwa pośrednie w kolejności; pusta lista = bezpośredni przelew na adres usługi. */
  steps: TrailStep[];
  /** Liczba heurystyk potwierdzających każdy krok typu `change` (w tej samej kolejności). */
  changeHeuristics?: number[];
  /** Skąd wiadomo, że adres końcowy to usługa. */
  labelBy: 'curated' | 'explorer_tag' | 'wallet_heuristic';
  /** Kwota, która dotarła do usługi, podzielona przez kwotę, która opuściła portfel podmiotu. */
  amountRatio: number;
  /** Czas od opuszczenia portfela podmiotu do wpływu do usługi. */
  elapsedHours: number;
}

export const CONFIDENCE_RULES = {
  direct: 95,
  walletHeuristicLabel: -5,
  step: { passthrough: -10, deposit_sweep: -8, swap: -12, cluster: -12 },
  /** Krok „reszta”: kara zależy od liczby zgodnych heurystyk (1, 2, 3 i więcej). */
  change: [-22, -18, -15],
  amount: [
    { min: 0.98, points: 4 },
    { min: 0.9, points: 2 },
    { min: 0.5, points: 0 },
    { min: 0, points: -8 },
  ],
  time: [
    { maxHours: 1, points: 4 },
    { maxHours: 24, points: 2 },
    { maxHours: 72, points: 0 },
    { maxHours: Infinity, points: -5 },
  ],
  /** Ścieżka z ogniwem pośrednim nigdy nie dorównuje przelewowi bezpośredniemu. */
  inferredCap: 90,
  min: 5,
} as const;

const signed = (points: number) => (points > 0 ? `+${points}` : `${points}`);

/**
 * Pewność 0–100, że środki podmiotu trafiły do usługi. Jawny wzór:
 * 95 za bezpośredni przelew na oznaczony portfel usługi; −5, gdy etykieta
 * pochodzi z heurystycznego grupowania portfeli (WalletExplorer); każde ogniwo
 * pośrednie obniża (adres wpłat −8, przelotowy −10, zamiana −12, adres z klastra −12,
 * reszta −22/−18/−15 zależnie od liczby zgodnych heurystyk); gdy środki przeszły
 * przez obcy adres — zgodność kwot (+4…−8) i krótki czas (+4…−5); ścieżka
 * z jakimkolwiek ogniwem pośrednim dostaje najwyżej 90.
 */
export function trailConfidence(input: ConfidenceInput): { confidence: number; reasons: string[] } {
  const rules = CONFIDENCE_RULES;
  const reasons: string[] = [`${rules.direct} pkt — punkt wyjścia: przelew na adres z publiczną etykietą usługi wymiany`];
  let score: number = rules.direct;
  if (input.labelBy === 'wallet_heuristic') {
    score += rules.walletHeuristicLabel;
    reasons.push(`${signed(rules.walletHeuristicLabel)} — etykieta usługi pochodzi z heurystycznego grupowania adresów w portfele (WalletExplorer)`);
  }
  let changeIndex = 0;
  for (const step of input.steps) {
    if (step === 'change') {
      const count = Math.max(1, input.changeHeuristics?.[changeIndex] ?? 1);
      changeIndex += 1;
      const points = rules.change[Math.min(count, rules.change.length) - 1]!;
      score += points;
      reasons.push(`${signed(points)} — krok przez adres reszty (heurystyka; zgodnych przesłanek: ${count})`);
      continue;
    }
    const points = rules.step[step];
    score += points;
    const what = {
      passthrough: 'adres przelotowy (przekazał dalej niemal całą otrzymaną kwotę)',
      deposit_sweep: 'adres pośredni zamieciony na portfel giełdy (prawdopodobny adres wpłat)',
      swap: 'powiązanie zamiany na stablecoin z późniejszym przelewem stablecoina',
      cluster: 'ścieżka zaczyna się od innego adresu portfela (heurystyka wspólnych wejść)',
    }[step];
    reasons.push(`${signed(points)} — ${what}`);
  }
  // Zgodność kwot i czas oceniamy tylko tam, gdzie środki przeszły przez obcy adres;
  // przy samym adresie reszty lub adresie z klastra płatność wychodzi wprost z portfela.
  const transit = input.steps.some((step) => step === 'passthrough' || step === 'deposit_sweep' || step === 'swap');
  if (transit) {
    const amount = rules.amount.find((rule) => input.amountRatio >= rule.min) ?? rules.amount.at(-1)!;
    score += amount.points;
    reasons.push(`${signed(amount.points)} — zgodność kwot: do usługi dotarło ${Math.round(Math.min(input.amountRatio, 9.99) * 100)}% kwoty, która opuściła portfel`);
    const time = rules.time.find((rule) => input.elapsedHours <= rule.maxHours)!;
    score += time.points;
    reasons.push(
      `${signed(time.points)} — czas od opuszczenia portfela do wpływu do usługi: ` +
        `${input.elapsedHours.toLocaleString('pl-PL', { maximumFractionDigits: 1 })} h`,
    );
  }
  if (input.steps.length > 0 && score > rules.inferredCap) {
    score = rules.inferredCap;
    reasons.push(`ograniczenie do ${rules.inferredCap} — ścieżka z ogniwem pośrednim jest wnioskowaniem`);
  }
  return { confidence: Math.max(rules.min, Math.min(rules.direct, Math.round(score))), reasons };
}

// ---------- Wspólne narzędzia ----------

const SERVICE_KIND_NAMES: Record<CashOutKind, string> = {
  exchange_deposit: 'giełda',
  p2p_service: 'serwis P2P',
  payment_gateway: 'bramka płatnicza',
  crypto_card: 'karta krypto-fiat',
  stablecoin_swap: 'zamiana na stablecoin',
};

const formatAmount = (amount: number) => amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 });
const formatHours = (hours: number) => hours.toLocaleString('pl-PL', { maximumFractionDigits: 1 });
const hoursBetween = (from: string, to: string) => Math.max(0, (Date.parse(to) - Date.parse(from)) / 3_600_000);
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;
const short = (address: string) => (address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address);

interface Service {
  name: string;
  kind: CashOutKind;
  labelBy: ConfidenceInput['labelBy'];
  source: string;
}

/** Usługa wymiany rozpoznana po klasyfikacji adresu; `undefined` dla pozostałych adresów. */
function serviceOf(known: Classification, labels: LabelSet): Service | undefined {
  const kind = known.kind && known.kind !== 'stablecoin_swap' ? known.kind : known.addressClass === 'exchange' ? 'exchange_deposit' : undefined;
  if (!kind) return undefined;
  const labelBy =
    known.classificationSource === labels.name
      ? 'curated'
      : /^WalletExplorer/.test(known.classificationSource)
        ? 'wallet_heuristic'
        : 'explorer_tag';
  return { name: known.label ?? SERVICE_KIND_NAMES[kind], kind, labelBy, source: known.classificationSource };
}

function openQuestions(service: Service, last: FlowHop, hops: FlowHop[], steps: TrailStep[]): string[] {
  const day = last.time.slice(0, 10);
  const what = `${formatAmount(last.amount)} ${last.asset} ${day} (tx ${last.txid})`;
  const questions: string[] = [];
  if (steps.includes('deposit_sweep') && hops.length >= 2) {
    const deposit = hops.at(-2)!.to;
    questions.push(
      `${service.name} może potwierdzić, do konta którego klienta przypisany jest adres wpłat ${deposit} ` +
        `i czy wpłata ${what} została zaksięgowana temu klientowi.`,
    );
  } else {
    questions.push(`${service.name} może potwierdzić właściciela konta, na które wpłynęło ${what}.`);
  }
  questions.push('Czy po tej wpłacie nastąpiła sprzedaż i wypłata na rachunek bankowy (historia konta w usłudze, wyciąg bankowy)?');
  const intermediates = hops.slice(0, -1).map((hop) => hop.to);
  if (intermediates.length > 0) {
    questions.push(
      `Kto kontroluje adresy pośrednie (${intermediates.map(short).join(', ')})? Łańcuch nie rozstrzyga, czy to ten sam podmiot, ` +
        'pośrednik, czy odbiorca płatności, który sam wpłacił środki do usługi.',
    );
  }
  return questions;
}

interface TrailDraft {
  network: Network;
  sourceAddress: string;
  hops: FlowHop[];
  steps: TrailStep[];
  changeHeuristics: number[];
  service: Service;
  /** Kwota, która opuściła portfel podmiotu na początku tej ścieżki. */
  originAmount: number;
  /** Chwila opuszczenia portfela podmiotu. */
  leftAt: string;
  amount: number;
}

function buildTrail(draft: TrailDraft): TracedTrail {
  const last = draft.hops.at(-1)!;
  const sameAsset = draft.hops.every((hop) => hop.asset === last.asset);
  const scored = trailConfidence({
    steps: draft.steps,
    changeHeuristics: draft.changeHeuristics,
    labelBy: draft.service.labelBy,
    amountRatio: sameAsset && draft.originAmount > 0 ? draft.amount / draft.originAmount : 1,
    elapsedHours: hoursBetween(draft.leftAt, last.time),
  });
  const kindName = SERVICE_KIND_NAMES[draft.service.kind];
  const summary =
    draft.steps.length === 0
      ? `Bezpośredni przelew na adres usługi „${draft.service.name}” (${kindName}); etykieta: ${draft.service.source}.`
      : `WNIOSKOWANIE: środki dotarły do usługi „${draft.service.name}” (${kindName}) przez ${draft.hops.length - 1} ` +
        `adres(y) pośredni(e); etykieta usługi: ${draft.service.source}.`;
  return {
    id: `${draft.network}:${draft.hops[0]!.txid}:${last.txid}:${last.to}`,
    sourceAddress: draft.sourceAddress,
    network: draft.network,
    hops: draft.hops,
    serviceName: draft.service.name,
    serviceKind: draft.service.kind,
    asset: last.asset,
    amount: round8(draft.amount),
    confidence: scored.confidence,
    reasons: [summary, ...draft.hops.filter((hop) => hop.reason).map((hop) => `Krok ${draft.hops.indexOf(hop) + 1}: ${hop.reason}`), ...scored.reasons],
    openQuestions: openQuestions(draft.service, { ...last, amount: round8(draft.amount) }, draft.hops, draft.steps),
  };
}

/** Zlicza przyczyny przerwania ścieżek i zamienia je na wpisy `limitations`. */
class StopLog {
  counts = new Map<string, number>();
  warnings: string[] = [];

  add(reason: string): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + 1);
  }

  warn(text: string): void {
    if (!this.warnings.includes(text)) this.warnings.push(text);
  }

  limitations(): string[] {
    const result = [...this.warnings];
    if (this.counts.size > 0) {
      const parts = [...this.counts.entries()].map(([reason, count]) => `${reason} (${count})`);
      result.push(`Śledzenie środków: ścieżki bez ustalonego końca w usłudze wymiany — ${parts.join('; ')}.`);
    }
    return result;
  }
}

const STOP = {
  activity: (count: number | undefined, limit: number) =>
    `adres pośredni o dużej aktywności (${count === undefined ? `co najmniej pełna strona historii` : `${count} transakcji`}, próg ${limit}) — prawdopodobnie usługa bez publicznej etykiety, dalej nie śledzimy`,
  contract: 'środki trafiły do kontraktu (wymiana, most, DeFi) — dalsza droga nie jest śledzona',
  unspent: 'środki pozostały na adresie pośrednim albo wyszły poza pobraną historią lub oknem czasu',
  split: 'środki zostały rozdzielone na mniejsze kwoty — brak dominującego odbiorcy',
  labelled: 'środki trafiły na adres z etykietą, która nie wskazuje usługi wymiany',
  depth: 'osiągnięto maksymalną liczbę kroków',
  error: 'błąd źródła danych przy pobieraniu historii adresu pośredniego',
};

const mixerWarning = (address: string, label: string | undefined, txid: string) =>
  `OSTRZEŻENIE — mikser: środki trafiły do „${label ?? 'transakcja typu CoinJoin'}” (${address}, tx ${txid}). ` +
  'Dalszej drogi środków nie da się wiarygodnie ustalić; użycie miksera wymaga osobnej oceny.';

function traceSummary(trails: TracedTrail[], options: Required<TraceOptions>): string[] {
  const inferred = trails.filter((trail) => trail.hops.length > 1).length;
  if (inferred === 0) return [];
  return [
    `Ścieżki z adresami pośrednimi (${inferred}) są WNIOSKOWANIEM z jawnych reguł (adres przelotowy: ≥ ${Math.round(options.minForwardedShare * 100)}% kwoty ` +
      `przekazane dalej w oknie ${options.windowHours} h, a w Bitcoinie wydanie dokładnie otrzymanego wyjścia w ciągu ${Math.round(options.utxoHoldHours / 24)} dni; ` +
      'adres reszty; zamiecenie adresu wpłat; zamiana na stablecoin). ' +
      'Każdy krok ma opis reguły, a ścieżka — pewność z jawnego wzoru. Adresy pośrednie mogą należeć do innych osób — potwierdzenie wymaga danych usługi.',
  ];
}

// ---------- Model kont: Ethereum, Tron ----------

/** Co źródło danych wie o adresie pośrednim. */
export interface ExpandedNode {
  /** Przelewy WYCHODZĄCE z adresu (z opisem odbiorców, jeśli źródło go podaje). */
  outgoing: RawTransfer[];
  /** Łączna liczba transakcji adresu, jeśli źródło ją podaje. */
  txCount?: number;
  /** Czy historia ma dalsze strony (adres aktywniejszy niż jedna strona). */
  more?: boolean;
}

export interface AccountTraceSearch {
  network: Network;
  address: string;
  /** Przelewy badanego adresu. */
  transfers: RawTransfer[];
  labels: LabelSet;
  sourceName: string;
  budget: RequestBudget;
  options?: TraceOptions;
  /**
   * Przelewy wychodzące z adresu pośredniego w podanej walucie — jedno żądanie do API.
   * `range` to okno czasu, w którym szukamy przekazania; źródło może je pominąć.
   */
  expand(address: string, asset: string, range: { since: number; until: number }): Promise<ExpandedNode>;
  /**
   * `true`, gdy `expand` faktycznie zawęża zapytanie do okna czasu (Tron). Pozwala śledzić
   * dawne przelewy, których nie ma już na pierwszej stronie historii adresu pośredniego.
   */
  timeBounded?: boolean;
  /** Liczba transakcji adresu (osobne żądanie), wywoływana tylko dla adresów z pełną stroną historii. */
  countTransactions?(address: string): Promise<number | undefined>;
  /** Hurtowe uzupełnienie etykiet odbiorców (jedno żądanie); dopisuje je do przelewów. */
  enrich?(transfers: RawTransfer[]): Promise<void>;
  /** Etykieta pojedynczego adresu (np. TronScan); każde pytanie zużywa budżet. */
  lookup?: LabelLookup;
  signal?: AbortSignal;
}

// Zgrubne wagi służą WYŁĄCZNIE do ustalenia kolejności „największych przelewów”
// między różnymi walutami; nie są kursami i nie trafiają do żadnej wyceny.
const ORDER_WEIGHTS: Record<string, number> = { BTC: 300_000, ETH: 10_000, WETH: 10_000, TRX: 1, USDT: 4, USDC: 4, DAI: 4 };
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI']);
const SWAP_SAME_TX_WINDOW_MS = 30 * 60_000;
const MAX_TRANSFERS_PER_CANDIDATE = 4;
/** Jaka część wyjść bardzo aktywnego adresu musi trafiać do jednej giełdy, by uznać go za adres wpłat. */
const EXCLUSIVE_SHARE = 0.95;

export async function traceAccountFlows(search: AccountTraceSearch): Promise<TraceResult> {
  const options = { ...DEFAULT_TRACE_OPTIONS, ...search.options };
  const { network, labels, budget } = search;
  const subject = normalizeAddress(search.address);
  const trails: TracedTrail[] = [];
  const deposits: InferredDeposit[] = [];
  const stops = new StopLog();
  const questions: TraceResult['openQuestions'] = [];
  if (!options.enabled) return { trails, deposits, limitations: [], openQuestions: questions };

  const describe = (transfer: RawTransfer) =>
    classify(network, transfer.counterparty, {
      labels,
      sourceLabel: transfer.counterpartyLabel,
      sourceClass: transfer.counterpartyClass,
      sourceKind: transfer.counterpartyKind,
      sourceName: transfer.counterpartyLabelSource ?? search.sourceName,
      isContract: transfer.counterpartyIsContract,
    });
  const hopOf = (from: string, transfer: RawTransfer, known: Classification, extra: Partial<FlowHop> = {}): FlowHop => ({
    txid: transfer.txid,
    time: transfer.time,
    from,
    to: transfer.counterparty,
    asset: transfer.asset,
    amount: transfer.amount,
    ...(known.label ? { toLabel: known.label } : {}),
    toClass: known.addressClass,
    explorerUrl: transfer.explorerUrl,
    ...extra,
  });

  const expanded = new Map<string, Promise<ExpandedNode>>();
  /** Ile kwoty danego przekazania przypisano już wcześniejszym wpłatom (jedno zamiecenie często obejmuje kilka wpłat). */
  const consumed = new Map<RawTransfer, number>();
  const available = (item: RawTransfer) => Math.max(0, item.amount - (consumed.get(item) ?? 0));
  const consume = (items: RawTransfer[], amount: number) => {
    let left = amount;
    for (const item of items) {
      const take = Math.min(left, available(item));
      consumed.set(item, (consumed.get(item) ?? 0) + take);
      left -= take;
      if (left <= 0) break;
    }
  };
  const counted = new Map<string, number | undefined>();
  const lookedUp = new Map<string, string | undefined>();
  let stoppedBy: string | undefined;
  let lookupBroken = false;
  const budgetStop = () => {
    stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
  };

  /** Uzupełnia etykiety odbiorców: hurtowo (jedno żądanie) albo pojedynczo dla dwóch największych. */
  async function labelDestinations(forwards: RawTransfer[]): Promise<void> {
    const unknown = forwards.filter((item) => {
      const known = describe(item);
      return known.addressClass === 'unknown' && !known.label && !item.counterpartyLabelChecked && isQueryableAddress(item.counterparty);
    });
    if (unknown.length === 0) return;
    if (search.enrich) {
      if (!budget.take()) return budgetStop();
      try {
        await search.enrich(unknown);
      } catch (error) {
        if (search.signal?.aborted) throw error;
        stops.warn(`Nie udało się hurtowo sprawdzić etykiet odbiorców: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (!search.lookup || lookupBroken) return;
    for (const item of unknown.slice(0, 2)) {
      const party = item.counterparty;
      if (!lookedUp.has(party)) {
        if (!search.lookup.cached?.(party) && !budget.take()) return budgetStop();
        try {
          lookedUp.set(party, await search.lookup.lookup(party, search.signal));
        } catch (error) {
          if (search.signal?.aborted) throw error;
          lookupBroken = true;
          stops.warn(`${search.lookup.sourceName}: nie udało się sprawdzić etykiety adresu ${party} (${error instanceof Error ? error.message : String(error)})`);
          return;
        }
      }
      const label = lookedUp.get(party);
      for (const same of forwards) {
        if (same.counterparty !== party) continue;
        same.counterpartyLabelChecked = true;
        if (label) {
          same.counterpartyLabel = label;
          same.counterpartyLabelSource = search.lookup.sourceName;
        }
      }
    }
  }

  interface WalkState {
    hops: FlowHop[];
    steps: TrailStep[];
    originAmount: number;
    leftAt: string;
  }

  /**
   * Idzie od adresu `current`, który w chwili `since` otrzymał `carried` jednostek waluty.
   * Zwraca `true`, gdy ścieżka dotarła do usługi.
   */
  async function walk(current: string, asset: string, carried: number, since: string, lastTxid: string, state: WalkState, visited: Set<string>): Promise<boolean> {
    if (state.hops.length >= options.maxHops) {
      stops.add(STOP.depth);
      return false;
    }
    const range = { since: Date.parse(since), until: Date.parse(since) + options.windowHours * 3_600_000 };
    const key = `${normalizeAddress(current)}|${asset}${search.timeBounded ? `|${range.since}` : ''}`;
    let pending = expanded.get(key);
    if (!pending) {
      if (!budget.take()) {
        budgetStop();
        return false;
      }
      pending = search.expand(current, asset, range);
      expanded.set(key, pending);
    }
    let node: ExpandedNode;
    try {
      node = await pending;
    } catch (error) {
      if (search.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ChainProviderError && (error.code === 'rate_limited' || error.code === 'timeout')) {
        stoppedBy = `błąd źródła danych — ${reason}`;
      } else {
        stops.warn(`Nie udało się sprawdzić dalszej drogi środków z adresu ${current}: ${reason}`);
        stops.add(STOP.error);
      }
      return false;
    }

    // Adres o dużej aktywności to zwykle usługa (giełda, kantor, most) bez publicznej etykiety:
    // jej wypłaty nie mają związku z wpłatą podmiotu, więc ścieżka tu się kończy.
    let txCount = node.txCount;
    if (txCount === undefined && node.more) {
      const id = normalizeAddress(current);
      if (!counted.has(id)) {
        if (search.countTransactions && budget.take()) {
          try {
            counted.set(id, await search.countTransactions(current));
          } catch (error) {
            if (search.signal?.aborted) throw error;
            counted.set(id, undefined);
          }
        } else {
          counted.set(id, undefined);
        }
      }
      txCount = counted.get(id);
    }
    // Wyjątek niżej: bardzo aktywny adres, którego WSZYSTKIE wyjścia trafiają do jednej giełdy,
    // ma wzorzec adresu wpłat intensywnie używanego konta — wtedy krok do giełdy jest dopuszczalny.
    const active = (txCount === undefined && node.more) || (txCount !== undefined && txCount > options.maxNodeTxCount);
    const stopActive = () => {
      stops.add(STOP.activity(txCount, options.maxNodeTxCount));
      const first = state.hops[0]!;
      questions.push({
        txid: first.txid,
        text:
          `${formatAmount(carried)} ${asset} z przelewu ${first.txid} (${first.time.slice(0, 10)}) trafiło na adres ${current} ` +
          `o ${txCount ?? 'co najmniej kilkudziesięciu'} transakcjach — prawdopodobnie usługa bez publicznej etykiety (giełda, kantor, pośrednik). ` +
          'Ustalenie, do kogo należy ten adres, wskazałoby, gdzie środki mogły zostać spieniężone.',
      });
      return false;
    };

    const sentAt = Date.parse(since);
    const windowEnd = sentAt + options.windowHours * 3_600_000;
    const forwards = node.outgoing
      .filter((item) => {
        const time = Date.parse(item.time);
        const party = normalizeAddress(item.counterparty);
        return (
          item.direction === 'out' && item.asset === asset && time >= sentAt && time <= windowEnd && item.txid !== lastTxid && party !== subject && !visited.has(party) && available(item) > 0
        );
      })
      .sort((a, b) => available(b) - available(a));
    if (forwards.length === 0) {
      if (active) return stopActive();
      stops.add(STOP.unspent);
      return false;
    }
    const pageOut = node.outgoing.filter((item) => item.direction === 'out' && item.asset === asset);
    await labelDestinations(active ? [...forwards, ...pageOut.filter((item) => !forwards.includes(item))] : forwards);

    // Grupujemy przekazania według odbiorcy.
    const groups = new Map<string, { transfers: RawTransfer[]; total: number; known: Classification }>();
    for (const forward of forwards) {
      const id = normalizeAddress(forward.counterparty);
      const group = groups.get(id) ?? { transfers: [], total: 0, known: describe(forward) };
      group.transfers.push(forward);
      group.total += available(forward);
      groups.set(id, group);
    }
    const ordered = [...groups.values()].sort((a, b) => b.total - a.total);
    const forwardedTotal = ordered.reduce((sum, group) => sum + group.total, 0);

    const toServices = ordered.filter((group) => serviceOf(group.known, labels));
    const serviceTotal = toServices.reduce((sum, group) => sum + group.total, 0);
    let exclusive = '';
    if (active) {
      const main = toServices[0] ? serviceOf(toServices[0].known, labels) : undefined;
      const entity = (name: string) => matchService(name)?.name ?? name;
      const pageTotal = pageOut.reduce((sum, item) => sum + item.amount, 0);
      const toSame = pageOut.filter((item) => {
        const service = serviceOf(describe(item), labels);
        return service && main && entity(service.name) === entity(main.name);
      });
      const sameTotal = toSame.reduce((sum, item) => sum + item.amount, 0);
      if (!main || pageOut.length < 3 || sameTotal < pageTotal * EXCLUSIVE_SHARE || toSame.length < pageOut.length * EXCLUSIVE_SHARE) return stopActive();
      exclusive =
        `; adres ma dużą aktywność (${txCount ?? 'co najmniej pełna strona historii'} transakcji), ale ${toSame.length} z ${pageOut.length} ` +
        `ostatnich przelewów wychodzących trafia do tej samej giełdy — wzorzec adresu wpłat intensywnie używanego konta`;
    }
    if (toServices.length > 0 && serviceTotal >= carried * options.minForwardedShare) {
      const main = toServices[0]!;
      const service = serviceOf(main.known, labels)!;
      const transfer = main.transfers[0]!;
      const first = main.transfers.reduce((best, item) => (Date.parse(item.time) < Date.parse(best.time) ? item : best));
      const hours = hoursBetween(since, first.time);
      const firstIntermediate = state.steps.every((step) => step === 'swap');
      const step: TrailStep = firstIntermediate && service.kind === 'exchange_deposit' ? 'deposit_sweep' : 'passthrough';
      const share = Math.round((serviceTotal / carried) * 100);
      const amount = Math.min(carried, main.total);
      // Wcześniejsze przekazania przypisujemy tej wpłacie w pierwszej kolejności.
      consume([...main.transfers].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), amount);
      const hop = hopOf(current, transfer, main.known, {
        amount: round8(amount),
        inferred: true,
        reason:
          step === 'deposit_sweep'
            ? `adres ${short(current)} bez publicznej etykiety przekazał środki (${share}% otrzymanej kwoty) do portfela giełdy „${service.name}” po ${formatHours(hours)} h — prawdopodobny indywidualny adres wpłat klienta giełdy (reguła: zamiecenie adresu wpłat)${exclusive}`
            : `adres ${short(current)} przekazał ${share}% otrzymanej kwoty do usługi „${service.name}” po ${formatHours(hours)} h (reguła: adres przelotowy)${exclusive}`,
      });
      const hops = [...state.hops, hop];
      const steps = [...state.steps, step];
      trails.push(
        buildTrail({ network, sourceAddress: search.address, hops, steps, changeHeuristics: [], service, originAmount: state.originAmount, leftAt: state.leftAt, amount }),
      );
      if (step === 'deposit_sweep' && hops.length === 2) {
        deposits.push({
          txid: hops[0]!.txid,
          counterparty: current,
          asset,
          exchangeAddress: transfer.counterparty,
          exchangeLabel: service.name,
          exchangeLabelSource: service.source,
          hoursToForward: Math.round(hours * 10) / 10,
          forwardedAmount: round8(serviceTotal),
          forwardedShare: Math.round((serviceTotal / carried) * 100) / 100,
          forwardTxid: transfer.txid,
        });
      }
      return true;
    }

    if (active) return stopActive();
    const top = ordered[0]!;
    if (top.known.addressClass === 'mixer') {
      stops.warn(mixerWarning(top.transfers[0]!.counterparty, top.known.label, top.transfers[0]!.txid));
      return false;
    }
    if (forwardedTotal < carried * options.minForwardedShare) {
      stops.add(STOP.unspent);
      return false;
    }
    if (top.known.addressClass === 'smart_contract') {
      stops.add(STOP.contract);
      return false;
    }
    if (top.known.addressClass !== 'unknown' || top.known.label) {
      stops.add(STOP.labelled);
      return false;
    }
    if (top.total < carried * options.minForwardedShare) {
      stops.add(STOP.split);
      return false;
    }
    // Reguła (a): adres przelotowy — niemal cała kwota poszła do jednego odbiorcy.
    const transfer = top.transfers[0]!;
    const hours = hoursBetween(since, transfer.time);
    const amount = Math.min(carried, top.total);
    consume([...top.transfers].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)), amount);
    const hop = hopOf(current, transfer, top.known, {
      amount: round8(amount),
      inferred: true,
      reason:
        `adres ${short(current)} w ciągu ${formatHours(hours)} h przekazał dalej ${Math.round((top.total / carried) * 100)}% otrzymanej kwoty ` +
        `(${top.transfers.length} przelew/y do jednego odbiorcy) — reguła: adres przelotowy`,
    });
    return walk(
      transfer.counterparty,
      asset,
      amount,
      transfer.time,
      transfer.txid,
      { ...state, hops: [...state.hops, hop], steps: [...state.steps, 'passthrough'] },
      new Set([...visited, normalizeAddress(current)]),
    );
  }

  // Reguła (d): zamiana na stablecoin w kontrakcie, po której stablecoin idzie dalej.
  const ordered = [...search.transfers].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const usedStarts = new Set<RawTransfer>();
  interface Start {
    transfer: RawTransfer;
    prefix: FlowHop[];
    steps: TrailStep[];
    originAmount: number;
    leftAt: string;
    weight: number;
  }
  const starts: Start[] = [];
  const usedInflows = new Set<RawTransfer>();
  for (const swapOut of ordered) {
    if (swapOut.direction !== 'out' || STABLECOINS.has(swapOut.asset.toUpperCase()) || ORDER_WEIGHTS[swapOut.asset.toUpperCase()] === undefined) continue;
    const target = describe(swapOut);
    if (target.addressClass !== 'smart_contract' && target.kind !== 'stablecoin_swap') continue;
    const swapAt = Date.parse(swapOut.time);
    const inflow = ordered.find((item) => {
      if (item.direction !== 'in' || !STABLECOINS.has(item.asset.toUpperCase()) || usedInflows.has(item)) return false;
      const delay = Date.parse(item.time) - swapAt;
      return item.txid === swapOut.txid || (delay >= 0 && delay <= SWAP_SAME_TX_WINDOW_MS);
    });
    if (!inflow) continue;
    const inflowAt = Date.parse(inflow.time);
    const onward = ordered.find((item) => {
      if (item.direction !== 'out' || item.asset !== inflow.asset || usedStarts.has(item)) return false;
      const delay = Date.parse(item.time) - inflowAt;
      return delay >= 0 && delay <= options.swapForwardHours * 3_600_000 && item.amount >= inflow.amount * options.minForwardedShare && item.amount <= inflow.amount * 1.02;
    });
    if (!onward) continue;
    usedInflows.add(inflow);
    usedStarts.add(onward);
    const onwardKnown = describe(onward);
    starts.push({
      transfer: onward,
      prefix: [
        hopOf(search.address, swapOut, target, {
          reason:
            `zamiana na stablecoin: ${formatAmount(swapOut.amount)} ${swapOut.asset} wysłano do kontraktu wymiany` +
            `${target.label ? ` „${target.label}”` : ''}, a na adres wpłynęło ${formatAmount(inflow.amount)} ${inflow.asset}` +
            `${inflow.txid === swapOut.txid ? ' w tej samej transakcji' : ' w ciągu kilkudziesięciu minut'}`,
        }),
        hopOf(search.address, onward, onwardKnown, {
          inferred: true,
          reason:
            `po ${formatHours(hoursBetween(inflow.time, onward.time))} h od zamiany z adresu wyszło ${formatAmount(onward.amount)} ${onward.asset} ` +
            `(${Math.round((onward.amount / inflow.amount) * 100)}% kwoty z zamiany) — reguła: stablecoin z zamiany przekazany dalej`,
        }),
      ],
      steps: ['swap'],
      originAmount: onward.amount,
      leftAt: onward.time,
      weight: Number.MAX_SAFE_INTEGER,
    });
  }

  // Kandydaci zwykli: odbiorcy przelewów wychodzących, o których nic nie wiadomo.
  const byCounterparty = new Map<string, { weight: number; transfers: RawTransfer[] }>();
  for (const transfer of search.transfers) {
    if (transfer.direction !== 'out' || usedStarts.has(transfer) || !isQueryableAddress(transfer.counterparty)) continue;
    if (normalizeAddress(transfer.counterparty) === subject) continue;
    const weight = ORDER_WEIGHTS[transfer.asset.toUpperCase()];
    if (weight === undefined || transfer.amount <= 0) continue;
    const known = describe(transfer);
    if (known.addressClass === 'mixer') {
      stops.warn(mixerWarning(transfer.counterparty, known.label, transfer.txid));
      continue;
    }
    if (known.addressClass !== 'unknown' || known.label || known.kind) continue;
    const group = byCounterparty.get(transfer.counterparty) ?? { weight: 0, transfers: [] };
    group.weight = Math.max(group.weight, transfer.amount * weight);
    group.transfers.push(transfer);
    byCounterparty.set(transfer.counterparty, group);
  }
  const candidates = [...byCounterparty.entries()].sort((a, b) => b[1].weight - a[1].weight);
  const selected = candidates.slice(0, options.maxCandidates);
  const weightOf = (list: typeof candidates) =>
    list.reduce((sum, [, group]) => sum + group.transfers.reduce((part, item) => part + item.amount * ORDER_WEIGHTS[item.asset.toUpperCase()]!, 0), 0);
  const coverage = candidates.length > selected.length && weightOf(candidates) > 0 ? Math.round((weightOf(selected) / weightOf(candidates)) * 100) : 100;

  for (const start of starts) {
    if (stoppedBy) break;
    const last = start.prefix.at(-1)!;
    const known = describe(start.transfer);
    const service = serviceOf(known, labels);
    if (service) {
      trails.push(
        buildTrail({ network, sourceAddress: search.address, hops: start.prefix, steps: start.steps, changeHeuristics: [], service, originAmount: start.originAmount, leftAt: start.leftAt, amount: last.amount }),
      );
      continue;
    }
    if (known.addressClass !== 'unknown' || known.label || !isQueryableAddress(start.transfer.counterparty)) continue;
    await walk(start.transfer.counterparty, start.transfer.asset, start.transfer.amount, start.transfer.time, start.transfer.txid, { hops: start.prefix, steps: start.steps, originAmount: start.originAmount, leftAt: start.leftAt }, new Set());
  }

  let examined = 0;
  for (const [counterparty, group] of selected) {
    if (stoppedBy) break;
    if (budget.remaining === 0 && ![...expanded.keys()].some((key) => key.startsWith(`${normalizeAddress(counterparty)}|`))) {
      budgetStop();
      break;
    }
    // Największe przelewy do tego kontrahenta (w dowolnej walucie), badane od najstarszego —
    // wcześniejsza wpłata pierwsza „zajmuje” późniejsze zamiecenie.
    const value = (item: RawTransfer) => item.amount * ORDER_WEIGHTS[item.asset.toUpperCase()]!;
    const largest = [...group.transfers]
      .sort((a, b) => value(b) - value(a))
      .slice(0, MAX_TRANSFERS_PER_CANDIDATE)
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    for (const transfer of largest) {
      if (stoppedBy) break;
      const hop = hopOf(search.address, transfer, describe(transfer));
      await walk(counterparty, transfer.asset, transfer.amount, transfer.time, transfer.txid, { hops: [hop], steps: [], originAmount: transfer.amount, leftAt: transfer.time }, new Set());
    }
    if ([...expanded.keys()].some((key) => key.startsWith(`${normalizeAddress(counterparty)}|`))) examined += 1;
  }

  const limitations = stops.limitations();
  if (stoppedBy) {
    limitations.push(
      `Śledzenie dalszej drogi środków przerwano: ${stoppedBy}. Sprawdzono ${examined} z ` +
        `${candidates.length} kontrahentów bez etykiety — pozostałe przelewy mogły prowadzić na giełdę.`,
    );
  } else if (candidates.length > selected.length) {
    limitations.push(
      `Dalszą drogę środków sprawdzono tylko dla ${selected.length} z ${candidates.length} kontrahentów bez etykiety ` +
        `(odbiorcy największych przelewów; ok. ${coverage}% wartości wypływów do adresów bez etykiety, liczone zgrubnymi wagami walut) — ` +
        'pozostałe przelewy mogły prowadzić na giełdę.',
    );
  }
  if (deposits.length > 0) {
    limitations.push(
      `Wskaźniki „prawdopodobny adres wpłat na giełdę” (${deposits.length}) są WNIOSKOWANIEM z dalszej drogi środków ` +
        `(okno ${options.windowHours} h, co najmniej ${Math.round(options.minForwardedShare * 100)}% kwoty przekazane na adres ` +
        'oznaczony jako giełda). Adres pośredni może należeć do innej osoby lub usługi — potwierdzenie wymaga danych giełdy.',
    );
  }
  limitations.push(...traceSummary(trails, options));
  return { trails, deposits, limitations, openQuestions: questions };
}

// ---------- Model UTXO: Bitcoin ----------

export interface UtxoTraceSearch {
  network: Network;
  address: string;
  /** Pobrane transakcje badanego adresu. */
  txs: UtxoTx[];
  labels: LabelSet;
  sourceName: string;
  budget: RequestBudget;
  options?: TraceOptions;
  /** Etykiety portfeli (WalletExplorer); każde nowe pytanie zużywa budżet. */
  lookup?: LabelLookup;
  /** Transakcje adresu (jedna strona historii) — jedno żądanie. */
  fetchTxs(address: string): Promise<UtxoTx[]>;
  /** Liczba transakcji adresu — jedno żądanie; pytamy tylko przy pełnej stronie historii. */
  fetchTxCount(address: string): Promise<number | undefined>;
  txUrl(txid: string): string;
  /** Rozmiar strony historii w API (Esplora: 25). */
  pageSize?: number;
  signal?: AbortSignal;
}

export interface UtxoTraceResult extends TraceResult {
  /** Adresy uznane heurystycznie za należące do portfela podmiotu. */
  clusterAddresses: { address: string; reason: string; txid?: string }[];
}

const SATOSHI = 1e8;
const txTime = (tx: UtxoTx) => new Date((tx.status?.block_time ?? 0) * 1000).toISOString();
const MAX_CLUSTER_SPENDS = 3;

export async function traceUtxoFlows(search: UtxoTraceSearch): Promise<UtxoTraceResult> {
  const options = { ...DEFAULT_TRACE_OPTIONS, ...search.options };
  const { network, labels, budget } = search;
  const pageSize = search.pageSize ?? 25;
  const trails: TracedTrail[] = [];
  const deposits: InferredDeposit[] = [];
  const stops = new StopLog();
  const clusterAddresses: UtxoTraceResult['clusterAddresses'] = [];
  const own = new Set<string>([search.address]);

  // Heurystyka wspólnych wejść działa na już pobranych transakcjach — bez dodatkowych żądań.
  for (const item of commonInputAddresses(search.txs, search.address)) {
    if (clusterAddresses.length >= options.clusterLimit) break;
    own.add(item.address);
    clusterAddresses.push({
      address: item.address,
      txid: item.txid,
      reason: `heurystyka wspólnych wejść: środki tego adresu wydano razem ze środkami adresu podmiotu w transakcji ${item.txid}`,
    });
  }
  const questions: TraceResult['openQuestions'] = [];
  if (!options.enabled) return { trails, deposits, limitations: [], clusterAddresses, openQuestions: questions };

  let stoppedBy: string | undefined;
  let lookupBroken = false;
  const resolved = new Map<string, Classification>();
  const UNKNOWN: Classification = { addressClass: 'unknown', classificationSource: 'brak danych o adresie' };

  /** Klasyfikacja adresu: zbiór etykiet, potem serwis etykiet portfeli (w budżecie). */
  async function resolve(address: string): Promise<Classification> {
    const cached = resolved.get(address);
    if (cached) return cached;
    let known = classify(network, address, { labels });
    if (known.addressClass === 'unknown' && !known.label && search.lookup && !lookupBroken && isQueryableAddress(address)) {
      if (!search.lookup.cached?.(address) && !budget.take()) {
        stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
        return UNKNOWN;
      }
      try {
        const label = await search.lookup.lookup(address, search.signal);
        if (label) known = classify(network, address, { labels, sourceLabel: label, sourceName: search.lookup.sourceName });
      } catch (error) {
        if (search.signal?.aborted) throw error;
        lookupBroken = true;
        stops.warn(`${search.lookup.sourceName}: nie udało się sprawdzić etykiety adresu ${address} (${error instanceof Error ? error.message : String(error)}) — dalsze etykiety tego serwisu pominięto.`);
      }
    }
    resolved.set(address, known);
    return known;
  }

  const fetched = new Map<string, UtxoTx[] | null>();
  async function history(address: string): Promise<UtxoTx[] | null> {
    if (fetched.has(address)) return fetched.get(address)!;
    if (!budget.take()) {
      stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
      return null;
    }
    try {
      const txs = (await search.fetchTxs(address)).filter((tx) => tx.status?.confirmed);
      fetched.set(address, txs);
      return txs;
    } catch (error) {
      if (search.signal?.aborted) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      if (error instanceof ChainProviderError && (error.code === 'rate_limited' || error.code === 'timeout')) {
        stoppedBy = `błąd źródła danych — ${reason}`;
      } else {
        stops.warn(`Nie udało się sprawdzić dalszej drogi środków z adresu ${address}: ${reason}`);
        stops.add(STOP.error);
      }
      fetched.set(address, null);
      return null;
    }
  }

  const activity = new Map<string, number | undefined>();

  /** Skąd pochodzą środki na badanej gałęzi: transakcja wypływu z portfela i udział gałęzi w jej wartości. */
  interface Origin {
    txid: string;
    time: string;
    percent: number;
  }

  /** `true`, gdy adres pośredni ma zbyt dużą aktywność, by go śledzić; zapisuje pytanie, dokąd trafiły środki. */
  async function tooActive(address: string, txs: UtxoTx[], origin?: Origin, satoshi?: number): Promise<boolean> {
    if (txs.length < pageSize) return false;
    if (!activity.has(address)) {
      // Bez budżetu na sprawdzenie liczby transakcji nie przesądzamy, że to usługa — przerywamy śledzenie.
      if (!budget.take()) {
        stoppedBy = `wyczerpano budżet ${budget.limit} żądań na jedną analizę adresu`;
        return true;
      }
      try {
        activity.set(address, await search.fetchTxCount(address));
      } catch (error) {
        if (search.signal?.aborted) throw error;
        activity.set(address, undefined);
      }
    }
    const count = activity.get(address);
    if (count !== undefined && count <= options.maxNodeTxCount) return false;
    stops.add(STOP.activity(count, options.maxNodeTxCount));
    if (origin) {
      questions.push({
        txid: origin.txid,
        text:
          `${origin.percent}% wartości wypływu ${origin.txid} (${origin.time.slice(0, 10)}${satoshi ? `; ${satoshi / SATOSHI} BTC` : ''}) trafiło na adres ${address} ` +
          `o ${count ?? `co najmniej ${pageSize}`} transakcjach — prawdopodobnie usługa bez publicznej etykiety (giełda, kantor, mikser). ` +
          'Ustalenie, do kogo należy ten adres, wskazałoby, gdzie środki mogły zostać spieniężone.',
      });
    }
    return true;
  }

  const hop = (tx: UtxoTx, from: string, to: string, satoshi: number, known: Classification, extra: Partial<FlowHop> = {}): FlowHop => ({
    txid: tx.txid,
    time: txTime(tx),
    from,
    to,
    asset: 'BTC',
    amount: satoshi / SATOSHI,
    ...(known.label ? { toLabel: known.label } : {}),
    toClass: known.addressClass,
    explorerUrl: search.txUrl(tx.txid),
    ...extra,
  });

  interface PathState {
    hops: FlowHop[];
    steps: TrailStep[];
    changeHeuristics: number[];
  }
  /**
   * Transakcja wydająca wyjście `fund:index` adresu. Gdy źródło nie podaje, które wyjście
   * wydaje wejście, bierzemy najwcześniejszą późniejszą transakcję wydającą środki tego adresu.
   */
  const spendOf = (txs: UtxoTx[], fund: UtxoTx, index: number, address: string) => {
    const exact = txs.find((tx) => (tx.vin ?? []).some((input) => input.txid === fund.txid && input.vout === index));
    if (exact) return exact;
    return txs
      .filter(
        (tx) =>
          tx.txid !== fund.txid &&
          (tx.status?.block_time ?? 0) >= (fund.status?.block_time ?? 0) &&
          (tx.vin ?? []).some((input) => input.txid === undefined && input.prevout?.scriptpubkey_address === address),
      )
      .sort((a, b) => (a.status?.block_time ?? 0) - (b.status?.block_time ?? 0))[0];
  };

  function finish(state: PathState, service: Service, satoshi: number, originSatoshi: number, leftAt: string): void {
    const draft = { network, sourceAddress: search.address, hops: state.hops, steps: state.steps, changeHeuristics: state.changeHeuristics, service, originAmount: originSatoshi / SATOSHI, leftAt, amount: satoshi / SATOSHI };
    const trail = buildTrail(draft);
    if (trails.some((item) => item.id === trail.id)) return;
    trails.push(trail);
    if (state.steps.length === 1 && state.steps[0] === 'deposit_sweep' && state.hops.length === 2) {
      const [first, last] = state.hops as [FlowHop, FlowHop];
      deposits.push({
        txid: first.txid,
        counterparty: first.to,
        asset: 'BTC',
        exchangeAddress: last.to,
        exchangeLabel: service.name,
        exchangeLabelSource: service.source,
        hoursToForward: Math.round(hoursBetween(first.time, last.time) * 10) / 10,
        forwardedAmount: last.amount,
        forwardedShare: Math.round((last.amount / first.amount) * 100) / 100,
        forwardTxid: last.txid,
      });
    }
  }

  /** Reguły (a) i (c): adres pośredni, który otrzymał wyjście `fundTx:index`. */
  async function follow(address: string, fundTx: UtxoTx, index: number, satoshi: number, state: PathState, originSatoshi: number, leftAt: string, visited: Set<string>, origin: Origin): Promise<void> {
    if (stoppedBy) return;
    if (state.hops.length >= options.maxHops) return stops.add(STOP.depth);
    const txs = await history(address);
    if (!txs) return;
    if (await tooActive(address, txs, origin, satoshi)) return;
    const spend = spendOf(txs, fundTx, index, address);
    const since = txTime(fundTx);
    if (!spend || hoursBetween(since, txTime(spend)) > options.utxoHoldHours) return stops.add(STOP.unspent);
    if (looksLikeCoinJoin(spend)) return stops.warn(mixerWarning(address, undefined, spend.txid));

    const outputs = (spend.vout ?? [])
      .map((output, position) => ({ output, position }))
      .filter(({ output }) => output.scriptpubkey_address && output.value && output.scriptpubkey_address !== address && !visited.has(output.scriptpubkey_address))
      .sort((a, b) => (b.output.value ?? 0) - (a.output.value ?? 0));
    const otherInputs = new Set((spend.vin ?? []).map((input) => input.prevout?.scriptpubkey_address).filter((a) => a && a !== address)).size;
    const merged = otherInputs > 0 ? `; transakcja łączy też środki z ${otherInputs} innych adresów` : '';
    const hours = formatHours(hoursBetween(since, txTime(spend)));

    const partial = new Set<string>();
    for (const { output } of outputs.slice(0, 2)) {
      const to = output.scriptpubkey_address!;
      const known = await resolve(to);
      const service = serviceOf(known, labels);
      if (service) {
        const firstIntermediate = state.steps.length === 0;
        const quickSweep = hoursBetween(since, txTime(spend)) <= options.windowHours && output.value! >= satoshi * options.minForwardedShare;
        const step: TrailStep = firstIntermediate && quickSweep && service.kind === 'exchange_deposit' ? 'deposit_sweep' : 'passthrough';
        const amount = Math.min(satoshi, output.value!);
        const part = (amount / satoshi) * 100;
        const percent = part >= 1 ? `${Math.round(part)}%` : `${part.toLocaleString('pl-PL', { maximumFractionDigits: 2 })}%`;
        const reason =
          step === 'deposit_sweep'
            ? `adres ${short(address)} bez publicznej etykiety został po ${hours} h zamieciony do portfela giełdy „${service.name}” — prawdopodobny indywidualny adres wpłat klienta giełdy (reguła: zamiecenie adresu wpłat)${merged}`
            : `adres ${short(address)} po ${hours} h wydał otrzymane wyjście, przekazując ${percent} jego kwoty do usługi „${service.name}” ` +
              `(reguła: adres przelotowy; powiązanie ścisłe — wydano dokładnie to wyjście` +
              `${part < options.minForwardedShare * 100 ? '; do usługi trafiła tylko CZĘŚĆ środków — reszta poszła dalej' : ''})${merged}`;
        finish(
          { ...state, hops: [...state.hops, hop(spend, address, to, amount, known, { inferred: true, reason })], steps: [...state.steps, step] },
          service,
          amount,
          originSatoshi,
          leftAt,
        );
        // Gdy do usługi trafiła niemal całość, ścieżka jest zamknięta; przy drobnej płatności idziemy dalej za resztą.
        if (output.value! >= satoshi * options.minForwardedShare) return;
        partial.add(to);
        continue;
      }
      if (known.addressClass === 'mixer') return stops.warn(mixerWarning(to, known.label, spend.txid));
      if (stoppedBy) return;
    }

    const top = outputs.find(({ output }) => !partial.has(output.scriptpubkey_address!));
    if (!top || top.output.value! < satoshi * options.minForwardedShare) return stops.add(outputs.length > 0 ? STOP.split : STOP.unspent);
    const to = top.output.scriptpubkey_address!;
    const amount = Math.min(satoshi, top.output.value!);
    const reason = `adres ${short(address)} po ${hours} h przekazał dalej ${Math.round((top.output.value! / satoshi) * 100)}% otrzymanej kwoty jednym wyjściem — reguła: adres przelotowy${merged}`;
    await follow(
      to,
      spend,
      top.position,
      amount,
      { ...state, hops: [...state.hops, hop(spend, address, to, amount, UNKNOWN, { inferred: true, reason })], steps: [...state.steps, 'passthrough'] },
      originSatoshi,
      leftAt,
      new Set([...visited, address]),
      origin,
    );
  }

  const processed = new Set<string>();

  /**
   * Transakcja wydająca środki portfela podmiotu (adresu podmiotu, adresu z klastra
   * albo adresu reszty): płatności sprawdzamy pod kątem usług, resztę śledzimy dalej (reguła b).
   */
  async function ownSpend(tx: UtxoTx, from: string, state: PathState): Promise<void> {
    if (stoppedBy || processed.has(tx.txid)) return;
    processed.add(tx.txid);
    if (looksLikeCoinJoin(tx)) return stops.warn(mixerWarning(from, undefined, tx.txid));
    const change = detectChange(tx, own);
    const outputs = (tx.vout ?? [])
      .map((output, position) => ({ output, position }))
      .filter(({ output }) => output.scriptpubkey_address && output.value);
    const payments = outputs
      .filter(({ output, position }) => position !== change?.changeIndex && !own.has(output.scriptpubkey_address!))
      .sort((a, b) => (b.output.value ?? 0) - (a.output.value ?? 0));
    const leftAt = txTime(tx);
    // Gdy transakcję współfinansują inne adresy, adresowi przypisujemy najwyżej jego własny wkład.
    const contributed = (tx.vin ?? []).filter((input) => input.prevout?.scriptpubkey_address === from).reduce((sum, input) => sum + (input.prevout?.value ?? 0), 0);
    const coFunded = (tx.vin ?? []).some((input) => input.prevout?.scriptpubkey_address !== from);

    // Każde istotne wyjście (nie tylko największe) jest osobną gałęzią — do limitu gałęzi.
    const paid = payments.reduce((sum, { output }) => sum + (output.value ?? 0), 0);
    const branches = payments.filter(({ output }, rank) => rank < 2 || (output.value ?? 0) >= paid * options.minBranchShare).slice(0, Math.max(2, options.maxBranches));
    if (payments.length > branches.length) {
      const skipped = payments.slice(branches.length).reduce((sum, { output }) => sum + (output.value ?? 0), 0);
      if (skipped >= paid * options.minBranchShare) stops.add(`pominięto mniejsze wyjścia transakcji wypływu ponad limit ${options.maxBranches} gałęzi`);
    }
    let followed = 0;
    for (const { output, position } of branches) {
      if (stoppedBy) return;
      const to = output.scriptpubkey_address!;
      const known = await resolve(to);
      const service = serviceOf(known, labels);
      const share = coFunded && contributed > 0 ? Math.min(output.value!, contributed) : output.value!;
      const notes = [
        ...(state.hops.length === 0 && state.steps.includes('cluster') ? [`przelew z adresu ${short(from)} uznanego za należący do portfela podmiotu (heurystyka wspólnych wejść)`] : []),
        ...(share < output.value! ? [`transakcję współfinansują inne adresy — adresowi przypisano jego wkład (${share / SATOSHI} BTC z ${output.value! / SATOSHI} BTC wyjścia)`] : []),
      ];
      const paymentHop = hop(tx, from, to, share, known, notes.length > 0
        ? { ...(state.steps.includes('cluster') && state.hops.length === 0 ? { inferred: true } : {}), reason: notes.join('; ') }
        : {});
      const next = { ...state, hops: [...state.hops, paymentHop] };
      if (service) {
        finish(next, service, share, share, leftAt);
        continue;
      }
      if (known.addressClass === 'mixer') {
        stops.warn(mixerWarning(to, known.label, tx.txid));
        continue;
      }
      if (followed < options.maxBranches && known.addressClass === 'unknown' && !known.label) {
        followed += 1;
        const origin = { txid: state.hops[0]?.txid ?? tx.txid, time: state.hops[0]?.time ?? leftAt, percent: paid > 0 ? Math.round((output.value! / paid) * 100) : 100 };
        await follow(to, tx, position, output.value!, next, output.value!, leftAt, new Set([from]), origin);
      }
    }

    if (!change || stoppedBy) return;
    const changeAddress = change.changeAddress;
    if (own.has(changeAddress)) return;
    if (state.hops.length + 1 >= options.maxHops) return stops.add(STOP.depth);
    if (clusterAddresses.length < options.clusterLimit) {
      clusterAddresses.push({ address: changeAddress, txid: tx.txid, reason: `heurystyka adresu reszty w transakcji ${tx.txid}: ${change.heuristics.join('; ')}` });
    }
    own.add(changeAddress);
    const changeOutput = tx.vout![change.changeIndex]!;
    const txs = await history(changeAddress);
    if (!txs) return;
    const heuristics = [...change.heuristics];
    // Trzecia przesłanka: adres reszty nie był wcześniej używany.
    if (txs.length < pageSize && txs.every((item) => (item.status?.block_time ?? 0) >= (tx.status?.block_time ?? 0))) {
      heuristics.push('adres nie był wcześniej używany');
    }
    const spend = spendOf(txs, tx, change.changeIndex, changeAddress);
    if (!spend) return stops.add('reszta nie została jeszcze wydana (lub wydano ją poza pobraną historią)');
    const changeHop = hop(tx, from, changeAddress, changeOutput.value!, UNKNOWN, {
      inferred: true,
      reason: `adres ${short(changeAddress)} uznany za resztę wracającą do portfela podmiotu (heurystyki: ${heuristics.join('; ')}) — reguła: łańcuch reszty`,
    });
    await ownSpend(spend, changeAddress, {
      hops: [...state.hops, changeHop],
      steps: [...state.steps, 'change'],
      changeHeuristics: [...state.changeHeuristics, heuristics.length],
    });
  }

  const externalValue = (tx: UtxoTx) =>
    (tx.vout ?? []).filter((output) => output.scriptpubkey_address && !own.has(output.scriptpubkey_address)).reduce((sum, output) => sum + (output.value ?? 0), 0);
  const spendsFrom = (txs: UtxoTx[], address: string) =>
    txs
      .filter((tx) => tx.status?.confirmed && (tx.vin ?? []).some((input) => input.prevout?.scriptpubkey_address === address))
      .sort((a, b) => externalValue(b) - externalValue(a));

  // Do śledzenia wybieramy NAJWIĘKSZE wartościowo wypływy w analizowanym zakresie, nie najnowsze.
  const subjectSpends = spendsFrom(search.txs, search.address);
  const selected = subjectSpends.slice(0, options.maxCandidates);
  const inflowCount = search.txs.filter((tx) => tx.status?.confirmed && !(tx.vin ?? []).some((input) => input.prevout?.scriptpubkey_address === search.address)).length;
  const outflowTotal = subjectSpends.reduce((sum, tx) => sum + externalValue(tx), 0);
  const selectedTotal = selected.reduce((sum, tx) => sum + externalValue(tx), 0);
  let examined = 0;
  for (const tx of selected) {
    if (stoppedBy) break;
    await ownSpend(tx, search.address, { hops: [], steps: [], changeHeuristics: [] });
    if (!stoppedBy) examined += 1;
  }

  // Wypłaty z pozostałych adresów portfela (wspólne wejścia) — często to z nich idzie wpłata na giełdę.
  const coInput = clusterAddresses.filter((item) => item.reason.startsWith('heurystyka wspólnych wejść'));
  let clusterExamined = 0;
  for (const member of coInput) {
    if (stoppedBy) break;
    const txs = await history(member.address);
    if (!txs) continue;
    clusterExamined += 1;
    if (await tooActive(member.address, txs)) {
      member.reason += ' — UWAGA: adres ma bardzo dużą aktywność, więc może należeć do usługi lub pochodzić z transakcji wspólnej; przynależność do portfela podmiotu jest wątpliwa';
      continue;
    }
    // Transakcje, w których wydawane są też środki adresu podmiotu, to jego własne wypływy — nie liczymy ich drugi raz z adresu klastra.
    const subjectIsInput = (item: UtxoTx) => (item.vin ?? []).some((input) => input.prevout?.scriptpubkey_address === search.address);
    for (const tx of spendsFrom(txs, member.address).filter((item) => !processed.has(item.txid) && !subjectIsInput(item)).slice(0, MAX_CLUSTER_SPENDS)) {
      if (stoppedBy) break;
      await ownSpend(tx, member.address, { hops: [], steps: ['cluster'], changeHeuristics: [] });
    }
  }

  const limitations = stops.limitations();
  if (stoppedBy) {
    limitations.push(
      `Śledzenie dalszej drogi środków przerwano: ${stoppedBy}. Sprawdzono ${examined} z ${subjectSpends.length} transakcji wychodzących ` +
        `adresu oraz ${clusterExamined} z ${coInput.length} pozostałych adresów portfela — reszta mogła prowadzić na giełdę.`,
    );
  } else if (subjectSpends.length > selected.length) {
    limitations.push(
      `Dalszą drogę środków sprawdzono dla ${selected.length} z ${subjectSpends.length} transakcji wychodzących (największe kwoty) — ` +
        'pozostałe mogły prowadzić na giełdę.',
    );
  }
  if (subjectSpends.length > 0) {
    limitations.push(
      `Wypływy z adresu w analizowanym zakresie: ${subjectSpends.length} transakcji wychodzących na łącznie ${round8(outflowTotal / SATOSHI)} BTC do obcych adresów ` +
        `(przy ${inflowCount} transakcjach przychodzących). Do śledzenia wybrano ${selected.length} największych wartościowo — ` +
        `${outflowTotal > 0 ? Math.round((selectedTotal / outflowTotal) * 100) : 100}% wartości wypływów` +
        (stoppedBy ? `, z czego faktycznie zbadano ${examined}.` : '.'),
    );
  }
  if (deposits.length > 0) {
    limitations.push(
      `Wskaźniki „prawdopodobny adres wpłat na giełdę” (${deposits.length}) są WNIOSKOWANIEM z dalszej drogi środków ` +
        `(zamiecenie niemal całej kwoty w oknie ${options.windowHours} h). Adres pośredni może należeć do innej osoby lub usługi — potwierdzenie wymaga danych giełdy.`,
    );
  }
  if (trails.some((trail) => trail.reasons.some((reason) => reason.includes('heurystyka wspólnych wejść')))) {
    limitations.push(
      'Część ścieżek zaczyna się od innych adresów portfela ustalonych HEURYSTYKĄ wspólnych wejść — jeśli adres nie należy do podmiotu, ścieżka go nie dotyczy.',
    );
  }
  limitations.push(...traceSummary(trails, options));
  return { trails, deposits, limitations, clusterAddresses, openQuestions: questions };
}
