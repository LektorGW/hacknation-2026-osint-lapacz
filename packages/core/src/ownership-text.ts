// Deklaracja własności adresu w treści wypowiedzi — reguła tekstowa, bez modelu językowego.
//
// Wpis na forum to zwykle tylko wzmianka o adresie. Wyjątek: autor w pierwszej osobie podaje adres
// jako SWÓJ („mój adres”, „wpłaty na”, „przyjmuję na adres”, „my wallet”, podpis „BTC: …”).
// Reguła jest celowo ostrożna: ostrzeżenie, pytanie o właściciela, rozdanie, cytat cudzej wypowiedzi,
// przeczenie („to nie mój adres”) albo opis własnej wpłaty („wysłałem na”) WYKLUCZAJĄ deklarację.
// Ma niższą moc niż jawna kategoria źródła (profil, oferta, dowód) i niż odczyt modelu językowego:
// nigdy nie podnosi kategorii publikacji — wpis liczy się z wagą wypowiedzi na forum.

/** Nazwa reguły w księdze Wskaźnika Pewności i w uwagach do adresu. */
export const TEXT_OWNERSHIP_RULE = 'deklaracja własności w treści (reguła tekstowa)';

export interface OwnershipDeclaration {
  /** `declares` — autor podaje adres jako własny; `excluded` — kontekst wyklucza własność; `none` — brak deklaracji. */
  verdict: 'declares' | 'excluded' | 'none';
  /** Opis, która część reguły rozstrzygnęła (dla analityka). */
  reason: string;
  /** Fragment treści, na którym oparto werdykt (oryginalna pisownia). */
  quote?: string;
}

/** Podstawa własności przypisana śladowi przez regułę tekstową (pole poza kategorią źródła). */
export interface OwnershipBasis {
  rule: 'text_declaration';
  /** Fragment treści z deklaracją. */
  quote: string;
}

const MAX_PREFIX = 160;
const MAX_SUFFIX = 80;
const MAX_QUOTE_SPAN = 400;
const ADDRESS_TOKEN = ' adresx ';

/** Małe litery bez znaków diakrytycznych, z zachowaniem długości (indeksy wskazują ten sam znak w oryginale). */
export function foldPreservingLength(text: string): string {
  let result = '';
  for (const char of text) {
    const lower = char.toLowerCase();
    let folded = lower.length === 1 ? lower : char;
    if (folded === 'ł') folded = 'l';
    else if (folded === '’' || folded === '‘' || folded === '`') folded = "'";
    else {
      const base = folded.normalize('NFD')[0];
      if (base) folded = base;
    }
    // Znaki spoza BMP zajmują dwie jednostki kodu — wypełniamy, by długość się zgadzała.
    result += char.length === 2 ? `${folded[0] ?? ' '} ` : (folded[0] ?? ' ');
  }
  return result;
}

/** Kontekst całej wypowiedzi, który wyklucza deklarację własności (ostrzeżenie, pytanie, rozdanie). */
const GLOBAL_EXCLUSIONS: { label: string; pattern: RegExp }[] = [
  { label: 'kontekst rozdania lub „podwajania” wpłat (giveaway, airdrop)', pattern: /\b(giveaway|give away|airdrop|rozdani\w*|podwaj\w*|double your|x2\b|2x\b)/ },
  {
    label: 'ostrzeżenie przed oszustwem lub zgłoszenie adresu',
    pattern:
      /\b(scam\w*|oszus\w*|oszuk\w*|naciag\w*|wyludz\w*|phishing|fake|falszyw\w*|podrob\w*|podszyw\w*|ostrzega\w*|ostrzezeni\w*|uwaga na|uwazajcie|beware|warning|zglaszam|zgloszeni\w*|reported|stolen|skradzion\w*|ukradzion\w*|kradziez\w*|hack\w*|haker\w*|ransom\w*|okup\w*|szantaz\w*|extort\w*)/,
  },
  {
    label: 'apel, by nie wpłacać na adres',
    pattern: /\b(nie\s+(wplacaj\w*|wysylaj\w*|przelewaj\w*|placcie|placic|wysylac|wplacac)|do not (send|pay)|don'?t (send|pay))\b/,
  },
  {
    label: 'pytanie o właściciela adresu',
    pattern: /\b(ktos zna|ktos wie|ktos kojarzy|ktos widzial|czy ktos|czyj (to|jest)|czyje to|do kogo nalezy|whose (address|wallet)|who owns|anyone know)/,
  },
];

/**
 * Wzorce kontekstu rozdania, ostrzeżenia i apelu „nie wpłacajcie” (na tekście po `foldPreservingLength`) —
 * te same, które wykluczają deklarację własności; korzysta z nich moduł ostrzeżeń o oszustwach (apps/api/src/scam.ts).
 */
export const SCAM_CONTEXT_PATTERNS = {
  giveaway: GLOBAL_EXCLUSIONS[0]!.pattern,
  warning: GLOBAL_EXCLUSIONS[1]!.pattern,
  doNotPay: GLOBAL_EXCLUSIONS[2]!.pattern,
} as const;

/** Kontekst przy adresie, który wskazuje cudzy adres albo przeczy własności. */
const LOCAL_EXCLUSIONS: { label: string; pattern: RegExp }[] = [
  { label: 'przeczenie („to nie mój adres”)', pattern: /\bnie\s+(jest\s+)?(moj|moja|moje|moim|moich|mojego|swoj|swoim)\b|\b(not|isn'?t|is not)\s+(my|mine)\b|\bnot mine\b/ },
  {
    label: 'adres innej osoby („jego / twój / sprzedawcy adres”)',
    pattern:
      /\b(jego|jej|ich|twoj\w*|wasz\w*|tego goscia|tej osoby|kolegi|znajomego|sprzedawcy|sprzedajacego|oszusta|klienta|his|her|their|your)\s+(\w+\s+)?(adres\w*|portfel\w*|wallet|address|konto)\b|\b(adres\w*|portfel\w*|konto)\s+(tego\s+|tej\s+)?(jego|jej|ich|sprzedawcy|sprzedajacego|kupujacego|oszusta|kolegi|znajomego|goscia|klienta|gieldy|kantoru|serwisu|fundacji|zbiorki)\b/,
  },
  {
    label: 'opis własnej wpłaty na ten adres (adres odbiorcy, nie autora)',
    pattern: /\b(wyslal|wyslala|wyslali|wplacil|wplacila|wplacili|przelal|przelala|przelali|zaplacil|zaplacila|zaplacili|ukradl|ukradla|ukradli|i sent|i paid|sent to|paid to|we sent)\w*/,
  },
  // „podaje” pomijamy: bez znaków diakrytycznych to także „podaję” (pierwsza osoba).
  { label: 'adres podany przez kogoś innego („podał adres”)', pattern: /\b(podal|podala|podali|podaja|wkleil|wkleila|wkleili|wkleja|wklejaja)\b/ },
];

/** Wymaga zaimka pierwszej osoby w tym samym zdaniu (słowa wieloznaczne: napiwki, „send to”). Polskie „i” to spójnik — pomijamy. */
const FIRST_PERSON = /\b(mnie|mi|moj\w*|moim|moich|swoj\w*|ja|my|me|mine|i'm|i am|i'll|i've|we|our)\b/;

const DECLARATIONS: { label: string; pattern: RegExp; firstPerson?: boolean }[] = [
  {
    label: '„mój adres / portfel”',
    pattern: /\b(moj|moja|moje|mojego|moim|moich|swoj|swoja|swoim|swojego)\s+(\w+\s+){0,2}?(adres\w*|portfel\w*|wallet|konto|profil\w*)\b/,
  },
  { label: '„na mój / na swój”', pattern: /\bna\s+(moj|swoj)\b/ },
  { label: '„adres do wpłaty”', pattern: /\badres\w*\s+do\s+(wplat\w*|platnos\w*|przelew\w*|wsparcia|darowizn\w*|napiwk\w*|rozliczen\w*)/ },
  { label: '„wpłaty na”', pattern: /\b(wplaty|wplata|wplacajcie|wplacaj|wplacac|przedplaty|przedplata|zadatek|zadatku)\b[^.!?\n]{0,40}(\bna\b|:)/ },
  { label: '„płatność na”', pattern: /\b(platnosc\w*|placcie|oplat\w*)\b[^.!?\n]{0,40}(\bna\b|:)/ },
  { label: '„przelej na”', pattern: /\b(przelej|przelejcie|przelewajcie|wyslij|wyslijcie|wysylajcie)\s+(mi\s+)?(\w+\s+){0,3}?na\b/ },
  { label: '„zbieram / przyjmujemy / akceptujemy”', pattern: /\b(zbieram|przyjmujemy|akceptujemy)\b/ },
  { label: '„klienci płacą / płacą mi”', pattern: /\b(klienci|klientow|uczniowie|kupujacy|zamawiajacy)\b[^.!?\n]{0,30}\b(placa|wplacaja|przelewaja|placic|wplacac)\b|\bplac(a|i)\s+mi\b/ },
  { label: '„można (mi) płacić”', pattern: /\b(mozna|mozecie|moga|mozesz)\s+(mi\s+|u\s+mnie\s+)?(placic|zaplacic|wplacac|wplacic|przelac|przelewac|wniesc|wyslac)\b/ },
  { label: '„rozliczenia ze mną”', pattern: /\b(rozliczenia|rozliczam|rozliczamy)\b[^.!?\n]{0,30}\b(ze\s+mna|sie|na)\b/ },
  {
    label: 'napiwki / darowizny / wsparcie (z zaimkiem pierwszej osoby)',
    pattern: /\b(napiwk\w*|darowizn\w*|donacj\w*|wsparcie|wesprzyj\w*|wesprzec|wspomoz\w*|postaw\w*\s+mi\s+kawe|donate|donations?|tips?|tip jar|support me|buy me a coffee|sponsor\w*)\b/,
    firstPerson: true,
  },
  { label: '„my address / my wallet”', pattern: /\bmy\s+(\w+\s+){0,2}?(address|addy|wallet)\b/ },
  { label: '„send / pay me”', pattern: /\b(send|pay|tip|donate)\s+(it\s+|them\s+|funds\s+|payment\s+|crypto\s+)?(to\s+)?me\b|\bpay(ments?)?\s+(me|to me|accepted)\b/ },
  { label: '„you can pay”', pattern: /\b(you can|you may|feel free to)\s+(pay|send|donate|tip)\b/ },
  { label: '„I accept / we accept”', pattern: /\b(i|we)\s+(accept|take|receive)\b/ },
  { label: '„send to” (z zaimkiem pierwszej osoby)', pattern: /\bsend\s+(\w+\s+){0,2}?to\b/, firstPerson: true },
];

/** Słowa z „ę”, których forma bez znaków diakrytycznych jest wieloznaczna (przyjmuję ≠ przyjmuje). */
const RAW_DECLARATIONS: { label: string; pattern: RegExp }[] = [{ label: '„przyjmuję / akceptuję”', pattern: /(?<![\p{L}])(przyjmuję|akceptuję)(?![\p{L}])/u }];

/** Etykieta wiersza „BTC: <adres>” — tickery tylko w podpisie, słowa płatności w całej wypowiedzi. */
const TICKER_LABEL = /^\s*(btc|eth|usdt|usdc|trx|ltc|xmr|doge|bitcoin|ethereum|tron|litecoin|monero)(\s*[\/(]?\s*(erc-?20|trc-?20|bep-?20|tron|ethereum|bsc|eth|btc|usdt)\s*\)?)*\s*$/;
const PAYMENT_LABEL = /\b(wplaty|wplata|platnosci|platnosc|napiwki|napiwek|darowizny|donate|donations|tips|wsparcie|zadatek|przedplaty)\b/;
/** Etykieta płatności poza podpisem: krótka i bez wskazania cudzego celu („wsparcie dla fundacji: …”). */
const FOREIGN_PURPOSE = /\b(dla|for|na rzecz)\b/;
const shortPaymentLabel = (label: string) => label.trim().split(/\s+/).length <= 3;

const QUOTE_PAIRS: Record<string, string[]> = { '„': ['”', '"', '“'], '“': ['”'], '"': ['"'], '«': ['»'], '»': ['«'] };

/** Zakresy cudzych słów: cytaty w cudzysłowie, wiersze „> …”, bloki po „Cytat:” / „… napisał:”. */
function quotedSpans(folded: string, address: string): boolean[] {
  const quoted = new Array<boolean>(folded.length).fill(false);
  const mark = (from: number, to: number) => {
    for (let index = Math.max(0, from); index < Math.min(folded.length, to); index++) quoted[index] = true;
  };
  // Cudzysłowy: cytat, gdy w środku jest coś więcej niż sam adres (adres w cudzysłowie to tylko zapis).
  for (let index = 0; index < folded.length; index++) {
    const closers = QUOTE_PAIRS[folded[index]!];
    if (!closers) continue;
    let end = -1;
    for (let at = index + 1; at < Math.min(folded.length, index + MAX_QUOTE_SPAN); at++) {
      if (closers.includes(folded[at]!)) {
        end = at;
        break;
      }
    }
    if (end < 0) continue;
    const inside = folded.slice(index + 1, end).split(address).join(' ');
    if ((inside.match(/\p{L}/gu) ?? []).length >= 3) mark(index, end + 1);
    index = end;
  }
  // Bloki cytatu w wierszach.
  const lines = folded.split('\n');
  let offset = 0;
  let inBlock = false;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    if (line.trim() === '') {
      inBlock = false;
      continue;
    }
    if (inBlock || /^\s*>/.test(line) || /^\s*(cytat|quote|cytuje)\b/.test(line)) {
      mark(start, start + line.length);
      if (/^\s*(cytat|quote|cytuje)\b/.test(line)) inBlock = true;
      continue;
    }
    const said = /(napisal\(a\)|napisala|napisal|wrote|pisze|pisal|pisala)\s*:/.exec(line);
    if (said) {
      mark(start + said.index + said[0].length, start + line.length);
      inBlock = true;
    }
  }
  return quoted;
}

/** Fragment oryginału do pokazania analitykowi (najwyżej ~160 znaków). */
function excerpt(text: string, from: number, to: number): string {
  return text.slice(Math.max(0, from), Math.min(text.length, to)).replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Granica zdania: koniec wiersza, „!” „?” albo kropka przed odstępem (nie kropka w adresie e-mail czy kwocie). */
const lastBoundary = (text: string): number => {
  let found = -1;
  for (const match of text.matchAll(/[!?\n]|\.(?=\s)/g)) found = match.index! + match[0].length;
  return found;
};

/**
 * Czy autor wypowiedzi podaje `address` jako własny. Wynik `declares` tylko wtedy, gdy przy którymś
 * wystąpieniu adresu poza cytatem stoi deklaracja w pierwszej osobie, a nic w wypowiedzi jej nie wyklucza.
 */
export function detectOwnershipDeclaration(text: string, address: string): OwnershipDeclaration {
  const folded = foldPreservingLength(text);
  const needle = address.trim().toLowerCase();
  if (!needle) return { verdict: 'none', reason: 'brak adresu' };
  const positions: number[] = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) positions.push(at);
  if (positions.length === 0) return { verdict: 'none', reason: 'adresu nie ma w treści wypowiedzi' };

  for (const { label, pattern } of GLOBAL_EXCLUSIONS) {
    const hit = pattern.exec(folded);
    if (hit) return { verdict: 'excluded', reason: `wykluczone: ${label}`, quote: excerpt(text, hit.index - 60, hit.index + hit[0].length + 60) };
  }

  const quoted = quotedSpans(folded, needle);
  const own = positions.filter((at) => !quoted[at]);
  if (own.length === 0) return { verdict: 'excluded', reason: 'wykluczone: adres występuje tylko w cytacie cudzej wypowiedzi', quote: excerpt(text, positions[0]! - 80, positions[0]! + needle.length + 40) };

  // Tekst autora: cytaty zastąpione odstępami, żeby cudze słowa nie dawały ani deklaracji, ani przeczeń.
  const authored = [...folded].map((char, index) => (quoted[index] && char !== '\n' ? ' ' : char)).join('');
  const rawLower = text.toLowerCase().length === text.length ? text.toLowerCase() : text;
  const lines = authored.split('\n');
  const footerFrom = (() => {
    const delimiter = lines.findLastIndex((line) => /^\s*(--|__|—)\s*$/.test(line) || /^\s*--\s/.test(line));
    const nonEmpty = lines.map((line, index) => (line.trim() ? index : -1)).filter((index) => index >= 0);
    const lastThree = nonEmpty.length > 3 ? nonEmpty[nonEmpty.length - 3]! : 0;
    return delimiter >= 0 ? Math.min(delimiter, lastThree) : lastThree;
  })();
  const lineOf = (at: number) => authored.slice(0, at).split('\n').length - 1;

  let declared: { label: string; from: number; to: number } | undefined;
  for (const at of own) {
    const before = authored.slice(Math.max(0, at - MAX_PREFIX), at);
    const prefix = before.slice(Math.max(0, lastBoundary(before)));
    const after = authored.slice(at + needle.length, at + needle.length + MAX_SUFFIX);
    const stop = after.search(/[!?\n]|\.(?=\s|$)/);
    const suffix = stop >= 0 ? after.slice(0, stop) : after;
    const clause = `${prefix}${ADDRESS_TOKEN}${suffix}`.replace(/\s+/g, ' ');
    const from = at - prefix.length;
    const to = at + needle.length + suffix.length;

    // Przeczenie tuż przed adresem: „mój adres to nie <adres>”.
    if (/\bnie\s*[:,\-–—]?\s*$/.test(prefix)) return { verdict: 'excluded', reason: 'wykluczone: przeczenie tuż przed adresem („… to nie <adres>”)', quote: excerpt(text, from, to) };
    for (const { label, pattern } of LOCAL_EXCLUSIONS) {
      if (pattern.test(clause)) return { verdict: 'excluded', reason: `wykluczone: ${label}`, quote: excerpt(text, from, to) };
    }
    if (declared) continue;

    for (const { label, pattern, firstPerson } of DECLARATIONS) {
      if (pattern.test(clause) && (!firstPerson || FIRST_PERSON.test(clause.replace(ADDRESS_TOKEN, ' ')))) {
        declared = { label, from, to };
        break;
      }
    }
    if (!declared) {
      const rawClause = rawLower.slice(Math.max(0, from), Math.min(rawLower.length, to));
      const raw = RAW_DECLARATIONS.find((item) => item.pattern.test(rawClause));
      if (raw) declared = { label: raw.label, from, to };
    }
    if (!declared) {
      // Wiersz „etykieta: <adres>” — słowa płatności wszędzie, tickery (BTC:, ETH:) tylko w podpisie.
      const index = lineOf(at);
      const line = lines[index] ?? '';
      const labelLine = /^\s*([^:\n]{1,40}):\s*adresx\s*[.,;]?\s*$/.exec(line.replace(needle, 'adresx'));
      if (labelLine) {
        const label = labelLine[1]!;
        const inFooter = index >= footerFrom;
        if (PAYMENT_LABEL.test(label) && !FOREIGN_PURPOSE.test(label) && (inFooter || shortPaymentLabel(label))) declared = { label: `wiersz „${label.trim()}: <adres>”`, from: at - line.indexOf(needle), to: at + needle.length };
        else if (TICKER_LABEL.test(label) && inFooter) declared = { label: `wiersz „${label.trim()}: <adres>” w podpisie wypowiedzi`, from: at - line.indexOf(needle), to: at + needle.length };
      }
    }
  }
  if (!declared) return { verdict: 'none', reason: 'brak deklaracji własności w pierwszej osobie przy adresie' };
  return { verdict: 'declares', reason: `autor podaje adres jako własny: ${declared.label}`, quote: excerpt(text, declared.from, declared.to) };
}
