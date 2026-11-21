// Graf powiązań sprawy: podmiot → identyfikatory → profile → adresy → usługi,
// oraz osoby powiązane. Węzeł usługi odpowiada jednemu wpisowi `ServiceLink`
// (jedna giełda = jeden węzeł, bez względu na liczbę jej adresów).

import type { Finding, GraphEdge, GraphNode, Identifier, RelatedPerson, ServiceLink } from '@olcys/core';
import type { ProfileNode } from './entity.ts';
import { roundPln, shortAddress } from './format.ts';
import { addressKey } from './intel.ts';
import type { DiscoveryStep } from './intel.ts';
import { isCashOutService, serviceKindLabel } from './services.ts';

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
}

const identifierNodeId = (identifier: Identifier) => `id:${identifier.type}:${identifier.value.trim().toLowerCase()}`;

export function buildGraph(input: GraphInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addNode = (node: GraphNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  /** Krawędź powstaje tylko między istniejącymi węzłami — graf nie ma krawędzi donikąd. */
  const addEdge = (edge: Omit<GraphEdge, 'id'>) => {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to) return;
    const id = `${edge.kind}:${edge.from}>${edge.to}`;
    if (!edges.has(id)) edges.set(id, { id, ...edge });
  };

  addNode({ id: 'subject', kind: 'subject', label: input.subjectLabel, sublabel: `sprawa: ${input.caseName}` });

  for (const { identifier, origin } of input.identifiers) {
    const id = identifierNodeId(identifier);
    addNode({ id, kind: 'identifier', label: identifier.value, sublabel: origin === 'analyst' ? identifier.type : `${identifier.type} (odkryty)` });
    addEdge({
      from: 'subject',
      to: id,
      kind: 'has_identifier',
      ...(origin === 'discovered' ? { label: 'odkryty w profilu', inferred: true } : { label: 'podany przez analityka' }),
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
    if (finding) addEdge({ from: identifierNodeId(identifier), to: `addr:${addressKey(finding)}`, kind: 'links_to', label: 'adres podany przez analityka' });
  }

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
    const inferred = card.identityMatch !== 'verified_link' && card.identityMatch !== 'exact_identifier';
    let found = false;
    for (const sighting of profile.sightings) {
      const from = identifierNodeId(sighting.matchedIdentifier);
      if (!nodes.has(from)) continue;
      found = true;
      addEdge({ from, to: id, kind: 'found_profile', label: card.identityMatch, weight: card.identityScore, ...(inferred ? { inferred } : {}) });
    }
    if (!found) addEdge({ from: 'subject', to: id, kind: 'found_profile', label: card.identityMatch, weight: card.identityScore, inferred: true });

    const urls = new Set(profile.sightings.map((item) => item.url));
    for (const step of input.trail) {
      if (urls.has(step.sourceUrl)) addEdge({ from: id, to: identifierNodeId(step.identifier), kind: 'links_to', label: 'profil wskazuje identyfikator' });
    }
    for (const key of card.addresses) addEdge({ from: id, to: `addr:${key}`, kind: 'publishes', label: 'publikuje adres', weight: card.identityScore });
  }

  const maxPln = Math.max(1, ...input.serviceLinks.map((link) => (link.outPln ?? 0) + (link.inPln ?? 0)));
  for (const link of input.serviceLinks) {
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
        if (direction === 'out') {
          addEdge({
            from: addressNode,
            to: id,
            kind: isCashOutService(link.kind) ? 'cash_out' : 'transfer',
            label,
            weight,
            // Wypłata na waluty tradycyjne jest wnioskiem; sam przelew — faktem.
            ...(isCashOutService(link.kind) || transfers.some((transfer) => transfer.viaAddress) ? { inferred: true } : {}),
          });
        } else {
          addEdge({ from: id, to: addressNode, kind: 'transfer', label, weight });
        }
      }
    }
    for (const mention of link.mentions) {
      const profile = input.profiles.find((item) => item.sightings.some((sighting) => sighting.url === mention.url));
      addEdge({
        from: profile ? `profile:${profile.card.id}` : 'subject',
        to: id,
        kind: 'links_to',
        label: link.basis.includes('account_link') ? 'konto lub odnośnik polecający' : 'wzmianka w treści',
        weight: link.strength,
      });
    }
  }

  for (const person of input.relatedPersons) {
    const id = `person:${person.id}`;
    addNode({ id, kind: 'person', label: person.handle, sublabel: person.services.join(', ') || 'inna sprawa w bazie', score: person.strength, url: person.profileUrls[0] });
    for (const relation of person.relations) {
      const viaAddress = `addr:${relation.via}`;
      addEdge({ from: nodes.has(viaAddress) ? viaAddress : 'subject', to: id, kind: 'related', label: relation.kind, weight: person.strength, inferred: true });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
