// Programowa weryfikacja odpowiedzi modelu — ochrona przed zmyśleniami.
// Model może się mylić albo zostać zmanipulowany treścią publikacji, dlatego wszystko,
// co da się sprawdzić z tekstem źródłowym, jest sprawdzane tutaj, zwykłym kodem.

/** Wycina obiekt JSON z odpowiedzi: znosi otoczkę tekstu, blok kodu i znaczniki `<think>`. */
export function extractJson(raw: string): Record<string, unknown> | undefined {
  const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, ' ').trim();
  const asObject = (candidate: string): Record<string, unknown> | undefined => {
    try {
      const value: unknown = JSON.parse(candidate);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = asObject(text);
  if (direct) return direct;
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index]!;
      if (inString) {
        if (char === '\\') index += 1;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const found = asObject(text.slice(start, index + 1));
          if (found) return found;
          break;
        }
      }
    }
  }
  return undefined;
}

/** NFC i pojedyncze spacje — jedyna dopuszczona różnica między cytatem a treścią. */
export const normalizeWhitespace = (text: string): string => text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** Małe litery bez znaków diakrytycznych — do porównywania nazw miejscowości. */
export const fold = (text: string): string =>
  text
    .replace(/[łŁ]/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Najkrótszy cytat uznawany za znaczący (krótszy pasowałby do niemal każdej treści). */
export const MIN_QUOTE_CHARS = 12;

/**
 * Czy cytat występuje dosłownie w którymś ze źródeł (po normalizacji białych znaków).
 * Zwraca cytat w postaci znormalizowanej albo `undefined`.
 */
export function verifyQuote(quote: unknown, sources: string[]): string | undefined {
  if (typeof quote !== 'string') return undefined;
  // Model bywa skłonny objąć cytat cudzysłowem lub wielokropkiem — to nie jest część treści.
  const candidates = [quote, quote.replace(/^[\s"'„”«»…]+|[\s"'„”«»…]+$/g, '').replace(/^\.{3}|\.{3}$/g, '')].map(normalizeWhitespace);
  const haystacks = sources.map(normalizeWhitespace);
  const longest = Math.max(0, ...haystacks.map((source) => source.length));
  for (const candidate of candidates) {
    if (candidate.length < Math.min(MIN_QUOTE_CHARS, longest)) continue;
    if (candidate.length > 0 && haystacks.some((source) => source.includes(candidate))) return candidate;
  }
  return undefined;
}

// ---------- Liczby ----------

const ADDRESS_LIKE = /0x[0-9a-fA-F]{6,}|(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,90}\d)(?=[A-Za-z0-9]{0,90}[A-Za-z])[A-Za-z0-9]{20,}/g;
const SHORTENED_ADDRESS = /([A-Za-z0-9]{4,})(?:…|\.{3})([A-Za-z0-9]{4,})/g;
const NUMBER = /(?<![\p{L}\p{N}_])\d+(?:[   ']\d{3})*(?:[.,]\d+)*/gu;
const SCALE = /^[  ]?(k|tys|tyś|тыс|thousand|mln|млн|million)(?![\p{L}])/iu;

const key = (value: number): string => String(Number(value.toPrecision(12)));

/** Możliwe odczyty zapisu bez spacji: „1.500” to 1500 albo 1,5; „12,5” to 12,5; „12.03.2025” to 12, 3 i 2025. */
function readings(piece: string): number[] {
  const separators = [...piece.matchAll(/[.,]/g)];
  if (separators.length === 0) return [Number(piece)];
  const groups = piece.split(/[.,]/);
  const digits = Number(groups.join(''));
  const grouped = groups[0]!.length <= 3 && groups[0] !== '0' && groups.slice(1).every((group) => group.length === 3);
  const last = separators[separators.length - 1]!.index;
  const decimal = Number(`${piece.slice(0, last).replace(/[.,]/g, '')}.${piece.slice(last + 1)}`);
  if (separators.length === 1) return grouped ? [digits, decimal] : [decimal];
  if (new Set(separators.map((hit) => hit[0])).size === 1) return grouped ? [digits] : groups.map(Number);
  return [decimal];
}

interface NumberToken {
  raw: string;
  /** Odczyty całego zapisu (ze spacjami jako separatorem tysięcy), także po przemnożeniu przez „tys.”/„mln”. */
  whole: number[];
  /** Odczyty każdego członu oddzielonego spacją osobno („2024 100” to dwie liczby). */
  parts: number[][];
}

function numberTokens(text: string): NumberToken[] {
  // Cyfry wewnątrz adresów (także skróconych „0x12ab…cd34”) nie są liczbami.
  const cleaned = text.replace(SHORTENED_ADDRESS, ' ').replace(ADDRESS_LIKE, ' ');
  const tokens: NumberToken[] = [];
  for (const hit of cleaned.matchAll(NUMBER)) {
    const raw = hit[0];
    const scale = SCALE.exec(cleaned.slice(hit.index + raw.length));
    const factor = scale ? (/^(k|tys|tyś|тыс|thousand)$/i.test(scale[1]!) ? 1_000 : 1_000_000) : 1;
    const widen = (values: number[]) => (factor === 1 ? values : [...values, ...values.map((value) => value * factor)]);
    const pieces = raw.split(/[   ']/);
    tokens.push({
      raw,
      whole: widen(readings(pieces.join(''))),
      parts: pieces.map((piece) => widen(readings(piece))),
    });
  }
  return tokens;
}

/** Zbiór wszystkich liczb, jakie da się odczytać z tekstu. */
function numberSet(text: string): Set<string> {
  const found = new Set<string>();
  for (const token of numberTokens(text)) {
    for (const value of [...token.whole, ...token.parts.flat()]) if (Number.isFinite(value)) found.add(key(value));
  }
  return found;
}

/** Czy kwota podana przez model występuje w którymś ze źródeł. */
export function amountInText(amount: number, sources: string[]): boolean {
  return Number.isFinite(amount) && numberSet(sources.join('\n')).has(key(amount));
}

/** Czy miejscowość występuje w źródłach — z tolerancją na odmianę („Kraków” ↔ „w Krakowie”). */
export function locationInText(location: string, sources: string[]): boolean {
  const words = fold(location).match(/[\p{L}]{3,}/gu) ?? [];
  if (words.length === 0) return false;
  const haystack = fold(sources.join('\n'));
  return words.every((word) => {
    const stem = word.length >= 6 ? word.slice(0, -2) : word.length >= 4 ? word.slice(0, -1) : word;
    return new RegExp(`(?<![\\p{L}])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u').test(haystack);
  });
}

/**
 * Liczby i adresy obecne w streszczeniu, a nieobecne w faktach. Pusta lista = streszczenie
 * nie wnosi żadnej liczby (kwoty, procentu, roku) ani adresu spoza faktów.
 */
export function unsupportedInSummary(summary: string, facts: string[]): string[] {
  const source = facts.join('\n');
  const problems: string[] = [];
  for (const hit of summary.matchAll(ADDRESS_LIKE)) if (!source.includes(hit[0])) problems.push(hit[0]);
  for (const hit of summary.matchAll(SHORTENED_ADDRESS)) {
    if (!source.includes(hit[1]!) || !source.includes(hit[2]!)) problems.push(hit[0]);
  }
  const known = numberSet(source);
  for (const token of numberTokens(summary)) {
    const whole = token.whole.some((value) => known.has(key(value)));
    const parts = token.parts.every((values) => values.some((value) => known.has(key(value))));
    if (!whole && !parts) problems.push(token.raw);
  }
  return problems;
}
