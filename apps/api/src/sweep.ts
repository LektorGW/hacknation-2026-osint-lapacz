// Typowanie podmiotów — „przegląd źródeł”. Zamiast czekać na identyfikator od analityka,
// narzędzie samo pobiera świeże publikacje (łączniki z metodą `discover`), wyciąga z nich
// adresy, grupuje po autorze i dla każdego autora wykonuje pełną analizę. Wynik to ranking
// podmiotów według priorytetu — lista wskazań do sprawdzenia, nie ustaleń.

import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, extractAddresses } from '@olcys/core';
import type { ConnectorContext, DiscoveringConnector, Lead, SourceConnector, SourceDocument, SubjectQuery, Sweep } from '@olcys/core';
import { runAnalysis } from './analysis.ts';
import type { AnalysisParams } from './analysis.ts';
import { mapLimit } from './concurrency.ts';
import { buildDossier } from './dossier.ts';
import { normalize } from './identity.ts';
import type { ExternalServiceMatcher } from './services.ts';
import type { LeadAnalysis } from './storage.ts';

export const DEFAULT_SWEEP_LIMIT = 25;
/** Ile publikacji pobieramy z jednego źródła. */
const DISCOVER_DOCUMENTS = 100;
/** Ile analiz wytypowanych podmiotów trwa jednocześnie (każda ma własny limit zapytań). */
const LEAD_CONCURRENCY = 3;

export interface SweepParams extends AuthorAnalysisParams {
  /** Najwyżej tylu autorów zostanie przeanalizowanych. */
  limit?: number;
}

export interface SweepResult {
  sweep: Sweep;
  /** Pełne analizy wytypowanych podmiotów: `Lead.id` → analiza. */
  analyses: Map<string, LeadAnalysis>;
}

export const canDiscover = (connector: SourceConnector): connector is DiscoveringConnector =>
  typeof (connector as Partial<DiscoveringConnector>).discover === 'function';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface AuthorGroup {
  handle: string;
  documents: SourceDocument[];
  addresses: Set<string>;
}

/** Zależności pełnej analizy jednego autora — wspólne dla przeglądu źródeł i monitoringu. */
export interface AuthorAnalysisParams extends Pick<AnalysisParams, 'chainProviders' | 'resolveActivity' | 'rules' | 'timeoutMs' | 'signal' | 'ai' | 'normalizeText'> {
  connectors: SourceConnector[];
  now?: () => Date;
  matchService?: ExternalServiceMatcher;
}

/**
 * Pełna analiza autora publikacji i wskazanie (`Lead`) z priorytetem liczonym tak samo
 * jak w teczce sprawy — priorytet wskazania i późniejszej sprawy jest spójny.
 */
export async function analyzeAuthor(
  params: AuthorAnalysisParams,
  handle: string,
  query: SubjectQuery,
): Promise<{ lead: Lead; analysis: LeadAnalysis }> {
  const now = params.now ?? (() => new Date());
  const connectors = params.connectors.map((connector) => connector.id);
  const startedAt = now().toISOString();
  const result = await runAnalysis({
    query,
    connectors: params.connectors,
    chainProviders: params.chainProviders,
    resolveActivity: params.resolveActivity,
    rules: params.rules,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    ai: params.ai,
    normalizeText: params.normalizeText,
    now,
  });
  const finishedAt = now().toISOString();
  const id = randomUUID();
  const dossier = buildDossier({
    caseSummary: { id: '', name: handle, createdAt: startedAt, query, runs: [] },
    run: { id, caseId: '', startedAt, finishedAt, status: 'completed', query, connectors, findings: result.findings, log: [] },
    intel: result.intel,
    decisions: [],
    otherCases: [],
    rules: params.rules ?? DEFAULT_RULES,
    now: now(),
    matchService: params.matchService,
  });
  const mainProfiles = dossier.profiles.filter((profile) => dossier.persons[0]?.profileIds.includes(profile.id));
  return {
    lead: {
      id,
      handle,
      services: [...new Set(mainProfiles.map((profile) => profile.service))],
      profileUrls: [...new Set(mainProfiles.map((profile) => profile.url))],
      addresses: dossier.findings
        .filter((finding) => !finding.confidence.excluded && finding.confidence.score > 0)
        .map((finding) => ({ address: finding.address, network: finding.network, score: finding.confidence.score })),
      topScore: dossier.totals.topScore,
      cashOutPlnByYear: dossier.totals.cashOutPlnByYear,
      cashOutPlnTotal: dossier.totals.cashOutPlnTotal,
      priority: dossier.totals.priority,
      priorityReasons: dossier.totals.priorityReasons,
    },
    analysis: { query, connectors, startedAt, finishedAt, findings: result.findings, log: result.log, documents: result.documents, intel: result.intel },
  };
}

export async function runSweep(params: SweepParams): Promise<SweepResult> {
  const now = params.now ?? (() => new Date());
  const limit = params.limit ?? DEFAULT_SWEEP_LIMIT;
  const sweep: Sweep = {
    id: randomUUID(),
    startedAt: now().toISOString(),
    status: 'running',
    connectors: params.connectors.map((connector) => connector.id),
    documentsScanned: 0,
    leads: [],
    log: [],
  };
  const log = (message: string) => sweep.log.push({ time: now().toISOString(), message });
  const analyses = new Map<string, LeadAnalysis>();

  const discovering = params.connectors.filter(canDiscover);
  if (discovering.length === 0) {
    log('Żaden z wybranych łączników nie potrafi sam wskazać świeżych publikacji (brak metody discover) — przegląd nie ma czego typować.');
    sweep.status = 'completed';
    sweep.finishedAt = now().toISOString();
    return { sweep, analyses };
  }

  // ---------- Świeże publikacje ----------
  const batches = await mapLimit(discovering, 6, async (connector) => {
    const context: ConnectorContext = { log: (message) => log(`[${connector.id}] ${message}`) };
    try {
      const found = await connector.discover(context, DISCOVER_DOCUMENTS);
      log(`[${connector.id}] ostatnie publikacje: ${found.length}.`);
      return found;
    } catch (error) {
      log(`[${connector.id}] BŁĄD pobierania publikacji: ${errorText(error)}. Źródło pominięte.`);
      return [];
    }
  });
  const documents = batches.flat();
  sweep.documentsScanned = documents.length;

  // ---------- Autorzy publikujący adresy ----------
  const authors = new Map<string, AuthorGroup>();
  for (const doc of documents) {
    const handle = (doc.profile?.handle ?? doc.author ?? '').trim().replace(/^@/, '');
    const addresses = extractAddresses(doc.text);
    if (!handle || addresses.length === 0) continue;
    const group = authors.get(normalize(handle)) ?? { handle, documents: [], addresses: new Set<string>() };
    authors.set(normalize(handle), group);
    group.documents.push(doc);
    for (const item of addresses) group.addresses.add(item.address);
  }
  // Najpierw autorzy z największą liczbą adresów i publikacji — tam najłatwiej o trafienie.
  const ranked = [...authors.values()].sort(
    (a, b) => b.addresses.size - a.addresses.size || b.documents.length - a.documents.length || a.handle.localeCompare(b.handle),
  );
  const selected = ranked.slice(0, limit);
  log(
    `Publikacji z adresami: ${[...authors.values()].reduce((sum, group) => sum + group.documents.length, 0)} z ${documents.length}; ` +
      `autorów ${authors.size}, do analizy ${selected.length} (limit ${limit}).`,
  );

  // ---------- Pełna analiza każdego autora ----------
  const leads = await mapLimit(selected, LEAD_CONCURRENCY, async (group): Promise<Lead | undefined> => {
    try {
      const { lead, analysis } = await analyzeAuthor(params, group.handle, { identifiers: [{ type: 'nick', value: group.handle }] });
      analyses.set(lead.id, analysis);
      return lead;
    } catch (error) {
      log(`Analiza autora „${group.handle}” nie powiodła się: ${errorText(error)}.`);
      return undefined;
    }
  });

  // Autor, u którego żaden adres nie przeszedł oceny (np. same adresy giełd), nie jest wskazaniem.
  const scored = leads.filter((lead): lead is Lead => lead !== undefined);
  const dropped = scored.filter((lead) => lead.topScore === 0);
  for (const lead of dropped) analyses.delete(lead.id);
  if (dropped.length > 0) {
    log(`Pominięto autorów bez adresu powiązanego (wynik 0%): ${dropped.map((lead) => lead.handle).join(', ')}.`);
  }
  sweep.leads = scored
    .filter((lead) => lead.topScore > 0)
    .sort((a, b) => b.priority - a.priority || b.topScore - a.topScore || a.handle.localeCompare(b.handle));
  log(`Koniec przeglądu: wytypowanych podmiotów ${sweep.leads.length}.`);
  sweep.status = 'completed';
  sweep.finishedAt = now().toISOString();
  return { sweep, analyses };
}
