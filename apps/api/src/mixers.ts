// Miksery i CoinJoin: czy środki adresów sprawy przeszły przez usługę, która zaciera ich drogę.
//
// Cztery źródła ustaleń (każde z jawnym statusem):
//   (a) przelewy WYCHODZĄCE na adres oznaczony jako mikser — etykieta z cytowanego zbioru = fakt źródłowy,
//       etykieta bez wskazanego źródła = obliczenie (klasa podana przez dostawcę danych), etykieta rozpoznana
//       po samej nazwie lub heurystyką grupowania portfeli = hipoteza;
//   (b) udział w transakcji wyglądającej na CoinJoin — HEURYSTYKA (wiele wyjść o identycznej kwocie), zawsze hipoteza;
//   (c) przelewy PRZYCHODZĄCE z miksera — pochodzenie środków zatarte;
//   (d) przerwania śledzenia środków na mikserze (ostrzeżenia modułu blockchain).
// Poziom: `confirmed` — przelew na lub z oznaczonego miksera; `possible` — tylko heurystyka albo mikser
// za adresem pośrednim; `none` — brak przesłanek.
//
// Narzędzie stwierdza wyłącznie, że środki przeszły przez mikser i że dalszej drogi nie da się ustalić
// z blockchainu. Niczego nie wnioskuje o osobie: użycie miksera bywa legalną ochroną prywatności.
// Listy sankcyjne: wyłącznie fakt o liście z lokalnej migawki (żadnych twierdzeń spoza migawki).

import type { CashOutAssessment, ClaimStatus, EvidenceRef, Finding, GraphEdge, GraphNode, InvestigationIndicators, ScoreComponent, ServiceLink, Transfer } from '@olcys/core';
import { riskListAddressFlags } from '@olcys/sources';
import type { RiskAddressFlag } from '@olcys/sources';
import { rateFor, valuationsOf } from './business.ts';
import { formatAmount, formatPln, plural, roundPln, shortAddress } from './format.ts';
import { addressKey } from './intel.ts';
import { NETWORK_LABEL, dateTime, esc, fact, inference, link } from './report-html.ts';
import { resolveService, serviceIdOf } from './services.ts';

export type MixerLevel = 'none' | 'possible' | 'confirmed';

/** Jedno przekazanie środków do miksera albo z miksera. */
export interface MixerTransfer {
  direction: 'to_mixer' | 'from_mixer';
  /** Adres sprawy (podmiotu albo powiązany). */
  address: string;
  network: string;
  txid: string;
  time: string;
  asset: string;
  amount: number;
  /** Szacunek w PLN po kursie z istniejących wycen tego samego aktywa; brak = bez kursu. */
  valuePln?: number;
  rateNote?: string;
  mixerAddress: string;
  /** Etykieta adresu miksera tak, jak podało źródło. */
  mixerLabel: string;
  /** Nazwa usługi (np. „Tornado Cash” zamiast etykiety puli). */
  mixerName: string;
  /** Skąd etykieta: zbiór etykiet i jego źródło, dostawca danych. */
  labelSource: string;
  /** `source_fact` — etykieta z cytowanego publicznego zbioru; `computed` — klasa od dostawcy danych; `hypothesis` — rozpoznanie po nazwie. */
  status: ClaimStatus;
  explorerUrl: string;
}

/** Udział w transakcji wyglądającej na CoinJoin (zawsze hipoteza). */
export interface CoinJoinParticipation {
  address: string;
  network: string;
  txid: string;
  time?: string;
  explorerUrl?: string;
  /** `equal_outputs` — heurystyka na przelewach adresu; `trace` — ostrzeżenie modułu śledzenia środków. */
  basis: 'equal_outputs' | 'trace';
  equalOutputs?: number;
  denomination?: number;
  asset?: string;
  /** Wzorzec znanej implementacji, jeśli kwoty go przypominają (nadal hipoteza). */
  pattern?: 'whirlpool' | 'wasabi';
  /** Środki trafiły do CoinJoin przez adres pośredni (z danych śledzenia). */
  via?: string;
  status: 'hypothesis';
  explanation: string;
}

/** Przerwanie śledzenia środków na mikserze (z ostrzeżeń modułu blockchain). */
export interface MixerTraceStop {
  address: string;
  network: string;
  /** Adres miksera albo adres, którego wydatek wyglądał na CoinJoin. */
  mixerAddress: string;
  mixerLabel?: string;
  txid: string;
  coinjoin: boolean;
  /** Stop na przelewie wprost z adresu sprawy (ten sam przelew jest już w tabeli przekazań). */
  direct: boolean;
  text: string;
}

/** Trafienie adresu miksera na liście sankcyjnej — fakt o liście z lokalnej migawki. */
export interface MixerSanctionHit {
  mixerAddress: string;
  list: string;
  entryId: string;
  entryName: string;
  retrievedAt: string;
  url?: string;
  caveat: string;
}

export interface MixerExposure {
  level: MixerLevel;
  /** Jedno zdanie dla analityka. */
  statement: string;
  /** Nazwy mikserów (usług) z przekazań oznaczonych etykietą. */
  mixers: string[];
  outgoing: MixerTransfer[];
  incoming: MixerTransfer[];
  coinjoins: CoinJoinParticipation[];
  traceStops: MixerTraceStop[];
  sanctions: MixerSanctionHit[];
  totals: {
    /** Liczba transakcji z udziałem miksera (przekazania w obie strony + CoinJoin). */
    transactions: number;
    outCount: number;
    inCount: number;
    outPln?: number;
    inPln?: number;
    /** Przekazania bez kursu — nie są wliczone do sum PLN. */
    unvalued: number;
  };
  /** Adresy sprawy, których dotyczy ekspozycja. */
  addresses: string[];
  limitations: string[];
}

/** Jawne reguły heurystyki CoinJoin — jedyne miejsce z progami. */
export const COINJOIN_RULES = {
  /** Od tylu wyjść o identycznej kwocie w jednej transakcji mówimy o wzorcu CoinJoin. */
  minEqualOutputs: 3,
  /** …do co najmniej tylu różnych adresów. */
  minDistinctCounterparties: 3,
  /** Nominały pul Whirlpool (Samourai) w BTC; wyjścia przygotowania (Tx0) są o opłatę wyższe. */
  whirlpoolPools: [0.001, 0.01, 0.05, 0.5],
  whirlpoolTolerance: 0.01,
  /** Wasabi 1.x: wiele równych wyjść ok. 0,1 BTC. */
  wasabi: { denomination: 0.1, tolerance: 0.002, minEqualOutputs: 10 },
  /** Heurystykę stosujemy tylko w sieciach UTXO — w modelu kont równe przelewy to zwykle wypłaty zbiorcze. */
  networks: ['bitcoin', 'bitcoin-testnet'],
} as const;

export const MIXER_PRIVACY_NOTE = 'Użycie miksera lub CoinJoin może być legalną ochroną prywatności — samo w sobie nie świadczy o niczym poza tym, że środki przeszły przez mikser.';
export const MIXER_SCOPE_NOTE = 'Narzędzie stwierdza wyłącznie, że środki przeszły przez mikser — dalszej drogi nie da się ustalić z blockchainu. Z tego faktu nie wyciąga żadnych wniosków o osobie.';
const COINJOIN_NOTE =
  `Heurystyka CoinJoin: w jednej transakcji co najmniej ${COINJOIN_RULES.minEqualOutputs} wyjścia o identycznej kwocie do różnych adresów (wiele równych wyjść ukrywa, które należy do którego uczestnika), ` +
  'albo ostrzeżenie modułu śledzenia: co najmniej 3 adresy na wejściach i 3 równe wyjścia. Wypłaty zbiorcze usług i płatności grupowe mogą wyglądać podobnie — to hipoteza do weryfikacji.';

/** Przelew z polami dodatkowymi modułu blockchain (poza kontraktem core). */
type ChainTransfer = Transfer & { counterpartyLabelSource?: string; counterpartyLabelInferred?: boolean };

const MIXER_WARNING = /OSTRZEŻENIE — mikser: środki trafiły do „([^”]+)” \(([^,]+), tx ([^)]+)\)/;
const COINJOIN_LABEL = 'transakcja typu CoinJoin';
const HEURISTIC_SOURCE = /WalletExplorer|rozpoznana po nazwie|heurysty/i;
const round2 = (value: number) => Math.round(value * 100) / 100;
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const txRefs = (txids: string[]): EvidenceRef[] => unique(txids).map((value) => ({ kind: 'txid' as const, value }));
const transakcja = (count: number) => `${count} ${plural(count, 'transakcja', 'transakcje', 'transakcji')}`;
const przelew = (count: number) => `${count} ${plural(count, 'przelew', 'przelewy', 'przelewów')}`;

/** Status etykiety miksera według jej pochodzenia. */
export function mixerLabelStatus(labelSource: string | undefined): ClaimStatus {
  if (labelSource && /https?:\/\//i.test(labelSource)) return 'source_fact';
  if (labelSource && HEURISTIC_SOURCE.test(labelSource)) return 'hypothesis';
  return 'computed';
}

/** Wzorzec znanej implementacji CoinJoin po kwocie równych wyjść (BTC). */
export function coinjoinPattern(amount: number, count: number): CoinJoinParticipation['pattern'] {
  if (COINJOIN_RULES.whirlpoolPools.some((pool) => amount >= pool && amount <= pool * (1 + COINJOIN_RULES.whirlpoolTolerance))) return 'whirlpool';
  const { denomination, tolerance, minEqualOutputs } = COINJOIN_RULES.wasabi;
  if (count >= minEqualOutputs && Math.abs(amount - denomination) <= tolerance) return 'wasabi';
  return undefined;
}

const PATTERN_TEXT: Record<NonNullable<CoinJoinParticipation['pattern']>, string> = {
  whirlpool: 'kwota zgodna z nominałem puli Whirlpool (Samourai)',
  wasabi: 'wzorzec zbliżony do Wasabi 1.x (wiele równych wyjść ok. 0,1 BTC)',
};

/**
 * Transakcje adresu wyglądające na CoinJoin: w jednej transakcji co najmniej trzy przelewy o identycznej kwocie
 * do różnych adresów, bez adresu oznaczonej usługi (wypłata zbiorcza giełdy wyglądałaby podobnie).
 */
export function coinjoinLike(network: string, address: string, transfers: Transfer[]): CoinJoinParticipation[] {
  if (!(COINJOIN_RULES.networks as readonly string[]).includes(network)) return [];
  const byTx = new Map<string, Transfer[]>();
  for (const item of transfers) byTx.set(item.txid, [...(byTx.get(item.txid) ?? []), item]);
  const result: CoinJoinParticipation[] = [];
  for (const [txid, items] of byTx) {
    if (items.length < COINJOIN_RULES.minEqualOutputs) continue;
    if (items.some((item) => item.counterpartyClass !== 'unknown' && item.counterpartyClass !== 'private')) continue;
    const byAmount = new Map<number, Transfer[]>();
    for (const item of items) {
      if (!(item.amount > 0)) continue;
      const key = round8(item.amount);
      byAmount.set(key, [...(byAmount.get(key) ?? []), item]);
    }
    const [amount, equal] = [...byAmount.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [0, []];
    const parties = new Set(equal.map((item) => item.counterparty)).size;
    if (equal.length < COINJOIN_RULES.minEqualOutputs || parties < COINJOIN_RULES.minDistinctCounterparties) continue;
    const asset = equal[0]!.asset;
    const pattern = asset.toUpperCase() === 'BTC' ? coinjoinPattern(amount, equal.length) : undefined;
    result.push({
      address,
      network,
      txid,
      time: equal[0]!.time,
      explorerUrl: equal[0]!.explorerUrl,
      basis: 'equal_outputs',
      equalOutputs: equal.length,
      denomination: amount,
      asset,
      ...(pattern ? { pattern } : {}),
      status: 'hypothesis',
      explanation:
        `HIPOTEZA: w transakcji ${shortAddress(txid)} adres ma ${equal.length} przelewy o identycznej kwocie ${formatAmount(amount)} ${asset} do ${parties} różnych adresów — ` +
        `wzorzec typowy dla CoinJoin (wiele równych wyjść ukrywa, które należy do którego uczestnika)${pattern ? `; ${PATTERN_TEXT[pattern]}` : ''}. ` +
        'Wypłata zbiorcza albo płatność grupowa może wyglądać podobnie.',
    });
  }
  return result;
}

/** Ostrzeżenia „OSTRZEŻENIE — mikser” zapisane przez moduł śledzenia środków. */
export function traceStopsOf(finding: Finding, outgoingTxids: Set<string>): MixerTraceStop[] {
  const stops: MixerTraceStop[] = [];
  for (const text of finding.chain?.limitations ?? []) {
    const match = MIXER_WARNING.exec(text);
    if (!match) continue;
    const [, label, mixerAddress, txid] = match;
    const coinjoin = label === COINJOIN_LABEL;
    if (stops.some((item) => item.txid === txid && item.mixerAddress === mixerAddress)) continue;
    stops.push({
      address: finding.address,
      network: finding.network,
      mixerAddress: mixerAddress!,
      ...(coinjoin ? {} : { mixerLabel: label! }),
      txid: txid!,
      coinjoin,
      direct: outgoingTxids.has(txid!),
      text,
    });
  }
  return stops;
}

export interface MixerInput {
  findings: Finding[];
  /** Adresy liczone jako powiązane z podmiotem (`sieć:adres`). */
  linkedKeys: Set<string>;
  /** Wszystkie adresy teczki — źródło kursów z istniejących wycen. */
  allFindings?: Finding[];
  /** Sprawdzenie adresów na listach sankcyjnych; domyślnie lokalne migawki list. */
  sanctionsCheck?: (addresses: string[]) => RiskAddressFlag[];
}

/** Ekspozycja adresów sprawy na miksery i CoinJoin. */
export function buildMixerExposure(input: MixerInput): MixerExposure {
  const valuations = valuationsOf(input.allFindings ?? input.findings);
  const outgoing: MixerTransfer[] = [];
  const incoming: MixerTransfer[] = [];
  const coinjoins: CoinJoinParticipation[] = [];
  const traceStops: MixerTraceStop[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    const key = addressKey(finding);
    if (seen.has(key) || !input.linkedKeys.has(key) || finding.confidence.excluded) continue;
    seen.add(key);
    // Adres giełdy, miksera czy kontraktu nie jest portfelem podmiotu — jego przepływy nie są ekspozycją podmiotu.
    const addressClass = finding.chain?.profile.addressClass;
    if (addressClass !== undefined && addressClass !== 'private' && addressClass !== 'unknown') continue;
    const transfers = (finding.chain?.transfers ?? []) as ChainTransfer[];
    for (const transfer of transfers) {
      if (transfer.counterpartyClass !== 'mixer') continue;
      const label = transfer.counterpartyLabel ?? 'Mikser bez etykiety';
      const rate = transfer.asset.includes('niezweryfikowany') ? undefined : rateFor(transfer.asset, transfer.time, valuations);
      const labelSource = transfer.counterpartyLabelSource ?? 'klasa adresu podana przez źródło danych (bez wskazanego publicznego źródła etykiety)';
      const item: MixerTransfer = {
        direction: transfer.direction === 'out' ? 'to_mixer' : 'from_mixer',
        address: finding.address,
        network: finding.network,
        txid: transfer.txid,
        time: transfer.time,
        asset: transfer.asset,
        amount: transfer.amount,
        ...(rate ? { valuePln: round2(transfer.amount * rate.rate), rateNote: rate.note } : {}),
        mixerAddress: transfer.counterparty,
        mixerLabel: label,
        mixerName: resolveService(label.replace(/^.*— /, ''), 'mixer').name,
        labelSource,
        status: mixerLabelStatus(transfer.counterpartyLabelSource),
        explorerUrl: transfer.explorerUrl,
      };
      (item.direction === 'to_mixer' ? outgoing : incoming).push(item);
    }
    const outTxids = new Set(outgoing.filter((item) => item.address === finding.address).map((item) => item.txid));
    const stops = traceStopsOf(finding, outTxids);
    traceStops.push(...stops);
    const own = coinjoinLike(finding.network, finding.address, transfers);
    coinjoins.push(...own);
    for (const stop of stops.filter((item) => item.coinjoin)) {
      if (coinjoins.some((item) => item.txid === stop.txid)) continue;
      const via = stop.mixerAddress !== finding.address ? stop.mixerAddress : undefined;
      coinjoins.push({
        address: finding.address,
        network: finding.network,
        txid: stop.txid,
        basis: 'trace',
        ...(via ? { via } : {}),
        status: 'hypothesis',
        explanation: via
          ? `HIPOTEZA: środki z adresu trafiły przez adres pośredni ${shortAddress(via)} do transakcji ${shortAddress(stop.txid)} wyglądającej na CoinJoin (co najmniej 3 adresy na wejściach i 3 równe wyjścia).`
          : `HIPOTEZA: adres wydał środki w transakcji ${shortAddress(stop.txid)} wyglądającej na CoinJoin (co najmniej 3 adresy na wejściach i 3 równe wyjścia).`,
      });
    }
  }

  // Listy sankcyjne: wyłącznie fakt o liście z lokalnej migawki.
  const mixerAddresses = unique([...outgoing, ...incoming].map((item) => item.mixerAddress));
  let flags: RiskAddressFlag[] = [];
  const sanctionNotes: string[] = [];
  if (mixerAddresses.length > 0) {
    try {
      flags = (input.sanctionsCheck ?? ((addresses) => riskListAddressFlags(addresses)))(mixerAddresses);
    } catch {
      sanctionNotes.push('Nie udało się sprawdzić adresów mikserów na listach sankcyjnych (błąd odczytu migawek list) — brak informacji to nie brak wpisu.');
    }
  }
  const sanctions: MixerSanctionHit[] = [];
  for (const flag of flags) {
    if (sanctions.some((item) => item.mixerAddress === flag.address && item.entryId === flag.entryId && item.list === flag.listLabel)) continue;
    sanctions.push({ mixerAddress: flag.address, list: flag.listLabel, entryId: flag.entryId, entryName: flag.entryName, retrievedAt: flag.retrievedAt, ...(flag.url ? { url: flag.url } : {}), caveat: flag.caveat });
  }

  const labelled = outgoing.length + incoming.length > 0;
  const indirect = traceStops.some((item) => !item.coinjoin && !item.direct);
  const level: MixerLevel = labelled ? 'confirmed' : coinjoins.length > 0 || indirect ? 'possible' : 'none';
  const sumPln = (items: MixerTransfer[]) => (items.some((item) => item.valuePln !== undefined) ? round2(items.reduce((total, item) => total + (item.valuePln ?? 0), 0)) : undefined);
  const outPln = sumPln(outgoing);
  const inPln = sumPln(incoming);
  const transactions = new Set([...outgoing, ...incoming].map((item) => item.txid).concat(coinjoins.map((item) => item.txid))).size;
  const unvalued = [...outgoing, ...incoming].filter((item) => item.valuePln === undefined).length;
  const mixers = unique([...outgoing, ...incoming].map((item) => item.mixerName));
  const addresses = unique([...outgoing, ...incoming, ...coinjoins].map((item) => item.address).concat(traceStops.filter((item) => !item.coinjoin && !item.direct).map((item) => item.address)));

  const limitations: string[] = [];
  if (level !== 'none') {
    limitations.push(MIXER_SCOPE_NOTE, MIXER_PRIVACY_NOTE);
    if (coinjoins.length > 0) limitations.push(COINJOIN_NOTE);
    if (indirect) limitations.push('Mikser za adresem pośrednim wskazało śledzenie środków (reguła adresu przelotowego) — to wnioskowanie, nie bezpośredni przelew z adresu sprawy.');
    if (unvalued > 0) limitations.push(`${przelew(unvalued)} z udziałem miksera bez kursu — nie są wliczone do sum PLN.`);
    if (mixerAddresses.length > 0) {
      limitations.push(
        'Adresy mikserów porównano wyłącznie z lokalnymi migawkami list sankcyjnych (OFAC SDN i inne). Trafienie to fakt o liście z dnia migawki; ' +
          'brak trafienia nie przesądza o aktualnym statusie — sprawdź bieżącą wersję listy.',
      );
    }
    limitations.push(...sanctionNotes);
  }

  // Kwota w zdaniu: wartość przekazań DO miksera (a bez nich — Z miksera); sumy obu kierunków nie łączymy.
  const amountText = outPln !== undefined && outPln > 0 ? `, ok. ${roundPln(outPln)} do miksera` : inPln !== undefined && inPln > 0 ? `, ok. ${roundPln(inPln)} z miksera` : '';
  const statement =
    level === 'confirmed'
      ? `Środki przeszły przez mikser (${mixers.join(', ')}, ${transakcja(new Set([...outgoing, ...incoming].map((item) => item.txid)).size)}${amountText}) — dalszej drogi nie da się ustalić z blockchainu.` +
        (incoming.length > 0 ? ' Część środków przyszła z miksera — pochodzenie środków zatarte.' : '')
      : level === 'possible'
        ? `Możliwy udział w mikserze lub transakcji typu CoinJoin (${transakcja(transactions || traceStops.length)}; heurystyka) — hipoteza do weryfikacji; jeśli tak, dalszej drogi środków nie da się ustalić z blockchainu.`
        : 'Brak przesłanek, że środki adresów sprawy przeszły przez mikser lub transakcję typu CoinJoin (w pobranych danych).';

  return {
    level,
    statement,
    mixers,
    outgoing,
    incoming,
    coinjoins,
    traceStops,
    sanctions,
    totals: { transactions, outCount: outgoing.length, inCount: incoming.length, ...(outPln !== undefined ? { outPln } : {}), ...(inPln !== undefined ? { inPln } : {}), unvalued },
    addresses,
    limitations,
  };
}

// ---------- Wskaźniki C i D ----------

const component = (rule: string, direction: ScoreComponent['direction'], evidence: EvidenceRef[], explanation: string, limitations: string[]): ScoreComponent => ({
  rule,
  weight: 0,
  applied: 0,
  direction,
  source: 'moduł danych blockchain (miksery i CoinJoin)',
  evidence,
  explanation,
  independence: 'not_applicable',
  independenceNote: 'Składnik informacyjny — nie zmienia wyniku wskaźnika.',
  limitations,
});

/**
 * Składniki wskaźnika C dla adresów z ekspozycją: `cashout.mixer_obfuscation` (droga do walut tradycyjnych przerwana)
 * i `cashout.mixer_inflow` (pochodzenie środków zatarte). Waga 0 — opisują ograniczenie, nie zmieniają wyniku.
 */
export function applyMixerIndicators(indicators: InvestigationIndicators, exposure: MixerExposure): void {
  if (exposure.level === 'none') return;
  for (const address of exposure.addresses) {
    const own = indicators.cashOut.filter((item) => item.address === address && item.origin !== 'web');
    const target: CashOutAssessment | undefined = own.find((item) => item.id.endsWith(':onchain')) ?? own[0];
    if (!target) continue;
    const out = exposure.outgoing.filter((item) => item.address === address);
    const cj = exposure.coinjoins.filter((item) => item.address === address);
    const stops = exposure.traceStops.filter((item) => item.address === address && !item.coinjoin && !item.direct);
    const added: ScoreComponent[] = [];
    if (out.length + cj.length + stops.length > 0) {
      const parts = [
        out.length > 0 ? `${przelew(out.length)} na adres miksera (${unique(out.map((item) => item.mixerName)).join(', ')})` : '',
        cj.length > 0 ? `${transakcja(cj.length)} wyglądające na CoinJoin (hipoteza)` : '',
        stops.length > 0 ? `${stops.length} ${plural(stops.length, 'ścieżka urwana', 'ścieżki urwane', 'ścieżek urwanych')} na mikserze za adresem pośrednim (wnioskowanie)` : '',
      ].filter(Boolean);
      added.push(
        component(
          'cashout.mixer_obfuscation',
          'contradicts',
          txRefs([...out.map((item) => item.txid), ...cj.map((item) => item.txid), ...stops.map((item) => item.txid)]),
          `Droga do walut tradycyjnych przerwana: ${parts.join('; ')}. Środki przeszły przez mikser — dalszej drogi nie da się ustalić z blockchainu. Składnik nie zmienia wyniku: ogranicza to, co można wykazać.`,
          [MIXER_SCOPE_NOTE, MIXER_PRIVACY_NOTE],
        ),
      );
    }
    const inflow = exposure.incoming.filter((item) => item.address === address);
    if (inflow.length > 0) {
      added.push(
        component(
          'cashout.mixer_inflow',
          'supports',
          txRefs(inflow.map((item) => item.txid)),
          `Nota o pochodzeniu środków: ${przelew(inflow.length)} z miksera (${unique(inflow.map((item) => item.mixerName)).join(', ')}) — pochodzenie środków zatarte. To nie jest przesłanka wypłaty i nie zmienia wyniku.`,
          ['Przelew z miksera nie wskazuje nadawcy, który wpłacił środki do miksera.', MIXER_PRIVACY_NOTE],
        ),
      );
    }
    if (added.length === 0) continue;
    target.indicator.components.push(...added);
    target.indicator.limitations = unique([...target.indicator.limitations, 'Część środków przeszła przez mikser — dalszej drogi tych środków nie da się ustalić z blockchainu.']);
  }
  // Wskaźnik D: wyłącznie kontekst, bez punktów.
  const business = indicators.businessActivity;
  if (business) {
    business.indicator.components.push(
      component(
        'business.mixer_use',
        'supports',
        txRefs([...exposure.outgoing, ...exposure.incoming, ...exposure.coinjoins].map((item) => item.txid)).slice(0, 10),
        `Kontekst: ${exposure.level === 'confirmed' ? 'środki przeszły przez mikser' : 'możliwy udział w mikserze lub CoinJoin (hipoteza)'}. Nie jest przesłanką działalności gospodarczej i nie zmienia wyniku — wpływy z miksera mają zatarte pochodzenie.`,
        [MIXER_PRIVACY_NOTE],
      ),
    );
  }
}

// ---------- Graf ----------

/** Węzeł miksera w grafie: węzeł usługi z oznaczeniem rodzaju (styl i ikona w interfejsie). */
export type MixerGraphNode = GraphNode & { mixer: { kind: 'labelled' | 'coinjoin' } };

const MIXER_SUBLABEL = 'mikser — dalsza droga środków nieustalona';

/** Węzły mikserów (oznaczone i CoinJoin) z krawędziami „do miksera” / „z miksera” w warstwie blockchain. */
export function applyMixerGraph(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, exposure: MixerExposure, serviceLinks: ServiceLink[]): void {
  if (exposure.level === 'none') return;
  const ensureNode = (id: string, label: string, kind: 'labelled' | 'coinjoin', status?: ClaimStatus, url?: string): void => {
    const existing = graph.nodes.find((node) => node.id === id);
    if (existing) {
      existing.sublabel = MIXER_SUBLABEL;
      (existing as MixerGraphNode).mixer = { kind };
      return;
    }
    const node: MixerGraphNode = {
      id,
      kind: 'service',
      label,
      sublabel: kind === 'coinjoin' ? 'CoinJoin — hipoteza (heurystyka)' : MIXER_SUBLABEL,
      ...(status ? { status } : {}),
      ...(url ? { url } : {}),
      mixer: { kind },
    };
    graph.nodes.push(node);
  };
  const addressNode = (network: string, address: string) => `addr:${addressKey({ network, address })}`;
  const linkOf = (name: string) => serviceLinks.find((item) => item.kind === 'mixer' && (item.name === name || item.id === serviceIdOf(name)));

  // (a), (c): przekazania do i z oznaczonego miksera.
  const groups = new Map<string, MixerTransfer[]>();
  for (const item of [...exposure.outgoing, ...exposure.incoming]) {
    const key = `${item.direction}|${item.network}|${item.address}|${item.mixerName}`;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  for (const items of groups.values()) {
    const first = items[0]!;
    const nodeId = `svc:${linkOf(first.mixerName)?.id ?? serviceIdOf(first.mixerName)}`;
    ensureNode(nodeId, first.mixerName, 'labelled');
    const from = first.direction === 'to_mixer' ? addressNode(first.network, first.address) : nodeId;
    const to = first.direction === 'to_mixer' ? nodeId : addressNode(first.network, first.address);
    const prefix = first.direction === 'to_mixer' ? 'do miksera' : 'z miksera';
    const pln = items.reduce((total, item) => total + (item.valuePln ?? 0), 0);
    const explanation =
      first.direction === 'to_mixer'
        ? `Przelewy na adres oznaczony jako mikser (${first.mixerLabel}; etykieta: ${first.labelSource}). Środki przeszły przez mikser — dalszej drogi nie da się ustalić z blockchainu.`
        : `Przelewy z adresu oznaczonego jako mikser (${first.mixerLabel}; etykieta: ${first.labelSource}) — pochodzenie środków zatarte.`;
    const edges = graph.edges.filter((edge) => edge.from === from && edge.to === to);
    if (edges.length > 0) {
      for (const edge of edges) {
        const base = edge.label ?? przelew(items.length);
        if (!edge.label?.startsWith(prefix)) edge.label = `${prefix}: ${base}${pln > 0 && !/ok\./.test(base) ? `, ok. ${roundPln(pln)}` : ''}`;
        edge.layer = 'chain';
        edge.explanation = explanation;
      }
      continue;
    }
    const statuses = unique(items.map((item) => item.status));
    graph.edges.push({
      id: `mixer:${from}->${to}`,
      from,
      to,
      kind: 'transfer',
      label: `${prefix}: ${przelew(items.length)}${pln > 0 ? `, ok. ${roundPln(pln)}` : ''}`,
      weight: 60,
      status: statuses.includes('hypothesis') ? 'hypothesis' : items.length === 1 && pln === 0 && statuses[0] === 'source_fact' ? 'source_fact' : 'computed',
      evidence: [...txRefs(items.map((item) => item.txid)).slice(0, 10), { kind: 'address', value: first.mixerAddress }],
      explanation,
      layer: 'chain',
    });
  }

  // (d): mikser za adresem pośrednim — krawędź hipotezy od adresu sprawy.
  for (const stop of exposure.traceStops.filter((item) => !item.coinjoin && !item.direct)) {
    const name = resolveService(stop.mixerLabel ?? 'Mikser', 'mixer').name;
    const nodeId = `svc:${linkOf(name)?.id ?? serviceIdOf(name)}`;
    ensureNode(nodeId, name, 'labelled');
    const from = addressNode(stop.network, stop.address);
    const id = `mixer:${from}->${nodeId}:posrednio`;
    if (graph.edges.some((edge) => edge.id === id)) continue;
    graph.edges.push({
      id,
      from,
      to: nodeId,
      kind: 'transfer',
      label: 'do miksera (przez adres pośredni)',
      weight: 30,
      inferred: true,
      status: 'hypothesis',
      evidence: [{ kind: 'txid', value: stop.txid }, { kind: 'address', value: stop.mixerAddress }],
      explanation: `Śledzenie środków urwało się na mikserze za adresem pośrednim (wnioskowanie z reguły adresu przelotowego). ${stop.text}`,
      layer: 'chain',
    });
  }

  // (b): CoinJoin — osobny węzeł hipotezy na każdą transakcję.
  for (const item of exposure.coinjoins) {
    const nodeId = `coinjoin:${item.network}:${item.txid}`;
    ensureNode(nodeId, 'Transakcja typu CoinJoin', 'coinjoin', 'hypothesis', item.explorerUrl);
    const from = addressNode(item.network, item.address);
    const id = `mixer:${from}->${nodeId}`;
    if (graph.edges.some((edge) => edge.id === id)) continue;
    graph.edges.push({
      id,
      from,
      to: nodeId,
      kind: 'transfer',
      label: item.equalOutputs ? `do CoinJoin: ${item.equalOutputs} × ${formatAmount(item.denomination!)} ${item.asset} (hipoteza)` : 'do CoinJoin (hipoteza)',
      weight: 30,
      inferred: true,
      status: 'hypothesis',
      evidence: [{ kind: 'txid', value: item.txid }],
      explanation: item.explanation,
      layer: 'chain',
    });
  }
}

/** Całość dla teczki: ekspozycja, składniki wskaźników C i D, węzły w grafie. */
export function applyMixerExposure(input: MixerInput & { graph: { nodes: GraphNode[]; edges: GraphEdge[] }; indicators: InvestigationIndicators; serviceLinks: ServiceLink[] }): MixerExposure {
  const exposure = buildMixerExposure(input);
  applyMixerIndicators(input.indicators, exposure);
  applyMixerGraph(input.graph, exposure, input.serviceLinks);
  return exposure;
}

// ---------- Kluczowe ustalenia i raport ----------

/** Fakt dla oznaczonego miksera, wniosek dla samej heurystyki. */
export function mixerKeyFindings(exposure: MixerExposure | undefined): { text: string; layer: 'fact' | 'inference' }[] {
  if (!exposure || exposure.level === 'none') return [];
  const result: { text: string; layer: 'fact' | 'inference' }[] = [];
  if (exposure.level === 'confirmed') {
    const { outPln, inPln } = exposure.totals;
    const parts = [
      exposure.totals.outCount > 0 ? `${przelew(exposure.totals.outCount)} do miksera${outPln ? ` (ok. ${roundPln(outPln)})` : ''}` : '',
      exposure.totals.inCount > 0 ? `${przelew(exposure.totals.inCount)} z miksera${inPln ? ` (ok. ${roundPln(inPln)})` : ''} — pochodzenie środków zatarte` : '',
    ].filter(Boolean);
    const listed = exposure.sanctions.map((item) => ` Adres miksera ${shortAddress(item.mixerAddress)} figuruje na liście ${item.list} (wpis ${item.entryId}: „${item.entryName}”, migawka z ${item.retrievedAt.slice(0, 10)}) — fakt o liście.`).join('');
    result.push({
      text: `Środki przeszły przez mikser (${exposure.mixers.join(', ')}): ${parts.join('; ')}. Dalszej drogi tych środków nie da się ustalić z blockchainu.${listed}`,
      layer: 'fact',
    });
  }
  const cj = exposure.coinjoins.length;
  const indirect = exposure.traceStops.filter((item) => !item.coinjoin && !item.direct).length;
  if (cj + indirect > 0) {
    result.push({
      text:
        `Możliwy udział w ${cj > 0 ? `${cj} ${plural(cj, 'transakcji', 'transakcjach', 'transakcjach')} typu CoinJoin (heurystyka równych wyjść)` : ''}${cj > 0 && indirect > 0 ? ' oraz ' : ''}${indirect > 0 ? 'mikserze za adresem pośrednim (śledzenie środków)' : ''} — ` +
        'hipoteza do weryfikacji; jeśli tak, dalszej drogi środków nie da się ustalić z blockchainu.',
      layer: 'inference',
    });
  }
  return result;
}

const STATUS_TEXT: Record<string, string> = { source_fact: 'fakt źródłowy', computed: 'etykieta dostawcy danych', hypothesis: 'hipoteza' };

/** Sekcja raportu „Miksery i CoinJoin”; pusta, gdy brak ekspozycji. */
export function renderMixerSection(exposure: MixerExposure | undefined): string {
  if (!exposure || exposure.level === 'none') return '';
  const rows = [...exposure.outgoing, ...exposure.incoming]
    .sort((a, b) => a.time.localeCompare(b.time))
    .map(
      (item) => `<tr><td>${dateTime(item.time)}</td><td>${item.direction === 'to_mixer' ? 'do miksera' : 'z miksera'}</td>
        <td class="mono">${esc(shortAddress(item.address))}<br><span class="meta">${esc(NETWORK_LABEL[item.network] ?? item.network)}</span></td>
        <td>${esc(item.mixerLabel)}<br><span class="mono">${esc(item.mixerAddress)}</span><br><span class="meta">etykieta: ${esc(item.labelSource)} (${esc(STATUS_TEXT[item.status] ?? item.status)})</span></td>
        <td class="liczba">${esc(formatAmount(item.amount))} ${esc(item.asset)}</td>
        <td class="liczba">${item.valuePln !== undefined ? `${esc(formatPln(item.valuePln))}${item.rateNote ? `<br><span class="meta">${esc(item.rateNote)}</span>` : ''}` : '—'}</td>
        <td class="mono">${link(item.explorerUrl, shortAddress(item.txid))}</td></tr>`,
    )
    .join('');
  const table =
    rows.length > 0
      ? fact(`<p>${esc(exposure.statement)}</p>
        <table><tr><th>Data i czas</th><th>Kierunek</th><th>Adres sprawy</th><th>Mikser (etykieta i jej źródło)</th><th class="liczba">Kwota</th><th class="liczba">Szacunek PLN</th><th>Transakcja</th></tr>${rows}</table>`)
      : '';
  const sanctions =
    exposure.sanctions.length > 0
      ? fact(`<h4>Adresy mikserów na listach sankcyjnych (fakt o liście)</h4><ul>${exposure.sanctions
          .map((item) => `<li><span class="mono">${esc(item.mixerAddress)}</span> — ${esc(item.list)}, wpis ${esc(item.entryId)} („${esc(item.entryName)}”)${item.url ? `, ${link(item.url, 'wpis')}` : ''}. ${esc(item.caveat)}</li>`)
          .join('')}</ul>`)
      : '';
  const heuristics =
    exposure.coinjoins.length + exposure.traceStops.filter((item) => !item.direct).length > 0
      ? inference(`<h4>Hipotezy: CoinJoin i mikser za adresem pośrednim</h4><ul>${[
          ...exposure.coinjoins.map((item) => `<li>${esc(item.explanation)} ${item.explorerUrl ? link(item.explorerUrl, `tx ${shortAddress(item.txid)}`) :`<span class="mono">${esc(item.txid)}</span>`}</li>`),
          ...exposure.traceStops.filter((item) => !item.direct && !item.coinjoin).map((item) => `<li>${esc(item.text)}</li>`),
        ].join('')}</ul>`)
      : '';
  return `<h2>Miksery i CoinJoin</h2>
${table}
${sanctions}
${heuristics}
<p class="meta">${exposure.limitations.map((item) => esc(item)).join(' ')}</p>`;
}
