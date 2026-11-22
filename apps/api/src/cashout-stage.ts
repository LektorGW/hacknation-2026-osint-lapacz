// Wskaźnik C — wyjście do walut tradycyjnych: drabina dowodowa od samej transakcji w blockchainie
// do udokumentowanego wyjścia do fiat. Szczegóły w `packages/core/src/indicators.ts`.
//
// Szczeble (żaden nie jest pomijany bez dowodu):
//   onchain_transfer      — przelewy wychodzące na adresy bez etykiety usługi wymiany; sama transakcja,
//                           nic nie mówi o walutach tradycyjnych;
//   service_interaction   — bezpośredni przelew na adres publicznie oznaczony jako usługa (giełda, P2P,
//                           bramka, karta) — z etykietą, jej źródłem i identyfikatorami transakcji;
//   cashout_signal        — mocniejszy wzorzec: udokumentowana ścieżka do usługi (także przez indywidualny
//                           adres wpłat), zamiana na stablecoin i wpłata, powtarzalne wpłaty;
//   documented_fiat_exit  — WYŁĄCZNIE gdy analityk przyjął dokumentację spoza blockchaina (`documentedExits`)
//                           albo wprowadził odpowiedź usługi z wypłatą na rachunek (`replyExits`).
// Same dane blockchain nigdy nie dają ostatniego szczebla: wypłatę na rachunek potwierdza tylko usługa.
// Przelewy PRZYCHODZĄCE z usługi to źródło środków, nie wyjście do fiat.
//
// Oznaki z publikacji kont podmiotu (Web2: oferty sprzedaży za PLN, BLIK, gotówka, karty krypto, nazwane
// usługi) — osobna ocena `origin: 'web'` z `fiat-signals.ts`; także one dochodzą najwyżej do `cashout_signal`.
// Każda ocena ma „Dlaczego to oznaka wypłaty” (`why`) i „Co potwierdzi wypłatę” (`confirm`).

import { CASH_OUT_STAGE_LABEL, combineComponents } from '@olcys/core';
import type { CashOutAssessment, CashOutIndicator, CashOutKind, CashOutStage, CashOutTrail, ClaimStatus, ComponentDraft, EvidenceRef, Finding, ServiceLink, Transfer } from '@olcys/core';
import type { RegistryData } from '@olcys/sources';
import { FIAT_WEB_RULES, buildWebCashOutAssessment, confirmationServices, offrampInfo, webServiceRefs } from './fiat-signals.ts';
import type { FiatPublication } from './fiat-signals.ts';
import { formatAmount, formatDate, plural, roundPln, shortAddress } from './format.ts';
import { resolveService, serviceIdOf } from './services.ts';

export interface CashOutStageInput {
  /** Adresy teczki po korektach. */
  findings: Finding[];
  /** Adresy liczone jako powiązane z podmiotem (`network:address`). */
  linkedKeys: Set<string>;
  /** Chwila oceny — potrzebna regule „adres zamilkł po wpłacie”; bez niej reguły nie oceniamy. */
  now?: Date;
  /** Powiązania z usługami — gotowe wskazówki do zapytania w „Co potwierdzi wypłatę”. */
  serviceLinks?: ServiceLink[];
  /**
   * Publikacje kont PRZYPISANYCH PODMIOTOWI z oznakami wyjścia do fiat (Web2). Wzmianek innych autorów
   * wywołujący tu nie przekazuje. Dają osobną ocenę `origin: 'web'` i wzmacniają ocenę tej samej usługi z blockchaina.
   */
  publications?: FiatPublication[];
  /** Migawki rejestrów (RDWW, MiCA) do rozpoznania nazw usług; brak — z pakietu źródeł; `null` — bez sprawdzania. */
  registry?: RegistryData | null;
  /** Klucz oceny z publikacji (np. identyfikator sprawy). */
  webKey?: string;
  /** Adresy, dla których analityk potwierdził wyjście do fiat dokumentem spoza blockchaina (`network:address`). */
  documentedExits?: Set<string>;
  /**
   * Adresy, dla których wypłatę na rachunek potwierdziła ODPOWIEDŹ USŁUGI wprowadzona przez analityka
   * (`network:address` → odpowiedzi). Ocena dla tej usługi przechodzi na ostatni szczebel z odpowiedzią jako dowodem.
   */
  replyExits?: Map<string, DocumentedExitSource[]>;
}

/** Odpowiedź usługi dokumentująca wypłatę na rachunek — podstawa ostatniego szczebla wskaźnika C. */
export interface DocumentedExitSource {
  replyId: string;
  serviceName: string;
  /** Identyfikator usługi w teczce (`ServiceLink.id`). */
  serviceId: string;
  reference: string;
  receivedAt: string;
  /** Liczba wypłat na rachunek potwierdzonych przez usługę i ich suma słownie. */
  payouts: number;
  payoutSummary: string;
  /** Transakcje adresu objęte odpowiedzią. */
  txids: string[];
  /** Co najmniej jedna z wypłat nie wskazuje powiązanej wpłaty — dotyczy konta klienta, a nie konkretnej transakcji. */
  payoutNotTied?: boolean;
  /** Zastrzeżenie, gdy właścicielem konta jest według usługi inna osoba niż kandydat główny. */
  holderNote?: string;
}

const PAYOUT_NOT_TIED_NOTE = 'Wypłata wskazana w odpowiedzi nie jest powiązana z konkretną wpłatą — dokument potwierdza wypłatę z konta klienta, a nie z tej transakcji.';

/** Jawne reguły wskaźnika C — jedyne miejsce z wagami i progami. */
export const CASH_OUT_RULES = {
  weights: {
    /** Sam przelew na adres bez etykiety usługi: nie jest przesłanką wyjścia do fiat. */
    onchainTransfer: 5,
    /** Zamiana na stablecoin bez późniejszej wpłaty do usługi. */
    stablecoinSwapOnly: 15,
    /** Bezpośredni przelew na oznaczony adres usługi — według rodzaju usługi. */
    directServiceTransfer: { exchange_deposit: 40, p2p_service: 45, crypto_card: 45, payment_gateway: 30, stablecoin_swap: 0 } as Record<CashOutKind, number>,
    depositAddressInferred: 55,
    trailDocumented: 50,
    stablecoinSwap: 60,
    repeatedDeposits: 60,
    valuationAvailable: 5,
    documentedOffchain: 100,
    /** Zamiana na stablecoin o wartości od `largeStablecoinPln`, potem wpłata stablecoina do usługi. */
    stablecoinConversionLarge: 65,
    /** Ostatnia aktywność adresu to wpłata do usługi, potem cisza (≥ `quietDays`) — typowy obraz sprzedaży. */
    depositThenQuiet: 50,
    /** Wpłaty do tej samej usługi wyjścia do fiat w co najmniej `offrampMonthsMin` różnych miesiącach. */
    repeatedOfframp: 65,
    /** Wartość wpłat w PLN (kurs z dnia) bliska okrągłym kwotom — przesłanka słaba. */
    roundAmountsPln: 10,
    /** Przelew na adres oznaczony jako wydawca karty zasilanej kryptowalutami (doładowanie karty). */
    cryptoCardTopup: 55,
    /** Oznaki z publikacji kont podmiotu (Web2) — szczegóły w `fiat-signals.ts`. */
    web: FIAT_WEB_RULES.weights,
  },
  penalties: {
    inferredHop: 8,
    clusterOrigin: 10,
    labelHeuristic: 5,
    lowTrailConfidence: 10,
    serviceAlsoNonCustodial: 15,
    paymentGatewaySpend: 10,
    withdrawalsBack: 5,
    incomingOnly: 10,
    unverifiedAsset: 10,
  },
  /** Od tylu osobnych wpłat do tej samej usługi mówimy o wpłatach powtarzalnych. */
  repeatedMin: 3,
  /** Wpłata stablecoina do usługi liczy się jako „po zamianie”, gdy nastąpiła w ciągu tylu dni od zamiany. */
  swapToDepositDays: 7,
  /** Poniżej tej pewności ścieżki (wzór modułu blockchain) ścieżka jest słabą podstawą. */
  lowTrailConfidence: 60,
  stablecoins: ['USDT', 'USDC', 'DAI'],
  /** Próg ekspercki „znacznej wartości” zamiany na stablecoin (PLN, kurs z dnia transakcji) — edytowalny. */
  largeStablecoinPln: 50_000,
  /** Ile dni bez żadnej transakcji po wpłacie do usługi, by uznać, że adres zamilkł. */
  quietDays: 30,
  /** Saldo w walucie sieci nie większe niż taka część sumy wpływów = adres opróżniony. */
  quietBalanceShare: 0.01,
  /** Od tylu różnych miesięcy kalendarzowych z wpłatami mówimy o regularnym spieniężaniu. */
  offrampMonthsMin: 3,
  /** Kwota „okrągła”: wielokrotność tej kwoty w PLN… */
  roundStepPln: 1000,
  /** …z odchyleniem najwyżej tyle złotych i najwyżej `roundToleranceShare` wartości. */
  roundTolerancePln: 50,
  roundToleranceShare: 0.005,
  /** Ile wpłat o okrągłej wartości (i co najmniej połowa wycenionych), by reguła zadziałała. */
  roundMin: 2,
} as const;

/** Ograniczenie obowiązkowe dla każdej oceny poniżej szczebla „udokumentowane wyjście”. */
export const BANK_SIDE_LIMITATION =
  'Dane blockchain nie pokazują wypłaty na rachunek bankowy ani w gotówce. Wyjście do walut tradycyjnych może potwierdzić wyłącznie usługa ' +
  '(dane KYC właściciela konta, historia zleceń i wypłat — odpowiedź na zapytanie) albo dokument spoza blockchaina przyjęty przez analityka.';

const DOCUMENTED_LIMITATION =
  'Wyjście do walut tradycyjnych przyjęto na podstawie dokumentacji spoza blockchaina zaakceptowanej przez analityka; narzędzie nie weryfikuje treści tego dokumentu, ' +
  'a transakcje w blockchainie pokazują wyłącznie przekazanie środków.';

const REPLY_LIMITATION =
  'Wyjście do walut tradycyjnych przyjęto na podstawie odpowiedzi usługi wprowadzonej przez analityka (dokument spoza OSINT); narzędzie nie weryfikuje autentyczności ani treści tego dokumentu, ' +
  'a transakcje w blockchainie pokazują wyłącznie przekazanie środków.';

const SOURCE = 'moduł danych blockchain';
const STAGE_RANK: Record<CashOutStage, number> = { onchain_transfer: 0, service_interaction: 1, cashout_signal: 2, documented_fiat_exit: 3 };
const KIND_NAME: Record<CashOutKind, string> = {
  exchange_deposit: 'giełda',
  p2p_service: 'serwis wymiany bezpośredniej (P2P)',
  payment_gateway: 'bramka płatnicza',
  crypto_card: 'karta zasilana kryptowalutami',
  stablecoin_swap: 'zamiana na stablecoin',
};

/** Przelew z polami dodatkowymi modułu blockchain (poza kontraktem core). */
type ChainTransfer = Transfer & { counterpartyKind?: CashOutKind; counterpartyLabelSource?: string; counterpartyLabelInferred?: boolean };

const INFERRED_LABEL = /adres(?:u)? wpłat giełdy „([^”]+)”/i;
const INFERRED_EXPLANATION = /portfela giełdy „([^”]+)”/i;
const DEPOSIT_RULE = /adres(?:u)? wpłat/i;
const SWAP_RULE = /zamiana na stablecoin/i;
const HEURISTIC_LABEL_SOURCE = /WalletExplorer|rozpoznana po nazwie/i;
// Nazwa usługi, która prowadzi także portfel lub wymianę BEZ powiernictwa (klient sam trzyma klucze, brak konta i KYC).
const NON_CUSTODIAL = /(?<![\p{L}\p{N}])(dex|swap|defi|web3|router|bridge|aggregator|non-?custodial|self-?custody)(?![\p{L}\p{N}])/iu;
const DAY_MS = 86_400_000;
const round8 = (value: number) => Math.round(value * 1e8) / 1e8;
const round2 = (value: number) => Math.round(value * 100) / 100;
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const txRefs = (txids: string[]): EvidenceRef[] => unique(txids).map((value) => ({ kind: 'txid' as const, value }));
const isServiceKind = (kind: CashOutKind | undefined): kind is Exclude<CashOutKind, 'stablecoin_swap'> => kind !== undefined && kind !== 'stablecoin_swap';
const slug = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'usluga';
const przelew = (count: number) => `${count} ${plural(count, 'przelew', 'przelewy', 'przelewów')}`;

/** Jedna wpłata do usługi: bezpośrednia, przez wywnioskowany adres wpłat albo ścieżką. */
interface Deposit {
  /** Transakcja, którą środki opuściły adres podmiotu. */
  txid: string;
  /** Wszystkie transakcje tej wpłaty (kroki ścieżki). */
  txids: string[];
  time: string;
  asset: string;
  amount: number;
  valuePln?: number;
  mode: 'direct' | 'deposit_address' | 'trail';
  /** Adres usługi, na który trafiły środki (jeśli znany). */
  serviceAddress?: string;
  label?: string;
  labelSource?: string;
  /** Adres pośredni (wywnioskowany adres wpłat). */
  via?: string;
  inferred: boolean;
  fromCluster: boolean;
  viaSwap: boolean;
  confidence?: number;
  /** Token o niezweryfikowanym kontrakcie albo kwocie — nie jest podstawą oceny. */
  unverified: boolean;
}

interface ServiceBucket {
  name: string;
  kind: Exclude<CashOutKind, 'stablecoin_swap'>;
  deposits: Deposit[];
  incoming: ChainTransfer[];
}

interface Draft {
  assessment: CashOutAssessment;
  /** Czy ocena dotyczy usługi i ma wpłaty (może zostać podniesiona dokumentem analityka). */
  upgradable: boolean;
}

const sumAmounts = (items: { asset: string; amount: number; valuePln?: number }[]): { asset?: string; amount?: number; valuePln?: number; valued: number } => {
  const assets = unique(items.map((item) => item.asset));
  const valued = items.filter((item) => item.valuePln !== undefined);
  return {
    ...(assets.length === 1 ? { asset: assets[0]!, amount: round8(items.reduce((sum, item) => sum + item.amount, 0)) } : {}),
    ...(valued.length > 0 ? { valuePln: round2(valued.reduce((sum, item) => sum + item.valuePln!, 0)) } : {}),
    valued: valued.length,
  };
};

const describeSum = (sum: { asset?: string; amount?: number; valuePln?: number }): string =>
  (sum.amount !== undefined ? ` ${formatAmount(sum.amount)} ${sum.asset}` : ' środków w kilku walutach') + (sum.valuePln !== undefined ? ` (szacunkowo ${roundPln(sum.valuePln)})` : '');

/** Skąd pochodzi etykieta usługi na końcu ścieżki — moduł blockchain zapisuje to w pierwszym zdaniu uzasadnienia. */
const trailLabelSource = (trail: CashOutTrail): string | undefined => /etykieta(?: usługi)?: ([^.]+)\./.exec(trail.reasons[0] ?? '')?.[1];

function build(
  id: string,
  finding: Finding,
  stage: CashOutStage,
  status: ClaimStatus,
  drafts: ComponentDraft[],
  limitations: string[],
  statement: string,
  extra: { serviceName?: string; txids: string[]; asset?: string; amount?: number; valuePln?: number },
): CashOutAssessment {
  const confirmed = stage === 'documented_fiat_exit';
  return {
    id,
    address: finding.address,
    network: finding.network,
    stage,
    ...(extra.serviceName ? { serviceName: extra.serviceName } : {}),
    txids: unique(extra.txids),
    ...(extra.asset !== undefined && extra.amount !== undefined ? { asset: extra.asset, amount: extra.amount } : {}),
    ...(extra.valuePln !== undefined ? { valuePln: extra.valuePln } : {}),
    indicator: combineComponents('cash_out', drafts, { confirmed, limitations: unique(confirmed ? [DOCUMENTED_LIMITATION, ...limitations] : [BANK_SIDE_LIMITATION, ...limitations]) }),
    status,
    statement,
  };
}

/** Składnik i zdanie dla oceny podniesionej dokumentem spoza blockchaina. */
function documented(draft: Draft, key: string, replies: DocumentedExitSource[] = []): CashOutAssessment {
  const { assessment } = draft;
  if (replies.length > 0) return documentedByReply(assessment, replies);
  const component: ComponentDraft = {
    rule: 'cashout.documented_offchain',
    weight: CASH_OUT_RULES.weights.documentedOffchain,
    direction: 'supports',
    source: 'decyzja analityka',
    evidence: [{ kind: 'decision', value: key }],
    explanation: 'Analityk przyjął dokumentację spoza blockchaina (np. odpowiedź usługi, wyciąg bankowy) potwierdzającą wyjście do walut tradycyjnych dla tego adresu.',
    limitations: ['Podstawą jest dokument, nie dane blockchain; jego treść i zakres ocenia analityk.'],
  };
  const previous: ComponentDraft[] = assessment.indicator.components.map(({ applied: _applied, independence: _independence, ...rest }) => ({ ...rest, weight: Math.abs(rest.weight) }));
  const limitations = assessment.indicator.limitations.filter((item) => item !== BANK_SIDE_LIMITATION);
  const where = assessment.serviceName ? ` przez usługę ${assessment.serviceName}` : '';
  return {
    ...assessment,
    stage: 'documented_fiat_exit',
    status: 'confirmed',
    indicator: combineComponents('cash_out', [component, ...previous], { confirmed: true, limitations: unique([DOCUMENTED_LIMITATION, ...limitations]) }),
    statement:
      `${CASH_OUT_STAGE_LABEL.documented_fiat_exit[0]!.toUpperCase()}${CASH_OUT_STAGE_LABEL.documented_fiat_exit.slice(1)}: wyjście środków z adresu ${shortAddress(assessment.address)}${where} ` +
      'potwierdza dokumentacja spoza blockchaina przyjęta przez analityka. Dane blockchain pokazują przy tym wyłącznie przekazanie środków' +
      (assessment.txids.length > 0 ? ` (${przelew(assessment.txids.length)}).` : '; w pobranych danych nie ma transakcji przypisanych do tego wyjścia.'),
  };
}

/** Ocena podniesiona odpowiedzią usługi: dowodem jest dokument z sygnaturą, nie decyzja analityka o adresie. */
function documentedByReply(assessment: CashOutAssessment, replies: DocumentedExitSource[]): CashOutAssessment {
  const components: ComponentDraft[] = replies.map((reply) => ({
    rule: 'cashout.documented_service_reply',
    weight: CASH_OUT_RULES.weights.documentedOffchain,
    direction: 'supports' as const,
    source: `odpowiedź usługi ${reply.serviceName} (dokument spoza OSINT)`,
    originKey: `reply:${reply.replyId}`,
    evidence: [{ kind: 'decision' as const, value: `reply:${reply.replyId}` }, { kind: 'attribute' as const, value: `sygn. ${reply.reference}` }, ...txRefs(reply.txids)],
    explanation:
      `Usługa ${reply.serviceName} w odpowiedzi sygn. ${reply.reference} (otrzymanej ${reply.receivedAt.slice(0, 10)}) potwierdziła ${reply.payouts} ${plural(reply.payouts, 'wypłatę', 'wypłaty', 'wypłat')} na rachunek bankowy ` +
      `(łącznie ${reply.payoutSummary}) z konta, na które trafiły środki z tego adresu. Dokument spoza OSINT wprowadzony przez analityka.`,
    limitations: [
      'Podstawą jest dokument, nie dane blockchain ani źródła publiczne; narzędzie nie weryfikuje jego autentyczności.',
      ...(reply.payoutNotTied ? [PAYOUT_NOT_TIED_NOTE] : []),
      ...(reply.holderNote ? [reply.holderNote] : []),
    ],
  }));
  const previous: ComponentDraft[] = assessment.indicator.components.map(({ applied: _applied, independence: _independence, ...rest }) => ({ ...rest, weight: Math.abs(rest.weight) }));
  const limitations = assessment.indicator.limitations.filter((item) => item !== BANK_SIDE_LIMITATION);
  const cite = replies.map((reply) => `odpowiedź usługi ${reply.serviceName} (sygn. ${reply.reference})`).join(' oraz ');
  return {
    ...assessment,
    stage: 'documented_fiat_exit',
    status: 'confirmed',
    indicator: combineComponents('cash_out', [...components, ...previous], {
      confirmed: true,
      limitations: unique([REPLY_LIMITATION, ...replies.flatMap((reply) => (reply.holderNote ? [reply.holderNote] : [])), ...limitations]),
    }),
    statement:
      `${CASH_OUT_STAGE_LABEL.documented_fiat_exit[0]!.toUpperCase()}${CASH_OUT_STAGE_LABEL.documented_fiat_exit.slice(1)}: wypłatę na rachunek bankowy środków z adresu ${shortAddress(assessment.address)} ` +
      `potwierdza ${cite} — dokument spoza OSINT wprowadzony przez analityka. Dane blockchain pokazują przy tym wyłącznie przekazanie środków` +
      (assessment.txids.length > 0 ? ` (${przelew(assessment.txids.length)}).` : '; w pobranych danych nie ma transakcji przypisanych do tego wyjścia.') +
      (replies.some((reply) => reply.payoutNotTied) ? ` ${PAYOUT_NOT_TIED_NOTE}` : ''),
  };
}

/** Kontekst oceny wspólny dla wszystkich adresów: chwila oceny i usługi nazwane w publikacjach podmiotu. */
interface AssessContext {
  now?: Date;
  web?: ReturnType<typeof webServiceRefs>;
}

const isRoundPln = (value: number): boolean => {
  const step = CASH_OUT_RULES.roundStepPln;
  return value >= step && Math.abs(value - Math.round(value / step) * step) <= Math.min(CASH_OUT_RULES.roundTolerancePln, value * CASH_OUT_RULES.roundToleranceShare);
};

function assessFinding(
  finding: Finding,
  ownKeys: Set<string>,
  isDocumented: boolean,
  key: string,
  replies: DocumentedExitSource[] = [],
  ctx: AssessContext = {},
): CashOutAssessment[] {
  const chain = finding.chain;
  const drafts: Draft[] = [];
  const base = `cashout:${finding.network}:${finding.address}`;
  const transfers = (chain?.transfers ?? []) as ChainTransfer[];
  const cashOuts = chain?.cashOuts ?? [];
  const trails = chain?.trails ?? [];
  const cashOutByHop = new Map<string, CashOutIndicator>(cashOuts.map((item) => [`${item.txid}|${item.counterparty}`, item]));
  const seized = new Set(((chain as { seizures?: { txid?: string }[] } | undefined)?.seizures ?? []).map((item) => item.txid));

  const buckets = new Map<string, ServiceBucket>();
  const bucket = (label: string | undefined, kind: Exclude<CashOutKind, 'stablecoin_swap'>, address: string): ServiceBucket => {
    const name = label ? resolveService(label, 'other').name : `Usługa bez nazwy (${shortAddress(address)})`;
    const id = slug(name);
    let item = buckets.get(id);
    if (!item) {
      item = { name, kind, deposits: [], incoming: [] };
      buckets.set(id, item);
    }
    return item;
  };

  /** Przelewy (txid|odbiorca), które są pierwszym krokiem ścieżki albo wpłatą — nie trafiają do zbiorczej oceny „sama transakcja”. */
  const used = new Set<string>();
  const directSeen = new Set<string>();
  /** Przelewy wychodzące, które nie prowadzą do żadnej usługi. */
  const plain: ChainTransfer[] = [];
  /** Wpłaty przez wywnioskowany adres wpłat, których nie opisuje żadna ścieżka. */
  const inferredWithoutTrail: { transfer: ChainTransfer; cashOut?: CashOutIndicator; exchange: string }[] = [];
  const trailHops = new Set(trails.flatMap((trail) => trail.hops.map((hop) => `${hop.txid}|${hop.to}`)));

  for (const transfer of transfers) {
    if (seized.has(transfer.txid) || transfer.counterpartyClass === 'institutional') continue;
    // Przelew między własnymi adresami podmiotu nie jest ani wpłatą do usługi, ani wypływem.
    if (ownKeys.has(`${finding.network}:${transfer.counterparty}`)) continue;
    const hopKey = `${transfer.txid}|${transfer.counterparty}`;
    const cashOut = transfer.direction === 'out' ? cashOutByHop.get(hopKey) : undefined;
    const inferredName = INFERRED_LABEL.exec(transfer.counterpartyLabel ?? '')?.[1] ?? (/^WNIOSKOWANIE/.test(cashOut?.explanation ?? '') ? INFERRED_EXPLANATION.exec(cashOut!.explanation)?.[1] : undefined);
    const inferred = transfer.counterpartyLabelInferred === true || inferredName !== undefined || /^WNIOSKOWANIE/.test(cashOut?.explanation ?? '');
    const kind = [transfer.counterpartyKind, cashOut?.kind, transfer.counterpartyClass === 'exchange' ? ('exchange_deposit' as const) : undefined].find(isServiceKind);

    if (transfer.direction === 'in') {
      if (kind && !inferred) bucket(transfer.counterpartyLabel, kind, transfer.counterparty).incoming.push(transfer);
      continue;
    }
    if (inferred) {
      // Adres pośredni: opisze go ścieżka; bez ścieżki zostaje wpłatą „przez wywnioskowany adres wpłat”.
      if (!trailHops.has(hopKey)) inferredWithoutTrail.push({ transfer, cashOut, exchange: inferredName ?? cashOut?.counterpartyLabel ?? 'giełda' });
      used.add(hopKey);
      continue;
    }
    if (!kind) {
      plain.push(transfer);
      continue;
    }
    used.add(hopKey);
    directSeen.add(hopKey);
    bucket(transfer.counterpartyLabel, kind, transfer.counterparty).deposits.push({
      txid: transfer.txid,
      txids: [transfer.txid],
      time: transfer.time,
      asset: transfer.asset,
      amount: transfer.amount,
      ...(cashOut?.valuePln !== undefined ? { valuePln: cashOut.valuePln } : {}),
      mode: 'direct',
      serviceAddress: transfer.counterparty,
      label: transfer.counterpartyLabel,
      labelSource: transfer.counterpartyLabelSource,
      inferred: false,
      fromCluster: false,
      viaSwap: false,
      unverified: transfer.asset.includes('niezweryfikowany'),
    });
  }

  for (const { transfer, cashOut, exchange } of inferredWithoutTrail) {
    bucket(exchange, 'exchange_deposit', transfer.counterparty).deposits.push({
      txid: transfer.txid,
      txids: [transfer.txid],
      time: transfer.time,
      asset: transfer.asset,
      amount: transfer.amount,
      ...(cashOut?.valuePln !== undefined ? { valuePln: cashOut.valuePln } : {}),
      mode: 'deposit_address',
      label: exchange,
      labelSource: transfer.counterpartyLabelSource,
      via: transfer.counterparty,
      inferred: true,
      fromCluster: false,
      viaSwap: false,
      unverified: transfer.asset.includes('niezweryfikowany'),
    });
  }

  for (const trail of trails) {
    if (!isServiceKind(trail.serviceKind) || trail.hops.length === 0) continue;
    const first = trail.hops[0]!;
    const last = trail.hops.at(-1)!;
    const fromCluster = trail.sourceAddress !== finding.address || first.from !== finding.address;
    const inferred = fromCluster || trail.hops.some((hop) => hop.inferred);
    const direct = trail.hops.length === 1 && !inferred;
    if (first.from === finding.address) used.add(`${first.txid}|${first.to}`);
    // Ścieżka jednokrokowa to ten sam fakt, co bezpośredni przelew z listy przelewów — nie liczymy go drugi raz.
    if (direct && directSeen.has(`${first.txid}|${first.to}`)) continue;
    const viaDeposit = !direct && trail.hops.some((hop) => DEPOSIT_RULE.test(hop.reason ?? ''));
    bucket(trail.serviceName, trail.serviceKind, last.to).deposits.push({
      txid: first.txid,
      txids: trail.hops.map((hop) => hop.txid),
      time: last.time,
      asset: trail.asset,
      amount: trail.amount,
      ...(trail.valuePln !== undefined ? { valuePln: trail.valuePln } : {}),
      mode: direct ? 'direct' : viaDeposit ? 'deposit_address' : 'trail',
      serviceAddress: last.to,
      label: last.toLabel ?? trail.serviceName,
      labelSource: trailLabelSource(trail),
      ...(viaDeposit && trail.hops.length >= 2 ? { via: trail.hops.at(-2)!.to } : {}),
      inferred,
      fromCluster,
      viaSwap: trail.hops.some((hop) => SWAP_RULE.test(hop.reason ?? '')),
      confidence: trail.confidence,
      unverified: trail.asset.includes('niezweryfikowany'),
    });
  }

  const swaps = cashOuts.filter((item) => item.kind === 'stablecoin_swap');
  const matchedSwaps = new Set<CashOutIndicator>();
  const stable = (asset: string) => (CASH_OUT_RULES.stablecoins as readonly string[]).includes(asset.toUpperCase());

  // ---------- Oceny dla usług ----------
  for (const [id, item] of buckets) {
    const valid = item.deposits.filter((deposit) => !deposit.unverified);
    const unverified = item.deposits.filter((deposit) => deposit.unverified);
    const components: ComponentDraft[] = [];
    const limitations: string[] = [];
    const incomingTxids = item.incoming.map((transfer) => transfer.txid);

    if (valid.length === 0) {
      // Brak wpłat do usługi: przelewy przychodzące to źródło środków, a nie wyjście do walut tradycyjnych.
      if (item.incoming.length > 0) {
        components.push({
          rule: 'cashout.incoming_only',
          weight: CASH_OUT_RULES.penalties.incomingOnly,
          direction: 'contradicts',
          source: SOURCE,
          evidence: [...txRefs(incomingTxids), ...unique(item.incoming.map((transfer) => transfer.counterparty)).map((value) => ({ kind: 'address' as const, value }))],
          explanation: `Z adresów usługi ${item.name} środki wyłącznie PRZYCHODZIŁY na badany adres (${przelew(item.incoming.length)}). Wypłata kryptowaluty z usługi to źródło środków, nie wyjście do walut tradycyjnych.`,
          limitations: ['Nie wyklucza to wpłat do tej usługi z innych adresów podmiotu ani poza pobraną historią.'],
        });
      }
      if (unverified.length > 0) {
        components.push({
          rule: 'cashout.unverified_asset',
          weight: CASH_OUT_RULES.penalties.unverifiedAsset,
          direction: 'contradicts',
          source: SOURCE,
          evidence: txRefs(unverified.flatMap((deposit) => deposit.txids)),
          explanation: `Przelewy do usługi ${item.name} dotyczą wyłącznie tokenów o niezweryfikowanym kontrakcie lub kwocie — nie wiadomo, co naprawdę przesłano.`,
          limitations: ['Token mógł być podróbką znanej waluty; kwoty nie są podstawą żadnych ustaleń.'],
        });
      }
      if (components.length === 0) continue;
      const txids = [...incomingTxids, ...unverified.flatMap((deposit) => deposit.txids)];
      drafts.push({
        upgradable: false,
        assessment: build(
          `${base}:svc:${id}`,
          finding,
          'onchain_transfer',
          'computed',
          components,
          ['Ocena nie wychodzi ponad szczebel „transakcja w blockchainie”: brak przelewu z badanego adresu do usługi.'],
          item.incoming.length > 0
            ? `Adres ${shortAddress(finding.address)} wyłącznie OTRZYMYWAŁ środki z usługi ${item.name} (${przelew(item.incoming.length)}). To źródło środków, nie wyjście do walut tradycyjnych — ` +
              'przesłanek wymiany na waluty tradycyjne z tych transakcji nie ma.'
            : `Przelewy z adresu ${shortAddress(finding.address)} do usługi ${item.name} dotyczą tokenów o niezweryfikowanym kontrakcie lub kwocie — to tylko transakcje w blockchainie, bez przesłanek wyjścia do walut tradycyjnych.`,
          { serviceName: item.name, txids },
        ),
      });
      continue;
    }

    const direct = valid.filter((deposit) => deposit.mode === 'direct');
    const viaDeposit = valid.filter((deposit) => deposit.mode === 'deposit_address');
    const viaTrail = valid.filter((deposit) => deposit.mode === 'trail');
    const total = sumAmounts(valid);
    const kindName = KIND_NAME[item.kind];
    const labelRefs = (deposits: Deposit[]): EvidenceRef[] => [
      ...unique(deposits.map((deposit) => deposit.serviceAddress).filter((value): value is string => !!value)).map((value) => ({ kind: 'address' as const, value })),
      ...unique(deposits.map((deposit) => `etykieta „${deposit.label ?? item.name}” — źródło: ${deposit.labelSource ?? 'nie zapisano w danych'}`)).map((value) => ({ kind: 'attribute' as const, value })),
    ];
    const sources = (deposits: Deposit[]) => unique(deposits.map((deposit) => deposit.labelSource ?? 'źródło etykiety nie zostało zapisane w danych')).join('; ');

    if (direct.length > 0) {
      components.push({
        rule: 'cashout.direct_service_transfer',
        weight: CASH_OUT_RULES.weights.directServiceTransfer[item.kind],
        direction: 'supports',
        source: SOURCE,
        // Przy karcie ten sam przelew opisuje mocniejsza reguła doładowania karty — liczy się raz.
        ...(item.kind === 'crypto_card' ? { originKey: `card:${id}` } : {}),
        evidence: [...txRefs(direct.flatMap((deposit) => deposit.txids)), ...labelRefs(direct)],
        explanation:
          `Bezpośredni przelew z badanego adresu na adres publicznie oznaczony jako ${kindName} „${direct[0]!.label ?? item.name}” (${przelew(direct.length)}). ` +
          `Źródło etykiety: ${sources(direct)}.`,
        limitations: ['Przelew do usługi nie dowodzi sprzedaży ani wypłaty: środki mogły zostać w usłudze, zostać wymienione na inną kryptowalutę albo wypłacone dalej w blockchainie.'],
      });
    }
    if (viaDeposit.length > 0) {
      components.push({
        rule: 'cashout.deposit_address_inferred',
        weight: CASH_OUT_RULES.weights.depositAddressInferred,
        direction: 'supports',
        source: SOURCE,
        evidence: [
          ...txRefs(viaDeposit.flatMap((deposit) => deposit.txids)),
          ...unique(viaDeposit.map((deposit) => deposit.via).filter((value): value is string => !!value)).map((value) => ({ kind: 'address' as const, value })),
          ...labelRefs(viaDeposit),
        ],
        explanation:
          `Środki trafiły na adres bez publicznej etykiety, który przekazał je do portfela usługi ${item.name} — wzorzec indywidualnego adresu wpłat klienta (${przelew(viaDeposit.length)}). ` +
          `Źródło etykiety usługi: ${sources(viaDeposit)}.`,
        limitations: ['Adres wpłat ustalono WNIOSKOWANIEM z dalszej drogi środków; może należeć do innej osoby lub pośrednika. Rozstrzyga usługa — właściciel konta przypisanego do adresu.'],
      });
    }
    if (viaTrail.length > 0) {
      components.push({
        rule: 'cashout.trail_documented',
        weight: CASH_OUT_RULES.weights.trailDocumented,
        direction: 'supports',
        source: SOURCE,
        evidence: [...txRefs(viaTrail.flatMap((deposit) => deposit.txids)), ...labelRefs(viaTrail)],
        explanation:
          `Udokumentowana ścieżka środków do usługi ${item.name} przez adresy pośrednie (${viaTrail.length} ${plural(viaTrail.length, 'ścieżka', 'ścieżki', 'ścieżek')}; ` +
          `pewność według wzoru modułu blockchain: ${viaTrail.map((deposit) => `${deposit.confidence ?? '?'}%`).join(', ')}). Źródło etykiety usługi: ${sources(viaTrail)}.`,
        limitations: ['Adresy pośrednie mogą należeć do innych osób: odbiorca płatności mógł sam wpłacić środki do usługi.'],
      });
    }

    // Zamiana na stablecoin, po której stablecoin trafił do usługi.
    const swapEvidence: string[] = [];
    const swapPairs: { swap: CashOutIndicator; deposit: Deposit }[] = [];
    for (const deposit of valid) {
      if (deposit.viaSwap) swapEvidence.push(...deposit.txids);
      if (!stable(deposit.asset)) continue;
      const at = Date.parse(deposit.time);
      for (const swap of swaps) {
        const delay = at - Date.parse(swap.time);
        if (delay < 0 || delay > CASH_OUT_RULES.swapToDepositDays * DAY_MS) continue;
        matchedSwaps.add(swap);
        swapPairs.push({ swap, deposit });
        swapEvidence.push(swap.txid, deposit.txid);
      }
    }
    // Wartość zamiany: wycena wydanej waluty, a bez niej — wycena wpłaconego stablecoina. Bez kursu progu nie oceniamy.
    const pairValue = (pair: { swap: CashOutIndicator; deposit: Deposit }) => pair.swap.valuePln ?? pair.deposit.valuePln;
    const largePairs = swapPairs.filter((pair) => (pairValue(pair) ?? 0) >= CASH_OUT_RULES.largeStablecoinPln);
    if (largePairs.length > 0) {
      const largest = Math.max(...largePairs.map((pair) => pairValue(pair)!));
      components.push({
        rule: 'cashout.stablecoin_conversion_large',
        weight: CASH_OUT_RULES.weights.stablecoinConversionLarge,
        direction: 'supports',
        source: SOURCE,
        // Ta sama zamiana co w regule ogólnej „zamiana na stablecoin” — liczy się raz (mocniejsza waga).
        originKey: `swap:${id}`,
        evidence: txRefs(largePairs.flatMap((pair) => [pair.swap.txid, pair.deposit.txid])),
        explanation:
          `Wymiana znacznej wartości na stablecoin: ${largePairs.length} ${plural(largePairs.length, 'zamiana', 'zamiany', 'zamian')} o szacunkowej wartości do ${roundPln(largest)} ` +
          `(próg ${roundPln(CASH_OUT_RULES.largeStablecoinPln)}), po której stablecoin trafił do usługi ${item.name} w ciągu ${CASH_OUT_RULES.swapToDepositDays} dni.`,
        limitations: [
          'Wartość to szacunek po kursie rynkowym z dnia transakcji, nie kwota faktycznie uzyskana.',
          'Związek zamiany z wpłatą wynika z kolejności i czasu transakcji; próg jest ekspercki i edytowalny (CASH_OUT_RULES.largeStablecoinPln).',
        ],
      });
    } else if (swapPairs.length > 0 && swapPairs.every((pair) => pairValue(pair) === undefined)) {
      limitations.push(`Brak kursu dla zamiany na stablecoin — reguły „wymiana znacznej wartości na stablecoin” (próg ${roundPln(CASH_OUT_RULES.largeStablecoinPln)}) nie oceniono.`);
    }
    if (swapEvidence.length > 0) {
      components.push({
        rule: 'cashout.stablecoin_swap',
        weight: CASH_OUT_RULES.weights.stablecoinSwap,
        direction: 'supports',
        source: SOURCE,
        originKey: `swap:${id}`,
        evidence: txRefs(swapEvidence),
        explanation: `Zamiana na stablecoin, po której stablecoin trafił do usługi ${item.name} (w ciągu ${CASH_OUT_RULES.swapToDepositDays} dni) — wzorzec typowy dla przygotowania wypłaty.`,
        limitations: ['Związek zamiany z późniejszą wpłatą wynika z kolejności i czasu transakcji, nie z ich treści; stablecoin mógł posłużyć do handlu w usłudze.'],
      });
    }
    if (valid.length >= CASH_OUT_RULES.repeatedMin) {
      components.push({
        rule: 'cashout.repeated_deposits',
        weight: CASH_OUT_RULES.weights.repeatedDeposits,
        direction: 'supports',
        source: SOURCE,
        originKey: `repeat:${id}`,
        evidence: txRefs(valid.map((deposit) => deposit.txid)),
        explanation: `Powtarzalne wpłaty do tej samej usługi: ${valid.length} osobnych wpłat (próg ${CASH_OUT_RULES.repeatedMin}) między ${valid.map((deposit) => deposit.time).sort()[0]!.slice(0, 10)} a ${valid.map((deposit) => deposit.time).sort().at(-1)!.slice(0, 10)}.`,
        limitations: ['Regularne wpłaty wskazują na stałe korzystanie z konta w usłudze, nie na to, co się z nimi stało po wpłacie.'],
      });
    }
    // Regularne spieniężanie: te same wpłaty rozłożone na wiele miesięcy (nie dotyczy bramki — to wydatki).
    const months = [...new Set(valid.map((deposit) => deposit.time.slice(0, 7)))].sort();
    const repeatedOfframp = item.kind !== 'payment_gateway' && valid.length >= CASH_OUT_RULES.repeatedMin && months.length >= CASH_OUT_RULES.offrampMonthsMin;
    if (repeatedOfframp) {
      components.push({
        rule: 'cashout.repeated_offramp',
        weight: CASH_OUT_RULES.weights.repeatedOfframp,
        direction: 'supports',
        source: SOURCE,
        // Te same wpłaty co w regule „powtarzalne wpłaty” — liczą się raz.
        originKey: `repeat:${id}`,
        evidence: txRefs(valid.map((deposit) => deposit.txid)),
        explanation:
          `Wpłaty do tej samej usługi wyjścia do fiat ${item.name} powtarzają się przez wiele miesięcy: ${valid.length} ${plural(valid.length, 'wpłata', 'wpłaty', 'wpłat')} w ${months.length} różnych miesiącach ` +
          `(${months[0]} – ${months.at(-1)}; próg ${CASH_OUT_RULES.offrampMonthsMin}) — wzorzec regularnego spieniężania.`,
        limitations: ['Regularność wpłat nie mówi, czy środki sprzedano i wypłacono; mogły zostać w usłudze albo wrócić w kryptowalucie.'],
      });
    }
    // Kwoty bliskie okrągłym w PLN (np. „sprzedaję za 10 000 zł”) — słaba przesłanka, tylko przy wycenie.
    const valuedDeposits = valid.filter((deposit) => deposit.valuePln !== undefined);
    const roundDeposits = valuedDeposits.filter((deposit) => isRoundPln(deposit.valuePln!));
    if (roundDeposits.length >= CASH_OUT_RULES.roundMin && roundDeposits.length * 2 >= valuedDeposits.length) {
      components.push({
        rule: 'cashout.round_amounts_pln',
        weight: CASH_OUT_RULES.weights.roundAmountsPln,
        direction: 'supports',
        source: SOURCE,
        evidence: txRefs(roundDeposits.map((deposit) => deposit.txid)),
        explanation:
          `Wartość ${roundDeposits.length} z ${valuedDeposits.length} wycenionych wpłat jest bliska okrągłej kwocie w PLN (wielokrotność ${roundPln(CASH_OUT_RULES.roundStepPln)}, ` +
          `odchylenie najwyżej ${roundPln(CASH_OUT_RULES.roundTolerancePln)}): ${roundDeposits.map((deposit) => roundPln(deposit.valuePln!)).join(', ')} — jak przy sprzedaży „za umówioną kwotę”.`,
        limitations: ['Przesłanka słaba: wycena po kursie dziennym, nie po kursie faktycznej transakcji; zbieżność z okrągłą kwotą bywa przypadkowa.'],
      });
    } else if (valuedDeposits.length === 0 && valid.length >= CASH_OUT_RULES.roundMin) {
      limitations.push('Brak kursu dla wpłat — reguły „kwoty bliskie okrągłym w PLN” nie oceniono.');
    }
    // Doładowanie karty zasilanej kryptowalutami: środki stają się wydawalne jak pieniądze.
    const cardTopup = item.kind === 'crypto_card';
    if (cardTopup) {
      components.push({
        rule: 'cashout.crypto_card_topup',
        weight: CASH_OUT_RULES.weights.cryptoCardTopup,
        direction: 'supports',
        source: SOURCE,
        originKey: `card:${id}`,
        evidence: [...txRefs(valid.flatMap((deposit) => deposit.txids)), ...labelRefs(valid)],
        explanation:
          `Doładowanie karty zasilanej kryptowalutami: ${przelew(valid.length)} na adres oznaczony jako wydawca karty „${valid[0]!.label ?? item.name}”. ` +
          `Karta pozwala płacić i wypłacać gotówkę w walucie tradycyjnej. Źródło etykiety: ${sources(valid)}.`,
        limitations: ['Jakie płatności kartą i wypłaty z bankomatu nastąpiły, wie tylko wydawca karty.'],
      });
    }
    // Wpłata do usługi, po której adres zamilkł: brak jakichkolwiek transakcji przez co najmniej `quietDays` dni.
    let quiet = false;
    const own = valid.filter((deposit) => !deposit.fromCluster && deposit.mode !== 'trail').sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
    const lastOwn = own[0];
    if (ctx.now && lastOwn && chain) {
      const lastAt = Date.parse(lastOwn.time);
      const later = transfers.filter((transfer) => Date.parse(transfer.time) > lastAt);
      const lastSeen = chain.profile.lastSeen ? Date.parse(chain.profile.lastSeen) : undefined;
      const days = Math.floor((ctx.now.getTime() - lastAt) / DAY_MS);
      const native = chain.profile.nativeAsset.toUpperCase() === lastOwn.asset.toUpperCase();
      const emptied = native ? chain.profile.balance <= CASH_OUT_RULES.quietBalanceShare * Math.max(chain.profile.totalReceived, 0) : undefined;
      if (later.length === 0 && (lastSeen === undefined || lastSeen <= lastAt + DAY_MS) && days >= CASH_OUT_RULES.quietDays && emptied !== false) {
        quiet = true;
        components.push({
          rule: 'cashout.deposit_then_quiet',
          weight: CASH_OUT_RULES.weights.depositThenQuiet,
          direction: 'supports',
          source: SOURCE,
          evidence: txRefs(lastOwn.txids),
          explanation:
            `Ostatnia aktywność adresu to wpłata do usługi ${item.name} (${formatDate(lastOwn.time)}); od tego czasu — ${days} dni do dnia oceny — adres nie ma żadnych transakcji` +
            `${emptied ? ', a jego saldo jest bliskie zeru' : ''}. Środki przeniesione do usługi wymiany i portfel, który zamilkł — typowy obraz sprzedaży.`,
          limitations: [
            'Brak późniejszych transakcji dotyczy pobranej historii adresu; podmiot mógł dalej działać z innych adresów.',
            ...(emptied === undefined ? ['Wpłata w tokenie — saldo tokena nie jest znane; oceniono tylko brak transakcji.'] : []),
          ],
        });
      }
    }
    // Ta sama usługa wymieniona w publikacjach kont podmiotu — niezależna podstawa (Web2) dla tej oceny.
    const webRef = ctx.web?.get(serviceIdOf(item.name));
    if (webRef) {
      components.push({
        rule: 'cashout.web.named_offramp',
        weight: CASH_OUT_RULES.weights.web.named_offramp,
        direction: 'supports',
        source: 'publikacje kont podmiotu (Web2)',
        originKey: webRef.originKey,
        evidence: webRef.urls.map((value) => ({ kind: 'url' as const, value })),
        explanation:
          `Podmiot sam wymienia usługę ${webRef.name} w swoich publikacjach (${webRef.urls.length}); ` +
          `${webRef.fiatContext ? 'publikacja mówi o wymianie na walutę tradycyjną' : 'to sama wzmianka'}. Cytat: „${webRef.excerpt}”.`,
        limitations: ['Wzmianka w publikacji nie wskazuje konta ani wypłaty; potwierdza tylko, że podmiot zna lub używa tej usługi.'],
      });
    }
    if (total.valuePln !== undefined) {
      components.push({
        rule: 'cashout.valuation_available',
        weight: CASH_OUT_RULES.weights.valuationAvailable,
        direction: 'supports',
        source: SOURCE,
        evidence: txRefs(valid.filter((deposit) => deposit.valuePln !== undefined).map((deposit) => deposit.txid)),
        explanation: `Dla ${total.valued} z ${valid.length} wpłat jest kurs z dnia transakcji — szacunkowa wartość ${roundPln(total.valuePln)}.`,
        limitations: ['Wycena jest szacunkiem po kursie rynkowym z dnia transakcji; nie jest kwotą faktycznie uzyskaną ze sprzedaży.'],
      });
    }
    if (total.valued < valid.length) {
      limitations.push(
        total.valued === 0
          ? 'Brak kursu dla tych transakcji — wartości w PLN nie podano (nie jest to zero).'
          : `Wartość w PLN obejmuje ${total.valued} z ${valid.length} wpłat; dla pozostałych brak kursu.`,
      );
    }
    if (total.amount === undefined) limitations.push('Wpłaty w kilku walutach — łącznej kwoty w jednej walucie nie podano.');
    if (unverified.length > 0) limitations.push(`Pominięto ${przelew(unverified.length)} w tokenach o niezweryfikowanym kontrakcie lub kwocie.`);

    // Składniki ograniczające.
    const reliesOnInference = direct.length === 0;
    const inferredDeposits = valid.filter((deposit) => deposit.inferred);
    if (inferredDeposits.length > 0) {
      const text = 'Część kroków ścieżki ustalono heurystyką (adres pośredni, adres wpłat, adres reszty), a nie wprost z transakcji.';
      if (reliesOnInference) {
        components.push({
          rule: 'cashout.inferred_hop',
          weight: CASH_OUT_RULES.penalties.inferredHop,
          direction: 'contradicts',
          source: SOURCE,
          evidence: txRefs(inferredDeposits.flatMap((deposit) => deposit.txids)),
          explanation: `${text} Bez bezpośredniego przelewu na oznaczony adres usługi cała ocena opiera się na wnioskowaniu.`,
          limitations: ['Wnioskowanie wymaga potwierdzenia przez usługę albo innym dowodem.'],
        });
      } else limitations.push(text);
    }
    const clustered = valid.filter((deposit) => deposit.fromCluster);
    if (clustered.length > 0) {
      const text = 'Ścieżka zaczyna się od innego adresu zaliczonego do portfela podmiotu heurystyką (wspólne wejścia, adres reszty), a nie od badanego adresu.';
      if (reliesOnInference) {
        components.push({
          rule: 'cashout.cluster_origin',
          weight: CASH_OUT_RULES.penalties.clusterOrigin,
          direction: 'contradicts',
          source: SOURCE,
          evidence: txRefs(clustered.flatMap((deposit) => deposit.txids)),
          explanation: text,
          limitations: ['Jeśli adres nie należy do podmiotu, ścieżka go nie dotyczy.'],
        });
      } else limitations.push(text);
    }
    const heuristicLabels = valid.filter((deposit) => HEURISTIC_LABEL_SOURCE.test(deposit.labelSource ?? ''));
    if (heuristicLabels.length === valid.length) {
      components.push({
        rule: 'cashout.label_heuristic',
        weight: CASH_OUT_RULES.penalties.labelHeuristic,
        direction: 'contradicts',
        source: SOURCE,
        evidence: unique(heuristicLabels.map((deposit) => deposit.labelSource!)).map((value) => ({ kind: 'attribute' as const, value })),
        explanation: 'Etykieta usługi pochodzi z heurystyki (grupowanie adresów w portfele albo rozpoznanie po nazwie w znaczniku eksploratora), a nie ze zweryfikowanego zbioru etykiet.',
        limitations: ['Przypisanie adresu do usługi może być błędne — do weryfikacji w eksploratorze.'],
      });
    }
    const weakTrails = valid.filter((deposit) => deposit.mode !== 'direct' && deposit.confidence !== undefined && deposit.confidence < CASH_OUT_RULES.lowTrailConfidence);
    if (reliesOnInference && weakTrails.length > 0 && weakTrails.length === valid.filter((deposit) => deposit.confidence !== undefined).length) {
      components.push({
        rule: 'cashout.low_trail_confidence',
        weight: CASH_OUT_RULES.penalties.lowTrailConfidence,
        direction: 'contradicts',
        source: SOURCE,
        evidence: txRefs(weakTrails.flatMap((deposit) => deposit.txids)),
        explanation: `Pewność ścieżek według wzoru modułu blockchain jest niska (poniżej ${CASH_OUT_RULES.lowTrailConfidence}%): ${weakTrails.map((deposit) => `${deposit.confidence}%`).join(', ')}.`,
        limitations: ['Niska pewność ścieżki oznacza długą drogę przez adresy pośrednie, niezgodność kwot albo długi czas.'],
      });
    }
    const labelsText = [item.name, ...valid.map((deposit) => deposit.label ?? '')].join(' ');
    if (NON_CUSTODIAL.test(labelsText)) {
      components.push({
        rule: 'cashout.service_also_non_custodial',
        weight: CASH_OUT_RULES.penalties.serviceAlsoNonCustodial,
        direction: 'contradicts',
        source: SOURCE,
        evidence: unique(valid.map((deposit) => deposit.label ?? item.name)).map((value) => ({ kind: 'attribute' as const, value: `etykieta „${value}”` })),
        explanation: 'Etykieta wskazuje na produkt bez powiernictwa (wymiana zdecentralizowana, portfel lub most): w takim produkcie nie ma konta klienta ani wypłaty na rachunek.',
        limitations: ['Usługa o tej nazwie może prowadzić także giełdę z kontami klientów — rodzaj adresu trzeba potwierdzić.'],
      });
    }
    if (item.kind === 'payment_gateway') {
      components.push({
        rule: 'cashout.payment_gateway_spend',
        weight: CASH_OUT_RULES.penalties.paymentGatewaySpend,
        direction: 'contradicts',
        source: SOURCE,
        evidence: txRefs(valid.map((deposit) => deposit.txid)),
        explanation: 'Przelew do bramki płatniczej to zapłata za towar lub usługę: waluty tradycyjne otrzymuje sprzedawca, a nie nadawca przelewu.',
        limitations: ['To wydatek w kryptowalucie, a nie wypłata środków podmiotu na jego rachunek.'],
      });
    }
    const firstDeposit = Math.min(...valid.map((deposit) => Date.parse(deposit.time)));
    const back = item.incoming.filter((transfer) => Date.parse(transfer.time) >= firstDeposit);
    if (back.length > 0) {
      components.push({
        rule: 'cashout.withdrawals_back',
        weight: CASH_OUT_RULES.penalties.withdrawalsBack,
        direction: 'contradicts',
        source: SOURCE,
        evidence: txRefs(back.map((transfer) => transfer.txid)),
        explanation: `Po wpłatach z adresów usługi ${item.name} wracały środki na badany adres (${przelew(back.length)}) — część wpłat mogła zostać wypłacona z powrotem w kryptowalucie.`,
        limitations: ['Usługa wypłaca z portfeli zbiorczych; nie wiadomo, czy to te same środki.'],
      });
    }

    // Publikacja podmiotu o wymianie na fiat w tej samej usłudze też jest wzorcem wypłaty — ale wciąż nie jej dowodem.
    const signal =
      viaDeposit.length > 0 ||
      viaTrail.length > 0 ||
      swapEvidence.length > 0 ||
      valid.length >= CASH_OUT_RULES.repeatedMin ||
      cardTopup ||
      quiet ||
      webRef?.fiatContext === true;
    const stage: CashOutStage = signal ? 'cashout_signal' : 'service_interaction';
    const hypothesis = inferredDeposits.length > 0 || clustered.length > 0;
    const how = [
      direct.length > 0 ? `${przelew(direct.length)} wprost na oznaczony adres usługi` : '',
      viaDeposit.length > 0 ? `${przelew(viaDeposit.length)} przez prawdopodobny indywidualny adres wpłat (wnioskowanie)` : '',
      viaTrail.length > 0 ? `${viaTrail.length} ${plural(viaTrail.length, 'ścieżka', 'ścieżki', 'ścieżek')} przez adresy pośrednie` : '',
    ].filter(Boolean).join(', ');
    const statement =
      stage === 'service_interaction'
        ? `Interakcja z usługą wymiany: z adresu ${shortAddress(finding.address)} przekazano${describeSum(total)} do usługi ${item.name} (${kindName}) — ${how}. ` +
          'To przekazanie środków do usługi; nie wynika z niego, że doszło do wymiany na waluty tradycyjne ani wypłaty na rachunek — potwierdzić może to tylko usługa.'
        : `Potencjalny sygnał wypłaty: z adresu ${shortAddress(finding.address)} przekazano${describeSum(total)} do usługi ${item.name} (${kindName}) — ${how}` +
          `${swapEvidence.length > 0 ? `; wpłatę poprzedziła zamiana na stablecoin${largePairs.length > 0 ? ' znacznej wartości' : ''}` : ''}` +
          `${valid.length >= CASH_OUT_RULES.repeatedMin ? `; wpłaty są powtarzalne${repeatedOfframp ? ` (${months.length} różnych miesięcy)` : ''}` : ''}` +
          `${cardTopup ? '; to doładowanie karty zasilanej kryptowalutami' : ''}${quiet ? '; po ostatniej wpłacie adres zamilkł' : ''}` +
          `${webRef?.fiatContext ? '; podmiot sam pisze o wymianie na walutę tradycyjną w tej usłudze' : ''}. ` +
          `${hypothesis ? 'To hipoteza oparta na wnioskowaniu, do weryfikacji. ' : ''}` +
          'Wzorzec jest typowy dla przygotowania wypłaty, ale sama wypłata w walucie tradycyjnej nie jest widoczna w blockchainie — potwierdzić może ją tylko usługa.';
    drafts.push({
      upgradable: true,
      assessment: build(`${base}:svc:${id}`, finding, stage, hypothesis ? 'hypothesis' : 'computed', components, limitations, statement, {
        serviceName: item.name,
        txids: [...valid.flatMap((deposit) => deposit.txids), ...swapEvidence],
        asset: total.asset,
        amount: total.amount,
        valuePln: total.valuePln,
      }),
    });
  }

  // ---------- Jedna zbiorcza ocena „sama transakcja w blockchainie” ----------
  const others = plain.filter((transfer) => !used.has(`${transfer.txid}|${transfer.counterparty}`));
  const looseSwaps = swaps.filter((swap) => !matchedSwaps.has(swap));
  const swapTxids = new Set(swaps.map((swap) => swap.txid));
  const onlyTransfers = others.filter((transfer) => !swapTxids.has(transfer.txid));
  if (onlyTransfers.length > 0 || looseSwaps.length > 0) {
    const components: ComponentDraft[] = [];
    const limitations: string[] = ['Adresy docelowe nie mają publicznej etykiety usługi wymiany — nie wiadomo, do kogo należą; brak etykiety nie dowodzi, że to osoby prywatne.'];
    const solid = onlyTransfers.filter((transfer) => !transfer.asset.includes('niezweryfikowany'));
    if (onlyTransfers.length > 0) {
      components.push({
        rule: 'cashout.onchain_transfer',
        weight: CASH_OUT_RULES.weights.onchainTransfer,
        direction: 'supports',
        source: SOURCE,
        evidence: txRefs(onlyTransfers.map((transfer) => transfer.txid)),
        explanation: `Przelewy wychodzące z badanego adresu na adresy bez etykiety usługi wymiany (${przelew(onlyTransfers.length)}). To wyłącznie transakcje w blockchainie.`,
        limitations: ['Sam przelew między adresami nic nie mówi o wymianie na waluty tradycyjne.'],
      });
    }
    if (looseSwaps.length > 0) {
      components.push({
        rule: 'cashout.stablecoin_swap_only',
        weight: CASH_OUT_RULES.weights.stablecoinSwapOnly,
        direction: 'supports',
        source: SOURCE,
        evidence: txRefs(looseSwaps.map((swap) => swap.txid)),
        explanation: `Zamiana na stablecoin (${przelew(looseSwaps.length)}) bez widocznej późniejszej wpłaty stablecoina do usługi wymiany.`,
        limitations: ['Zamiana na stablecoin utrwala wartość, ale sama nie jest wyjściem do walut tradycyjnych — środki pozostają kryptowalutą.'],
      });
    }
    const mixers = onlyTransfers.filter((transfer) => transfer.counterpartyClass === 'mixer').length;
    if (mixers > 0) limitations.push(`${przelew(mixers)} do miksera — dalszej drogi tych środków nie da się ustalić.`);
    const total = sumAmounts(solid);
    drafts.push({
      upgradable: false,
      assessment: build(
        `${base}:onchain`,
        finding,
        'onchain_transfer',
        'computed',
        components,
        limitations,
        `Transakcje w blockchainie: z adresu ${shortAddress(finding.address)} wyszło ${przelew(onlyTransfers.length + looseSwaps.length)} na adresy bez etykiety usługi wymiany` +
          `${looseSwaps.length > 0 ? ` (w tym ${looseSwaps.length} ${plural(looseSwaps.length, 'zamiana', 'zamiany', 'zamian')} na stablecoin)` : ''}. ` +
          'To tylko przelewy między adresami — nie wynika z nich nic o wymianie na waluty tradycyjne.',
        { txids: [...onlyTransfers.map((transfer) => transfer.txid), ...looseSwaps.map((swap) => swap.txid)], asset: total.asset, amount: total.amount },
      ),
    });
  }

  if (!isDocumented && replies.length === 0) return drafts.map((draft) => draft.assessment);

  // ---------- Dokument spoza blockchaina przyjęty przez analityka ----------
  const upgradable = drafts.filter((draft) => draft.upgradable);
  if (replies.length > 0) {
    // Odpowiedź usługi podnosi ocenę TEJ usługi; pozostałe oceny podnosi tylko decyzja analityka o adresie.
    const repliesOf = (draft: Draft) => replies.filter((reply) => draft.assessment.serviceName !== undefined && serviceIdOf(draft.assessment.serviceName) === reply.serviceId);
    if (upgradable.some((draft) => repliesOf(draft).length > 0)) {
      return drafts.map((draft) => {
        if (!draft.upgradable) return draft.assessment;
        const own = repliesOf(draft);
        return own.length > 0 ? documented(draft, key, own) : isDocumented ? documented(draft, key) : draft.assessment;
      });
    }
    if (!isDocumented) {
      // Nazwa usługi z odpowiedzi nie odpowiada żadnej ocenie: dopasowanie wynika z transakcji, więc dokument obejmuje oceny z wpłatami.
      const scope = 'Nazwa usługi w odpowiedzi nie odpowiada etykiecie usługi w danych blockchain — zakres dokumentu trzeba sprawdzić w jego treści.';
      const widen = (assessment: CashOutAssessment): CashOutAssessment => ({ ...assessment, indicator: { ...assessment.indicator, limitations: [...assessment.indicator.limitations, scope] } });
      if (upgradable.length > 0) return drafts.map((draft) => (draft.upgradable ? widen(documented(draft, key, replies)) : draft.assessment));
      const aggregate = drafts.find((draft) => draft.assessment.id === `${base}:onchain`);
      const empty: Draft = { upgradable: true, assessment: build(`${base}:onchain`, finding, 'onchain_transfer', 'computed', [], [], '', { txids: [] }) };
      return [widen(documented(aggregate ?? empty, key, replies)), ...drafts.filter((draft) => draft !== aggregate).map((draft) => draft.assessment)];
    }
  }
  if (upgradable.length > 0) {
    const several = upgradable.length > 1 ? ['Potwierdzenie analityka dotyczy adresu, a ocen dla usług jest kilka — zakres dokumentu (której usługi dotyczy) trzeba sprawdzić w jego treści.'] : [];
    return drafts.map((draft) => {
      if (!draft.upgradable) return draft.assessment;
      const upgraded = documented(draft, key);
      return several.length > 0 ? { ...upgraded, indicator: { ...upgraded.indicator, limitations: [...upgraded.indicator.limitations, ...several] } } : upgraded;
    });
  }
  // Brak wpłat do usług w danych blockchain: dokument jest jedyną podstawą — zbiorcza ocena (jeśli jest) przechodzi na ostatni szczebel.
  const aggregate = drafts.find((draft) => draft.assessment.id === `${base}:onchain`);
  const rest = drafts.filter((draft) => draft !== aggregate).map((draft) => draft.assessment);
  const empty: Draft = { upgradable: true, assessment: build(`${base}:onchain`, finding, 'onchain_transfer', 'computed', [], [], '', { txids: [] }) };
  const upgraded = documented(aggregate ?? empty, key);
  return [
    {
      ...upgraded,
      indicator: {
        ...upgraded.indicator,
        limitations: [...upgraded.indicator.limitations, 'W danych blockchain nie ma przelewu z tego adresu do rozpoznanej usługi wymiany — udokumentowane wyjście opiera się wyłącznie na dokumencie spoza blockchaina.'],
      },
    },
    ...rest,
  ];
}

/** „Dlaczego to oznaka wypłaty” — po jednym zdaniu na regułę wzorca. */
const WHY_RULE: Record<string, string> = {
  'cashout.deposit_address_inferred': 'środki trafiły na prawdopodobny indywidualny adres wpłat klienta w usłudze',
  'cashout.trail_documented': 'udokumentowana ścieżka środków prowadzi do usługi wymiany',
  'cashout.stablecoin_conversion_large': 'wymiana znacznej wartości na stablecoin, a potem wpłata do usługi',
  'cashout.stablecoin_swap': 'wpłatę poprzedziła zamiana na stablecoin',
  'cashout.repeated_offramp': 'wpłaty do tej samej usługi powtarzają się przez wiele miesięcy (regularne spieniężanie)',
  'cashout.repeated_deposits': 'wpłaty do tej samej usługi powtarzają się',
  'cashout.crypto_card_topup': 'doładowanie karty pozwala wydawać środki jak pieniądze i wypłacać gotówkę',
  'cashout.deposit_then_quiet': 'po wpłacie do usługi adres zamilkł — typowy obraz sprzedaży',
  'cashout.round_amounts_pln': 'kwoty w PLN bliskie okrągłym (przesłanka słaba)',
  'cashout.web.named_offramp': 'podmiot sam wymienia tę usługę w swoich publikacjach',
};

/** Uzupełnia ocenę z blockchaina o „Dlaczego to oznaka wypłaty”, „Co potwierdzi wypłatę” i rodzaj usługi wyjścia do fiat. */
function withGuidance(assessment: CashOutAssessment, links: ServiceLink[] | undefined, registry: RegistryData | null | undefined): CashOutAssessment {
  const rules = new Set(assessment.indicator.components.filter((item) => item.direction === 'supports').map((item) => item.rule));
  const reasons = Object.entries(WHY_RULE)
    .filter(([rule]) => rules.has(rule))
    .map(([, text]) => text);
  const kindText = assessment.indicator.components.find((item) => item.rule === 'cashout.direct_service_transfer')?.explanation.match(/oznaczony jako ([^„]+) „/)?.[1]?.trim();
  const why =
    assessment.stage === 'documented_fiat_exit'
      ? 'Wypłatę na rachunek potwierdza dokument spoza blockchaina (odpowiedź usługi albo dokumentacja przyjęta przez analityka).'
      : assessment.stage === 'cashout_signal'
        ? `Wzorzec typowy dla przygotowania wypłaty: ${reasons.join('; ')}.`
        : assessment.stage === 'service_interaction'
          ? `Środki trafiły do usługi${kindText ? ` (${kindText})` : ''}, w której zwykle zamienia się kryptowaluty na pieniądze${reasons.length > 0 ? `; ${reasons.join('; ')}` : ''}. Sam przelew nie dowodzi sprzedaży.`
          : 'To nie jest oznaka wypłaty: adresy docelowe nie mają etykiety usługi wymiany albo środki z usługi tylko przychodziły.';
  const services = assessment.serviceName && !assessment.serviceName.startsWith('Usługa bez nazwy') ? confirmationServices([assessment.serviceName], links) : [];
  const confirm =
    assessment.stage === 'documented_fiat_exit'
      ? { text: 'Wypłata jest udokumentowana; dalsze zapytanie tylko wtedy, gdy trzeba ustalić rachunek bankowy lub zakres pozostałych wypłat.', services }
      : services.length > 0
        ? {
            text:
              `Ostatni szczebel daje tylko odpowiedź usługi ${services[0]!.name}: dane KYC właściciela konta, historia wpłat (transakcje poniżej), zlecenia sprzedaży i wypłaty na rachunek bankowy ` +
              '(daty, kwoty, numer rachunku). Odpowiedź wprowadza analityk w zakładce odpowiedzi usług.',
            services,
          }
        : {
            text: 'Najpierw trzeba ustalić, do kogo należą adresy docelowe (etykieta usługi, dalsza ścieżka środków); dopiero usługa wymiany może potwierdzić wypłatę.',
            services,
          };
  const offramp = assessment.stage === 'onchain_transfer' ? undefined : offrampInfo(assessment.serviceName, registry);
  return { ...assessment, origin: 'chain', why, confirm, ...(offramp ? { offramp } : {}) };
}

export function buildCashOutAssessments(input: CashOutStageInput): CashOutAssessment[] {
  const result: CashOutAssessment[] = [];
  const seen = new Set<string>();
  const publications = input.publications ?? [];
  const ctx: AssessContext = { ...(input.now ? { now: input.now } : {}), ...(publications.length > 0 ? { web: webServiceRefs(publications) } : {}) };
  for (const finding of input.findings) {
    const key = `${finding.network}:${finding.address}`;
    if (seen.has(key) || !input.linkedKeys.has(key) || finding.confidence.excluded) continue;
    seen.add(key);
    // Adres giełdy, kontraktu, miksera, zbiórki lub instytucji nie jest portfelem prywatnym podmiotu — jego przepływy nie są „wyjściem” podmiotu.
    const addressClass = finding.chain?.profile.addressClass;
    if (addressClass !== undefined && addressClass !== 'private' && addressClass !== 'unknown') continue;
    result.push(
      ...assessFinding(finding, input.linkedKeys, input.documentedExits?.has(key) === true, key, input.replyExits?.get(key) ?? [], ctx).map((item) =>
        withGuidance(item, input.serviceLinks, input.registry),
      ),
    );
  }
  // Oznaki z publikacji kont podmiotu: osobna ocena, najwyżej „potencjalny sygnał wypłaty” — nigdy ostatni szczebel.
  const web = buildWebCashOutAssessment({
    publications,
    ...(input.serviceLinks ? { serviceLinks: input.serviceLinks } : {}),
    ...(input.registry !== undefined ? { registry: input.registry } : {}),
    ...(input.webKey ? { key: input.webKey } : {}),
  });
  if (web) result.push(web);
  return result.sort(
    (a, b) =>
      STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || b.indicator.score - a.indicator.score || (b.valuePln ?? 0) - (a.valuePln ?? 0) || a.id.localeCompare(b.id),
  );
}
