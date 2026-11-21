// Przebieg analizy: od identyfikatorów podmiotu do listy powiązań podmiot–adres.
// Funkcja nie zna konkretnych źródeł ani sieci — dostaje łączniki i dostawców
// danych blockchain przez parametry, więc da się ją testować atrapami.

import { createHash } from 'node:crypto';
import { computeConfidence, DEFAULT_RULES, extractAddresses, validateAddress } from '@olcys/core';
import { createLimiter } from './concurrency.ts';
import { unlabeledCounterparties } from './counterparties.ts';
import { assessIdentity, assessLinkedProfile, matchRank, normalize as normalizeName } from './identity.ts';
import type { IdentityAssessment } from './identity.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { DiscoveryStep, RunIntel, Sighting, SightingRole } from './intel.ts';
import type {
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
}

export interface AnalysisResult {
  findings: Finding[];
  log: { time: string; message: string }[];
  documents: CapturedDocument[];
  /** Profile, ścieżka odkrywania i publikacje innych osób — materiał do teczki. */
  intel: RunIntel;
}

interface AddressGroup {
  address: string;
  network: Network;
  checksumVerified: boolean;
  evidence: Map<string, StoredEvidence>;
  /** Autorzy publikujący adres, których nie da się powiązać z podmiotem. */
  unrelatedAuthors: Set<string>;
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

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const identifierKey = (identifier: Identifier) => `${identifier.type}:${identifier.value.trim().toLowerCase()}`;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

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

  const groups = new Map<string, AddressGroup>();
  const documents = new Map<string, CapturedDocument>();
  const sightings = new Map<string, Sighting>();

  const groupFor = (network: Network, address: string, checksumVerified: boolean): AddressGroup => {
    const key = `${network}:${address}`;
    let group = groups.get(key);
    if (!group) {
      group = { address, network, checksumVerified, evidence: new Map(), unrelatedAuthors: new Set() };
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
      });
      return;
    }
    for (const address of addresses) if (!existing.addresses.includes(address)) existing.addresses.push(address);
    // Dokument przypisany podmiotowi nie wraca do roli „inna osoba”.
    if (role !== 'subject') return;
    if (existing.role !== 'subject' || matchRank(identity.match) > matchRank(existing.identity.match)) {
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
    const results = await Promise.all(
      accepting.map((connector) =>
        limited(async () => {
          const context = (signal: AbortSignal): ConnectorContext => ({
            signal,
            log: (message) => log(`[${connector.id}] ${message}`),
          });
          try {
            const found = await withTimeout(
              (signal) => connector.search(identifier, context(signal)),
              timeoutMs,
              params.signal,
            );
            log(`[${connector.id}] ${identifier.type} „${identifier.value}”: dokumentów ${found.length}.`);
            return found;
          } catch (error) {
            log(`[${connector.id}] BŁĄD przy ${identifier.type} „${identifier.value}”: ${errorText(error)}. Źródło pominięte.`);
            return [];
          }
        }),
      ),
    );
    return results.flat();
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
    const detected = extractAddresses(doc.text);
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
      for (const doc of docs) {
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

  // ---------- Wystąpienia adresów u innych autorów ----------

  // Analiza samego adresu (bez identyfikatorów osoby) odwraca pytanie: kto ten adres
  // publikuje? Każdy autor jest wtedy kandydatem na właściciela, a jego publikacja — śladem.
  const addressOnly = personIdentifiers.length === 0;

  const checkOccurrences = async (group: AddressGroup) => {
    const key = `${group.network}:${group.address}`;
    const occurrences = await search({ type: 'crypto_address', value: group.address });
    const candidateAuthors = new Set<string>();
    for (const doc of occurrences) {
      const hit = extractAddresses(doc.text).find((item) => `${item.network}:${item.address}` === key);
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
        log(`Adres ${group.address} występuje w ${doc.url} bez wskazanego autora — nie wliczono do publikujących.`);
      }
    }
    if (candidateAuthors.size > 1) {
      // Kilku różnych autorów przy jednym adresie osłabia przypisanie do któregokolwiek z nich.
      const [, ...others] = candidateAuthors;
      for (const other of others) group.unrelatedAuthors.add(other);
      log(`Adres ${group.address} publikuje ${candidateAuthors.size} różnych autorów — przypisanie niejednoznaczne.`);
    }
  };
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
  await Promise.all([...groups.values()].map(fetchActivity));

  // ---------- Kontrahenci bez etykiety: czy ktoś opublikował ich adresy? ----------

  const subjectGroups = [...groups.values()].filter(
    (group) => !rules.excludedClasses.includes(group.chain?.profile.addressClass ?? 'unknown'),
  );
  const counterparties = unlabeledCounterparties(subjectGroups, new Set(groups.keys())).slice(0, maxCounterparties);
  if (counterparties.length > 0) {
    log(`Sprawdzanie kontrahentów bez etykiety (największych wartością): ${counterparties.length}.`);
  }
  await Promise.all(
    counterparties.map(async (candidate) => {
      const key = addressKey(candidate);
      for (const doc of await search({ type: 'crypto_address', value: candidate.address })) {
        if (!extractAddresses(doc.text).some((item) => addressKey(item) === key)) continue;
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

  const findings: Finding[] = [];
  for (const group of groups.values()) {
    const evidence = [...group.evidence.values()];
    const unrelatedPublishers = group.unrelatedAuthors.size;
    const confidence = computeConfidence(
      { evidence, addressClass: group.chain?.profile.addressClass ?? 'unknown', unrelatedPublishers },
      rules,
    );
    findings.push({
      address: group.address,
      network: group.network,
      checksumVerified: group.checksumVerified,
      evidence,
      confidence,
      chain: group.chain,
      unrelatedPublishers,
    });
    log(
      `${group.address}: Wskaźnik Pewności ${confidence.score}% (${confidence.tier})` +
        `${confidence.excluded ? ' — adres wykluczony' : ''}; śladów ${evidence.length}.`,
    );
  }

  sortFindings(findings);
  log(`Koniec analizy: adresów ${findings.length}.`);

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
