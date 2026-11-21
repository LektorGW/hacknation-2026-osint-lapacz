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
import { insightEffect } from './ai-rules.ts';
import type { InsightEvidence } from './ai-rules.ts';
import { effectiveUnrelatedPublishers, sortFindings } from './analysis.ts';
import type { AnalysisFinding } from './analysis.ts';
import { detectReplacements } from './diff.ts';
import { buildProfileNodes, decisionMatchesProfile, sightingsOf } from './entity.ts';
import { formatDate } from './format.ts';
import { buildGraph } from './graph.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { MentionSummary, RunIntel } from './intel.ts';
import { buildKeyFindings } from './keyfindings.ts';
import { resolvePersons } from './persons.ts';
import { summarizeFindings } from './priority.ts';
import { buildCashOutProof } from './proof.ts';
import type { CashOutProof } from './proof.ts';
import { buildRelatedPersons } from './relations.ts';
import type { OtherCase, RelatedPersonView } from './relations.ts';
import { buildServiceLinks, detectServiceMentions } from './services.ts';
import type { ExternalServiceMatcher, MentionSource } from './services.ts';
import type { CaseSummary, DecisionRecord } from './storage.ts';
import { buildTimeline } from './timeline.ts';

/** Adres w teczce: wynik względem osoby głównej plus adnotacje o korektach. */
export type DossierFinding = Omit<Finding, 'evidence'> & {
  /** Ślady z opcjonalnym odczytem publikacji przez model językowy (`insight`). */
  evidence: InsightEvidence[];
  /** Adres cytowany przez bardzo wielu autorów — nikomu nieprzypisany. */
  widelyCited?: boolean;
  /** Analizę blockchain pominięto (limit adresów albo czasu). */
  chainSkipped?: boolean;
  /**
   * Łączne prawdopodobieństwo (0–100), że adres należy do OSOBY ZE SPRAWY: prawdopodobieństwo
   * kandydata głównego × prawdopodobieństwo adresu u tego kandydata / 100.
   */
  subjectProbability: number;
  /** Dlaczego wynik różni się od zapisanego w analizie (inna osoba, decyzja analityka). */
  annotations?: string[];
  /** Ślady pominięte w ocenie — widoczne dla analityka, ale nieliczone. */
  excludedEvidence?: InsightEvidence[];
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
  /** Dowód spieniężenia: ustalenia „osoba → adres → ścieżka → usługa”, od najpewniejszego. Puste, gdy brak ścieżek. */
  cashOutProof: CashOutProof[];
  /** Streszczenie wygenerowane przez model z kluczowych ustaleń; `null` bez modelu. */
  summary: { text: string; model: string; promptVersion: string } | null;
  /** Analiza przerwana limitem czasu — wynik częściowy. */
  partial: boolean;
  /** Identyfikatory podmiotu wymieniane w publikacjach innych autorów — wzmianki, nie profile. */
  mentions: MentionSummary[];
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
function latestDecisions(decisions: DecisionRecord[], target: string): DecisionRecord[] {
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
    authorComparisons: input.intel?.authorComparisons,
  });
  const main = persons[0];
  const mainProfileIds = new Set(main && main.probability > 0 ? main.profileIds : []);
  const mainNodes = nodes.filter((node) => mainProfileIds.has(node.card.id));

  // ---------- Adresy względem osoby głównej ----------
  const nodeOfDoc = new Map(nodes.flatMap((node) => node.sightings.map((item) => [sightingKey(item), node] as const)));
  const addressDecisions = new Map(latestDecisions(input.decisions, 'address').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  // Decyzja dla pojedynczego śladu: „potwierdzony” cofa wpływ modelu, „odrzucony” wyłącza ślad.
  const evidenceDecisions = new Map(latestDecisions(input.decisions, 'evidence').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  const findings: DossierFinding[] = (run.findings as AnalysisFinding[]).map((finding) => {
    const kept: InsightEvidence[] = [];
    const dropped: InsightEvidence[] = [];
    const annotations: string[] = [...(finding.notes ?? [])];
    /** Ślady wyłączone odczytem modelu — do osobnego wpisu w księdze. */
    const byModel: { evidence: InsightEvidence; note: string }[] = [];
    for (const evidence of finding.evidence) {
      const node = nodeOfDoc.get(sightingKey(evidence));
      const own = evidenceDecisions.get(evidence.id.toLowerCase());
      const effect = insightEffect(evidence);
      if (effect?.categoryNote && !annotations.includes(effect.categoryNote)) annotations.push(effect.categoryNote);
      if (own?.decision === 'rejected') {
        dropped.push(evidence);
        annotations.push(`Pominięto ślad ${evidence.url} odrzucony przez analityka — ${decisionNote(own)}.`);
      } else if (effect?.effect === 'excludes' && own?.decision !== 'confirmed' && node?.card.decision !== 'confirmed') {
        dropped.push(evidence);
        byModel.push({ evidence, note: effect.note });
        annotations.push(`${effect.note} Ślad: ${evidence.url}. Decyzja analityka „potwierdzony” dla śladu lub profilu cofa ten wpływ.`);
      } else if (effect?.effect === 'excludes') {
        annotations.push(`Odczyt modelu dla śladu ${evidence.url} pominięto decyzją analityka — ślad jest wliczany.`);
        kept.push(node ? { ...evidence, identityMatch: node.card.identityMatch, identityReasons: node.card.identityReasons } : evidence);
      } else if (!node) kept.push(evidence);
      else if (!mainProfileIds.has(node.card.id)) {
        dropped.push(evidence);
        const note =
          node.card.decision === 'rejected'
            ? `Pominięto ślad z profilu ${node.card.id} odrzuconego decyzją analityka.`
            : `Pominięto ślad z profilu ${node.card.id}, zaliczonego do innego kandydata (${personOfProfile.get(node.card.id)}) — nie podnosi wyniku osoby głównej.`;
        if (!annotations.includes(note)) annotations.push(note);
      } else {
        if (effect?.effect === 'confirms') annotations.push(`${effect.note} Ślad: ${evidence.url}.`);
        kept.push({ ...evidence, identityMatch: node.card.identityMatch, identityReasons: node.card.identityReasons });
      }
    }
    const addressClass = finding.chain?.profile.addressClass ?? 'unknown';
    // Dowód kryptograficzny lub potwierdzony profil ma pierwszeństwo przed liczbą cytujących adres.
    const unrelatedPublishers = effectiveUnrelatedPublishers(kept, finding.unrelatedPublishers);
    let confidence = computeConfidence({ evidence: kept, addressClass, unrelatedPublishers }, rules);
    if (byModel.length > 0 && !confidence.excluded) {
      // Wpływ modelu jest jawny: różnica względem wyniku liczonego z tymi śladami.
      const withModelEvidence = computeConfidence(
        { evidence: [...kept, ...byModel.map((item) => item.evidence)], addressClass, unrelatedPublishers },
        rules,
      );
      confidence = {
        ...confidence,
        ledger: [
          ...confidence.ledger,
          {
            rule: 'ai.ownership',
            delta: confidence.score - withModelEvidence.score,
            running: confidence.score,
            explanation: `Ślady niewliczone po odczycie modelu językowego (${byModel.length}): ${byModel.map((item) => item.note).join(' ')}`,
            evidenceIds: byModel.map((item) => item.evidence.id),
          },
        ],
      };
    }
    const widelyCited = finding.confidence.ledger.find((entry) => entry.rule === 'exclusion.widely_cited');
    if (widelyCited && !confidence.excluded && unrelatedPublishers > 0) {
      confidence = {
        score: 0,
        tier: [...rules.tiers].sort((a, b) => a.min - b.min)[0]!.label,
        excluded: true,
        ledger: [...confidence.ledger, { ...widelyCited, delta: -confidence.score }],
        nextSteps: [],
      };
    }

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
    const personAddress = main?.addresses.find((item) => item.key === addressKey(finding))?.probability ?? 0;
    return {
      ...finding,
      evidence: kept,
      confidence,
      subjectProbability: confidence.excluded || kept.length === 0 ? 0 : Math.round(((main?.probability ?? 0) * personAddress) / 100),
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
  const linkedKeys = new Set(linked.map(addressKey));
  const cashOutProof = buildCashOutProof({ findings, linkedKeys, analystAddresses, main });
  const serviceLinks = buildServiceLinks({
    subjectFindings: linked,
    publishedServiceFindings: findings.filter((finding) => finding.confidence.ledger[0]?.rule === 'exclusion.address_class'),
    mentionSources,
    accountNames,
    matcher: input.matchService,
  });
  const summary = summarizeFindings(findings, analystAddresses, input.now, serviceLinks, cashOutProof[0]?.combinedConfidence);

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
    cashOutProof,
    summary: null,
    partial: input.intel?.partial === true,
    mentions: input.intel?.mentions ?? [],
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
      proofs: cashOutProof,
    }),
    timeline: buildTimeline({ linked, profiles: profiles.filter((profile) => mainProfileIds.has(profile.id)), replacements, proofs: cashOutProof }),
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
      mentions: input.intel?.mentions ?? [],
      proofs: cashOutProof,
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
