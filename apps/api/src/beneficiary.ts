// Beneficjent adresu powszechnie cytowanego: CZYJ to adres zbiórki lub płatności, według treści wokół adresu
// w publikacjach cytujących (np. „Donation to Tor”, metadane F-Droid `<author>The Tor Project</author>
// <donate>https://donate.torproject.org/</donate><bitcoin>…</bitcoin>`, „wpłaty na rzecz Fundacji X”).
//
// Zasady:
// - autor publikacji cytującej NIE jest właścicielem — nazwę bierzemy z kontekstu adresu, nie z autora;
// - liczą się NIEZALEŻNE pochodzenia (`provenanceGroups` z @olcys/core, grupowane po autorze publikacji:
//   tłumaczenia jednego repozytorium to jedno pochodzenie, kopie i przedruki też);
// - konkurencyjna nazwa z własnego pochodzenia albo ostrzeżenie przed oszustwem blokuje przypisanie;
// - nazwa wyglądająca na osobę (bez cech organizacji i bez zgodnej domeny) nie jest przypisywana — narzędzie nie
//   wskazuje osób na podstawie cytowań;
// - wynik jest zawsze hipotezą; strona organizacji publikująca ten sam adres to najmocniejsza przesłanka.

import { provenanceGroups } from '@olcys/core';
import type { AddressClass, Evidence, Network } from '@olcys/core';

/** Jawne wagi oceny beneficjenta (punkty 0–100, suma reguł jak we Wskaźniku Pewności). */
export const BENEFICIARY_RULES = {
  /** Nazwa organizacji w kontekście adresu („Donation to X”, „na rzecz X”, pole `author` obok adresu). */
  namedInContext: 25,
  /** Nazwa z ustrukturyzowanych metadanych (XML/JSON: author/organization obok pól donate/bitcoin). */
  structuredMetadata: 15,
  /** Domena odnośnika zbiórki albo e-maila obok adresu zgodna z nazwą (donate.torproject.org → „The Tor Project”). */
  donationDomain: 15,
  /** Za każde kolejne niezależne pochodzenie wskazujące tę samą organizację. */
  extraOrigin: 10,
  maxExtraOrigins: 20,
  /** Oficjalna strona organizacji publikuje ten sam adres. */
  officialSite: 25,
  /** Kara za każdą konkurencyjną nazwę z własnego pochodzenia (blokuje przypisanie). */
  competingName: -30,
  /** Kara za ostrzeżenie przed oszustwem w kontekście adresu (blokuje przypisanie). */
  scamWarning: -40,
  /** Minimum do przypisania: co najmniej tyle niezależnych pochodzeń (albo potwierdzenie na stronie organizacji)… */
  minOrigins: 2,
  /** …i co najmniej taki wynik. */
  minScore: 40,
  /** Ilu niepowiązanych autorów musi cytować adres, by szukać beneficjenta. */
  minCitingAuthors: 3,
} as const;

export type BeneficiarySignal = 'named_in_context' | 'structured_metadata' | 'donation_domain' | 'email_domain';

export interface BeneficiaryDocument {
  url: string;
  service: string;
  author?: string;
  text: string;
  contentHash?: string;
  archivedAt?: string;
}

/** Jedno wskazanie beneficjenta w kontekście adresu. */
export interface BeneficiaryMention {
  /** Klucz porównawczy nazwy (bez „the”, form prawnych i znaków), np. „tor”. */
  key: string;
  name?: string;
  domain?: string;
  donationUrl?: string;
  email?: string;
  signals: BeneficiarySignal[];
  role: 'donation' | 'payment';
  /** Fragment treści wokół adresu (do ~300 znaków). */
  quote: string;
  url: string;
  service: string;
  author?: string;
  contentHash?: string;
}

/** Ostrzeżenie przed oszustwem w kontekście adresu — nazwa w nim to ofiara podszywania się, nie beneficjent. */
export interface ScamWarning {
  url: string;
  service: string;
  author?: string;
  quote: string;
  named?: string;
}

export interface OfficialSiteCheck {
  url: string;
  /** Strona pobrana i zawiera ten sam adres. */
  publishesAddress: boolean;
  checkedAt: string;
  note: string;
}

export interface BeneficiaryComponent {
  rule: string;
  delta: number;
  explanation: string;
  sources?: string[];
}

export interface BeneficiaryAttribution {
  address: string;
  network: Network;
  name: string;
  key: string;
  domain?: string;
  donationUrl?: string;
  role: 'beneficjent zbiórki' | 'odbiorca płatności';
  /** Wskaźnik 0–100 z jawnych reguł `BENEFICIARY_RULES` (porządkowy, nie prawdopodobieństwo). */
  score: number;
  components: BeneficiaryComponent[];
  /** Liczba niezależnych pochodzeń wskazujących tę organizację. */
  origins: number;
  evidence: { url: string; author?: string; service: string; quote: string; signals: BeneficiarySignal[] }[];
  competing: { name: string; origins: number }[];
  warnings: ScamWarning[];
  officialSite?: OfficialSiteCheck;
  /** Czy spełniono warunki przypisania (bez konkurencji, bez ostrzeżeń, ≥ 2 pochodzenia albo strona organizacji). */
  attributed: boolean;
  /** Dlaczego nie przypisano (gdy `attributed` = false). */
  reason?: string;
  status: 'hypothesis';
  limitations: string[];
}

// ---------- Wydobycie z tekstu ----------

const ADDRESS_LIKE = /\b(?:0x[0-9a-fA-F]{40}|(?:bc1|tb1)[0-9a-z]{20,}|[13][1-9A-HJ-NP-Za-km-z]{24,34}|T[1-9A-HJ-NP-Za-km-z]{33})\b/g;
const WIDE_BEFORE = 700;
const WIDE_AFTER = 400;
const NARROW = 220;
const MAX_OCCURRENCES = 5;

/** Granice elementu w metadanych (jedna aplikacja F-Droid / AppStream) — nie mieszamy pól sąsiednich wpisów. */
const BLOCK_START = /<(?:application|component|package|project|item|entry)\b/gi;
const BLOCK_END = /<\/(?:application|component|package|project|item|entry)>/gi;

const SCAM = /\b(?:scam\w*|fraud\w*|fake|phishing|impersonat\w*|not\s+affiliated|beware|oszust\w*|fałszyw\w*|podszyw\w*|wyłudz\w*)\b/i;

/** Słowa kluczowe przed nazwą beneficjenta. Nazwa musi zaczynać się wielką literą (sprawdzane osobno). */
const PHRASES: { pattern: RegExp; role: 'donation' | 'payment' }[] = [
  { pattern: /\bdonat(?:e|es|ed|ing|ion|ions)\s+(?:to|for|towards)\s+/gi, role: 'donation' },
  { pattern: /\bsupport(?:s|ing)?\s+/gi, role: 'donation' },
  { pattern: /\b(?:fundrais(?:er|ing)|contribut(?:e|ions?)|tips?)\s+(?:to|for)\s+/gi, role: 'donation' },
  { pattern: /\bna\s+rzecz\s+/gi, role: 'donation' },
  { pattern: /\bzbiórk[aięą]\s+(?:dla\s+|na\s+)?/gi, role: 'donation' },
  { pattern: /\bwesprzyj(?:cie)?\s+/gi, role: 'donation' },
  { pattern: /\bwsparci[ea]\s+(?:dla\s+)?/gi, role: 'donation' },
  { pattern: /\bdarowizn[aęyą]?\s+(?:dla|na)\s+/gi, role: 'donation' },
  { pattern: /\bpay(?:ments?)?\s+(?:to|for)\s+/gi, role: 'payment' },
  { pattern: /\bpłatnoś(?:ć|ci)\s+(?:dla|na\s+rzecz)\s+/gi, role: 'payment' },
];

const NAME = /^(?:(?:The|the)\s+)?\p{Lu}[\p{L}\p{N}.&'’+-]*(?:[ \t]+(?:\p{Lu}[\p{L}\p{N}.&'’+-]*|of|for|and|&|de|du|la|der|und|dla|i))*/u;
const CONNECTIVE_TAIL = /\s+(?:of|for|and|&|de|du|la|der|und|dla|i)$/;

/** Nazwy, które nie są beneficjentem: zaimki, waluty, platformy płatności, ogólniki. */
const STOP_NAMES = new Set(
  [
    'me', 'us', 'my', 'our', 'this', 'it', 'him', 'her', 'them', 'you', 'the', 'the project', 'the author', 'the developer', 'the developers', 'author', 'developer', 'developers',
    'development', 'project', 'mnie', 'nas', 'nasz', 'mój', 'autora', 'projekt', 'projektu', 'twórcę', 'twórcy',
    'bitcoin', 'btc', 'ethereum', 'eth', 'monero', 'xmr', 'litecoin', 'ltc', 'crypto', 'lightning', 'tron', 'usdt', 'tether',
    'paypal', 'patreon', 'github', 'github sponsors', 'liberapay', 'open collective', 'opencollective', 'ko-fi', 'buy me a coffee', 'bitpay', 'coinbase',
    'donate', 'donation', 'donations', 'support', 'here', 'below', 'above',
  ].map((item) => item.toLowerCase()),
);

/** Formy prawne i ogólniki pomijane w kluczu porównawczym. */
const KEY_SUFFIXES = ['project', 'projekt', 'foundation', 'fundacja', 'fundacji', 'stowarzyszenie', 'stowarzyszenia', 'association', 'society', 'inc', 'ltd', 'llc', 'gmbh', 'ev', 'org', 'team', 'community', 'spzoo', 'sa'];

/** Cechy nazwy organizacji (a nie osoby). */
const ORG_MARKERS = /\b(?:project|projekt\w*|foundation|fundacj\w*|stowarzyszeni\w*|association|society|inc|ltd|llc|gmbh|e\.v\.|org|team|community|network|initiative|collective|trust|fund|charity|institute|instytut\w*|sp\.\s*z\s*o\.o\.|s\.a\.|federation|federacj\w*|alliance|centre|center|labs?|software|club|klub\w*|church|kości[oó]ł\w*|parafi\w*|szpital\w*|hospital|university|uniwersytet\w*)\b/i;

/** Domeny ogólne: poczta, hosting kodu, platformy płatności, eksploratory — nie wskazują beneficjenta. */
const GENERIC_DOMAINS = new Set([
  'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org', 'sourceforge.net', 'paypal.com', 'paypal.me', 'patreon.com', 'liberapay.com', 'opencollective.com',
  'ko-fi.com', 'buymeacoffee.com', 'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'protonmail.com', 'protonmail.ch', 'proton.me', 'riseup.net',
  'tutanota.com', 'tuta.io', 'posteo.de', 'posteo.net', 'mailbox.org', 'icloud.com', 'me.com', 'wp.pl', 'onet.pl', 'o2.pl', 'interia.pl', 'gazeta.pl', 'example.com', 'example.org',
  'blockchain.info', 'blockchain.com', 'blockstream.info', 'mempool.space', 'bitpay.com', 'coinbase.com', 'google.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com',
  'reddit.com', 'medium.com', 'wikipedia.org', 'archive.org', 'w3.org', 'schema.org', 'f-droid.org', 'apache.org', 'gnu.org', 'creativecommons.org', 'mozilla.org',
]);
/** Platformy zbiórek: beneficjent jest w ścieżce (opencollective.com/<nazwa>). */
const PLATFORM_PATH: Record<string, RegExp> = {
  'opencollective.com': /^\/([a-z0-9-]{2,60})/i,
  'liberapay.com': /^\/([a-z0-9_.-]{2,60})/i,
  'patreon.com': /^\/([a-z0-9_]{2,60})/i,
  'ko-fi.com': /^\/([a-z0-9_]{2,60})/i,
  'buymeacoffee.com': /^\/([a-z0-9_]{2,60})/i,
  'github.com': /^\/sponsors\/([a-z0-9-]{2,60})/i,
};
const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.pl', 'org.pl', 'net.pl', 'gov.pl', 'edu.pl', 'com.au', 'org.au', 'co.jp', 'com.br', 'co.nz']);
const DONATION_URL_HINT = /donat|zbiork|zbiórk|wplac|wpłać|wspar|sponsor|funding|fundrais|spende|support/i;

const strip = (value: string) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Klucz porównawczy nazwy: „The Tor Project” → „tor”, „torproject” → „tor”. */
export function beneficiaryKey(value: string): string {
  let key = strip(value).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of KEY_SUFFIXES) {
      if (key.endsWith(suffix) && key.length > suffix.length + 1) {
        key = key.slice(0, -suffix.length);
        changed = true;
      }
    }
  }
  return key;
}

/** Domena rejestrowalna: donate.torproject.org → torproject.org. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

const domainLabel = (domain: string) => domain.split('.')[0] ?? domain;

/** Beneficjent wskazany odnośnikiem zbiórki: domena organizacji albo nazwa w ścieżce platformy zbiórek. */
function fromUrl(raw: string): { domain?: string; key?: string; label?: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!/^https?:$/.test(url.protocol)) return undefined;
  const domain = registrableDomain(url.hostname);
  const platform = PLATFORM_PATH[domain]?.exec(url.pathname)?.[1];
  if (platform) return { key: beneficiaryKey(platform), label: platform };
  if (GENERIC_DOMAINS.has(domain)) return undefined;
  return { domain, key: beneficiaryKey(domainLabel(domain)) };
}

function fromEmail(raw: string): { domain: string; key: string } | undefined {
  const match = /^[^\s@<>"]+@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(raw.trim());
  if (!match || /noreply|no-reply/i.test(raw)) return undefined;
  const domain = registrableDomain(match[1]!);
  if (GENERIC_DOMAINS.has(domain)) return undefined;
  return { domain, key: beneficiaryKey(domainLabel(domain)) };
}

/** Nazwa beneficjenta z początku tekstu po słowie kluczowym; `undefined`, gdy to zaimek, waluta albo ogólnik. */
function parseName(text: string): string | undefined {
  const match = NAME.exec(text);
  if (!match) return undefined;
  let name = match[0].trim();
  const words = name.split(/\s+/).slice(0, 6);
  name = words.join(' ');
  while (CONNECTIVE_TAIL.test(name)) name = name.replace(CONNECTIVE_TAIL, '');
  name = name.replace(/[.,;:'’-]+$/, '');
  if (name.length < 2 || name.length > 60 || !/\p{L}/u.test(name)) return undefined;
  if (STOP_NAMES.has(name.toLowerCase()) || STOP_NAMES.has(name.toLowerCase().replace(/^the\s+/, ''))) return undefined;
  if (!beneficiaryKey(name)) return undefined;
  return name;
}

function cleanName(raw: string): string | undefined {
  const name = raw.replace(/\s+/g, ' ').replace(/<[^>]*>/g, '').trim();
  if (name.length < 2 || name.length > 80 || !/\p{L}/u.test(name) || STOP_NAMES.has(name.toLowerCase()) || /@|https?:/i.test(name)) return undefined;
  return beneficiaryKey(name) ? name : undefined;
}

const STRUCTURED_FIELDS = 'author|organization|organisation|developer_name|publisher|beneficiary|recipient|payee';
// Po znaczniku zamykającym — działa także na fragmencie uciętym przed znacznikiem otwierającym („…>The Tor Project</author>”).
const XML_FIELD = new RegExp(`([^<>]{2,80})</(${STRUCTURED_FIELDS})>`, 'gi');
const JSON_FIELD = new RegExp(`"(${STRUCTURED_FIELDS})"\\s*:\\s*"([^"]{2,80})"`, 'gi');
const XML_DONATE = /<donate>\s*([^<\s]+)\s*<\/donate>|<url\b[^>]*type\s*=\s*["']donation["'][^>]*>\s*([^<\s]+)\s*<\/url>/gi;
const JSON_DONATE = /"(?:donate|donation|donations|funding)"\s*:\s*"([^"\s]+)"/gi;
/** Metadane YAML (np. F-Droid `metadata/*.yml`: `AuthorName:`, `Donate:`), także spłaszczone do jednego wiersza. */
const YAML_FIELD = /(?:^|\s)(?:AuthorName|Author|Organi[sz]ation|Beneficiary):[ \t]*([^\n]{2,80}?)(?=\s+[A-Z][A-Za-z]+:\s|\n|$)/g;
const YAML_DONATE = /(?:^|\s)Donate:[ \t]*(https?:\/\/\S+)/g;
const XML_EMAIL =/<email>\s*([^<\s]+)\s*<\/email>|"email"\s*:\s*"([^"\s]+)"/gi;
const ANY_URL = /https?:\/\/[^\s"'<>()\]]+/gi;

/** Pozycje wystąpień adresu w tekście (adresy bech32 i 0x bez rozróżniania wielkości liter). */
function occurrences(text: string, address: string): number[] {
  const caseless = /^(?:bc1|tb1|0x)/i.test(address);
  const haystack = caseless ? text.toLowerCase() : text;
  const needle = caseless ? address.toLowerCase() : address;
  const found: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0 && found.length < MAX_OCCURRENCES; at = haystack.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** Okno wokół adresu przycięte na granicach innych adresów i elementów metadanych. */
function windowAround(text: string, at: number, length: number, address: string, before: number, after: number): { before: string; after: string } {
  const headStart = Math.max(0, at - before);
  let start = headStart;
  let end = Math.min(text.length, at + length + after);
  const head = text.slice(headStart, at);
  const tail = text.slice(at + length, end);
  const other = (value: string) => value.toLowerCase() !== address.toLowerCase();
  for (const match of head.matchAll(ADDRESS_LIKE)) if (other(match[0])) start = Math.max(start, headStart + match.index + match[0].length);
  for (const match of head.matchAll(BLOCK_START)) start = Math.max(start, headStart + match.index);
  for (const match of head.matchAll(BLOCK_END)) start = Math.max(start, headStart + match.index + match[0].length);
  const firstOther = [...tail.matchAll(ADDRESS_LIKE)].find((match) => other(match[0]));
  if (firstOther) end = Math.min(end, at + length + firstOther.index);
  const blockEnd = [...tail.matchAll(BLOCK_END)][0] ?? [...tail.matchAll(BLOCK_START)][0];
  if (blockEnd) end = Math.min(end, at + length + blockEnd.index + (blockEnd[0].startsWith('</') ? blockEnd[0].length : 0));
  return { before: text.slice(start, at), after: text.slice(at + length, end) };
}

/** Ostatnie (najbliższe adresowi) dopasowanie w części „przed” albo pierwsze w części „po”. */
function nearest<T>(before: T[], after: T[]): T | undefined {
  return before.at(-1) ?? after[0];
}

/**
 * Wskazania beneficjenta i ostrzeżenia w jednym dokumencie. Każde wystąpienie adresu daje najwyżej jedno
 * wskazanie (najbliższa nazwa, metadane i domena z tego samego elementu).
 */
export function extractBeneficiaryMentions(doc: BeneficiaryDocument, address: string): { mentions: BeneficiaryMention[]; warnings: ScamWarning[] } {
  const mentions: BeneficiaryMention[] = [];
  const warnings: ScamWarning[] = [];
  const base = { url: doc.url, service: doc.service, ...(doc.author ? { author: doc.author } : {}), ...(doc.contentHash ? { contentHash: doc.contentHash } : {}) };
  for (const at of occurrences(doc.text, address)) {
    const wide = windowAround(doc.text, at, address.length, address, WIDE_BEFORE, WIDE_AFTER);
    const narrow = { before: wide.before.slice(-NARROW), after: wide.after.slice(0, NARROW) };
    const quote = `${narrow.before.slice(-150)}${address}${narrow.after.slice(0, 150)}`.replace(/\s+/g, ' ').trim();

    // Nazwa po słowie kluczowym — najbliższa adresowi.
    const phraseHits = (part: string, offsetFromAddress: (index: number) => number) =>
      PHRASES.flatMap(({ pattern, role }) =>
        [...part.matchAll(pattern)].flatMap((match) => {
          const name = parseName(part.slice(match.index + match[0].length, match.index + match[0].length + 90));
          return name ? [{ name, role, distance: offsetFromAddress(match.index) }] : [];
        }),
      ).sort((a, b) => a.distance - b.distance);
    const phrase = [...phraseHits(narrow.before, (index) => narrow.before.length - index), ...phraseHits(narrow.after, (index) => index)].sort((a, b) => a.distance - b.distance)[0];

    if (SCAM.test(`${narrow.before} ${narrow.after}`)) {
      warnings.push({ ...base, quote, ...(phrase ? { named: phrase.name } : {}) });
      continue;
    }

    // Metadane ustrukturyzowane (XML/JSON) w obrębie tego samego elementu.
    const fields = (part: string) =>
      [...[...part.matchAll(XML_FIELD)].map((match) => ({ index: match.index, value: match[1]! })), ...[...part.matchAll(JSON_FIELD)].map((match) => ({ index: match.index, value: match[2]! })), ...[...part.matchAll(YAML_FIELD)].map((match) => ({ index: match.index, value: match[1]! }))]
        .sort((a, b) => a.index - b.index)
        .map((match) => cleanName(match.value))
        .filter((name): name is string => name !== undefined);
    const structuredName = nearest(fields(wide.before), fields(wide.after));
    const donateUrls = (part: string) => [...part.matchAll(XML_DONATE), ...part.matchAll(JSON_DONATE), ...part.matchAll(YAML_DONATE)].sort((a, b) => a.index - b.index).map((match) => (match[1] ?? match[2])!);
    const looseUrls = (part: string) => [...part.matchAll(ANY_URL)].map((match) => match[0]).filter((url) => DONATION_URL_HINT.test(url));
    // Luźne odnośniki zbiórek (poza polami metadanych): gdy przy adresie stoją odnośniki do RÓŻNYCH organizacji
    // (np. lista „znanych adresów”), kontekst jest niejednoznaczny i odnośnik niczego nie wskazuje.
    const loose = [...looseUrls(narrow.before), ...looseUrls(narrow.after)];
    const looseKeys = new Set(loose.map((url) => fromUrl(url)?.key).filter(Boolean));
    const donationUrl =
      nearest(donateUrls(wide.before), donateUrls(wide.after)) ?? (looseKeys.size <= 1 ? nearest(looseUrls(narrow.before), looseUrls(narrow.after)) : undefined);
    const emails = (part: string) => [...part.matchAll(XML_EMAIL)].map((match) => (match[1] ?? match[2])!);
    const email = nearest(emails(wide.before), emails(wide.after));

    const fromDonation = donationUrl ? fromUrl(donationUrl) : undefined;
    const fromMail = email ? fromEmail(email) : undefined;
    const name = structuredName ?? phrase?.name;
    const key = name ? beneficiaryKey(name) : (fromDonation?.key ?? fromMail?.key);
    if (!key) continue;
    const domain = fromDonation?.domain ?? fromMail?.domain;
    const signals: BeneficiarySignal[] = [];
    if (name) signals.push('named_in_context');
    if (structuredName) signals.push('structured_metadata');
    if (fromDonation && (!name || sameKey(fromDonation.key, key))) signals.push('donation_domain');
    if (fromMail && (!name || sameKey(fromMail.key, key))) signals.push('email_domain');
    const donationRole = phrase?.role ?? (donationUrl || /donat|zbiórk|darowizn|wpłat/i.test(`${narrow.before} ${narrow.after} ${doc.url}`) ? 'donation' : 'payment');
    mentions.push({
      ...base,
      key,
      ...(name ? { name } : fromDonation?.label ? { name: fromDonation.label } : {}),
      ...(domain && (!name || sameKey(beneficiaryKey(domainLabel(domain)), key)) ? { domain } : {}),
      ...(donationUrl && fromDonation ? { donationUrl } : {}),
      ...(email && fromMail ? { email } : {}),
      signals,
      role: donationRole,
      quote,
    });
  }
  return { mentions, warnings };
}

/** Te same klucze — także „torproject” wobec „tor” po zdjęciu ogólników (np. „tor” i „torproject”). */
export function sameKey(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a === b || (Math.min(a.length, b.length) >= 3 && (a === beneficiaryKey(b) || b === beneficiaryKey(a)));
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

export interface AttributionInput {
  address: string;
  network: Network;
  mentions: BeneficiaryMention[];
  warnings: ScamWarning[];
  officialSite?: OfficialSiteCheck;
}

const looksLikeOrganization = (names: string[], domainMatches: boolean) =>
  domainMatches || names.some((name) => ORG_MARKERS.test(name)) || names.some((name) => name.trim().split(/\s+/).length === 1 && name.length >= 3);

/** Ocena beneficjenta adresu: dominująca organizacja z niezależnych pochodzeń. `undefined`, gdy brak wskazań. */
export function attributeBeneficiary(input: AttributionInput): BeneficiaryAttribution | undefined {
  const { mentions, warnings } = input;
  if (mentions.length === 0 && warnings.length === 0) return undefined;

  // Pochodzenie = autor publikacji (grupy z provenanceGroups: ten sam autor, ta sama treść, kopia archiwalna, przedruk).
  const docs = new Map<string, Evidence>();
  for (const item of [...mentions, ...warnings]) {
    if (docs.has(item.url)) continue;
    docs.set(item.url, {
      id: item.url,
      category: 'forum_post',
      service: originService(item),
      url: item.url,
      capturedAt: '',
      identityMatch: 'same_handle',
      excerpt: item.quote,
      ...('contentHash' in item && item.contentHash ? { contentHash: item.contentHash } : {}),
    });
  }
  const groups = provenanceGroups([...docs.values()]);
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => group.evidenceIds.forEach((id) => groupOf.set(id, index)));

  // Grupowanie wskazań po kluczu; wskazanie z samą domeną dołącza do nazwy o zgodnym kluczu.
  const keys: string[] = [];
  for (const mention of mentions) if (!keys.some((key) => sameKey(key, mention.key))) keys.push(mention.key);
  const byKey = keys.map((key) => {
    const own = mentions.filter((mention) => sameKey(mention.key, key));
    return { key, mentions: own, groups: new Set(own.map((mention) => groupOf.get(mention.url)!)) };
  });
  byKey.sort(
    (a, b) =>
      b.groups.size - a.groups.size ||
      Number(b.mentions.some((item) => item.signals.includes('structured_metadata'))) - Number(a.mentions.some((item) => item.signals.includes('structured_metadata'))) ||
      b.mentions.length - a.mentions.length,
  );
  const top = byKey[0];
  const names = top ? top.mentions.map((item) => item.name).filter((name): name is string => Boolean(name)) : [];
  const domain = top?.mentions.find((item) => item.domain)?.domain;
  const displayName =
    names.filter((name) => ORG_MARKERS.test(name)).sort((a, b) => b.length - a.length)[0] ??
    top?.mentions.find((item) => item.signals.includes('structured_metadata'))?.name ??
    [...names].sort((a, b) => b.length - a.length)[0] ??
    domain ??
    warnings[0]?.named ??
    '(nieustalona)';

  // Konkurencja: inna nazwa z co najmniej jednego pochodzenia, które NIE wskazuje też organizacji dominującej.
  const competing = top
    ? byKey
        .slice(1)
        .filter((other) => [...other.groups].some((group) => !top.groups.has(group)) || other.groups.size >= top.groups.size)
        .map((other) => ({ name: other.mentions.find((item) => item.name)?.name ?? other.mentions[0]?.domain ?? other.key, origins: other.groups.size }))
    : [];

  const components: BeneficiaryComponent[] = [];
  const add = (rule: string, delta: number, explanation: string, sources?: string[]) => components.push({ rule, delta, explanation, ...(sources?.length ? { sources: [...new Set(sources)].slice(0, 10) } : {}) });
  const urlsWith = (signal: BeneficiarySignal) => (top?.mentions ?? []).filter((item) => item.signals.includes(signal)).map((item) => item.url);
  if (top && names.length > 0) {
    const sample = top.mentions.find((item) => item.signals.includes('named_in_context'));
    add('beneficiary.named_in_context', BENEFICIARY_RULES.namedInContext, `Nazwa „${displayName}” występuje w treści wokół adresu (np. „${sample?.quote.slice(0, 160) ?? ''}”).`, urlsWith('named_in_context'));
  }
  if (top && urlsWith('structured_metadata').length > 0) {
    add('beneficiary.structured_metadata', BENEFICIARY_RULES.structuredMetadata, 'Nazwa pochodzi z ustrukturyzowanych metadanych obok adresu (pola autora/organizacji przy polach zbiórki i adresu kryptowalutowego).', urlsWith('structured_metadata'));
  }
  const domainSources = top ? [...urlsWith('donation_domain'), ...urlsWith('email_domain')] : [];
  if (domainSources.length > 0) {
    const sample = top!.mentions.find((item) => item.donationUrl)?.donationUrl ?? top!.mentions.find((item) => item.email)?.email ?? domain;
    add('beneficiary.donation_domain', BENEFICIARY_RULES.donationDomain, `Odnośnik zbiórki lub e-mail obok adresu wskazuje domenę ${domain ?? sample} (${sample}) zgodną z nazwą organizacji.`, domainSources);
  }
  const origins = top?.groups.size ?? 0;
  if (origins > 1) {
    const extra = Math.min(BENEFICIARY_RULES.maxExtraOrigins, (origins - 1) * BENEFICIARY_RULES.extraOrigin);
    const originLabels = groups.filter((_, index) => top!.groups.has(index)).map((group) => [...new Set(group.services.map((service) => service.split('|')[1]))].join(', '));
    add('beneficiary.independent_origins', extra, `Organizację wskazuje ${origins} niezależnych pochodzeń publikacji (${originLabels.join('; ')}); kopie, tłumaczenia i pliki tego samego autora liczą się jako jedno.`, top!.mentions.map((item) => item.url));
  }
  if (input.officialSite?.publishesAddress) {
    add('beneficiary.official_site', BENEFICIARY_RULES.officialSite, `Potwierdzone na stronie organizacji ${input.officialSite.url}: strona publikuje ten sam adres.`, [input.officialSite.url]);
  }
  if (competing.length > 0) {
    add('beneficiary.competing_names', BENEFICIARY_RULES.competingName * competing.length, `Inne nazwy wskazane w kontekście adresu przez niezależne publikacje: ${competing.map((item) => `„${item.name}”`).join(', ')} — beneficjent niejednoznaczny.`);
  }
  if (warnings.length > 0) {
    add('beneficiary.scam_warning', BENEFICIARY_RULES.scamWarning, `Publikacje ostrzegają przed oszustwem z użyciem tego adresu${warnings[0]!.named ? ` (wymieniona nazwa „${warnings[0]!.named}” to ofiara podszywania się, nie beneficjent)` : ''}.`, warnings.map((item) => item.url));
  }
  const score = Math.max(0, Math.min(100, components.reduce((sum, item) => sum + item.delta, 0)));
  const domainMatches = Boolean(domain) && names.some((name) => sameKey(beneficiaryKey(name), beneficiaryKey(domainLabel(domain!))));
  const organization = looksLikeOrganization(names, domainMatches || (names.length === 0 && Boolean(domain)));
  const enoughOrigins = origins >= BENEFICIARY_RULES.minOrigins || (input.officialSite?.publishesAddress === true && origins >= 1);
  const reason = !top
    ? 'Kontekst adresu to wyłącznie ostrzeżenia przed oszustwem — nazwa w nich nie jest beneficjentem.'
    : warnings.length > 0
      ? 'W kontekście adresu są ostrzeżenia przed oszustwem — organizacji nie przypisano.'
      : competing.length > 0
        ? `Konkurencyjne nazwy beneficjenta (${competing.map((item) => item.name).join(', ')}) — organizacji nie przypisano.`
        : !organization
          ? `Nazwa „${displayName}” nie ma cech organizacji ani zgodnej domeny — narzędzie nie wskazuje osób na podstawie cytowań.`
          : !enoughOrigins
            ? `Organizację wskazuje tylko ${origins} pochodzenie publikacji (wymagane ${BENEFICIARY_RULES.minOrigins} albo potwierdzenie na stronie organizacji).`
            : score < BENEFICIARY_RULES.minScore
              ? `Wskaźnik ${score} poniżej progu ${BENEFICIARY_RULES.minScore}.`
              : undefined;
  const donationUrl = top?.mentions.find((item) => item.donationUrl)?.donationUrl;
  return {
    address: input.address,
    network: input.network,
    name: displayName,
    key: top?.key ?? beneficiaryKey(displayName),
    ...(domain ? { domain } : {}),
    ...(donationUrl ? { donationUrl } : {}),
    role: (top?.mentions ?? []).some((item) => item.role === 'donation') ? 'beneficjent zbiórki' : 'odbiorca płatności',
    score,
    components,
    origins,
    evidence: (top?.mentions ?? []).slice(0, 12).map((item) => ({ url: item.url, ...(item.author ? { author: item.author } : {}), service: item.service, quote: item.quote, signals: item.signals })),
    competing,
    warnings: warnings.slice(0, 5),
    ...(input.officialSite ? { officialSite: input.officialSite } : {}),
    attributed: reason === undefined,
    ...(reason ? { reason } : {}),
    status: 'hypothesis',
    limitations: [
      'Autorzy publikacji cytujących adres nie są jego właścicielami — nazwa organizacji pochodzi z treści wokół adresu, a nie z autora publikacji.',
      input.officialSite?.publishesAddress
        ? `Adres publikuje strona organizacji (${input.officialSite.url}) — to nadal hipoteza: strona mogła zmienić treść albo zostać podszyta; zachowaj kopię strony.`
        : 'Przynależność adresu do organizacji należy potwierdzić na jej oficjalnej stronie (zakładka darowizn) albo zapytaniem do organizacji.',
      'Wpłacający na adres zbiórki to darczyńcy lub klienci — nie są kontami właściciela.',
    ],
  };
}

/** Wskazania ze wszystkich dokumentów zawierających adres — wejście dla `attributeBeneficiary`. */
export function collectBeneficiaryMentions(docs: BeneficiaryDocument[], address: string): { mentions: BeneficiaryMention[]; warnings: ScamWarning[] } {
  const mentions: BeneficiaryMention[] = [];
  const warnings: ScamWarning[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const key = `${doc.url}|${doc.archivedAt ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const found = extractBeneficiaryMentions(doc, address);
    // Jedno wskazanie danego klucza na dokument (np. adres powtórzony w pliku).
    for (const mention of found.mentions) if (!mentions.some((item) => item.url === mention.url && item.key === mention.key)) mentions.push(mention);
    for (const warning of found.warnings) if (!warnings.some((item) => item.url === warning.url)) warnings.push(warning);
  }
  return { mentions, warnings };
}

/** Łącznik pobierający stronę organizacji (jedna strona, robots.txt, bez podążania za odnośnikami). */
export const OFFICIAL_SITE_CONNECTOR = 'live-www';

/**
 * Klasa adresu do Wskaźnika Pewności osoby: adres przypisany organizacji jako zbiórka dostaje klasę „charity”
 * (wykluczenie z przypisania osobie). Adres podany przez analityka zostaje przedmiotem sprawy — klasa bez zmian.
 */
export function charityClass(
  current: AddressClass | undefined,
  beneficiary: BeneficiaryAttribution | undefined,
  analystAddress: boolean,
): AddressClass {
  const known = current ?? 'unknown';
  if (!beneficiary?.attributed || analystAddress) return known;
  return known === 'private' || known === 'unknown' ? 'charity' : known;
}

/** Adnotacja przy adresie: czyj to adres zbiórki i dlaczego 0% dla osoby. */
export function beneficiaryNote(attribution: BeneficiaryAttribution): string {
  return (
    `Adres ${attribution.role === 'beneficjent zbiórki' ? 'zbiórki' : 'płatności'} organizacji „${attribution.name}”${attribution.domain ? ` (${attribution.domain})` : ''} — ` +
    `hipoteza z kontekstu publikacji cytujących (wskaźnik ${attribution.score}/100, niezależnych pochodzeń ${attribution.origins})` +
    `${attribution.officialSite?.publishesAddress ? `; potwierdzone na stronie organizacji ${attribution.officialSite.url}` : ''}. ` +
    'Wskaźnik Pewności dla osoby: 0% — znany adres zbiórki organizacji; autorzy cytujący adres nie są jego właścicielami.'
  );
}

/** Adres strony organizacji do sprawdzenia: odnośnik zbiórki albo strona główna domeny. */
export function officialSiteUrl(attribution: BeneficiaryAttribution): string | undefined {
  if (attribution.donationUrl) {
    try {
      const url = new URL(attribution.donationUrl);
      if (/^https?:$/.test(url.protocol) && registrableDomain(url.hostname) === attribution.domain) return url.toString();
    } catch {
      // niżej strona główna
    }
  }
  return attribution.domain ? `https://${attribution.domain}/` : undefined;
}
