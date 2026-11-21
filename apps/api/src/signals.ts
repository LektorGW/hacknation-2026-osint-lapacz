// Sygnały monitoringu: na ile publikacja wiąże się z Polską i czy zawiera oznaki obrotu
// kryptowalutami wymagającego uwagi. Wyłącznie jawne reguły z `data/signals.json`:
// każda ocena to suma wag wykrytych sygnałów (najwyżej 100), a każdy sygnał trafia do
// `reasons` z cytowanym fragmentem. Sygnały obrotu są wskazówką „do sprawdzenia” —
// nie zarzutem i nie ustaleniem.

import { readFileSync } from 'node:fs';
import type { ProfileAttributes, ScoredSignal } from '@olcys/core';

interface SignalConfig {
  thresholds: {
    hitPolishNexus: number;
    hitSuspicion: number;
    autoAnalyzeDefault: number;
    maxAutoAnalysesPerRun: number;
    maxAiPublicationsPerRun: number;
    contractCheckBudgetPerRun: number;
    newsMinLength: number;
    offerMaxPosition: number;
    discoverLimitPerSource: number;
    priorityPolishWeight: number;
  };
  ownership: { phrases: string[] };
  news: { sourceIds: string[] };
  governance: { hostPatterns: string[]; connectorPrefixes: string[] };
  polishWeights: Record<string, number>;
  suspicionWeights: Record<string, number>;
  language: { polishWords: string[]; englishWords: string[] };
  polish: Record<'currency' | 'blik' | 'phoneTransfer' | 'banks' | 'cryptoExchanges' | 'places' | 'country' | 'firstNames' | 'services' | 'timezones', string[]>;
  suspicion: Record<'tradeVerbs' | 'cryptoTerms' | 'cashOrInPerson' | 'noKyc' | 'regularActivity' | 'cryptoPayments' | 'payoutToAccount' | 'depositAddressRequest', string[]> & {
    amountRatesPln: Record<string, number>;
    amountSignificantPln: number;
    amountLargePln: number;
  };
}

const CONFIG = JSON.parse(readFileSync(new URL('../data/signals.json', import.meta.url), 'utf8')) as SignalConfig;

/** Wagi i progi pokazywane przez API — pełne listy fraz są w `data/signals.json`. */
export const SIGNAL_RULES = {
  thresholds: CONFIG.thresholds,
  polishWeights: CONFIG.polishWeights,
  suspicionWeights: CONFIG.suspicionWeights,
  amount: {
    ratesPln: CONFIG.suspicion.amountRatesPln,
    significantPln: CONFIG.suspicion.amountSignificantPln,
    largePln: CONFIG.suspicion.amountLargePln,
  },
  description:
    'Obie oceny to suma wag wykrytych sygnałów, najwyżej 100. Trafienie powstaje, gdy publikacja zawiera adres kryptowalutowy ' +
    'albo gdy związek z Polską i sygnały obrotu osiągają progi; autor jest analizowany automatycznie, gdy suma obu ocen ' +
    'osiąga próg automatycznej analizy. Kursy przy kwotach są orientacyjne i służą wyłącznie do progów. ' +
    'Sygnały obrotu to wskazówki do sprawdzenia, nie zarzut.',
};

/** Publikacja w postaci potrzebnej do oceny sygnałów. */
export interface SignalInput {
  text: string;
  title?: string;
  author?: string;
  url?: string;
  profile?: ProfileAttributes;
}

/** Małe litery bez polskich znaków, z zachowaniem długości — pozycje odpowiadają oryginałowi. */
const fold = (text: string): string =>
  text
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Wzorzec dla listy fraz: całe słowa; gwiazdka na końcu frazy dopuszcza dowolne zakończenie wyrazu. */
function phrasePattern(phrases: string[]): RegExp {
  const parts = phrases.map((phrase) => {
    const folded = fold(phrase.normalize('NFC'));
    return folded.endsWith('*') ? `${escape(folded.slice(0, -1))}[a-z0-9]*` : `${escape(folded)}(?![a-z0-9])`;
  });
  return new RegExp(`(?<![a-z0-9])(?:${parts.join('|')})`, 'u');
}

const PATTERNS = {
  currency: phrasePattern(CONFIG.polish.currency),
  blik: phrasePattern(CONFIG.polish.blik),
  phoneTransfer: phrasePattern(CONFIG.polish.phoneTransfer),
  bank: phrasePattern(CONFIG.polish.banks),
  cryptoExchange: phrasePattern(CONFIG.polish.cryptoExchanges),
  place: phrasePattern(CONFIG.polish.places),
  country: phrasePattern(CONFIG.polish.country),
  polishService: phrasePattern(CONFIG.polish.services),
  tradeVerb: phrasePattern(CONFIG.suspicion.tradeVerbs),
  cryptoTerm: phrasePattern(CONFIG.suspicion.cryptoTerms),
  cashOrInPerson: phrasePattern(CONFIG.suspicion.cashOrInPerson),
  noKyc: phrasePattern(CONFIG.suspicion.noKyc),
  regularActivity: phrasePattern(CONFIG.suspicion.regularActivity),
  cryptoPayments: phrasePattern(CONFIG.suspicion.cryptoPayments),
  payoutToAccount: phrasePattern(CONFIG.suspicion.payoutToAccount),
  depositAddressRequest: phrasePattern(CONFIG.suspicion.depositAddressRequest),
  ownership: phrasePattern(CONFIG.ownership.phrases),
};

/** W jakiej odległości (w znakach) za formą ofertową musi stać nazwa kryptowaluty. */
const TRADE_WINDOW = 40;

const NEWS_SOURCES = new Set(CONFIG.news.sourceIds);
const GOVERNANCE_HOSTS = CONFIG.governance.hostPatterns.map((pattern) => new RegExp(pattern, 'i'));

/** Kanał wiadomości z jawnej listy — jego publikacje to artykuły redakcyjne, nie oferty osób. */
export const isNewsSource = (connectorId: string): boolean => NEWS_SOURCES.has(connectorId);

/** Forum zarządzania protokołem lub DAO: adresy w postach to zwykle kontrakty i multisigi. */
export const isGovernanceForum = (service: string, connectorId = ''): boolean =>
  CONFIG.governance.connectorPrefixes.some((prefix) => connectorId.startsWith(prefix)) || GOVERNANCE_HOSTS.some((pattern) => pattern.test(service));

/** W jakiej odległości (w znakach) przed adresem musi stać zwrot wskazujący, że to adres autora. */
const OWNERSHIP_WINDOW = 120;

/**
 * Czy autor podaje adres jako WŁASNY: zwrot typu „mój adres”, „wpłaty na”, „donate” tuż przed adresem.
 * Zwraca cytat albo `undefined`. To reguła zastępcza — gdy działa model językowy, rozstrzyga jego odczyt.
 */
export function ownershipClaim(text: string, addresses: string[]): string | undefined {
  const original = text.normalize('NFC');
  const folded = fold(original);
  for (const address of addresses) {
    const at = original.indexOf(address);
    if (at < 0) continue;
    const start = Math.max(0, at - OWNERSHIP_WINDOW);
    const hit = PATTERNS.ownership.exec(folded.slice(start, at));
    if (hit) return quote(original, start + hit.index, hit[0].length + Math.min(OWNERSHIP_WINDOW, at - start - hit.index));
  }
  return undefined;
}

/**
 * Oferta kupna, sprzedaży lub wymiany kryptowaluty: forma ofertowa („sprzedam”, „kupię”, „selling”),
 * po której zaraz stoi nazwa kryptowaluty. Rzeczowniki z artykułów („sprzedaż kryptowalut”) ani
 * ogłoszenie o sprzęcie z dopiskiem o kopaniu ofertą nie są. Zwraca cytat i pozycję w treści.
 */
export function tradeOfferAt(doc: SignalInput): { quote: string; index: number } | undefined {
  const original = bodyOf(doc);
  const folded = fold(original);
  for (const verb of folded.matchAll(new RegExp(PATTERNS.tradeVerb.source, 'gu'))) {
    const end = verb.index + verb[0].length;
    if (PATTERNS.cryptoTerm.test(folded.slice(end, end + TRADE_WINDOW))) return { quote: quote(original, verb.index, verb[0].length), index: verb.index };
  }
  return undefined;
}

export const tradeOffer = (doc: SignalInput): string | undefined => tradeOfferAt(doc)?.quote;

/** Czy podana nazwa aktywa (np. z odczytu modelu) jest kryptowalutą z listy — „karta graficzna” nią nie jest. */
export const isCryptoAsset = (asset: string | undefined): boolean => asset !== undefined && PATTERNS.cryptoTerm.test(fold(asset.normalize('NFC')));

const POLISH_WORDS = new Set(CONFIG.language.polishWords.map((word) => word.normalize('NFC').toLowerCase()));
const ENGLISH_WORDS = new Set(CONFIG.language.englishWords);
const FIRST_NAMES = new Set(CONFIG.polish.firstNames.map(fold));

/** Fragment oryginalnego tekstu wokół trafienia — do zacytowania w przesłance. */
function quote(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** Pierwsze wystąpienie wzorca w tekście: cytat z oryginału. */
function find(pattern: RegExp, original: string, folded: string): string | undefined {
  const hit = pattern.exec(folded);
  return hit ? quote(original, hit.index, hit[0].length) : undefined;
}

export interface LanguageGuess {
  /** `pl`, `en` albo `und`, gdy tekst jest za krótki lub niejednoznaczny. */
  language: 'pl' | 'en' | 'und';
  polishWords: number;
  englishWords: number;
  diacritics: number;
}

/**
 * Prosty detektor języka: polskie znaki diakrytyczne i częste polskie słowa funkcyjne
 * przeciw częstym słowom angielskim. Nie rozpoznaje innych języków — zwraca wtedy `und`.
 */
export function detectLanguage(text: string): LanguageGuess {
  const words = text.normalize('NFC').toLowerCase().match(/\p{L}+/gu) ?? [];
  const polishWords = words.filter((word) => POLISH_WORDS.has(word)).length;
  const englishWords = words.filter((word) => ENGLISH_WORDS.has(word)).length;
  const diacritics = (text.normalize('NFC').match(/[ąćęłńóśźż]/gi) ?? []).length;
  const polish = polishWords + diacritics / 2;
  let language: LanguageGuess['language'] = 'und';
  if (polish >= 2 && polish > englishWords) language = 'pl';
  else if (englishWords >= 2 && englishWords > polish) language = 'en';
  return { language, polishWords, englishWords, diacritics };
}

class Score {
  total = 0;
  reasons: string[] = [];
  add(points: number, reason: string): void {
    this.total += points;
    this.reasons.push(`${reason} (+${points})`);
  }
  result(): ScoredSignal {
    return { score: Math.min(100, this.total), reasons: this.reasons };
  }
}

const bodyOf = (doc: SignalInput): string => [doc.title ?? '', doc.text, doc.profile?.bio ?? ''].join('\n').normalize('NFC');

/**
 * Związek publikacji z Polską, 0–100. Tekst po angielsku z polskimi sygnałami (BLIK, miasto,
 * złotówki) też daje wysoki wynik — chodzi o osobę, nie o język.
 */
export function polishNexus(doc: SignalInput): ScoredSignal & { language: LanguageGuess['language'] } {
  const weights = CONFIG.polishWeights;
  const original = bodyOf(doc);
  const folded = fold(original);
  const score = new Score();
  const guess = detectLanguage(original);

  if (guess.language === 'pl') {
    score.add(weights.language!, `Treść po polsku (polskie słowa funkcyjne: ${guess.polishWords}, znaki diakrytyczne: ${guess.diacritics})`);
  }
  const phrase = (key: keyof typeof PATTERNS, weight: string, label: string) => {
    const hit = find(PATTERNS[key], original, folded);
    if (hit) score.add(weights[weight]!, `${label}: „${hit}”`);
  };
  phrase('currency', 'currency', 'Polska waluta');
  phrase('blik', 'blik', 'BLIK');
  phrase('phoneTransfer', 'phoneTransfer', 'Przelew na telefon');
  phrase('bank', 'bank', 'Polski bank lub fintech');
  phrase('cryptoExchange', 'cryptoExchange', 'Polska giełda lub kantor kryptowalut');

  const plus48 = /(?:\+48|0048)[\s-]?\d{3}[\s-]?\d{3}[\s-]?\d{3}(?!\d)/.exec(original);
  const nineDigits = /(?<![\d+])\d{3}[ -]\d{3}[ -]\d{3}(?![\d -])/.exec(original);
  if (plus48) score.add(weights.phonePlus48!, `Numer telefonu z prefiksem +48: „${quote(original, plus48.index, plus48[0].length)}”`);
  else if (nineDigits) score.add(weights.phoneNineDigits!, `Dziewięciocyfrowy numer w polskim układzie: „${quote(original, nineDigits.index, nineDigits[0].length)}”`);

  // Nazwa strefy czasowej „Europe/Warsaw” jest osobnym sygnałem — nie liczymy jej drugi raz jako miasta.
  const place = find(PATTERNS.place, original, folded.replace(/europe\/warsaw/g, (zone) => ' '.repeat(zone.length)));
  if (place) score.add(weights.place!, `Polskie miasto lub region: „${place}”`);
  phrase('country', 'country', 'Wzmianka o Polsce');
  phrase('polishService', 'polishService', 'Polski serwis');

  const domain = /(?<![a-z0-9])[a-z0-9][a-z0-9.-]*\.pl(?![a-z0-9])/.exec(folded);
  const ownHost = (() => {
    try {
      return doc.url ? new URL(doc.url).hostname.toLowerCase() : '';
    } catch {
      return '';
    }
  })();
  const profileDomain = [...(doc.profile?.urls ?? []), ...(doc.profile?.emails ?? [])].find((value) => /\.pl(?:[/:?#]|$)/i.test(value));
  if (domain) score.add(weights.domainPl!, `Domena .pl w treści: „${quote(original, domain.index, domain[0].length)}”`);
  else if (ownHost.endsWith('.pl')) score.add(weights.domainPl!, `Publikacja w serwisie z domeny .pl: „${ownHost}”`);
  else if (profileDomain) score.add(weights.domainPl!, `Domena .pl w danych profilu: „${profileDomain}”`);

  const names = [doc.profile?.displayName, doc.author, doc.profile?.handle].filter((value): value is string => Boolean(value));
  const firstName = names.flatMap((value) => fold(value.normalize('NFC')).split(/[^a-z]+/)).find((token) => FIRST_NAMES.has(token));
  if (firstName) score.add(weights.firstName!, `Polskie imię w nazwie autora: „${names.find((value) => fold(value.normalize('NFC')).includes(firstName))}”`);

  const location = doc.profile?.location?.normalize('NFC');
  if (location && (PATTERNS.country.test(fold(location)) || PATTERNS.place.test(fold(location)))) {
    score.add(weights.profileLocation!, `Lokalizacja profilu: „${location}”`);
  }
  const marker = CONFIG.polish.timezones.find((value) => [original, location ?? '', doc.profile?.displayName ?? ''].some((part) => part.toLowerCase().includes(value)));
  if (marker) score.add(weights.flagOrTimezone!, `Flaga lub strefa czasowa Polski: „${marker}”`);

  return { ...score.result(), language: guess.language };
}

const UNIT: Record<string, string> = {
  zł: 'PLN', zl: 'PLN', pln: 'PLN', złotych: 'PLN', zlotych: 'PLN',
  usd: 'USD', $: 'USD', eur: 'EUR', '€': 'EUR', euro: 'EUR',
  usdt: 'USDT', usdc: 'USDC', btc: 'BTC', eth: 'ETH',
};
const AMOUNT = /(?<![\w.,])(\$|€)?\s?(\d{1,3}(?:[ . ]\d{3})+|\d+)(?:[.,](\d{1,8}))?\s?(k|tys\.?|mln)?\s?(zł|zl|pln|złotych|zlotych|usd|eur|euro|usdt|usdc|btc|eth)?(?![\p{L}\d])/giu;

interface Amount {
  valuePln: number;
  index: number;
  length: number;
}

/** Kwoty z walutą w tekście, przeliczone orientacyjnie na PLN (wyłącznie do progów). */
function amounts(text: string): Amount[] {
  const found: Amount[] = [];
  for (const hit of text.matchAll(AMOUNT)) {
    const unit = UNIT[(hit[5] ?? hit[1] ?? '').toLowerCase()];
    const rate = unit ? CONFIG.suspicion.amountRatesPln[unit] : undefined;
    if (!rate) continue;
    const scale = hit[4] ? (/^k|^tys/i.test(hit[4]) ? 1_000 : 1_000_000) : 1;
    const number = Number(`${hit[2]!.replace(/[ . ]/g, '')}.${hit[3] ?? '0'}`);
    // „1.500 zł” to tysiąc pięćset; „0.5 BTC” to pół — rozstrzyga grupowanie po trzy cyfry.
    if (Number.isFinite(number) && number > 0) found.push({ valuePln: number * scale * rate, index: hit.index, length: hit[0].length });
  }
  return found;
}

/**
 * Sygnały obrotu kryptowalutami wymagającego uwagi, 0–100. Do sprawdzenia — nie zarzut.
 * Liczą się WYŁĄCZNIE w kontekście kryptowalut: gdy publikacja zawiera ofertę obrotu kryptowalutą
 * albo adres kryptowalutowy (`hasAddress`). Gotówka, odbiór osobisty czy kwota w ogłoszeniu
 * o komputerze nie są sygnałem; sama wzmianka słowa „bitcoin” też nie.
 */
export function suspicion(doc: SignalInput, context: { hasAddress?: boolean } = {}): ScoredSignal {
  if (!context.hasAddress && tradeOffer(doc) === undefined) return { score: 0, reasons: [] };
  const weights = CONFIG.suspicionWeights;
  const original = bodyOf(doc);
  const folded = fold(original);
  const score = new Score();
  const phrase = (key: keyof typeof PATTERNS, weight: string, label: string) => {
    const hit = find(PATTERNS[key], original, folded);
    if (hit) score.add(weights[weight]!, `${label}: „${hit}”`);
  };

  // Oferta to czasownik obrotu z nazwą kryptowaluty tuż obok („sprzedam BTC”), a nie np.
  // sprzedaż sprzętu z dopiskiem o płatności w BTC kilka zdań dalej.
  const offer = tradeOffer(doc);
  if (offer) score.add(weights.tradeOffer!, `Oferta kupna, sprzedaży lub wymiany kryptowalut: „${offer}”`);
  phrase('cashOrInPerson', 'cashOrInPerson', 'Gotówka lub transakcja osobista');

  const largest = amounts(original).sort((a, b) => b.valuePln - a.valuePln)[0];
  if (largest) {
    const cited = quote(original, largest.index, largest.length);
    if (largest.valuePln >= CONFIG.suspicion.amountLargePln) score.add(weights.amountLarge!, `Duża kwota (orientacyjnie od ${CONFIG.suspicion.amountLargePln} zł): „${cited}”`);
    else if (largest.valuePln >= CONFIG.suspicion.amountSignificantPln) score.add(weights.amountSignificant!, `Znaczna kwota (orientacyjnie od ${CONFIG.suspicion.amountSignificantPln} zł): „${cited}”`);
    else score.add(weights.amountMentioned!, `Podana kwota: „${cited}”`);
  }

  phrase('noKyc', 'noKyc', 'Oferta bez weryfikacji tożsamości');
  phrase('regularActivity', 'regularActivity', 'Oznaki stałej działalności');
  phrase('cryptoPayments', 'cryptoPayments', 'Przyjmowanie płatności w kryptowalutach');
  phrase('payoutToAccount', 'payoutToAccount', 'Wypłata na konto lub kartę');
  phrase('depositAddressRequest', 'depositAddressRequest', 'Adres do wpłaty');
  return score.result();
}
