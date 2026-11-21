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
import { buildLinkedIdentities } from './aliases.ts';
import type { LinkedIdentity } from './aliases.ts';
import { insightEffect } from './ai-rules.ts';
import type { InsightEvidence } from './ai-rules.ts';
import { OWNERSHIP_CATEGORIES, effectiveUnrelatedPublishers, sortFindings } from './analysis.ts';
import type { AnalysisFinding } from './analysis.ts';
import { detectReplacements } from './diff.ts';
import { buildProfileNodes, decisionMatchesProfile, profileKey, sightingsOf } from './entity.ts';
import { formatDate, sumByYear } from './format.ts';
import { buildExplanations, buildUnconfirmedAddresses } from './explain.ts';
import type { Explanation, ServiceLabel, UnconfirmedAddress } from './explain.ts';
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
  totals: Dossier['totals'] & {
    cashOutPlnTotal: number;
    /** Wypłaty osoby głównej łącznie z tożsamościami o relacji „prawdopodobnie ta sama osoba”. */
    cashOutPlnByYearWithLikelySame: Record<string, number>;
    cashOutPlnTotalWithLikelySame: number;
  };
  /** Inne tożsamości tej samej osoby oraz osoby bliskie lub podstawione — karty „Powiązana tożsamość”. */
  linkedIdentities: LinkedIdentity[];
  /** Słabe tropy niewykazane jako tożsamości (wynik poniżej progu): sama podobna nazwa konta, sam odczyt stylu, jednokierunkowy przelew. */
  weakLeadsHidden: number;
  /** Dowód spieniężenia: ustalenia „osoba → adres → ścieżka → usługa”, od najpewniejszego. Puste, gdy brak ścieżek. */
  cashOutProof: CashOutProof[];
  /** Streszczenie wygenerowane przez model z kluczowych ustaleń; `null` bez modelu. */
  summary: { text: string; model: string; promptVersion: string } | null;
  /** Analiza przerwana limitem czasu — wynik częściowy. */
  partial: boolean;
  /** Identyfikatory podmiotu wymieniane w publikacjach innych autorów — wzmianki, nie profile. */
  mentions: MentionSummary[];
  /** Adresy znalezione, ale nieprzypisane podmiotowi — sekcja „Adresy do potwierdzenia”. */
  unconfirmedAddresses: UnconfirmedAddress[];
  /** Dlaczego nie ma adresów albo dowodu spieniężenia i co można zrobić. */
  explanations: Explanation[];
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
  /** Publicznie oznaczone adresy usług (zbiór etykiet modułu danych blockchain). */
  serviceLabels?: ServiceLabel[];
  /** Analiza wykonana w trybie głębokim. */
  deep?: boolean;
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
  // Decyzja „to ta sama osoba” dla profilu powiązanej tożsamości scala ją z podmiotem:
  // jej publikacje są wtedy liczone jak publikacje podmiotu.
  const mergedKeys = new Set(latestDecisions(input.decisions, 'profile').filter((decision) => decision.decision === 'confirmed').map((decision) => decision.key.trim().toLowerCase()));
  const sightings = sightingsOf(run, input.intel).map((sighting) =>
    sighting.role !== 'subject' && (mergedKeys.has(profileKey(sighting).toLowerCase()) || mergedKeys.has(sighting.url.toLowerCase()))
      ? { ...sighting, role: 'subject' as const, step: 0, identity: { match: 'verified_link' as const, reasons: ['Tożsamość scalona z osobą główną decyzją analityka.'], distance: 0 } }
      : sighting,
  );
  const nodes = buildProfileNodes(run, sightings);

  const analystAddresses = new Set(
    run.query.identifiers
      .filter((identifier) => identifier.type === 'crypto_address')
      .map((identifier) => validateAddress(identifier.value.trim()))
      .filter((valid) => valid !== null)
      .map((valid) => addressKey(valid)),
  );

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
  // Analiza samego adresu, który jest powszechnie cytowany: publikacje nie wskazują właściciela,
  // więc teczka nie podaje żadnego kandydata na osobę (autorzy są policzeni we wzmiankach).
  const addressOnly = run.query.identifiers.length > 0 && run.query.identifiers.every((item) => item.type === 'crypto_address');
  const subjectFindings = (run.findings as AnalysisFinding[]).filter((finding) => analystAddresses.has(addressKey(finding)));
  const ownerUnknown = addressOnly && subjectFindings.length > 0 && subjectFindings.every((finding) => finding.widelyCited);
  if (ownerUnknown) persons.length = 0;
  const main = persons[0];
  const mainProfileIds = new Set(main && main.probability > 0 ? main.profileIds : []);
  const mainNodes = nodes.filter((node) => mainProfileIds.has(node.card.id));

  // ---------- Adresy względem osoby głównej ----------
  const nodeOfDoc = new Map(nodes.flatMap((node) => node.sightings.map((item) => [sightingKey(item), node] as const)));
  const addressDecisions = new Map(latestDecisions(input.decisions, 'address').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  // Decyzja dla pojedynczego śladu: „potwierdzony” cofa wpływ modelu, „odrzucony” wyłącza ślad.
  const evidenceDecisions = new Map(latestDecisions(input.decisions, 'evidence').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  // Adresy znane tylko z publikacji powiązanych tożsamości nie są adresami podmiotu — chyba że
  // analityk scalił tożsamość (wtedy publikujący profil należy już do osoby głównej).
  const stillLinkedOnly = (finding: AnalysisFinding) =>
    finding.linkedOnly === true && !finding.evidence.some((item) => mainProfileIds.has(nodeOfDoc.get(sightingKey(item))?.card.id ?? ''));
  const linkedFindings = (run.findings as AnalysisFinding[]).filter(stillLinkedOnly);
  const findings: DossierFinding[] = (run.findings as AnalysisFinding[]).filter((finding) => !stillLinkedOnly(finding)).map((finding) => {
    const kept: InsightEvidence[] = [];
    const dropped: InsightEvidence[] = [];
    const annotations: string[] = (finding.notes ?? []).filter((note) => !note.startsWith('Adres opublikowany przez powiązaną tożsamość'));
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
            : ownerUnknown
            ? `Pominięto ślad z profilu ${node.card.id}: adres jest powszechnie cytowany, więc autor publikacji nie jest wskazywany jako właściciel.`
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
    if (widelyCited && !confidence.excluded && unrelatedPublishers > 0 && !analystAddresses.has(addressKey(finding))) {
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
      annotations.push(`Adres potwierdzony przez analityka — ${decisionNote(decision)}. Adres jest liczony jak podany w sprawie: wchodzi do sum, usług i dowodu spieniężenia.`);
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
  // Adres potwierdzony decyzją analityka jest liczony tak samo jak adres podany w sprawie.
  const confirmedAddresses = new Set(findings.filter((finding) => finding.decision === 'confirmed').map(addressKey));
  const subjectAddresses = new Set([...analystAddresses, ...confirmedAddresses]);
  const { linked } = summarizeFindings(findings, subjectAddresses, input.now);

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
  const unconfirmedAddresses = ownerUnknown ? [] : buildUnconfirmedAddresses({ findings, linkedKeys, persons, nodes, personOfProfile, matcher: input.matchService });
  const cashOutProof = buildCashOutProof({
    findings,
    linkedKeys,
    analystAddresses,
    confirmedAddresses,
    main,
    unconfirmed: new Map(
      unconfirmedAddresses.map((item) => [
        addressKey(item),
        {
          probability: item.personAddressProbability,
          origin: item.sources[0] ? `z profilu ${item.sources[0].service}${item.sources[0].author ? ` „${item.sources[0].author}”` : ''}` : 'o słabej podstawie',
        },
      ]),
    ),
  });
  const confirmedProofs = cashOutProof.filter((proof) => !proof.ownerUnconfirmed);
  const serviceLinks = buildServiceLinks({
    subjectFindings: linked,
    publishedServiceFindings: findings.filter((finding) => finding.confidence.ledger[0]?.rule === 'exclusion.address_class'),
    mentionSources,
    accountNames,
    matcher: input.matchService,
  });
  const summary = summarizeFindings(findings, subjectAddresses, input.now, serviceLinks, confirmedProofs[0]?.combinedConfidence);

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
  const relatedPersons = buildRelatedPersons({ run: { ...run, findings }, linked, sightings, subjectProfiles: mainNodes, otherCases: input.otherCases, rules, addressOnly });
  const { identities: linkedIdentities, hidden: weakLeadsHidden } = ownerUnknown
    ? { identities: [], hidden: 0 }
    : buildLinkedIdentities({
        main,
        mainNodes,
        otherNodes: nodes.filter((node) => !mainProfileIds.has(node.card.id)),
        externalNodes: [
          ...buildProfileNodes(run, sightings, 'linked_identity'),
          // Współpublikujący liczy się tylko wtedy, gdy podaje adres jako własny (profil, oferta).
          ...buildProfileNodes(run, sightings, 'co_publisher').filter((node) => node.sightings.some((item) => OWNERSHIP_CATEGORIES.includes(item.category))),
          ...buildProfileNodes(run, sightings, 'counterparty_publisher'),
        ],
        leads: input.intel?.pivot ?? [],
        linked,
        allFindings: run.findings,
        authorComparisons: input.intel?.authorComparisons,
        decisionOf: (node) => latestDecisions(input.decisions, 'profile').find((decision) => decisionMatchesProfile(decision.key, node))?.decision,
        rules,
      });
  const likelySame = sumByYear([summary.cashOutPlnByYear, ...linkedIdentities.filter((item) => item.relation === 'same_person_likely').map((item) => item.cashOutPlnByYear)]);
  const profiles = (ownerUnknown ? [] : nodes)
    .map((node) => node.card)
    .sort((a, b) => Number(mainProfileIds.has(b.id)) - Number(mainProfileIds.has(a.id)) || b.identityScore - a.identityScore);

  const explanations = buildExplanations({
    identifiers: run.query.identifiers,
    findings,
    linked,
    unconfirmed: unconfirmedAddresses,
    confirmedProofs: confirmedProofs.length,
    cashOutPlnTotal: summary.cashOutPlnTotal,
    profiles,
    connectorCount: run.connectors.length,
    deep: input.deep === true,
    partial: input.intel?.partial === true,
    serviceLabels: input.serviceLabels,
    matcher: input.matchService,
  });

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
    unconfirmedAddresses,
    explanations,
    linkedIdentities,
    weakLeadsHidden,
    graph: buildGraph({
      subjectLabel: main?.fullName ?? caseSummary.name,
      caseName: caseSummary.name,
      identifiers,
      profiles: ownerUnknown ? [] : nodes,
      mainProfileIds,
      findings,
      serviceLinks,
      relatedPersons,
      trail,
      proofs: confirmedProofs,
      linkedIdentities,
    }),
    timeline: buildTimeline({ linked, profiles: profiles.filter((profile) => mainProfileIds.has(profile.id)), replacements, proofs: confirmedProofs }),
    totals: {
      linkedAddresses: summary.linkedAddresses,
      excludedAddresses: summary.excludedAddresses,
      topScore: summary.topScore,
      cashOutPlnByYear: summary.cashOutPlnByYear,
      cashOutPlnTotal: summary.cashOutPlnTotal,
      cashOutPlnByYearWithLikelySame: likelySame,
      cashOutPlnTotalWithLikelySame: Math.round(Object.values(likelySame).reduce((sum, value) => sum + value, 0) * 100) / 100,
      priority: summary.priority,
      priorityReasons: addressOnly
        ? [...summary.priorityReasons, 'Sprawa dotyczy adresu: sumy i priorytet opisują badany adres, a nie osobę.']
        : summary.priorityReasons,
    },
    decisions: input.decisions,
    keyFindings: buildKeyFindings({
      addressOnly,
      widelyCited: subjectFindings.some((finding) => finding.widelyCited),
      mentions: input.intel?.mentions ?? [],
      explanations,
      linkedIdentities,
      unconfirmed: unconfirmedAddresses,
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
