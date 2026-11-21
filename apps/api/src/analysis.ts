// Przebieg analizy: od identyfikatorów podmiotu do listy powiązań podmiot–adres.
// Funkcja nie zna konkretnych źródeł ani sieci — dostaje łączniki i dostawców
// danych blockchain przez parametry, więc da się ją testować atrapami.

import { createHash } from 'node:crypto';
import { computeConfidence, DEFAULT_RULES, extractAddresses, validateAddress } from '@olcys/core';
import { AI_RULES } from './ai-rules.ts';
import type { InsightEvidence } from './ai-rules.ts';
import { createLimiter } from './concurrency.ts';
import { unlabeledCounterparties } from './counterparties.ts';
import { buildProfileNodes } from './entity.ts';
import { assessIdentity, assessLinkedProfile, isUniqueType, matchRank, normalize as normalizeName } from './identity.ts';
import type { IdentityAssessment } from './identity.ts';
import { addressKey, sightingKey } from './intel.ts';
import { mentionsInDocument } from './services.ts';
import type { AuthorComparison, DiscoveryStep, MentionSummary, RunIntel, Sighting, SightingRole } from './intel.ts';
import { comparablePairs } from './persons.ts';
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
  /** Od ilu niepowiązanych autorów adres uznajemy za powszechnie cytowany i nikomu go nie przypisujemy. */
  widelyCitedAuthors?: number;
  /** Limit czasu całej analizy; po jego upływie zwracany jest wynik częściowy. */
  totalTimeoutMs?: number;
  /**
   * Czy łącznik jest źródłem wyszukiwawczym (dopasowuje po fragmencie treści). Jego dokument
   * jest przypisywany osobie tylko przy zgodnym autorze albo unikalnym identyfikatorze w treści.
   */
  isSearchSource?: (connectorId: string) => boolean;
  /** Limit czasu zapytania dla wybranych łączników (np. wyszukiwarka wielu forów potrzebuje więcej). */
  connectorTimeouts?: Record<string, number>;
  /** Sprowadza nietypowe zapisy adresów w treści do postaci wykrywalnej (np. ze spacjami); domyślnie bez zmian. */
  normalizeText?: (text: string) => string;
  /** Ilu najwyżej różnych autorów może wymieniać dane kontaktowe podmiotu, by wzmianki uznać za jego publikacje. */
  maxMentionAuthors?: number;
  /** Model językowy (opcjonalny): odczyt publikacji i porównanie autorów. */
  ai?: AiAssistant;
  maxAiPublications?: number;
  /** Odbiorca postępu — do pokazania analitykowi w trakcie długiej analizy. */
  onProgress?: (progress: AnalysisProgress) => void;
}

export type AnalysisStage = 'search' | 'occurrences' | 'chain' | 'counterparties' | 'ai' | 'scoring';

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
  /** Analizę blockchain pominięto z powodu limitu adresów albo czasu. */
  chainSkipped?: boolean;
  notes?: string[];
};

/** Domyślnie: indeks własny, wyszukiwarka forów, źródła monitoringu i wszystko z „search” w nazwie. */
export const defaultIsSearchSource = (connectorId: string): boolean =>
  connectorId === 'corpus' || connectorId === 'deep-search' || connectorId.startsWith('mon-') || connectorId.includes('search');

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
}

const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_DISCOVERY_DEPTH = 3;
export const DEFAULT_MAX_IDENTIFIERS = 40;
export const DEFAULT_MAX_COUNTERPARTIES = 10;
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_MAX_CHAIN_ADDRESSES = 15;
export const DEFAULT_WIDELY_CITED_AUTHORS = 10;
export const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_MENTION_AUTHORS = 3;
/** Najwyżej tyle par profili porównuje model językowy w jednej analizie. */
const MAX_AUTHOR_COMPARISONS = 10;

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

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

  const normalizeText = params.normalizeText ?? ((text: string) => text);
  /** Adresy w treści — po sprowadzeniu nietypowych zapisów do postaci wykrywalnej. */
  const extract = (text: string) => extractAddresses(normalizeText(text));

  const groups = new Map<string, AddressGroup>();
  const documents = new Map<string, CapturedDocument>();
  const sightings = new Map<string, Sighting>();

  // Limit czasu całej analizy liczymy zegarem monotonicznym, niezależnym od wstrzykniętego `now`.
  const deadline = performance.now() + (params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  let partial = false;
  const expired = (what: string): boolean => {
    if (performance.now() < deadline) return false;
    if (!partial) log(`Przekroczono limit czasu całej analizy — ${what} i dalsze kroki pominięto; wynik jest częściowy.`);
    partial = true;
    return true;
  };

  const progress: AnalysisProgress = { stage: 'search', connectorsDone: 0, connectorsTotal: 0, documents: 0, addresses: 0 };
  const report = (stage?: AnalysisStage) => {
    if (stage) progress.stage = stage;
    progress.documents = sightings.size;
    progress.addresses = groups.size;
    params.onProgress?.({ ...progress });
  };

  // Ten sam post widziany przez różne łączniki: jeden adres publikacji i jedna kopia treści.
  const isSearchSource = params.isSearchSource ?? defaultIsSearchSource;
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
        ...(role === 'subject' ? { serviceMentions: mentionsInDocument(doc) } : {}),
      });
      return;
    }
    for (const address of addresses) if (!existing.addresses.includes(address)) existing.addresses.push(address);
    // Dokument przypisany podmiotowi nie wraca do roli „inna osoba”.
    if (role !== 'subject') return;
    if (existing.role !== 'subject' || matchRank(identity.match) > matchRank(existing.identity.match)) {
      if (existing.role !== 'subject') existing.serviceMentions = mentionsInDocument(doc);
      existing.role = 'subject';
      existing.identity = identity;
      existing.matchedIdentifier = doc.matchedIdentifier;
      existing.step = Math.min(existing.step, step);
    }
  };

  const addEvidence = (
    group: AddressGroup,
    doc: SourceDocument,
    identity: IdentityAssessment,
    excerpt: string,
    contentHash: string,
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
    });
    capture(doc, contentHash);
  };

  /** Pyta wszystkie łączniki akceptujące dany typ; błąd jednego nie zatrzymuje pozostałych. */
  const search = async (identifier: Identifier): Promise<SourceDocument[]> => {
    const accepting = params.connectors.filter((connector) => connector.accepts.includes(identifier.type));
    progress.connectorsTotal += accepting.length;
    const results = await Promise.all(
      accepting.map((connector) =>
        limited(async () => {
          if (expired('wyszukiwanie w części źródeł')) return [];
          const context = (signal: AbortSignal): ConnectorContext => ({
            signal,
            log: (message) => log(`[${connector.id}] ${message}`),
          });
          try {
            const found = await withTimeout(
              (signal) => connector.search(identifier, context(signal)),
              params.connectorTimeouts?.[connector.id] ?? timeoutMs,
              params.signal,
            );
            log(`[${connector.id}] ${identifier.type} „${identifier.value}”: dokumentów ${found.length}.`);
            return found;
          } catch (error) {
            log(`[${connector.id}] BŁĄD przy ${identifier.type} „${identifier.value}”: ${errorText(error)}. Źródło pominięte.`);
            return [];
          } finally {
            progress.connectorsDone++;
            report();
          }
        }),
      ),
    );
    const unique: SourceDocument[] = [];
    let duplicates = 0;
    for (const doc of results.flat()) {
      const kept = dedupe(doc);
      if (kept) unique.push(kept);
      else duplicates++;
    }
    if (duplicates > 0) log(`Pominięto ${duplicates} powtórzeń tej samej treści pod innym adresem (${identifier.type} „${identifier.value}”).`);
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
      mentions.push({ identifier, documents: rejected, authors: authors.size, services });
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
    groupFor(valid.network, valid.address, valid.checksumVerified);
    log(`Adres podany przez analityka: ${valid.address} (${valid.network}).`);
  }

  /** Nazwy, pod którymi podmiot występuje: wartość → czy powiązanie jest pośrednie/słabe. */
  const knownNames = new Map<string, IdentityMatch>();
  for (const identifier of personIdentifiers) knownNames.set(normalizeName(identifier.value), 'exact_identifier');

  log(`Start analizy: identyfikatorów ${inputKeys.size}, łączników ${params.connectors.length}.`);

  // ---------- Wyszukiwanie krok po kroku: identyfikatory podane, potem odkryte ----------

  const ingest = (doc: SourceDocument, identity: IdentityAssessment, step: number) => {
    const detected = extract(doc.text);
    noteSighting(doc, identity, 'subject', step, detected.map(addressKey));
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

  /** Odnotowuje identyfikatory wskazane przez dokument i wybiera te do kolejnego kroku. */
  const collectDiscovered = (doc: SourceDocument, identity: IdentityAssessment, step: number, next: Map<string, Pending>) => {
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
        // Ten sam identyfikator wskazany w tym kroku także przez mocniejszy dokument.
        if (match === 'linked_profile' && pending.match !== 'linked_profile') {
          pending.match = match;
          trail.get(key)!.match = match;
        }
        continue;
      }
      if (trail.has(key)) continue;

      const withinDepth = step < depth;
      const withinLimit = inputKeys.size + [...trail.values()].filter((entry) => entry.followed).length < maxIdentifiers;
      const followed = withinDepth && withinLimit;
      trail.set(key, {
        identifier,
        step: step + 1,
        sourceUrl: doc.url,
        sourceService: doc.service,
        via: doc.matchedIdentifier,
        match,
        followed,
      });
      if (followed) {
        next.set(key, { identifier, match, distance: (identity.distance ?? 0) + 1, parent: doc.matchedIdentifier });
        log(`Odkryty identyfikator (krok ${step + 1}): ${identifier.type} „${identifier.value}” — wskazany w ${doc.url}.`);
      } else if (withinDepth && !limitLogged) {
        limitLogged = true;
        log(`Osiągnięto limit ${maxIdentifiers} identyfikatorów w analizie — kolejne odkryte identyfikatory nie są już wyszukiwane.`);
      }
    }
  };

  let frontier: Pending[] = personIdentifiers.map((identifier) => ({ identifier, match: 'exact_identifier', distance: 0 }));
  for (let step = 0; frontier.length > 0; step++) {
    const batches = await Promise.all(
      frontier.map(async (item) => ({ item, docs: await search(item.identifier) })),
    );
    const next = new Map<string, Pending>();
    for (const { item, docs } of batches) {
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
        collectDiscovered(doc, identity, step, next);
      }
    }
    frontier = [...next.values()];
    if (frontier.length > 0) log(`Krok ${step + 1} wyszukiwania: nowych identyfikatorów ${frontier.length}.`);
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

  const checkOccurrences = async (group: AddressGroup) => {
    const key = `${group.network}:${group.address}`;
    const occurrences = await search({ type: 'crypto_address', value: group.address });
    const candidateAuthors = new Set<string>();
    for (const doc of occurrences) {
      const hit = extract(doc.text).find((item) => `${item.network}:${item.address}` === key);
      if (!hit) continue;
      if ([...group.evidence.values()].some((item) => item.url === doc.url && item.archivedAt === doc.archivedAt)) continue;
      const contentHash = sha256Hex(doc.text);
      const author = doc.author ? normalizeName(doc.author) : '';
      const relation = author ? knownNames.get(author) : undefined;
      if (addressOnly && author) {
        const identity: IdentityAssessment = {
          match: 'exact_identifier',
          reasons: [`Autor „${doc.author}” sam opublikował ten adres.`],
          distance: 0,
        };
        addEvidence(group, doc, identity, hit.context, contentHash);
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
    if (candidateAuthors.size > 1) {
      // Kilku różnych autorów przy jednym adresie osłabia przypisanie do któregokolwiek z nich.
      const [, ...others] = candidateAuthors;
      for (const other of others) group.unrelatedAuthors.add(other);
      log(`Adres ${group.address} publikuje ${candidateAuthors.size} różnych autorów — przypisanie niejednoznaczne.`);
    }
  };
  report('occurrences');
  await Promise.all([...groups.values()].map(checkOccurrences));

  // ---------- Dane blockchain ----------

  const resolveActivity = params.resolveActivity ?? firstWorkingProvider;
  const fetchActivity = (group: AddressGroup) =>
    limited(async () => {
      try {
        group.chain = await withTimeout(
          (signal) => resolveActivity(params.chainProviders, group.network, group.address, { signal, log }),
          // Limit obejmuje kolejne próby u wszystkich dostawców.
          timeoutMs * Math.max(1, params.chainProviders.length),
          params.signal,
        );
        if (!group.chain) log(`${group.address}: brak danych blockchain — adres pozostaje bez klasyfikacji.`);
      } catch (error) {
        log(`${group.address}: BŁĄD pobierania danych blockchain: ${errorText(error)}.`);
      }
    });
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
  const chainLimit = params.maxChainAddresses ?? DEFAULT_MAX_CHAIN_ADDRESSES;
  const chainSkipped = new Set(ranked.slice(chainLimit));
  if (chainSkipped.size > 0) {
    log(`Adresów ${ranked.length}, limit analizy blockchain ${chainLimit} — ${chainSkipped.size} najsłabiej udokumentowanych pozostaje bez analizy łańcucha.`);
  }
  report('chain');
  await Promise.all(
    ranked.slice(0, chainLimit).map(async (group) => {
      if (expired('analizę blockchain części adresów')) chainSkipped.add(group);
      else await fetchActivity(group);
    }),
  );

  // ---------- Kontrahenci bez etykiety: czy ktoś opublikował ich adresy? ----------

  const subjectGroups = [...groups.values()].filter(
    (group) => !rules.excludedClasses.includes(group.chain?.profile.addressClass ?? 'unknown'),
  );
  const counterparties = unlabeledCounterparties(subjectGroups, new Set(groups.keys())).slice(0, maxCounterparties);
  report('counterparties');
  if (counterparties.length > 0) {
    log(`Sprawdzanie kontrahentów bez etykiety (największych wartością): ${counterparties.length}.`);
  }
  await Promise.all(
    counterparties.map(async (candidate) => {
      const key = addressKey(candidate);
      for (const doc of await search({ type: 'crypto_address', value: candidate.address })) {
        if (!extract(doc.text).some((item) => addressKey(item) === key)) continue;
        const author = doc.author ? normalizeName(doc.author) : '';
        if (!author) continue;
        if (knownNames.has(author)) {
          log(`Kontrahent ${candidate.address} jest publikowany przez sam podmiot („${doc.author}”, ${doc.url}) — warto dodać ten adres do sprawy.`);
          continue;
        }
        capture(doc, sha256Hex(doc.text));
        noteSighting(doc, { match: 'same_handle', reasons: [] }, 'counterparty_publisher', 0, [key]);
        log(`Kontrahent ${candidate.address} opublikowany przez „${doc.author}”: ${doc.url} — możliwa osoba powiązana.`);
      }
    }),
  );

  // ---------- Wskaźnik Pewności ----------

  report('scoring');
  const widelyCitedFrom = params.widelyCitedAuthors ?? DEFAULT_WIDELY_CITED_AUTHORS;
  const findings: AnalysisFinding[] = [];
  for (const group of groups.values()) {
    const evidence = [...group.evidence.values()];
    const unrelatedPublishers = group.unrelatedAuthors.size;
    const counted = effectiveUnrelatedPublishers(evidence, unrelatedPublishers);
    let confidence = computeConfidence({ evidence, addressClass: group.chain?.profile.addressClass ?? 'unknown', unrelatedPublishers: counted }, rules);
    const notes: string[] = [...group.notes];
    if (counted !== unrelatedPublishers && unrelatedPublishers >= rules.sharedAddressThreshold) {
      notes.push(
        `Adres wymienia także ${unrelatedPublishers} innych autorów; własność potwierdza dowód kryptograficzny lub potwierdzona tożsamość profilu, ` +
          'więc cytowania nie obniżają wyniku.',
      );
    }
    const widelyCited = counted >= widelyCitedFrom;
    if (widelyCited && !confidence.excluded) {
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
    if (chainSkipped.has(group)) notes.push('Nie analizowano łańcucha: adres poza limitem liczby adresów albo czasu analizy.');
    findings.push({
      address: group.address,
      network: group.network,
      checksumVerified: group.checksumVerified,
      evidence,
      confidence,
      chain: group.chain,
      unrelatedPublishers,
      ...(widelyCited ? { widelyCited } : {}),
      ...(chainSkipped.has(group) ? { chainSkipped: true } : {}),
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
    const comparisons: AuthorComparison[] = [];
    await Promise.all(
      comparablePairs(nodes, findings, rules)
        .slice(0, MAX_AUTHOR_COMPARISONS)
        .map(({ a, b }) =>
          aiLimited(async () => {
            const texts = (node: (typeof nodes)[number]) => node.sightings.map(textOf).filter((text): text is string => Boolean(text));
            const [left, right] = [texts(a), texts(b)];
            if (left.length === 0 || right.length === 0 || performance.now() >= deadline) return;
            try {
              const result = await ai.compareAuthors(left, right);
              if (result) comparisons.push({ a: a.card.id, b: b.card.id, likelihood: result.likelihood, reasons: result.reasons, model: result.model });
            } catch (error) {
              log(`[model ${ai.model}] BŁĄD porównania autorów ${a.card.id} / ${b.card.id}: ${errorText(error)}.`);
            }
          }),
        ),
    );
    if (comparisons.length > 0) {
      authorComparisons = comparisons;
      log(`[model ${ai.model}] porównano styl autorów dla par profili: ${comparisons.length} (słaba przesłanka, nie łączy profili).`);
    }
  }

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
      ...(mentions.length > 0 ? { mentions } : {}),
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
