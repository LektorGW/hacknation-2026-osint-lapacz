// Obieg środków („ping-pong”, round-trip, warstwowanie): środki wychodzą z badanego adresu (albo jego portfela)
// i po 1..N adresach pośrednich wracają na ten sam adres, inny adres tego portfela albo inny adres sprawy.
//
// Dwa etapy:
//   1. Bezpośredni ping-pong A→B→A — z przelewów samego adresu, bez żadnych zapytań (także powtarzany).
//   2. Przeszukiwanie wszerz po przelewach wychodzących (na żądanie, „Szukaj dalej”): tylko największe udziały
//      kwoty na każdym kroku, bez drobnych kwot, bez powrotu na ścieżce, każdy adres pobierany najwyżej raz,
//      w oknie czasu od pierwszego przelewu; usługi (giełda, mikser, kontrakt) kończą gałąź — gdy z tej samej
//      usługi środki wracają na adres, obieg jest zapisany jako HIPOTEZA (usługi mieszają środki klientów).
//
// Zasada uczciwości: każdy krok to fakt zapisany w blockchainie; to, że krążą TE SAME środki albo że wszystkie
// adresy kontroluje TA SAMA osoba, jest hipotezą. Plik bez zależności sieciowych — dane dostarcza wywołujący.

import { createHash } from 'node:crypto';
import type { AddressClass, Transfer } from '@olcys/core';
import { valueAmount } from './valuation.ts';
import type { RateSource } from './valuation.ts';

export const ROUNDTRIP_LIMITS = {
  defaultMaxHops: 10,
  /** Twardy limit długości obiegu (liczba przelewów). */
  maxHops: 50,
  /** Budżet pobrań aktywności adresów na jedno wyszukiwanie. */
  defaultBudget: 60,
  maxBudget: 200,
  defaultWindowDays: 180,
  maxWindowDays: 1095,
  /** Ile największych przelewów wychodzących śledzić z każdego adresu pośredniego. */
  defaultFanOut: 3,
  maxFanOut: 6,
  /** Przelew mniejszy niż taki ułamek kwoty, która dotarła na adres, jest pomijany (drobne kwoty). */
  defaultMinShare: 0.05,
  /** Najwyżej tyle obiegów w wyniku. */
  maxCycles: 40,
} as const;

/** Jedno zdanie o granicach wniosku — pokazywane przy każdym wyniku. */
export const ROUNDTRIP_CAVEAT =
  'Każdy krok obiegu to fakt zapisany w blockchainie; to, że wracają te same środki albo że adresy kontroluje ta sama osoba, jest hipotezą — ' +
  'obieg ma też zwykłe wyjaśnienia (przesunięcia między własnymi portfelami, wpłata i wypłata z giełdy, zamiana tokenów).';

export type RoundTripPattern = 'direct' | 'intermediaries' | 'exchange' | 'mixer' | 'contract';

export const ROUNDTRIP_PATTERN_LABEL: Record<RoundTripPattern, string> = {
  direct: 'bezpośredni ping-pong',
  intermediaries: 'obieg przez adresy pośrednie',
  exchange: 'obieg przez giełdę',
  mixer: 'obieg przez mikser',
  contract: 'obieg przez kontrakt',
};

const PATTERN_NOTE: Record<RoundTripPattern, string> = {
  direct: 'Środki wyszły na adres i wróciły bezpośrednio z niego. Może to być zwrot, rozliczenie albo przesunięcie między własnymi portfelami.',
  intermediaries: 'Środki wróciły po przejściu przez adresy pośrednie bez etykiet — wzorzec warstwowania, ale też zwykłego zarządzania własnymi portfelami.',
  exchange: 'Środki wróciły z adresu giełdy lub usługi. Usługa miesza środki klientów, więc to NIE dowodzi powrotu tych samych środków — hipoteza (typowo wpłata i późniejsza wypłata z własnego konta).',
  mixer: 'Środki wróciły z miksera — pochodzenie zatarte; powiązanie wpłaty z wypłatą jest hipotezą.',
  contract: 'Środki wróciły z kontraktu (np. zamiana tokenów) — zwykle zwykła operacja wymiany, często w tej samej chwili.',
};

/** Klasa adresu pośredniego w obiegu. */
export type IntermediaryClass = 'exchange' | 'mixer' | 'contract' | 'unlabelled' | 'labelled';

export const INTERMEDIARY_CLASS_LABEL: Record<IntermediaryClass, string> = {
  exchange: 'giełda / usługa',
  mixer: 'mikser',
  contract: 'kontrakt',
  unlabelled: 'bez etykiety',
  labelled: 'z etykietą',
};

export interface RoundTripHop {
  from: string;
  to: string;
  txid: string;
  time: string;
  amount: number;
  asset: string;
  valuePln?: number;
  valuation?: string;
  explorerUrl?: string;
}

export interface RoundTripIntermediary {
  address: string;
  class: IntermediaryClass;
  label?: string;
}

export interface RoundTripAmount {
  amount: number;
  asset: string;
  valuePln?: number;
}

export interface RoundTripCycle {
  /** Stały identyfikator z identyfikatorów transakcji (ten sam obieg = ten sam identyfikator). */
  id: string;
  pattern: RoundTripPattern;
  label: string;
  /** Kroki są faktami; to, że krążą te same środki — zawsze hipoteza. */
  sameFunds: 'hypothesis';
  hops: RoundTripHop[];
  hopCount: number;
  startedAt: string;
  endedAt: string;
  durationHours: number;
  out: RoundTripAmount;
  back: RoundTripAmount;
  /** Wróciło / wyszło: w tej samej walucie z kwot, inaczej z wycen PLN; brak, gdy nie da się porównać. */
  ratio?: number;
  returnsTo: { address: string; role: HomeRole };
  intermediaries: RoundTripIntermediary[];
  /** Ile razy powtórzył się ping-pong z tym samym adresem (tylko obieg bezpośredni). */
  repeats?: number;
  note: string;
}

export type RoundTripStopReason = 'budget' | 'max_hops' | 'time_window' | 'service_reached' | 'fan_out' | 'dust' | 'source_error' | 'cycle_limit';

export interface RoundTripStop {
  reason: RoundTripStopReason;
  detail: string;
  count: number;
}

export interface RoundTripProgress {
  addressesFetched: number;
  deepestHop: number;
  cyclesFound: number;
  queued: number;
}

export interface RoundTripParams {
  maxHops: number;
  budget: number;
  windowDays: number;
  fanOut: number;
  minShare: number;
}

export interface RoundTripResult {
  origin: string;
  network: string;
  params: RoundTripParams;
  cycles: RoundTripCycle[];
  stops: RoundTripStop[];
  stats: { addressesFetched: number; deepestHop: number; pathsExplored: number; cyclesFound: number };
  caveat: string;
}

/** Aktywność adresu potrzebna wyszukiwaniu — zgodna z `ChainActivity`. */
export interface RoundTripActivity {
  transfers: Transfer[];
  profile?: { addressClass?: AddressClass; label?: string; isContract?: boolean };
}

/** Rola adresu „domowego”, na który może wrócić obieg. */
export type HomeRole = 'subject' | 'cluster' | 'case';

export interface RoundTripOptions {
  network: string;
  /** Adres badany (start i główny cel powrotu). */
  origin: string;
  originActivity: RoundTripActivity;
  /** Inne adresy tego samego portfela (heurystyka) i inne adresy sprawy w tej sieci. */
  cluster?: string[];
  caseAddresses?: string[];
  /** Pobranie aktywności adresu pośredniego (koszt: jedno pobranie z budżetu); `undefined` — brak danych. */
  fetchActivity: (address: string) => Promise<RoundTripActivity | undefined>;
  /** Dodatkowa zgoda na pobranie (np. budżet rozwinięcia); `false` — budżet wyczerpany. */
  reserve?: () => boolean;
  maxHops?: number;
  budget?: number;
  windowDays?: number;
  fanOut?: number;
  minShare?: number;
  /** Wycena kroków w PLN (opcjonalna). */
  rateSource?: RateSource;
  onProgress?: (progress: RoundTripProgress) => void;
  signal?: AbortSignal;
}

const clamp = (value: number | undefined, fallback: number, min: number, max: number) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, number));
};

/** Parametry po zastosowaniu limitów (jak w wyniku). */
export function roundTripParams(input: Partial<RoundTripParams> = {}): RoundTripParams {
  const L = ROUNDTRIP_LIMITS;
  return {
    maxHops: Math.floor(clamp(input.maxHops, L.defaultMaxHops, 2, L.maxHops)),
    budget: Math.floor(clamp(input.budget, L.defaultBudget, 0, L.maxBudget)),
    windowDays: clamp(input.windowDays, L.defaultWindowDays, 1, L.maxWindowDays),
    fanOut: Math.floor(clamp(input.fanOut, L.defaultFanOut, 1, L.maxFanOut)),
    minShare: clamp(input.minShare, L.defaultMinShare, 0, 0.9),
  };
}

/** Porównywalna postać adresu (adresy EVM bez rozróżniania wielkości liter). */
const norm = (address: string) => (address.startsWith('0x') || address.startsWith('0X') ? address.toLowerCase() : address);

export function intermediaryClass(addressClass: AddressClass | undefined, label?: string, isContract?: boolean): IntermediaryClass {
  if (addressClass === 'mixer') return 'mixer';
  if (addressClass === 'exchange' || addressClass === 'institutional') return 'exchange';
  if (addressClass === 'smart_contract' || isContract) return 'contract';
  return label ? 'labelled' : 'unlabelled';
}

const isService = (kind: IntermediaryClass) => kind === 'exchange' || kind === 'mixer' || kind === 'contract';

const DAY = 86_400_000;

interface PathState {
  address: string;
  hops: RoundTripHop[];
  onPath: Set<string>;
}

/** Szuka obiegów środków wokół adresu. Kończy się zawsze: każdy adres jest rozwijany najwyżej raz. */
export async function findRoundTrips(options: RoundTripOptions): Promise<RoundTripResult> {
  const params = roundTripParams(options);
  const window = params.windowDays * DAY;
  const origin = options.origin;
  const home = new Map<string, HomeRole>();
  for (const address of options.caseAddresses ?? []) home.set(norm(address), 'case');
  for (const address of options.cluster ?? []) home.set(norm(address), 'cluster');
  home.set(norm(origin), 'subject');
  const isHome = (address: string) => home.has(norm(address));

  const stops = new Map<RoundTripStopReason, RoundTripStop>();
  const stop = (reason: RoundTripStopReason, detail: string, count = 1) => {
    const existing = stops.get(reason);
    if (existing) existing.count += count;
    else stops.set(reason, { reason, detail, count });
  };

  const cycles = new Map<string, RoundTripCycle>();
  const classes = new Map<string, { kind: IntermediaryClass; label?: string }>();
  const remember = (address: string, cls: AddressClass | undefined, label?: string, isContract?: boolean) => {
    const kind = intermediaryClass(cls, label, isContract);
    const known = classes.get(norm(address));
    // Klasa usługi z etykiety albo profilu ma pierwszeństwo przed „bez etykiety”.
    if (!known || (known.kind === 'unlabelled' && kind !== 'unlabelled')) classes.set(norm(address), { kind, ...(label ? { label } : {}) });
  };
  const classOf = (address: string) => classes.get(norm(address)) ?? { kind: 'unlabelled' as IntermediaryClass };

  for (const transfer of options.originActivity.transfers) if (transfer.counterparty) remember(transfer.counterparty, transfer.counterpartyClass, transfer.counterpartyLabel);

  const hopOf = (transfer: Transfer, from: string, to: string): RoundTripHop => ({
    from,
    to,
    txid: transfer.txid,
    time: transfer.time,
    amount: transfer.amount,
    asset: transfer.asset,
    ...(transfer.explorerUrl ? { explorerUrl: transfer.explorerUrl } : {}),
  });

  const addCycle = (hops: RoundTripHop[], repeats?: number) => {
    const key = hops.map((hop) => `${hop.txid}:${norm(hop.from)}>${norm(hop.to)}`).join('|');
    const id = `obieg-${createHash('sha256').update(key).digest('hex').slice(0, 12)}`;
    if (cycles.has(id)) return;
    if (cycles.size >= ROUNDTRIP_LIMITS.maxCycles) {
      stop('cycle_limit', `Pokazano ${ROUNDTRIP_LIMITS.maxCycles} obiegów — kolejne pominięto.`);
      return;
    }
    const intermediaries: RoundTripIntermediary[] = hops.slice(0, -1).map((hop) => {
      const known = classOf(hop.to);
      return { address: hop.to, class: known.kind, ...(known.label ? { label: known.label } : {}) };
    });
    const kinds = new Set(intermediaries.map((item) => item.class));
    const pattern: RoundTripPattern = kinds.has('mixer')
      ? 'mixer'
      : kinds.has('exchange')
        ? 'exchange'
        : kinds.has('contract')
          ? 'contract'
          : hops.length === 2
            ? 'direct'
            : 'intermediaries';
    const first = hops[0]!;
    const last = hops.at(-1)!;
    const label = pattern === 'direct' && repeats && repeats > 1 ? `${ROUNDTRIP_PATTERN_LABEL.direct} (powtarzany: ${repeats} razy)` : ROUNDTRIP_PATTERN_LABEL[pattern];
    const cycle: RoundTripCycle = {
      id,
      pattern,
      label,
      sameFunds: 'hypothesis',
      hops,
      hopCount: hops.length,
      startedAt: first.time,
      endedAt: last.time,
      durationHours: Math.round(((Date.parse(last.time) - Date.parse(first.time)) / 3_600_000) * 10) / 10,
      out: { amount: first.amount, asset: first.asset },
      back: { amount: last.amount, asset: last.asset },
      returnsTo: { address: last.to, role: home.get(norm(last.to)) ?? 'subject' },
      intermediaries,
      ...(repeats && repeats > 1 ? { repeats } : {}),
      note: PATTERN_NOTE[pattern],
    };
    const ratio = ratioOf(cycle);
    cycles.set(id, ratio === undefined ? cycle : { ...cycle, ratio });
    options.onProgress?.({ addressesFetched: fetched, deepestHop, cyclesFound: cycles.size, queued: queue.length });
  };

  let fetched = 0;
  let deepestHop = 0;
  let pathsExplored = 0;
  const queue: PathState[] = [];
  const within = (time: string, start: string) => Date.parse(time) - Date.parse(start) <= window;
  const originTransfers = [...options.originActivity.transfers].filter((item) => item.counterparty).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  // ---------- 1. Bezpośredni ping-pong z przelewów samego adresu (bez zapytań) ----------
  const byParty = new Map<string, Transfer[]>();
  for (const transfer of originTransfers) {
    if (isHome(transfer.counterparty)) continue;
    const key = norm(transfer.counterparty);
    byParty.set(key, [...(byParty.get(key) ?? []), transfer]);
  }
  for (const list of byParty.values()) {
    const pairs: [Transfer, Transfer][] = [];
    const pending: Transfer[] = [];
    for (const transfer of list) {
      if (transfer.direction === 'out') pending.push(transfer);
      else {
        // Powrót łączymy z najbliższym wcześniejszym, jeszcze niesparowanym wypływem w oknie czasu.
        while (pending.length > 0 && !within(transfer.time, pending.at(-1)!.time)) pending.pop();
        const out = pending.pop();
        if (out) pairs.push([out, transfer]);
      }
    }
    for (const [out, back] of pairs) addCycle([hopOf(out, origin, out.counterparty), hopOf(back, back.counterparty, origin)], pairs.length);
  }

  // ---------- 2. Przeszukiwanie wszerz po przelewach wychodzących ----------
  const visited = new Set<string>();
  const seeds = rank(
    originTransfers.filter((item) => item.direction === 'out' && !isHome(item.counterparty)),
    undefined,
  );
  const seedLimit = params.fanOut * 2;
  if (seeds.length > seedLimit) stop('fan_out', `Z badanego adresu śledzono ${seedLimit} największych wypływów; mniejsze pominięto.`, seeds.length - seedLimit);
  for (const transfer of seeds.slice(0, seedLimit)) {
    const hop = hopOf(transfer, origin, transfer.counterparty);
    const kind = classOf(transfer.counterparty).kind;
    if (isService(kind)) {
      // Powrót z usługi na adres badany jest już w etapie 1 (ping-pong przez usługę) — dalej nie idziemy.
      stop('service_reached', 'Gałęzie zakończone na usłudze (giełda, mikser, kontrakt) — historii usług nie pobieramy.');
      continue;
    }
    queue.push({ address: transfer.counterparty, hops: [hop], onPath: new Set([norm(origin), norm(transfer.counterparty)]) });
  }

  while (queue.length > 0) {
    if (options.signal?.aborted) break;
    const state = queue.shift()!;
    const key = norm(state.address);
    if (visited.has(key)) continue;
    const depth = state.hops.length;
    if (depth + 1 > params.maxHops) {
      stop('max_hops', `Osiągnięto limit ${params.maxHops} przelewów w obiegu — dalszych kroków nie badano.`);
      continue;
    }
    if (fetched >= params.budget || (options.reserve && !options.reserve())) {
      stop('budget', `Budżet ${params.budget} pobrań adresów wyczerpany — nie zbadano adresów w kolejce.`, queue.length + 1);
      queue.length = 0;
      break;
    }
    visited.add(key);
    fetched++;
    pathsExplored++;
    deepestHop = Math.max(deepestHop, depth);
    options.onProgress?.({ addressesFetched: fetched, deepestHop, cyclesFound: cycles.size, queued: queue.length });
    let activity: RoundTripActivity | undefined;
    try {
      activity = await options.fetchActivity(state.address);
    } catch (error) {
      stop('source_error', `Nie pobrano historii części adresów pośrednich (${error instanceof Error ? error.message : String(error)}).`);
      continue;
    }
    if (!activity) continue;
    if (activity.profile) remember(state.address, activity.profile.addressClass, activity.profile.label, activity.profile.isContract);
    const start = state.hops[0]!.time;
    const arrival = state.hops.at(-1)!;
    // Adres okazał się usługą (z jego własnego profilu): gałąź kończy się tutaj; powrót z usługi sprawdzamy niżej.
    if (isService(classOf(state.address).kind)) {
      stop('service_reached', 'Gałęzie zakończone na usłudze (giełda, mikser, kontrakt) — historii usług nie pobieramy.');
      closeViaService(state);
      continue;
    }
    for (const transfer of activity.transfers) if (transfer.counterparty) remember(transfer.counterparty, transfer.counterpartyClass, transfer.counterpartyLabel);
    const outgoing = activity.transfers
      .filter((item) => item.direction === 'out' && item.counterparty && Date.parse(item.time) >= Date.parse(arrival.time))
      .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const late = outgoing.filter((item) => !within(item.time, start));
    if (late.length > 0) stop('time_window', `Przelewy poza oknem ${params.windowDays} dni od pierwszego wypływu pominięto.`, late.length);
    const timely = outgoing.filter((item) => within(item.time, start));
    // Powrót na adres badany, adres portfela albo adres sprawy zamyka obieg.
    const closing = timely.filter((item) => isHome(item.counterparty) && !(depth === 1 && norm(item.counterparty) === norm(origin)));
    for (const transfer of closing.slice(0, 3)) addCycle([...state.hops, hopOf(transfer, state.address, transfer.counterparty)]);
    const onward = timely.filter((item) => !isHome(item.counterparty) && !state.onPath.has(norm(item.counterparty)));
    const sized = onward.filter((item) => item.asset !== arrival.asset || item.amount >= arrival.amount * params.minShare);
    if (sized.length < onward.length) stop('dust', `Drobne przelewy (poniżej ${Math.round(params.minShare * 100)}% kwoty, która dotarła na adres) pominięto.`, onward.length - sized.length);
    const ranked = rank(sized, arrival.asset);
    if (ranked.length > params.fanOut) stop('fan_out', `Z każdego adresu pośredniego śledzono ${params.fanOut} największe wypływy; mniejsze pominięto.`, ranked.length - params.fanOut);
    for (const transfer of ranked.slice(0, params.fanOut)) {
      const hop = hopOf(transfer, state.address, transfer.counterparty);
      const next: PathState = { address: transfer.counterparty, hops: [...state.hops, hop], onPath: new Set([...state.onPath, norm(transfer.counterparty)]) };
      if (isService(classOf(transfer.counterparty).kind)) {
        stop('service_reached', 'Gałęzie zakończone na usłudze (giełda, mikser, kontrakt) — historii usług nie pobieramy.');
        closeViaService(next);
        continue;
      }
      if (next.hops.length + 1 > params.maxHops) {
        stop('max_hops', `Osiągnięto limit ${params.maxHops} przelewów w obiegu — dalszych kroków nie badano.`);
        continue;
      }
      queue.push(next);
    }
  }

  /** Gałąź doszła do usługi: czy z tej samej usługi środki wróciły na adres badany (w oknie, po wpłacie)? */
  function closeViaService(state: PathState) {
    const arrival = state.hops.at(-1)!;
    if (state.hops.length + 1 > params.maxHops) return;
    const back = originTransfers.find(
      (item) => item.direction === 'in' && norm(item.counterparty) === norm(state.address) && Date.parse(item.time) >= Date.parse(arrival.time) && within(item.time, state.hops[0]!.time),
    );
    // Obieg A→usługa→A to już etap 1; tutaj tylko obiegi z co najmniej jednym adresem pośrednim przed usługą.
    if (back && state.hops.length > 1) addCycle([...state.hops, hopOf(back, state.address, origin)]);
  }

  const list = [...cycles.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.hopCount - b.hopCount || a.id.localeCompare(b.id));
  if (options.rateSource) await valueCycles(list, options.rateSource);
  options.onProgress?.({ addressesFetched: fetched, deepestHop, cyclesFound: list.length, queued: 0 });
  return {
    origin,
    network: options.network,
    params,
    cycles: list,
    stops: [...stops.values()],
    stats: { addressesFetched: fetched, deepestHop, pathsExplored, cyclesFound: list.length },
    caveat: ROUNDTRIP_CAVEAT,
  };
}

/** Kolejność śledzenia: najpierw ta sama waluta, która dotarła (malejąco), potem pozostałe; remisy po czasie i txid. */
function rank(transfers: Transfer[], asset: string | undefined): Transfer[] {
  return [...transfers].sort(
    (a, b) =>
      Number(b.asset === asset) - Number(a.asset === asset) ||
      b.amount - a.amount ||
      Date.parse(a.time) - Date.parse(b.time) ||
      a.txid.localeCompare(b.txid),
  );
}

/** Wycena kroków w PLN po kursie z dnia przelewu; porównanie „wyszło / wróciło”. */
async function valueCycles(cycles: RoundTripCycle[], rateSource: RateSource): Promise<void> {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof valueAmount>>>>();
  const value = (hop: RoundTripHop) => {
    const key = `${hop.asset}|${hop.amount}|${hop.time.slice(0, 10)}`;
    if (!cache.has(key)) cache.set(key, valueAmount(rateSource, hop.asset, hop.amount, hop.time).catch(() => null));
    return cache.get(key)!;
  };
  for (const cycle of cycles) {
    for (const hop of cycle.hops) {
      const valued = await value(hop);
      if (valued) {
        hop.valuePln = valued.valuePln;
        hop.valuation = valued.valuation;
      }
    }
    const first = cycle.hops[0]!;
    const last = cycle.hops.at(-1)!;
    cycle.out = { amount: first.amount, asset: first.asset, ...(first.valuePln !== undefined ? { valuePln: first.valuePln } : {}) };
    cycle.back = { amount: last.amount, asset: last.asset, ...(last.valuePln !== undefined ? { valuePln: last.valuePln } : {}) };
  }
  for (const cycle of cycles) {
    const ratio = cycle.ratio ?? ratioOf(cycle);
    if (ratio !== undefined) cycle.ratio = ratio;
  }
}

function ratioOf(cycle: RoundTripCycle): number | undefined {
  const round = (value: number) => Math.round(value * 1000) / 1000;
  if (cycle.out.asset === cycle.back.asset && cycle.out.amount > 0) return round(cycle.back.amount / cycle.out.amount);
  if (cycle.out.valuePln && cycle.back.valuePln !== undefined) return round(cycle.back.valuePln / cycle.out.valuePln);
  return undefined;
}
