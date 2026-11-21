// Przebieg analizy: od identyfikatorów podmiotu do listy powiązań podmiot–adres.
// Funkcja nie zna konkretnych źródeł ani sieci — dostaje łączniki i dostawców
// danych blockchain przez parametry, więc da się ją testować atrapami.

import { createHash } from 'node:crypto';
import { computeConfidence, DEFAULT_RULES, detectOwnershipDeclaration, extractAddresses, TEXT_OWNERSHIP_RULE, validateAddress } from '@olcys/core';
import type { OwnershipBasis, OwnershipDeclaration } from '@olcys/core';
import { AI_RULES } from './ai-rules.ts';
import { BENEFICIARY_RULES, OFFICIAL_SITE_CONNECTOR, attributeBeneficiary, beneficiaryNote, charityClass, collectBeneficiaryMentions, officialSiteUrl } from './beneficiary.ts';
import type { BeneficiaryAttribution, OfficialSiteCheck } from './beneficiary.ts';
import { buildOrganizationNetwork, krsNumbersIn } from './org-network.ts';
import type { OrganizationNetwork, OrgSeed } from './org-network.ts';
import type { InsightEvidence } from './ai-rules.ts';
import { createLimiter } from './concurrency.ts';
import { unlabeledCounterparties } from './counterparties.ts';
import { buildProfileNodes } from './entity.ts';
import { assessIdentity, assessLinkedProfile, isUniqueType, matchRank, normalize as normalizeName } from './identity.ts';
import type { IdentityAssessment } from './identity.ts';
import { addressKey, sightingKey } from './intel.ts';
import { mentionsInDocument } from './services.ts';
import { detectFiatSignals } from './fiat-signals.ts';
import { businessTextOf } from './business.ts';
import type { AuthorComparison, DiscoveryStep, ExpansionStop, MentionSummary, QueryTiming, RunIntel, Sighting, SightingRole, SourceError, StageTiming, StopReason } from './intel.ts';
import { comparablePairs } from './persons.ts';
import { PIVOT_LIMITS, runPivot } from './pivot.ts';
import type { PivotLead, PivotSource } from './pivot.ts';
import type {
  AiAssistant,
  AnalysisRun,
  ChainActivity,
  ChainProvider,
  ConnectorContext,
  Finding,
  Identifier,
  IdentityMatch,
  Network,
  ScoreRules,
  SourceCategory,
  SourceConnector,
  SourceDocument,
  StoredEvidence,
  SubjectQuery,
} from '@olcys/core';

/** Kopia pobranej treści — zapisywana jako element łańcucha dowodowego. */
export interface CapturedDocument {
  contentHash: string;
  url: string;
  title: string;
  service: string;
  connectorId: string;
  author?: string;
  publishedAt?: string;
  archivedAt?: string;
  fetchedAt: string;
  text: string;
}

/**
 * Sposób uzyskania danych blockchain z listy dostawców. `undefined` oznacza brak danych.
 * Zgodny z `getActivityFromProviders` z `@olcys/chain`.
 */
export type ActivityResolver = (
  providers: ChainProvider[],
  network: Network,
  address: string,
  context: ConnectorContext,
) => Promise<ChainActivity | undefined>;

export interface AnalysisParams {
  query: SubjectQuery;
  connectors: SourceConnector[];
  chainProviders: ChainProvider[];
  /** Domyślnie: pierwszy dostawca obsługujący sieć, który odpowie bez błędu. */
  resolveActivity?: ActivityResolver;
  rules?: ScoreRules;
  now?: () => Date;
  /** Dodatkowy odbiorca wpisów dziennika (np. log serwera). */
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Limit czasu jednego zapytania do źródła lub dostawcy. */
  timeoutMs?: number;
  /** Ile kolejnych kroków wyszukiwania po identyfikatorach odkrytych w profilach. */
  discoveryDepth?: number;
  /** Górny limit liczby identyfikatorów w analizie (podane + odkryte). */
  maxIdentifiers?: number;
  /** Ilu największych kontrahentów bez etykiety sprawdzić w źródłach. */
  maxCounterparties?: number;
  /** Ile zapytań do źródeł i dostawców może trwać jednocześnie. */
  concurrency?: number;
  /** Najwyżej tyle adresów dostaje analizę blockchain (najlepiej udokumentowane najpierw). */
  maxChainAddresses?: number;
  /**
   * Budżet zapytań całej analizy: każde zapytanie do łącznika (łącznik × identyfikator) i każde
   * wywołanie dostawcy danych blockchain. Po wyczerpaniu kolejne zapytania są pomijane z powodem
   * zatrzymania `request_budget`; wynik obejmuje to, co zebrano do tej chwili.
   */
  maxRequests?: number;
  /** Od ilu niepowiązanych autorów adres uznajemy za powszechnie cytowany i nikomu go nie przypisujemy. */
  widelyCitedAuthors?: number;
  /** Limit czasu całej analizy; po jego upływie zwracany jest wynik częściowy. */
  totalTimeoutMs?: number;
  /**
   * Czy łącznik jest źródłem wyszukiwawczym (dopasowuje po fragmencie treści). Jego dokument
   * jest przypisywany osobie tylko przy zgodnym autorze albo unikalnym identyfikatorze w treści.
   */
  isSearchSource?: (connectorId: string) => boolean;
  /**
   * Czy łącznik jest kosztowną wyszukiwarką obiegającą wiele serwisów (jedno zapytanie trwa
   * kilkanaście sekund). Takie źródła pytamy tylko o najważniejsze identyfikatory i adresy.
   */
  isBroadSearch?: (connectorId: string) => boolean;
  /** Limit czasu zapytania dla wybranych łączników (np. wyszukiwarka wielu forów potrzebuje więcej). */
  connectorTimeouts?: Record<string, number>;
  /** Sprowadza nietypowe zapisy adresów w treści do postaci wykrywalnej (np. ze spacjami); domyślnie bez zmian. */
  normalizeText?: (text: string) => string;
  /** Ilu najwyżej różnych autorów może wymieniać dane kontaktowe podmiotu, by wzmianki uznać za jego publikacje. */
  maxMentionAuthors?: number;
  /** Po ilu niepowiązanych autorach przestajemy zbierać wzmianki o identyfikatorze w kolejnych źródłach wyszukiwawczych. */
  mentionStopAuthors?: number;
  /** Pętla rozszerzania (inne tożsamości, adresy powiązane): liczba kroków i zapytań na krok; `steps: 0` ją wyłącza. */
  pivot?: { steps: number; queriesPerStep: number };
  /** Okres, którego ma dotyczyć historia blockchain (daty ISO); przekazywany dostawcom danych. */
  period?: { from?: string; to?: string };
  /** Model językowy (opcjonalny): odczyt publikacji i porównanie autorów. */
  ai?: AiAssistant;
  maxAiPublications?: number;
  /** Odbiorca postępu — do pokazania analitykowi w trakcie długiej analizy. */
  onProgress?: (progress: AnalysisProgress) => void;
  /**
   * Sieć organizacji z rejestrów publicznych (KRS, Wikidata, GLEIF, ProPublica) dla organizacji wskazanych w analizie.
   * Domyślnie włączona tylko przy źródłach na żywo (łączniki `live-*`); `false` wyłącza; `fetch` — atrapa w testach.
   */
  registries?: false | { fetch?: typeof fetch };
  /** Analiza w trybie głębokim (krok 2 sieci organizacji: inne podmioty osób w rejestrze). */
  deep?: boolean;
}

export type AnalysisStage = 'search' | 'occurrences' | 'chain' | 'counterparties' | 'pivot' | 'ai' | 'scoring';

export interface AnalysisProgress {
  stage: AnalysisStage;
  /** Zakończone i wszystkie dotąd zlecone zapytania do łączników (łącznik × identyfikator). */
  connectorsDone: number;
  connectorsTotal: number;
  documents: number;
  addresses: number;
}

/** Adres w wyniku analizy z lokalnymi adnotacjami (poza kontraktem `Finding`). */
export type AnalysisFinding = Omit<Finding, 'evidence'> & {
  evidence: InsightEvidence[];
  /** Adres cytowany przez bardzo wielu autorów — nie jest przypisywany osobie. */
  widelyCited?: boolean;
  /** Analizę blockchain pominięto z powodu limitu adresów, czasu albo budżetu zapytań. */
  chainSkipped?: boolean;
  /** Żaden dostawca danych blockchain nie odpowiedział dla tego adresu — `chain` jest puste, żadnych kwot nie przyjęto. */
  chainUnavailable?: boolean;
  /**
   * Adres opublikowany przez powiązaną tożsamość (pętla rozszerzania), a nie przez podmiot.
   * Nie jest przypisany podmiotowi; `linkedScore` to Wskaźnik Pewności względem autora publikacji.
   */
  linkedOnly?: boolean;
  linkedScore?: number;
  notes?: string[];
};

/** Domyślnie: indeks własny, wyszukiwarka forów, źródła monitoringu i wszystko z „search” w nazwie. */
export const defaultIsSearchSource = (connectorId: string): boolean =>
  connectorId === 'corpus' || connectorId === 'deep-search' || connectorId.startsWith('mon-') || connectorId.includes('search');

/** Domyślnie: wyszukiwarka forów, źródła monitoringu i wszystko z „search” w nazwie (bez indeksu własnego — jest lokalny). */
export const defaultIsBroadSearch = (connectorId: string): boolean => connectorId !== 'corpus' && defaultIsSearchSource(connectorId);

/**
 * Kontekst zapytania do dostawcy danych blockchain (lokalne rozszerzenie `ConnectorContext`):
 * adres będący przedmiotem sprawy dostaje pełną historię, pozostałe — najnowszą.
 */
export interface ChainContext extends ConnectorContext {
  history: 'recent' | 'full';
  since?: string;
  until?: string;
}

/**
 * Publikacje, które same w sobie wskazują właściciela adresu: własny profil, dowód kryptograficzny,
 * oferta lub wiadomość z adresem do wpłaty. Wypowiedź na forum czy komentarz to tylko wzmianka.
 */
export const OWNERSHIP_CATEGORIES: SourceCategory[] = ['own_profile', 'cryptographic_proof', 'sale_offer', 'settlement_message'];
/**
 * Kategorie, w których deklarację „to mój adres” wolno odczytać regułą tekstową (`detectOwnershipDeclaration`):
 * tylko wypowiedź na forum — nie masowy komentarz (rozdania, konkursy). Taka wypowiedź zachowuje swoją
 * kategorię i wagę (50); reguła ma niższą moc niż kategorie z `OWNERSHIP_CATEGORIES` i niż odczyt modelu.
 */
export const TEXT_DECLARATION_CATEGORIES: SourceCategory[] = ['forum_post'];
/**
 * Publikacja z tyloma różnymi adresami to lista lub zestawienie (np. „najbogatsze adresy”), a nie
 * czyjś własny adres: nie jest przesłanką własności ani powiązania między osobami.
 */
export const ADDRESS_LIST_MIN = 10;
/** Adres opublikowany przez tylu niezależnych autorów nie wskazuje żadnego z nich jako właściciela ani kontrahenta. */
export const MANY_PUBLISHERS_MIN = 3;
/** Najwyżej tyle wzmianek o adresie czyta model, szukając autora podającego adres jako własny. */
const MAX_OWNERSHIP_READS = 10;

/** Plik kodu w repozytorium (`…/blob/…`), ale nie tekst dla ludzi (README, *.md, *.txt, *.rst). */
export const isCodeFile = (url: string): boolean => /\/blob\//.test(url) && !/(\.(md|markdown|txt|rst)|\/readme[^/]*)$/i.test(url.replace(/[?#].*$/, ''));

/** Adres publikacji do porównań: bez `www.`, fragmentu, parametrów śledzących i końcowego ukośnika. */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref_src$)/i.test(key)) url.searchParams.delete(key);
    return `${url.protocol}//${url.hostname.toLowerCase().replace(/^www\./, '')}${url.port ? `:${url.port}` : ''}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return raw.trim();
  }
}

export interface AnalysisResult {
  findings: AnalysisFinding[];
  log: { time: string; message: string }[];
  documents: CapturedDocument[];
  /** Profile, ścieżka odkrywania i publikacje innych osób — materiał do teczki. */
  intel: RunIntel;
}

interface AddressGroup {
  address: string;
  network: Network;
  checksumVerified: boolean;
  evidence: Map<string, InsightEvidence>;
  /** Autorzy publikujący adres, których nie da się powiązać z podmiotem. */
  unrelatedAuthors: Set<string>;
  /** Wiedza o adresie z publikacji bez autora (np. serwisy ostrzegające) — adnotacje, nie ślady osoby. */
  notes: string[];
  /** Adres znany tylko z publikacji powiązanej tożsamości. */
  linkedOnly?: boolean;
  chain?: ChainActivity;
}

/** Identyfikator czekający na wyszukanie w kolejnym kroku. */
interface Pending {
  identifier: Identifier;
  /** Ocena dziedziczona po dokumencie, który identyfikator wskazał. */
  match: IdentityMatch;
  distance: number;
  /** Identyfikator, po którym znaleziono dokument wskazujący. */
  parent?: Identifier;
  /**
   * Nazwa (np. ENS) wymieniona w publikacji, a nie wskazana przez profil: jej dokumenty przyjmujemy
   * tylko wtedy, gdy prowadzą do adresu już przypisanego podmiotowi.
   */
  requireKnownAddress?: boolean;
  /** Identyfikator pytamy tylko w źródłach bezpośrednich (bez kosztownych wyszukiwarek). */
  directOnly?: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_DISCOVERY_DEPTH = 3;
export const DEFAULT_MAX_IDENTIFIERS = 40;
export const DEFAULT_MAX_COUNTERPARTIES = 10;
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_MAX_CHAIN_ADDRESSES = 15;
/** Domyślny budżet zapytań analizy — z dużym zapasem; zwykła analiza zużywa kilkadziesiąt–kilkaset zapytań. */
export const DEFAULT_MAX_REQUESTS = 5000;
/**
 * Wiarygodność źródeł przy rozwijaniu: z jakich dokumentów NIE bierzemy identyfikatorów do dalszego wyszukiwania.
 * - kategorie o niskiej wiarygodności (masowe komentarze: konkursy, rozdania) — nigdy;
 * - dokumenty słabo przypisane podmiotowi (zgodne tylko nazwisko albo pospolity nick) — tylko wtedy,
 *   gdy znaleziono je wprost po identyfikatorze analityka (krok < `weakFollowSteps`); taki identyfikator
 *   dziedziczy słabą ocenę i trafia wyłącznie do źródeł bezpośrednich. Łańcuch „słaby → słaby” jest ucinany.
 */
export const EXPANSION_RELIABILITY: { lowReliabilityCategories: SourceCategory[]; weakMatches: IdentityMatch[]; weakFollowSteps: number } = {
  lowReliabilityCategories: ['mass_comment'],
  weakMatches: ['name_only', 'common_handle'],
  weakFollowSteps: 1,
};
/** Komunikaty, którymi łącznik sam zgłasza niedostępność źródła, zwracając to, co zdążył pobrać. */
const REPORTED_FAILURE = /błąd podczas|nie udało się pobrać|kod (?:5\d\d|429)(?!\d)/i;
/** Stała kolejność etapów w wykazie powodów zatrzymania i błędów źródeł. */
const STAGE_ORDER = ['search', 'occurrences', 'chain', 'counterparties', 'pivot', 'organizations', 'ai', 'scoring'];
const stageRank = (stage: string) => STAGE_ORDER.indexOf(stage) + 1 || STAGE_ORDER.length + 1;
const REASON_ORDER: StopReason[] = ['aborted', 'time_limit', 'request_budget', 'depth_limit', 'identifier_limit', 'query_limit', 'counterparty_limit', 'chain_address_limit', 'low_reliability', 'source_error', 'no_new_leads'];
export const DEFAULT_WIDELY_CITED_AUTHORS = 10;
export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_MENTION_AUTHORS = 3;
export const DEFAULT_MENTION_STOP_AUTHORS = 30;
/** Od jakiej wartości śladu (punkty bazowe z korektą tożsamości) analiza blockchain adresu startuje od razu. */
const EARLY_CHAIN_STRENGTH = 70;
/** Ile analiz blockchain trwa jednocześnie (osobny limit — nie czekają w kolejce za wyszukiwaniem). */
const CHAIN_CONCURRENCY = 3;
/** Jaka część limitu czasu przypada na wyszukiwanie, a jaka na wystąpienia adresów; reszta to blockchain i ocena. */
/** Ile identyfikatorów odkrytych (tylko z profili potwierdzonych) trafia do kosztownych wyszukiwarek. */
const MAX_BROAD_DISCOVERED = 3;
/** Ile adresów podmiotu i ilu kontrahentów sprawdzamy w kosztownych wyszukiwarkach; reszta tylko w źródłach bezpośrednich. */
const MAX_BROAD_ADDRESSES = 5;
const MAX_BROAD_COUNTERPARTIES = 3;
const SEARCH_TIME_SHARE = 0.6;
const OCCURRENCE_TIME_SHARE = 0.8;
/** Najwyżej tyle par profili porównuje model językowy w jednej analizie. */
const MAX_AUTHOR_COMPARISONS = 10;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Sygnały działalności gospodarczej (wskaźnik D) zapisywane przy widzianym dokumencie; pusty obiekt, gdy brak sygnałów. */
/** Oznaki wyjścia do fiat (wskaźnik C, Web2) z treści i opisu profilu dokumentu podmiotu. */
const fiatSignalsOf = (doc: SourceDocument) => detectFiatSignals([doc.text, doc.profile?.bio ?? ''].join('\n'));

const withBusinessText = (doc: SourceDocument): { businessText?: NonNullable<Sighting['businessText']> } => {
  const businessText = businessTextOf(doc);
  return businessText ? { businessText } : {};
};

const identifierKey = (identifier: Identifier) => `${identifier.type}:${identifier.value.trim().toLowerCase()}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Liczba niepowiązanych publikujących brana do oceny. Dowód kryptograficzny albo potwierdzona
 * tożsamość profilu ma pierwszeństwo przed liczbą cytujących: adres znanej osoby cytuje wielu,
 * co nie podważa jego własności.
 */
export function effectiveUnrelatedPublishers(evidence: StoredEvidence[], unrelatedPublishers: number): number {
  return evidence.some((item) => item.category === 'cryptographic_proof' || item.identityMatch === 'verified_link') ? 0 : unrelatedPublishers;
}

/** Wykonuje zapytanie z limitem czasu; przerwanie przekazuje też do wywoływanego kodu. */
async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outer?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(new Error(timeout.aborted ? `przekroczono limit czasu ${timeoutMs} ms` : 'analiza przerwana'));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([run(signal), aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export async function runAnalysis(params: AnalysisParams): Promise<AnalysisResult> {
  const rules = params.rules ?? DEFAULT_RULES;
  const now = params.now ?? (() => new Date());
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const depth = Math.max(0, params.discoveryDepth ?? DEFAULT_DISCOVERY_DEPTH);
  const maxIdentifiers = params.maxIdentifiers ?? DEFAULT_MAX_IDENTIFIERS;
  const maxCounterparties = params.maxCounterparties ?? DEFAULT_MAX_COUNTERPARTIES;
  // Jeden limit na całą analizę: obejmuje i źródła, i dostawców danych blockchain.
  const limited = createLimiter(params.concurrency ?? DEFAULT_CONCURRENCY);
  const journal: { time: string; message: string }[] = [];
  const log = (message: string) => {
    journal.push({ time: now().toISOString(), message });
    params.log?.(message);
  };

  const runStartedAt = now().toISOString();

  // ---------- Kontrola rozszerzania: budżet zapytań, powtórzenia, powody zatrzymania, błędy źródeł ----------

  const maxRequests = Math.max(0, Math.floor(params.maxRequests ?? DEFAULT_MAX_REQUESTS));
  const requests = { connectors: 0, chain: 0 };
  const duplicates = { queries: 0, identifiers: 0, documents: 0 };
  const stops: ExpansionStop[] = [];
  const addStop = (stage: string, reason: StopReason, detail: string, skipped?: number) => {
    stops.push({ stage, reason, detail, ...(skipped !== undefined ? { skipped } : {}) });
  };
  /** Zapytania pominięte po wyczerpaniu budżetu, według etapu. */
  const budgetSkipped = new Map<string, number>();
  let budgetLogged = false;
  /** Rezerwuje jedno zapytanie w budżecie analizy; `false`, gdy budżet jest wyczerpany. */
  const reserveRequest = (kind: 'connectors' | 'chain', stage: string): boolean => {
    if (requests.connectors + requests.chain < maxRequests) {
      requests[kind]++;
      return true;
    }
    budgetSkipped.set(stage, (budgetSkipped.get(stage) ?? 0) + 1);
    if (!budgetLogged) {
      budgetLogged = true;
      log(
        `Wyczerpano budżet zapytań analizy (${maxRequests}) — kolejne zapytania do źródeł i dostawców danych blockchain są pomijane; ` +
          'wynik obejmuje to, co zebrano do tej chwili.',
      );
    }
    return false;
  };
  /** Błędy źródeł i dostawców zebrane według (etap, źródło) — jedno źródło to jeden wpis z licznikiem. */
  const sourceErrors = new Map<string, SourceError>();
  const noteSourceError = (entry: { connectorId?: string; providerId?: string; stage: string; message: string; address?: string; reported?: boolean }) => {
    const key = `${entry.stage}|${entry.connectorId ?? ''}|${entry.providerId ?? ''}|${entry.reported ? 'r' : ''}`;
    const existing = sourceErrors.get(key);
    if (existing) {
      existing.count++;
      if (entry.address && !existing.addresses?.includes(entry.address)) (existing.addresses ??= []).push(entry.address);
      return;
    }
    sourceErrors.set(key, {
      ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      stage: entry.stage,
      message: entry.message,
      count: 1,
      ...(entry.address ? { addresses: [entry.address] } : {}),
      ...(entry.reported ? { reported: true } : {}),
    });
  };

  const normalizeText = params.normalizeText ?? ((text: string) => text);
  /** Adresy w treści — po sprowadzeniu nietypowych zapisów do postaci wykrywalnej. */
  const extract = (text: string) => extractAddresses(normalizeText(text));

  /** Deklaracja własności adresu w treści wypowiedzi (reguła tekstowa); `undefined` dla kategorii, których reguła nie czyta. */
  // Fragment pliku z kodu (np. wynik wyszukiwarki kodu GitHuba, adres `/blob/`) to nie wypowiedź: przykłady, wektory
  // testowe i konfiguracje często zawierają cudze adresy z etykietą „donate:” albo komentarzem „my wallet”.
  const declarationIn = (doc: SourceDocument, address: string): OwnershipDeclaration | undefined =>
    TEXT_DECLARATION_CATEGORIES.includes(doc.category) && !isCodeFile(doc.url) ? detectOwnershipDeclaration(normalizeText(doc.text), address) : undefined;

  /** Czy publikacja jest listą adresów (zestawieniem), a nie publikacją czyjegoś adresu. */
  const isAddressList = (doc: SourceDocument): boolean => new Set(extract(doc.text).map((item) => item.address)).size >= ADDRESS_LIST_MIN;

  const groups = new Map<string, AddressGroup>();
  const documents = new Map<string, CapturedDocument>();
  const sightings = new Map<string, Sighting>();

  // Limit czasu całej analizy liczymy zegarem monotonicznym, niezależnym od wstrzykniętego `now`.
  const startedAt = performance.now();
  const totalMs = params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const deadline = startedAt + totalMs;
  let partial = false;
  /** `share`: jaka część limitu czasu przypada na dany rodzaj pracy — reszta zostaje na kolejne fazy. */
  const expired = (what: string, share = 1): boolean => {
    if (performance.now() < startedAt + totalMs * share) return false;
    if (!partial) {
      log(`Przekroczono limit czasu całej analizy — ${what} i dalsze kroki pominięto; wynik jest częściowy.`);
      addStop(progress.stage, 'time_limit', `Przekroczono limit czasu całej analizy (${Math.round(totalMs / 1000)} s) — ${what} i dalsze kroki pominięto.`);
    }
    partial = true;
    return true;
  };

  const progress: AnalysisProgress = { stage: 'search', connectorsDone: 0, connectorsTotal: 0, documents: 0, addresses: 0 };
  // Pomiar czasu: fazy w kolejności wykonania oraz każde zapytanie do łącznika.
  const timings: StageTiming[] = [];
  const queries: QueryTiming[] = [];
  let phase = { name: 'search-0', since: startedAt };
  /** Zamyka bieżącą fazę pomiaru i otwiera następną. */
  const enterPhase = (name: string) => {
    const at = performance.now();
    timings.push({ stage: phase.name, ms: Math.round(at - phase.since) });
    phase = { name, since: at };
  };
  const report = (stage?: AnalysisStage) => {
    if (stage && stage !== progress.stage) enterPhase(stage);
    if (stage) progress.stage = stage;
    progress.documents = sightings.size;
    progress.addresses = groups.size;
    params.onProgress?.({ ...progress });
  };

  // Ten sam post widziany przez różne łączniki: jeden adres publikacji i jedna kopia treści.
  const isSearchSource = params.isSearchSource ?? defaultIsSearchSource;
  const isBroadSearch = params.isBroadSearch ?? defaultIsBroadSearch;
  const firstUrl = new Map<string, string>();
  const contentSeen = new Map<string, string>();
  const dedupe = (doc: SourceDocument): SourceDocument | undefined => {
    const canonical = canonicalUrl(doc.url);
    const known = firstUrl.get(canonical);
    if (!known) firstUrl.set(canonical, doc.url);
    const url = known ?? doc.url;
    const contentKey = `${doc.service.toLowerCase()}|${normalizeName(doc.author ?? '')}|${doc.archivedAt ?? ''}|${sha256Hex(doc.text)}`;
    const sameContentAt = contentSeen.get(contentKey);
    if (sameContentAt && sameContentAt !== canonical) return undefined;
    contentSeen.set(contentKey, canonical);
    return url === doc.url ? doc : { ...doc, url };
  };

  const groupFor = (network: Network, address: string, checksumVerified: boolean): AddressGroup => {
    const key = `${network}:${address}`;
    let group = groups.get(key);
    if (!group) {
      group = { address, network, checksumVerified, evidence: new Map(), unrelatedAuthors: new Set(), notes: [] };
      groups.set(key, group);
    }
    // Wystarczy jedno wystąpienie z poprawną sumą kontrolną.
    group.checksumVerified ||= checksumVerified;
    return group;
  };

  const capture = (doc: SourceDocument, contentHash: string) => {
    documents.set(`${contentHash}|${doc.url}`, {
      contentHash,
      url: doc.url,
      title: doc.title,
      service: doc.service,
      connectorId: doc.connectorId,
      author: doc.author,
      publishedAt: doc.publishedAt,
      archivedAt: doc.archivedAt,
      fetchedAt: doc.fetchedAt,
      text: doc.text,
    });
  };

  /** Zapamiętuje dokument jako widziany profil; przy powtórce zostaje mocniejsza ocena tożsamości. */
  const noteSighting = (
    doc: SourceDocument,
    identity: IdentityAssessment,
    role: SightingRole,
    step: number,
    addresses: string[],
  ) => {
    const key = sightingKey(doc);
    const existing = sightings.get(key);
    if (!existing) {
      sightings.set(key, {
        url: doc.url,
        service: doc.service,
        connectorId: doc.connectorId,
        title: doc.title,
        author: doc.author,
        publishedAt: doc.publishedAt,
        archivedAt: doc.archivedAt,
        fetchedAt: doc.fetchedAt,
        category: doc.category,
        profile: doc.profile,
        matchedIdentifier: doc.matchedIdentifier,
        discoveredIdentifiers: doc.discoveredIdentifiers ?? [],
        identity,
        step,
        addresses: [...addresses],
        role,
        // Wzmianek o usługach szukamy tylko w treściach samego podmiotu.
        ...(role === 'subject' ? { serviceMentions: mentionsInDocument(doc), fiatSignals: fiatSignalsOf(doc) } : {}),
        // Sygnały działalności gospodarczej (wskaźnik D) z pełnej treści — teczka nie ma treści dokumentów.
        ...withBusinessText(doc),
      });
      return;
    }
    for (const address of addresses) if (!existing.addresses.includes(address)) existing.addresses.push(address);
    // Dokument przypisany podmiotowi nie wraca do roli „inna osoba”.
    if (role !== 'subject') return;
    if (existing.role !== 'subject' || matchRank(identity.match) > matchRank(existing.identity.match)) {
      if (existing.role !== 'subject') {
        existing.serviceMentions = mentionsInDocument(doc);
        existing.fiatSignals = fiatSignalsOf(doc);
      }
      existing.role = 'subject';
      existing.identity = identity;
      existing.matchedIdentifier = doc.matchedIdentifier;
      existing.step = Math.min(existing.step, step);
    }
  };

  // ---------- Dane blockchain: start, gdy tylko adres ma mocny ślad ----------

  const resolveActivity = params.resolveActivity ?? firstWorkingProvider;
  /** Co stało się z zapytaniami o adres: czy któryś dostawca odpowiedział, kto zawiódł, czy zabrakło budżetu. */
  const chainOutcomes = new Map<string, { ok: boolean; budget: boolean; failures: { providerId: string; message: string }[] }>();
  const outcomeFor = (key: string) => {
    let outcome = chainOutcomes.get(key);
    if (!outcome) chainOutcomes.set(key, (outcome = { ok: false, budget: false, failures: [] }));
    return outcome;
  };
  // Każde wywołanie dostawcy liczy się do budżetu zapytań; błędy dostawców zapamiętujemy per adres,
  // żeby odróżnić „inny dostawca odpowiedział” od „nikt nie odpowiedział” (wtedy nie przyjmujemy żadnych liczb).
  const chainProviders: ChainProvider[] = params.chainProviders.map((provider) => ({
    ...provider,
    id: provider.id,
    label: provider.label,
    supports: (network, address) => provider.supports(network, address),
    getActivity: async (network, address, context) => {
      const outcome = outcomeFor(addressKey({ network, address }));
      if (!reserveRequest('chain', 'chain')) {
        outcome.budget = true;
        throw new Error('wyczerpano budżet zapytań analizy');
      }
      try {
        const activity = await provider.getActivity(network, address, context);
        outcome.ok = true;
        return activity;
      } catch (error) {
        if (!context.signal?.aborted) outcome.failures.push({ providerId: provider.id, message: errorText(error) });
        throw error;
      }
    },
  }));
  /** Adresy bez analizy łańcucha z powodu budżetu zapytań oraz adresy, dla których dostawcy nie odpowiedzieli. */
  const chainBudgetSkipped = new Set<AddressGroup>();
  const chainUnavailable = new Map<AddressGroup, string>();
  const chainLimited = createLimiter(CHAIN_CONCURRENCY);
  const chainLimit = params.maxChainAddresses ?? DEFAULT_MAX_CHAIN_ADDRESSES;
  const chainJobs = new Map<AddressGroup, Promise<void>>();
  /** Uruchamia analizę blockchain adresu (raz); zwraca `undefined`, gdy limit adresów jest wyczerpany. */
  const subjectAddresses = new Set(
    params.query.identifiers.filter((item) => item.type === 'crypto_address').map((item) => item.value.trim().toLowerCase()),
  );
  /** Adres podany przez analityka jest przedmiotem sprawy: dostawca ma sięgnąć po pełną historię. */
  const chainContext = (group: AddressGroup, signal: AbortSignal): ChainContext => ({
    signal,
    log,
    history: subjectAddresses.has(group.address.toLowerCase()) ? 'full' : 'recent',
    ...(params.period?.from ? { since: params.period.from } : {}),
    ...(params.period?.to ? { until: params.period.to } : {}),
  });
  const startChain = (group: AddressGroup): Promise<void> | undefined => {
    const running = chainJobs.get(group);
    if (running || chainJobs.size >= chainLimit) return running;
    const job = chainLimited(async () => {
      if (expired('analizę blockchain części adresów')) return;
      const key = addressKey(group);
      if (chainProviders.length > 0 && requests.connectors + requests.chain >= maxRequests) {
        // Budżet wyczerpany przed pierwszym zapytaniem o ten adres.
        reserveRequest('chain', 'chain');
        chainBudgetSkipped.add(group);
        return;
      }
      let failure: string | undefined;
      try {
        group.chain = await withTimeout(
          (signal) => resolveActivity(chainProviders, group.network, group.address, chainContext(group, signal)),
          // Limit obejmuje kolejne próby u wszystkich dostawców.
          timeoutMs * Math.max(1, chainProviders.length),
          params.signal,
        );
      } catch (error) {
        failure = errorText(error);
        log(`${group.address}: BŁĄD pobierania danych blockchain: ${failure}.`);
      }
      const outcome = chainOutcomes.get(key);
      const answered = outcome?.ok === true;
      if (!answered && outcome?.budget && outcome.failures.length === 0 && failure === undefined) {
        // Zapytanie zatrzymał budżet, a strategia wyboru dostawcy zwróciła wynik zastępczy — nie przyjmujemy go.
        group.chain = undefined;
        chainBudgetSkipped.add(group);
        return;
      }
      if (!answered && ((outcome?.failures.length ?? 0) > 0 || failure !== undefined) && !params.signal?.aborted) {
        // Żaden dostawca nie odpowiedział: wynik zastępczy (same zera) wprowadzałby w błąd, więc adres zostaje bez danych.
        group.chain = undefined;
        const failures = outcome?.failures.length
          ? outcome.failures
          : chainProviders.filter((provider) => provider.supports(group.network, group.address)).map((provider) => ({ providerId: provider.id, message: failure ?? 'brak odpowiedzi' }));
        for (const item of failures) noteSourceError({ providerId: item.providerId, stage: 'chain', message: item.message, address: key });
        const reason = failures.map((item) => `${item.providerId}: ${item.message}`).join('; ') || failure || 'brak odpowiedzi';
        chainUnavailable.set(group, reason);
        log(`${group.address}: dane blockchain NIEDOSTĘPNE — żaden dostawca nie odpowiedział (${reason}). Adres pozostaje bez danych z łańcucha; żadnych kwot nie przyjęto.`);
        return;
      }
      if (!group.chain) log(`${group.address}: brak danych blockchain — adres pozostaje bez klasyfikacji.`);
    });
    chainJobs.set(group, job);
    return job;
  };

  const addEvidence = (
    group: AddressGroup,
    doc: SourceDocument,
    identity: IdentityAssessment,
    excerpt: string,
    contentHash: string,
    ownershipBasis?: OwnershipBasis,
  ) => {
    // Ten sam dokument (URL + wersja) jest jednym śladem, nawet jeśli zwróciło go kilka zapytań.
    const id = `ev-${sha256Hex(`${doc.url}|${doc.archivedAt ?? ''}|${group.network}:${group.address}`).slice(0, 12)}`;
    const existing = group.evidence.get(id);
    if (existing) {
      // Liczy się najmocniejsza droga dojścia do dokumentu (np. e-mail zamiast samego nicku).
      if (matchRank(identity.match) > matchRank(existing.identityMatch)) {
        existing.identityMatch = identity.match;
        existing.identityReasons = identity.reasons;
        existing.matchedIdentifier = doc.matchedIdentifier;
      }
      return;
    }
    group.evidence.set(id, {
      id,
      category: doc.category,
      service: doc.service,
      url: doc.url,
      capturedAt: doc.fetchedAt,
      identityMatch: identity.match,
      identityReasons: identity.reasons,
      title: doc.title,
      author: doc.author,
      publishedAt: doc.publishedAt,
      archivedAt: doc.archivedAt,
      excerpt,
      contentHash,
      connectorId: doc.connectorId,
      matchedIdentifier: doc.matchedIdentifier,
      ...(ownershipBasis ? { ownershipBasis } : {}),
    });
    capture(doc, contentHash);
    // Mocny ślad: analiza łańcucha biegnie równolegle z dalszym wyszukiwaniem.
    if (rules.base[doc.category] + rules.identityAdjustment[identity.match] >= EARLY_CHAIN_STRENGTH) void startChain(group);
  };

  /** Niepowiązani autorzy wymieniający identyfikator w źródłach wyszukiwawczych: identyfikator → autorzy. */
  const citers = new Map<string, Set<string>>();
  /** Zapytania już wysłane w tej analizie: `łącznik|identyfikator` → odpowiedź (kontrola powtórzeń). */
  const askedQueries = new Map<string, Promise<SourceDocument[]>>();
  /** Identyfikatory, dla których przerwano zbieranie wzmianek (są powszechnie cytowane). */
  const mentionStopped = new Set<string>();
  const mentionStopAuthors = params.mentionStopAuthors ?? DEFAULT_MENTION_STOP_AUTHORS;

  /**
   * Pyta wszystkie łączniki akceptujące dany typ; błąd jednego nie zatrzymuje pozostałych.
   * `directOnly` pomija kosztowne wyszukiwarki (pytamy tylko źródła bezpośrednie: profile, rejestry, indeks własny).
   */
  const search = async (identifier: Identifier, options: { timeShare?: number; directOnly?: boolean; stage?: AnalysisStage } = {}): Promise<SourceDocument[]> => {
    const key = identifierKey(identifier);
    const stage = options.stage ?? 'search';
    const wanted = normalizeName(identifier.value);
    const accepting = params.connectors.filter(
      (connector) => connector.accepts.includes(identifier.type) && !(options.directOnly && isBroadSearch(connector.id)),
    );
    const results = await Promise.all(
      accepting.map((connector) => {
        // To samo zapytanie (łącznik × identyfikator) wysyłamy raz na analizę; kolejne etapy dostają tę samą odpowiedź.
        const queryKey = `${connector.id}|${key}`;
        const asked = askedQueries.get(queryKey);
        if (asked) {
          duplicates.queries++;
          return asked;
        }
        // Budżet rezerwujemy przy zlecaniu, w kolejności kodu — nie zależy od tego, które źródło odpowie pierwsze.
        if (!reserveRequest('connectors', stage)) return Promise.resolve<SourceDocument[]>([]);
        progress.connectorsTotal++;
        const job = limited(async (): Promise<SourceDocument[]> => {
          if (expired('wyszukiwanie w części źródeł', options.timeShare ?? SEARCH_TIME_SHARE)) {
            requests.connectors--;
            progress.connectorsDone++;
            return [];
          }
          // Identyfikator wymienia już wielu niepowiązanych autorów — kolejne wzmianki niczego nie zmienią,
          // a czas jest potrzebny na profile podmiotu i analizę łańcucha.
          if (isSearchSource(connector.id) && (citers.get(key)?.size ?? 0) > mentionStopAuthors) {
            if (!mentionStopped.has(key)) {
              mentionStopped.add(key);
              addStop(
                stage,
                'query_limit',
                `${identifier.type} „${identifier.value}”: wymienia go ponad ${mentionStopAuthors} niepowiązanych autorów — dalszych źródeł wyszukiwawczych o ten identyfikator nie pytano.`,
              );
              log(
                `${identifier.type} „${identifier.value}”: wymienia go co najmniej ${citers.get(key)!.size} niepowiązanych autorów (próg ${mentionStopAuthors}) — ` +
                  'dalsze źródła wyszukiwawcze pominięto dla tego identyfikatora.',
              );
            }
            requests.connectors--;
            progress.connectorsDone++;
            report();
            return [];
          }
          const context = (signal: AbortSignal): ConnectorContext => ({
            signal,
            log: (message) => {
              log(`[${connector.id}] ${message}`);
              // Łącznik sam obsłużył błąd źródła i zwrócił to, co miał — analityk musi o tym wiedzieć.
              // Zbiorcze podsumowanie wyszukiwarki forów („hostów N: odpowiedziało M…”) wymienia błędy pojedynczych hostów;
              // dopóki choć jeden host odpowiedział, źródło działało i nie jest zgłaszane jako niedostępne.
              const answered = /hostów \d+: odpowiedziało (\d+)/.exec(message);
              const aggregateOk = answered !== null && Number(answered[1]) > 0;
              if (!aggregateOk && REPORTED_FAILURE.test(message)) noteSourceError({ connectorId: connector.id, stage, message, reported: true });
            },
          });
          const queryStarted = performance.now();
          let documentsFound = 0;
          try {
            const found = await withTimeout(
              (signal) => connector.search(identifier, context(signal)),
              params.connectorTimeouts?.[connector.id] ?? timeoutMs,
              params.signal,
            );
            log(`[${connector.id}] ${identifier.type} „${identifier.value}”: dokumentów ${found.length}.`);
            documentsFound = found.length;
            if (isSearchSource(connector.id)) {
              const authors = citers.get(key) ?? new Set<string>();
              citers.set(key, authors);
              for (const doc of found) {
                const author = normalizeName(doc.author ?? '');
                if (author && author !== wanted) authors.add(`${doc.service.toLowerCase()}|${author}`);
              }
            }
            return found;
          } catch (error) {
            log(`[${connector.id}] BŁĄD przy ${identifier.type} „${identifier.value}”: ${errorText(error)}. Źródło pominięte.`);
            // Przerwanie całej analizy to nie awaria źródła.
            if (!params.signal?.aborted) noteSourceError({ connectorId: connector.id, stage, message: errorText(error) });
            return [];
          } finally {
            queries.push({ connectorId: connector.id, identifier, ms: Math.round(performance.now() - queryStarted), documents: documentsFound });
            progress.connectorsDone++;
            report();
          }
        });
        askedQueries.set(queryKey, job);
        return job;
      }),
    );
    const unique: SourceDocument[] = [];
    let repeated = 0;
    for (const doc of results.flat()) {
      const kept = dedupe(doc);
      if (kept) unique.push(kept);
      else repeated++;
    }
    duplicates.documents += repeated;
    if (repeated > 0) log(`Pominięto ${repeated} powtórzeń tej samej treści pod innym adresem (${identifier.type} „${identifier.value}”).`);
    return unique;
  };

  /** Czy autor dokumentu to nazwa, po której dokument znaleziono (a nie ktoś, kto ją tylko wymienia). */
  const authorMatches = (doc: SourceDocument): boolean => {
    const matched = normalizeName(doc.matchedIdentifier.value);
    const names = [doc.profile?.handle, doc.author, doc.profile?.displayName].filter((value): value is string => Boolean(value));
    return names.some((name) => normalizeName(name) === matched);
  };

  const mentions: MentionSummary[] = [];
  const maxMentionAuthors = params.maxMentionAuthors ?? DEFAULT_MAX_MENTION_AUTHORS;

  /**
   * Źródło wyszukiwawcze dopasowuje po fragmencie treści, więc zwraca też cudze wzmianki
   * o podmiocie. Dokument jest publikacją podmiotu, gdy zgadza się autor albo gdy — przy
   * niewielu autorach — treść zawiera dane kontaktowe podane przez analityka (e-mail,
   * komunikator). Nazwa wymieniana przez wielu autorów to „nazwa powszechnie cytowana”.
   */
  const attributableDocuments = (identifier: Identifier, docs: SourceDocument[]): SourceDocument[] => {
    const isMention = (doc: SourceDocument) => isSearchSource(doc.connectorId) && doc.identityMatch !== 'verified_link' && !authorMatches(doc);
    const cited = docs.filter(isMention);
    if (cited.length === 0) return docs;
    const authors = new Set(cited.map((doc) => `${doc.service.toLowerCase()}|${normalizeName(doc.author ?? doc.url)}`));
    const contacts = params.query.identifiers
      .filter((item) => (item.type === 'email' || item.type === 'messenger_id') && item.value.trim().length >= 4)
      .map((item) => item.value.trim().toLowerCase());
    const few = authors.size <= maxMentionAuthors;
    const accepted = new Set(cited.filter((doc) => few && contacts.some((contact) => doc.text.toLowerCase().includes(contact))));
    const rejected = cited.length - accepted.size;
    if (rejected > 0) {
      const services = new Set(cited.map((doc) => doc.service.toLowerCase())).size;
      mentions.push({ identifier, documents: rejected, authors: authors.size, services, ...(mentionStopped.has(identifierKey(identifier)) ? { atLeast: true } : {}) });
      log(
        `${identifier.type} „${identifier.value}”: ${rejected} publikacji ${authors.size} innych autorów w ${services} serwisach tylko wymienia ten identyfikator — ` +
          `to wzmianki${few ? '' : ' (identyfikator powszechnie cytowany)'}, nie profile podmiotu; nie przypisano ich podmiotowi.`,
      );
    }
    return docs.filter((doc) => !isMention(doc) || accepted.has(doc));
  };

  // ---------- Identyfikatory wejściowe ----------

  const inputKeys = new Set<string>();
  const personIdentifiers: Identifier[] = [];
  for (const raw of params.query.identifiers) {
    const identifier = { type: raw.type, value: raw.value.trim() };
    if (!identifier.value || inputKeys.has(identifierKey(identifier))) continue;
    inputKeys.add(identifierKey(identifier));
    if (identifier.type !== 'crypto_address') {
      personIdentifiers.push(identifier);
      continue;
    }
    const valid = validateAddress(identifier.value);
    if (!valid) {
      log(`Identyfikator „${identifier.value}” nie jest poprawnym adresem obsługiwanej sieci — pominięty.`);
      continue;
    }
    // Adres podany przez analityka jest analizowany także bez żadnej publikacji.
    void startChain(groupFor(valid.network, valid.address, valid.checksumVerified));
    log(`Adres podany przez analityka: ${valid.address} (${valid.network}).`);
  }

  /** Nazwy, pod którymi podmiot występuje: wartość → czy powiązanie jest pośrednie/słabe. */
  const knownNames = new Map<string, IdentityMatch>();
  for (const identifier of personIdentifiers) knownNames.set(normalizeName(identifier.value), 'exact_identifier');

  log(`Start analizy: identyfikatorów ${inputKeys.size}, łączników ${params.connectors.length}.`);

  // ---------- Wyszukiwanie krok po kroku: identyfikatory podane, potem odkryte ----------

  const ingest = (doc: SourceDocument, identity: IdentityAssessment, step: number) => {
    const found = extract(doc.text);
    // Zestawienie wielu adresów (np. lista „najbogatszych portfeli”) nie jest publikacją własnego adresu.
    const list = new Set(found.map((item) => item.address)).size >= ADDRESS_LIST_MIN;
    const detected = list ? [] : found;
    noteSighting(doc, identity, 'subject', step, detected.map(addressKey));
    if (list) log(`${doc.url}: publikacja zawiera ${found.length} adresów — to zestawienie adresów, nie przypisano ich podmiotowi.`);
    if (detected.length === 0) return;
    const contentHash = sha256Hex(doc.text);
    for (const item of detected) {
      addEvidence(groupFor(item.network, item.address, item.checksumVerified), doc, identity, item.context, contentHash);
    }
    log(`Adresy w ${doc.url}: ${detected.map((item) => item.address).join(', ')}.`);
  };

  /** Ścieżka dojścia: identyfikator → wpis z profilem, który go wskazał. */
  const trail = new Map<string, DiscoveryStep>();
  let limitLogged = false;
  let broadDiscovered = 0;
  /** Identyfikatory odkryte, które trafiły do wyszukiwania (każdy najwyżej raz). */
  const askedIdentifiers = new Set<string>();

  /** Identyfikatory potwierdzone, które przez limit trafiły tylko do źródeł bezpośrednich (bez kosztownych wyszukiwarek). */
  let broadCapped = 0;
  const hasBroadFor = (type: Identifier['type']) => params.connectors.some((connector) => isBroadSearch(connector.id) && connector.accepts.includes(type));

  /** Odnotowuje identyfikatory wskazane przez dokument i wybiera te do kolejnego kroku. */
  const collectDiscovered = (doc: SourceDocument, identity: IdentityAssessment, step: number, next: Map<string, Pending>) => {
    // Wiarygodność źródła (EXPANSION_RELIABILITY): masowy komentarz nigdy nie prowadzi dalej, a dokument
    // słabo przypisany podmiotowi — tylko wtedy, gdy znaleziono go wprost po identyfikatorze analityka.
    const lowCategory = EXPANSION_RELIABILITY.lowReliabilityCategories.includes(doc.category);
    const weakDocument = EXPANSION_RELIABILITY.weakMatches.includes(identity.match) || EXPANSION_RELIABILITY.weakMatches.includes(doc.identityMatch);
    const unreliable = lowCategory || (weakDocument && step >= EXPANSION_RELIABILITY.weakFollowSteps);
    for (const raw of doc.discoveredIdentifiers ?? []) {
      const identifier = { type: raw.type, value: raw.value.trim() };
      // Adresy trafiają do analizy przez treść dokumentów, nie przez tę listę.
      if (!identifier.value || identifier.type === 'crypto_address') continue;
      const key = identifierKey(identifier);
      if (inputKeys.has(key)) continue;
      // Profil wskazany przez dokument dopasowany po samym nazwisku dziedziczy tę słabość.
      const match: IdentityMatch =
        doc.identityMatch === 'name_only' || identity.match === 'name_only' ? 'name_only' : 'linked_profile';
      const name = normalizeName(identifier.value);
      if (knownNames.get(name) !== 'exact_identifier' && knownNames.get(name) !== 'linked_profile') {
        knownNames.set(name, match);
      }

      const pending = next.get(key);
      if (pending) {
        duplicates.identifiers++;
        // Ten sam identyfikator wskazany w tym kroku także przez mocniejszy dokument.
        if (match === 'linked_profile' && pending.match !== 'linked_profile') {
          pending.match = match;
          trail.get(key)!.match = match;
        }
        continue;
      }
      const prior = trail.get(key);
      // Identyfikator wskazany wcześniej tylko przez źródło niewiarygodne dostaje drugą szansę, gdy wskazuje go wiarygodne.
      const retry = prior !== undefined && !prior.followed && prior.stopReason === 'low_reliability' && !unreliable && !askedIdentifiers.has(key);
      if (prior && !retry) {
        duplicates.identifiers++;
        continue;
      }

      // Nazwa ENS wymieniona w treści wpisu (a nie wskazana przez profil) często należy do kogoś innego:
      // sprawdzamy ją tylko w źródłach znających samą nazwę i przyjmujemy, gdy prowadzi do adresu podmiotu.
      const requireKnownAddress = identifier.type === 'ens_name' && doc.category !== 'own_profile' && doc.category !== 'cryptographic_proof';

      // Do kosztownych wyszukiwarek trafiają tylko identyfikatory wskazane przez profil potwierdzony
      // (dowód kryptograficzny, odnośniki wzajemne) i najwyżej kilka; resztę sprawdzamy w źródłach bezpośrednich.
      const strongSource = identity.match === 'verified_link' || doc.category === 'cryptographic_proof';
      const directOnly = requireKnownAddress || !strongSource || broadDiscovered >= MAX_BROAD_DISCOVERED;
      const withinDepth = step < depth;
      const withinLimit = inputKeys.size + [...trail.values()].filter((entry) => entry.followed).length < maxIdentifiers;
      const followed = withinDepth && withinLimit && !unreliable;
      const stopReason: StopReason | undefined = followed ? undefined : unreliable ? 'low_reliability' : !withinDepth ? 'depth_limit' : 'identifier_limit';
      trail.set(key, {
        identifier,
        step: step + 1,
        sourceUrl: doc.url,
        sourceService: doc.service,
        via: doc.matchedIdentifier,
        match,
        followed,
        ...(stopReason ? { stopReason } : {}),
      });
      if (unreliable) {
        log(
          `Identyfikator ${identifier.type} „${identifier.value}” wskazany w ${doc.url} nie jest wyszukiwany: ` +
            (lowCategory
              ? 'źródłem jest masowy komentarz (niska wiarygodność).'
              : 'dokument jest słabo przypisany podmiotowi (zgodne tylko nazwisko albo pospolity nick) i nie został znaleziony wprost po identyfikatorze analityka.'),
        );
      }
      if (followed) {
        askedIdentifiers.add(key);
        if (strongSource && !requireKnownAddress && directOnly && hasBroadFor(identifier.type)) broadCapped++;
        if (!directOnly) broadDiscovered++;
        next.set(key, { identifier, match, distance: (identity.distance ?? 0) + 1, parent: doc.matchedIdentifier, ...(requireKnownAddress ? { requireKnownAddress } : {}), ...(directOnly ? { directOnly } : {}) });
        log(`Odkryty identyfikator (krok ${step + 1}): ${identifier.type} „${identifier.value}” — wskazany w ${doc.url}.`);
      } else if (withinDepth && !limitLogged) {
        limitLogged = true;
        log(`Osiągnięto limit ${maxIdentifiers} identyfikatorów w analizie — kolejne odkryte identyfikatory nie są już wyszukiwane.`);
      }
    }
  };

  let lastStep = 0;
  let frontier: Pending[] = personIdentifiers.map((identifier) => ({ identifier, match: 'exact_identifier', distance: 0 }));
  for (let step = 0; frontier.length > 0; step++) {
    const batches = await Promise.all(
      frontier.map(async (item) => ({ item, docs: await search(item.identifier, { directOnly: item.directOnly }) })),
    );
    const next = new Map<string, Pending>();
    for (const { item, docs: found } of batches) {
      let docs = found;
      if (item.requireKnownAddress) {
        const leadsToSubject = (doc: SourceDocument) => extract(doc.text).some((address) => (groups.get(addressKey(address))?.evidence.size ?? 0) > 0);
        docs = found.filter(leadsToSubject);
        if (docs.length === 0) {
          const entry = trail.get(identifierKey(item.identifier))!;
          entry.followed = false;
          entry.stopReason = 'low_reliability';
          log(`${item.identifier.type} „${item.identifier.value}” wymieniono w treści publikacji, ale nie prowadzi do adresu podmiotu — to cudza nazwa, pominięto.`);
        }
      }
      for (const doc of attributableDocuments(item.identifier, docs)) {
        // Dokument znany z wcześniejszego kroku wraca, bo sam podał identyfikator, po którym teraz
        // szukamy. To nie jest nowe potwierdzenie — zostaje pierwotna ocena.
        const seen = sightings.get(sightingKey(doc));
        if (seen && seen.role === 'subject' && seen.step < step) continue;
        const identity: IdentityAssessment =
          step === 0
            ? { ...assessIdentity(doc, personIdentifiers), distance: 0 }
            : assessLinkedProfile(doc, personIdentifiers, item.match, { step, distance: item.distance, parent: item.parent });
        ingest(doc, identity, step);
        // Dalej śledzimy tylko identyfikatory z publikacji samego podmiotu — nie z cudzych wzmianek
        // przyjętych ze źródła wyszukiwawczego na podstawie danych kontaktowych w treści.
        if (!isSearchSource(doc.connectorId) || authorMatches(doc) || doc.identityMatch === 'verified_link') collectDiscovered(doc, identity, step, next);
      }
    }
    frontier = [...next.values()];
    lastStep = step;
    if (frontier.length > 0) {
      log(`Krok ${step + 1} wyszukiwania: nowych identyfikatorów ${frontier.length}.`);
      enterPhase(`search-${step + 1}`);
    }
  }

  // Powody zatrzymania odkrywania — z tego, co zostało w ścieżce dojścia bez dalszego wyszukiwania.
  {
    const names = (reason: StopReason) => [...trail.values()].filter((entry) => !entry.followed && entry.stopReason === reason).map((entry) => `${entry.identifier.type} „${entry.identifier.value}”`);
    const listed = (items: string[]) => `${items.slice(0, 10).join(', ')}${items.length > 10 ? ` i ${items.length - 10} innych` : ''}`;
    const beyondDepth = names('depth_limit');
    const beyondLimit = names('identifier_limit');
    const unreliable = names('low_reliability');
    if (beyondDepth.length > 0) addStop('search', 'depth_limit', `Osiągnięto limit głębokości odkrywania (kroków: ${depth}) — nie wyszukiwano dalej: ${listed(beyondDepth)}.`, beyondDepth.length);
    if (beyondLimit.length > 0) addStop('search', 'identifier_limit', `Osiągnięto limit ${maxIdentifiers} identyfikatorów w analizie — nie wyszukiwano: ${listed(beyondLimit)}.`, beyondLimit.length);
    if (unreliable.length > 0) {
      addStop(
        'search',
        'low_reliability',
        `Nie rozwijano identyfikatorów ze źródeł o niskiej wiarygodności (masowe komentarze; dokumenty zgodne tylko nazwiskiem albo pospolitym nickiem poza pierwszym krokiem; cudze nazwy z treści): ${listed(unreliable)}.`,
        unreliable.length,
      );
    }
    if (broadCapped > 0) {
      addStop('search', 'query_limit', `Kosztowne wyszukiwarki dostały najwyżej ${MAX_BROAD_DISCOVERED} odkryte identyfikatory — pozostałe potwierdzone (${broadCapped}) sprawdzono tylko w źródłach bezpośrednich.`, broadCapped);
    }
    if (personIdentifiers.length > 0 && beyondDepth.length === 0 && beyondLimit.length === 0 && !partial && !budgetSkipped.has('search')) {
      addStop('search', 'no_new_leads', `Odkrywanie zakończone po kroku ${lastStep}: znalezione profile nie wskazały żadnych nowych identyfikatorów do sprawdzenia.`);
    }
  }

  // Nazwy kont znalezionych profili też są nazwami podmiotu — ale tylko pośrednio:
  // to samo konto w innym serwisie nie musi należeć do tej samej osoby.
  for (const sighting of sightings.values()) {
    const author = sighting.author ? normalizeName(sighting.author) : '';
    if (author && !knownNames.has(author)) {
      knownNames.set(author, sighting.identity.match === 'name_only' ? 'name_only' : 'linked_profile');
    }
  }

  // ---------- Wystąpienia adresów u innych autorów ----------

  // Analiza samego adresu (bez identyfikatorów osoby) odwraca pytanie: kto ten adres
  // publikuje? Każdy autor jest wtedy kandydatem na właściciela, a jego publikacja — śladem.
  const addressOnly = personIdentifiers.length === 0;

  const fetchOccurrences = (group: AddressGroup, index: number) =>
    search({ type: 'crypto_address', value: group.address }, { timeShare: OCCURRENCE_TIME_SHARE, directOnly: index >= MAX_BROAD_ADDRESSES, stage: 'occurrences' });
  const checkOccurrences = async (group: AddressGroup, occurrences: SourceDocument[]) => {
    const key = `${group.network}:${group.address}`;
    const candidateAuthors = new Set<string>();
    const containsAddress = (doc: SourceDocument) => extract(doc.text).some((item) => `${item.network}:${item.address}` === key);

    // Analiza samego adresu: kandydatem na właściciela jest tylko autor z mocną podstawą własności.
    // Komentujący i cytujący adres to wzmianki — nie wolno wskazywać ich jako osób.
    const owners = new Set<string>();
    /** Wypowiedzi, w których reguła tekstowa odczytała deklarację własności: adres publikacji → podstawa. */
    const declaredDocs = new Map<string, OwnershipBasis>();
    const citing = { documents: 0, authors: new Set<string>(), services: new Set<string>() };
    if (addressOnly) {
      const relevant = occurrences.filter((doc) => doc.author && containsAddress(doc) && !isAddressList(doc));
      for (const doc of relevant) if (OWNERSHIP_CATEGORIES.includes(doc.category)) owners.add(normalizeName(doc.author!));
      // Reguła tekstowa (bez modelu): wypowiedź na forum z deklaracją w pierwszej osobie („mój adres”, „wpłaty na”).
      // Najniższa moc: tylko dla autorów bez jawnej podstawy własności, a model językowy może ją uchylić.
      const declared = new Map<SourceDocument, OwnershipDeclaration>();
      for (const doc of relevant) {
        if (owners.has(normalizeName(doc.author!))) continue;
        const declaration = declarationIn(doc, group.address);
        if (declaration?.verdict === 'declares') declared.set(doc, declaration);
        else if (declaration?.verdict === 'excluded') log(`${doc.url}: ${TEXT_OWNERSHIP_RULE} — ${declaration.reason}; autor „${doc.author}” pozostaje wzmianką.`);
      }
      if (params.ai) {
        // Wyjątek: model czyta wypowiedź i stwierdza (z cytatem), że autor podaje adres jako własny.
        const unclear = relevant.filter((doc) => !owners.has(normalizeName(doc.author!))).slice(0, MAX_OWNERSHIP_READS);
        await Promise.all(
          unclear.map(async (doc) => {
            try {
              const insight = await params.ai!.analyzePublication({ text: doc.text, address: group.address, author: doc.author, title: doc.title });
              if (insight?.ownership === 'own_address' && insight.quote.trim()) {
                owners.add(normalizeName(doc.author!));
                // Podstawą jest odczyt modelu, nie reguła tekstowa.
                declared.delete(doc);
                log(`[model ${insight.model}] ${doc.url}: autor „${doc.author}” podaje adres jako własny („${insight.quote.trim()}”) — możliwy właściciel.`);
              } else if (insight && AI_RULES.excludingOwnership.includes(insight.ownership) && insight.quote.trim() && declared.delete(doc)) {
                // Odczyt modelu ma pierwszeństwo przed regułą tekstową.
                log(`[model ${insight.model}] ${doc.url}: odczyt modelu („${insight.quote.trim()}”) uchyla regułę tekstową — autor „${doc.author}” pozostaje wzmianką.`);
              }
            } catch (error) {
              log(`[model ${params.ai!.model}] BŁĄD odczytu ${doc.url}: ${errorText(error)}.`);
            }
          }),
        );
      }
      for (const [doc, declaration] of declared) {
        owners.add(normalizeName(doc.author!));
        const quote = declaration.quote ?? '';
        declaredDocs.set(doc.url, { rule: 'text_declaration', quote });
        const note =
          `${TEXT_OWNERSHIP_RULE[0]!.toUpperCase()}${TEXT_OWNERSHIP_RULE.slice(1)}: autor „${doc.author}” w ${doc.url} — „${quote}” (${declaration.reason}). ` +
          'Wypowiedź liczona jako publikacja autora z wagą wypowiedzi na forum (50), nigdy wyższą; jawna kategoria źródła i odczyt modelu językowego mają pierwszeństwo.';
        if (!group.notes.includes(note)) group.notes.push(note);
        log(`${doc.url}: ${TEXT_OWNERSHIP_RULE} — autor „${doc.author}” podaje adres jako własny („${quote}”) — możliwy właściciel.`);
      }
    }
    let lists = 0;
    for (const doc of occurrences) {
      const hit = extract(doc.text).find((item) => `${item.network}:${item.address}` === key);
      if (!hit) continue;
      if (isAddressList(doc)) {
        // Autor zestawienia adresów nie jest ani właścicielem, ani „niepowiązanym publikującym”.
        lists++;
        continue;
      }
      if ([...group.evidence.values()].some((item) => item.url === doc.url && item.archivedAt === doc.archivedAt)) continue;
      const contentHash = sha256Hex(doc.text);
      const author = doc.author ? normalizeName(doc.author) : '';
      const relation = author ? knownNames.get(author) : undefined;
      if (addressOnly && author && !owners.has(author)) {
        group.unrelatedAuthors.add(author);
        citing.documents++;
        citing.authors.add(`${doc.service.toLowerCase()}|${author}`);
        citing.services.add(doc.service.toLowerCase());
        capture(doc, contentHash);
        noteSighting(doc, { match: 'same_handle', reasons: [] }, 'co_publisher', 0, [key]);
      } else if (addressOnly && author) {
        const basis = declaredDocs.get(doc.url);
        // Dowód kryptograficzny (rekord ENS sprawdzony w obie strony, zweryfikowany podpis wymieniający konto) wiąże
        // profil z adresem mocniej niż samo opublikowanie adresu: przynależność profilu jest potwierdzona.
        const proven = doc.category === 'cryptographic_proof';
        const identity: IdentityAssessment = {
          match: proven ? 'verified_link' : 'exact_identifier',
          reasons: [
            proven
              ? `Dowód kryptograficzny: „${doc.author}” jest powiązany z tym adresem zapisem dokonanym kluczem adresu (${doc.service}).`
              : basis
                ? `Autor „${doc.author}” podaje ten adres jako własny w wypowiedzi (${TEXT_OWNERSHIP_RULE}): „${basis.quote}”.`
                : `Autor „${doc.author}” sam opublikował ten adres.`,
          ],
          distance: 0,
        };
        addEvidence(group, doc, identity, hit.context, contentHash, basis);
        noteSighting(doc, identity, 'subject', 0, [key]);
        candidateAuthors.add(author);
        log(`Adres ${group.address} publikuje „${doc.author}”: ${doc.url} — możliwy właściciel.`);
      } else if (relation) {
        const identity: IdentityAssessment = {
          match: relation,
          reasons: [`Autor „${doc.author}” to nazwa, pod którą występuje badany podmiot.`],
          distance: relation === 'exact_identifier' ? 0 : 1,
        };
        addEvidence(group, doc, identity, hit.context, contentHash);
        noteSighting(doc, identity, 'subject', 0, [key]);
        log(`Adres ${group.address} także w ${doc.url} — autor „${doc.author}” to badany podmiot.`);
      } else if (author) {
        // Publikacja obcej osoby nie obciąża podmiotu; liczymy ją tylko jako sygnał adresu współdzielonego.
        group.unrelatedAuthors.add(author);
        capture(doc, contentHash);
        noteSighting(doc, { match: 'same_handle', reasons: [] }, 'co_publisher', 0, [key]);
        log(`Adres ${group.address} publikuje też niepowiązany autor „${doc.author}”: ${doc.url}.`);
      } else {
        // Publikacja bez autora (np. serwis ostrzegający przed oszustwami) to wiedza o adresie, nie ślad osoby.
        const note = `Wiedza o adresie z serwisu ${doc.service}: „${doc.title}” (${doc.url}) — publikacja bez autora, nie jest śladem osoby.`;
        if (!group.notes.includes(note)) group.notes.push(note);
        log(`Adres ${group.address} występuje w ${doc.url} bez wskazanego autora — odnotowano jako wiedzę o adresie, nie wliczono do publikujących.`);
      }
    }
    if (lists > 0) {
      const note = `Adres występuje w publicznych zestawieniach adresów (${lists} ${lists === 1 ? 'publikacja' : 'publikacji'}) — to nie jest przesłanka własności ani powiązania z autorami zestawień.`;
      group.notes.push(note);
      mentions.push({ identifier: { type: 'crypto_address', value: group.address }, documents: lists, authors: 0, services: 0, note: 'adres występuje w publicznych zestawieniach adresów' });
      log(`Adres ${group.address}: ${note}`);
    }
    if (citing.documents > 0) {
      const identifier: Identifier = { type: 'crypto_address', value: group.address };
      mentions.push({
        identifier,
        documents: citing.documents,
        authors: citing.authors.size,
        services: citing.services.size,
        ...(mentionStopped.has(identifierKey(identifier)) ? { atLeast: true } : {}),
      });
      log(
        `Adres ${group.address} wymienia ${citing.authors.size} autorów w ${citing.services.size} serwisach (${citing.documents} publikacji) bez mocnej podstawy własności — ` +
          'to wzmianki, nie kandydaci na właściciela.',
      );
    }
    if (candidateAuthors.size > 1) {
      // Kilku różnych autorów przy jednym adresie osłabia przypisanie do któregokolwiek z nich.
      const [, ...others] = candidateAuthors;
      for (const other of others) group.unrelatedAuthors.add(other);
      log(`Adres ${group.address} publikuje ${candidateAuthors.size} różnych autorów — przypisanie niejednoznaczne.`);
    }
  };
  // Analizę blockchain dostają najpierw adresy podane przez analityka i najlepiej udokumentowane.
  const evidenceStrength = (group: AddressGroup) =>
    Math.max(0, ...[...group.evidence.values()].map((item) => rules.base[item.category] + rules.identityAdjustment[item.identityMatch]));
  const analystKeys = new Set(
    params.query.identifiers.filter((item) => item.type === 'crypto_address').map((item) => item.value.trim().toLowerCase()),
  );
  const ranked = [...groups.values()].sort(
    (a, b) =>
      Number(analystKeys.has(b.address.toLowerCase())) - Number(analystKeys.has(a.address.toLowerCase())) ||
      evidenceStrength(b) - evidenceStrength(a) ||
      b.evidence.size - a.evidence.size,
  );
  // Wystąpienia adresów biegną równolegle z analizą łańcucha i sprawdzaniem kontrahentów:
  // każde zapytanie do wyszukiwarki forów trwa kilkanaście sekund, więc nie ustawiamy ich w kolejce.
  report('occurrences');
  // Zapytania biegną równolegle, ale odpowiedzi przetwarzamy w kolejności rankingu adresów —
  // wynik nie zależy od tego, które źródło odpowie pierwsze.
  const occurrenceQueries = ranked.map(fetchOccurrences);
  const occurrencesDone = (async () => {
    for (const [index, group] of ranked.entries()) await checkOccurrences(group, await occurrenceQueries[index]!);
  })();
  if (ranked.length > MAX_BROAD_ADDRESSES && hasBroadFor('crypto_address')) {
    addStop(
      'occurrences',
      'query_limit',
      `Wystąpienia adresów w kosztownych wyszukiwarkach sprawdzono dla ${MAX_BROAD_ADDRESSES} najlepiej udokumentowanych adresów; pozostałe (${ranked.length - MAX_BROAD_ADDRESSES}) tylko w źródłach bezpośrednich.`,
      ranked.length - MAX_BROAD_ADDRESSES,
    );
  }

  // ---------- Dane blockchain ----------

  report('chain');
  // Wolne miejsca w limicie dostają kolejne adresy z rankingu; część analiz mogła wystartować wcześniej.
  for (const group of ranked) startChain(group);
  await Promise.all(chainJobs.values());
  const chainSkipped = new Set(ranked.filter((group) => !chainJobs.has(group) || (!group.chain && performance.now() >= deadline)));
  if (ranked.length > chainJobs.size) {
    log(`Adresów ${ranked.length}, limit analizy blockchain ${chainLimit} — ${ranked.length - chainJobs.size} najsłabiej udokumentowanych pozostaje bez analizy łańcucha.`);
    addStop('chain', 'chain_address_limit', `Analizę blockchain dostało ${chainJobs.size} z ${ranked.length} adresów (limit ${chainLimit}) — najsłabiej udokumentowane pozostają bez analizy łańcucha.`, ranked.length - chainJobs.size);
  }

  // ---------- Kontrahenci bez etykiety: czy ktoś opublikował ich adresy? ----------

  const subjectGroups = [...groups.values()].filter(
    (group) => !rules.excludedClasses.includes(group.chain?.profile.addressClass ?? 'unknown'),
  );
  const allCounterparties = unlabeledCounterparties(subjectGroups, new Set(groups.keys()));
  const counterparties = allCounterparties.slice(0, Math.max(0, maxCounterparties));
  report('counterparties');
  if (counterparties.length > 0) {
    log(`Sprawdzanie kontrahentów bez etykiety (największych wartością): ${counterparties.length}.`);
  }
  if (allCounterparties.length > counterparties.length) {
    // Zasada: grafu nie rozwijamy po wszystkich kontrahentach transakcji — tylko największych, i tylko o jeden krok.
    log(`Kontrahentów bez etykiety ${allCounterparties.length}, limit ${maxCounterparties} — pozostałych ${allCounterparties.length - counterparties.length} nie sprawdzano (nie rozwijamy grafu po wszystkich kontrahentach).`);
    addStop(
      'counterparties',
      'counterparty_limit',
      `Sprawdzono ${counterparties.length} największych wartością kontrahentów bez etykiety z ${allCounterparties.length} (limit ${maxCounterparties}) — nie rozwijamy grafu po wszystkich kontrahentach; ` +
        'kontrahentów sprawdzamy tylko w publikacjach, bez analizy ich własnych kontrahentów.',
      allCounterparties.length - counterparties.length,
    );
  }
  // Zapytania o kontrahentów biegną równolegle z wystąpieniami adresów; odpowiedzi przetwarzamy
  // po nich i w kolejności rankingu — zapisany wynik nie zależy od kolejności odpowiedzi źródeł.
  const counterpartyQueries = counterparties.map((candidate, index) =>
    search({ type: 'crypto_address', value: candidate.address }, { timeShare: OCCURRENCE_TIME_SHARE, directOnly: index >= MAX_BROAD_COUNTERPARTIES, stage: 'counterparties' }),
  );
  await occurrencesDone;
  {
    for (const [index, candidate] of counterparties.entries()) {
      const key = addressKey(candidate);
      const publications = (await counterpartyQueries[index]!).filter((doc) => extract(doc.text).some((item) => addressKey(item) === key));
      // Adres w zestawieniach albo u kilku niezależnych autorów nie wskazuje żadnego z nich jako kontrahenta.
      const single = publications.filter((doc) => doc.author && !isAddressList(doc));
      const authors = new Set(single.map((doc) => normalizeName(doc.author!)));
      if (publications.length > single.length || authors.size >= MANY_PUBLISHERS_MIN) {
        log(
          `Kontrahent ${candidate.address} występuje w publicznych zestawieniach adresów lub u ${authors.size} różnych autorów — ` +
            'publikacje nie wskazują właściciela; autorzy nie są osobami powiązanymi.',
        );
        if (authors.size >= MANY_PUBLISHERS_MIN || single.length === 0) continue;
      }
      for (const doc of single) {
        const author = doc.author ? normalizeName(doc.author) : '';
        if (!author) continue;
        if (knownNames.has(author)) {
          log(`Kontrahent ${candidate.address} jest publikowany przez sam podmiot („${doc.author}”, ${doc.url}) — warto dodać ten adres do sprawy.`);
          continue;
        }
        // Kontrahenta wskazuje tylko publikacja z podstawą własności (profil, oferta); komentarz o adresie
        // to wzmianka i nie może nikogo wskazywać jako osoby powiązanej.
        if (!OWNERSHIP_CATEGORIES.includes(doc.category)) {
          log(`Kontrahenta ${candidate.address} wymienia „${doc.author}” w ${doc.url} (wypowiedź, nie własna publikacja adresu) — odnotowano bez wskazywania osoby.`);
          continue;
        }
        capture(doc, sha256Hex(doc.text));
        noteSighting(doc, { match: 'same_handle', reasons: [] }, 'counterparty_publisher', 0, [key]);
        log(`Kontrahent ${candidate.address} opublikowany przez „${doc.author}”: ${doc.url} — możliwa osoba powiązana.`);
      }
    }
  }

  // ---------- Rozszerzanie: inne tożsamości tej samej osoby i adresy powiązane ----------

  report('pivot');
  const pivotLimits = params.pivot ?? PIVOT_LIMITS.standard;
  let pivotLeads: PivotLead[] = [];
  if (pivotLimits.steps > 0) {
    const corpus = params.connectors.find((connector) => connector.id === 'corpus');
    // Adresy publikowane jako własne: jawna kategoria źródła albo — w wypowiedzi na forum — deklaracja odczytana regułą tekstową.
    const ownedAddresses = (doc: SourceDocument) =>
      OWNERSHIP_CATEGORIES.includes(doc.category)
        ? extract(doc.text).map((item) => ({ network: item.network, address: item.address }))
        : extract(doc.text)
            .filter((item) => declarationIn(doc, item.address)?.verdict === 'declares')
            .map((item) => ({ network: item.network, address: item.address }));
    const subjectProfiles: PivotSource[] = [...sightings.values()]
      .filter((item) => item.role === 'subject')
      .map((item) => ({
        path: [`profil „${item.profile?.handle ?? item.author ?? item.url}” podmiotu w serwisie ${item.service}`],
        author: item.author,
        handle: item.profile?.handle ?? item.author,
        attributes: item.profile,
        addresses: [],
        ofSubject: true,
      }));
    const subjectChains: PivotSource[] = subjectGroups
      .filter((group) => group.chain && (group.evidence.size > 0 || subjectAddresses.has(group.address.toLowerCase())))
      .map((group) => ({ path: [], addresses: [{ network: group.network, address: group.address, chain: group.chain }], ofSubject: true }));
    pivotLeads = await runPivot({
      steps: pivotLimits.steps,
      queriesPerStep: pivotLimits.queriesPerStep,
      sources: [...subjectProfiles, ...subjectChains],
      isSubjectName: (name) => knownNames.has(normalizeName(name)),
      search: (identifier) => search(identifier, { timeShare: PIVOT_LIMITS.timeShare, directOnly: true, stage: 'pivot' }),
      phraseSearch: async (phrase) => {
        if (!corpus || expired('rozszerzanie o inne tożsamości', PIVOT_LIMITS.timeShare)) return [];
        // Fraza w indeksie własnym też jest zapytaniem: raz na analizę i w ramach budżetu.
        const queryKey = `${corpus.id}|phrase:${phrase.trim().toLowerCase()}`;
        let job = askedQueries.get(queryKey);
        if (job) duplicates.queries++;
        else {
          if (!reserveRequest('connectors', 'pivot')) return [];
          job = (async () => {
            try {
              return await corpus.search({ type: 'full_name', value: phrase }, { log: (message) => log(`[corpus] ${message}`) });
            } catch (error) {
              log(`[corpus] BŁĄD przy frazie „${phrase}”: ${errorText(error)}.`);
              noteSourceError({ connectorId: corpus.id, stage: 'pivot', message: errorText(error) });
              return [];
            }
          })();
          askedQueries.set(queryKey, job);
        }
        return (await job).map(dedupe).filter((doc): doc is SourceDocument => doc !== undefined);
      },
      ownedAddresses,
      record: (doc, step) => {
        const author = doc.author ? normalizeName(doc.author) : '';
        if (!author || knownNames.has(author) || isAddressList(doc)) return false;
        const contentHash = sha256Hex(doc.text);
        const owned = ownedAddresses(doc);
        capture(doc, contentHash);
        noteSighting(doc, { match: 'same_handle', reasons: [] }, 'linked_identity', step, extract(doc.text).map(addressKey));
        // Adresy opublikowane przez powiązaną tożsamość jako własne dostają osobne wpisy —
        // nie są przypisane podmiotowi, ale ich aktywność w łańcuchu jest potrzebna do oceny.
        for (const item of extract(doc.text)) {
          if (!owned.some((entry) => entry.address === item.address)) continue;
          const key = addressKey(item);
          let group = groups.get(key);
          if (!group) {
            group = groupFor(item.network, item.address, item.checksumVerified);
            group.linkedOnly = true;
          }
          if (group.linkedOnly) {
            const declaration = OWNERSHIP_CATEGORIES.includes(doc.category) ? undefined : declarationIn(doc, item.address);
            const basis: OwnershipBasis | undefined = declaration?.verdict === 'declares' ? { rule: 'text_declaration', quote: declaration.quote ?? '' } : undefined;
            addEvidence(group, doc, { match: 'exact_identifier', reasons: [`Autor „${doc.author}” (powiązana tożsamość) sam opublikował ten adres${basis ? ` (${TEXT_OWNERSHIP_RULE})` : ''}.`] }, item.context, contentHash, basis);
          }
        }
        return true;
      },
      expired: () => performance.now() >= startedAt + totalMs * PIVOT_LIMITS.timeShare,
      log,
      onStop: (stop) => addStop('pivot', stop.reason, stop.detail, stop.skipped),
    });
    // Adresy powiązanych tożsamości: analiza łańcucha w ramach wspólnego limitu adresów.
    const linkedGroups = [...groups.values()].filter((group) => group.linkedOnly);
    for (const group of linkedGroups) startChain(group);
    await Promise.all(linkedGroups.map((group) => chainJobs.get(group)));
    const linkedSkipped = linkedGroups.filter((group) => !chainJobs.has(group));
    for (const group of linkedSkipped) chainSkipped.add(group);
    if (linkedSkipped.length > 0) {
      addStop('pivot', 'chain_address_limit', `Adresy powiązanych tożsamości bez analizy blockchain (wspólny limit ${chainLimit} adresów): ${linkedSkipped.length}.`, linkedSkipped.length);
    }
    if (pivotLeads.length > 0) log(`Rozszerzanie: tropów ${pivotLeads.length}, adresów powiązanych tożsamości ${linkedGroups.length}.`);
  }

  // ---------- Beneficjent adresu cytowanego przez wielu: czyj to adres zbiórki lub płatności ----------

  const beneficiaries = new Map<string, BeneficiaryAttribution>();
  for (const group of groups.values()) {
    if (group.unrelatedAuthors.size < BENEFICIARY_RULES.minCitingAuthors) continue;
    const key = addressKey(group);
    const docs = [...documents.values()].filter((doc) => extract(doc.text).some((item) => addressKey(item) === key));
    const { mentions: found, warnings } = collectBeneficiaryMentions(docs, group.address);
    let attribution = attributeBeneficiary({ address: group.address, network: group.network, mentions: found, warnings });
    if (!attribution) continue;
    // Strona organizacji (odnośnik zbiórki z kontekstu albo domena): jedna strona, łącznik „Strona WWW” (robots.txt, bez podążania za odnośnikami).
    const site = !attribution.reason || /pochodzenie publikacji/.test(attribution.reason) ? officialSiteUrl(attribution) : undefined;
    const www = params.connectors.find((connector) => connector.id === OFFICIAL_SITE_CONNECTOR && connector.accepts.includes('profile_url'));
    if (site && www && !expired('sprawdzenie strony organizacji', OCCURRENCE_TIME_SHARE) && reserveRequest('connectors', 'occurrences')) {
      const checkedAt = now().toISOString();
      let official: OfficialSiteCheck;
      try {
        const pages = await withTimeout(
          (signal) => www.search({ type: 'profile_url', value: site }, { signal, log: (message) => log(`[${www.id}] ${message}`) }),
          timeoutMs,
          params.signal,
        );
        const page = pages[0];
        const publishes = page !== undefined && extract(page.text).some((item) => addressKey(item) === key);
        if (page) capture(page, sha256Hex(page.text));
        official = {
          url: page?.url ?? site,
          publishesAddress: publishes,
          checkedAt,
          note: !page
            ? 'Strony nie pobrano (robots.txt, brak odpowiedzi albo strona bez treści tekstowej) — potwierdzenia brak.'
            : publishes
              ? `Strona organizacji publikuje ten sam adres — kopia strony zapisana (${checkedAt}).`
              : 'Strona pobrana, ale nie zawiera tego adresu (może być na podstronie albo w treści ładowanej skryptem) — potwierdzenia brak.',
        };
      } catch (error) {
        official = { url: site, publishesAddress: false, checkedAt, note: `Błąd pobrania strony organizacji: ${errorText(error)} — potwierdzenia brak.` };
      }
      log(`Adres ${group.address}: strona organizacji ${official.url} — ${official.note}`);
      attribution = attributeBeneficiary({ address: group.address, network: group.network, mentions: found, warnings, officialSite: official }) ?? attribution;
    }
    beneficiaries.set(key, attribution);
    log(
      attribution.attributed
        ? `Adres ${group.address}: adres zbiórki / płatności organizacji „${attribution.name}” (hipoteza, wskaźnik ${attribution.score}/100, niezależnych pochodzeń ${attribution.origins}) — autorzy cytujący nie są właścicielami.`
        : `Adres ${group.address}: beneficjenta nie przypisano — ${attribution.reason}`,
    );
  }

  // ---------- Sieć organizacji z rejestrów publicznych (organizacja → osoby w rolach → podmioty powiązane) ----------

  let organizationNetwork: OrganizationNetwork | undefined;
  const registriesEnabled = params.registries !== false && (params.registries?.fetch !== undefined || params.connectors.some((connector) => connector.id.startsWith('live-')));
  if (registriesEnabled && !expired('sieć organizacji z rejestrów', PIVOT_LIMITS.timeShare)) {
    const seeds: OrgSeed[] = [];
    for (const attribution of beneficiaries.values()) {
      if (!attribution.attributed) continue;
      const krs = krsNumbersIn(attribution.evidence.map((item) => item.quote).join('\n'))[0];
      seeds.push({ name: attribution.name, ...(attribution.domain ? { domain: attribution.domain } : {}), ...(krs ? { krs } : {}), addresses: [attribution.address], origin: `beneficjent zbiórki adresu ${attribution.address}` });
    }
    for (const sighting of sightings.values()) {
      const krs = sighting.profile?.registryEntries?.map((entry) => /^KRS (\d{10})$/.exec(entry)?.[1]).find(Boolean);
      if (sighting.role !== 'subject' || !krs || seeds.some((seed) => seed.krs === krs)) continue;
      seeds.push({ name: sighting.profile?.organization ?? `KRS ${krs}`, krs, addresses: [], origin: `wpis KRS ${krs} znaleziony w analizie` });
    }
    if (seeds.length > 0) {
      const github = params.connectors.find((connector) => connector.id === 'live-github');
      organizationNetwork = await buildOrganizationNetwork({
        seeds: seeds.slice(0, 3),
        ...(params.registries && params.registries.fetch ? { fetch: params.registries.fetch } : {}),
        deep: params.deep === true,
        now,
        log,
        ...(params.signal ? { signal: params.signal } : {}),
        reserve: () => reserveRequest('connectors', 'organizations'),
        // Profile publiczne osoby w roli: wyłącznie z loginu opublikowanego przez rejestr, tylko łącznik GitHub; nie są śladami adresu.
        ...(github
          ? {
              lookupProfile: async (identifier: { type: 'login'; value: string }) => {
                try {
                  const docs = await withTimeout((signal) => github.search(identifier, { signal, log: (message) => log(`[${github.id}] ${message}`) }), timeoutMs, params.signal);
                  return docs.slice(0, 3).map((doc) => ({ url: doc.url, service: doc.service, title: doc.title }));
                } catch (error) {
                  log(`[${github.id}] BŁĄD profilu osoby z rejestru „${identifier.value}”: ${errorText(error)}.`);
                  return [];
                }
              },
            }
          : {}),
      });
      for (const stop of organizationNetwork.stops) addStop(stop.stage, stop.reason, stop.detail, stop.skipped);
    }
  }

  // ---------- Wskaźnik Pewności ----------

  report('scoring');
  const widelyCitedFrom = params.widelyCitedAuthors ?? DEFAULT_WIDELY_CITED_AUTHORS;
  const findings: AnalysisFinding[] = [];
  for (const group of groups.values()) {
    const evidence = [...group.evidence.values()];
    const unrelatedPublishers = group.unrelatedAuthors.size;
    const counted = effectiveUnrelatedPublishers(evidence, unrelatedPublishers);
    const beneficiary = beneficiaries.get(addressKey(group));
    const subjectOfCase = subjectAddresses.has(group.address.toLowerCase());
    // Adres zbiórki organizacji (klasa „charity”): nie przypisuje się go osobie. Adres podany przez analityka
    // pozostaje przedmiotem sprawy (łańcuch, sumy) — dostaje tylko adnotację.
    const addressClass = charityClass(group.chain?.profile.addressClass, beneficiary, subjectOfCase);
    let confidence = computeConfidence({ evidence, addressClass, unrelatedPublishers: counted }, rules);
    const notes: string[] = [...group.notes];
    if (beneficiary?.attributed) notes.push(beneficiaryNote(beneficiary));
    if (counted !== unrelatedPublishers && unrelatedPublishers >= rules.sharedAddressThreshold) {
      notes.push(
        `Adres wymienia także ${unrelatedPublishers} innych autorów; własność potwierdza dowód kryptograficzny lub potwierdzona tożsamość profilu, ` +
          'więc cytowania nie obniżają wyniku.',
      );
    }
    const widelyCited = counted >= widelyCitedFrom;
    if (subjectOfCase) {
      notes.push(
        `Zakres historii blockchain: pełna historia adresu (adres podany przez analityka jest przedmiotem sprawy)` +
          `${params.period?.from || params.period?.to ? `; okres wskazany przez analityka: od ${params.period.from ?? 'początku'} do ${params.period.to ?? 'dziś'}` : ''}.`,
      );
    } else if (params.period?.from || params.period?.to) {
      notes.push(`Zakres historii blockchain: okres wskazany przez analityka, od ${params.period.from ?? 'początku'} do ${params.period.to ?? 'dziś'}.`);
    }
    if (widelyCited && subjectOfCase) {
      // Adres jest przedmiotem sprawy: liczba cytujących nie zatrzymuje analizy łańcucha ani nie zeruje sum.
      notes.push(
        `Adres powszechnie cytowany: wymienia go ${unrelatedPublishers} niepowiązanych autorów (próg ${widelyCitedFrom}) — na podstawie publikacji nie da się wskazać właściciela. ` +
          'Adres podany przez analityka pozostaje przedmiotem sprawy: analiza łańcucha, sumy i priorytet dotyczą adresu, nie osoby.',
      );
    } else if (widelyCited && !confidence.excluded) {
      // Adres darowizn projektu albo adres z FAQ giełdy: publikuje go wielu autorów, więc nie wskazuje osoby.
      const explanation =
        `Adres powszechnie cytowany: publikuje go ${unrelatedPublishers} niepowiązanych autorów (próg ${widelyCitedFrom}). ` +
        'Nie jest przypisywany żadnej osobie; odnotowano jedynie fakt publikacji.';
      notes.push(explanation);
      confidence = {
        score: 0,
        tier: [...rules.tiers].sort((a, b) => a.min - b.min)[0]!.label,
        excluded: true,
        ledger: [...confidence.ledger, { rule: 'exclusion.widely_cited', delta: -confidence.score, running: 0, explanation, evidenceIds: evidence.map((item) => item.id) }],
        nextSteps: [],
      };
    }
    let linkedScore: number | undefined;
    if (group.linkedOnly) {
      // Adres powiązanej tożsamości: w wyniku dla podmiotu ma 0%, a ocena względem autora zostaje obok.
      linkedScore = confidence.score;
      const explanation = 'Adres opublikowany przez powiązaną tożsamość, nie przez podmiot — nie jest przypisany podmiotowi (ocena względem autora publikacji w polu linkedScore).';
      notes.push(explanation);
      confidence = { ...confidence, score: 0, tier: [...rules.tiers].sort((a, b) => a.min - b.min)[0]!.label, ledger: [...confidence.ledger, { rule: 'info.linked_identity', delta: -confidence.score, running: 0, explanation, evidenceIds: evidence.map((item) => item.id) }], nextSteps: [] };
    }
    const unavailable = chainUnavailable.get(group);
    if (unavailable !== undefined) {
      notes.push(`Dane blockchain niedostępne: żaden dostawca danych nie odpowiedział dla tego adresu (${unavailable}). Nie podano żadnych kwot ani klasyfikacji — to brak danych, a nie brak aktywności.`);
    } else if (chainBudgetSkipped.has(group)) {
      notes.push(`Nie analizowano łańcucha: wyczerpano budżet zapytań analizy (${maxRequests}).`);
    } else if (chainSkipped.has(group)) notes.push('Nie analizowano łańcucha: adres poza limitem liczby adresów albo czasu analizy.');
    findings.push({
      address: group.address,
      network: group.network,
      checksumVerified: group.checksumVerified,
      evidence,
      confidence,
      chain: group.chain,
      unrelatedPublishers,
      ...(widelyCited ? { widelyCited } : {}),
      ...(chainSkipped.has(group) || chainBudgetSkipped.has(group) ? { chainSkipped: true } : {}),
      ...(unavailable !== undefined ? { chainUnavailable: true } : {}),
      ...(group.linkedOnly ? { linkedOnly: true, linkedScore } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    });
    log(
      `${group.address}: Wskaźnik Pewności ${confidence.score}% (${confidence.tier})` +
        `${confidence.excluded ? ' — adres wykluczony' : ''}; śladów ${evidence.length}.`,
    );
  }
  sortFindings(findings);

  // ---------- Model językowy (opcjonalny): odczyt publikacji i porównanie autorów ----------

  let authorComparisons: AuthorComparison[] | undefined;
  if (params.ai && !expired('odczyt publikacji przez model')) {
    report('ai');
    const { ai } = params;
    const aiLimited = createLimiter(AI_RULES.concurrency);
    const textOf = (item: { url: string; contentHash?: string }) =>
      [...documents.values()].find((doc) => doc.url === item.url && (!item.contentHash || doc.contentHash === item.contentHash))?.text;

    // Najpierw ślady najmocniejsze: to one decydują o wyniku.
    const queue = findings
      .flatMap((finding) => finding.evidence.map((item) => ({ finding, item, value: rules.base[item.category] + rules.identityAdjustment[item.identityMatch] })))
      .sort((a, b) => b.value - a.value)
      .slice(0, params.maxAiPublications ?? AI_RULES.maxPublicationsPerAnalysis);
    let read = 0;
    await Promise.all(
      queue.map(({ finding, item }) =>
        aiLimited(async () => {
          const text = textOf(item);
          if (!text || performance.now() >= deadline) return;
          try {
            const insight = await ai.analyzePublication({ text, address: finding.address, author: item.author, title: item.title });
            if (insight) {
              item.insight = insight;
              read++;
            }
          } catch (error) {
            log(`[model ${ai.model}] BŁĄD odczytu ${item.url}: ${errorText(error)}. Ślad oceniony samymi regułami.`);
          }
        }),
      ),
    );
    log(`[model ${ai.model}] odczytano publikacji: ${read} z ${queue.length} (odczyt jest sugestią; o wyniku decydują reguły).`);

    const nodes = buildProfileNodes({ findings } as unknown as AnalysisRun, [...sightings.values()]);
    let comparisons: AuthorComparison[] = [];
    // Poza parami profili podmiotu porównujemy też profile podmiotu z profilami powiązanych tożsamości
    // (z pętli rozszerzania, współpublikujących, kontrahentów) — do oceny „ta sama osoba albo bliska”.
    const outside = (['linked_identity', 'co_publisher', 'counterparty_publisher'] as const).flatMap((role) =>
      buildProfileNodes({ findings } as unknown as AnalysisRun, [...sightings.values()], role),
    );
    const crossPairs = nodes.flatMap((a) => outside.map((b) => ({ a, b })));
    // Wyniki w kolejności par, nie w kolejności odpowiedzi modelu.
    comparisons = (
      await Promise.all(
        [...comparablePairs(nodes, findings, rules), ...crossPairs]
          .slice(0, MAX_AUTHOR_COMPARISONS)
          .map(({ a, b }) =>
            aiLimited(async (): Promise<AuthorComparison | undefined> => {
              const texts = (node: (typeof nodes)[number]) => node.sightings.map(textOf).filter((text): text is string => Boolean(text));
              const [left, right] = [texts(a), texts(b)];
              if (left.length === 0 || right.length === 0 || performance.now() >= deadline) return undefined;
              try {
                const result = await ai.compareAuthors(left, right);
                return result ? { a: a.card.id, b: b.card.id, likelihood: result.likelihood, reasons: result.reasons, model: result.model } : undefined;
              } catch (error) {
                log(`[model ${ai.model}] BŁĄD porównania autorów ${a.card.id} / ${b.card.id}: ${errorText(error)}.`);
                return undefined;
              }
            }),
          ),
      )
    ).filter((item): item is AuthorComparison => item !== undefined);
    if (comparisons.length > 0) {
      authorComparisons = comparisons;
      log(`[model ${ai.model}] porównano styl autorów dla par profili: ${comparisons.length} (słaba przesłanka, nie łączy profili).`);
    }
  }

  enterPhase('done');
  const slowestQueries = [...queries].sort((a, b) => b.ms - a.ms).slice(0, 10);
  log(`Czas faz: ${timings.map((item) => `${item.stage} ${(item.ms / 1000).toFixed(1)} s`).join(', ')}; razem ${((performance.now() - startedAt) / 1000).toFixed(1)} s, zapytań do łączników ${queries.length}.`);
  if (slowestQueries.length > 0) {
    log(`Najwolniejsze zapytania: ${slowestQueries.map((item) => `${item.connectorId} (${item.identifier.type} „${item.identifier.value}”) ${(item.ms / 1000).toFixed(1)} s`).join('; ')}.`);
  }

  // ---------- Kontrola rozszerzania: podsumowanie ----------

  for (const [stage, skipped] of budgetSkipped) {
    addStop(stage, 'request_budget', `Wyczerpano budżet zapytań analizy (${maxRequests}) — w tym etapie pominięto zapytań: ${skipped}.`, skipped);
  }
  if (chainBudgetSkipped.size > 0) log(`Budżet zapytań: adresów bez analizy łańcucha ${chainBudgetSkipped.size}.`);
  if (params.signal?.aborted) addStop(progress.stage, 'aborted', 'Analizę przerwano z zewnątrz (zamykanie usługi) — wynik obejmuje to, co zebrano do chwili przerwania.');
  const sourceName = (item: SourceError) => item.connectorId ?? item.providerId ?? '';
  const failedSources = [...sourceErrors.values()].sort(
    (a, b) => stageRank(a.stage) - stageRank(b.stage) || (sourceName(a) < sourceName(b) ? -1 : sourceName(a) > sourceName(b) ? 1 : 0) || Number(a.reported ?? false) - Number(b.reported ?? false),
  );
  for (const item of failedSources) item.addresses?.sort();
  for (const stage of new Set(failedSources.map((item) => item.stage))) {
    const inStage = failedSources.filter((item) => item.stage === stage);
    const names = [...new Set(inStage.map(sourceName))];
    addStop(
      stage,
      'source_error',
      `${stage === 'chain' ? 'Dostawcy danych blockchain' : 'Źródła'}, które nie odpowiedziały: ${names.join(', ')} — tej części wyniku brakuje; niczego nie uzupełniano.`,
      inStage.reduce((sum, item) => sum + item.count, 0),
    );
  }
  if (failedSources.length > 0) {
    log(
      `WYNIK CZĘŚCIOWY — nie odpowiedziały: ${failedSources.map((item) => `${sourceName(item)} (${item.stage}, ${item.count}×: ${item.message})`).join('; ')}. ` +
        'Ustalenia pochodzą z pozostałych źródeł; brakujących danych nie uzupełniano.',
    );
  }
  const stopKey = (item: ExpansionStop) => stageRank(item.stage) * 100 + REASON_ORDER.indexOf(item.reason);
  const orderedStops = stops
    .map((item, index) => ({ item, index }))
    .sort((a, b) => stopKey(a.item) - stopKey(b.item) || (a.item.detail < b.item.detail ? -1 : a.item.detail > b.item.detail ? 1 : 0) || a.index - b.index)
    .map(({ item }) => item);
  const duplicatesSkipped = duplicates.queries + duplicates.identifiers + duplicates.documents;
  log(
    `Kontrola rozszerzania: zapytań do źródeł ${requests.connectors}, do dostawców danych blockchain ${requests.chain} (budżet ${maxRequests}); ` +
      `pominiętych powtórzeń ${duplicatesSkipped} (zapytania ${duplicates.queries}, identyfikatory ${duplicates.identifiers}, treści ${duplicates.documents}).`,
  );
  if (orderedStops.length > 0) log(`Powody zatrzymania: ${orderedStops.map((item) => `[${item.stage}/${item.reason}] ${item.detail}`).join(' ')}`);
  log(`Koniec analizy: adresów ${findings.length}${partial ? ' (wynik częściowy — limit czasu)' : ''}.`);

  return {
    findings,
    log: journal,
    documents: [...documents.values()],
    intel: {
      version: 1,
      discoveryDepth: depth,
      sightings: [...sightings.values()],
      trail: [...trail.values()],
      checkedCounterparties: counterparties.map(addressKey),
      ...(authorComparisons ? { authorComparisons } : {}),
      ...(partial ? { partial } : {}),
      ...(pivotLeads.length > 0 ? { pivot: pivotLeads } : {}),
      timings,
      slowestQueries,
      ...(mentions.length > 0 ? { mentions } : {}),
      // Zawsze obecne (także puste): teczka odróżnia „sprawdzono, brak beneficjenta” od starszej analizy bez tego etapu.
      beneficiaries: [...beneficiaries.values()],
      ...(organizationNetwork ? { organizationNetwork } : {}),
      expansion: {
        limits: {
          discoveryDepth: depth,
          maxIdentifiers,
          maxRequests,
          maxCounterparties,
          maxChainAddresses: chainLimit,
          pivotSteps: pivotLimits.steps,
          pivotQueriesPerStep: pivotLimits.queriesPerStep,
          pivotMinLinkStrength: PIVOT_LIMITS.minLinkStrength,
          maxBroadDiscovered: MAX_BROAD_DISCOVERED,
          maxBroadAddresses: MAX_BROAD_ADDRESSES,
          maxBroadCounterparties: MAX_BROAD_COUNTERPARTIES,
          mentionStopAuthors,
          requestTimeoutMs: timeoutMs,
          totalTimeoutMs: totalMs,
          concurrency: params.concurrency ?? DEFAULT_CONCURRENCY,
        },
        requests: { connectors: requests.connectors, chain: requests.chain, budget: maxRequests },
        duplicatesSkipped,
        duplicates,
        reliability: EXPANSION_RELIABILITY,
        stops: orderedStops,
        run: {
          startedAt: runStartedAt,
          finishedAt: now().toISOString(),
          identifiers: params.query.identifiers.map((item) => ({ type: item.type, value: item.value.trim() })),
          ...(params.period?.from || params.period?.to ? { period: params.period } : {}),
          connectors: params.connectors.map((connector) => connector.id),
          chainProviders: params.chainProviders.map((provider) => provider.id),
          rulesHash: sha256Hex(JSON.stringify(rules)).slice(0, 16),
          ...(params.ai ? { ai: params.ai.model } : {}),
        },
      },
      ...(failedSources.length > 0 ? { sourceErrors: failedSources } : {}),
    },
  };
}

/** Wykluczone zostają w wynikach (analityk widzi, co odrzucono), ale na końcu listy. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort(
    (a, b) => Number(a.confidence.excluded) - Number(b.confidence.excluded) || b.confidence.score - a.confidence.score,
  );
}

/** Pierwszy dostawca obsługujący sieć, który odpowie bez błędu. */
const firstWorkingProvider: ActivityResolver = async (providers, network, address, context) => {
  for (const provider of providers) {
    if (!provider.supports(network, address)) continue;
    try {
      return await provider.getActivity(network, address, context);
    } catch (error) {
      context.log(`[${provider.id}] BŁĄD dla ${address}: ${errorText(error)}.`);
    }
  }
  return undefined;
};
