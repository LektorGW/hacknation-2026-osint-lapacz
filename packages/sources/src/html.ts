// Zamiana HTML na tekst i wydobywanie z HTML wskazówek o tożsamości.
// Świadomie bez zewnętrznego parsera: potrzebujemy tylko tekstu, w którym
// `extractAddresses` znajdzie adresy, oraz odnośników do innych profili.

import { addressFromHref } from './address-text.ts';

const BLOCK_TAGS =
  'p|div|section|article|header|footer|main|nav|aside|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|pre|blockquote|form|dl|dt|dd|hr|figure|figcaption|title';

// Znaczniki czysto typograficzne znikają bez śladu (mogą dzielić słowo lub adres),
// pozostałe zamieniamy na odstęp, żeby sąsiednie elementy nie skleiły się w jeden ciąg.
const FORMATTING_TAGS = 'b|i|em|strong|u|s|mark|small|sub|sup|wbr';

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  bdquo: '„',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  oacute: 'ó',
  Oacute: 'Ó',
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (whole, name: string) => NAMED_ENTITIES[name] ?? whole)
    // `&amp;` na końcu, żeby `&amp;lt;` nie zostało zdekodowane dwukrotnie.
    .replace(/&amp;/g, '&');
}

/** Tekst widoczny dla czytelnika strony: bez skryptów i stylów, bloki w osobnych wierszach. */
export function htmlToText(html: string): string {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // Odnośnik płatności (`bitcoin:…`) albo odnośnik do eksploratora bloków niesie adres w atrybucie href —
    // zostawiamy go w tekście, bo widoczny napis to często tylko „wpłać tutaj".
    .replace(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi, (tag, href: string) => {
      const address = addressFromHref(href);
      return address ? `${tag} [adres z odnośnika: ${address}] ` : tag;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(new RegExp(`</?(?:${FORMATTING_TAGS})\\b[^>]*>`, 'gi'), '')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(stripped)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Zwraca właściwą treść dokumentu: pierwszy element <article>, a gdy go nie ma —
 * <main> lub całą stronę. Dzięki temu nawigacja i cudze komentarze pod wpisem
 * nie są przypisywane autorowi dokumentu.
 */
export function extractContent(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  if (article) return article[1]!;
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html);
  return main ? main[1]! : html;
}

/** Odnośniki oznaczone rel="me" — autor deklaruje nimi swoje inne profile. */
export function findRelMeLinks(html: string): string[] {
  const links: string[] = [];
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["'][^"']*\bme\b[^"']*["']/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (href) links.push(decodeEntities(href[1]!));
  }
  return links;
}

export function findEmails(text: string): string[] {
  const found = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(found.map((email) => email.toLowerCase()))];
}

/** Numery telefonów podane jawnie po „tel." / „telefon"; wynik to same cyfry (z prefiksem kraju, jeśli był). */
export function findPhones(text: string): string[] {
  const found: string[] = [];
  const pattern = /(?:\btel\.?|\btelefon)[:\s]*((?:\+\d{2}[\s-]?)?\d{3}[\s-]?\d{3}[\s-]?\d{3})(?!\d)/gi;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) found.push(match[1]!.replace(/[\s-]/g, ''));
  return [...new Set(found)];
}

/** Tytuł strony ze znacznika <title>. */
export function findTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? htmlToText(match[1]!).replace(/\n/g, ' ').trim() : '';
  return title || null;
}

/** Wszystkie adresy z atrybutów href znaczników <a>, w kolejności wystąpienia. */
export function findLinks(html: string): string[] {
  const links: string[] = [];
  for (const tag of html.match(/<a\b[^>]*>/gi) ?? []) {
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag);
    if (href) links.push(decodeEntities(href[1]!));
  }
  return links;
}

/** Wartość `content` znacznika <meta name="…"> lub <meta property="…">. */
export function findMeta(html: string, name: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:name|property)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (key?.toLowerCase() !== name.toLowerCase()) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (content) return decodeEntities(content).trim();
  }
  return null;
}

/**
 * Wnętrze pierwszego (od pozycji `from`) elementu o podanej klasie CSS, z poprawnym
 * domknięciem zagnieżdżonych elementów tego samego rodzaju. `end` wskazuje pozycję za elementem.
 */
export function innerByClass(html: string, className: string, from = 0): { inner: string; end: number } | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const open = new RegExp(`<([a-zA-Z0-9]+)\\b[^>]*\\bclass\\s*=\\s*["'][^"']*(?<![\\w-])${escaped}(?![\\w-])[^"']*["'][^>]*>`, 'g');
  open.lastIndex = from;
  const start = open.exec(html);
  if (!start) return null;
  const tag = start[1]!;
  const contentStart = start.index + start[0].length;
  const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  walker.lastIndex = contentStart;
  let depth = 1;
  for (let step = walker.exec(html); step; step = walker.exec(html)) {
    depth += step[1] ? -1 : 1;
    if (depth === 0) return { inner: html.slice(contentStart, step.index), end: step.index + step[0].length };
  }
  return { inner: html.slice(contentStart), end: html.length };
}
