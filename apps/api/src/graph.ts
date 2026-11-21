// Graf śledczy sprawy: podmiot → identyfikatory → konta → adresy → usługi, a obok
// hipotezy wspólnego operatora, deklarowane persony i publikacje źródłowe.
// Węzeł usługi odpowiada jednemu wpisowi `ServiceLink` (jedna giełda = jeden węzeł,
// bez względu na liczbę jej adresów).
//
// Każda krawędź ma status twierdzenia (`ClaimStatus`): fakt źródłowy, obliczenie, hipoteza,
// potwierdzenie albo odrzucenie decyzją analityka — oraz, gdzie dane istnieją, dowody i zdanie
// wyjaśnienia. Powiązania odrzucone zostają w grafie jako krawędzie odrzucone. Krawędzie
// przepływów w blockchainie mają warstwę `chain`, pozostałe — `identity`.
// Graf nigdy nie przedstawia hipotezy jako ustalonej osoby: węzły operatora, persony i osoby
// są hipotezami, dopóki nie potwierdzi ich analityk.

import type {
  ClaimStatus,
  Decision,
  EvidenceRef,
  Finding,
  GraphEdge,
  GraphNode,
  HypothesisStatus,
  Identifier,
  InvestigationIndicators,
  OperatorHypothesis,
  PersonCandidate,
  RelatedPerson,
  ServiceLink,
} from '@olcys/core';
import type { ProfileNode } from './entity.ts';
import { formatDate, roundPln, shortAddress } from './format.ts';
import { addressKey } from './intel.ts';
import type { DiscoveryStep } from './intel.ts';
import { identityRelationLabel } from './aliases.ts';
import type { LinkedIdentity } from './aliases.ts';
import type { CashOutProof } from './proof.ts';
import type { FundingSourceView, SeizureView } from './provenance.ts';
import { CONTRACTS_LINK_ID, isCashOutService, serviceIdOf, serviceKindLabel } from './services.ts';

export interface GraphInput {
  subjectLabel: string;
  caseName: string;
  identifiers: { identifier: Identifier; origin: 'analyst' | 'discovered' }[];
  profiles: ProfileNode[];
  /** Identyfikatory profili osoby głównej (`ProfileCard.id`). */
  mainProfileIds: Set<string>;
  findings: Finding[];
  serviceLinks: ServiceLink[];
  relatedPersons: RelatedPerson[];
  trail: DiscoveryStep[];
  /** Dowód spieniężenia: ścieżki środków rysowane krok po kroku. */
  proofs?: CashOutProof[];
  linkedIdentities?: LinkedIdentity[];
  seizures?: SeizureView[];
  fundingSources?: FundingSourceView[];
  /** Trzy wskaźniki śledcze: hipotezy wspólnego operatora, konto→portfel, wyjście do fiat. */
  indicators?: InvestigationIndicators;
  /** Kandydaci na osobę — każdy z więcej niż jednym kontem to osobna hipoteza operatora. Bez nich używane są `mainProfileIds`. */
  persons?: PersonCandidate[];
}

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Poniżej tego wskaźnika hipoteza wspólnego operatora jest tylko krawędzią — nie dołącza konta do węzła operatora. */
export const WEAK_OPERATOR_SCORE = 40;
/** Najwyżej tyle dowodów (np. txid) przy jednej krawędzi. */
export const MAX_EDGE_EVIDENCE = 10;

export const HYPOTHESIS_NOTE = 'hipoteza — do weryfikacji';

/** Legenda statusów krawędzi i węzłów grafu. */
export const graphLegend: { status: ClaimStatus; label: string; description: string }[] = [
  { status: 'source_fact', label: 'fakt źródłowy', description: 'Wprost ze źródła: publikacja, cecha zadeklarowana w profilu, przelew zapisany w transakcji.' },
  { status: 'computed', label: 'wynik obliczeń', description: 'Policzone z faktów: sumy, wyceny, ścieżka złożona wyłącznie z kroków zapisanych w blockchainie.' },
  { status: 'hypothesis', label: 'hipoteza — do weryfikacji', description: 'Wnioskowanie narzędzia: niepotwierdzona zgodność tożsamości, heurystyka portfela, adres wpłat, wniosek o wypłacie, wspólny operator.' },
  { status: 'confirmed', label: 'potwierdzone przez analityka', description: 'Hipoteza przyjęta decyzją analityka zapisaną w rejestrze decyzji.' },
  { status: 'rejected', label: 'odrzucone przez analityka', description: 'Powiązanie odrzucone decyzją analityka albo wykluczone sprzecznością — zostaje w grafie dla pełnego obrazu.' },
];

const HYPOTHESIS_STATUS_LABEL: Record<HypothesisStatus, string> = {
  hypothesis: 'hipoteza wspólnego operatora (do weryfikacji)',
  auto_grouped: 'hipoteza wspólnego operatora (konta zgrupowane automatycznie)',
  blocked: 'hipoteza wspólnego operatora (zablokowana sprzecznością)',
  confirmed: 'wspólny operator potwierdzony decyzją analityka',
  rejected: 'wspólny operator odrzucony decyzją analityka',
};

const hypothesisClaim = (status: HypothesisStatus): ClaimStatus => (status === 'confirmed' ? 'confirmed' : status === 'rejected' ? 'rejected' : 'hypothesis');

const identifierNodeId = (identifier: Identifier) => `id:${identifier.type}:${identifier.value.trim().toLowerCase()}`;

/** Dowody bez powtórzeń i pustych wartości, najwyżej `cap`. */
function refs(items: (EvidenceRef | undefined)[], cap = MAX_EDGE_EVIDENCE): EvidenceRef[] {
  const seen = new Set<string>();
  const result: EvidenceRef[] = [];
  for (const item of items) {
    if (!item || !item.value) continue;
    const key = `${item.kind}|${item.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: item.kind, value: item.value });
  }
  return result.slice(0, cap);
}

const txRefs = (txids: string[]): EvidenceRef[] => refs(txids.map((value) => ({ kind: 'txid' as const, value })));

type EdgeDraft = Omit<GraphEdge, 'id' | 'inferred' | 'status' | 'layer'> & { status: ClaimStatus; layer?: 'identity' | 'chain' };

/** Skupienia kont (łączenie zbiorów rozłącznych). */
function unionFind() {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    if (!parent.has(id)) parent.set(id, id);
    const up = parent.get(id)!;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  return { find, union: (a: string, b: string) => parent.set(find(a), find(b)), has: (id: string) => parent.has(id) };
}

export function buildGraph(input: GraphInput): Graph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  /** Krawędź powstaje tylko między istniejącymi węzłami — graf nie ma krawędzi donikąd. */
  const addEdge = (edge: EdgeDraft) => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) return;
    const id = `${edge.kind}:${edge.from}>${edge.to}`;
    if (edges.has(id)) return;
    const { evidence, explanation, layer, ...rest } = edge;
    edges.set(id, {
      id,
      ...rest,
      // `inferred` zostaje dla zgodności wstecznej: wnioskowanie = status „hipoteza”.
      ...(edge.status === 'hypothesis' ? { inferred: true } : {}),
      ...(evidence && evidence.length > 0 ? { evidence } : {}),
      ...(explanation ? { explanation } : {}),
      layer: layer ?? (edge.kind === 'transfer' || edge.kind === 'cash_out' ? 'chain' : 'identity'),
    });
  };
  const hypotheses: OperatorHypothesis[] = input.indicators?.commonOperator ?? [];
  const decisionOfFinding = (finding: Finding): Decision | undefined => (finding as Finding & { decision?: Decision }).decision;

  addNode({ id: 'subject', kind: 'subject', label: input.subjectLabel, sublabel: `sprawa: ${input.caseName}` });

  for (const { identifier, origin } of input.identifiers) {
    const id = identifierNodeId(identifier);
    addNode({ id, kind: 'identifier', label: identifier.value, sublabel: origin === 'analyst' ? identifier.type : `${identifier.type} (odkryty)` });
    const step = origin === 'discovered' ? input.trail.find((item) => identifierNodeId(item.identifier) === id) : undefined;
    addEdge({
      from: 'subject',
      to: id,
      kind: 'has_identifier',
      ...(origin === 'discovered'
        ? {
            label: 'odkryty w profilu',
            status: 'hypothesis' as const,
            explanation: step
              ? `Identyfikator wskazany w publikacji ${step.sourceUrl} (${step.sourceService}); przypisanie go podmiotowi jest wnioskiem narzędzia.`
              : 'Identyfikator odkryty w znalezionym profilu; przypisanie go podmiotowi jest wnioskiem narzędzia.',
          }
        : { label: 'podany przez analityka', status: 'source_fact' as const, explanation: 'Identyfikator podany przez analityka jako dane wejściowe sprawy.' }),
      evidence: refs([{ kind: 'attribute', value: `${identifier.type}: ${identifier.value}` }, step ? { kind: 'url', value: step.sourceUrl } : undefined]),
    });
  }

  for (const finding of input.findings) {
    addNode({
      id: `addr:${addressKey(finding)}`,
      kind: 'address',
      label: shortAddress(finding.address),
      sublabel: finding.chain?.profile.label ?? finding.network,
      score: finding.confidence.score,
      ...(finding.confidence.excluded ? { excluded: true } : {}),
    });
  }
  for (const { identifier } of input.identifiers) {
    if (identifier.type !== 'crypto_address') continue;
    const finding = input.findings.find((item) => item.address.toLowerCase() === identifier.value.trim().toLowerCase());
    if (finding) {
      addEdge({
        from: identifierNodeId(identifier),
        to: `addr:${addressKey(finding)}`,
        kind: 'links_to',
        label: 'adres podany przez analityka',
        status: 'source_fact',
        evidence: refs([{ kind: 'address', value: finding.address }]),
        explanation: 'Adres podany przez analityka jako dane wejściowe sprawy.',
      });
    }
  }

  // Konta: jeden węzeł na profil w usłudze. Sposób odnalezienia decyduje, czy powiązanie jest faktem, czy hipotezą.
  for (const profile of input.profiles) {
    const { card } = profile;
    const id = `profile:${card.id}`;
    const main = input.mainProfileIds.has(card.id);
    addNode({
      id,
      kind: 'profile',
      label: card.handle ?? card.url,
      sublabel: main ? card.service : `${card.service} — inny kandydat`,
      score: card.identityScore,
      ...(card.decision === 'rejected' || !main ? { excluded: true } : {}),
      url: card.url,
    });
    const verified = card.identityMatch === 'verified_link' || card.identityMatch === 'exact_identifier';
    const status: ClaimStatus = card.decision === 'confirmed' ? 'confirmed' : card.decision === 'rejected' ? 'rejected' : verified ? 'source_fact' : 'hypothesis';
    const reasons = card.identityReasons.join(' ');
    let found = false;
    for (const sighting of profile.sightings) {
      const from = identifierNodeId(sighting.matchedIdentifier);
      if (!nodes.has(from)) continue;
      found = true;
      addEdge({
        from,
        to: id,
        kind: 'found_profile',
        label: card.identityMatch,
        weight: card.identityScore,
        status,
        evidence: refs([{ kind: 'attribute', value: `${sighting.matchedIdentifier.type}: ${sighting.matchedIdentifier.value}` }, { kind: 'url', value: sighting.url }]),
        explanation: `Konto odnalezione po identyfikatorze „${sighting.matchedIdentifier.value}”.${reasons ? ` ${reasons}` : ''}`,
      });
    }
    if (!found) {
      addEdge({
        from: 'subject',
        to: id,
        kind: 'found_profile',
        label: card.identityMatch,
        weight: card.identityScore,
        status: card.decision === 'confirmed' ? 'confirmed' : card.decision === 'rejected' ? 'rejected' : 'hypothesis',
        evidence: refs([{ kind: 'attribute', value: `${profile.matchedIdentifier.type}: ${profile.matchedIdentifier.value}` }, { kind: 'url', value: card.url }]),
        explanation: `Konto odnalezione pośrednio (identyfikator „${profile.matchedIdentifier.value}”).${reasons ? ` ${reasons}` : ''}`,
      });
    }

    const urls = new Set(profile.sightings.map((item) => item.url));
    for (const step of input.trail) {
      if (!urls.has(step.sourceUrl)) continue;
      addEdge({
        from: id,
        to: identifierNodeId(step.identifier),
        kind: 'links_to',
        label: 'profil wskazuje identyfikator',
        status: 'source_fact',
        evidence: refs([{ kind: 'url', value: step.sourceUrl }, { kind: 'attribute', value: `${step.identifier.type}: ${step.identifier.value}` }]),
        explanation: `Publikacja konta wskazuje identyfikator „${step.identifier.value}”.`,
      });
    }
    for (const key of card.addresses) {
      const finding = input.findings.find((item) => addressKey(item) === key);
      const published = (finding?.evidence ?? []).filter((item) => card.evidenceIds.includes(item.id) || urls.has(item.url));
      const decision = finding ? decisionOfFinding(finding) : undefined;
      addEdge({
        from: id,
        to: `addr:${key}`,
        kind: 'publishes',
        label: decision === 'rejected' ? 'publikuje adres (powiązanie odrzucone)' : 'publikuje adres',
        weight: card.identityScore,
        // Publikacja jest faktem; decyzja analityka o adresie zmienia status powiązania.
        status: decision === 'confirmed' ? 'confirmed' : decision === 'rejected' ? 'rejected' : 'source_fact',
        evidence: refs([...published.map((item) => ({ kind: 'evidence_id' as const, value: item.id })), ...published.map((item) => ({ kind: 'url' as const, value: item.url }))]),
        explanation:
          published.length > 0
            ? `Konto opublikowało ten adres (publikacji: ${published.length}). Publikacja jest deklaracją autora — nie dowodzi dysponowania kluczem prywatnym.`
            : 'Konto opublikowało ten adres. Publikacja jest deklaracją autora — nie dowodzi dysponowania kluczem prywatnym.',
      });
    }
  }

  // Konta spoza profili podmiotu, których dotyczy istotna hipoteza wspólnego operatora albo decyzja analityka.
  // Słabe hipotezy o nieznanych kontach nie tworzą węzłów — graf nie wciąga przypadkowych osób.
  const identityCards = (input.linkedIdentities ?? []).flatMap((identity) => identity.profiles ?? []);
  for (const hypothesis of hypotheses) {
    const score = hypothesis.indicator?.score ?? 0;
    if (score < WEAK_OPERATOR_SCORE && hypothesis.status !== 'confirmed' && hypothesis.status !== 'rejected') continue;
    hypothesis.accounts.forEach((account, index) => {
      const card = identityCards.find((item) => item.id === account);
      addNode({
        id: `profile:${account}`,
        kind: 'profile',
        label: hypothesis.accountLabels?.[index] ?? card?.handle ?? account,
        sublabel: `${card?.service ?? account.split('|')[0]} — konto z hipotezy wspólnego operatora`,
        excluded: true,
        ...(card?.url ? { url: card.url } : {}),
      });
    });
  }

  // Hipotezy operatora: skupienia kont jednego kandydata na osobę oraz kont połączonych hipotezą
  // potwierdzoną albo przyjętą automatycznie. Hipoteza słaba, odrzucona lub zablokowana sprzecznością NIE łączy kont.
  const cards = new Map(input.profiles.map((profile) => [profile.card.id, profile.card]));
  const clusters = unionFind();
  const confirmedClusters = unionFind();
  const groups: { profileIds: string[]; status?: PersonCandidate['status'] }[] = input.persons ?? [{ profileIds: [...input.mainProfileIds] }];
  for (const group of groups) {
    const members = (group.profileIds ?? []).filter((id) => nodes.has(`profile:${id}`));
    for (const member of members) {
      clusters.union(members[0]!, member);
      if (group.status === 'confirmed') confirmedClusters.union(members[0]!, member);
    }
  }
  for (const hypothesis of hypotheses) {
    const [a, b] = hypothesis.accounts;
    if (!nodes.has(`profile:${a}`) || !nodes.has(`profile:${b}`)) continue;
    const strong = (hypothesis.indicator?.score ?? 0) >= WEAK_OPERATOR_SCORE;
    if (hypothesis.status === 'confirmed' || (hypothesis.status === 'auto_grouped' && strong)) clusters.union(a, b);
    if (hypothesis.status === 'confirmed') confirmedClusters.union(a, b);
  }
  const members = new Map<string, string[]>();
  for (const id of [...nodes.keys()].filter((key) => key.startsWith('profile:')).map((key) => key.slice('profile:'.length))) {
    if (!clusters.has(id)) continue;
    members.set(clusters.find(id), [...(members.get(clusters.find(id)) ?? []), id]);
  }
  const operatorOf = new Map<string, string>();
  const multi = [...members.values()].filter((list) => list.length > 1);
  // Skupienie z kontami osoby głównej dostaje numer 1.
  multi.sort((x, y) => Number(y.some((id) => input.mainProfileIds.has(id))) - Number(x.some((id) => input.mainProfileIds.has(id))));
  multi.forEach((list, index) => {
    const id = `operator:${index + 1}`;
    const person = (input.persons ?? []).find((candidate) => (candidate.profileIds ?? []).some((profileId) => list.includes(profileId)));
    const confirmed = person?.status === 'confirmed' || list.every((member) => confirmedClusters.find(member) === confirmedClusters.find(list[0]!));
    const status: ClaimStatus = person?.status === 'rejected' ? 'rejected' : confirmed ? 'confirmed' : 'hypothesis';
    const main = list.some((member) => input.mainProfileIds.has(member));
    addNode({
      id,
      kind: 'operator',
      label: `Hipoteza operatora #${index + 1}`,
      sublabel:
        status === 'confirmed'
          ? `wspólny operator ${list.length} kont — potwierdzony decyzją analityka`
          : status === 'rejected'
            ? `wspólny operator ${list.length} kont — odrzucony decyzją analityka`
            : `${HYPOTHESIS_NOTE} (kont: ${list.length})`,
      status,
      ...(person ? { score: person.probability } : {}),
    });
    if (main) {
      addEdge({
        from: 'subject',
        to: id,
        kind: 'operates',
        label: status === 'confirmed' ? 'operator kont podmiotu (potwierdzony)' : 'hipoteza: operator kont podmiotu',
        status,
        ...(person ? { weight: person.probability } : {}),
        explanation: 'Konta zaliczone do badanego podmiotu mogą mieć wspólnego operatora — to wnioskowanie narzędzia, nie ustalenie tożsamości.',
      });
    }
    for (const member of list) {
      operatorOf.set(member, id);
      const card = cards.get(member);
      const related = hypotheses.filter((hypothesis) => hypothesis.accounts.includes(member) && hypothesis.accounts.every((account) => list.includes(account)));
      addEdge({
        from: id,
        to: `profile:${member}`,
        kind: 'operates',
        label: card?.decision === 'rejected' ? 'konto odrzucone decyzją analityka' : status === 'confirmed' ? 'obsługuje konto (potwierdzone)' : 'hipoteza: obsługuje konto',
        status: card?.decision === 'rejected' ? 'rejected' : status === 'confirmed' || card?.decision === 'confirmed' ? 'confirmed' : 'hypothesis',
        ...(card ? { weight: card.identityScore } : {}),
        evidence: refs([
          ...related.flatMap((hypothesis) => (hypothesis.indicator?.components ?? []).filter((component) => component.direction === 'supports').flatMap((component) => component.evidence ?? [])),
          card ? { kind: 'url', value: card.url } : undefined,
        ]),
        explanation:
          (card?.identityReasons ?? []).join(' ') ||
          'Konto zaliczone do tej hipotezy operatora na podstawie przesłanek łączących konta — wnioskowanie narzędzia, do weryfikacji.',
      });
    }
  });

  // Persony: nazwa, pod którą konto występuje. Deklaracja jest faktem źródłowym; to, kto się za nią kryje — nie.
  for (const profile of input.profiles) {
    const { card } = profile;
    const name = (card.attributes?.displayName ?? card.handle ?? '').trim();
    if (!name) continue;
    const id = `persona:${name.toLowerCase()}`;
    const operator = operatorOf.get(card.id);
    addNode({
      id,
      kind: 'persona',
      label: name,
      sublabel: `deklarowana tożsamość — ${HYPOTHESIS_NOTE}`,
      status: card.decision === 'confirmed' ? 'confirmed' : 'hypothesis',
      ...(operator ? { parent: operator } : {}),
    });
    addEdge({
      from: `profile:${card.id}`,
      to: id,
      kind: 'declares',
      label: 'występuje pod nazwą',
      status: 'source_fact',
      evidence: refs([{ kind: 'url', value: card.url }, { kind: 'attribute', value: `nazwa: ${name}` }]),
      explanation: `Konto w ${card.service} występuje pod nazwą „${name}”. To deklaracja w profilu, nie ustalenie tożsamości.`,
    });
  }

  // Źródła dowodowe: jedna publikacja (adres URL) = jeden węzeł, podpięty pod konto, które ją zamieściło.
  for (const finding of input.findings) {
    for (const item of finding.evidence) {
      const id = `source:${item.url}`;
      const publisher = input.profiles.find((profile) => profile.card.evidenceIds.includes(item.id) || profile.sightings.some((sighting) => sighting.url === item.url));
      const parent = publisher ? `profile:${publisher.card.id}` : undefined;
      addNode({
        id,
        kind: 'source',
        label: item.service,
        sublabel: `publikacja${item.publishedAt ? ` z ${formatDate(item.publishedAt)}` : ''}; pozyskano ${formatDate(item.capturedAt)}`,
        url: item.url,
        status: 'source_fact',
        ...(parent ? { parent } : {}),
      });
      const evidence = refs([{ kind: 'evidence_id', value: item.id }, { kind: 'url', value: item.url }]);
      addEdge({
        from: `addr:${addressKey(finding)}`,
        to: id,
        kind: 'documented_by',
        label: 'adres w publikacji',
        status: 'source_fact',
        evidence,
        explanation: `Adres występuje w treści tej publikacji (pozyskano ${formatDate(item.capturedAt)}${item.contentHash ? `, SHA-256 ${item.contentHash.slice(0, 16)}…` : ''}).`,
      });
      if (parent) {
        addEdge({ from: parent, to: id, kind: 'documented_by', label: 'publikacja konta', status: 'source_fact', evidence, explanation: 'Publikacja zamieszczona przez to konto.' });
      }
    }
  }

  const maxPln = Math.max(1, ...input.serviceLinks.map((link) => (link.outPln ?? 0) + (link.inPln ?? 0)));
  for (const link of input.serviceLinks) {
    // Zbiorczy wpis „Kontrakty i protokoły” jest informacją, nie usługą — nie rysujemy go.
    if (link.id === CONTRACTS_LINK_ID) continue;
    const id = `svc:${link.id}`;
    addNode({ id, kind: 'service', label: link.name, sublabel: serviceKindLabel(link.kind), score: link.strength });
    const findingOf = (address: string) => input.findings.find((item) => item.address === address);
    for (const direction of ['out', 'in'] as const) {
      const bySubject = new Map<string, typeof link.transfers>();
      for (const transfer of link.transfers.filter((item) => item.direction === direction)) {
        bySubject.set(transfer.subjectAddress, [...(bySubject.get(transfer.subjectAddress) ?? []), transfer]);
      }
      for (const [address, transfers] of bySubject) {
        const finding = findingOf(address);
        if (!finding) continue;
        const pln = transfers.reduce((sum, transfer) => sum + (transfer.valuePln ?? 0), 0);
        const label = `${transfers.length} przel.${pln > 0 ? `, ok. ${roundPln(pln)}` : ''}`;
        const weight = pln > 0 ? Math.max(1, Math.round((100 * pln) / maxPln)) : link.strength;
        const addressNode = `addr:${addressKey(finding)}`;
        const evidence = refs([...txRefs(transfers.map((transfer) => transfer.txid)), { kind: 'address', value: address }], MAX_EDGE_EVIDENCE + 1);
        // Jeden przelew bez wyceny to fakt z transakcji; suma lub wycena kilku — wynik obliczeń.
        const factual: ClaimStatus = transfers.length === 1 && pln === 0 ? 'source_fact' : 'computed';
        const viaDeposit = transfers.some((transfer) => transfer.viaAddress);
        if (direction === 'out') {
          const cashOut = isCashOutService(link.kind);
          addEdge({
            from: addressNode,
            to: id,
            kind: cashOut ? 'cash_out' : 'transfer',
            label,
            weight,
            // Wypłata na waluty tradycyjne jest wnioskiem; sam przelew — faktem.
            status: cashOut || viaDeposit ? 'hypothesis' : factual,
            evidence,
            explanation: viaDeposit
              ? 'Przelew przez prawdopodobny adres wpłat usługi — adres wpłat wskazano wnioskowaniem, nie etykietą.'
              : cashOut
                ? 'Przelewy na adres z publiczną etykietą usługi wymiany są zapisane w blockchainie; to, że była to wypłata na waluty tradycyjne, jest wnioskiem do potwierdzenia przez usługę.'
                : 'Przelewy z adresu na adres z publiczną etykietą usługi, zapisane w blockchainie.',
          });
        } else {
          addEdge({ from: id, to: addressNode, kind: 'transfer', label, weight, status: factual, evidence, explanation: 'Przelewy z adresu z publiczną etykietą usługi na ten adres, zapisane w blockchainie.' });
        }
      }
    }
    for (const mention of link.mentions) {
      const profile = input.profiles.find((item) => item.sightings.some((sighting) => sighting.url === mention.url));
      const account = link.basis.includes('account_link');
      addEdge({
        from: profile ? `profile:${profile.card.id}` : 'subject',
        to: id,
        kind: 'links_to',
        label: account ? 'konto lub odnośnik polecający' : 'wzmianka w treści',
        weight: link.strength,
        status: 'source_fact',
        evidence: refs([{ kind: 'url', value: mention.url }, mention.evidenceId ? { kind: 'evidence_id', value: mention.evidenceId } : undefined]),
        explanation: `Usługa ${link.name} występuje w publicznej treści konta (${account ? 'konto lub odnośnik polecający' : 'wzmianka'}); to nie dowodzi posiadania w niej konta klienta.`,
      });
    }
  }

  // Ścieżki środków: adres podmiotu → adresy pośrednie → usługa, każda krawędź to jeden krok.
  for (const proof of input.proofs ?? []) {
    const { trail } = proof;
    const service = `svc:${serviceIdOf(trail.serviceName)}`;
    addNode({ id: service, kind: 'service', label: trail.serviceName, sublabel: 'usługa na końcu ścieżki środków', score: trail.confidence });
    let from = `addr:${trail.network}:${trail.sourceAddress}`;
    if (proof.cluster) {
      addNode({ id: from, kind: 'address', label: shortAddress(trail.sourceAddress), sublabel: 'adres z klastra portfela (heurystyka)', score: proof.personAddressProbability });
      addEdge({
        from: `addr:${trail.network}:${proof.cluster.seed}`,
        to: from,
        kind: 'related',
        label: proof.cluster.reason,
        status: 'hypothesis',
        layer: 'chain',
        evidence: refs([{ kind: 'address', value: proof.cluster.seed }, { kind: 'address', value: trail.sourceAddress }]),
        explanation: `Adres zaliczony do tego samego portfela heurystyką (${proof.cluster.reason}) — to wnioskowanie, nie zapis w blockchainie.`,
      });
    }
    trail.hops.forEach((hop, index) => {
      const final = index === trail.hops.length - 1;
      const to = final ? service : `addr:${trail.network}:${hop.to}`;
      if (!final) addNode({ id: to, kind: 'address', label: shortAddress(hop.to), sublabel: hop.toLabel ?? 'adres pośredni na ścieżce środków', url: hop.explorerUrl });
      addEdge({
        from,
        to,
        kind: 'cash_out',
        label: `krok ${index + 1}: ${hop.amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 })} ${hop.asset}`,
        weight: trail.confidence,
        // Krok wprost z transakcji jest faktem; krok z heurystyki i wniosek o dotarciu do usługi — hipotezą.
        status: hop.inferred || final ? 'hypothesis' : 'source_fact',
        evidence: refs([{ kind: 'txid', value: hop.txid }, { kind: 'url', value: hop.explorerUrl }]),
        explanation:
          hop.reason ??
          (final
            ? 'Ostatni krok ścieżki: środki dotarły na adres przypisywany usłudze; wypłatę na waluty tradycyjne może potwierdzić tylko usługa.'
            : hop.inferred
              ? 'Krok ustalony heurystyką, nie wprost z transakcji.'
              : 'Przelew zapisany w transakcji.'),
      });
      from = to;
    });
  }

  // Zajęcie: adres podmiotu → adres organu państwa. Pochodzenie środków: adres źródłowy → adres podmiotu.
  for (const seizure of input.seizures ?? []) {
    const id = `gov:${seizure.counterparty}`;
    addNode({ id, kind: 'service', label: seizure.counterpartyLabel, sublabel: 'organ państwa — zajęcie środków (etykieta publiczna)', url: seizure.explorerUrl });
    addEdge({
      from: `addr:${seizure.network}:${seizure.subjectAddress}`,
      to: id,
      kind: 'transfer',
      label: `zajęcie: ${seizure.amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 })} ${seizure.asset}`,
      weight: 100,
      status: 'source_fact',
      evidence: refs([{ kind: 'txid', value: seizure.txid }, { kind: 'url', value: seizure.labelSource }]),
      explanation: seizure.explanation,
    });
  }
  for (const source of input.fundingSources ?? []) {
    if (!source.label && !source.category) continue;
    const id = `src:${source.address}`;
    addNode({
      id,
      kind: 'service',
      label: source.label ?? shortAddress(source.address),
      sublabel: source.category === 'incident' ? 'źródło środków — adres związany z incydentem' : source.category === 'sanctioned' ? 'źródło środków — lista sankcyjna' : 'źródło środków',
    });
    addEdge({
      from: id,
      to: `addr:${source.network}:${source.subjectAddress}`,
      kind: 'transfer',
      label: `${Math.round(source.share * 100)}% wpływów${source.hops > 1 ? ' (przez adres pośredni)' : ''}`,
      weight: Math.max(1, Math.round(source.share * 100)),
      // Udział we wpływach jest obliczeniem; droga przez adres pośredni — heurystyką.
      status: source.hops > 1 ? 'hypothesis' : 'computed',
      evidence: refs([...txRefs(source.txids ?? []), { kind: 'address', value: source.address }], MAX_EDGE_EVIDENCE + 1),
      explanation: source.reason,
    });
  }

  // Powiązane tożsamości: węzeł osoby połączony z podmiotem (albo z adresem, który je łączy).
  const EVIDENCE_LABEL = { url: 'publikacja', txid: 'transakcja', attribute: 'wspólna cecha', address: 'adres' } as const;
  for (const identity of input.linkedIdentities ?? []) {
    const id = `identity:${identity.id}`;
    const declared = (identity as LinkedIdentity & { status?: 'hypothesis' | 'confirmed' | 'rejected' }).status;
    const status: ClaimStatus = declared === 'confirmed' ? 'confirmed' : declared === 'rejected' || identity.decision === 'rejected' ? 'rejected' : 'hypothesis';
    const relation = identityRelationLabel(identity.relation);
    addNode({
      id,
      kind: 'person',
      label: identity.displayName,
      sublabel: status === 'hypothesis' ? `${relation} — ${HYPOTHESIS_NOTE}` : status === 'rejected' ? `${relation} — odrzucone decyzją analityka` : `${relation} — potwierdzone decyzją analityka`,
      score: identity.score,
      url: identity.profiles[0]?.url,
      status,
    });
    const [lead] = identity.reasons;
    const viaAddress = lead?.evidence.find((item) => item.kind === 'address');
    const anchor = viaAddress ? input.findings.find((finding) => finding.address === viaAddress.value) : undefined;
    addEdge({
      from: anchor ? `addr:${addressKey(anchor)}` : 'subject',
      to: id,
      kind: 'related',
      label: `${relation}: ${lead ? EVIDENCE_LABEL[lead.evidence[0]?.kind ?? 'attribute'] : 'przesłanka'}`,
      weight: identity.score,
      status,
      evidence: refs(identity.reasons.flatMap((reason) => reason.evidence)),
      explanation: `${identity.reasons.map((reason) => reason.text).join(' ')} To przesłanki wspólnego operatora albo osoby bliskiej — do rozstrzygnięcia przez analityka.`.trim(),
    });
    // Konta tej tożsamości, jeśli są w grafie, deklarują jej nazwę.
    for (const account of (identity as LinkedIdentity & { accounts?: string[] }).accounts ?? []) {
      addEdge({
        from: `profile:${account}`,
        to: id,
        kind: 'declares',
        label: 'występuje pod nazwą',
        status: 'source_fact',
        evidence: refs([{ kind: 'attribute', value: `nazwa: ${identity.displayName}` }]),
        explanation: `Konto występuje pod nazwą „${identity.displayName}”. To deklaracja w profilu, nie ustalenie tożsamości.`,
      });
    }
  }

  for (const person of input.relatedPersons) {
    const id = `person:${person.id}`;
    addNode({
      id,
      kind: 'person',
      label: person.handle,
      sublabel: `${person.services.join(', ') || 'inna sprawa w bazie'} — ${HYPOTHESIS_NOTE}`,
      score: person.strength,
      url: person.profileUrls[0],
      status: 'hypothesis',
    });
    for (const relation of person.relations) {
      const viaAddress = `addr:${relation.via}`;
      addEdge({
        from: nodes.has(viaAddress) ? viaAddress : 'subject',
        to: id,
        kind: 'related',
        label: relation.kind,
        weight: person.strength,
        status: 'hypothesis',
        evidence: refs([relation.via ? { kind: relation.kind === 'shared_attribute' ? 'attribute' : 'address', value: relation.via } : undefined]),
        explanation: relation.description,
      });
    }
  }

  // Hipotezy wspólnego operatora: krawędź między dwoma kontami, także słaba, zablokowana i odrzucona.
  for (const hypothesis of hypotheses) {
    const [a, b] = [...hypothesis.accounts].sort();
    const score = hypothesis.indicator?.score ?? 0;
    const components = hypothesis.indicator?.components ?? [];
    const weak = score < WEAK_OPERATOR_SCORE && hypothesis.status === 'hypothesis';
    addEdge({
      from: `profile:${a}`,
      to: `profile:${b}`,
      kind: 'same_operator',
      label: weak ? 'słaba hipoteza wspólnego operatora (do weryfikacji)' : (HYPOTHESIS_STATUS_LABEL[hypothesis.status] ?? HYPOTHESIS_STATUS_LABEL.hypothesis),
      weight: score,
      status: hypothesisClaim(hypothesis.status),
      evidence: refs([
        ...components.flatMap((component) => component.evidence ?? []),
        hypothesis.decision ? { kind: 'decision', value: hypothesis.decision.id } : undefined,
      ]),
      explanation: hypothesis.statement,
    });
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Im niższa ranga, tym mocniejsza podstawa krawędzi; krawędzie odrzucone nie tworzą ścieżki. */
const STATUS_RANK: Record<ClaimStatus, number> = { source_fact: 0, confirmed: 0, computed: 1, hypothesis: 2, rejected: 3 };
const rankOf = (edge: GraphEdge): number => STATUS_RANK[edge.status ?? (edge.inferred ? 'hypothesis' : 'source_fact')];

/**
 * Najmocniejsza ścieżka dowodowa między dwoma węzłami (krawędzie można przechodzić w obie strony).
 * Najpierw szukana jest ścieżka złożona wyłącznie z faktów źródłowych i potwierdzeń, potem dopuszczane są
 * obliczenia, na końcu hipotezy; przy tej samej podstawie wygrywa ścieżka krótsza, a potem o wyższych wagach.
 * Zwraca krawędzie w kolejności od `fromId` do `toId`, pustą listę dla tego samego węzła albo `null`, gdy ścieżki nie ma.
 */
export function evidencePath(graph: Graph, fromId: string, toId: string): GraphEdge[] | null {
  const ids = new Set(graph.nodes.map((node) => node.id));
  if (!ids.has(fromId) || !ids.has(toId)) return null;
  if (fromId === toId) return [];
  for (const allowed of [0, 1, 2]) {
    const adjacent = new Map<string, { edge: GraphEdge; next: string }[]>();
    for (const edge of graph.edges) {
      if (rankOf(edge) > allowed) continue;
      adjacent.set(edge.from, [...(adjacent.get(edge.from) ?? []), { edge, next: edge.to }]);
      adjacent.set(edge.to, [...(adjacent.get(edge.to) ?? []), { edge, next: edge.from }]);
    }
    // Koszt kroku: 1 za krawędź + drobna kara za niską wagę (liczba kroków zawsze przeważa).
    const cost = new Map<string, number>([[fromId, 0]]);
    const previous = new Map<string, { edge: GraphEdge; node: string }>();
    const done = new Set<string>();
    for (;;) {
      let current: string | undefined;
      for (const [id, value] of cost) if (!done.has(id) && (current === undefined || value < cost.get(current)!)) current = id;
      if (current === undefined || current === toId) break;
      done.add(current);
      for (const { edge, next } of adjacent.get(current) ?? []) {
        const value = cost.get(current)! + 1 + (100 - Math.max(0, Math.min(100, edge.weight ?? 50))) / 100_000;
        if (value < (cost.get(next) ?? Infinity)) {
          cost.set(next, value);
          previous.set(next, { edge, node: current });
        }
      }
    }
    if (!previous.has(toId)) continue;
    const path: GraphEdge[] = [];
    for (let at = toId; at !== fromId; at = previous.get(at)!.node) path.unshift(previous.get(at)!.edge);
    return path;
  }
  return null;
}

/** Węzły osiągalne wyłącznie przez krawędzie warstwy `chain` — do rysowania przepływów osobno od powiązań tożsamości. */
export function chainOnlyNodeIds(graph: Graph): Set<string> {
  const seen = new Map<string, boolean>();
  for (const edge of graph.edges) {
    for (const id of [edge.from, edge.to]) seen.set(id, (seen.get(id) ?? true) && edge.layer === 'chain');
  }
  return new Set([...seen].filter(([, chainOnly]) => chainOnly).map(([id]) => id));
}
