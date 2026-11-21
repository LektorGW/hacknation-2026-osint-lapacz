// Silnik `html-list`: lista wątków ze zwykłej strony HTML, wskazana selektorami
// z konfiguracji — dla forów bez kanału RSS i bez API. Przed pobraniem strony
// sprawdzany jest robots.txt. Łącznik czyta wyłącznie stronę listy (tytuły,
// autorzy, daty); treści wątków nie pobiera.

import { htmlToText } from '../html.ts';
import { robotsAllows } from '../www.ts';
import { hostOf, normalizedUrl, toIso } from './common.ts';
import type { EngineAdapter, HtmlListSelectors, MonitorPost } from './common.ts';

export interface SelectedElement {
  tag: string;
  /** Znacznik otwierający — z atrybutami. */
  open: string;
  inner: string;
}

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source', 'wbr']);

interface Compound {
  tag?: string;
  classes: string[];
  attributes: { name: string; operator?: string; value?: string }[];
}

/** `a.tytul[href*=topic]` → nazwa znacznika, klasy i warunki na atrybuty. */
function parseCompound(text: string): Compound {
  const compound: Compound = { classes: [], attributes: [] };
  const rest = text.replace(/\[([\w-]+)(?:([*^$]?=)["']?([^"'\]]*)["']?)?\]/g, (_, name: string, operator?: string, value?: string) => {
    compound.attributes.push({ name: name.toLowerCase(), ...(operator ? { operator, value: value ?? '' } : {}) });
    return '';
  });
  const [tag, ...classes] = rest.split('.');
  if (tag && tag !== '*') compound.tag = tag.toLowerCase();
  compound.classes = classes.filter(Boolean);
  return compound;
}

export function attributeOf(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(openTag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value?.replace(/&amp;/g, '&');
}

function matches(tag: string, openTag: string, compound: Compound): boolean {
  if (compound.tag && compound.tag !== tag) return false;
  if (compound.classes.length > 0) {
    const classes = (attributeOf(openTag, 'class') ?? '').split(/\s+/);
    if (!compound.classes.every((name) => classes.includes(name))) return false;
  }
  return compound.attributes.every(({ name, operator, value }) => {
    const actual = attributeOf(openTag, name);
    if (actual === undefined) return false;
    if (!operator) return true;
    if (operator === '=') return actual === value;
    if (operator === '*=') return actual.includes(value!);
    if (operator === '^=') return actual.startsWith(value!);
    return actual.endsWith(value!);
  });
}

/**
 * Elementy pasujące do selektora. Obsługiwane: `tag`, `.klasa`, `tag.klasa`, `[atr]`,
 * `[atr=…]`, `[atr*=…]`, `[atr^=…]`, `[atr$=…]` oraz spacja (potomek). To celowo mały
 * podzbiór CSS — wystarcza do wskazania wiersza listy, odnośnika, autora i daty.
 */
export function selectAll(html: string, selector: string): SelectedElement[] {
  const [first, ...rest] = selector.trim().split(/\s+/);
  if (!first) return [];
  const compound = parseCompound(first);
  const found: SelectedElement[] = [];
  const opener = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    const tag = match[1]!.toLowerCase();
    if (!matches(tag, match[0], compound)) continue;
    const start = match.index + match[0].length;
    let inner = '';
    if (!VOID_TAGS.has(tag) && !match[0].endsWith('/>')) {
      const walker = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
      walker.lastIndex = start;
      let depth = 1;
      let end = html.length;
      for (let step = walker.exec(html); step; step = walker.exec(html)) {
        depth += step[1] ? -1 : 1;
        if (depth === 0) {
          end = step.index;
          break;
        }
      }
      inner = html.slice(start, end);
    }
    found.push({ tag, open: match[0], inner });
  }
  if (rest.length === 0) return found;
  return found.flatMap((element) => selectAll(element.inner, rest.join(' ')));
}

/** Data z tekstu komórki listy, np. „April 13, 2026, 07:18:30 AM by ktoś" (czas forum przyjmujemy jako UTC). */
export function looseDate(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const direct = toIso(text);
  if (direct) return direct;
  const match = /([A-Z][a-z]+ \d{1,2}, \d{4}),? (\d{1,2}:\d{2}(?::\d{2})?(?: ?[AP]M)?)/.exec(text) ?? /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(text);
  return match ? toIso(`${match[1]} ${match[2]} UTC`) : undefined;
}

/** Reguły robots.txt pamiętane na hosta — kilkanaście działów jednego forum to jedno pobranie pliku. */
const ROBOTS_TTL_MS = 6 * 60 * 60 * 1000;
const robotsCache = new Map<string, { at: number; text: string | null }>();

const textOf = (element: SelectedElement | undefined): string => htmlToText(element?.inner ?? '').replace(/\n/g, ' ').trim();

/** Rozbiera stronę listy wątków według selektorów źródła. */
export function parseHtmlList(html: string, pageUrl: string, selectors: HtmlListSelectors): MonitorPost[] {
  const posts: MonitorPost[] = [];
  const seen = new Set<string>();
  for (const item of selectAll(html, selectors.item)) {
    const link = selectAll(item.inner, selectors.link).find((element) => attributeOf(element.open, 'href'));
    const href = link ? attributeOf(link.open, 'href') : undefined;
    const title = textOf(link);
    if (!href || !title) continue;
    let url: string;
    try {
      url = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url) || seen.has(url)) continue;
    seen.add(url);

    const authorElement = selectors.author ? selectAll(item.inner, selectors.author)[0] : undefined;
    const author = textOf(authorElement) || undefined;
    const authorHref = authorElement ? attributeOf(authorElement.open, 'href') : undefined;
    const dateElement = selectors.date ? selectAll(item.inner, selectors.date)[0] : undefined;
    const published = dateElement
      ? looseDate(attributeOf(dateElement.open, 'datetime')) ?? looseDate(attributeOf(dateElement.open, 'title')) ?? looseDate(textOf(dateElement))
      : undefined;
    let profileUrl: string | undefined;
    try {
      profileUrl = authorHref ? new URL(authorHref, pageUrl).toString() : undefined;
    } catch {
      profileUrl = undefined;
    }
    posts.push({
      url,
      title,
      // Lista zawiera tylko tytuły — pełnej treści wątku łącznik nie pobiera.
      text: title,
      service: hostOf(pageUrl),
      ...(author ? { author } : {}),
      ...(published ? { publishedAt: published } : {}),
      ...(author && profileUrl && /^https?:/i.test(profileUrl) ? { profile: { urls: [profileUrl] } } : {}),
    });
  }
  return posts;
}

export const htmlListEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Lista wątków ze strony ${source.url} (HTML): po sprawdzeniu robots.txt odczytywane są tytuły, odnośniki, autorzy i daty wskazane selektorami ` +
    `z konfiguracji (element: „${source.selectors?.item}", odnośnik: „${source.selectors?.link}"). Treść wątków nie jest pobierana. Jedno żądanie na przebieg (robots.txt raz na 6 godzin na host).`,
  service: (source) => hostOf(source.url),
  problem: (source) => (!source.url || !hostOf(source.url) ? 'brak pola „url"' : !source.selectors?.item || !source.selectors.link ? 'brak selektorów „item" i „link"' : null),
  requestHost: (source) => hostOf(source.url),
  addressKey: (source) => normalizedUrl(source.url),

  async discover(run) {
    const url = new URL(run.source.url!);
    const options = { minIntervalMs: run.intervalMs, publicOnly: true } as const;
    const cached = robotsCache.get(url.origin);
    let rules: string | null;
    if (cached && Date.now() - cached.at < ROBOTS_TTL_MS) {
      rules = cached.text;
    } else {
      const robots = await run.session.get(`${url.origin}/robots.txt`, { ...options, quietMissing: true, maxBytes: 200_000 });
      // Odmowa, błąd serwera lub brak połączenia: nie wiemy, czy wolno — nie pobieramy (i nie zapamiętujemy).
      if (!robots && (run.session.refused || run.session.lastStatus === 0 || run.session.lastStatus >= 500)) return [];
      // Odpowiedź HTML pod /robots.txt to strona błędu, nie reguły; brak pliku oznacza brak ograniczeń.
      rules = robots && robots.contentType !== 'text/html' ? robots.text : null;
      robotsCache.set(url.origin, { at: Date.now(), text: rules });
    }
    if (rules !== null && !robotsAllows(rules, `${url.pathname}${url.search}`)) {
      run.context.log(`${run.source.label}: robots.txt nie pozwala na pobranie ${url.pathname}${url.search} — źródło pominięte.`);
      return [];
    }
    const page = await run.session.get(url.toString(), { ...options, allowedContentTypes: ['text/html', 'application/xhtml+xml'] });
    return page ? parseHtmlList(page.text, page.url, run.source.selectors!) : [];
  },
};
