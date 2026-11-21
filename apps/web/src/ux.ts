// Czysta logika warstwy prezentacji: słowne poziomy wyników, skracanie ustaleń, zdanie podsumowania.
// Bez DOM i Reacta — testowana w `test/ux.test.ts`.
import { fmtPlnCompact, scoreLevel } from './format.ts';
import type { ScoreLevel } from './format.ts';
import type { GlossaryId } from './glossary.ts';

// ---------- Liczebniki ----------

/** Polska odmiana rzeczownika po liczebniku: 1 adres, 2 adresy, 5 adresów. */
export function plural(count: number, one: string, few: string, many: string): string {
  const abs = Math.abs(count);
  if (abs === 1) return one;
  const tens = abs % 100;
  const units = abs % 10;
  return units >= 2 && units <= 4 && (tens < 12 || tens > 14) ? few : many;
}

export const countText = (count: number, one: string, few: string, many: string) => `${count} ${plural(count, one, few, many)}`;

// ---------- Wyniki 0–100: słowo, kolor, opis ----------

export type ScoreKind = 'publication' | 'joint' | 'person' | 'proof' | 'priority' | 'strength' | 'trail';

interface KindInfo {
  /** Nazwa wyniku w nagłówku wyjaśnienia. */
  label: string;
  glossary: GlossaryId;
  /** Słowa dla poziomów: wysoki, prawdopodobny, średni, niski. */
  words: Record<Exclude<ScoreLevel, 'excluded'>, string>;
}

export const SCORE_KIND: Record<ScoreKind, KindInfo> = {
  publication: {
    label: 'Wskaźnik Pewności publikacji',
    glossary: 'wskaznik-pewnosci',
    words: { high: 'bardzo mocne powiązanie', likely: 'mocne powiązanie', medium: 'umiarkowane powiązanie', low: 'słabe powiązanie' },
  },
  joint: {
    label: 'Powiązanie adresu z osobą ze sprawy',
    glossary: 'osoba-adres',
    words: { high: 'bardzo mocne powiązanie', likely: 'mocne powiązanie', medium: 'umiarkowane powiązanie', low: 'słabe powiązanie' },
  },
  person: {
    label: 'Pewność ustalenia osoby',
    glossary: 'pewnosc-osoby',
    words: { high: 'bardzo prawdopodobne', likely: 'prawdopodobne', medium: 'możliwe', low: 'mało prawdopodobne' },
  },
  proof: {
    label: 'Łączna pewność ustalenia',
    glossary: 'laczna-pewnosc',
    words: { high: 'bardzo mocny dowód', likely: 'mocny dowód', medium: 'średnio mocny dowód', low: 'słaby dowód' },
  },
  priority: {
    label: 'Priorytet sprawy',
    glossary: 'priorytet-sprawy',
    words: { high: 'pilna sprawa', likely: 'wysoki priorytet', medium: 'średni priorytet', low: 'niski priorytet' },
  },
  trail: {
    label: 'Pewność ścieżki środków',
    glossary: 'pewnosc-sciezki',
    words: { high: 'ścieżka bardzo pewna', likely: 'ścieżka pewna', medium: 'ścieżka umiarkowanie pewna', low: 'ścieżka niepewna' },
  },
  strength: {
    label: 'Siła powiązania',
    glossary: 'osoba-adres',
    words: { high: 'bardzo silne', likely: 'silne', medium: 'umiarkowane', low: 'słabe' },
  },
};

/** Poziom wyniku słowami, np. „bardzo mocne powiązanie”; wykluczony adres ma zawsze słowo „odrzucony”. */
export function tierWords(kind: ScoreKind, value: number, excluded = false): string {
  if (excluded) return 'odrzucony';
  const level = scoreLevel(value);
  return SCORE_KIND[kind].words[level === 'excluded' ? 'low' : level];
}

// ---------- Ustalenia: krótka pierwsza część i reszta ----------

/** Skróty, po których kropka nie kończy zdania. */
const ABBREVIATIONS = new Set(['ok', 'tys', 'zł', 'np', 'mln', 'mld', 'r', 'nr', 'ul', 'godz', 'tj', 'tzw', 'ang', 'pkt', 'wg', 'm.in', 'ds', 'sygn', 'tel', 'św', 'proc', 'p.p']);

/**
 * Dzieli ustalenie na zwięzły początek (jedna linia na liście) i dopowiedzenie.
 * Cięcie po pierwszym końcu zdania, myślniku albo średniku — nie wcześniej niż po `min` znakach.
 */
export function splitLead(text: string, min = 24, max = 150): { lead: string; rest?: string; joined?: boolean } {
  const clean = text.trim().replace(/\s+/g, ' ');
  /** Miejsca cięcia: koniec części głównej i początek dopowiedzenia. */
  const cuts: { leadEnd: number; restStart: number }[] = [];
  /** Wewnątrz nawiasu nie tniemy — początek nie może kończyć się otwartym nawiasem. */
  const insideBrackets = (index: number) => {
    const before = clean.slice(0, index);
    return (before.match(/\(/g)?.length ?? 0) > (before.match(/\)/g)?.length ?? 0);
  };
  for (const separator of [' — ', ' – ', '; ']) {
    let index = clean.indexOf(separator, min);
    while (index >= 0 && insideBrackets(index)) index = clean.indexOf(separator, index + 1);
    if (index >= 0) cuts.push({ leadEnd: index, restStart: index + separator.length });
  }
  const sentence = /([^\s.]+)\.\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ„"(])/g;
  for (let match = sentence.exec(clean); match; match = sentence.exec(clean)) {
    const word = match[1]!.toLowerCase().replace(/[()„”"]/g, '');
    const leadEnd = match.index + match[1]!.length + 1;
    if (leadEnd < min || ABBREVIATIONS.has(word) || /^\d+$/.test(word) || insideBrackets(leadEnd)) continue;
    cuts.push({ leadEnd, restStart: match.index + match[0].length });
    break;
  }
  const best = cuts.sort((a, b) => a.leadEnd - b.leadEnd)[0];
  if (best && best.leadEnd <= max) {
    const lead = clean.slice(0, best.leadEnd).trim();
    const rest = clean.slice(best.restStart).trim();
    return rest ? { lead, rest: rest.charAt(0).toUpperCase() + rest.slice(1) } : { lead };
  }
  if (clean.length <= max) return { lead: clean };
  // Bez wyraźnego końca myśli: dopowiedzenie w nawiasie przenosimy do szczegółów.
  const bracket = clean.lastIndexOf(' (', max);
  if (bracket >= min) return { lead: clean.slice(0, bracket).trim(), rest: clean.slice(bracket + 1).trim() };
  const cut = clean.lastIndexOf(' ', max);
  const at = cut > min ? cut : max;
  // `joined`: dopowiedzenie jest dalszym ciągiem tego samego zdania (po rozwinięciu — bez wielokropka).
  return { lead: clean.slice(0, at).trim(), rest: clean.slice(at).trim(), joined: true };
}

// ---------- Grupy ustaleń ----------

export type FindingGroup = 'fact' | 'calc' | 'inference' | 'external';

export const FINDING_GROUPS: { id: FindingGroup; title: string; subtitle: string }[] = [
  { id: 'fact', title: 'Co wiemy ze źródeł', subtitle: 'fakty — można je sprawdzić pod podanym adresem' },
  { id: 'calc', title: 'Co policzyliśmy', subtitle: 'obliczenia z faktów według jawnych reguł' },
  { id: 'inference', title: 'Co wymaga sprawdzenia', subtitle: 'wnioski i hipotezy — potrzebna decyzja analityka' },
  { id: 'external', title: 'Z dokumentów spoza OSINT', subtitle: 'odpowiedzi usług wprowadzone przez analityka' },
];

export function groupKeyFindings(
  items: { text: string; layer: 'fact' | 'calculation' | 'inference' }[],
  isExternal: (text: string) => boolean = () => false,
): Record<FindingGroup, string[]> {
  const groups: Record<FindingGroup, string[]> = { fact: [], calc: [], inference: [], external: [] };
  for (const item of items) {
    const group: FindingGroup = isExternal(item.text) ? 'external' : item.layer === 'calculation' ? 'calc' : item.layer;
    groups[group].push(item.text);
  }
  return groups;
}

// ---------- Zdanie podsumowania sprawy ----------

export interface SummaryFacts {
  /** Nazwa osoby (kandydat główny); brak = osoby nie ustalono. */
  person?: string;
  addressCase?: boolean;
  /**
   * Wejściem wyszukiwania był adres krypto (postać skrócona): zdanie mówi o osobie powiązanej z adresem,
   * a nie o adresach powiązanych z osobą.
   */
  inputAddress?: string;
  /** Dlaczego nie ustalono osoby dla adresu z wejścia (dopowiedzenie po myślniku). */
  noPersonReason?: string;
  linked: number;
  unconfirmed: number;
  services: string[];
  totalPln: number;
}

/** Powód braku osoby dla adresu z wejścia — z tego, co widać w teczce. */
export function noPersonReason(facts: { widelyCited?: boolean; mentionDocuments: number }): string {
  if (facts.widelyCited) return 'adres cytuje wielu niezwiązanych autorów, więc nie przypisujemy go nikomu';
  if (facts.mentionDocuments > 0) return 'adres występuje w publikacjach, ale żadna nie wskazuje jego właściciela';
  return 'w źródłach publicznych nie znaleziono publikacji z tym adresem';
}

/** Jedno–dwa zdania: co znaleziono i dokąd trafiły pieniądze. Język ostrożny — bez przesądzania. */
export function summarySentence(facts: SummaryFacts): string {
  const parts: string[] = [];
  if (facts.inputAddress) {
    parts.push(
      facts.person
        ? `Znaleziono osobę powiązaną z adresem ${facts.inputAddress}: ${facts.person}.`
        : `Nie znaleziono osoby powiązanej z adresem ${facts.inputAddress}${facts.noPersonReason ? ` — ${facts.noPersonReason}` : ''}.`,
    );
  } else if (facts.addressCase) {
    parts.push('Sprawa dotyczy jednego adresu — właściciela nie ustalano.');
  } else if (facts.linked > 0) {
    parts.push(`Znaleziono ${countText(facts.linked, 'adres powiązany', 'adresy powiązane', 'adresów powiązanych')} ${facts.person ? `z osobą ${facts.person}` : 'z podmiotem'}.`);
  } else if (facts.unconfirmed > 0) {
    parts.push(`Znaleziono ${countText(facts.unconfirmed, 'adres', 'adresy', 'adresów')} do potwierdzenia — żaden nie jest jeszcze przypisany osobie.`);
  } else {
    parts.push('Nie znaleziono adresów kryptowalutowych powiązanych z tą osobą.');
  }
  if (facts.services.length > 0) {
    const names = facts.services.slice(0, 2).join(', ');
    const more = facts.services.length > 2 ? ` i ${countText(facts.services.length - 2, 'inna usługa', 'inne usługi', 'innych usług')}` : '';
    parts.push(`Środki trafiły do: ${names}${more}${facts.totalPln > 0 ? ` — szacunkowo ${fmtPlnCompact(facts.totalPln)}` : ''}.`);
  } else if (facts.linked > 0 || facts.addressCase || facts.inputAddress) {
    parts.push('Nie wykryto przelewów do giełd ani innych usług.');
  }
  return parts.join(' ');
}

// ---------- Wejście wyszukiwania ----------

interface InputIdentifier {
  identifier: { type: string; value: string };
  origin: 'analyst' | 'discovered';
}

/**
 * Co analityk wpisał: identyfikatory podane przez analityka (pierwszy — główny).
 * `kind: 'address'`, gdy głównym wejściem jest adres krypto; inaczej `'person'` (nick, e-mail, imię i nazwisko…).
 */
export function searchInput(identifiers: InputIdentifier[]): { kind: 'address' | 'person'; items: InputIdentifier['identifier'][] } {
  const items = identifiers.filter((item) => item.origin === 'analyst').map((item) => item.identifier);
  return { kind: items[0]?.type === 'crypto_address' ? 'address' : 'person', items };
}

// ---------- Dowód spieniężenia: przekazania do tej samej usługi w jednej karcie ----------

export interface ProofLike {
  id: string;
  address: string;
  serviceName: string;
  combinedConfidence: number;
  trail: { valuePln?: number | null; hops: { time: string }[] };
}

export interface ProofGroup<T extends ProofLike> {
  key: string;
  serviceName: string;
  address: string;
  /** Przekazania od najpewniejszego; pierwsze jest wzorcem wyjaśnienia. */
  items: T[];
  totalPln: number;
  unvalued: number;
  /** Zakres lat, np. „2024–2025” albo „2025”. */
  years: string;
  best: T;
}

/** Łączy ustalenia z tego samego adresu do tej samej usługi; kolejność grup — od najpewniejszej. */
export function groupProofs<T extends ProofLike>(proofs: T[]): ProofGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const proof of proofs) {
    const key = `${proof.serviceName}|${proof.address}`;
    groups.set(key, [...(groups.get(key) ?? []), proof]);
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const items = [...list].sort((a, b) => b.combinedConfidence - a.combinedConfidence || (b.trail.valuePln ?? 0) - (a.trail.valuePln ?? 0));
      const years = [...new Set(items.flatMap((item) => item.trail.hops.map((hop) => hop.time.slice(0, 4))))].sort();
      return {
        key,
        serviceName: items[0]!.serviceName,
        address: items[0]!.address,
        items,
        totalPln: items.reduce((total, item) => total + (item.trail.valuePln ?? 0), 0),
        unvalued: items.filter((item) => item.trail.valuePln == null).length,
        years: years.length === 0 ? '' : years.length === 1 ? years[0]! : `${years[0]}–${years.at(-1)}`,
        best: items[0]!,
      };
    })
    .sort((a, b) => b.best.combinedConfidence - a.best.combinedConfidence || b.totalPln - a.totalPln);
}

/** Uzasadnienie składnika bez notacji „P(…) = 55%:” — sama treść prostym językiem. */
export function plainComponent(text: string): string {
  return text.replace(/^P\([^)]*\)\s*=\s*\d+\s*%\s*:?\s*/u, '').replace(/^Łączna pewność ustalenia\s*=.*$/u, '').trim();
}

// ---------- Pamięć przeglądarki (wskazówki, przewodnik) ----------

/** Odczyt z `localStorage` odporny na tryb prywatny i blokadę danych witryny. */
export function readFlag(key: string, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function writeFlag(key: string, value: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (value) storage?.setItem(key, '1');
    else storage?.removeItem(key);
  } catch {
    // Brak dostępu do pamięci: stan obowiązuje do zamknięcia karty.
  }
}

/** Usuwa wszystkie klucze z prefiksem (przywrócenie wskazówek, ponowny przewodnik). */
export function clearFlags(prefix: string, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // jw.
  }
}

export const HINT_PREFIX = 'olcys:wskazowka:';
export const TOUR_PREFIX = 'olcys:przewodnik:';
