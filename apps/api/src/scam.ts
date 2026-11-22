// Ostrzeżenia o możliwym oszustwie z użyciem adresu („scam”): czy w zebranych materiałach są zgłoszenia,
// że adres mógł służyć do oszustwa — i co z tego wynika dla ustalenia właściciela.
//
// Sygnały (każdy jako składnik z regułą, wagą, źródłem, dowodami i ograniczeniami):
//   1. publikacje ostrzegające przed adresem — reguła tekstowa na treściach już zebranych (wzorce wspólne
//      z regułą deklaracji własności, `SCAM_CONTEXT_PATTERNS` z @olcys/core) oraz odczyt modelu językowego
//      `warning_about_address` z cytatem; niezależne pochodzenia liczy `provenanceGroups` (kopie raz);
//   2. wzorzec fałszywego rozdania: tekst obiecujący zwielokrotniony zwrot („send 1 BTC get 2 back”, „x2”,
//      „rozdajemy”) przy adresie, zwłaszcza z nazwą znanej osoby lub marki; oraz wzorzec w blockchainie —
//      wiele wpłat od wielu różnych nadawców w krótkim oknie, a potem szybkie wyprowadzenie środków;
//   3. zatruwanie adresu („address poisoning”): kontrahent o tym samym początku i końcu co prawdziwy
//      kontrahent — sygnał dla KONTRAHENTA, nie dla adresu sprawy;
//   4. publiczne zbiory ostrzeżeń (migawki lokalne: MEW darklist — adresy, MetaMask — domeny phishingowe).
//      Trafienia na listach sankcyjnych już są w teczce (`riskLists`) — tu tylko odwołanie, bez powielania.
//
// Wynik nigdy nie przesądza o winie: „adres MÓGŁ być wykorzystywany do oszustwa”. Autorzy ostrzeżeń są
// poszkodowanymi lub świadkami — nigdy właścicielami; właściciel adresu pozostaje nieustalony.

import { SCAM_CONTEXT_PATTERNS, foldPreservingLength, provenanceGroups } from '@olcys/core';
import type { ClaimStatus, Evidence, EvidenceRef, Finding, GraphEdge, GraphNode, StoredEvidence, TextInsight, Transfer } from '@olcys/core';
import { scamListAddressFlags, scamListDomainFlags } from '@olcys/sources';
import type { ScamListAddressFlag, ScamListDomainFlag } from '@olcys/sources';
import { formatAmount, plural, shortAddress } from './format.ts';
import { addressKey } from './intel.ts';
import type { Sighting } from './intel.ts';

export type ScamLevel = 'none' | 'reports' | 'strong';

/** Jawne wagi i progi — jedyne miejsce z liczbami (wskaźnik porządkowy 0–100, nie prawdopodobieństwo). */
export const SCAM_RULES = {
  /** Pierwsze niezależne pochodzenie publikacji ostrzegającej przed adresem. */
  warningFirst: 35,
  /** Każde kolejne niezależne pochodzenie… */
  warningExtra: 15,
  /** …najwyżej łącznie. */
  warningExtraMax: 30,
  /** Tekst obiecujący zwielokrotniony zwrot przy adresie (fałszywe rozdanie). */
  giveawayText: 25,
  /** …z nazwą znanej osoby lub marki (podszywanie się). */
  impersonation: 10,
  /** Wzorzec w blockchainie typowy dla fałszywego rozdania (heurystyka). */
  chainPattern: 20,
  /** Wpis adresu w publicznym zbiorze ostrzeżeń. */
  listHit: 60,
  /** Domena z listy phishingowej w tej samej publikacji co adres. */
  domainHit: 20,
  /** Poziom „silne ostrzeżenie” od tylu punktów… */
  strong: 60,
  /** …„są zgłoszenia” od tylu. */
  reports: 25,
  /** Okno wokół adresu (znaki przed i po), w którym szukamy kontekstu ostrzeżenia lub rozdania. */
  window: 200,
  /** Wzorzec rozdania w blockchainie: okno wpłat, minimalna liczba wpłat i różnych nadawców, wyprowadzenie. */
  chain: { windowHours: 72, minInbound: 8, minSenders: 6, maxSenderShare: 0.5, sweepHours: 72, sweepShare: 0.8, nearFirstActivityDays: 14 },
  /** Adres-podróbka: ten sam początek i koniec (jak w packages/chain/src/links.ts). */
  poisoning: { prefix: 6, suffix: 4, minLength: 13 },
} as const;

const PRIVACY_NOTE = 'Zgłoszenie oszustwa to informacja z publikacji lub zbioru społecznościowego — nie ustalenie organu i nie dowód winy.';
export const SCAM_WARNERS_NOTE = 'Autorzy publikacji ostrzegających przed adresem to poszkodowani lub świadkowie — nie są właścicielami adresu i nie są kandydatami na osobę.';
export const SCAM_OWNER_NOTE = `${SCAM_WARNERS_NOTE} Właściciel adresu pozostaje nieustalony.`;
const SCAM_OWNER_KNOWN_NOTE = `${SCAM_WARNERS_NOTE} Kandydat na właściciela wynika z innych publikacji — ostrzeżenia go nie wskazują i nie potwierdzają; zgłoszenia nie przesądzają o jego winie.`;
export const SCAM_ACTION_NOTE =
  'Co można zrobić: jeśli sprawa tego wymaga, zgłoszenie do CERT Polska (incydent.cert.pl) albo na Policję. Narzędzie niczego nie zgłasza samo.';

/** Publikacja ostrzegająca przed adresem albo publikacja z obietnicą „rozdania”. */
export interface ScamPublication {
  url: string;
  title?: string;
  service: string;
  author?: string;
  publishedAt?: string;
  /** Fragment treści przy adresie (oryginalna pisownia). */
  quote: string;
  /** `warning` — ostrzeżenie przed adresem; `giveaway` — obietnica zwielokrotnionego zwrotu (sama oferta „rozdania”). */
  kind: 'warning' | 'giveaway';
  /** Podstawa: reguła tekstowa, odczyt modelu językowego albo oba. */
  basis: 'rule' | 'model' | 'rule+model';
  /** Słowa i wzorce, na których oparto rozpoznanie. */
  matched: string[];
  /** Obietnica zwielokrotnionego zwrotu w tej publikacji (także cytowana w ostrzeżeniu). */
  giveaway: boolean;
  /** Nazwa znanej osoby lub marki przy obietnicy (możliwe podszywanie się). */
  impersonates?: string;
  /** Numer grupy pochodzenia (`provenanceGroups`) — kopie mają ten sam numer. */
  origin: number;
}

export interface ScamComponent {
  rule: string;
  weight: number;
  status: ClaimStatus;
  source: string;
  evidence: EvidenceRef[];
  explanation: string;
  limitations: string[];
}

/** Wzorzec w blockchainie typowy dla fałszywego rozdania (heurystyka, zawsze hipoteza). */
export interface GiveawayChainPattern {
  windowStart: string;
  windowEnd: string;
  inbound: number;
  senders: number;
  inboundAmount: number;
  asset: string;
  sweepAmount: number;
  sweepTime: string;
  /** Okno zaczyna się blisko pierwszej aktywności adresu w pobranych danych. */
  nearFirstActivity: boolean;
  txids: string[];
  explanation: string;
}

export interface ScamAddressWarning {
  address: string;
  network: string;
  level: ScamLevel;
  /** Suma wag składników (porządkowa 0–100). */
  score: number;
  /** Zdanie dla analityka — nigdy nie przesądza o winie. */
  statement: string;
  /** Niezależne źródła zgłoszeń: pochodzenia publikacji ostrzegających + zbiory ostrzeżeń z trafieniem. */
  independentSources: number;
  components: ScamComponent[];
  publications: ScamPublication[];
  listHits: ScamListAddressFlag[];
  domainHits: ScamListDomainFlag[];
  chainPattern?: GiveawayChainPattern;
  /** Odwołanie do trafień list sankcyjnych tego adresu (szczegóły w części „Listy ryzyka”). */
  sanctions: string[];
  /** Skutki dla interpretacji: kim są autorzy ostrzeżeń, co z właścicielem. */
  interpretation: string[];
  /** Neutralna linia „co można zrobić”. */
  action: string;
  /** Źródła do wypisania (nazwa i odnośnik). */
  sources: { label: string; url?: string }[];
  limitations: string[];
}

/** Kontrahent wyglądający na podróbkę prawdziwego kontrahenta (zatruwanie adresu) — hipoteza. */
export interface PoisoningSignal {
  /** Adres sprawy, w którego historii widać podróbkę. */
  address: string;
  network: string;
  /** Adres-podróbka (kontrahent). */
  lookalike: string;
  /** Prawdziwy kontrahent, pod którego podróbka się podszywa. */
  genuine: string;
  txids: string[];
  status: 'hypothesis';
  explanation: string;
}

export interface ScamWarnings {
  level: ScamLevel;
  statement: string;
  /** Adresy z co najmniej jednym składnikiem (także poniżej progu ostrzeżenia). */
  addresses: ScamAddressWarning[];
  poisoning: PoisoningSignal[];
  limitations: string[];
}

export interface ScamDocument {
  url: string;
  title?: string;
  service: string;
  author?: string;
  publishedAt?: string;
  archivedAt?: string;
  text: string;
  contentHash?: string;
}

export interface ScamInput {
  /** Adresy teczki; ślady z `evidence` i `excludedEvidence` (z odczytem modelu, jeśli był). */
  findings: (Finding & { evidence: (StoredEvidence & { insight?: TextInsight })[]; excludedEvidence?: (StoredEvidence & { insight?: TextInsight })[]; notes?: string[] })[];
  /** Pełne treści dokumentów analizy (także publikacji innych autorów). Bez nich — tylko fragmenty śladów. */
  documents?: ScamDocument[];
  sightings?: Sighting[];
  /** Kandydaci na osobę — do sprawdzenia, że żaden autor ostrzeżenia nie jest kandydatem. */
  persons?: { profileIds: string[] }[];
  /** Odznaki list sankcyjnych (id węzła grafu → trafienie). */
  riskLists?: Record<string, { badge: string; summary: string }>;
  listCheck?: (addresses: string[]) => ScamListAddressFlag[];
  domainCheck?: (values: string[]) => ScamListDomainFlag[];
}

// ---------- Reguła tekstowa ----------

/** Dodatkowe słowa ostrzeżenia spoza wzorców core (tekst po złożeniu znaków diakrytycznych). */
const EXTRA_WARNING = /\b(uwaga[,!:]|zglosz\w*|ukradl\w*|okradl\w*|rug ?pull\w*|drainer\w*|wallet drainer|nie wysylajcie|ponzi|piramid\w* finansow\w*)/;
/** Słowa, które wzorzec ostrzeżenia łapałby przypadkiem. */
const WARNING_NOISE = /\b(hackathon\w*|hacker news|hackernews|ostrzezenie o oszustwach:|scam alert:?\s*(none|brak|0)\b|no scam reports?|brak zgloszen)/g;
/** Właściciel ostrzega przed podszywaniem się i wskazuje SWÓJ jedyny adres — to nie ostrzeżenie przed tym adresem. */
const OFFICIAL_ADDRESS =
  /\b(jedyn\w* (prawdziw\w* |oficjaln\w* |wlasciw\w* )?adres\w*|oficjaln\w* adres\w*|nasz\w* (jedyn\w* |oficjaln\w* )?(adres|portfel)\w*|our (only |official )?(address|wallet)|(the )?official (address|wallet)|only (valid|legit|real|official) (address|wallet))\b/;
/** Obietnica zwielokrotnionego zwrotu. */
const MULTIPLY: RegExp[] = [
  /\b(send|wyslij\w*|wplac\w*|przelej\w*)\b[^.!?\n]{0,80}\b(get|receive|otrzyma\w*|dostan\w*|odsyla\w*|odesl\w*|zwrac\w*|wroc\w*)\b[^.!?\n]{0,40}(\bback\b|\bx ?[2-9]\b|\b[2-9] ?x\b|\bpodwoj\w*|\bdouble\w*|\b[0-9]+(\.[0-9]+)? ?(btc|eth|usdt|trx)\b)/,
  /\bdouble your\b|\bpodwoimy\b|\bpodwajamy\b|\bpodwoj\w* (twoj|wplat)\w*/,
  /\b(rozdajemy|rozdanie\w*|giveaway|give away|airdrop)\b/,
  /\b(x ?[2-9]|[2-9] ?x)\b[^.!?\n]{0,30}\b(zwrot\w*|back|return\w*)\b|\b(zwrot\w*|return\w*)\b[^.!?\n]{0,30}\b(x ?[2-9]|[2-9] ?x)\b/,
];
/** Znane osoby i marki, pod które podszywają się fałszywe rozdania. */
const BRANDS = /\b(elon musk|musk|elon|tesla|spacex|vitalik|buterin|saylor|microstrategy|binance|coinbase|kraken|ripple|cardano|bill gates|apple|changpeng|zondacrypto|kanga|lewandowski|cristiano|ronaldo|mrbeast|trump|obama|bezos)\b/;

const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();

interface TextReading {
  warning: boolean;
  giveaway: boolean;
  impersonates?: string;
  matched: string[];
  /** Indeks wystąpienia adresu, przy którym rozpoznano kontekst (dla cytatu). */
  at: number;
}

/** Rozpoznanie kontekstu przy wystąpieniach adresu: ostrzeżenie, rozdanie, podszywanie się. `undefined` — nic. */
export function readScamContext(text: string, address: string): TextReading | undefined {
  const folded = foldPreservingLength(text);
  const needle = address.trim().toLowerCase();
  if (!needle) return undefined;
  const { window } = SCAM_RULES;
  let result: TextReading | undefined;
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    const slice = folded.slice(Math.max(0, at - window), at + needle.length + window).split(needle).join(' adresx ');
    if (OFFICIAL_ADDRESS.test(slice)) continue;
    const clean = slice.replace(WARNING_NOISE, ' ');
    const matched: string[] = [];
    for (const pattern of [SCAM_CONTEXT_PATTERNS.warning, SCAM_CONTEXT_PATTERNS.doNotPay, EXTRA_WARNING]) {
      const hit = pattern.exec(clean);
      if (hit) matched.push(hit[0].trim());
    }
    const warning = matched.length > 0;
    const promise = MULTIPLY.map((pattern) => pattern.exec(clean)?.[0]).filter((item): item is string => Boolean(item));
    const giveawayCore = SCAM_CONTEXT_PATTERNS.giveaway.exec(clean)?.[0];
    const giveaway = promise.length > 0 || Boolean(giveawayCore);
    if (!warning && !giveaway) continue;
    const brand = giveaway ? BRANDS.exec(clean)?.[0] : undefined;
    const reading: TextReading = {
      warning,
      giveaway,
      ...(brand ? { impersonates: brand } : {}),
      matched: [...new Set([...matched, ...promise.map((item) => collapse(item).slice(0, 60)), ...(giveawayCore ? [giveawayCore] : [])])],
      at,
    };
    // Ostrzeżenie ma pierwszeństwo nad samą obietnicą (ostrzeżenie często cytuje treść „rozdania”).
    if (!result || (reading.warning && !result.warning)) result = reading;
    if (result.warning && result.giveaway) break;
  }
  return result;
}

/**
 * Cytat przy adresie: wiersz z adresem (bez nagłówków strony — autor, data, numer wpisu), a gdy wiersz jest
 * za krótki albo za długi — okno ±140 znaków. Ten sam cytat służy do rozpoznawania kopii (`provenanceGroups`).
 */
function quoteAt(text: string, at: number, length: number): string {
  const start = text.lastIndexOf('\n', at) + 1;
  const stop = text.indexOf('\n', at + length);
  const line = collapse(text.slice(start, stop < 0 ? undefined : stop));
  if (line.length >= length + 30 && line.length <= 400) return line;
  return collapse(text.slice(Math.max(0, at - 140), at + length + 140)).slice(0, 320);
}

// ---------- Wzorzec w blockchainie ----------

const HOUR = 3_600_000;
const time = (iso: string) => new Date(iso).getTime();

/** Wiele wpłat od wielu różnych nadawców w krótkim oknie, potem szybkie wyprowadzenie większości środków. */
export function giveawayChainPattern(finding: Pick<Finding, 'chain'>): GiveawayChainPattern | undefined {
  const rules = SCAM_RULES.chain;
  const transfers = [...(finding.chain?.transfers ?? [])].filter((item) => item.amount > 0 && !Number.isNaN(time(item.time))).sort((a, b) => time(a.time) - time(b.time));
  if (transfers.length < rules.minInbound) return undefined;
  const first = Math.min(time(transfers[0]!.time), finding.chain?.profile.firstSeen ? time(finding.chain.profile.firstSeen) || Infinity : Infinity);
  const inbound = transfers.filter((item) => item.direction === 'in');
  for (let start = 0; start < inbound.length; start++) {
    const from = time(inbound[start]!.time);
    const asset = inbound[start]!.asset;
    const window = inbound.filter((item) => item.asset === asset && time(item.time) >= from && time(item.time) <= from + rules.windowHours * HOUR);
    if (window.length < rules.minInbound) continue;
    const bySender = new Map<string, number>();
    for (const item of window) bySender.set(item.counterparty, (bySender.get(item.counterparty) ?? 0) + item.amount);
    const total = window.reduce((sum, item) => sum + item.amount, 0);
    if (bySender.size < rules.minSenders || Math.max(...bySender.values()) > total * rules.maxSenderShare) continue;
    const end = time(window[window.length - 1]!.time);
    const sweep = transfers.filter((item) => item.direction === 'out' && item.asset === asset && time(item.time) >= from && time(item.time) <= end + rules.sweepHours * HOUR);
    const swept = sweep.reduce((sum, item) => sum + item.amount, 0);
    if (swept < total * rules.sweepShare) continue;
    const windowStart = window[0]!.time;
    const windowEnd = window[window.length - 1]!.time;
    const sweepTime = sweep[sweep.length - 1]!.time;
    const nearFirstActivity = from - first <= rules.nearFirstActivityDays * 24 * HOUR;
    return {
      windowStart,
      windowEnd,
      inbound: window.length,
      senders: bySender.size,
      inboundAmount: total,
      asset,
      sweepAmount: swept,
      sweepTime,
      nearFirstActivity,
      txids: [...new Set([...window, ...sweep].map((item) => item.txid))],
      explanation:
        `HIPOTEZA: ${window.length} wpłat od ${bySender.size} różnych nadawców w ciągu ${Math.max(1, Math.round((end - from) / HOUR))} h (${windowStart.slice(0, 10)}–${windowEnd.slice(0, 10)}, łącznie ${formatAmount(total)} ${asset}), ` +
        `a do ${sweepTime.slice(0, 10)} wyprowadzono ${formatAmount(swept)} ${asset} (${Math.round((100 * swept) / total)}% wpływów)${nearFirstActivity ? ' — zaraz po pierwszej aktywności adresu' : ''}. ` +
        'Taki przebieg jest typowy dla fałszywego rozdania (wiele ofiar wpłaca, środki szybko znikają), ale zbiórka, sprzedaż albo adres wpłat usługi mogą wyglądać podobnie.',
    };
  }
  return undefined;
}

// ---------- Zatruwanie adresu ----------

const lookalike = (a: string, b: string) => {
  const { prefix, suffix, minLength } = SCAM_RULES.poisoning;
  return a !== b && a.length === b.length && a.length >= minLength && a.slice(0, prefix).toLowerCase() === b.slice(0, prefix).toLowerCase() && a.slice(-suffix).toLowerCase() === b.slice(-suffix).toLowerCase();
};

/** Kontrahenci-podróbki w historii adresu: ten sam początek i koniec co prawdziwy kontrahent, mniejszy obrót. */
export function addressPoisoning(finding: Pick<Finding, 'address' | 'network' | 'chain'>): PoisoningSignal[] {
  const parties = new Map<string, Transfer[]>();
  for (const item of finding.chain?.transfers ?? []) parties.set(item.counterparty, [...(parties.get(item.counterparty) ?? []), item]);
  const volume = (items: Transfer[]) => items.reduce((sum, item) => sum + item.amount, 0);
  const keys = [...parties.keys()];
  const result: PoisoningSignal[] = [];
  for (const fake of keys) {
    // Podróbka podszywa się pod adres, na który adres sprawy sam wysyłał (prawdziwy kontrahent), albo pod adres sprawy.
    const genuine = keys.filter((other) => lookalike(fake, other) && volume(parties.get(other)!) > volume(parties.get(fake)!)).sort((a, b) => volume(parties.get(b)!) - volume(parties.get(a)!))[0];
    const target = genuine ?? (lookalike(fake, finding.address) ? finding.address : undefined);
    if (!target) continue;
    const items = parties.get(fake)!;
    result.push({
      address: finding.address,
      network: finding.network,
      lookalike: fake,
      genuine: target,
      txids: [...new Set(items.map((item) => item.txid))].slice(0, 10),
      status: 'hypothesis',
      explanation:
        `HIPOTEZA: kontrahent ${shortAddress(fake)} ma ten sam początek i koniec co ${target === finding.address ? 'sam adres sprawy' : `prawdziwy kontrahent ${shortAddress(target)}`} ` +
        `(${items.length} ${plural(items.length, 'przelew', 'przelewy', 'przelewów')}, ${formatAmount(volume(items))} ${items[0]!.asset}) — typowy ślad zatruwania adresu („address poisoning”): ` +
        'oszust podsuwa podobny adres w historii, licząc, że ofiara skopiuje go przy następnym przelewie. To sygnał dla kontrahenta-podróbki, nie dla adresu sprawy.',
    });
  }
  return result;
}

// ---------- Ocena ----------

const originService = (item: { service: string; author?: string; url: string }) => {
  let host = item.service;
  try {
    host = new URL(item.url).hostname;
  } catch {
    // zostaje nazwa usługi
  }
  return `${item.service}|${(item.author ?? host).toLowerCase()}`.toLowerCase();
};

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"'”)]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|xyz|app|live|site|online|top|info|pl|eu|co|me|gift|club|finance|exchange)\b/gi;
const NOTE_KNOWLEDGE = /^Wiedza o adresie z serwisu (.+?): „(.+)” \((https?:\/\/[^)\s]+)\)/;

const sourcesText = (count: number) => `${count} ${plural(count, 'niezależnym źródle', 'niezależnych źródłach', 'niezależnych źródłach')}`;

/** Ocena jednego adresu teczki; `undefined`, gdy brak jakiegokolwiek składnika. */
function assessAddress(finding: ScamInput['findings'][number], input: ScamInput, listHits: ScamListAddressFlag[]): ScamAddressWarning | undefined {
  const needle = finding.address.toLowerCase();
  const roleOf = new Map((input.sightings ?? []).map((item) => [item.url, item]));
  const allEvidence = [...finding.evidence, ...(finding.excludedEvidence ?? [])];

  // Teksty: pełne dokumenty z adresem; brakujące uzupełniają fragmenty śladów i wiedza o adresie z publikacji bez autora.
  const texts: ScamDocument[] = [];
  const seenUrls = new Set<string>();
  for (const doc of input.documents ?? []) {
    if (!doc.text.toLowerCase().includes(needle) || seenUrls.has(`${doc.url}|${doc.archivedAt ?? ''}`)) continue;
    seenUrls.add(`${doc.url}|${doc.archivedAt ?? ''}`);
    texts.push(doc);
  }
  for (const item of allEvidence) {
    if (seenUrls.has(`${item.url}|${item.archivedAt ?? ''}`)) continue;
    seenUrls.add(`${item.url}|${item.archivedAt ?? ''}`);
    texts.push({ url: item.url, title: item.title, service: item.service, ...(item.author ? { author: item.author } : {}), ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}), ...(item.archivedAt ? { archivedAt: item.archivedAt } : {}), text: item.excerpt, contentHash: item.contentHash });
  }
  for (const note of finding.notes ?? []) {
    const match = NOTE_KNOWLEDGE.exec(note);
    if (!match || [...seenUrls].some((key) => key.startsWith(`${match[3]}|`))) continue;
    seenUrls.add(`${match[3]}|`);
    // Tytuł publikacji bez autora (np. „Scam Alert: 3 reports”) — kontekst bez samego adresu: dopisujemy adres do odczytu.
    texts.push({ url: match[3]!, title: match[2]!, service: match[1]!, text: `${match[2]} ${finding.address}` });
  }

  // Odczyt modelu (z cytatem) — po adresie URL śladu.
  const modelWarnings = new Map(allEvidence.filter((item) => item.insight?.ownership === 'warning_about_address' && item.insight.quote.trim()).map((item) => [item.url, item.insight!]));

  const found: Omit<ScamPublication, 'origin'>[] = [];
  const domainCandidates: { value: string; url: string }[] = [];
  for (const doc of texts) {
    const reading = readScamContext(doc.text, finding.address);
    const model = modelWarnings.get(doc.url);
    if (!reading && !model) continue;
    const warning = Boolean(reading?.warning) || Boolean(model);
    const role = roleOf.get(doc.url);
    const author = doc.author ?? role?.author;
    found.push({
      url: doc.url,
      ...(doc.title ? { title: doc.title } : {}),
      service: doc.service,
      ...(author ? { author } : {}),
      ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
      quote: reading ? quoteAt(doc.text, reading.at, needle.length) : model!.quote.trim(),
      kind: warning ? 'warning' : 'giveaway',
      basis: reading?.warning && model ? 'rule+model' : reading?.warning || (reading && !model) ? 'rule' : 'model',
      matched: [...(reading?.matched ?? []), ...(model ? [`model ${model.model}: „${model.quote.trim()}”`] : [])],
      giveaway: Boolean(reading?.giveaway),
      ...(reading?.impersonates ? { impersonates: reading.impersonates } : {}),
    });
    // Domeny w publikacji z adresem (odnośniki w treści i host samej publikacji nie jest sprawdzany — to źródło).
    for (const match of doc.text.matchAll(URL_IN_TEXT)) domainCandidates.push({ value: match[0], url: doc.url });
  }

  // Niezależne pochodzenia: grupy `provenanceGroups` (autor publikacji, ta sama treść, przedruk, kopia archiwalna).
  const evidenceLike: Evidence[] = found.map((item, index) => ({
    id: String(index),
    category: 'forum_post',
    service: originService(item),
    url: item.url,
    capturedAt: '',
    identityMatch: 'same_handle',
    excerpt: item.quote,
  }));
  const groupOf = new Map<string, number>();
  provenanceGroups(evidenceLike).forEach((group, index) => group.evidenceIds.forEach((id) => groupOf.set(id, index)));
  const publications: ScamPublication[] = found.map((item, index) => ({ ...item, origin: groupOf.get(String(index)) ?? index }));
  const warnings = publications.filter((item) => item.kind === 'warning');
  const warningOrigins = new Set(warnings.map((item) => item.origin)).size;
  const giveaways = publications.filter((item) => item.giveaway);
  const impersonated = giveaways.find((item) => item.impersonates)?.impersonates;

  let domainHits: ScamListDomainFlag[] = [];
  try {
    domainHits = domainCandidates.length > 0 ? (input.domainCheck ?? ((values) => scamListDomainFlags(values)))(domainCandidates.map((item) => item.value)) : [];
  } catch {
    domainHits = [];
  }
  const chainPattern = giveawayChainPattern(finding);
  const node = `addr:${addressKey(finding)}`;
  const sanctionBadge = input.riskLists?.[node];
  const sanctions = sanctionBadge ? [`${sanctionBadge.summary} — szczegóły w części „Listy ryzyka” (trafienie nie jest tu powielane).`] : [];

  const components: ScamComponent[] = [];
  const urlRefs = (items: ScamPublication[]): EvidenceRef[] => [...new Set(items.map((item) => item.url))].slice(0, 10).map((value) => ({ kind: 'url' as const, value }));
  if (warnings.length > 0) {
    const weight = SCAM_RULES.warningFirst + Math.min(SCAM_RULES.warningExtraMax, (warningOrigins - 1) * SCAM_RULES.warningExtra);
    const byModel = warnings.filter((item) => item.basis !== 'rule').length;
    components.push({
      rule: 'scam.warning_publications',
      weight,
      status: 'source_fact',
      source: 'publikacje zebrane w analizie (reguła tekstowa przy adresie' + (byModel > 0 ? ' i odczyt modelu językowego z cytatem)' : ')'),
      evidence: urlRefs(warnings),
      explanation:
        `${warnings.length} ${plural(warnings.length, 'publikacja ostrzega', 'publikacje ostrzegają', 'publikacji ostrzega')} przed tym adresem (${sourcesText(warningOrigins)}; kopie i przedruki liczone raz)` +
        `${byModel > 0 ? `, w tym ${byModel} według odczytu modelu językowego` : ''}. Fakt dotyczy treści publikacji — nie rozstrzyga, czy oszustwo miało miejsce.`,
      limitations: [PRIVACY_NOTE, 'Ostrzeżenie mogło być pomyłką albo celowym oczernianiem; sprawdź treść publikacji.'],
    });
  }
  if (giveaways.length > 0) {
    components.push({
      rule: 'scam.giveaway_text',
      weight: SCAM_RULES.giveawayText,
      status: 'hypothesis',
      source: 'publikacje zebrane w analizie (reguła tekstowa: obietnica zwielokrotnionego zwrotu przy adresie)',
      evidence: urlRefs(giveaways),
      explanation: `Przy adresie stoi obietnica zwielokrotnionego zwrotu („rozdanie”, „x2”, „send … get … back”) w ${giveaways.length} ${plural(giveaways.length, 'publikacji', 'publikacjach', 'publikacjach')} — wzorzec fałszywego rozdania.`,
      limitations: ['Prawdziwe akcje promocyjne zdarzają się rzadko, ale się zdarzają; obietnica zwrotu sama nie dowodzi oszustwa.'],
    });
    if (impersonated) {
      components.push({
        rule: 'scam.impersonation',
        weight: SCAM_RULES.impersonation,
        status: 'hypothesis',
        source: 'publikacje zebrane w analizie (reguła tekstowa: nazwa znanej osoby lub marki przy obietnicy zwrotu)',
        evidence: urlRefs(giveaways.filter((item) => item.impersonates)),
        explanation: `Obietnica zwrotu powołuje się na znaną osobę lub markę („${impersonated}”) — typowe podszywanie się w fałszywych rozdaniach. Wymieniona osoba lub marka to możliwa OFIARA podszywania się, nie właściciel adresu.`,
        limitations: ['Wymienienie nazwy nie oznacza, że osoba lub firma ma cokolwiek wspólnego z adresem.'],
      });
    }
  }
  if (chainPattern) {
    components.push({
      rule: 'scam.giveaway_chain_pattern',
      weight: SCAM_RULES.chainPattern,
      status: 'hypothesis',
      source: 'moduł danych blockchain (przelewy pobrane w analizie)',
      evidence: chainPattern.txids.slice(0, 10).map((value) => ({ kind: 'txid' as const, value })),
      explanation: chainPattern.explanation,
      limitations: ['Wzorzec liczony wyłącznie z pobranych przelewów (dostawcy danych zwracają ograniczoną liczbę transakcji) — brak wzorca niczego nie dowodzi.'],
    });
  }
  if (listHits.length > 0) {
    components.push({
      rule: 'scam.public_list',
      weight: SCAM_RULES.listHit,
      status: 'source_fact',
      source: [...new Set(listHits.map((item) => `${item.listLabel} (migawka z ${item.retrievedAt.slice(0, 10)}, licencja ${item.licence})`))].join('; '),
      evidence: [{ kind: 'address', value: finding.address }, ...listHits.map((item) => ({ kind: 'url' as const, value: item.url }))],
      explanation: `Adres figuruje w publicznym zbiorze ostrzeżeń: ${listHits.map((item) => `„${item.comment || 'bez opisu'}”${item.date ? ` (wpis z ${item.date})` : ''}`).join('; ')} — fakt o liście.`,
      limitations: [listHits[0]!.caveat],
    });
  }
  if (domainHits.length > 0) {
    components.push({
      rule: 'scam.phishing_domain',
      weight: SCAM_RULES.domainHit,
      status: 'source_fact',
      source: `${domainHits[0]!.listLabel} (migawka z ${domainHits[0]!.retrievedAt.slice(0, 10)}, licencja ${domainHits[0]!.licence})`,
      evidence: domainHits.slice(0, 10).map((item) => ({ kind: 'attribute' as const, value: item.domain })),
      explanation: `W publikacji z tym adresem jest odnośnik do domeny z listy phishingowej: ${domainHits.map((item) => item.domain).join(', ')} — fakt o liście; adres pojawia się obok strony podszywającej się pod usługę.`,
      limitations: [domainHits[0]!.caveat],
    });
  }
  if (sanctions.length > 0) {
    components.push({
      rule: 'scam.sanctions_reference',
      weight: 0,
      status: 'source_fact',
      source: 'listy sankcyjne (lokalne migawki) — wynik części „Listy ryzyka”',
      evidence: [{ kind: 'address', value: finding.address }],
      explanation: `Odwołanie: ${sanctions[0]} Składnik informacyjny — nie zmienia wyniku.`,
      limitations: [],
    });
  }
  if (components.length === 0) return undefined;

  const score = Math.min(100, components.reduce((sum, item) => sum + item.weight, 0));
  const level: ScamLevel = score >= SCAM_RULES.strong ? 'strong' : score >= SCAM_RULES.reports ? 'reports' : 'none';
  const independentSources = warningOrigins + new Set(listHits.map((item) => item.list)).size;
  const statement =
    independentSources > 0
      ? `Ostrzeżenie: adres mógł być wykorzystywany do oszustwa (zgłoszenia w ${sourcesText(independentSources)}).`
      : `Ostrzeżenie: adres mógł być wykorzystywany do oszustwa (${[giveaways.length > 0 ? 'obietnica „rozdania” przy adresie' : '', chainPattern ? 'wzorzec wpłat w blockchainie' : '', domainHits.length > 0 ? 'domena phishingowa obok adresu' : ''].filter(Boolean).join(', ')}; brak zgłoszeń w źródłach) — hipoteza.`;

  // Skutki dla interpretacji — i sprawdzenie, że żaden autor ostrzeżenia nie jest kandydatem na osobę.
  const candidates = new Set((input.persons ?? []).flatMap((person) => person.profileIds.map((id) => id.toLowerCase())));
  const interpretation = [candidates.size > 0 ? SCAM_OWNER_KNOWN_NOTE : SCAM_OWNER_NOTE];
  const conflicting = warnings.filter((item) => item.author && candidates.has(`${item.service}|${item.author}`.toLowerCase()));
  for (const item of conflicting) {
    interpretation.push(`SPRZECZNOŚĆ do sprawdzenia: autor „${item.author}” (${item.service}) ostrzega przed adresem, a jest wśród kandydatów na osobę — ostrzeżenie nie może być podstawą przypisania adresu.`);
  }
  if (impersonated) interpretation.push(`Nazwa „${impersonated}” w obietnicy zwrotu to możliwa ofiara podszywania się, nie właściciel adresu.`);
  const sources = [
    ...warnings.map((item) => ({ label: `${item.service}${item.author ? ` — „${item.author}”` : ''}${item.title ? `: ${item.title}` : ''}`, url: item.url })),
    ...listHits.map((item) => ({ label: item.listLabel, url: item.url })),
    ...domainHits.slice(0, 3).map((item) => ({ label: `${item.listLabel}: ${item.domain}`, url: item.url })),
  ];
  const limitations = [
    PRIVACY_NOTE,
    `Wynik ${score}/100 to suma jawnych wag (${components.map((item) => `${item.rule} ${item.weight}`).join(', ')}); próg „są zgłoszenia” ${SCAM_RULES.reports}, „silne ostrzeżenie” ${SCAM_RULES.strong} — wskaźnik porządkowy, nie prawdopodobieństwo.`,
    ...(input.documents ? [] : ['Treści publikacji innych autorów nie były dostępne — oceniono tylko fragmenty śladów przy adresie.']),
  ];
  return {
    address: finding.address,
    network: finding.network,
    level,
    score,
    statement,
    independentSources,
    components,
    publications,
    listHits,
    domainHits,
    ...(chainPattern ? { chainPattern } : {}),
    sanctions,
    interpretation,
    action: SCAM_ACTION_NOTE,
    sources,
    limitations,
  };
}

const LEVEL_ORDER: Record<ScamLevel, number> = { none: 0, reports: 1, strong: 2 };

/** Ostrzeżenia o możliwym oszustwie dla wszystkich adresów teczki. */
export function buildScamWarnings(input: ScamInput): ScamWarnings {
  const limitations: string[] = [];
  let listHits: ScamListAddressFlag[] = [];
  try {
    listHits = (input.listCheck ?? ((addresses) => scamListAddressFlags(addresses)))(input.findings.map((item) => item.address));
  } catch {
    limitations.push('Nie udało się wczytać migawek zbiorów ostrzeżeń — brak informacji to nie brak wpisu.');
  }
  const addresses: ScamAddressWarning[] = [];
  const poisoning: PoisoningSignal[] = [];
  const seen = new Set<string>();
  for (const finding of input.findings) {
    const key = addressKey(finding);
    if (seen.has(key)) continue;
    seen.add(key);
    const own = listHits.filter((item) => item.address.toLowerCase() === finding.address.toLowerCase());
    const warning = assessAddress(finding, input, own);
    if (warning) addresses.push(warning);
    poisoning.push(...addressPoisoning(finding));
  }
  addresses.sort((a, b) => LEVEL_ORDER[b.level] - LEVEL_ORDER[a.level] || b.score - a.score);
  const level = addresses.reduce<ScamLevel>((top, item) => (LEVEL_ORDER[item.level] > LEVEL_ORDER[top] ? item.level : top), 'none');
  const flagged = addresses.filter((item) => item.level !== 'none');
  const statement =
    flagged.length === 0
      ? 'Brak zgłoszeń, że adresy sprawy mogły być wykorzystywane do oszustwa (w zebranych materiałach i lokalnych zbiorach ostrzeżeń).'
      : flagged.length === 1
        ? flagged[0]!.statement
        : `Ostrzeżenie: ${flagged.length} ${plural(flagged.length, 'adres', 'adresy', 'adresów')} sprawy mogły być wykorzystywane do oszustwa — szczegóły i źródła przy adresach.`;
  if (level !== 'none') limitations.push(SCAM_WARNERS_NOTE, PRIVACY_NOTE);
  if (poisoning.length > 0) limitations.push('Zatruwanie adresu dotyczy kontrahentów-podróbek, nie adresu sprawy — nie podnosi poziomu ostrzeżenia dla adresu sprawy.');
  return { level, statement, addresses, poisoning, limitations };
}

/** Węzeł adresu w grafie dostaje dopisek „zgłoszenia oszustwa” i pole `scam` (poziom). */
export function applyScamGraph(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, warnings: ScamWarnings): void {
  for (const item of warnings.addresses) {
    if (item.level === 'none') continue;
    const node = graph.nodes.find((candidate) => candidate.id === `addr:${addressKey(item)}`);
    if (!node) continue;
    const badge = item.level === 'strong' ? 'zgłoszenia oszustwa' : 'możliwe oszustwo (zgłoszenia)';
    if (!node.sublabel?.startsWith(badge)) node.sublabel = node.sublabel ? `${badge} · ${node.sublabel}` : badge;
    (node as GraphNode & { scam?: { level: ScamLevel; sources: number } }).scam = { level: item.level, sources: item.independentSources };
  }
}

/** Całość dla teczki: ostrzeżenia i dopisek w grafie. */
export function applyScamWarnings(input: ScamInput & { graph: { nodes: GraphNode[]; edges: GraphEdge[] } }): ScamWarnings {
  const warnings = buildScamWarnings(input);
  applyScamGraph(input.graph, warnings);
  return warnings;
}

/** Kluczowe ustalenia: trafienie zbioru = fakt o liście, reszta = wniosek do weryfikacji. */
export function scamKeyFindings(warnings: ScamWarnings | undefined): { text: string; layer: 'fact' | 'inference' }[] {
  if (!warnings) return [];
  const result: { text: string; layer: 'fact' | 'inference' }[] = [];
  for (const item of warnings.addresses.filter((entry) => entry.level !== 'none')) {
    const named = item.sources.slice(0, 3).map((source) => source.label).join('; ');
    result.push({
      text: `${item.statement.replace(/^Ostrzeżenie: adres/, `Ostrzeżenie: adres ${shortAddress(item.address)}`)} Źródła: ${named}${item.sources.length > 3 ? ` i ${item.sources.length - 3} innych` : ''}. ${item.interpretation[0] ?? SCAM_OWNER_NOTE}`,
      layer: item.listHits.length > 0 ? 'fact' : 'inference',
    });
  }
  if (warnings.poisoning.length > 0) {
    result.push({
      text: `Możliwe zatruwanie adresu: ${warnings.poisoning.length} ${plural(warnings.poisoning.length, 'kontrahent wygląda', 'kontrahentów wygląda', 'kontrahentów wygląda')} na podróbkę prawdziwego kontrahenta (ten sam początek i koniec adresu) — hipoteza dotycząca kontrahentów, nie adresu sprawy.`,
      layer: 'inference',
    });
  }
  return result;
}
