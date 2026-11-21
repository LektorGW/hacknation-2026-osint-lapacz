// Wskaźnik D — sygnały możliwej niezgłoszonej działalności gospodarczej.
//
// Pytanie KAS: czy osoba zarabia na obrocie (kryptowalutami albo towarami i usługami za kryptowaluty) w sposób
// zorganizowany i ciągły, a może tego nie zgłaszać (PIT-38, PIT-36/36L, CEIDG, JPK). Narzędzie NIE zna statusu
// podatkowego: pokazuje wyłącznie sygnały w źródłach publicznych i w blockchainie, z jawnymi regułami, oraz listę
// sprawdzeń, które może wykonać tylko KAS. Ocena jest zawsze hipotezą (`status: 'hypothesis'`).
//
// Trzy grupy składników (wagi i progi w `BUSINESS_RULES`):
//   Web2      — powtarzalne oferty (kopie liczone raz), cennik lub ogłoszenie usług, przyjmowanie płatności w krypto,
//               obrót P2P / kantor, własna strona ze sklepem i instrukcją płatności, kontakt w sprawie zamówień,
//               związek z Polską (sygnały z `signals.ts`);
//   Blockchain — wyłącznie adresy przypisane podmiotowi: wielu wpłacających, regularne wpływy, kwoty detaliczne,
//               obrót roczny w PLN (z istniejących wycen; obrót ≠ dochód), wyjście do giełdy (powiązanie ze wskaźnikiem C);
//   Rejestry  — CEIDG / KRS / wykaz VAT / rejestr walut wirtualnych z łączników użytych w analizie (bez nowych źródeł).
// Kontrdowody: adres zbiórki organizacji (darowizny, nie sprzedaż), strona z prośbą o wsparcie, jednorazowa sprzedaż,
// wpis w rejestrze działalności w zakresie walut wirtualnych (zarejestrowany dostawca usług — nie „ukryta” działalność),
// znaleziony wpis rejestrowy (działalność istnieje — pytanie brzmi wtedy, czy obrót jest zadeklarowany).
//
// `assessBusinessActivity` jest czystą funkcją; `businessSignalsFor` liczy wskaźnik dla dowolnego bytu siatki
// (rozwijanie sieci na żądanie), a `buildBusinessActivity` — dla podmiotu teczki wraz z węzłami jego siatki.

import { createHash } from 'node:crypto';
import { combineComponents, indicatorLevel, normalizeForFingerprint, strongestPath } from '@olcys/core';
import type {
  BusinessActivityAssessment,
  BusinessNetworkEntry,
  BusinessRegistryCheck,
  BusinessTurnoverYear,
  CashOutAssessment,
  ChainActivity,
  ComponentDraft,
  EvidenceRef,
  Finding,
  GraphEdge,
  GraphNode,
  Identifier,
  ProfileAttributes,
  RegisteredEntity,
  RegisteredEntityAssessment,
  SourceCategory,
} from '@olcys/core';
import { formatPln, plural, shortAddress } from './format.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { Sighting } from './intel.ts';
import { polishNexus, signalPhrase } from './signals.ts';

// ---------- Reguły ----------

/** Jawne reguły wskaźnika D — jedyne miejsce z wagami i progami. */
export const BUSINESS_RULES = {
  weights: {
    /** Dwie odrębne oferty; trzy i więcej; premia za oferty w co najmniej dwóch serwisach. */
    repeatedOffers: { two: 40, threeOrMore: 50, multiService: 5 },
    priceListOrServiceAd: 35,
    acceptsCryptoPayments: 35,
    p2pTrading: 45,
    websiteShop: 40,
    polishNexus: 10,
    contactForOrders: 20,
    /** Różni wpłacający: od 5, od 10, od 25 adresów. */
    manyPayers: { five: 30, ten: 40, twentyFive: 50 },
    /** Wpływy w co najmniej 3 miesiącach (przy pokryciu ≥ 50% okresu); w co najmniej 6 miesiącach. */
    regularInflows: { three: 30, six: 40 },
    retailAmounts: 20,
    /** Obrót w najwyższym roku: od 5 tys., od 20 tys., od 100 tys. zł. */
    turnover: { from5k: 10, from20k: 20, from100k: 30 },
    cashoutToExchange: 15,
    /** Brak wpisu przy wyszukiwaniu po numerze (NIP/KRS) albo domenie; przy wyszukiwaniu wyłącznie po nazwie. */
    registryNoneFound: { number: 10, name: 5 },
  },
  contradictions: {
    /** Adres zbiórki organizacji: wpłaty to darowizny, nie sprzedaż — kontrdowód twardy. */
    charityAddress: 40,
    /** Strona z prośbą o wsparcie (darowizny) bez oferty sprzedaży. */
    donationContext: 20,
    /** Jedna oferta, bez powtarzalnych wpływów — typowa sprzedaż prywatna. */
    oneOffSale: 15,
    /** Wpis w rejestrze działalności w zakresie walut wirtualnych / rejestrze MiCA: przy dopasowaniu po numerze lub domenie; po samej nazwie. */
    virtualCurrencyRegister: { exact: 30, nameOnly: 10 },
    /** Wpis w CEIDG / KRS / wykazie VAT: działalność jest zarejestrowana (składnik neutralny — przenosi pytanie na deklaracje). */
    registryFound: 10,
  },
  /** Ścieżka „podmiot zarejestrowany — zgodność obrotu i ryzyko prania pieniędzy” (sygnały do weryfikacji). */
  registered: {
    /** Obrót kryptowalutowy, a kody PKD podmiotu nie dotyczą handlu, finansów ani usług IT. */
    cryptoFlowsVsPkd: 40,
    /** Działy PKD uznane za zgodne z obrotem kryptowalutami lub sprzedażą za kryptowaluty. */
    relatedPkdDivisions: ['46', '47', '62', '63', '64', '66'],
    /** Rejestracja najwyżej tyle dni przed pierwszą aktywnością (albo po niej). */
    recentRegistration: 20,
    recentRegistrationDays: 365,
    /** Wpływy przy statusie VAT innym niż „Czynny” albo po wykreśleniu. */
    vatStatusInactiveOrRemoved: 35,
    /** Wypłata z odpowiedzi usługi na rachunek, którego końcówka zgadza się z rachunkiem z wykazu VAT. */
    payoutToWhitelistAccount: 60,
    /** Ile końcowych cyfr porównujemy (numer w odpowiedzi usługi jest zamaskowany). */
    maskedDigits: 4,
    /** Ten sam adres jako prywatny i jako adres płatności firmy. */
    personalAndCompanyMixing: 30,
    /** Członkowie organów wspólni z innymi podmiotami siatki. */
    sharedOfficerNetwork: 15,
    /** Lista sankcyjna albo ostrzeżenie KNF: dopasowanie mocne (identyfikator, druga cecha); słabe (sama nazwa). */
    riskStrong: 40,
    riskWeak: 15,
  },
  /** Od tylu wpływów liczymy składniki blockchain. */
  minInflows: 3,
  /** Kwoty „detaliczne”: wpływy w tym przedziale (PLN) stanowią co najmniej `retailShare` wycenionych wpływów. */
  retail: { minPln: 20, maxPln: 5000, share: 0.6, minValued: 5 },
  /** Wycena wpływu kursem z istniejącej wyceny tego samego aktywa najwyżej o tyle dni odległej. */
  rateWindowDays: 45,
  /** Publikacje o tej samej treści w odstępie krótszym niż tyle dni to kopia (przedruk), a nie nowa oferta. */
  copyWindowDays: 14,
  /** Podobieństwo zbiorów wyrazów, od którego dwie treści uznajemy za przedruk. */
  nearDuplicate: 0.8,
  /** Od jakiego wskaźnika związku z Polską (signals.ts) liczymy składnik `business.polish_nexus`. */
  polishNexusMin: 40,
  /** Od jakiego wyniku węzeł siatki ma odznakę „sygnały działalności”. */
  networkMinScore: 40,
  /** Od jakiego wyniku teczka dostaje zdanie w kluczowych ustaleniach. */
  keyFindingMinScore: 40,
} as const;

/** Łączniki rejestrów publicznych (istniejące — wskaźnik nie dodaje nowych źródeł). */
export const BUSINESS_REGISTRIES = [
  { connectorId: 'live-ceidg', registry: 'CEIDG (jednoosobowa działalność gospodarcza)', by: 'nip' as const },
  { connectorId: 'live-krs', registry: 'KRS (Krajowy Rejestr Sądowy)', by: 'krs' as const },
  { connectorId: 'live-vat-whitelist', registry: 'wykaz podatników VAT („biała lista”)', by: 'nip' as const },
  { connectorId: 'rejestry-publiczne', registry: 'rejestr działalności w zakresie walut wirtualnych (IAS Katowice) i rejestr MiCA (ESMA)', by: 'name' as const },
];
const REGISTRY_IDS = new Set(BUSINESS_REGISTRIES.map((item) => item.connectorId));

export const BUSINESS_LIMITATIONS = [
  'Wskaźnik D opisuje sygnały w źródłach publicznych i w blockchainie; nie rozstrzyga, czy działalność jest zarejestrowana ani czy przychód zadeklarowano — to sprawdzają wyłącznie systemy KAS.',
  'Kwoty to obrót (suma wpływów), a nie dochód ani przychód podatkowy: wpływ może być zwrotem, pożyczką, przelewem z innego własnego portfela albo darowizną.',
  'Jeden nadawca może używać wielu adresów, a jeden adres — wielu nadawców (np. portfel zbiorczy usługi): liczba wpłacających jest przybliżeniem.',
];

const SOURCE_WEB = 'publikacje podmiotu (źródła publiczne)';
const SOURCE_CHAIN = 'moduł danych blockchain';
const DAY_MS = 86_400_000;

// ---------- Pomocnicze ----------

const unique = <T>(items: T[]): T[] => [...new Set(items)];
const round2 = (value: number) => Math.round(value * 100) / 100;
/** Małe litery bez polskich znaków (pozycje zgodne z oryginałem nie są tu potrzebne). */
const fold = (text: string): string =>
  text
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
const warsaw = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw' });
/** Data w Polsce (`RRRR-MM-DD`) — o roku podatkowym decyduje czas polski. */
const polishDay = (time: string): string => warsaw.format(new Date(time));
const cite = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
};
const count = (value: number, one: string, few: string, many: string) => `${value} ${plural(value, one, few, many)}`;

// ---------- Sygnały w treści publikacji (liczone przy pobraniu dokumentu) ----------

export type BusinessTextKind =
  | 'sale'
  | 'price_list'
  | 'service_ad'
  | 'accepts_crypto'
  | 'p2p'
  | 'shop'
  | 'payment_instructions'
  | 'contact_for_orders'
  | 'donation';

/** Zwięzły zapis sygnałów jednej publikacji — zapisywany przy widzianym dokumencie (`Sighting.businessText`). */
export interface BusinessTextSignals {
  /** Cytaty (fragment oryginału) dla wykrytych sygnałów. */
  quotes: Partial<Record<BusinessTextKind, string>>;
  /** Związek z Polską według `signals.ts` (wynik i najwyżej trzy przesłanki). */
  nexus?: { score: number; reasons: string[] };
  /** Skrót treści po normalizacji (bez adresów, odnośników, wielkości liter) — do rozpoznania kopii. */
  fingerprint?: string;
  /** Do 40 charakterystycznych wyrazów treści — do rozpoznania przedruku z drobnymi zmianami. */
  tokens?: string[];
  /** Numery NIP / KRS podane w treści wprost po etykiecie (NIP z poprawną cyfrą kontrolną). */
  registryNumbers?: string[];
  /** Dla dokumentów łączników rejestrów: dane podmiotu tak, jak zwrócił je rejestr. */
  registry?: RegistryDetails;
}

/** Dane podmiotu z dokumentu rejestru (wykaz VAT, KRS, CEIDG) — odczytane z treści dokumentu łącznika. */
export interface RegistryDetails {
  connectorId: string;
  name?: string;
  nip?: string;
  krs?: string;
  regon?: string;
  vatStatus?: string;
  registrationDate?: string;
  removalDate?: string;
  pkd: { code: string; description?: string }[];
  capital?: string;
  people: string[];
  accounts: string[];
}

/** Odczyt pól z treści dokumentu rejestru (format łączników z packages/sources/src/registry.ts). */
export function registryDetailsOf(connectorId: string, text: string): RegistryDetails | undefined {
  if (!['live-vat-whitelist', 'live-krs', 'live-ceidg'].includes(connectorId)) return undefined;
  const field = (...labels: string[]): string | undefined => {
    for (const label of labels) {
      const hit = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+)$`, 'mi').exec(text);
      if (hit) return hit[1]!.trim();
    }
    return undefined;
  };
  const date = (value: string | undefined) => /\d{4}-\d{2}-\d{2}/.exec(value ?? '')?.[0];
  const pkdText = field('PKD', 'Główny PKD');
  const pkd = (pkdText ?? '')
    .split(';')
    .map((item) => /^\s*(\d{2}(?:\.\d{1,2})?(?:\.[A-Z])?)\s*(?:—\s*(.+))?$/.exec(item))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => ({ code: hit[1]!, ...(hit[2] ? { description: hit[2].trim() } : {}) }));
  const people = [
    ...(field('Reprezentanci') ?? '').split(';'),
    ...(field('Wspólnicy') ?? '').split(';'),
    ...(field('Przedsiębiorca') ?? '').split(';'),
    ...[...text.matchAll(/^- (.+)$/gm)].map((hit) => hit[1]!),
  ]
    .map((item) => item.trim())
    .filter(Boolean);
  const accounts = (field('Numery rachunków w wykazie') ?? '').split(/[,;]\s*/).map((item) => item.replace(/\s/g, '')).filter((item) => /^\d{26}$/.test(item));
  const nip = field('NIP')?.replace(/[^\d]/g, '');
  const krs = field('KRS')?.replace(/[^\d]/g, '');
  const ceidgStatus = connectorId === 'live-ceidg' ? field('Status') : undefined;
  const removal = date(field('Data wykreślenia', 'Data zakończenia działalności', 'Data zakończenia'));
  return {
    connectorId,
    ...(field('Nazwa', 'Nazwa firmy') ? { name: field('Nazwa', 'Nazwa firmy')! } : {}),
    ...(nip && nip.length === 10 ? { nip } : {}),
    ...(krs && krs.length === 10 ? { krs } : {}),
    ...(field('REGON') ? { regon: field('REGON')! } : {}),
    ...(field('Status VAT') ? { vatStatus: field('Status VAT')! } : ceidgStatus ? { vatStatus: `CEIDG: ${ceidgStatus}` } : {}),
    ...(date(field('Data rejestracji jako podatnik VAT', 'Data rejestracji w KRS', 'Data rozpoczęcia działalności')) ? { registrationDate: date(field('Data rejestracji jako podatnik VAT', 'Data rejestracji w KRS', 'Data rozpoczęcia działalności'))! } : {}),
    ...(removal ? { removalDate: removal } : {}),
    pkd,
    ...(field('Kapitał zakładowy') ? { capital: field('Kapitał zakładowy')! } : {}),
    people: unique(people).slice(0, 15),
    accounts,
  };
}

const PATTERNS: Partial<Record<BusinessTextKind, RegExp>> = {
  sale: /(?<![a-z0-9])(sprzedam|sprzedaje|sprzedajemy|na sprzedaz|oferuje|oferujemy|do kupienia|wysylka|wysylam|na stanie|for sale|selling|wts|in stock)(?![a-z0-9])/,
  price_list:
    /(?<![a-z0-9])(cennik|price ?list|ceny od|cena od|prices? from|\d+(?:[.,]\d+)?\s?(?:zl|pln|usdt|usd|eur)\s?(?:\/|za|per)\s?(?:szt|sztuke|godz|godzine|h|usluge|miesiac|mies|pc|pcs|item|hour))(?![a-z0-9])/,
  service_ad:
    /(?<![a-z0-9])(swiadcze uslugi|swiadczymy uslugi|oferuje uslugi|oferujemy uslugi|wykonuje|wykonujemy|naprawiam|naprawy|realizuje zamowienia|realizujemy zamowienia|na zamowienie|przyjmuje zlecenia|przyjmujemy zlecenia|commissions open)(?![a-z0-9])/,
  shop: /(?<![a-z0-9])(sklep\w*|koszyk|zamowienie|zamowienia|checkout|add to cart|order now|regulamin|dostawa|shipping)(?![a-z0-9])/,
  payment_instructions: /(po wplacie|platnosc na adres|wplata na adres|wplaty na adres|adres do platnosci|w tytule|instrukcja platnosci|payment instructions|after payment)/,
  contact_for_orders:
    /(?<![a-z0-9])(?:(?:zamowienia|zamowienie|zamow|zapytania|wycena|wyceny)\b.{0,40}\b(?:priv|pw|dm|telegram|signal|whatsapp|e-?mail|mail|tel|telefon|sms|napisz|kontakt)|(?:pisz|napisz|kontakt)\b.{0,30}\b(?:priv|pw|dm|telegram|signal|whatsapp)|orders? via|dm (?:me|for))/,
  donation: /(?<![a-z0-9])(wesprzyj|wsparcie projektu|darowizn\w*|donat\w*|tip ?jar|napiwek|buy me a coffee|zbiorka|zrzutka|support (?:me|the project|my work))(?![a-z0-9])/,
};
const ACCEPTS_EXTRA = /(?<![a-z0-9])(?:(?:przyjmuje|przyjmujemy|akceptuje|akceptujemy)\s+(?:platnosci|platnosc)|platnosc\s*:?\s*(?:w\s+)?(?:btc|usdt|eth|krypto\w*|bitcoin\w*)|we accept (?:btc|bitcoin|crypto|usdt))/;
const P2P_OFFER =
  /(?<![a-z0-9])(?:sprzedam|odsprzedam|kupie|skupuje|wymienie|zamienie|selling|buying|wts|wtb|i sell|i buy|we sell|we buy)\s+(?:\d+(?:[.,]\d+)?\s*)?(?:btc|bitcoin\w*|eth|ethereum|usdt|usdc|tether|krypto\w*|crypto\w*|ltc|xmr|monero|stablecoin\w*)(?![a-z0-9])/;
const P2P_EXTRA =/(?<![a-z0-9])(kantor\w*|p2p|wymiana (?:btc|usdt|eth|krypto\w*)|kurs dnia|skup (?:btc|krypto\w*|usdt)|otc)(?![a-z0-9])/;

/** NIP: 10 cyfr z poprawną cyfrą kontrolną. */
const validNip = (digits: string): boolean => {
  if (!/^\d{10}$/.test(digits)) return false;
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  return weights.reduce((sum, weight, index) => sum + weight * Number(digits[index]), 0) % 11 === Number(digits[9]);
};

function registryNumbersIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])NIP(?:[\s:]|\s*nr\.?\s*)*(?:PL)?\s*(\d{3}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}|\d{3}[\s-]?\d{2}[\s-]?\d{2}[\s-]?\d{3})(?!\d)/giu)) {
    const digits = match[1]!.replace(/[\s-]/g, '');
    if (validNip(digits)) found.add(`NIP ${digits}`);
  }
  for (const match of text.matchAll(/(?<![\p{L}\p{N}])KRS(?:[\s:]|\s*nr\.?\s*)*(\d{10})(?!\d)/giu)) if (Number(match[1]) > 0) found.add(`KRS ${match[1]}`);
  return [...found];
}

/**
 * Sygnały działalności w treści jednej publikacji. Wywoływane przy pobraniu dokumentu (pełna treść), a dla starszych
 * analiz — z tego, co zostało w teczce (tytuł, opis profilu, fragmenty przy adresach). `undefined` — brak sygnałów.
 */
export function businessTextOf(doc: { text: string; title?: string; url?: string; author?: string; profile?: ProfileAttributes; connectorId?: string }): BusinessTextSignals | undefined {
  const registry = doc.connectorId ? registryDetailsOf(doc.connectorId, doc.text) : undefined;
  if (registry) return { quotes: {}, registry };
  const original = [doc.title ?? '', doc.text, doc.profile?.bio ?? ''].join('\n').normalize('NFC');
  const folded = fold(original);
  const quotes: BusinessTextSignals['quotes'] = {};
  for (const [kind, pattern] of Object.entries(PATTERNS) as [BusinessTextKind, RegExp][]) {
    const hit = pattern.exec(folded);
    if (hit) quotes[kind] = cite(original, hit.index, hit[0].length);
  }
  const signalInput = { text: doc.text, ...(doc.title ? { title: doc.title } : {}), ...(doc.url ? { url: doc.url } : {}), ...(doc.author ? { author: doc.author } : {}), ...(doc.profile ? { profile: doc.profile } : {}) };
  const accepts = signalPhrase('cryptoPayments', signalInput) ?? (() => {
    const hit = ACCEPTS_EXTRA.exec(folded);
    return hit ? cite(original, hit.index, hit[0].length) : undefined;
  })();
  if (accepts) quotes.accepts_crypto = accepts;
  // Oferta obrotu kryptowalutą: nazwa waluty TUŻ po formie ofertowej („sprzedam BTC”, „kupię 0,5 USDT”) — nie
  // „sprzedam koparkę …, płatność w BTC” (to sprzedaż sprzętu za kryptowalutę, a nie wymiana).
  const p2p = [P2P_OFFER, P2P_EXTRA]
    .map((pattern) => pattern.exec(folded))
    .filter((hit): hit is RegExpExecArray => hit !== null)
    .map((hit) => cite(original, hit.index, hit[0].length))[0];
  if (p2p) quotes.p2p = p2p;
  if (!quotes.payment_instructions) {
    const deposit = signalPhrase('depositAddressRequest', signalInput);
    if (deposit) quotes.payment_instructions = deposit;
  }
  const nexus = polishNexus(signalInput);
  const normalized = normalizeForFingerprint(doc.text);
  const tokens = unique(normalized.split(' ').filter((token) => token.length >= 4)).slice(0, 40);
  const numbers = registryNumbersIn(original);
  const any = Object.keys(quotes).length > 0 || nexus.score > 0 || numbers.length > 0;
  if (!any) return undefined;
  return {
    quotes,
    ...(nexus.score > 0 ? { nexus: { score: nexus.score, reasons: nexus.reasons.slice(0, 3) } } : {}),
    ...(normalized.replace(/ /g, '').length >= 24 ? { fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 16) } : {}),
    ...(tokens.length >= 8 ? { tokens } : {}),
    ...(numbers.length > 0 ? { registryNumbers: numbers } : {}),
  };
}

// ---------- Wejście oceny ----------

/** Publikacja przypisana ocenianemu bytowi. */
export interface BusinessPublication {
  url: string;
  service: string;
  connectorId?: string;
  title?: string;
  category?: SourceCategory;
  publishedAt?: string;
  archivedAt?: string;
  contentHash?: string;
  signals?: BusinessTextSignals;
  /** Adresy w treści publikacji (`sieć:adres`). */
  addresses?: string[];
}

/** Adres przypisany ocenianemu bytowi wraz z zapisaną aktywnością blockchain. */
export interface BusinessAddress {
  address: string;
  network: string;
  chain?: ChainActivity;
  /** Organizacja, której to adres zbiórki / płatności (beneficjent) — wtedy wpłaty to darowizny. */
  charity?: string;
}

/** Wpis rejestrowy znaleziony w analizie (dokument łącznika rejestru). */
export interface BusinessRegistryRecord {
  connectorId: string;
  service: string;
  url: string;
  title: string;
  organization?: string;
  registryEntries?: string[];
  /** Dopasowanie wyłącznie po nazwie (możliwa zbieżność nazw). */
  nameOnly?: boolean;
  /** Dane podmiotu odczytane z dokumentu rejestru (wykaz VAT, KRS, CEIDG). */
  details?: RegistryDetails;
}

/** Wypłata na rachunek bankowy z odpowiedzi usługi (dokument spoza OSINT) — numer rachunku zamaskowany. */
export interface BusinessServicePayout {
  replyId: string;
  serviceName: string;
  reference: string;
  bankAccountMasked: string;
  amount?: number;
  currency?: string;
  time?: string;
}

/** Flaga listy sankcyjnej / ostrzeżeń KNF dla węzła (zgodna z `RiskNodeFlag` z @olcys/sources). */
export interface BusinessRiskFlag {
  nodeId: string;
  badge: string;
  status: string;
  confidence: string;
  summary: string;
}

/** Dane do ścieżki „podmiot zarejestrowany — zgodność obrotu i ryzyko prania pieniędzy”. */
export interface RegisteredTrackContext {
  payouts?: BusinessServicePayout[];
  /** Organizacje z sieci organizacji (rejestry) — do adresów płatności firmy i wspólnych członków organów. */
  organizations?: { id: string; name: string; krs?: string; nip?: string; addressKeys: string[] }[];
  orgRelations?: { from: string; to: string; kind: string; explanation: string }[];
  riskFlags?: BusinessRiskFlag[];
}

export interface BusinessRegistryInput {
  /** Łączniki użyte w analizie. */
  connectorsUsed: string[];
  /** Identyfikatory, po których szukano (podane przez analityka i odkryte). */
  identifiers: Identifier[];
  records: BusinessRegistryRecord[];
  /** Łączniki, które nie odpowiedziały. */
  failedConnectors?: string[];
  /** Numery NIP / KRS widoczne w publikacjach, ale nieużyte w zapytaniach (np. dane piaskownicy). */
  numbersInPublications?: string[];
}

/** Wycena istniejąca w danych (wypłata, ścieżka) — z niej bierzemy kurs aktywa w dniu wpływu. */
export interface BusinessValuation {
  asset: string;
  time: string;
  amount: number;
  valuePln: number;
  txid?: string;
  /** Kurs przykładowy (dane demonstracyjne), nie rynkowy. */
  sample?: boolean;
}

export interface BusinessInput {
  id: string;
  subject: BusinessActivityAssessment['subject'];
  publications: BusinessPublication[];
  addresses: BusinessAddress[];
  /** Klucze `sieć:adres` wszystkich adresów bytu — przelewy między nimi nie są wpływami. */
  ownKeys?: Set<string>;
  valuations?: BusinessValuation[];
  registry?: BusinessRegistryInput;
  /** Oceny wskaźnika C dla adresów bytu. */
  cashOut?: CashOutAssessment[];
  /** Dane do drugiej ścieżki (podmiot zarejestrowany). */
  registered?: RegisteredTrackContext;
}

// ---------- Kopie publikacji ----------

/** Adres publikacji bez archiwum, protokołu, `www.`, parametrów i końcowego ukośnika. */
const originUrl = (url: string): string =>
  url
    .replace(/^https?:\/\/(?:web\.)?archive\.org\/web\/\d+[a-z_]*\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/[#?].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();

const pubTime = (pub: BusinessPublication): string | undefined => pub.publishedAt ?? pub.archivedAt;

function jaccard(a: string[] | undefined, b: string[] | undefined): number {
  if (!a || !b || a.length < 8 || b.length < 8) return 0;
  const left = new Set(a);
  let shared = 0;
  for (const token of b) if (left.has(token)) shared++;
  return shared / (left.size + new Set(b).size - shared);
}

interface OfferGroup {
  publications: BusinessPublication[];
  first?: string;
  services: string[];
  reasons: string[];
}

/**
 * Dzieli publikacje na odrębne oferty. Kopia to: ta sama strona (także w archiwum), ta sama treść (skrót SHA-256),
 * albo ta sama lub niemal ta sama treść opublikowana w odstępie krótszym niż `copyWindowDays` (przedruk, wpis
 * w drugim serwisie tego samego dnia). Ta sama treść wystawiona ponownie po tygodniach to kolejna oferta.
 */
export function groupOffers(publications: BusinessPublication[]): OfferGroup[] {
  const parent = publications.map((_, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  const reasons = new Map<number, Set<string>>();
  const join = (a: number, b: number, reason: string) => {
    const [ra, rb] = [find(a), find(b)];
    const merged = new Set([...(reasons.get(ra) ?? []), ...(reasons.get(rb) ?? []), reason]);
    parent[ra] = rb;
    reasons.set(rb, merged);
  };
  for (let i = 0; i < publications.length; i++) {
    for (let j = i + 1; j < publications.length; j++) {
      const [a, b] = [publications[i]!, publications[j]!];
      if (originUrl(a.url) === originUrl(b.url)) join(i, j, 'ta sama strona (kopia archiwalna lub powtórne pobranie)');
      else if (a.contentHash && a.contentHash === b.contentHash) join(i, j, 'identyczna treść (ten sam skrót SHA-256)');
      else {
        const [ta, tb] = [pubTime(a), pubTime(b)];
        const close = !ta || !tb || Math.abs(Date.parse(ta) - Date.parse(tb)) < BUSINESS_RULES.copyWindowDays * DAY_MS;
        const same = a.signals?.fingerprint !== undefined && a.signals.fingerprint === b.signals?.fingerprint;
        const near = !same && jaccard(a.signals?.tokens, b.signals?.tokens) >= BUSINESS_RULES.nearDuplicate;
        if (close && (same || near)) join(i, j, same ? 'ta sama treść w krótkim odstępie czasu (przedruk)' : 'niemal identyczna treść w krótkim odstępie czasu (przedruk)');
      }
    }
  }
  const groups = new Map<number, BusinessPublication[]>();
  publications.forEach((pub, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), pub]));
  return [...groups.entries()]
    .map(([root, items]) => {
      const times = items.map(pubTime).filter((value): value is string => Boolean(value)).sort();
      return { publications: items, ...(times[0] ? { first: times[0] } : {}), services: unique(items.map((item) => item.service.toLowerCase())), reasons: [...(reasons.get(root) ?? [])] };
    })
    .sort((a, b) => (a.first ?? '').localeCompare(b.first ?? '') || a.publications[0]!.url.localeCompare(b.publications[0]!.url));
}

// ---------- Wpływy w blockchainie ----------

interface Inflow {
  txid: string;
  time: string;
  day: string;
  address: string;
  network: string;
  counterparty: string;
  asset: string;
  amount: number;
  valuePln?: number;
  sample?: boolean;
  rateNote?: string;
}

const STABLE = new Set(['USDT', 'USDC', 'DAI']);
const assetKey = (asset: string) => (STABLE.has(asset.toUpperCase()) ? 'USD-STABLE' : asset.toUpperCase());

/** Kurs w dniu wpływu z najbliższej istniejącej wyceny tego samego aktywa (w oknie `rateWindowDays`). */
export function rateFor(asset: string, time: string, valuations: BusinessValuation[]): { rate: number; note: string; sample: boolean } | undefined {
  const at = Date.parse(time);
  let best: { valuation: BusinessValuation; distance: number } | undefined;
  for (const valuation of valuations) {
    if (assetKey(valuation.asset) !== assetKey(asset) || !(valuation.amount > 0) || !(valuation.valuePln > 0)) continue;
    const distance = Math.abs(Date.parse(valuation.time) - at);
    if (distance > BUSINESS_RULES.rateWindowDays * DAY_MS) continue;
    if (!best || distance < best.distance) best = { valuation, distance };
  }
  if (!best) return undefined;
  const rate = best.valuation.valuePln / best.valuation.amount;
  return {
    rate,
    sample: best.valuation.sample === true,
    note: `kurs ok. ${formatPln(round2(rate))}/${best.valuation.asset} przyjęty z wyceny transakcji${best.valuation.txid ? ` ${shortAddress(best.valuation.txid)}` : ''} z ${polishDay(best.valuation.time)}${best.valuation.sample ? ' (KURS PRZYKŁADOWY — dane demonstracyjne)' : ''}`,
  };
}

/** Wyceny zapisane w danych blockchain: wypłaty do usług i udokumentowane ścieżki. */
export function valuationsOf(findings: Finding[]): BusinessValuation[] {
  const result: BusinessValuation[] = [];
  for (const finding of findings) {
    for (const item of finding.chain?.cashOuts ?? []) {
      if (item.valuePln !== undefined && item.amount > 0) result.push({ asset: item.asset, time: item.time, amount: item.amount, valuePln: item.valuePln, txid: item.txid, sample: /KURS PRZYKŁADOWY/.test(item.valuation ?? '') });
    }
    for (const trail of finding.chain?.trails ?? []) {
      const last = trail.hops.at(-1);
      if (trail.valuePln !== undefined && trail.amount > 0 && last) result.push({ asset: trail.asset, time: last.time, amount: trail.amount, valuePln: trail.valuePln, txid: last.txid, sample: /KURS PRZYKŁADOWY/.test(trail.valuation ?? '') });
    }
  }
  return result;
}

const SERVICE_CLASSES = new Set(['exchange', 'smart_contract', 'institutional', 'mixer']);

function collectInflows(addresses: BusinessAddress[], ownKeys: Set<string>, valuations: BusinessValuation[]) {
  const inflows: Inflow[] = [];
  let serviceInflows = 0;
  let exchangeInflows = 0;
  const excluded: string[] = [];
  for (const item of addresses) {
    const chain = item.chain;
    if (!chain) continue;
    const addressClass = chain.profile.addressClass;
    if (item.charity || addressClass === 'charity') {
      excluded.push(`${shortAddress(item.address)} (adres zbiórki${item.charity ? ` organizacji „${item.charity}”` : ''})`);
      continue;
    }
    if (addressClass !== 'private' && addressClass !== 'unknown') {
      excluded.push(`${shortAddress(item.address)} (adres usługi lub kontraktu — nie portfel podmiotu)`);
      continue;
    }
    const seized = new Set(((chain as { seizures?: { txid?: string }[] }).seizures ?? []).map((entry) => entry.txid));
    for (const transfer of chain.transfers) {
      if (transfer.direction !== 'in' || seized.has(transfer.txid)) continue;
      if (ownKeys.has(`${item.network}:${transfer.counterparty}`)) continue;
      if (transfer.asset.includes('niezweryfikowany') || !(transfer.amount > 0)) continue;
      const kind = (transfer as { counterpartyKind?: string }).counterpartyKind;
      if (transfer.counterpartyClass === 'exchange') {
        exchangeInflows++;
        continue;
      }
      if (SERVICE_CLASSES.has(transfer.counterpartyClass) || (kind !== undefined && kind !== 'stablecoin_swap')) {
        serviceInflows++;
        continue;
      }
      const rate = rateFor(transfer.asset, transfer.time, valuations);
      inflows.push({
        txid: transfer.txid,
        time: transfer.time,
        day: polishDay(transfer.time),
        address: item.address,
        network: item.network,
        counterparty: transfer.counterparty,
        asset: transfer.asset,
        amount: transfer.amount,
        ...(rate ? { valuePln: round2(transfer.amount * rate.rate), rateNote: rate.note, sample: rate.sample } : {}),
      });
    }
  }
  inflows.sort((a, b) => a.time.localeCompare(b.time) || a.txid.localeCompare(b.txid));
  return { inflows, serviceInflows, exchangeInflows, excluded };
}

function turnoverByYear(inflows: Inflow[]): BusinessTurnoverYear[] {
  const years = new Map<string, Inflow[]>();
  for (const inflow of inflows) years.set(inflow.day.slice(0, 4), [...(years.get(inflow.day.slice(0, 4)) ?? []), inflow]);
  return [...years.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, items]) => {
      const valued = items.filter((item) => item.valuePln !== undefined);
      return {
        year,
        inflows: items.length,
        payers: new Set(items.map((item) => item.counterparty)).size,
        valuePln: round2(valued.reduce((sum, item) => sum + item.valuePln!, 0)),
        valued: valued.length,
        sampleRated: valued.filter((item) => item.sample).length,
      };
    });
}

const monthsBetween = (first: string, last: string): number => {
  const [y1, m1] = first.split('-').map(Number);
  const [y2, m2] = last.split('-').map(Number);
  return (y2! - y1!) * 12 + (m2! - m1!) + 1;
};

// ---------- Rejestry ----------

const NAME_TYPES = new Set(['full_name', 'nick', 'profile_url']);

function registryChecks(input: BusinessRegistryInput | undefined): BusinessRegistryCheck[] {
  if (!input) return [];
  // Dokument łącznika rejestru dowodzi, że łącznik był użyty (także gdy wykaz łączników analizy jest niepełny).
  const used = new Set([...input.connectorsUsed, ...input.records.map((record) => record.connectorId)]);
  const failed = new Set(input.failedConnectors ?? []);
  const numbers = unique(
    input.identifiers
      .filter((item) => item.type === 'login' || item.type === 'nick')
      .map((item) => item.value.trim())
      .flatMap((value) => {
        const nip = /^(?:NIP[\s:]*(?:PL)?|PL)\s*([\d\s-]{10,13})$/i.exec(value);
        if (nip && validNip(nip[1]!.replace(/[\s-]/g, ''))) return [`NIP ${nip[1]!.replace(/[\s-]/g, '')}`];
        const krs = /^KRS[\s:]*(\d{1,10})$/i.exec(value);
        return krs && Number(krs[1]) > 0 ? [`KRS ${krs[1]!.padStart(10, '0')}`] : [];
      }),
  );
  const names = unique(input.identifiers.filter((item) => NAME_TYPES.has(item.type)).map((item) => `${item.type === 'profile_url' ? 'domena/strona' : 'nazwa'} „${item.value.trim()}”`));
  return BUSINESS_REGISTRIES.map(({ connectorId, registry, by }) => {
    const records = input.records
      .filter((record) => record.connectorId === connectorId)
      .map((record) => ({
        name: record.organization ?? record.title,
        ...(record.registryEntries?.[0] ? { identifier: record.registryEntries[0] } : {}),
        url: record.url,
        ...(record.registryEntries && record.registryEntries.length > 0 ? { status: record.registryEntries.join('; ') } : {}),
        ...(record.nameOnly ? { nameOnly: true } : {}),
      }));
    const queries = by === 'name' ? names : numbers.filter((item) => item.startsWith(by === 'krs' ? 'KRS' : 'NIP'));
    const basis: BusinessRegistryCheck['basis'] = queries.length === 0 ? 'none' : by === 'name' ? (queries.some((item) => item.startsWith('domena')) ? 'domain' : 'name') : 'number';
    if (!used.has(connectorId)) {
      const why =
        connectorId === 'live-ceidg'
          ? 'Łącznik CEIDG nie był użyty w tej analizie — wymaga tokenu Hurtowni danych CEIDG (zmienna CEIDG_API_TOKEN) i włączonych źródeł publicznych.'
          : connectorId === 'rejestry-publiczne'
            ? 'Łącznik rejestrów publicznych nie był użyty w tej analizie.'
            : 'Łącznik nie był użyty w tej analizie (źródła publiczne wyłączone albo nie wybrane przez analityka).';
      const unused = (input.numbersInPublications ?? []).filter((item) => item.startsWith(by === 'krs' ? 'KRS' : 'NIP'));
      return { registry, connectorId, status: 'not_checked' as const, basis: 'none' as const, queries: [], records: [], note: `${why}${unused.length > 0 && by !== 'name' ? ` W publikacjach podano: ${unused.join(', ')} — do sprawdzenia ręcznie.` : ''}` };
    }
    if (failed.has(connectorId) && records.length === 0) {
      return { registry, connectorId, status: 'unavailable' as const, basis, queries, records, note: 'Źródło nie odpowiedziało w tej analizie — brak wyniku nie oznacza braku wpisu.' };
    }
    if (records.length > 0) {
      return { registry, connectorId, status: 'found' as const, basis, queries, records, note: records.every((item) => item.nameOnly) ? 'Znaleziono wpis zgodny tylko z nazwą — możliwa zbieżność nazw; wymaga potwierdzenia numerem.' : 'Znaleziono wpis w rejestrze.' };
    }
    if (queries.length === 0) {
      return {
        registry,
        connectorId,
        status: 'not_checked' as const,
        basis,
        queries,
        records,
        note: by === 'name' ? 'Brak nazwy, nicku ani domeny do sprawdzenia.' : `W danych sprawy nie było numeru ${by === 'krs' ? 'KRS' : 'NIP'} — rejestru nie było o co zapytać.`,
      };
    }
    return {
      registry,
      connectorId,
      status: 'not_found' as const,
      basis,
      queries,
      records,
      note:
        basis === 'number'
          ? 'Szukano po numerze — wpisu nie znaleziono w dniu analizy.'
          : 'Szukano wyłącznie po nazwie, nicku lub domenie — wyszukiwanie po nazwie jest zawodne: osoba może działać pod inną zarejestrowaną nazwą.',
    };
  });
}

// ---------- Ocena ----------

const urlRefs = (items: BusinessPublication[]): EvidenceRef[] => unique(items.map((item) => item.url)).slice(0, 8).map((value) => ({ kind: 'url' as const, value }));
const txRefs = (items: { txid: string }[], max = 8): EvidenceRef[] => unique(items.map((item) => item.txid)).slice(0, max).map((value) => ({ kind: 'txid' as const, value }));
const isWebsite = (pub: BusinessPublication): boolean => /(^|-)www(-|$)/.test(pub.connectorId ?? '') || /^www\./i.test(pub.service) || pub.connectorId === 'live-www';
const isCommercial = (pub: BusinessPublication): boolean => {
  const quotes = pub.signals?.quotes ?? {};
  return pub.category === 'sale_offer' || quotes.p2p !== undefined || quotes.price_list !== undefined || quotes.service_ad !== undefined || (quotes.sale !== undefined && (quotes.accepts_crypto !== undefined || quotes.shop !== undefined));
};

/** Klucz pochodzenia: składnik oparty na jednej grupie publikacji dzieli ją z innymi składnikami z tej grupy. */
function originOf(pubs: BusinessPublication[], groups: OfferGroup[], fallback: string): string {
  const owners = unique(pubs.map((pub) => groups.findIndex((group) => group.publications.includes(pub))));
  return owners.length === 1 && owners[0]! >= 0 ? `pub:${owners[0]}` : fallback;
}

/** Wskaźnik D dla jednego bytu — czysta funkcja z jawnymi regułami. */
export function assessBusinessActivity(input: BusinessInput): BusinessActivityAssessment {
  const W = BUSINESS_RULES.weights;
  const C = BUSINESS_RULES.contradictions;
  const drafts: ComponentDraft[] = [];
  const limitations: string[] = [...BUSINESS_LIMITATIONS];
  const pubs = input.publications.filter((pub) => !REGISTRY_IDS.has(pub.connectorId ?? ''));
  const all = groupOffers(pubs);
  const commercialPubs = pubs.filter(isCommercial);
  const offers = groupOffers(commercialPubs);
  const quoted = (kind: BusinessTextKind) => pubs.filter((pub) => pub.signals?.quotes[kind] !== undefined);
  const quoteLine = (items: BusinessPublication[], kind: BusinessTextKind) =>
    items
      .slice(0, 3)
      .map((pub) => `„${pub.signals!.quotes[kind]}” (${pub.service})`)
      .join('; ');

  // ---------- Web2 ----------
  if (offers.length >= 2) {
    const services = unique(offers.flatMap((group) => group.services));
    const weight = (offers.length >= 3 ? W.repeatedOffers.threeOrMore : W.repeatedOffers.two) + (services.length >= 2 ? W.repeatedOffers.multiService : 0);
    const dated = offers.filter((group) => group.first).map((group) => group.first!);
    const copies = commercialPubs.length - offers.length;
    drafts.push({
      rule: 'business.repeated_offers',
      weight,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: 'web:offers',
      evidence: urlRefs(offers.map((group) => group.publications[0]!)),
      explanation:
        `${count(offers.length, 'odrębna oferta', 'odrębne oferty', 'odrębnych ofert')} sprzedaży lub wymiany w ${count(services.length, 'serwisie', 'serwisach', 'serwisach')} (${services.join(', ')})` +
        (dated.length >= 2 ? ` opublikowanych między ${polishDay(dated[0]!)} a ${polishDay(dated.at(-1)!)}` : '') +
        '. Powtarzalne oferty w czasie to typowy sygnał działalności zorganizowanej i ciągłej.',
      ...(copies > 0
        ? { independenceNote: `Kopie tej samej oferty policzono raz: ${count(commercialPubs.length, 'publikacja', 'publikacje', 'publikacji')} → ${count(offers.length, 'oferta', 'oferty', 'ofert')} (${unique(offers.flatMap((group) => group.reasons)).join('; ')}).` }
        : {}),
      limitations: ['Oferta nie dowodzi, że do sprzedaży doszło; część ofert mogła dotyczyć tego samego towaru.', 'Ta sama treść wystawiona ponownie po kilku tygodniach jest liczona jako kolejna oferta.'],
    });
  }
  const priced = pubs.filter((pub) => pub.signals?.quotes.price_list !== undefined || pub.signals?.quotes.service_ad !== undefined);
  if (priced.length > 0) {
    drafts.push({
      rule: 'business.price_list_or_service_ad',
      weight: W.priceListOrServiceAd,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: originOf(priced, all, 'web:price'),
      evidence: urlRefs(priced),
      explanation: `Cennik albo ogłoszenie usług: ${priced
        .slice(0, 3)
        .map((pub) => `„${pub.signals!.quotes.price_list ?? pub.signals!.quotes.service_ad}” (${pub.service})`)
        .join('; ')}.`,
      limitations: ['Cennik pokazuje ofertę, nie obrót; usługa mogła być świadczona okazjonalnie.'],
    });
  }
  const accepts = quoted('accepts_crypto');
  if (accepts.length > 0) {
    drafts.push({
      rule: 'business.accepts_crypto_payments',
      weight: W.acceptsCryptoPayments,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: originOf(accepts, all, 'web:accepts'),
      evidence: urlRefs(accepts),
      explanation: `Podmiot przyjmuje zapłatę w kryptowalutach: ${quoteLine(accepts, 'accepts_crypto')}.`,
      limitations: ['Przyjmowanie płatności w kryptowalutach jest legalne; sygnał dotyczy wyłącznie tego, że wpływy mogą być zapłatą za towar lub usługę.'],
    });
  }
  const p2p = quoted('p2p');
  if (p2p.length > 0) {
    drafts.push({
      rule: 'business.p2p_trading',
      weight: W.p2pTrading,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: originOf(p2p, all, 'web:p2p'),
      evidence: urlRefs(p2p),
      explanation: `Oferta wymiany kryptowalut (P2P, kantor, skup): ${quoteLine(p2p, 'p2p')}. Stała wymiana na rzecz innych osób może wymagać wpisu do rejestru działalności w zakresie walut wirtualnych.`,
      limitations: ['Jednorazowa sprzedaż własnych kryptowalut nie jest działalnością gospodarczą; znaczenie ma powtarzalność (składnik `business.repeated_offers`).'],
    });
  }
  const shops = pubs.filter((pub) => isWebsite(pub) && (pub.signals?.quotes.shop !== undefined || pub.signals?.quotes.payment_instructions !== undefined) && (pub.signals?.quotes.accepts_crypto !== undefined || pub.signals?.quotes.payment_instructions !== undefined || pub.signals?.quotes.price_list !== undefined));
  if (shops.length > 0) {
    drafts.push({
      rule: 'business.website_shop',
      weight: W.websiteShop,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: originOf(shops, all, 'web:shop'),
      evidence: urlRefs(shops),
      explanation: `Własna strona z ofertą i instrukcją płatności: ${shops
        .slice(0, 2)
        .map((pub) => `„${pub.signals!.quotes.shop ?? pub.signals!.quotes.payment_instructions}” (${pub.url})`)
        .join('; ')}.`,
      limitations: ['Strona może być nieaktywna albo prowadzona przez inną osobę niż autor pozostałych publikacji.'],
    });
  }
  const contact = quoted('contact_for_orders');
  if (contact.length > 0) {
    drafts.push({
      rule: 'business.contact_for_orders',
      weight: W.contactForOrders,
      direction: 'supports',
      source: SOURCE_WEB,
      originKey: originOf(contact, all, 'web:contact'),
      evidence: urlRefs(contact),
      explanation: `Kontakt w sprawie zamówień: ${quoteLine(contact, 'contact_for_orders')}.`,
      limitations: ['Prośba o kontakt sama w sobie nie świadczy o skali sprzedaży.'],
    });
  }
  const nexus = pubs.filter((pub) => (pub.signals?.nexus?.score ?? 0) >= BUSINESS_RULES.polishNexusMin).sort((a, b) => (b.signals!.nexus!.score - a.signals!.nexus!.score));
  if (nexus.length > 0 && (offers.length > 0 || accepts.length > 0 || priced.length > 0)) {
    drafts.push({
      rule: 'business.polish_nexus',
      weight: W.polishNexus,
      direction: 'supports',
      source: `${SOURCE_WEB} — reguły związku z Polską (signals.ts)`,
      originKey: 'web:nexus',
      evidence: urlRefs(nexus.slice(0, 3)),
      explanation: `Związek z Polską (wynik ${nexus[0]!.signals!.nexus!.score}/100): ${nexus[0]!.signals!.nexus!.reasons.join('; ')}. Wskazuje polską jurysdykcję podatkową działalności.`,
      limitations: ['Język, waluta czy miasto nie ustalają rezydencji podatkowej.'],
    });
  }

  // ---------- Blockchain ----------
  const ownKeys = input.ownKeys ?? new Set(input.addresses.map((item) => `${item.network}:${item.address}`));
  const { inflows, serviceInflows, exchangeInflows, excluded } = collectInflows(input.addresses, ownKeys, input.valuations ?? []);
  const turnover = turnoverByYear(inflows);
  const payers = unique(inflows.map((item) => item.counterparty));
  const months = unique(inflows.map((item) => item.day.slice(0, 7))).sort();
  const span = months.length > 0 ? monthsBetween(months[0]!, months.at(-1)!) : 0;
  const valued = inflows.filter((item) => item.valuePln !== undefined);
  let manyPayers = false;
  let regular = false;
  if (excluded.length > 0) limitations.push(`Pominięto adresy, których wpływy nie są wpływami podmiotu: ${excluded.join(', ')}.`);
  if (exchangeInflows + serviceInflows > 0) {
    limitations.push(
      `Wypłaty z giełd i usług na adresy podmiotu (${count(exchangeInflows + serviceInflows, 'przelew', 'przelewy', 'przelewów')}) liczone osobno — to przeniesienie własnych środków, nie zapłata od klienta.`,
    );
  }
  if (inflows.length >= BUSINESS_RULES.minInflows) {
    const head = `${count(inflows.length, 'wpływ', 'wpływy', 'wpływów')} od kontrahentów spoza usług`;
    if (payers.length >= 5) {
      manyPayers = true;
      drafts.push({
        rule: 'business.many_payers',
        weight: payers.length >= 25 ? W.manyPayers.twentyFive : payers.length >= 10 ? W.manyPayers.ten : W.manyPayers.five,
        direction: 'supports',
        source: SOURCE_CHAIN,
        originKey: 'chain:payers',
        evidence: [...txRefs(inflows, 6), ...payers.slice(0, 4).map((value) => ({ kind: 'address' as const, value }))],
        explanation:
          `${count(payers.length, 'różny adres', 'różne adresy', 'różnych adresów')} nadawców (${head}). Wielu niezależnych wpłacających to wzorzec klientów, nie przelewów własnych.` +
          (exchangeInflows > 0 ? ` Wypłaty z giełd (${exchangeInflows}) nie są liczone jako wpłacający.` : ''),
        limitations: ['Adresy nadawców bez etykiety mogą należeć do jednej osoby albo do usługi bez publicznej etykiety.'],
      });
    }
    const coverage = span > 0 ? months.length / span : 0;
    if (months.length >= 3 && coverage >= 0.5) {
      regular = true;
      drafts.push({
        rule: 'business.regular_inflows',
        weight: months.length >= 6 ? W.regularInflows.six : W.regularInflows.three,
        direction: 'supports',
        source: SOURCE_CHAIN,
        originKey: 'chain:months',
        evidence: txRefs(inflows, 6),
        explanation: `Wpływy w ${count(months.length, 'miesiącu', 'miesiącach', 'miesiącach')} z ${span} (${months[0]} – ${months.at(-1)}; pokrycie ${Math.round(coverage * 100)}%). Regularność w czasie odpowiada ciągłości działalności.`,
        limitations: ['Regularne wpływy mogą też pochodzić z innego źródła stałego (np. wynagrodzenia w kryptowalucie).'],
      });
    }
    const retail = valued.filter((item) => item.valuePln! >= BUSINESS_RULES.retail.minPln && item.valuePln! <= BUSINESS_RULES.retail.maxPln);
    if (valued.length >= BUSINESS_RULES.retail.minValued && retail.length / valued.length >= BUSINESS_RULES.retail.share) {
      drafts.push({
        rule: 'business.retail_amounts',
        weight: W.retailAmounts,
        direction: 'supports',
        source: SOURCE_CHAIN,
        originKey: 'chain:amounts',
        evidence: txRefs(retail, 6),
        explanation: `${retail.length} z ${valued.length} wycenionych wpływów (${Math.round((retail.length / valued.length) * 100)}%) mieści się w przedziale ${BUSINESS_RULES.retail.minPln}–${BUSINESS_RULES.retail.maxPln} zł — typowe kwoty sprzedaży detalicznej.`,
        limitations: ['Wycena jest szacunkiem po kursie z istniejących wycen tego samego aktywa.'],
      });
    }
    const top = [...turnover].sort((a, b) => b.valuePln - a.valuePln)[0];
    if (top && top.valuePln >= 5_000) {
      drafts.push({
        rule: 'business.turnover',
        weight: top.valuePln >= 100_000 ? W.turnover.from100k : top.valuePln >= 20_000 ? W.turnover.from20k : W.turnover.from5k,
        direction: 'supports',
        source: `${SOURCE_CHAIN} — wycena`,
        originKey: 'chain:turnover',
        evidence: txRefs(valued.filter((item) => item.day.startsWith(top.year)), 6),
        explanation:
          `Obrót (wpływy, nie dochód) w roku ${top.year}: ok. ${formatPln(top.valuePln)} z ${count(top.valued, 'wycenionego wpływu', 'wycenionych wpływów', 'wycenionych wpływów')} ` +
          `(${turnover.map((year) => `${year.year}: ${formatPln(year.valuePln)}`).join('; ')}).`,
        limitations: [
          'To suma wpływów po kursie z istniejących wycen, nie przychód podatkowy ani dochód; koszty, zwroty i przelewy własne nie są odjęte.',
          ...(top.valued < top.inflows ? [`W roku ${top.year} wyceniono ${top.valued} z ${top.inflows} wpływów — obrót jest niedoszacowany.`] : []),
          ...(top.sampleRated > 0 ? [`${top.sampleRated} z wycenionych wpływów oparto na KURSIE PRZYKŁADOWYM (dane demonstracyjne) — nie jest to kurs rynkowy.`] : []),
        ],
      });
    }
  } else if (inflows.length > 0) {
    limitations.push(`Za mało wpływów (${inflows.length}, próg ${BUSINESS_RULES.minInflows}), by oceniać ich liczbę, regularność i kwoty.`);
  }
  if (inflows.length > valued.length) limitations.push(`${valued.length} z ${inflows.length} wpływów wyceniono (kurs z istniejących wycen tego samego aktywa w oknie ${BUSINESS_RULES.rateWindowDays} dni); pozostałe bez kursu — nie są zerem.`);
  const exits = (input.cashOut ?? []).filter((item) => item.stage !== 'onchain_transfer' && item.indicator.score > 0);
  if (exits.length > 0) {
    const best = [...exits].sort((a, b) => b.indicator.score - a.indicator.score)[0]!;
    drafts.push({
      rule: 'business.cashout_to_exchange',
      weight: W.cashoutToExchange,
      direction: 'supports',
      source: `${SOURCE_CHAIN} — wskaźnik C`,
      originKey: 'chain:cashout',
      evidence: [...unique(exits.flatMap((item) => item.txids)).slice(0, 6).map((value) => ({ kind: 'txid' as const, value })), { kind: 'attribute', value: `wskaźnik C: ${best.id}` }],
      explanation: `Środki z adresów podmiotu trafiały do usług wymiany (${unique(exits.map((item) => item.serviceName ?? 'usługa')).join(', ')}; najwyższy wskaźnik C ${best.indicator.score}/100 — ${best.indicator.level}). Wpływy mogły zostać zamienione na waluty tradycyjne.`,
      limitations: ['Szczegóły i ograniczenia — wskaźnik C; wypłatę na rachunek potwierdza tylko usługa.'],
    });
  }

  // ---------- Rejestry ----------
  const checks = registryChecks(input.registry);
  const checked = checks.filter((item) => item.status === 'found' || item.status === 'not_found');
  const vasp = checks.find((item) => item.connectorId === 'rejestry-publiczne');
  // Lista ostrzeżeń KNF (ten sam łącznik) nie jest wpisem dostawcy usług — trafia do ścieżki „podmiot zarejestrowany”.
  const vaspRecords = (vasp?.records ?? []).filter((record) => !/KNF/i.test(record.name));
  const registeredChecks = checks.filter((item) => item.status === 'found' && item.connectorId !== 'rejestry-publiczne');
  if (vasp?.status === 'found' && vaspRecords.length > 0) {
    const exact = vaspRecords.some((record) => !record.nameOnly);
    drafts.push({
      rule: 'business.virtual_currency_register',
      weight: exact ? C.virtualCurrencyRegister.exact : C.virtualCurrencyRegister.nameOnly,
      direction: 'contradicts',
      source: 'rejestry publiczne (migawka lokalna)',
      evidence: vaspRecords.slice(0, 3).map((record) => ({ kind: 'url' as const, value: record.url })),
      explanation: `Wpis w rejestrze dostawców usług walut wirtualnych: ${vaspRecords.map((record) => record.name).slice(0, 3).join('; ')}. Zarejestrowany dostawca usług przeczy hipotezie działalności „ukrytej”.`,
      limitations: exact ? ['Wpis nie mówi, czy cały obrót jest zadeklarowany.'] : ['Dopasowanie wyłącznie po nazwie — możliwa zbieżność nazw; wpis może dotyczyć innego podmiotu.'],
    });
  }
  if (registeredChecks.length > 0) {
    drafts.push({
      rule: 'business.registry_found',
      weight: C.registryFound,
      direction: 'contradicts',
      source: 'rejestry publiczne (CEIDG, KRS, wykaz VAT)',
      evidence: registeredChecks.flatMap((item) => item.records).slice(0, 4).map((record) => ({ kind: 'url' as const, value: record.url })),
      explanation: `Znaleziono zarejestrowaną działalność: ${registeredChecks
        .flatMap((item) => item.records.map((record) => `${record.name}${record.identifier ? ` (${record.identifier})` : ''} — ${item.registry}`))
        .slice(0, 3)
        .join('; ')}. Działalność istnieje — pytanie brzmi, czy obrót jest w niej zadeklarowany, co sprawdzić mogą tylko systemy KAS. ` +
        'Wpis otwiera osobną ścieżkę wskaźnika D: „podmiot zarejestrowany — weryfikacja zgodności obrotu i ryzyko prania pieniędzy”.',
      limitations: ['Numer z publikacji może należeć do innego podmiotu niż autor publikacji.'],
    });
  } else if (checked.length > 0 && checked.every((item) => item.status === 'not_found')) {
    const byNumber = checked.some((item) => item.basis === 'number' || item.basis === 'domain');
    drafts.push({
      rule: 'business.registry_none_found',
      weight: byNumber ? W.registryNoneFound.number : W.registryNoneFound.name,
      direction: 'supports',
      source: 'rejestry publiczne (łączniki użyte w analizie)',
      originKey: 'registry:none',
      evidence: checked.flatMap((item) => item.queries.map((value) => ({ kind: 'attribute' as const, value: `${item.registry}: ${value}` }))).slice(0, 6),
      explanation: `Nie znaleziono wpisu w: ${checked.map((item) => item.registry).join('; ')} (szukano: ${unique(checked.flatMap((item) => item.queries)).join(', ')}).`,
      limitations: [
        'Wyszukiwanie po nazwie lub nicku jest zawodne: osoba może prowadzić działalność pod inną zarejestrowaną nazwą albo jako wspólnik spółki.',
        ...(checks.some((item) => item.connectorId === 'live-ceidg' && item.status === 'not_checked') ? ['CEIDG nie był sprawdzany (brak tokenu albo numeru NIP) — jednoosobowej działalności nie wykluczono.'] : []),
      ],
    });
  }
  if (checks.length > 0 && checked.length === 0) limitations.push('W tej analizie nie sprawdzono żadnego rejestru działalności — brak wpisu nie został ustalony.');
  if (checks.some((item) => item.connectorId === 'live-ceidg' && item.status === 'not_checked')) limitations.push('CEIDG nie był sprawdzany — wymaga tokenu Hurtowni danych CEIDG (CEIDG_API_TOKEN) albo sprawdzenia w systemach KAS.');

  // ---------- Kontrdowody ----------
  const charity = input.addresses.filter((item) => item.charity || item.chain?.profile.addressClass === 'charity');
  if (charity.length > 0) {
    drafts.push({
      rule: 'business.charity_address',
      weight: C.charityAddress,
      direction: 'contradicts',
      blocking: true,
      source: 'kontekst cytowań adresu (beneficjent) / klasa adresu',
      evidence: charity.map((item) => ({ kind: 'address' as const, value: item.address })),
      explanation: `Adres zbiórki${charity[0]!.charity ? ` organizacji „${charity[0]!.charity}”` : ''}: wpłaty na taki adres to darowizny, a nie zapłata za towar lub usługę. Jego wpływów nie liczono.`,
      limitations: ['Organizacja może prowadzić też działalność gospodarczą — to inne pytanie niż zbiórka.'],
    });
  }
  const donation = quoted('donation');
  if (donation.length > 0 && offers.length === 0 && p2p.length === 0 && priced.length === 0) {
    drafts.push({
      rule: 'business.donation_context',
      weight: C.donationContext,
      direction: 'contradicts',
      source: SOURCE_WEB,
      evidence: urlRefs(donation),
      explanation: `Publikacje proszą o wsparcie, a nie oferują sprzedaży: ${quoteLine(donation, 'donation')}. Wpływy mogą być darowiznami.`,
      limitations: ['Darowizny też mogą podlegać opodatkowaniu (inny podatek niż z działalności).'],
    });
  }
  if (offers.length === 1 && !manyPayers && !regular) {
    drafts.push({
      rule: 'business.one_off_sale',
      weight: C.oneOffSale,
      direction: 'contradicts',
      source: SOURCE_WEB,
      evidence: urlRefs(offers[0]!.publications),
      explanation: 'Jedna oferta i brak powtarzalnych wpływów od wielu wpłacających — obraz typowy dla jednorazowej sprzedaży prywatnej, nie działalności.',
      limitations: ['Inne oferty mogły nie trafić do przeszukanych źródeł.'],
    });
  }

  const indicator = combineComponents('business_activity', drafts, { limitations: unique(limitations) });
  const turnoverPlnByYear = Object.fromEntries(turnover.filter((year) => year.valued > 0).map((year) => [year.year, year.valuePln]));
  const years = unique([...turnover.map((year) => year.year), ...offers.map((group) => (group.first ? polishDay(group.first).slice(0, 4) : '')).filter(Boolean)]).sort();
  // Druga ścieżka: wpis w rejestrze nie tylko przeczy „ukrytej” działalności — otwiera weryfikację zgodności obrotu podmiotu.
  const entities = registeredEntitiesOf(input.registry?.records ?? []);
  const firstActivity = [...inflows.map((item) => item.time), ...offers.map((group) => group.first).filter((value): value is string => Boolean(value))].sort()[0];
  const registered =
    entities.length > 0
      ? assessRegisteredTrack(entities, input.registered ?? {}, {
          inflows,
          offers: offers.length,
          ...(firstActivity ? { firstActivity } : {}),
          publications: pubs,
          addressKeys: new Set(input.addresses.map((item) => `${item.network}:${item.address}`)),
        })
      : undefined;
  return {
    id: input.id,
    track: 'unregistered',
    ...(registered ? { registered } : {}),
    subject: input.subject,
    indicator,
    status: 'hypothesis',
    statement: statementOf(input.subject.label, indicator, { offers: offers.length, services: unique(offers.flatMap((group) => group.services)).length, payers: payers.length, months: months.length, turnover, checks }),
    turnoverPlnByYear,
    turnover,
    registryCheck: checks,
    whatToVerify: whatToVerify({ years, checks, p2p: p2p.length > 0, exits, turnover, registered: registeredChecks, vasp: vasp?.status === 'found' }),
    ...(input.subject.kind === 'subject' ? { network: [] } : {}),
  };
}

function statementOf(
  label: string,
  indicator: BusinessActivityAssessment['indicator'],
  facts: { offers: number; services: number; payers: number; months: number; turnover: BusinessTurnoverYear[]; checks: BusinessRegistryCheck[] },
): string {
  const parts = [
    facts.offers > 0 ? `${count(facts.offers, 'oferta', 'oferty', 'ofert')} w ${count(facts.services, 'serwisie', 'serwisach', 'serwisach')}` : '',
    facts.payers > 0 ? `${count(facts.payers, 'wpłacający', 'wpłacających', 'wpłacających')}` : '',
    facts.months > 0 ? `wpływy w ${count(facts.months, 'miesiącu', 'miesiącach', 'miesiącach')}` : '',
    ...facts.turnover.filter((year) => year.valued > 0).map((year) => `obrót ${year.year}: ok. ${formatPln(year.valuePln)} (wpływy, nie dochód)`),
  ].filter(Boolean);
  const registry = facts.checks.some((item) => item.status === 'found')
    ? ' W rejestrach znaleziono wpis — sprawdzenia wymaga, czy obrót jest zadeklarowany.'
    : facts.checks.some((item) => item.status === 'not_found')
      ? ' W sprawdzonych rejestrach nie znaleziono wpisu (wyszukiwanie może być niepełne).'
      : '';
  if (indicator.score === 0) return `${label}: brak sygnałów działalności gospodarczej w zebranych danych.${registry}`;
  return (
    `Sygnały możliwej działalności gospodarczej (hipoteza): ${label} — wskaźnik D ${indicator.score}/100, ${indicator.level}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.${registry} ` +
    'To nie jest ustalenie statusu podatkowego — rozstrzygają wyłącznie systemy KAS.'
  );
}

function whatToVerify(facts: {
  years: string[];
  checks: BusinessRegistryCheck[];
  p2p: boolean;
  exits: CashOutAssessment[];
  turnover: BusinessTurnoverYear[];
  registered: BusinessRegistryCheck[];
  vasp: boolean;
}): string[] {
  const years = facts.years.length > 0 ? facts.years.join(', ') : 'lata objęte publikacjami i transakcjami';
  const result = [
    `Sprawdź złożenie zeznań PIT-38 (odpłatne zbycie walut wirtualnych) oraz PIT-36/PIT-36L (przychody z działalności) za lata ${years}.`,
  ];
  const ceidg = facts.checks.find((item) => item.connectorId === 'live-ceidg');
  if (!ceidg || ceidg.status !== 'found') result.push('Sprawdź, czy osoba prowadzi działalność w CEIDG (wymaga tokenu Hurtowni danych CEIDG albo dostępu w systemach KAS) — wyszukiwanie po NIP lub PESEL jest pewniejsze niż po nazwie.');
  const nips = unique(facts.registered.flatMap((item) => item.records.map((record) => record.identifier).filter((value): value is string => Boolean(value && /NIP/.test(value)))));
  if (facts.registered.length > 0) result.push(`Porównaj obrót z plikami JPK_V7 podmiotu${nips.length > 0 ? ` (${nips.join(', ')})` : ''}, jeśli jest zarejestrowany jako podatnik VAT, oraz z przychodem wykazanym w zeznaniu.`);
  else result.push('Jeśli podmiot jest zarejestrowany jako podatnik VAT, porównaj obrót z plikami JPK_V7 podmiotu.');
  if (facts.turnover.some((year) => year.valuePln > 0)) {
    result.push('Porównaj kwartalne wpływy z limitem działalności nierejestrowanej (art. 5 ustawy Prawo przedsiębiorców: przychód do 225% minimalnego wynagrodzenia w kwartale) — wpływ to nie przychód, więc wymaga to danych źródłowych.');
  }
  if (facts.p2p || facts.vasp) result.push('Sprawdź wpis w rejestrze działalności w zakresie walut wirtualnych (Dyrektor IAS w Katowicach) i sprawozdawczość podmiotu — wymiana na rzecz innych osób wymaga wpisu.');
  for (const exit of facts.exits.slice(0, 2)) {
    result.push(`Rozważ zapytanie do usługi ${exit.serviceName ?? 'wymiany'} o dane KYC właściciela konta i historię wypłat (wskaźnik C: ${exit.indicator.score}/100).`);
  }
  result.push('Zabezpiecz kopie ofert i stron (adresy URL w składnikach) — ogłoszenia bywają usuwane.');
  return result;
}

// ---------- Ścieżka 2: podmiot zarejestrowany ----------

const REGISTRY_NAME: Record<string, string> = { 'live-vat-whitelist': 'wykaz podatników VAT', 'live-krs': 'KRS', 'live-ceidg': 'CEIDG' };

/** Podmioty z rejestrów (bez dopasowań po samej nazwie), scalone po NIP / KRS. */
export function registeredEntitiesOf(records: BusinessRegistryRecord[]): RegisteredEntity[] {
  const entities: RegisteredEntity[] = [];
  for (const record of records) {
    const details = record.details;
    if (!details || record.nameOnly) continue;
    const existing = entities.find((entity) => (details.nip && entity.nip === details.nip) || (details.krs && entity.krs === details.krs));
    const entity: RegisteredEntity = existing ?? { id: details.nip ? `nip:${details.nip}` : `krs:${details.krs ?? record.url}`, name: details.name ?? record.organization ?? record.title, pkd: [], people: [], whitelistAccounts: [], sources: [] };
    if (!existing) entities.push(entity);
    if (details.nip && !entity.nip) entity.nip = details.nip;
    if (details.krs && !entity.krs) entity.krs = details.krs;
    if (details.regon && !entity.regon) entity.regon = details.regon;
    if (details.vatStatus && (!entity.vatStatus || details.connectorId === 'live-vat-whitelist')) entity.vatStatus = details.vatStatus;
    if (details.registrationDate && (!entity.registrationDate || details.registrationDate < entity.registrationDate)) entity.registrationDate = details.registrationDate;
    if (details.removalDate) entity.removalDate = details.removalDate;
    if (details.capital) entity.capital = details.capital;
    for (const item of details.pkd) if (!entity.pkd.some((known) => known.code === item.code)) entity.pkd.push(item);
    entity.people = unique([...entity.people, ...details.people]);
    entity.whitelistAccounts = unique([...entity.whitelistAccounts, ...details.accounts]);
    entity.sources.push({ registry: REGISTRY_NAME[details.connectorId] ?? details.connectorId, url: record.url });
  }
  return entities;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '');

interface TrackFacts {
  inflows: Inflow[];
  offers: number;
  firstActivity?: string;
  publications: BusinessPublication[];
  addressKeys: Set<string>;
}

function assessRegisteredTrack(entities: RegisteredEntity[], context: RegisteredTrackContext, facts: TrackFacts): RegisteredEntityAssessment {
  const R = BUSINESS_RULES.registered;
  const drafts: ComponentDraft[] = [];
  const sourceOf = (entity: RegisteredEntity) => `rejestry publiczne (${unique(entity.sources.map((item) => item.registry)).join(', ')})`;
  const entityRefs = (entity: RegisteredEntity): EvidenceRef[] => entity.sources.slice(0, 3).map((item) => ({ kind: 'url' as const, value: item.url }));
  const active = facts.inflows.length >= BUSINESS_RULES.minInflows || facts.offers > 0;

  for (const entity of entities) {
    const label = `${entity.name}${entity.nip ? ` (NIP ${entity.nip})` : entity.krs ? ` (KRS ${entity.krs})` : ''}`;
    if (entity.pkd.length > 0 && active && !entity.pkd.some((item) => (R.relatedPkdDivisions as readonly string[]).includes(item.code.slice(0, 2)))) {
      drafts.push({
        rule: 'business.registered.crypto_flows_vs_pkd',
        weight: R.cryptoFlowsVsPkd,
        direction: 'supports',
        source: sourceOf(entity),
        originKey: `reg:pkd:${entity.id}`,
        evidence: [...entityRefs(entity), ...txRefs(facts.inflows, 4)],
        explanation:
          `Obrót kryptowalutowy (${count(facts.inflows.length, 'wpływ', 'wpływy', 'wpływów')}, ${count(facts.offers, 'oferta', 'oferty', 'ofert')}), a kody PKD podmiotu ${label} ` +
          `(${entity.pkd.slice(0, 4).map((item) => `${item.code}${item.description ? ` ${item.description}` : ''}`).join('; ')}) nie dotyczą handlu, finansów ani usług IT. ` +
          'Sygnał do weryfikacji: możliwe wprowadzanie środków z kryptowalut do obrotu firmy — sprawdź JPK_V7, księgi i źródło środków.',
        limitations: ['PKD to deklaracja przy rejestracji; podmiot może prowadzić działalność także w innym zakresie. Wpływy mogą dotyczyć osoby, nie firmy.'],
      });
    }
    if (entity.registrationDate && facts.firstActivity) {
      const days = (Date.parse(facts.firstActivity) - Date.parse(entity.registrationDate)) / DAY_MS;
      if (days <= R.recentRegistrationDays) {
        drafts.push({
          rule: 'business.registered.recent_registration',
          weight: R.recentRegistration,
          direction: 'supports',
          source: sourceOf(entity),
          originKey: `reg:date:${entity.id}`,
          evidence: entityRefs(entity),
          explanation:
            days < 0
              ? `Podmiot ${label} zarejestrowano ${entity.registrationDate}, już po pierwszej aktywności (${polishDay(facts.firstActivity)}).`
              : `Podmiot ${label} zarejestrowano ${entity.registrationDate} — ${Math.round(days)} dni przed pierwszą aktywnością (${polishDay(facts.firstActivity)}).`,
          limitations: ['Świeża rejestracja jest częsta i zwykle niewinna; to wyłącznie kontekst dla pozostałych sygnałów.'],
        });
      }
    }
    const vat = entity.vatStatus ?? '';
    const inactive = vat !== '' && !/czynny/i.test(vat) && !/^CEIDG: aktywn/i.test(vat);
    const afterRemoval = entity.removalDate ? facts.inflows.filter((item) => item.day >= entity.removalDate!) : [];
    if (facts.inflows.length > 0 && (inactive || afterRemoval.length > 0)) {
      const affected = afterRemoval.length > 0 ? afterRemoval : facts.inflows;
      drafts.push({
        rule: 'business.registered.vat_status_inactive_or_removed',
        weight: R.vatStatusInactiveOrRemoved,
        direction: 'supports',
        source: sourceOf(entity),
        originKey: `reg:vat:${entity.id}`,
        evidence: [...entityRefs(entity), ...txRefs(affected, 4)],
        explanation:
          `Wpływy (${affected.length}) przy statusie „${vat || 'brak danych'}”${entity.removalDate ? `, wykreślenie ${entity.removalDate}` : ''} podmiotu ${label}. ` +
          'Sygnał do weryfikacji: przyjmowanie środków mimo nieaktywnego lub wykreślonego statusu.',
        limitations: ['Status VAT dotyczy dnia sprawdzenia w wykazie; wcześniejsze okresy wymagają historii statusu. Zwolnienie z VAT bywa w pełni legalne.'],
      });
    }
    const suffixes = entity.whitelistAccounts.map((account) => account.slice(-R.maskedDigits));
    const matched = (context.payouts ?? []).filter((payout) => {
      const digits = digitsOnly(payout.bankAccountMasked);
      return digits.length >= R.maskedDigits && suffixes.includes(digits.slice(-R.maskedDigits));
    });
    if (matched.length > 0) {
      drafts.push({
        rule: 'business.registered.payout_to_whitelist_account',
        weight: R.payoutToWhitelistAccount,
        direction: 'supports',
        source: `odpowiedź usługi (dokument spoza OSINT) i wykaz podatników VAT`,
        originKey: `reg:payout:${entity.id}`,
        evidence: [...matched.slice(0, 3).map((payout) => ({ kind: 'decision' as const, value: `reply:${payout.replyId}` })), ...entityRefs(entity)],
        explanation:
          `Wypłata na rachunek bankowy z odpowiedzi usługi ${unique(matched.map((payout) => `${payout.serviceName} (sygn. ${payout.reference})`)).join(', ')} ` +
          `trafiła na rachunek o końcówce zgodnej (${R.maskedDigits} ostatnie cyfry) z rachunkiem podmiotu ${label} w wykazie podatników VAT. ` +
          'Silny sygnał oparty na dokumentach: środki z kryptowalut mogły trafić do obrotu firmy — sprawdź JPK_V7, księgi i źródło środków.',
        limitations: [
          `Porównano WYŁĄCZNIE ${R.maskedDigits} ostatnie cyfry zamaskowanego numeru z odpowiedzi usługi — zbieżność końcówki nie dowodzi tożsamości rachunku; pełny numer potwierdzi usługa albo bank.`,
          'Odpowiedź usługi to dokument spoza OSINT wprowadzony przez analityka; narzędzie nie weryfikuje jego autentyczności.',
        ],
      });
    }
    const numbers = [entity.nip ? `NIP ${entity.nip}` : '', entity.krs ? `KRS ${entity.krs}` : ''].filter(Boolean);
    const companyPubs = facts.publications.filter((pub) => (pub.signals?.registryNumbers ?? []).some((value) => numbers.includes(value)));
    const companyKeys = new Set([
      ...companyPubs.flatMap((pub) => pub.addresses ?? []),
      ...(context.organizations ?? []).filter((org) => (org.nip && org.nip === entity.nip) || (org.krs && org.krs === entity.krs)).flatMap((org) => org.addressKeys),
    ]);
    const privatePubs = facts.publications.filter((pub) => !companyPubs.includes(pub));
    const mixed = [...companyKeys].filter((key) => facts.addressKeys.has(key) && privatePubs.some((pub) => (pub.addresses ?? []).includes(key)));
    if (mixed.length > 0) {
      drafts.push({
        rule: 'business.registered.personal_and_company_mixing',
        weight: R.personalAndCompanyMixing,
        direction: 'supports',
        source: SOURCE_WEB,
        originKey: `reg:mix:${entity.id}`,
        evidence: [...mixed.slice(0, 3).map((key) => ({ kind: 'address' as const, value: key.split(':').slice(1).join(':') })), ...urlRefs([...companyPubs, ...privatePubs.filter((pub) => (pub.addresses ?? []).some((key) => mixed.includes(key)))])],
        explanation: `Ten sam adres występuje jako adres płatności podmiotu ${label} i w publikacjach prywatnych osoby (${mixed.map((key) => shortAddress(key.split(':').slice(1).join(':'))).join(', ')}). Sygnał do weryfikacji: mieszanie środków prywatnych i firmowych.`,
        limitations: ['Wspólny adres może wynikać z uproszczenia rozliczeń w małej firmie; nie przesądza o celu.'],
      });
    }
    const org = (context.organizations ?? []).find((item) => (item.nip && item.nip === entity.nip) || (item.krs && item.krs === entity.krs));
    const shared = org ? (context.orgRelations ?? []).filter((relation) => relation.kind === 'shared_officer' && (relation.from === org.id || relation.to === org.id)) : [];
    if (shared.length > 0) {
      drafts.push({
        rule: 'business.registered.shared_officer_network',
        weight: R.sharedOfficerNetwork,
        direction: 'supports',
        source: 'sieć organizacji z rejestrów publicznych',
        originKey: `reg:officers:${entity.id}`,
        evidence: shared.slice(0, 3).map((relation) => ({ kind: 'attribute' as const, value: relation.explanation })),
        explanation: `Członkowie organów podmiotu ${label} pełnią role także w innych podmiotach siatki (${shared.length}). Kontekst do oceny powiązań kapitałowych i osobowych.`,
        limitations: ['Wspólny członek zarządu to częsta i legalna sytuacja.'],
      });
    }
    for (const flag of (context.riskFlags ?? []).filter((item) => item.nodeId === entity.id)) {
      const strong = flag.confidence === 'strong' || flag.status === 'source_fact';
      drafts.push({
        rule: 'business.registered.sanctions_or_knf_warning',
        weight: strong ? R.riskStrong : R.riskWeak,
        direction: 'supports',
        source: `listy sankcyjne i ostrzeżenia KNF (${flag.badge})`,
        originKey: `reg:risk:${entity.id}:${flag.badge}`,
        evidence: [{ kind: 'attribute', value: flag.summary }],
        explanation: `${flag.badge === 'ostrzeżenie KNF' ? 'Ostrzeżenie publiczne KNF' : 'Lista sankcyjna'} — ${flag.summary}`,
        limitations: [strong ? 'Wpis dotyczy bytu z listy; nie przesądza o udziale osób powiązanych.' : 'Zgodna tylko nazwa — możliwy imiennik; wymaga porównania identyfikatorów.'],
      });
    }
  }
  const indicator = combineComponents('business_activity', drafts, {
    limitations: [
      'Ścieżka „podmiot zarejestrowany” wskazuje sygnały do weryfikacji zgodności obrotu i ryzyka prania pieniędzy; nie stwierdza prania pieniędzy ani nieprawidłowości.',
      'Dane rejestrów pochodzą z dnia analizy (stan bieżący); historyczne statusy i rachunki wymagają odrębnego sprawdzenia.',
    ],
  });
  const names = entities.map((entity) => `${entity.name}${entity.nip ? ` (NIP ${entity.nip})` : ''}`).join('; ');
  const whatToVerify = [
    `Porównaj obrót kryptowalutowy z plikami JPK_V7 i księgami podmiotu ${names}.`,
    'Sprawdź zeznanie CIT-8 (spółka) albo PIT-36/PIT-36L (przedsiębiorca) podmiotu za lata aktywności oraz ujęcie wpływów z kryptowalut.',
    'Ustal źródło pochodzenia środków wpłacanych z kryptowalut na rachunki podmiotu (dokumenty sprzedaży, umowy, faktury).',
    'Ustal beneficjenta rzeczywistego podmiotu — CRBR (Centralny Rejestr Beneficjentów Rzeczywistych) jest rejestrem jawnym, ale przed użyciem sprawdź podstawę prawną i zakres dostępu; narzędzie z niego nie korzysta.',
    ...(drafts.some((item) => item.rule === 'business.registered.payout_to_whitelist_account')
      ? ['Potwierdź pełny numer rachunku z odpowiedzi usługi w wykazie podatników VAT albo w banku — narzędzie porównało tylko końcówkę zamaskowanego numeru.']
      : []),
    ...(drafts.some((item) => item.rule === 'business.registered.sanctions_or_knf_warning') ? ['Zweryfikuj trafienie na liście sankcyjnej lub ostrzeżeń KNF po identyfikatorach (NIP, KRS, LEI, adresy) — sama zgodność nazwy to możliwy imiennik.'] : []),
  ];
  const signals = indicator.components.filter((item) => item.applied > 0).length;
  return {
    track: 'registered_entity',
    entities,
    indicator,
    status: 'hypothesis',
    statement:
      signals === 0
        ? `Podmiot zarejestrowany: ${names}. Nie znaleziono sygnałów niezgodności obrotu w zebranych danych — pozostaje pytanie, czy obrót jest zadeklarowany (sprawdzają systemy KAS).`
        : `Podmiot zarejestrowany — sygnały do weryfikacji zgodności obrotu i ryzyka prania pieniędzy (hipoteza): ${names}; wskaźnik ${indicator.score}/100, ${indicator.level}. ` +
          'Możliwe wprowadzanie środków z kryptowalut do obrotu firmy — sprawdź JPK_V7, księgi, źródło środków. To sygnał do weryfikacji, nie ustalenie.',
    whatToVerify,
  };
}

// ---------- Byt siatki: rozwijanie sieci na żądanie ----------

/** Byt siatki w postaci potrzebnej do oceny (zgodny strukturalnie z `Entity` z network/types.ts). */
export interface BusinessEntityLike {
  key: string;
  kind: string;
  label: string;
  value?: string;
  url?: string;
  meta?: { addresses?: string[]; address?: string; network?: string; service?: string; handle?: string; registry?: { krs?: string; nip?: string; lei?: string } };
}

/** Dane do oceny bytu siatki: dokumenty przypisane bytowi (kopie treści z analizy), adresy z teczki, rejestry. */
export interface BusinessNodeData {
  documents?: { url: string; service: string; connectorId?: string; title?: string; text: string; publishedAt?: string; archivedAt?: string; contentHash?: string; author?: string; category?: SourceCategory }[];
  /** Adresy teczki z zapisaną aktywnością blockchain; ocenie podlegają adresy wskazane w `meta.addresses` / `meta.address`. */
  findings?: Finding[];
  /** Wpisy rejestrowe bytu (np. organizacja z KRS). */
  registryRecords?: BusinessRegistryRecord[];
  connectorsUsed?: string[];
  cashOut?: CashOutAssessment[];
  /** Adres zbiórki organizacji (`sieć:adres` → nazwa organizacji). */
  charity?: Map<string, string>;
}

/**
 * Wskaźnik D dla dowolnego bytu siatki (osoba, konto, organizacja, adres). Czysta funkcja: korzysta wyłącznie
 * z danych przekazanych przez wywołującego — bez zapytań do źródeł.
 */
export function businessSignalsFor(entity: BusinessEntityLike, data: BusinessNodeData = {}): BusinessActivityAssessment {
  const keys = unique([...(entity.meta?.addresses ?? []), ...(entity.meta?.address && entity.meta.network ? [`${entity.meta.network}:${entity.meta.address}`] : [])]);
  const findings = (data.findings ?? []).filter((finding) => keys.some((key) => key.toLowerCase() === addressKey(finding).toLowerCase()));
  const publications: BusinessPublication[] = (data.documents ?? []).map((doc) => {
    const signals = businessTextOf(doc);
    return {
      url: doc.url,
      service: doc.service,
      ...(doc.connectorId ? { connectorId: doc.connectorId } : {}),
      ...(doc.title ? { title: doc.title } : {}),
      ...(doc.category ? { category: doc.category } : {}),
      ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
      ...(doc.archivedAt ? { archivedAt: doc.archivedAt } : {}),
      ...(doc.contentHash ? { contentHash: doc.contentHash } : {}),
      ...(signals ? { signals } : {}),
    };
  });
  const records = [
    ...(data.registryRecords ?? []),
    ...(entity.kind === 'organization' && entity.meta?.registry?.krs
      ? [{ connectorId: 'live-krs', service: 'api-krs.ms.gov.pl', url: entity.url ?? `https://api-krs.ms.gov.pl/api/krs/OdpisAktualny/${entity.meta.registry.krs}`, title: entity.label, organization: entity.label, registryEntries: [`KRS ${entity.meta.registry.krs}`] }]
      : []),
  ];
  return assessBusinessActivity({
    id: `business:${entity.key}`,
    subject: { kind: entity.kind, label: entity.label, nodeId: entity.key },
    publications,
    addresses: findings.map((finding) => ({ address: finding.address, network: finding.network, ...(finding.chain ? { chain: finding.chain } : {}), ...(data.charity?.get(addressKey(finding)) ? { charity: data.charity.get(addressKey(finding))! } : {}) })),
    valuations: valuationsOf(data.findings ?? []),
    ...(records.length > 0 || data.connectorsUsed ? { registry: { connectorsUsed: unique([...(data.connectorsUsed ?? []), ...records.map((record) => record.connectorId)]), identifiers: [], records } } : {}),
    ...(data.cashOut ? { cashOut: data.cashOut.filter((item) => keys.includes(`${item.network}:${item.address}`)) } : {}),
  });
}

// ---------- Teczka: podmiot sprawy i jego siatka ----------

/** Publikacja w teczce: sygnały z analizy (`Sighting.businessText`), a dla starszych analiz — z fragmentów przy adresach. */
export function publicationOf(sighting: Sighting & { businessText?: BusinessTextSignals }, excerpts: string[] = []): BusinessPublication {
  const signals = sighting.businessText ?? businessTextOf({ text: excerpts.join('\n'), title: sighting.title, url: sighting.url, ...(sighting.author ? { author: sighting.author } : {}), ...(sighting.profile ? { profile: sighting.profile } : {}) });
  return {
    url: sighting.url,
    service: sighting.service,
    connectorId: sighting.connectorId,
    title: sighting.title,
    category: sighting.category,
    ...(sighting.publishedAt ? { publishedAt: sighting.publishedAt } : {}),
    ...(sighting.archivedAt ? { archivedAt: sighting.archivedAt } : {}),
    ...(signals ? { signals } : {}),
    ...(sighting.addresses.length > 0 ? { addresses: sighting.addresses } : {}),
  };
}

export interface DossierBusinessInput {
  subjectLabel: string;
  /** Dokumenty przypisane osobie głównej. */
  subjectSightings: Sighting[];
  /** Wszystkie dokumenty analizy (do rejestrów i węzłów siatki). */
  sightings: Sighting[];
  findings: (Finding & { evidence: { url: string; archivedAt?: string; excerpt: string; contentHash?: string }[] })[];
  /** Adresy przypisane podmiotowi (`sieć:adres`). */
  linkedKeys: Set<string>;
  /** Adresy zbiórek organizacji (`sieć:adres` → nazwa organizacji). */
  charity: Map<string, string>;
  connectorsUsed: string[];
  identifiers: Identifier[];
  failedConnectors: string[];
  cashOut: CashOutAssessment[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  /** Węzły siatki do oceny: powiązane tożsamości (id węzła, etykieta, dokumenty, adresy). */
  networkCandidates: { nodeId: string; kind: string; label: string; sightings: Sighting[]; addressKeys: string[] }[];
  /** Wypłaty na rachunek z obowiązujących odpowiedzi usług (numer rachunku zamaskowany). */
  payouts?: BusinessServicePayout[];
  /** Sieć organizacji z rejestrów (jeśli analiza ją zbudowała). */
  organizations?: RegisteredTrackContext['organizations'];
  orgRelations?: RegisteredTrackContext['orgRelations'];
  /**
   * Sprawdzenie podmiotów w listach sankcyjnych i ostrzeżeniach KNF (`checkNetworkNodes` z @olcys/sources, wstrzykiwane —
   * teczka nie ładuje list sama). Brak = sprawdzenia nie wykonano.
   */
  riskCheck?: (nodes: { id: string; kind: 'person' | 'organization'; name: string; identifiers?: { kind: string; value: string }[] }[]) => BusinessRiskFlag[];
}

function excerptsOf(findings: DossierBusinessInput['findings']): Map<string, { excerpts: string[]; contentHash?: string }> {
  const map = new Map<string, { excerpts: string[]; contentHash?: string }>();
  for (const finding of findings) {
    for (const item of finding.evidence) {
      const key = sightingKey(item);
      const entry = map.get(key) ?? { excerpts: [] };
      if (item.excerpt && !entry.excerpts.includes(item.excerpt)) entry.excerpts.push(item.excerpt);
      if (item.contentHash) entry.contentHash = item.contentHash;
      map.set(key, entry);
    }
  }
  return map;
}

const isRegistrySighting = (sighting: Sighting) => REGISTRY_IDS.has(sighting.connectorId);

/** Wskaźnik D podmiotu teczki wraz z węzłami siatki (osoby, organizacje) mającymi sygnały działalności. */
export function buildBusinessActivity(input: DossierBusinessInput): BusinessActivityAssessment {
  const excerpts = excerptsOf(input.findings);
  const toPublication = (sighting: Sighting): BusinessPublication => {
    const extra = excerpts.get(sightingKey(sighting));
    const pub = publicationOf(sighting, extra?.excerpts ?? []);
    return extra?.contentHash ? { ...pub, contentHash: extra.contentHash } : pub;
  };
  const subjectKeys = new Set(input.subjectSightings.map(sightingKey));
  const registrySightings = input.sightings.filter((sighting) => isRegistrySighting(sighting) && (sighting.role === 'subject' || subjectKeys.has(sightingKey(sighting))));
  const records: BusinessRegistryRecord[] = registrySightings.map((sighting) => ({
    connectorId: sighting.connectorId,
    service: sighting.service,
    url: sighting.url,
    title: sighting.title,
    ...(sighting.profile?.organization ? { organization: sighting.profile.organization } : {}),
    ...(sighting.profile?.registryEntries ? { registryEntries: sighting.profile.registryEntries } : {}),
    ...(sighting.identity.match === 'name_only' ? { nameOnly: true } : {}),
    ...((sighting as Sighting & { businessText?: BusinessTextSignals }).businessText?.registry ? { details: (sighting as Sighting & { businessText?: BusinessTextSignals }).businessText!.registry! } : {}),
  }));
  // Listy sankcyjne i ostrzeżenia KNF — tylko dla podmiotów z rejestrów (i ich osób z wykazu VAT), gdy wstrzyknięto sprawdzenie.
  const entities = registeredEntitiesOf(records);
  let riskFlags: BusinessRiskFlag[] = [];
  if (input.riskCheck && entities.length > 0) {
    try {
      riskFlags = input.riskCheck(
        entities.map((entity) => ({
          id: entity.id,
          kind: 'organization' as const,
          name: entity.name,
          identifiers: [...(entity.nip ? [{ kind: 'nip', value: entity.nip }] : []), ...(entity.krs ? [{ kind: 'krs', value: entity.krs }] : [])],
        })),
      );
    } catch {
      riskFlags = [];
    }
  }
  // Ostrzeżenie KNF znalezione w analizie przez łącznik rejestrów publicznych (po numerze) też jest sygnałem tej ścieżki.
  for (const sighting of input.sightings.filter((item) => item.connectorId === 'rejestry-publiczne' && item.service === 'knf.gov.pl' && item.identity.match !== 'name_only')) {
    const entity = entities.find((item) => sighting.matchedIdentifier.value.replace(/\D/g, '') === item.nip || sighting.matchedIdentifier.value.replace(/\D/g, '') === item.krs);
    if (entity) riskFlags.push({ nodeId: entity.id, badge: 'ostrzeżenie KNF', status: 'source_fact', confidence: 'strong', summary: `${sighting.title} (${sighting.url}).` });
  }
  const publications = input.subjectSightings.filter((sighting) => !isRegistrySighting(sighting)).map(toPublication);
  const discovered = input.sightings.flatMap((sighting) => (sighting.role === 'subject' ? sighting.discoveredIdentifiers : []));
  const numbersInPublications = unique(publications.flatMap((pub) => pub.signals?.registryNumbers ?? []));
  const addresses = input.findings
    .filter((finding) => input.linkedKeys.has(addressKey(finding)))
    .map((finding) => ({ address: finding.address, network: finding.network, ...(finding.chain ? { chain: finding.chain } : {}), ...(input.charity.get(addressKey(finding)) ? { charity: input.charity.get(addressKey(finding))! } : {}) }));
  const valuations = valuationsOf(input.findings);
  const subject = assessBusinessActivity({
    id: 'business:subject',
    subject: { kind: 'subject', label: input.subjectLabel, nodeId: 'subject' },
    publications,
    addresses,
    ownKeys: input.linkedKeys,
    valuations,
    registry: {
      connectorsUsed: input.connectorsUsed,
      identifiers: [...input.identifiers, ...discovered],
      records,
      failedConnectors: input.failedConnectors,
      numbersInPublications,
    },
    cashOut: input.cashOut.filter((item) => input.linkedKeys.has(`${item.network}:${item.address}`)),
    registered: {
      ...(input.payouts ? { payouts: input.payouts } : {}),
      ...(input.organizations ? { organizations: input.organizations } : {}),
      ...(input.orgRelations ? { orgRelations: input.orgRelations } : {}),
      riskFlags,
    },
  });

  // ---------- Siatka: osoby i konta powiązane, organizacje ----------
  const network: BusinessNetworkEntry[] = [];
  const nodeLabel = new Map(input.graph.nodes.map((node) => [node.id, node.label]));
  for (const candidate of input.networkCandidates) {
    if (!input.graph.nodes.some((node) => node.id === candidate.nodeId)) continue;
    const keys = new Set(candidate.addressKeys);
    const assessment = assessBusinessActivity({
      id: `business:${candidate.nodeId}`,
      subject: { kind: candidate.kind, label: candidate.label, nodeId: candidate.nodeId },
      publications: candidate.sightings.filter((sighting) => !isRegistrySighting(sighting)).map(toPublication),
      addresses: input.findings
        .filter((finding) => keys.has(addressKey(finding)))
        .map((finding) => ({ address: finding.address, network: finding.network, ...(finding.chain ? { chain: finding.chain } : {}), ...(input.charity.get(addressKey(finding)) ? { charity: input.charity.get(addressKey(finding))! } : {}) })),
      ownKeys: keys,
      valuations,
    });
    if (assessment.indicator.score < BUSINESS_RULES.networkMinScore) continue;
    const path = strongestPath(input.graph.edges, candidate.nodeId, 'subject');
    network.push({
      nodeId: candidate.nodeId,
      label: candidate.label,
      kind: candidate.kind,
      score: assessment.indicator.score,
      level: assessment.indicator.level,
      rules: assessment.indicator.components.filter((item) => item.applied > 0).map((item) => item.rule),
      statement: assessment.statement,
      path: path
        ? {
            summary: path.summary,
            strength: Math.round(path.strength * 100) / 100,
            level: path.level,
            hypotheses: path.hypotheses,
            labels: path.nodes.map((id) => nodeLabel.get(id) ?? id),
            ...(path.weakest ? { weakest: { label: path.weakest.label, status: path.weakest.status, strength: Math.round(path.weakest.strength * 100) / 100 } } : {}),
          }
        : null,
    });
  }
  network.sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId));
  return { ...subject, network };
}

/** Części teczki potrzebne do wskaźnika D (typy strukturalne — bez zależności od modułów teczki). */
export interface DossierBusinessParts {
  subjectLabel: string;
  mainNodes: { card: { id: string }; sightings: Sighting[] }[];
  otherNodes: { card: { id: string }; sightings: Sighting[] }[];
  sightings: Sighting[];
  findings: DossierBusinessInput['findings'];
  linkedKeys: Set<string>;
  beneficiaries: Map<string, { name: string }>;
  connectorsUsed: string[];
  identifiers: Identifier[];
  sourceErrors: { connectorId?: string }[];
  cashOut: CashOutAssessment[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  linkedIdentities: { id: string; displayName: string; accounts: string[]; addresses: { address: string; network: string }[] }[];
  serviceReplies: { id: string; serviceName: string; reference: string; withdrawn?: boolean; match?: { matched?: boolean }; payload: { fiatPayouts: { time: string; amount: number; currency: string; bankAccountMasked?: string }[] } }[];
  organizationNetwork?: {
    organizations: { id: string; name: string; identifiers: { krs?: string; nip?: string }; addresses: string[] }[];
    relations: { from: string; to: string; kind: string; explanation: string }[];
  };
  riskCheck?: DossierBusinessInput['riskCheck'];
}

/** Wskaźnik D teczki złożony z jej części (jedno wywołanie w `buildDossier`). */
export function businessForDossier(parts: DossierBusinessParts): BusinessActivityAssessment {
  const keyOfRaw = (address: string) => {
    const finding = parts.findings.find((item) => item.address.toLowerCase() === address.toLowerCase() || addressKey(item).toLowerCase() === address.toLowerCase());
    return finding ? addressKey(finding) : address;
  };
  const charity = new Map<string, string>();
  for (const [key, item] of parts.beneficiaries) charity.set(key, item.name);
  const allNodes = [...parts.mainNodes, ...parts.otherNodes];
  const network = parts.organizationNetwork;
  return buildBusinessActivity({
    subjectLabel: parts.subjectLabel,
    subjectSightings: parts.mainNodes.flatMap((node) => node.sightings),
    sightings: parts.sightings,
    findings: parts.findings,
    linkedKeys: parts.linkedKeys,
    charity,
    connectorsUsed: parts.connectorsUsed,
    identifiers: parts.identifiers,
    failedConnectors: unique(parts.sourceErrors.map((item) => item.connectorId).filter((value): value is string => Boolean(value))),
    cashOut: parts.cashOut,
    graph: parts.graph,
    networkCandidates: [
      ...parts.linkedIdentities.map((identity) => ({
        nodeId: `identity:${identity.id}`,
        kind: 'person',
        label: identity.displayName,
        sightings: allNodes.filter((node) => identity.accounts.includes(node.card.id)).flatMap((node) => node.sightings),
        addressKeys: identity.addresses.map((item) => `${item.network}:${item.address}`),
      })),
      ...(network?.organizations ?? []).map((org) => ({ nodeId: org.id, kind: 'organization', label: org.name, sightings: [], addressKeys: org.addresses.map(keyOfRaw) })),
    ],
    payouts: parts.serviceReplies
      .filter((reply) => !reply.withdrawn && reply.match?.matched !== false)
      .flatMap((reply) =>
        reply.payload.fiatPayouts
          .filter((payout) => payout.bankAccountMasked)
          .map((payout) => ({ replyId: reply.id, serviceName: reply.serviceName, reference: reply.reference, bankAccountMasked: payout.bankAccountMasked!, amount: payout.amount, currency: payout.currency, time: payout.time })),
      ),
    ...(network
      ? {
          organizations: network.organizations.map((org) => ({
            id: org.id,
            name: org.name,
            ...(org.identifiers.krs ? { krs: org.identifiers.krs } : {}),
            ...(org.identifiers.nip ? { nip: org.identifiers.nip } : {}),
            addressKeys: org.addresses.map(keyOfRaw),
          })),
          orgRelations: network.relations,
        }
      : {}),
    ...(parts.riskCheck ? { riskCheck: parts.riskCheck } : {}),
  });
}

export const BUSINESS_BADGE = 'sygnały działalności';

/** Odznaka „sygnały działalności” w podpisie węzłów grafu (podmiot i węzły siatki od progu `networkMinScore`). */
export function applyBusinessBadges(graph: { nodes: GraphNode[] }, assessment: BusinessActivityAssessment | undefined): void {
  if (!assessment) return;
  const marked = new Set((assessment.network ?? []).map((item) => item.nodeId));
  if (assessment.indicator.score >= BUSINESS_RULES.networkMinScore) marked.add('subject');
  for (const node of graph.nodes) {
    if (!marked.has(node.id) || (node.sublabel ?? '').includes(BUSINESS_BADGE)) continue;
    node.sublabel = node.sublabel ? `${node.sublabel} · ${BUSINESS_BADGE}` : BUSINESS_BADGE;
  }
}

/** Zdanie do kluczowych ustaleń (warstwa wniosków) — tylko od progu `keyFindingMinScore`. */
export function businessKeyFindings(assessment: BusinessActivityAssessment | undefined): { text: string; layer: 'inference' }[] {
  if (!assessment) return [];
  const result: { text: string; layer: 'inference' }[] = [];
  if (assessment.indicator.score >= BUSINESS_RULES.keyFindingMinScore) result.push({ text: assessment.statement, layer: 'inference' });
  if (assessment.registered && assessment.registered.indicator.score >= BUSINESS_RULES.keyFindingMinScore) result.push({ text: assessment.registered.statement, layer: 'inference' });
  const network = assessment.network ?? [];
  if (network.length > 0) {
    result.push({
      text:
        `W siatce: ${count(network.length, 'podmiot', 'podmioty', 'podmiotów')} z sygnałami działalności (hipoteza) — ` +
        network
          .slice(0, 3)
          .map((item) => `${item.label} (wskaźnik D ${item.score}/100${item.path ? `; ${item.path.summary}` : '; brak ścieżki do podmiotu'})`)
          .join('; ') +
        '. Powiązanie w siatce nie przenosi sygnałów na podmiot sprawy.',
      layer: 'inference',
    });
  }
  return result;
}

/** Wskaźnik D jako słowo poziomu — do podpisów. */
export const businessLevel = (score: number): string => indicatorLevel(score);
