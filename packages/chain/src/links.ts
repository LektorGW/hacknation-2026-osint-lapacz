// Inne adresy tej samej osoby: powiązania wynikające z samego blockchaina.
// WSZYSTKO tutaj to HEURYSTYKI — wskazują adresy warte sprawdzenia, a nie
// ustalają tożsamości. Każde powiązanie ma rodzaj, siłę 0–100 i uzasadnienie.
//
//  co_depositor          — inny nadawca wpłat na TEN SAM indywidualny adres wpłat giełdy;
//  same_wallet           — adres z klastra portfela (wspólne wejścia, reszta);
//  funded_by / funds     — pierwsze zasilenie między adresami prywatnymi;
//  repeated_counterparty — prywatny kontrahent z przelewami w obie strony przez dłuższy czas.
//
// Celowo NIE tworzymy powiązania „to samo źródło finansowania” (dwa adresy zasilone
// z tego samego portfela wypłat giełdy): giełda wypłaca tysiącom klientów z tych
// samych adresów, więc wspólny adres wypłat nie mówi nic o wspólnym właścicielu.

import type { AddressCluster, ChainActivity, Network } from '@olcys/core';
import type { RawTransfer } from './activity.ts';
import type { InferredDeposit } from './deposit.ts';
import { ChainProviderError } from './http.ts';
import type { RequestBudget } from './http.ts';
import { classify, normalizeAddress } from './labels.ts';
import type { LabelSet } from './labels.ts';
import { isQueryableAddress } from './party-labels.ts';

export type LinkKind = 'co_depositor' | 'same_wallet' | 'funded_by' | 'funds' | 'repeated_counterparty';

/** Adres powiązany z adresem podmiotu — kandydat na inny adres tej samej osoby. */
export interface LinkedAddress {
  address: string;
  network: Network;
  kind: LinkKind;
  /** Siła powiązania 0–100 z jawnych reguł; to nie jest prawdopodobieństwo. */
  strength: number;
  /** Na czym opiera się powiązanie i kiedy zawodzi. */
  reason: string;
  /** Transakcje, z których wynika powiązanie. */
  txids: string[];
  firstSeen?: string;
  lastSeen?: string;
  /** Łączna kwota przelewów stanowiących podstawę powiązania. */
  amount?: number;
  asset?: string;
}

/** Wynik analizy rozszerzony o powiązane adresy (pole poza kontraktem core). */
export type ChainActivityWithLinks = ChainActivity & { openQuestions?: string[]; linkedAddresses?: LinkedAddress[] };

export interface LinkOptions {
  enabled?: boolean;
  /** Ilu współwpłacających najwyżej zwracamy dla jednego adresu wpłat. */
  maxCoDepositors?: number;
  /** Ile adresów wpłat najwyżej badamy. */
  maxDepositAddresses?: number;
  /** Ile dni przed i po wpłacie podmiotu bierzemy pod uwagę wpłaty innych nadawców. */
  coDepositWindowDays?: number;
  /**
   * Powyżej tylu różnych nadawców adres wpłat uznajemy za adres pośrednika (kantor, bramka,
   * serwis przyjmujący wpłaty wielu osób) i NIE tworzymy powiązań.
   */
  maxDepositSenders?: number;
  /** Powyżej tylu transakcji adres wpłat uznajemy za adres usługi. */
  maxDepositTxCount?: number;
  /** Powyżej tylu transakcji kontrahent nie jest traktowany jak adres prywatny. */
  maxPrivateTxCount?: number;
  /** Ilu odbiorców przelewów sprawdzamy pod kątem „pierwszego zasilenia”. */
  maxFundedChecks?: number;
  /** Minimalna liczba przelewów i minimalny okres (dni) dla stałego kontrahenta. */
  repeatedMinTransfers?: number;
  repeatedMinDays?: number;
}

export const DEFAULT_LINK_OPTIONS: Required<LinkOptions> = {
  enabled: true,
  maxCoDepositors: 20,
  maxDepositAddresses: 4,
  coDepositWindowDays: 730,
  maxDepositSenders: 10,
  maxDepositTxCount: 2000,
  maxPrivateTxCount: 200,
  maxFundedChecks: 3,
  repeatedMinTransfers: 3,
  repeatedMinDays: 30,
};

/** Budżet żądań na szukanie powiązań: tryb standardowy / głęboki. */
export const DEFAULT_LINK_BUDGET = 12;
export const DEEP_LINK_BUDGET = 40;

/** Siły powiązań — jawne stałe. */
export const LINK_STRENGTH = {
  coDepositor: 80,
  /** Adres wpłat rozpoznany tylko po etykiecie portfela (WalletExplorer), bez zaobserwowanego zamiecenia. */
  coDepositorLabelOnly: 70,
  /** Adres wpłat z wieloma nadawcami (ale poniżej progu pośrednika). */
  coDepositorManySenders: 65,
  sameWalletCommonInput: 75,
  sameWalletChange: [55, 65],
  sameWalletDoubtful: 25,
  funding: 45,
  fundingRepeated: 50,
  fundingBothWays: 60,
  repeatedBase: 30,
  repeatedPerTransfer: 4,
  repeatedMax: 50,
} as const;

/** Co źródło danych wie o adresie: przelewy przychodzące i aktywność. */
export interface IncomingNode {
  /** Przelewy PRZYCHODZĄCE na adres (kontrahent = nadawca). */
  incoming: RawTransfer[];
  txCount?: number;
  /** Czy historia ma dalsze strony. */
  more?: boolean;
}

export interface LinkSearch {
  network: Network;
  address: string;
  /** Przelewy badanego adresu. */
  transfers: RawTransfer[];
  /** Ustalone (wnioskowaniem) indywidualne adresy wpłat giełd. */
  deposits: InferredDeposit[];
  cluster?: AddressCluster;
  /** Czy pobrano całą historię adresu — tylko wtedy wolno mówić o „pierwszej wpłacie”. */
  historyComplete: boolean;
  labels: LabelSet;
  sourceName: string;
  budget: RequestBudget;
  options?: LinkOptions;
  /** Przelewy przychodzące na adres w podanej walucie — jedno żądanie. */
  fetchIncoming?(address: string, asset: string): Promise<IncomingNode>;
  /** Liczba transakcji adresu — jedno żądanie. */
  countTransactions?(address: string): Promise<number | undefined>;
  signal?: AbortSignal;
}

const DAY_MS = 86_400_000;
const short = (address: string) => (address.length > 16 ? `${address.slice(0, 8)}…${address.slice(-6)}` : address);
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;
const span = (items: { time: string }[]) => {
  const times = items.map((item) => item.time).sort();
  return { firstSeen: times[0]!, lastSeen: times.at(-1)! };
};

export async function findLinkedAddresses(search: LinkSearch): Promise<{ links: LinkedAddress[]; limitations: string[] }> {
  const options = { ...DEFAULT_LINK_OPTIONS, ...search.options };
  const { network, labels, budget } = search;
  const subject = normalizeAddress(search.address);
  const links: LinkedAddress[] = [];
  const limitations: string[] = [];
  if (!options.enabled) return { links, limitations };

  const describe = (transfer: RawTransfer) =>
    classify(network, transfer.counterparty, {
      labels,
      sourceLabel: transfer.counterpartyLabel,
      sourceClass: transfer.counterpartyClass,
      sourceKind: transfer.counterpartyKind,
      sourceName: transfer.counterpartyLabelSource ?? search.sourceName,
      isContract: transfer.counterpartyIsContract,
    });
  /** Kontrahent wyglądający na adres prywatny: bez etykiety, klasy i kodu kontraktu. */
  const looksPrivate = (transfer: RawTransfer) => {
    const known = describe(transfer);
    return known.addressClass === 'unknown' && !known.label && !known.kind && isQueryableAddress(transfer.counterparty);
  };

  /** Przelew, na którym wolno oprzeć powiązanie: realna kwota w zweryfikowanej walucie. */
  const solid = (transfer: RawTransfer) => transfer.amount > 0 && !transfer.asset.includes('niezweryfikowany');
  /**
   * Adres-podróbka („address poisoning”): oszuści wysyłają zerowe lub fałszywe przelewy z adresów o tym samym
   * początku i końcu co prawdziwy kontrahent. Z pary podobnych adresów zostaje ten o większym obrocie.
   */
  const lookalike = (a: string, b: string) => a !== b && a.length === b.length && a.length > 12 && a.slice(0, 6) === b.slice(0, 6) && a.slice(-4) === b.slice(-4);
  let poisoned = 0;
  const dropLookalikes = <T extends { key: string; volume: number }>(entries: T[], reference: string[] = []): T[] =>
    entries.filter((entry) => {
      const fake = reference.some((other) => lookalike(entry.key, other)) || entries.some((other) => lookalike(entry.key, other.key) && other.volume > entry.volume);
      if (fake) poisoned += 1;
      return !fake;
    });

  let stoppedBy: string | undefined;
  const fail = (what: string, error: unknown) => {
    if (search.signal?.aborted) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ChainProviderError && (error.code === 'rate_limited' || error.code === 'timeout')) stoppedBy = `błąd źródła danych — ${reason}`;
    else limitations.push(`Powiązania: ${what} — ${reason}`);
  };
  const outOfBudget = () => {
    stoppedBy = `wyczerpano budżet ${budget.limit} żądań na szukanie powiązań`;
  };

  // ---------- same_wallet: klaster portfela (bez dodatkowych żądań) ----------
  const clusterSet = new Set<string>();
  for (const member of search.cluster?.addresses ?? []) {
    clusterSet.add(normalizeAddress(member.address));
    const doubtful = member.reason.includes('UWAGA');
    const common = member.reason.startsWith('heurystyka wspólnych wejść');
    const heuristics = common ? 0 : member.reason.split(';').length;
    const strength = doubtful
      ? LINK_STRENGTH.sameWalletDoubtful
      : common
        ? LINK_STRENGTH.sameWalletCommonInput
        : LINK_STRENGTH.sameWalletChange[Math.min(heuristics, 2) - 1] ?? LINK_STRENGTH.sameWalletChange[0];
    links.push({
      address: member.address,
      network,
      kind: 'same_wallet',
      strength,
      reason:
        `HEURYSTYKA „ten sam portfel”: ${member.reason}. ` +
        (common
          ? 'Zawodzi przy transakcjach wspólnych (CoinJoin, PayJoin) i wypłatach zbiorczych usług.'
          : 'Adres reszty wskazano po cechach transakcji — może to być adres odbiorcy płatności.'),
      txids: member.txid ? [member.txid] : [],
    });
  }

  // ---------- co_depositor: inni nadawcy wpłat na ten sam indywidualny adres wpłat ----------
  interface DepositTarget {
    address: string;
    asset: string;
    exchange: string;
    time: string;
    txid: string;
    labelOnly: boolean;
  }
  const targets = new Map<string, DepositTarget>();
  for (const deposit of search.deposits) {
    const own = search.transfers.find((item) => item.txid === deposit.txid && item.direction === 'out');
    const key = normalizeAddress(deposit.counterparty);
    if (!targets.has(key)) {
      targets.set(key, { address: deposit.counterparty, asset: deposit.asset, exchange: deposit.exchangeLabel, time: own?.time ?? '', txid: deposit.txid, labelOnly: false });
    }
  }
  // Bitcoin: adres zaliczony przez WalletExplorer do portfela giełdy bywa indywidualnym adresem wpłat
  // (portfel obejmuje adresy wpłat klientów). Portfele zbiorcze odpadną niżej po liczbie nadawców.
  for (const transfer of search.transfers) {
    if (transfer.direction !== 'out' || transfer.counterpartyLabelSource !== 'WalletExplorer' || !isQueryableAddress(transfer.counterparty)) continue;
    const known = describe(transfer);
    const key = normalizeAddress(transfer.counterparty);
    if (known.addressClass !== 'exchange' || targets.has(key)) continue;
    targets.set(key, { address: transfer.counterparty, asset: transfer.asset, exchange: known.label ?? 'giełda', time: transfer.time, txid: transfer.txid, labelOnly: true });
  }

  let depositChecked = 0;
  let depositRejected = 0;
  for (const target of [...targets.values()].slice(0, options.maxDepositAddresses)) {
    if (stoppedBy || !search.fetchIncoming) break;
    if (!budget.take()) {
      outOfBudget();
      break;
    }
    let node: IncomingNode;
    try {
      node = await search.fetchIncoming(target.address, target.asset);
    } catch (error) {
      fail(`nie udało się pobrać wpłat na adres wpłat ${target.address}`, error);
      continue;
    }
    depositChecked += 1;
    const incoming = node.incoming.filter((item) => item.direction === 'in' && isQueryableAddress(item.counterparty) && solid(item));
    const grouped = new Map<string, RawTransfer[]>();
    for (const item of incoming) {
      const key = normalizeAddress(item.counterparty);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    const kept = dropLookalikes(
      [...grouped.entries()].map(([key, items]) => ({ key, items, volume: items.reduce((sum, item) => sum + item.amount, 0) })),
      [subject],
    );
    const senders = new Map(kept.map((entry) => [entry.key, entry.items] as const));
    let txCount = node.txCount;
    if (txCount === undefined && node.more && search.countTransactions && budget.take()) {
      try {
        txCount = await search.countTransactions(target.address);
      } catch (error) {
        fail(`nie udało się sprawdzić aktywności adresu wpłat ${target.address}`, error);
      }
    }
    // Wyjątek: adres przyjmujący wpłaty wielu osób to pośrednik (kantor, bramka, serwis), nie konto jednej osoby.
    if (senders.size > options.maxDepositSenders || (txCount !== undefined && txCount > options.maxDepositTxCount)) {
      depositRejected += 1;
      limitations.push(
        `Powiązania: adres ${target.address} (środki przekazywane do „${target.exchange}”) ma ${senders.size}${node.more ? '+' : ''} różnych nadawców` +
          `${txCount !== undefined ? ` i ${txCount} transakcji` : ''} — to raczej adres pośrednika (kantor, bramka, serwis przyjmujący wpłaty wielu osób) ` +
          'albo portfel zbiorczy niż indywidualny adres wpłat jednego klienta. Nie utworzono powiązań „współwpłacający”.',
      );
      continue;
    }
    const center = Date.parse(target.time);
    const windowMs = options.coDepositWindowDays * DAY_MS;
    let services = 0;
    let outside = 0;
    const found: LinkedAddress[] = [];
    for (const [key, items] of senders) {
      if (key === subject || clusterSet.has(key)) continue;
      const known = describe(items[0]!);
      if (known.addressClass !== 'unknown' || known.label || known.kind) {
        services += 1;
        continue;
      }
      const inWindow = Number.isNaN(center) ? items : items.filter((item) => Math.abs(Date.parse(item.time) - center) <= windowMs);
      if (inWindow.length === 0) {
        outside += 1;
        continue;
      }
      const others = senders.size - 1;
      const strength = target.labelOnly ? LINK_STRENGTH.coDepositorLabelOnly : others > 5 ? LINK_STRENGTH.coDepositorManySenders : LINK_STRENGTH.coDepositor;
      found.push({
        address: items[0]!.counterparty,
        network,
        kind: 'co_depositor',
        strength,
        reason:
          `HEURYSTYKA „współwpłacający”: adres wpłacił ${inWindow.length} raz(y) na ${short(target.address)} — ten sam ` +
          (target.labelOnly
            ? `adres portfela giełdy „${target.exchange}” (etykieta WalletExplorer), na który wpłacał adres podmiotu`
            : `prawdopodobny indywidualny adres wpłat w giełdzie „${target.exchange}”, na który wpłacał adres podmiotu (tx ${target.txid})`) +
          `. Indywidualny adres wpłat należy do jednego konta klienta giełdy, więc wpłacający to najpewniej ta sama osoba ALBO ktoś wpłacający na jej konto ` +
          `(kontrahent, kupujący, rodzina). Zastrzeżenia: sam adres wpłat ustalono wnioskowaniem; adres mógł należeć do pośrednika o małej liczbie klientów ` +
          `(różnych nadawców: ${senders.size}). Rozstrzyga giełda — właściciel konta i lista wpłat.`,
        txids: inWindow.map((item) => item.txid),
        ...span(inWindow),
        amount: round8(inWindow.reduce((sum, item) => sum + item.amount, 0)),
        asset: inWindow[0]!.asset,
      });
    }
    found.sort((a, b) => b.txids.length - a.txids.length || (b.amount ?? 0) - (a.amount ?? 0));
    links.push(...found.slice(0, options.maxCoDepositors));
    limitations.push(
      `Powiązania: adres wpłat ${target.address} („${target.exchange}”) — ${senders.size} różnych nadawców w pobranej historii` +
        `${node.more ? ' (historia ma dalsze strony — starszych wpłat nie widać)' : ''}; współwpłacających: ${Math.min(found.length, options.maxCoDepositors)}` +
        `${found.length > options.maxCoDepositors ? ` z ${found.length} (limit)` : ''}; pominięto ${services} nadawców będących usługami lub kontraktami` +
        `${outside > 0 ? ` i ${outside} spoza okna ${options.coDepositWindowDays} dni` : ''}.`,
    );
  }
  if (targets.size > options.maxDepositAddresses) {
    limitations.push(`Powiązania: sprawdzono ${options.maxDepositAddresses} z ${targets.size} adresów wpłat (limit).`);
  }

  // ---------- funded_by / funds / repeated_counterparty: przelewy między adresami prywatnymi ----------
  const ordered = [...search.transfers].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const allParties = new Map<string, RawTransfer[]>();
  for (const transfer of ordered) {
    const key = normalizeAddress(transfer.counterparty);
    if (key === subject || !solid(transfer)) continue;
    allParties.set(key, [...(allParties.get(key) ?? []), transfer]);
  }
  const genuine = dropLookalikes([...allParties.entries()].map(([key, items]) => ({ key, items, volume: items.reduce((sum, item) => sum + item.amount, 0) })));
  const byParty = new Map<string, RawTransfer[]>();
  for (const { key, items } of genuine) {
    if (targets.has(key) || clusterSet.has(key) || !looksPrivate(items[0]!)) continue;
    byParty.set(key, items);
  }

  const activity = new Map<string, number | undefined | null>();
  /** `true`, gdy adres można traktować jak prywatny (mała aktywność); `false` przy usłudze lub braku możliwości sprawdzenia. */
  async function quiet(address: string): Promise<boolean> {
    const key = normalizeAddress(address);
    if (!activity.has(key)) {
      if (!search.countTransactions) {
        activity.set(key, null);
      } else if (!budget.take()) {
        outOfBudget();
        return false;
      } else {
        try {
          activity.set(key, await search.countTransactions(address));
        } catch (error) {
          fail(`nie udało się sprawdzić aktywności adresu ${address}`, error);
          activity.set(key, undefined);
        }
      }
    }
    const count = activity.get(key);
    // Bez liczby transakcji nie przesądzamy, że adres jest prywatny.
    return typeof count === 'number' && count <= options.maxPrivateTxCount;
  }
  const strengthOfFunding = (items: RawTransfer[]) => {
    const both = items.some((item) => item.direction === 'in') && items.some((item) => item.direction === 'out');
    return both ? LINK_STRENGTH.fundingBothWays : items.length >= 2 ? LINK_STRENGTH.fundingRepeated : LINK_STRENGTH.funding;
  };
  const relation = (items: RawTransfer[]) => {
    const incoming = items.filter((item) => item.direction === 'in').length;
    return `łącznie ${items.length} przelew(y) między adresami (${incoming} przychodzących, ${items.length - incoming} wychodzących)`;
  };
  const sumOf = (items: RawTransfer[]) => {
    const asset = items[0]!.asset;
    return { amount: round8(items.filter((item) => item.asset === asset).reduce((sum, item) => sum + item.amount, 0)), asset };
  };

  // funded_by: kto zasilił adres podmiotu pierwszą wpłatą.
  const firstIn = ordered.find((item) => item.direction === 'in' && solid(item));
  if (firstIn && !stoppedBy) {
    if (!search.historyComplete) {
      limitations.push(
        'Powiązania: nie ustalano źródła pierwszego zasilenia adresu — historia adresu nie jest pełna, więc najstarsza pobrana wpłata ' +
          'nie musi być pierwszą (pełną historię włącza opcja `history: \'full\'`).',
      );
    } else {
      const key = normalizeAddress(firstIn.counterparty);
      const items = byParty.get(key);
      if (items && (await quiet(firstIn.counterparty))) {
        links.push({
          address: firstIn.counterparty,
          network,
          kind: 'funded_by',
          strength: strengthOfFunding(items),
          reason:
            `HEURYSTYKA „źródło środków”: pierwsza wpłata na adres podmiotu (${firstIn.amount} ${firstIn.asset}, ${firstIn.time.slice(0, 10)}, tx ${firstIn.txid}) ` +
            `przyszła z tego adresu, który nie ma etykiety usługi i ma małą aktywność (${activity.get(key)} transakcji); ${relation(items)}. ` +
            'Nowy portfel często jest zasilany z innego portfela tej samej osoby — ale równie dobrze mógł to być sprzedawca, pracodawca lub znajomy.',
          txids: items.map((item) => item.txid),
          ...span(items),
          ...sumOf(items),
        });
      }
    }
  }

  // repeated_counterparty: stały prywatny kontrahent z przelewami w obie strony.
  const linked = () => new Set(links.map((link) => `${link.kind}|${normalizeAddress(link.address)}`));
  const repeated = [...byParty.entries()]
    .filter(([, items]) => {
      const days = (Date.parse(items.at(-1)!.time) - Date.parse(items[0]!.time)) / DAY_MS;
      return (
        items.length >= options.repeatedMinTransfers &&
        days >= options.repeatedMinDays &&
        items.some((item) => item.direction === 'in') &&
        items.some((item) => item.direction === 'out')
      );
    })
    .sort((a, b) => b[1].length - a[1].length);
  for (const [key, items] of repeated) {
    if (stoppedBy) break;
    if (!(await quiet(items[0]!.counterparty))) continue;
    const days = Math.round((Date.parse(items.at(-1)!.time) - Date.parse(items[0]!.time)) / DAY_MS);
    links.push({
      address: items[0]!.counterparty,
      network,
      kind: 'repeated_counterparty',
      strength: Math.min(LINK_STRENGTH.repeatedMax, LINK_STRENGTH.repeatedBase + (items.length - options.repeatedMinTransfers) * LINK_STRENGTH.repeatedPerTransfer),
      reason:
        `HEURYSTYKA „stały kontrahent”: ${relation(items)} w ciągu ${days} dni; adres nie ma etykiety usługi i ma małą aktywność ` +
        `(${activity.get(key)} transakcji). Może to być drugi portfel tej samej osoby, ale też osoba bliska, wspólnik albo stały kontrahent.`,
      txids: items.map((item) => item.txid),
      ...span(items),
      ...sumOf(items),
    });
  }

  // funds: adresy prywatne, dla których przelew z adresu podmiotu był pierwszym zasileniem.
  const outgoing = [...byParty.entries()]
    .filter(([key, items]) => items.some((item) => item.direction === 'out') && !linked().has(`funded_by|${key}`) && !linked().has(`repeated_counterparty|${key}`))
    .sort((a, b) => Math.max(...b[1].map((item) => item.amount)) - Math.max(...a[1].map((item) => item.amount)))
    .slice(0, options.maxFundedChecks);
  for (const [key, items] of outgoing) {
    if (stoppedBy || !search.fetchIncoming) break;
    const firstOut = items.find((item) => item.direction === 'out')!;
    if (!budget.take()) {
      outOfBudget();
      break;
    }
    let node: IncomingNode;
    try {
      node = await search.fetchIncoming(firstOut.counterparty, firstOut.asset);
    } catch (error) {
      fail(`nie udało się pobrać wpłat na adres ${firstOut.counterparty}`, error);
      continue;
    }
    // „Pierwsze zasilenie” da się stwierdzić tylko przy całej historii wpłat na jednej stronie.
    if (node.more || (node.txCount !== undefined && node.txCount > options.maxPrivateTxCount)) continue;
    const earliest = node.incoming.filter((item) => item.direction === 'in').sort((a, b) => Date.parse(a.time) - Date.parse(b.time))[0];
    if (!earliest || normalizeAddress(earliest.counterparty) !== subject) continue;
    if (linked().has(`repeated_counterparty|${key}`)) continue;
    links.push({
      address: firstOut.counterparty,
      network,
      kind: 'funds',
      strength: strengthOfFunding(items),
      reason:
        `HEURYSTYKA „zasilony adres”: pierwszą wpłatą na ten adres był przelew z adresu podmiotu (${earliest.amount} ${earliest.asset}, ` +
        `${earliest.time.slice(0, 10)}, tx ${earliest.txid}); adres nie ma etykiety usługi; ${relation(items)}. ` +
        'Tak wygląda założenie nowego portfela przez tę samą osobę — ale też pierwsza płatność na świeży adres odbiorcy.',
      txids: items.map((item) => item.txid),
      ...span(items),
      ...sumOf(items),
    });
  }

  if (poisoned > 0) {
    limitations.push(
      `Powiązania: pominięto ${poisoned} adres(y) wyglądające na podróbki prawdziwych kontrahentów (ten sam początek i koniec adresu, mniejszy obrót) — ` +
        'typowy ślad oszustwa „address poisoning”, a nie powiązanie z osobą.',
    );
  }
  if (stoppedBy) limitations.push(`Powiązania: szukanie przerwano — ${stoppedBy}. Lista powiązanych adresów może być niepełna.`);
  if (links.length > 0) {
    limitations.push(
      `Powiązane adresy (${links.length}) to HEURYSTYKI wskazujące kandydatów na inne adresy tej samej osoby — nie ustalenie tożsamości. ` +
        'Siła 0–100 pochodzi z jawnych reguł; każde powiązanie wymaga potwierdzenia poza łańcuchem (dane giełdy, inne źródła).',
    );
  }
  links.sort((a, b) => b.strength - a.strength);
  return { links, limitations };
}
