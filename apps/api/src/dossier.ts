// Teczka podmiotu: jeden obraz sprawy złożony z zapisanej analizy i decyzji analityka,
// bez ponownego odpytywania źródeł. Kolejność składania odpowiada wadze dla analityka:
// osoby → adresy względem osoby głównej → usługi → sumy i priorytet → reszta.
// Zapisana analiza pozostaje nietknięta — korekty istnieją tylko w teczce.

import { computeConfidence, linkKey, validateAddress } from '@olcys/core';
import type {
  AnalysisRun,
  Decision,
  Dossier,
  Finding,
  Identifier,
  InvestigationIndicators,
  PersonCandidate,
  TimelineEvent,
  ScoreRules,
  StoredEvidence,
} from '@olcys/core';
import { buildLinkedIdentities, identityRelationLabel } from './aliases.ts';
import type { LinkedIdentity } from './aliases.ts';
import { insightEffect } from './ai-rules.ts';
import type { InsightEvidence } from './ai-rules.ts';
import { OWNERSHIP_CATEGORIES, effectiveUnrelatedPublishers, sortFindings } from './analysis.ts';
import { buildCashOutAssessments } from './cashout-stage.ts';
import { fiatPublicationsOf } from './fiat-signals.ts';
import { applyBusinessBadges, businessForDossier, businessKeyFindings } from './business.ts';
import { checkNetworkNodes } from '@olcys/sources';
import type { AnalysisFinding } from './analysis.ts';
import { detectReplacements } from './diff.ts';
import { buildProfileNodes, decisionMatchesProfile, profileKey, sightingsOf } from './entity.ts';
import { formatDate, shortAddress, sumByYear } from './format.ts';
import { buildExplanations, buildUnconfirmedAddresses } from './explain.ts';
import type { Explanation, ServiceLabel, UnconfirmedAddress } from './explain.ts';
import { buildGraph } from './graph.ts';
import { riskListGraph } from '@olcys/sources';
import type { RiskGraphResult } from '@olcys/sources';
import { addressKey, sightingKey } from './intel.ts';
import type { MentionSummary, RunIntel } from './intel.ts';
import { buildKeyFindings } from './keyfindings.ts';
import { applyMixerExposure, mixerKeyFindings } from './mixers.ts';
import { applyScamWarnings, scamKeyFindings } from './scam.ts';
import type { ScamDocument, ScamWarnings } from './scam.ts';
import type { MixerExposure } from './mixers.ts';
import { buildAccountWalletLinks, buildOperatorHypotheses } from './operator.ts';
import { PERSON_RULES, resolvePersons } from './persons.ts';
import { summarizeFindings } from './priority.ts';
import { collectFundingSources, collectSeizures, isIncidentSource, relatedAddressesOf } from './provenance.ts';
import type { FundingSourceView, RelatedAddress, SeizureView } from './provenance.ts';
import { buildCashOutProof } from './proof.ts';
import type { CashOutProof } from './proof.ts';
import { buildRelatedPersons } from './relations.ts';
import type { OtherCase, RelatedPersonView } from './relations.ts';
import { buildReplyView, evaluateReply, formatFiat, payoutSummary, payoutsForMatch, replyCitation, replyKeyFindings, replyRef, sameFullName } from './service-reply.ts';
import type { ServiceReply, ServiceReplyRef, ServiceReplyView } from './service-reply.ts';
import type { DocumentedExitSource } from './cashout-stage.ts';
import { buildServiceLinks, detectServiceMentions } from './services.ts';
import type { ExternalServiceMatcher, MentionSource } from './services.ts';
import type { CaseSummary, DecisionRecord } from './storage.ts';
import { buildTimeline } from './timeline.ts';
import { beneficiaryNote, charityClass } from './beneficiary.ts';
import { addressLinkGraph, buildAddressNetwork } from './network.ts';
import type { AddressNetwork } from './network.ts';
import { annotateExplanations, insertOrganizationFindings, organizationGraph, organizationViews, resolveBeneficiaries } from './organizations.ts';
import type { DossierOrganization } from './organizations.ts';
import type { OrganizationNetwork } from './org-network.ts';
import { applyPublicFigureDecision, mergeOrganizationNetworks, networkCounts, publicFigureFinding, publicFigureGraph } from './public-figure.ts';
import type { PublicFigure, PublicFigureAddress, PublicFigureRole } from './public-figure.ts';
import type { ExpansionRecord } from './network/types.ts';

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
  /** Własność adresu potwierdziła odpowiedź usługi (dokument spoza OSINT) — adres liczony jak potwierdzony przez analityka. */
  confirmedByReply?: ServiceReplyRef;
  /**
   * Inne adresy powiązane z tym adresem w samym blockchainie (ten sam portfel, wspólny adres wpłat,
   * finansowanie), których nikt nie opublikował — adresy, nie osoby.
   */
  relatedAddresses?: RelatedAddress[];
};

/** Kandydat na osobę w teczce — z odwołaniem do odpowiedzi usługi, która go potwierdziła albo mu przeczy. */
export type DossierPerson = PersonCandidate & {
  /** Status „confirmed” wynika z odpowiedzi usługi (dane KYC zgodne z kandydatem), nie z decyzji analityka. */
  confirmedByReply?: ServiceReplyRef;
  /** Sprzeczności z odpowiedziami usług: konto w usłudze należy do innej osoby. */
  replyContradictions?: string[];
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
  /** Kandydaci na osobę; główny może być potwierdzony odpowiedzią usługi albo mieć jawną sprzeczność z jej treścią. */
  persons: DossierPerson[];
  /**
   * Odpowiedzi usług wprowadzone przez analityka — DOKUMENTY SPOZA OSINT, nie znaleziska narzędzia.
   * Każda z wynikiem dopasowania do danych sprawy i skutkami; wycofane zostają z oznaczeniem.
   */
  serviceReplies: ServiceReplyView[];
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
  /** Przelewy na adresy organów państwa (zajęcie środków) — nie są spieniężeniem i nie wchodzą do sum wypłat. */
  seizures: SeizureView[];
  /** Skąd przyszły środki na adresy podmiotu (z publicznych etykiet). */
  fundingSources: FundingSourceView[];
  /** Adresy znalezione, ale nieprzypisane podmiotowi — sekcja „Adresy do potwierdzenia”. */
  unconfirmedAddresses: UnconfirmedAddress[];
  /** Dlaczego nie ma adresów albo dowodu spieniężenia i co można zrobić. */
  explanations: Explanation[];
  /** Trzy osobne wskaźniki: konto→portfel, wspólny operator (hipotezy), wyjście do walut tradycyjnych. */
  indicators: InvestigationIndicators;
  /** Źródła i dostawcy danych, którzy nie odpowiedzieli — wynik jest w tej części niepełny, niczego nie uzupełniano. */
  sourceErrors: NonNullable<RunIntel['sourceErrors']>;
  /** Kontrola rozszerzania analizy: limity, budżet zapytań, powody zatrzymania, parametry do powtórzenia. Brak dla starszych analiz. */
  expansion?: RunIntel['expansion'];
  /**
   * Organizacje wskazane przez kontekst cytowań adresu (beneficjent zbiórki / odbiorca płatności) — hipotezy z jawnym
   * wskaźnikiem. Organizacja nie jest kandydatem na osobę: Wskaźnik Pewności dla osoby pozostaje 0%.
   */
  organizations: DossierOrganization[];
  /** Sieć organizacji z rejestrów publicznych: osoby w rolach (nie właściciele adresu), podmioty powiązane, źródła, zatrzymania. */
  organizationNetwork?: OrganizationNetwork;
  /** Dopasowanie podmiotu do osoby publicznej w Wikidata (hipoteza / decyzja analityka) z rolami i licznikami siatki. */
  publicFigure?: PublicFigure;
  /** Siatka adresu: wpływy i wypływy zbiorczo, punkty zapytania, ten sam portfel — bez osób dla wpłacających. */
  addressNetwork: AddressNetwork[];
  /** Odznaki list sankcyjnych i ostrzeżeń dla węzłów grafu (id węzła → trafienie); brak = brak trafień. */
  riskLists?: RiskGraphResult['badges'];
  /** Miksery i CoinJoin: czy środki adresów sprawy przeszły przez mikser (poziom, przekazania, hipotezy, listy sankcyjne). */
  mixerExposure: MixerExposure;
  /** Ostrzeżenia o możliwym oszustwie z użyciem adresów sprawy (zgłoszenia, wzorzec rozdania, zbiory ostrzeżeń, zatruwanie adresu). */
  scamWarnings: ScamWarnings;
}

export interface DossierInput {
  caseSummary: CaseSummary;
  run: AnalysisRun;
  intel?: RunIntel | null;
  decisions: DecisionRecord[];
  /** Odpowiedzi usług wprowadzone przez analityka (łącznie z wycofanymi). */
  serviceReplies?: ServiceReply[];
  /** Ostatnie analizy innych spraw — do powiązań między sprawami. */
  otherCases: OtherCase[];
  rules: ScoreRules;
  now: Date;
  matchService?: ExternalServiceMatcher;
  /** Publicznie oznaczone adresy usług (zbiór etykiet modułu danych blockchain). */
  serviceLabels?: ServiceLabel[];
  /** Analiza wykonana w trybie głębokim. */
  deep?: boolean;
  /** Rozwinięcia sieci sprawy — z nich teczka bierze sieć osoby publicznej rozwiniętą po decyzji analityka. */
  expansions?: Pick<ExpansionRecord, 'id' | 'startedAt' | 'withdrawnAt' | 'results'>[];
  /** Pełne treści dokumentów analizy (także publikacji innych autorów) — do ostrzeżeń o oszustwie; bez nich tylko fragmenty śladów. */
  documents?: ScamDocument[];
}

/** Obowiązuje najnowsza decyzja dla danego celu; wcześniejsze zostają tylko w rejestrze. */
function latestDecisions(decisions: DecisionRecord[], target: string): DecisionRecord[] {
  const byKey = new Map<string, DecisionRecord>();
  for (const decision of decisions) {
    if (decision.target === target) byKey.set(decision.key.trim().toLowerCase(), decision);
  }
  return [...byKey.values()];
}

/** Klucz decyzji o parze kont w postaci kanonicznej (`linkKey`), bez względu na kolejność i wielkość liter. */
function canonicalLinkKey(key: string): string | undefined {
  const parts = key.split('<->').map((part) => part.trim());
  return parts.length === 2 && parts[0] && parts[1] && parts[0].toLowerCase() !== parts[1].toLowerCase() ? linkKey(parts[0], parts[1]) : undefined;
}

const decisionNote = (decision: DecisionRecord): string =>
  `decyzja z ${formatDate(decision.decidedAt)} (${decision.author})${decision.note ? `, notatka: „${decision.note}”` : ''}`;

export function buildDossier(input: DossierInput): DossierView {
  const { run, rules, caseSummary } = input;
  // Decyzje wycofane zostają w rejestrze (historia i audyt), ale niczego nie zmieniają:
  // po wycofaniu wynik jest dokładnie taki, jak bez tej decyzji.
  const decisions = input.decisions.filter((decision) => !decision.withdrawnAt);
  // Decyzje o parach kont (hipoteza wspólnego operatora): klucz kanoniczny → obowiązująca decyzja.
  const linkDecisions = new Map<string, DecisionRecord>();
  for (const decision of latestDecisions(decisions, 'link')) {
    const key = canonicalLinkKey(decision.key);
    if (key) linkDecisions.set(key, decision);
  }
  const linkDecisionOf = (a: string, b: string): Decision | undefined => linkDecisions.get(linkKey(a, b))?.decision;
  const linkedAccounts = new Set([...linkDecisions].filter(([, decision]) => decision.decision === 'confirmed').flatMap(([key]) => key.split('<->')));
  // Decyzja „to ta sama osoba” dla profilu powiązanej tożsamości scala ją z podmiotem:
  // jej publikacje są wtedy liczone jak publikacje podmiotu.
  const mergedKeys = new Set(latestDecisions(decisions, 'profile').filter((decision) => decision.decision === 'confirmed').map((decision) => decision.key.trim().toLowerCase()));
  const sightings = sightingsOf(run, input.intel).map((sighting) =>
    sighting.role !== 'subject' && (mergedKeys.has(profileKey(sighting).toLowerCase()) || mergedKeys.has(sighting.url.toLowerCase()))
      ? { ...sighting, role: 'subject' as const, step: 0, identity: { match: 'verified_link' as const, reasons: ['Tożsamość scalona z osobą główną decyzją analityka.'], distance: 0 } }
      : sighting.role !== 'subject' && linkedAccounts.has(profileKey(sighting).toLowerCase())
        ? // Konto wskazane w potwierdzonej parze trafia między profile sprawy — do kandydata, z którym je połączono.
          { ...sighting, role: 'subject' as const, identity: { match: 'linked_profile' as const, reasons: ['Konto włączone do profili sprawy decyzją analityka o wspólnym operatorze.'] } }
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
  for (const decision of latestDecisions(decisions, 'profile')) {
    for (const node of nodes) {
      if (decisionMatchesProfile(decision.key, node)) profileDecisions.set(node.card.id, decision.decision);
    }
  }
  const { persons, personOfProfile, blockedPairs } = resolvePersons({
    nodes,
    identifiers: run.query.identifiers,
    findings: run.findings,
    decisions: profileDecisions,
    linkDecisions: new Map([...linkDecisions].map(([key, decision]) => [key, decision.decision])),
    rules,
    authorComparisons: input.intel?.authorComparisons,
  });
  // Analiza samego adresu, który jest powszechnie cytowany: publikacje nie wskazują właściciela,
  // więc teczka nie podaje żadnego kandydata na osobę (autorzy są policzeni we wzmiankach).
  const addressOnly = run.query.identifiers.length > 0 && run.query.identifiers.every((item) => item.type === 'crypto_address');
  const subjectFindings = (run.findings as AnalysisFinding[]).filter((finding) => analystAddresses.has(addressKey(finding)));
  const ownerUnknown = addressOnly && subjectFindings.length > 0 && subjectFindings.every((finding) => finding.widelyCited);
  if (ownerUnknown) persons.length = 0;
  // Beneficjent adresu cytowanego przez wielu: czyj to adres zbiórki (organizacja, nie osoba).
  const beneficiaries = resolveBeneficiaries(run.findings, input.intel);
  const beneficiaryOf = new Map(beneficiaries.filter((item) => item.attributed).map((item) => [addressKey(item), item]));
  let main: DossierPerson | undefined = persons[0];
  const mainProfileIds = new Set(main && main.probability > 0 ? main.profileIds : []);
  const mainNodes = nodes.filter((node) => mainProfileIds.has(node.card.id));

  // ---------- Adresy względem osoby głównej ----------
  const nodeOfDoc = new Map(nodes.flatMap((node) => node.sightings.map((item) => [sightingKey(item), node] as const)));
  const addressDecisions = new Map(latestDecisions(decisions, 'address').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  // Decyzja dla pojedynczego śladu: „potwierdzony” cofa wpływ modelu, „odrzucony” wyłącza ślad.
  const evidenceDecisions = new Map(latestDecisions(decisions, 'evidence').map((decision) => [decision.key.trim().toLowerCase(), decision]));

  // Adresy znane tylko z publikacji powiązanych tożsamości nie są adresami podmiotu — chyba że
  // analityk scalił tożsamość (wtedy publikujący profil należy już do osoby głównej).
  const stillLinkedOnly = (finding: AnalysisFinding) =>
    finding.linkedOnly === true && !finding.evidence.some((item) => mainProfileIds.has(nodeOfDoc.get(sightingKey(item))?.card.id ?? ''));
  const linkedFindings = (run.findings as AnalysisFinding[]).filter(stillLinkedOnly);

  // ---------- Odpowiedzi usług (dokumenty spoza OSINT wprowadzone przez analityka) ----------
  // Wycofane i niedopasowane niczego nie zmieniają: bez obowiązującej, dopasowanej odpowiedzi teczka liczy się dokładnie jak dotąd.
  const addressDecisionFor = (finding: Finding) => addressDecisions.get(addressKey(finding).toLowerCase()) ?? addressDecisions.get(finding.address.toLowerCase());
  const evaluations = (input.serviceReplies ?? [])
    .filter((reply) => !reply.withdrawnAt)
    .map((reply) =>
      evaluateReply(
        reply,
        (run.findings as AnalysisFinding[]).filter((finding) => !stillLinkedOnly(finding)),
        main,
        run.query.identifiers,
        (finding) => finding.confidence.excluded || addressDecisionFor(finding)?.decision === 'rejected',
      ),
    );
  const replyConfirmedKeys = new Map<string, ServiceReplyRef>();
  const replyNotes = new Map<string, string[]>();
  for (const evaluation of evaluations) {
    const { reply } = evaluation;
    for (const match of evaluation.matches.filter((item) => !item.excluded)) {
      if (evaluation.identity === 'confirmed') {
        if (!replyConfirmedKeys.has(match.key)) replyConfirmedKeys.set(match.key, replyRef(reply));
        continue;
      }
      const holder = reply.payload.customer?.fullName;
      const note =
        evaluation.identity === 'other_person'
          ? `Odpowiedź ${replyCitation(reply)} (dokument spoza OSINT): konto w usłudze, na które trafiły środki z tego adresu, należy do innej osoby${holder ? ` („${holder}”)` : ''} — własność adresu NIE została potwierdzona tą odpowiedzią.`
          : `Odpowiedź ${replyCitation(reply)} (dokument spoza OSINT) dotyczy transakcji tego adresu; nie rozstrzyga, czyj jest adres.`;
      replyNotes.set(match.key, [...(replyNotes.get(match.key) ?? []), note]);
    }
  }
  const confirming = evaluations.find((item) => item.identity === 'confirmed');
  if (confirming && main) {
    // Dane KYC z usługi zgodne z kandydatem głównym: kandydat potwierdzony tak, jak decyzją analityka, z dokumentem jako podstawą.
    main = {
      ...main,
      status: 'confirmed',
      probability: PERSON_RULES.probability.analyst_confirmed,
      reasons: [
        `Podstawa ${PERSON_RULES.probability.analyst_confirmed}: potwierdzone odpowiedzią ${replyCitation(confirming.reply)} — dokument spoza OSINT wprowadzony przez analityka. ${confirming.identityBasis.join(' ')}`,
        ...main.reasons.map((reason) => reason.replace(/^Podstawa (\d+): /, 'Wcześniejsza ocena narzędzia ($1): ')),
      ],
      confirmedByReply: replyRef(confirming.reply),
    };
    persons[0] = main;
  }
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
    // Adres zbiórki organizacji nie jest przypisywany osobie (klasa „charity”); adres analityka zostaje przedmiotem sprawy.
    const beneficiary = beneficiaryOf.get(addressKey(finding));
    const addressClass = charityClass(finding.chain?.profile.addressClass, beneficiary, analystAddresses.has(addressKey(finding)));
    if (beneficiary && !annotations.some((note) => note.startsWith('Adres zbiórki organizacji') || note.startsWith('Adres płatności organizacji'))) annotations.push(beneficiaryNote(beneficiary));
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

    if (beneficiary && analystAddresses.has(addressKey(finding)) && confidence.score === 0) {
      confidence = {
        ...confidence,
        ledger: [
          ...confidence.ledger,
          { rule: 'info.charity_beneficiary', delta: 0, running: 0, explanation: `0% dla osoby — znany adres zbiórki organizacji „${beneficiary.name}” (hipoteza z kontekstu cytowań). Adres podany przez analityka pozostaje przedmiotem sprawy: łańcuch i sumy dotyczą adresu.`, evidenceIds: [] },
        ],
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
    const byReply = decision?.decision === 'rejected' || confidence.excluded ? undefined : replyConfirmedKeys.get(addressKey(finding));
    if (byReply) {
      annotations.push(
        `Własność adresu potwierdzona odpowiedzią usługi ${byReply.serviceName}, sygn. ${byReply.reference} (dokument spoza OSINT wprowadzony przez analityka): konto, na które trafiły środki z tego adresu, należy do kandydata głównego. ` +
          'Adres jest liczony jak potwierdzony przez analityka: wchodzi do sum, usług i dowodu spieniężenia.',
      );
    }
    if (!confidence.excluded) annotations.push(...(replyNotes.get(addressKey(finding)) ?? []));
    const personAddress = main?.addresses.find((item) => item.key === addressKey(finding))?.probability ?? 0;
    return {
      ...finding,
      evidence: kept,
      confidence,
      subjectProbability: confidence.excluded || kept.length === 0 ? 0 : Math.round(((main?.probability ?? 0) * personAddress) / 100),
      ...(annotations.length > 0 ? { annotations } : {}),
      ...(dropped.length > 0 ? { excludedEvidence: dropped } : {}),
      ...(decision ? { decision: decision.decision } : {}),
      ...(byReply ? { confirmedByReply: byReply } : {}),
    };
  });
  sortFindings(findings);

  // ---------- Usługi, sumy, priorytet ----------
  // Adres potwierdzony decyzją analityka jest liczony tak samo jak adres podany w sprawie.
  // Tak samo liczony jest adres, którego własność potwierdziła odpowiedź usługi.
  const confirmedByReply = new Map(findings.flatMap((finding) => (finding.confirmedByReply ? [[addressKey(finding), finding.confirmedByReply] as const] : [])));
  const confirmedAddresses = new Set(findings.filter((finding) => finding.decision === 'confirmed' || finding.confirmedByReply).map(addressKey));
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
    confirmedByReply,
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
  // Ustalenia, których transakcje obejmuje odpowiedź usługi, dostają jej wynik: potwierdzony właściciel konta albo inna osoba.
  for (const evaluation of evaluations) {
    const { reply } = evaluation;
    const holderName = reply.payload.customer?.fullName;
    for (const match of evaluation.matches.filter((item) => !item.excluded)) {
      const covered = new Set(match.txids);
      // Wypłata powiązana z transakcją innego adresu nie dokumentuje wyjścia z tego adresu.
      const paid = evaluation.fiatExitKeys.includes(match.key);
      for (const proof of cashOutProof) {
        if (proof.serviceReply || `${proof.network}:${proof.cluster?.seed ?? proof.address}` !== match.key || !proof.trail.hops.some((hop) => covered.has(hop.txid))) continue;
        const outcome = evaluation.identity === 'confirmed' ? ('confirmed' as const) : evaluation.identity === 'other_person' ? ('other_person' as const) : ('holder_unverified' as const);
        proof.serviceReply = {
          ...replyRef(reply),
          outcome,
          ...(holderName ? { holderName } : {}),
          fiatExitDocumented: paid && linkedKeys.has(match.key),
          note:
            outcome === 'confirmed'
              ? `Odpowiedź ${replyCitation(reply)} (dokument spoza OSINT): konto, na które trafiły te środki, należy do kandydata głównego${paid ? '; usługa potwierdziła wypłatę na rachunek bankowy' : '; wypłaty na rachunek odpowiedź nie potwierdza'}.`
              : outcome === 'other_person'
                ? `Odpowiedź ${replyCitation(reply)} (dokument spoza OSINT): konto, na które trafiły te środki, należy do INNEJ osoby${holderName ? ` („${holderName}”)` : ''}. Ustalenie pokazuje przekazanie środków do usługi, a nie spieniężenie przez kandydata głównego.`
                : `Odpowiedź ${replyCitation(reply)} (dokument spoza OSINT) dotyczy tych transakcji${paid ? ' i potwierdza wypłatę na rachunek bankowy' : ''}; właściciela konta nie da się porównać z kandydatem głównym.`,
        };
      }
    }
  }
  const confirmedProofs = cashOutProof.filter((proof) => !proof.ownerUnconfirmed);
  const serviceLinks = buildServiceLinks({
    subjectFindings: linked,
    publishedServiceFindings: findings.filter((finding) => finding.confidence.ledger[0]?.rule === 'exclusion.address_class'),
    mentionSources,
    accountNames,
    matcher: input.matchService,
  });
  const seizures = collectSeizures(linked);
  const fundingSources = collectFundingSources(linked);
  const incidentSource = fundingSources.find(isIncidentSource);
  const incident = incidentSource
    ? `środki pochodzą z adresu oznaczonego jako „${incidentSource.label ?? incidentSource.category}”`
    : seizures[0]
      ? `środki przekazano na adres organu państwa „${seizures[0].counterpartyLabel}”`
      : undefined;
  const summary = summarizeFindings(findings, subjectAddresses, input.now, serviceLinks, confirmedProofs[0]?.combinedConfidence, incident);

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
  const externalNodes = [
    ...buildProfileNodes(run, sightings, 'linked_identity'),
    // Współpublikujący liczy się tylko wtedy, gdy podaje adres jako własny (profil, oferta).
    ...buildProfileNodes(run, sightings, 'co_publisher').filter((node) => node.sightings.some((item) => OWNERSHIP_CATEGORIES.includes(item.category))),
    ...buildProfileNodes(run, sightings, 'counterparty_publisher'),
  ];
  const { identities: linkedIdentities, hidden: weakLeadsHidden } = ownerUnknown
    ? { identities: [], hidden: 0 }
    : buildLinkedIdentities({
        main,
        mainNodes,
        otherNodes: nodes.filter((node) => !mainProfileIds.has(node.card.id)),
        externalNodes,
        leads: input.intel?.pivot ?? [],
        linked,
        allFindings: run.findings,
        authorComparisons: input.intel?.authorComparisons,
        decisionOf: (node) => latestDecisions(decisions, 'profile').find((decision) => decisionMatchesProfile(decision.key, node))?.decision,
        linkDecisionOf,
        rules,
      });

  // ---------- Odpowiedzi usług: widok ze skutkami, wypłaty na osi czasu, sprzeczności przy kandydacie ----------
  const replyExits = new Map<string, DocumentedExitSource[]>();
  const serviceReplies: ServiceReplyView[] = (input.serviceReplies ?? []).map((reply) => {
    const evaluation = evaluations.find((item) => item.reply.id === reply.id);
    const holder = reply.payload.customer?.fullName;
    const other = evaluation?.identity === 'other_person' && holder !== undefined;
    const identity = other ? linkedIdentities.find((item) => [item.fullName, item.displayName].some((name) => name !== undefined && sameFullName(name, holder!))) : undefined;
    const candidate = other ? persons.slice(1).find((person) => person.fullName !== undefined && sameFullName(person.fullName, holder!)) : undefined;
    // Tylko adresy, których dotyczy wypłata: powiązana z ich transakcją albo bez wskazanej transakcji.
    const exitKeys = evaluation ? evaluation.fiatExitKeys.filter((key) => linkedKeys.has(key)) : [];
    for (const key of exitKeys) {
      const match = evaluation!.matches.find((item) => item.key === key)!;
      const own = payoutsForMatch(reply.payload.fiatPayouts, match);
      replyExits.set(key, [
        ...(replyExits.get(key) ?? []),
        {
          replyId: reply.id,
          serviceName: reply.serviceName,
          serviceId: reply.serviceId,
          reference: reply.reference,
          receivedAt: reply.receivedAt,
          payouts: own.length,
          payoutSummary: payoutSummary(own),
          txids: match.txids,
          ...(own.some((payout) => !payout.relatedTxid) ? { payoutNotTied: true } : {}),
          ...(other ? { holderNote: `Według usługi właścicielem konta jest inna osoba („${holder}”), a nie kandydat główny — wypłatę na rachunek otrzymał właściciel konta.` } : {}),
        },
      ]);
    }
    return buildReplyView({
      reply,
      evaluation,
      serviceKnown: serviceLinks.some((link) => link.id === reply.serviceId),
      fiatExitKeys: exitKeys,
      ...(identity ? { linkedIdentity: { id: identity.id, displayName: identity.displayName, relation: identityRelationLabel(identity.relation) } } : {}),
      ...(candidate?.fullName ? { otherCandidate: candidate.fullName } : {}),
      ...(main?.fullName ? { mainName: main.fullName } : {}),
    });
  });
  const contradictions = serviceReplies.flatMap((view) => (view.contradiction ? [view.contradiction] : []));
  if (main && contradictions.length > 0) {
    main = { ...main, reasons: [...main.reasons, ...contradictions], replyContradictions: contradictions };
    persons[0] = main;
  }
  const payoutEvents: TimelineEvent[] = serviceReplies
    .filter((view) => !view.withdrawn && view.match.matched)
    .flatMap((view) =>
      view.payload.fiatPayouts.map((payout) => ({
        time: payout.time,
        kind: 'cash_out' as const,
        title: `Wypłata na rachunek bankowy ${formatFiat(payout.amount, payout.currency)} — według odpowiedzi usługi ${view.serviceName} (dokument spoza OSINT)`,
        detail:
          `Odpowiedź sygn. ${view.reference}${payout.bankAccountMasked ? `; rachunek ${payout.bankAccountMasked}` : ''}${payout.relatedTxid ? `; powiązana wpłata: transakcja ${shortAddress(payout.relatedTxid)}` : ''}. ` +
          'Informacja z dokumentu wprowadzonego przez analityka — nie z blockchaina ani ze źródeł publicznych.',
        address: view.match.addresses.find((item) => !item.excluded)?.address,
        layer: 'fact' as const,
      })),
    );

  // ---------- Trzy wskaźniki: konto → portfel, wspólny operator, wyjście do walut tradycyjnych ----------
  // Konta znane teczce: profile sprawy oraz konta powiązanych tożsamości (po jednym na serwis + nazwę).
  const accounts = ownerUnknown ? [] : [...nodes];
  if (!ownerUnknown) {
    for (const node of externalNodes) if (!accounts.some((known) => known.card.id === node.card.id)) accounts.push(node);
  }
  const indicators: InvestigationIndicators = {
    accountWallet: buildAccountWalletLinks({
      accounts,
      findings: run.findings,
      rules,
      addressDecisionOf: (finding) => addressDecisions.get(addressKey(finding).toLowerCase()) ?? addressDecisions.get(finding.address.toLowerCase()),
    }),
    commonOperator: buildOperatorHypotheses({
      accounts,
      findings: run.findings,
      rules,
      personOfProfile,
      blockedPairs,
      profileDecisions,
      linkDecisions,
      authorComparisons: input.intel?.authorComparisons,
      leads: input.intel?.pivot ?? [],
    }),
    // Ostatni szczebel drabiny (udokumentowane wyjście do walut tradycyjnych) daje wyłącznie obowiązująca
    // decyzja analityka `cashout` „potwierdzony” — dokumentacja spoza blockchaina, z podstawą w notatce.
    cashOut: buildCashOutAssessments({
      findings,
      linkedKeys,
      documentedExits: new Set(
        latestDecisions(decisions, 'cashout')
          .filter((decision) => decision.decision === 'confirmed')
          .flatMap((decision) => findings.filter((finding) => [addressKey(finding).toLowerCase(), finding.address.toLowerCase()].includes(decision.key.trim().toLowerCase())).map(addressKey)),
      ),
      // …albo odpowiedź usługi z co najmniej jedną wypłatą na rachunek (samo potwierdzenie KYC nie wystarcza).
      ...(replyExits.size > 0 ? { replyExits } : {}),
      // Oznaki z publikacji (Web2) — wyłącznie dokumenty kont kandydata głównego; wzmianki innych autorów się nie liczą.
      now: input.now,
      serviceLinks,
      publications: fiatPublicationsOf(mainNodes, findings),
      webKey: caseSummary.id,
    }),
  };
  // Adresy powiązane w blockchainie, które mają publikację, są tożsamościami; pozostałe to „inne adresy”.
  const publishedLinked = new Set(linkedIdentities.flatMap((identity) => identity.addresses.map((item) => item.address.toLowerCase())));
  for (const finding of findings) {
    if (!linkedKeys.has(addressKey(finding))) continue;
    const related = relatedAddressesOf(finding, publishedLinked);
    if (related.length > 0) finding.relatedAddresses = related;
  }
  // Siatka adresu (zbiorczo): adresy sprawy podane przez analityka i potwierdzone — z zapisanych danych blockchain.
  // Osoba publiczna (Wikidata): decyzja analityka zmienia status; sieć osoby dochodzi do sieci organizacji teczki.
  const { publicFigure, organizationNetwork } = publicFigureForDossier(input, decisions);
  const organizations = organizationViews(beneficiaries, organizationNetwork);
  const addressNetwork = findings
    .filter((finding) => subjectAddresses.has(addressKey(finding)) && linkedKeys.has(addressKey(finding)))
    .map((finding) =>
      buildAddressNetwork({
        finding,
        serviceLinks,
        ...(finding.relatedAddresses ? { relatedAddresses: finding.relatedAddresses } : {}),
        checkedCounterparties: input.intel?.checkedCounterparties ?? [],
        ...(input.intel?.expansion ? { maxCounterparties: input.intel.expansion.limits.maxCounterparties } : {}),
        ...(beneficiaryOf.get(addressKey(finding)) ? { organization: beneficiaryOf.get(addressKey(finding))!.name } : {}),
      }),
    )
    .filter((item): item is AddressNetwork => item !== undefined);
  const likelySame = sumByYear([summary.cashOutPlnByYear, ...linkedIdentities.filter((item) => item.relation === 'same_person_likely').map((item) => item.cashOutPlnByYear)]);
  const profiles = (ownerUnknown ? [] : nodes)
    .map((node) => node.card)
    .sort((a, b) => Number(mainProfileIds.has(b.id)) - Number(mainProfileIds.has(a.id)) || b.identityScore - a.identityScore);

  const explanations = annotateExplanations(buildExplanations({
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
    sourceErrors: input.intel?.sourceErrors,
    serviceLabels: input.serviceLabels,
    matcher: input.matchService,
    seizures: seizures.length,
  }), organizations);

  const graphInput = {
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
    seizures,
    fundingSources,
    indicators,
    persons,
    ...(serviceReplies.some((view) => !view.withdrawn) ? { serviceReplies } : {}),
  };
  const graph = buildGraph(graphInput);
  // Sieć: adres ↔ adres (ten sam portfel, bezpośrednie przelewy; warstwa blockchain) oraz organizacje, osoby w rolach z rejestrów i relacje.
  const addressLinks = addressLinkGraph(findings, graph);
  graph.nodes.push(...addressLinks.nodes);
  graph.edges.push(...addressLinks.edges);
  // Węzeł osoby publicznej przed siecią organizacji: ten sam klucz (`regperson:Q…`) co jej role z rejestru.
  const figureGraph = publicFigureGraph(publicFigure, 'subject');
  if (graph.nodes.some((node) => node.id === 'subject')) graph.nodes.push(...figureGraph.nodes.filter((node) => !graph.nodes.some((known) => known.id === node.id)));
  const orgGraph = organizationGraph(organizations, organizationNetwork, graph);
  graph.nodes.push(...orgGraph.nodes);
  graph.edges.push(...orgGraph.edges);
  graph.edges.push(...figureGraph.edges.filter((edge) => graph.nodes.some((node) => node.id === edge.from) && graph.nodes.some((node) => node.id === edge.to)));
  // Oficjalne listy sankcyjne i ostrzeżeń (migawki lokalne, bez sieci): wpis listy jako osobny węzeł, trafienie
  // identyfikatora = fakt o liście, zgodność nazwy = hipoteza. Błąd list nie blokuje teczki.
  let riskLists: RiskGraphResult['badges'] | undefined;
  try {
    const risk = riskListGraph(graph, { attributes: organizationRegistryAttributes(organizationNetwork) });
    const known = new Set(graph.nodes.map((node) => node.id));
    graph.nodes.push(...risk.nodes.filter((node) => !known.has(node.id)));
    graph.edges.push(...risk.edges);
    if (Object.keys(risk.badges).length > 0) riskLists = risk.badges;
  } catch {
    riskLists = undefined;
  }
  // Wskaźnik D — sygnały działalności gospodarczej (dwie ścieżki) i węzły siatki z odznaką oraz ścieżką do podmiotu.
  indicators.businessActivity = businessForDossier({
    subjectLabel: main?.fullName ?? caseSummary.name,
    mainNodes: ownerUnknown ? [] : mainNodes,
    otherNodes: [...nodes.filter((node) => !mainProfileIds.has(node.card.id)), ...externalNodes],
    sightings,
    findings,
    linkedKeys,
    beneficiaries: beneficiaryOf,
    connectorsUsed: run.connectors,
    identifiers: run.query.identifiers,
    sourceErrors: input.intel?.sourceErrors ?? [],
    cashOut: indicators.cashOut,
    graph,
    linkedIdentities,
    serviceReplies,
    ...(input.intel?.organizationNetwork ? { organizationNetwork: input.intel.organizationNetwork } : {}),
    riskCheck: (riskNodes) => checkNetworkNodes(riskNodes),
  });
  applyBusinessBadges(graph, indicators.businessActivity);
  // Miksery i CoinJoin: ekspozycja adresów sprawy, składniki informacyjne wskaźników C i D, węzły mikserów w grafie.
  const mixerExposure = applyMixerExposure({ findings, linkedKeys, allFindings: findings, graph, indicators, serviceLinks });
  // Ostrzeżenia o możliwym oszustwie: autorzy ostrzeżeń to poszkodowani lub świadkowie, nigdy właściciele.
  const scamWarnings = applyScamWarnings({ findings, ...(input.documents ? { documents: input.documents } : {}), sightings, persons, ...(riskLists ? { riskLists } : {}), graph });

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
    serviceReplies,
    relatedPersons,
    serviceLinks,
    cashOutProof,
    summary: null,
    partial: input.intel?.partial === true,
    mentions: input.intel?.mentions ?? [],
    seizures,
    fundingSources,
    unconfirmedAddresses,
    explanations,
    linkedIdentities,
    weakLeadsHidden,
    indicators,
    sourceErrors: input.intel?.sourceErrors ?? [],
    ...(input.intel?.expansion ? { expansion: input.intel.expansion } : {}),
    graph,
    organizations,
    ...(organizationNetwork ? { organizationNetwork } : {}),
    ...(publicFigure ? { publicFigure } : {}),
    addressNetwork,
    ...(riskLists ? { riskLists } : {}),
    mixerExposure,
    scamWarnings,
    timeline: buildTimeline({
      linked,
      profiles: profiles.filter((profile) => mainProfileIds.has(profile.id)),
      replacements,
      proofs: confirmedProofs,
      seizures,
      ...(payoutEvents.length > 0 ? { extraEvents: payoutEvents } : {}),
    }),
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
    keyFindings: [...withRiskListFindings(insertOrganizationFindings(buildKeyFindings({
      addressOnly,
      widelyCited: subjectFindings.some((finding) => finding.widelyCited),
      mentions: input.intel?.mentions ?? [],
      explanations,
      ...(serviceReplies.length > 0 ? { replyFindings: replyKeyFindings(serviceReplies) } : {}),
      linkedIdentities,
      seizures,
      fundingSources,
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
    }), organizations, input.intel?.organizationNetwork), riskLists), ...(publicFigureFinding(publicFigure) ? [publicFigureFinding(publicFigure)!] : []), ...businessKeyFindings(indicators.businessActivity), ...mixerKeyFindings(mixerExposure), ...scamKeyFindings(scamWarnings)],
  };
}

/** Numery rejestrowe organizacji z sieci organizacji (KRS, NIP) — do porównania z identyfikatorami wpisów list. */
function organizationRegistryAttributes(network: OrganizationNetwork | undefined): Record<string, { identifiers: { kind: string; value: string }[] }> {
  const attributes: Record<string, { identifiers: { kind: string; value: string }[] }> = {};
  for (const org of network?.organizations ?? []) {
    const identifiers = [
      ...(org.identifiers.krs ? [{ kind: 'KRS', value: org.identifiers.krs }] : []),
      ...(org.identifiers.nip ? [{ kind: 'NIP', value: org.identifiers.nip }] : []),
    ];
    if (identifiers.length > 0) attributes[org.id] = { identifiers };
  }
  return attributes;
}

/** Trafienia na listach jako ustalenia: identyfikator na liście = fakt, zgodność nazwy = wniosek do weryfikacji. */
function withRiskListFindings(findings: DossierView['keyFindings'], badges: RiskGraphResult['badges'] | undefined): DossierView['keyFindings'] {
  if (!badges) return findings;
  return [...findings, ...Object.values(badges).map((badge) => ({ text: `${badge.summary} ${badge.caveat}`, layer: badge.status === 'source_fact' ? ('fact' as const) : ('inference' as const) }))];
}

/**
 * Osoba publiczna w teczce: decyzja analityka (potwierdzenie, odrzucenie, wybór kandydata), sieć z rozwinięcia po
 * potwierdzeniu (głębokość 2) albo z analizy (druga cecha, głębokość 1); odrzucone dopasowanie nie wnosi sieci.
 */
function publicFigureForDossier(input: DossierInput, decisions: DecisionRecord[]): { publicFigure?: PublicFigure; organizationNetwork?: OrganizationNetwork } {
  const base = input.intel?.organizationNetwork;
  const figure = applyPublicFigureDecision(input.intel?.publicFigure, decisions);
  if (!figure) return base ? { organizationNetwork: base } : {};
  if (figure.status === 'rejected' || !figure.wikidataId) return { publicFigure: { ...figure, roles: undefined, expansion: undefined }, ...(base ? { organizationNetwork: base } : {}) } as { publicFigure: PublicFigure; organizationNetwork?: OrganizationNetwork };
  const expansion =
    figure.status === 'confirmed'
      ? (input.expansions ?? []).filter((record) => !record.withdrawnAt && record.results.publicFigure?.wikidataId === figure.wikidataId && record.results.organizationNetwork).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)
      : undefined;
  const fromAnalysis = input.intel?.publicFigure?.wikidataId === figure.wikidataId && figure.match === 'corroborated' ? input.intel?.publicFigureNetwork : undefined;
  const network = (expansion?.results.organizationNetwork as OrganizationNetwork | undefined) ?? fromAnalysis;
  const view: PublicFigure = {
    ...figure,
    ...(expansion
      ? {
          roles: (expansion.results.publicFigure?.roles ?? []) as PublicFigureRole[],
          cryptoAddresses: (expansion.results.publicFigure?.cryptoAddresses ?? []) as PublicFigureAddress[],
          expansion: { depth: expansion.results.publicFigure?.depth ?? 2, automatic: false, expansionId: expansion.id, note: 'Rozwinięto po potwierdzeniu dopasowania przez analityka (zapis w historii rozwinięć; można go wycofać).' },
        }
      : {}),
    ...(network ? { counts: networkCounts(network) } : {}),
  };
  const merged = mergeOrganizationNetworks(base, network);
  return { publicFigure: view, ...(merged ? { organizationNetwork: merged } : {}) };
}
