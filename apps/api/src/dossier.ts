// Teczka podmiotu: jeden obraz sprawy złożony z zapisanej analizy i decyzji analityka,
// bez ponownego odpytywania źródeł. Kolejność składania odpowiada wadze dla analityka:
// osoby → adresy względem osoby głównej → usługi → sumy i priorytet → reszta.
// Zapisana analiza pozostaje nietknięta — korekty istnieją tylko w teczce.

import { computeConfidence, validateAddress } from '@olcys/core';
import type {
  AnalysisRun,
  Decision,
  Dossier,
  Finding,
  Identifier,
  ScoreRules,
  StoredEvidence,
} from '@olcys/core';
import { sortFindings } from './analysis.ts';
import { detectReplacements } from './diff.ts';
import { buildProfileNodes, decisionMatchesProfile, sightingsOf } from './entity.ts';
import { formatDate } from './format.ts';
import { buildGraph } from './graph.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { RunIntel } from './intel.ts';
import { buildKeyFindings } from './keyfindings.ts';
import { resolvePersons } from './persons.ts';
import { summarizeFindings } from './priority.ts';
import { buildRelatedPersons } from './relations.ts';
import type { OtherCase, RelatedPersonView } from './relations.ts';
import { buildServiceLinks, detectServiceMentions } from './services.ts';
import type { ExternalServiceMatcher, MentionSource } from './services.ts';
import type { CaseSummary, DecisionRecord } from './storage.ts';
import { buildTimeline } from './timeline.ts';

/** Adres w teczce: wynik względem osoby głównej plus adnotacje o korektach. */
export type DossierFinding = Finding & {
  /** Dlaczego wynik różni się od zapisanego w analizie (inna osoba, decyzja analityka). */
  annotations?: string[];
  /** Ślady pominięte w ocenie — widoczne dla analityka, ale nieliczone. */
  excludedEvidence?: StoredEvidence[];
  decision?: Decision;
};

/** Teczka w odpowiedzi API: kontrakt `Dossier` z lokalnymi, dodatkowymi polami. */
export interface DossierView extends Dossier {
  subject: {
    name: string;
    knownNames: string[];
    identifiers: {
      identifier: Identifier;
      origin: 'analyst' | 'discovered';
      sourceUrl?: string;
      /** Ścieżka dojścia: krok wyszukiwania i identyfikator, po którym znaleziono profil wskazujący. */
      step?: number;
      via?: Identifier;
      followed?: boolean;
    }[];
  };
  findings: DossierFinding[];
  relatedPersons: RelatedPersonView[];
  decisions: DecisionRecord[];
  totals: Dossier['totals'] & { cashOutPlnTotal: number };
}

export interface DossierInput {
  caseSummary: CaseSummary;
  run: AnalysisRun;
  intel?: RunIntel | null;
  decisions: DecisionRecord[];
  /** Ostatnie analizy innych spraw — do powiązań między sprawami. */
  otherCases: OtherCase[];
  rules: ScoreRules;
  now: Date;
  matchService?: ExternalServiceMatcher;
}

/** Obowiązuje najnowsza decyzja dla danego celu; wcześniejsze zostają tylko w rejestrze. */
function latestDecisions(decisions: DecisionRecord[], target: DecisionRecord['target']): DecisionRecord[] {
  const byKey = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.target === target) byKey.set(decision.key.trim().toLowerCase(), decision);
  }
  return [...byKey.values()];
}

const decisionNote = (decision: DecisionRecord): string =>
  `decyzja z ${formatDate(decision.decidedAt)} (${decision.author})${decision.note ? `, notatka: „${decision.note}”` : ''}`;

export function buildDossier(input: DossierInput): DossierView {
  const { run, rules, caseSummary } = input;
  const sightings = sightingsOf(run, input.intel);
  const nodes = buildProfileNodes(run, sightings);

  // ---------- Osoby ----------
  const profileDecisions = new Map<string, Decision>();
  for (const decision of latestDecisions(input.decisions, 'profile')) {
    for (const node of nodes) {
      if (decisionMatchesProfile(decision.key, node)) profileDecisions.set(node.card.id, decision.decision);
    }
  }
  const { persons, personOfProfile } = resolvePersons({
    nodes,
    identifiers: run.query.identifiers,
    findings: run.findings,
    decisions: profileDecisions,
    rules,
  });
  const main = persons[0];
  const mainProfileIds = new Set(main && main.probability > 0 ? main.profileIds : []);
  const mainNodes = nodes.filter((node) => mainProfileIds.has(node.card.id));

  // ---------- Adresy względem osoby głównej ----------
  const nodeOfDoc = new Map(nodes.flatMap((node) => node.sightings.map((item) => [sightingKey(item), node] as const)));
  const addressDecisions = new Map(latestDecisions(input.decisions, 'address').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  const findings: DossierFinding[] = run.findings.map((finding) => {
    const kept: StoredEvidence[] = [];
    const dropped: StoredEvidence[] = [];
    const annotations: string[] = [];
    for (const evidence of finding.evidence) {
      const node = nodeOfDoc.get(sightingKey(evidence));
      if (!node) kept.push(evidence);
      else if (!mainProfileIds.has(node.card.id)) {
        dropped.push(evidence);
        const note =
          node.card.decision === 'rejected'
            ? `Pominięto ślad z profilu ${node.card.id} odrzuconego decyzją analityka.`
            : `Pominięto ślad z profilu ${node.card.id}, zaliczonego do innego kandydata (${personOfProfile.get(node.card.id)}) — nie podnosi wyniku osoby głównej.`;
        if (!annotations.includes(note)) annotations.push(note);
      } else {
        kept.push({ ...evidence, identityMatch: node.card.identityMatch, identityReasons: node.card.identityReasons });
      }
    }
    let confidence = computeConfidence(
      { evidence: kept, addressClass: finding.chain?.profile.addressClass ?? 'unknown', unrelatedPublishers: finding.unrelatedPublishers },
      rules,
    );

    const decision = addressDecisions.get(addressKey(finding).toLowerCase()) ?? addressDecisions.get(finding.address.toLowerCase());
    if (decision?.decision === 'rejected') {
      const explanation = `Adres odrzucony przez analityka — ${decisionNote(decision)}. Wykluczony z sum i priorytetu.`;
      annotations.push(explanation);
      confidence = {
        score: 0,
        tier: [...rules.tiers].sort((a, b) => a.min - b.min)[0]!.label,
        excluded: true,
        ledger: [...confidence.ledger, { rule: 'decision.address_rejected', delta: -confidence.score, running: 0, explanation, evidenceIds: [] }],
        nextSteps: [],
      };
    } else if (decision) {
      annotations.push(`Adres potwierdzony przez analityka — ${decisionNote(decision)}. Decyzja odnotowana; wynik liczony bez zmian.`);
    }
    return {
      ...finding,
      evidence: kept,
      confidence,
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(dropped.length > 0 ? { excludedEvidence: dropped } : {}),
      ...(decision ? { decision: decision.decision } : {}),
    };
  });
  sortFindings(findings);

  // ---------- Usługi, sumy, priorytet ----------
  const analystAddresses = new Set(
    run.query.identifiers
      .filter((identifier) => identifier.type === 'crypto_address')
      .map((identifier) => validateAddress(identifier.value.trim()))
      .filter((valid) => valid !== null)
      .map((valid) => addressKey(valid)),
  );
  const { linked } = summarizeFindings(findings, analystAddresses, input.now);

  const evidenceIdOfDoc = new Map(findings.flatMap((finding) => finding.evidence.map((item) => [sightingKey(item), item.id] as const)));
  const mentionSources: MentionSource[] = mainNodes.flatMap((node) =>
    node.sightings.map((sighting) => ({
      url: sighting.url,
      // Starsze analizy nie mają zapisanych wzmianek — zostają cytaty przy adresach.
      mentions:
        sighting.serviceMentions ??
        detectServiceMentions(findings.flatMap((finding) => finding.evidence.filter((item) => sightingKey(item) === sightingKey(sighting)).map((item) => item.excerpt)).join('\n')),
      evidenceId: evidenceIdOfDoc.get(sightingKey(sighting)),
    })),
  );
  const accountNames = [
    ...new Set([
      ...run.query.identifiers.filter((item) => ['nick', 'login', 'email', 'full_name'].includes(item.type)).map((item) => item.value.trim()),
      ...(main?.attributes ?? []).filter((item) => item.kind === 'email' || item.kind === 'handle' || item.kind === 'phone').map((item) => item.value),
      ...(main?.fullName ? [main.fullName] : []),
    ]),
  ].slice(0, 10);
  const serviceLinks = buildServiceLinks({
    subjectFindings: linked,
    publishedServiceFindings: findings.filter((finding) => finding.confidence.ledger[0]?.rule === 'exclusion.address_class'),
    mentionSources,
    accountNames,
    matcher: input.matchService,
  });
  const summary = summarizeFindings(findings, analystAddresses, input.now, serviceLinks);

  // ---------- Reszta obrazu ----------
  const trail = input.intel?.trail ?? [];
  const identifiers: DossierView['subject']['identifiers'] = [
    ...run.query.identifiers.map((identifier) => ({ identifier, origin: 'analyst' as const })),
    ...trail.map((step) => ({
      identifier: step.identifier,
      origin: 'discovered' as const,
      sourceUrl: step.sourceUrl,
      step: step.step,
      via: step.via,
      followed: step.followed,
    })),
  ];
  const replacements = detectReplacements({ ...run, findings });
  const relatedPersons = buildRelatedPersons({ run: { ...run, findings }, linked, sightings, subjectProfiles: mainNodes, otherCases: input.otherCases, rules });
  const profiles = nodes
    .map((node) => node.card)
    .sort((a, b) => Number(mainProfileIds.has(b.id)) - Number(mainProfileIds.has(a.id)) || b.identityScore - a.identityScore);

  return {
    caseId: caseSummary.id,
    runId: run.id,
    generatedAt: input.now.toISOString(),
    subject: {
      name: caseSummary.name,
      knownNames: [
        ...new Set([
          ...(main?.fullName ? [main.fullName] : []),
          ...(main?.nameVariants ?? []),
          ...run.query.identifiers.filter((item) => item.type === 'full_name').map((item) => item.value.trim()),
        ]),
      ],
      identifiers,
    },
    persons,
    profiles,
    findings,
    relatedPersons,
    serviceLinks,
    graph: buildGraph({
      subjectLabel: main?.fullName ?? caseSummary.name,
      caseName: caseSummary.name,
      identifiers,
      profiles: nodes,
      mainProfileIds,
      findings,
      serviceLinks,
      relatedPersons,
      trail,
    }),
    timeline: buildTimeline({ linked, profiles: profiles.filter((profile) => mainProfileIds.has(profile.id)), replacements }),
    totals: {
      linkedAddresses: summary.linkedAddresses,
      excludedAddresses: summary.excludedAddresses,
      topScore: summary.topScore,
      cashOutPlnByYear: summary.cashOutPlnByYear,
      cashOutPlnTotal: summary.cashOutPlnTotal,
      priority: summary.priority,
      priorityReasons: summary.priorityReasons,
    },
    decisions: input.decisions,
    keyFindings: buildKeyFindings({
      persons,
      profiles,
      serviceLinks,
      findings,
      linked,
      cashOutPlnByYear: summary.cashOutPlnByYear,
      replacements,
      relatedPersons,
      priority: summary.priority,
      connectorCount: run.connectors.length,
    }),
  };
}
