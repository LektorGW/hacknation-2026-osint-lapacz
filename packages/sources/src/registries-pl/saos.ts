// Orzeczenia sądów — System Analizy Orzeczeń Sądowych (SAOS, saos.org.pl), programowe API wyszukiwania.
//
// Podstawa (sprawdzone 22.11.2026; cytaty w docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja 3):
//   • https://www.saos.org.pl/help/index.php/dokumentacja-api — „System SAOS umożliwia pobieranie i przeszukiwanie
//     wszystkich zgromadzonych danych orzeczeń poprzez programowe API.”; „możesz w łatwy sposób wzbogacić swoją własną
//     stronę www lub pisaną aplikację”. Dane importowane automatycznie m.in. z Portalu Orzeczeń Sądów Powszechnych
//     (orzeczenia.ms.gov.pl — sam portal nie publikuje API ani warunków, więc go nie odpytujemy).
//   • API wyszukiwania „nie służy do pobierania bazy orzeczeń” — pytamy pojedynczo (jedno zapytanie na organizację,
//     najwyżej 10 wyników), nie budujemy kopii bazy.
//   • CBOSA (orzeczenia.nsa.gov.pl) NIE jest odpytywana: robots.txt zabrania `/cbo/find` i `/cbo/search`.
//
// Zasady: orzeczenia są zanonimizowane — nazwiska osób fizycznych zastępuje „(...)” lub inicjały. Narzędzie niczego nie
// odtwarza i nie przypisuje orzeczenia osobie. Wynik to KONTEKST ORGANIZACJI (zgodność nazwy w treści orzeczenia —
// dopasowanie słabe: możliwa zbieżność nazw); nazwisk sędziów nie przenosimy (zbędne dla analizy).

export const SAOS_SERVICE = 'saos.org.pl';
export const SAOS_SEARCH_API = 'https://www.saos.org.pl/api/search/judgments';
export const SAOS_JUDGMENT_PAGE = 'https://www.saos.org.pl/judgments';
export const SAOS_TERMS = 'SAOS — programowe API orzeczeń (dane jawne, zanonimizowane; pojedyncze zapytania, bez kopiowania bazy)';
export const SAOS_PAGE_SIZE = 10;

export interface CourtDecision {
  id: number;
  /** Strona orzeczenia w SAOS (dla człowieka). */
  url: string;
  /** Pełne dane orzeczenia w API SAOS. */
  apiUrl: string;
  caseNumbers: string[];
  court?: string;
  division?: string;
  courtType: string;
  judgmentType?: string;
  date?: string;
  keywords: string[];
  /** Fragment treści z trafieniem (bez znaczników), najwyżej 300 znaków. */
  excerpt: string;
  /** Słowa kluczowe lub fragment wskazują na upadłość, likwidację albo restrukturyzację. */
  insolvency: boolean;
  /** Sprawa podatkowa / skarbowa (słowa kluczowe lub fragment). */
  tax: boolean;
}

/** Formy prawne na końcu nazwy — fraza wyszukiwania to sama nazwa (orzeczenia często skracają formę). */
const LEGAL_FORM =
  /[\s,]*(?:SPÓŁKA AKCYJNA|SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ(?: SPÓŁKA KOMANDYTOWA)?|SPÓŁKA KOMANDYTOWO-AKCYJNA|SPÓŁKA KOMANDYTOWA|SPÓŁKA JAWNA|SPÓŁKA PARTNERSKA|PROSTA SPÓŁKA AKCYJNA|S\.\s?A\.|SP\.\s?Z\s?O\.\s?O\.|SP\.\s?K\.|SP\.\s?J\.|P\.\s?S\.\s?A\.)\s*$/i;
const STATE_SUFFIX = /[\s,]*W (?:LIKWIDACJI|UPADŁOŚCI|RESTRUKTURYZACJI)\s*$/i;

/**
 * Fraza do wyszukania organizacji w treści orzeczeń: nazwa bez formy prawnej i bez dopisku „w likwidacji”.
 * `undefined`, gdy zostaje mniej niż 2 wyrazy albo mniej niż 6 znaków (za dużo zbieżności z innymi tekstami).
 */
export function saosPhraseFor(name: string): string | undefined {
  let core = name.replace(/["„”]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) core = core.replace(STATE_SUFFIX, '').replace(LEGAL_FORM, '').trim();
  const words = core.split(' ').filter(Boolean);
  if (core.length < 6 || words.length < 2) return undefined;
  return core;
}

/** Adres zapytania: dokładna fraza w cudzysłowie, najnowsze orzeczenia najpierw. */
export function saosSearchUrl(phrase: string, pageSize = SAOS_PAGE_SIZE): string {
  const params = new URLSearchParams({ all: `"${phrase.replace(/"/g, '')}"`, pageSize: String(Math.min(Math.max(pageSize, 10), 100)), pageNumber: '0', sortingField: 'JUDGMENT_DATE', sortingDirection: 'DESC' });
  return `${SAOS_SEARCH_API}?${params.toString()}`;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

const INSOLVENCY = /upadło|upadl|likwidac|restruktury|niewypłacaln|układ z wierzycielami|sanacj/i;
const TAX = /podat|vat\b|skarbow|akcyz|ordynacj/i;

/** Odczyt odpowiedzi API wyszukiwania SAOS (`items`). Pomija pozycje bez identyfikatora. */
export function parseSaosSearch(json: unknown): CourtDecision[] {
  const decisions: CourtDecision[] = [];
  for (const item of arr(obj(json)?.items).map(obj)) {
    const id = typeof item?.id === 'number' ? item.id : Number(item?.id);
    if (!item || !Number.isInteger(id) || id <= 0) continue;
    const division = obj(item.division);
    const keywords = arr(item.keywords).map(str).filter((value): value is string => Boolean(value));
    const excerpt = (str(item.textContent) ?? '').replace(/<\/?em>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    const haystack = `${keywords.join(' ')} ${excerpt}`;
    decisions.push({
      id,
      url: `${SAOS_JUDGMENT_PAGE}/${id}`,
      apiUrl: str(item.href) ?? `https://www.saos.org.pl/api/judgments/${id}`,
      caseNumbers: arr(item.courtCases).map((value) => str(obj(value)?.caseNumber)).filter((value): value is string => Boolean(value)),
      ...(str(obj(division?.court)?.name) ? { court: str(obj(division?.court)?.name)! } : {}),
      ...(str(division?.name) ? { division: str(division?.name)! } : {}),
      courtType: str(item.courtType) ?? 'UNKNOWN',
      ...(str(item.judgmentType) ? { judgmentType: str(item.judgmentType)! } : {}),
      ...(str(item.judgmentDate) ? { date: str(item.judgmentDate)! } : {}),
      keywords: keywords.slice(0, 8),
      excerpt,
      insolvency: INSOLVENCY.test(haystack),
      tax: TAX.test(haystack),
    });
  }
  return decisions;
}

const JUDGMENT_TYPE: Record<string, string> = { SENTENCE: 'wyrok', DECISION: 'postanowienie', RESOLUTION: 'uchwała', REGULATION: 'zarządzenie', REASONS: 'uzasadnienie' };

/** Krótki opis orzeczenia po polsku: „wyrok, Sąd Okręgowy w Warszawie, I C 605/26, 2026-10-09”. */
export function courtDecisionLabel(decision: CourtDecision): string {
  return [JUDGMENT_TYPE[decision.judgmentType ?? ''] ?? 'orzeczenie', decision.court, decision.caseNumbers.join(', ') || undefined, decision.date].filter(Boolean).join(', ');
}

export interface SaosOptions {
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  userAgent?: string;
}

/** Jedno zapytanie do API wyszukiwania SAOS (fraza = nazwa organizacji). Nigdy nie rzuca wyjątku. */
export async function searchCourtDecisions(phrase: string, options: SaosOptions = {}): Promise<{ decisions: CourtDecision[]; url: string; error?: string }> {
  const url = saosSearchUrl(phrase);
  try {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const response = await (options.fetch ?? fetch)(url, { headers: { Accept: 'application/json', ...(options.userAgent ? { 'User-Agent': options.userAgent } : {}) }, signal });
    if (!response.ok) return { decisions: [], url, error: `kod ${response.status}` };
    return { decisions: parseSaosSearch(await response.json()), url };
  } catch (error) {
    return { decisions: [], url, error: error instanceof Error ? error.message : String(error) };
  }
}
