// Organizacje w teczce: beneficjent adresu zbiórki (hipoteza z kontekstu cytowań, ewentualnie potwierdzona na
// stronie organizacji) oraz sieć organizacji z rejestrów publicznych — widok, zdania i węzły grafu.
// Organizacja nie jest kandydatem na osobę: Wskaźnik Pewności dla osoby pozostaje 0%.

import type { Dossier, Finding, GraphEdge, GraphNode } from '@olcys/core';
import { BENEFICIARY_RULES, attributeBeneficiary, collectBeneficiaryMentions } from './beneficiary.ts';
import type { BeneficiaryAttribution, BeneficiaryComponent, OfficialSiteCheck } from './beneficiary.ts';
import { shortAddress } from './format.ts';
import { addressKey } from './intel.ts';
import type { RunIntel } from './intel.ts';
import type { OrganizationNetwork } from './org-network.ts';

type KeyFinding = Dossier['keyFindings'][number];

/** Organizacja wskazana w teczce. */
export interface DossierOrganization {
  name: string;
  domain?: string;
  role: 'beneficjent zbiórki' | 'odbiorca płatności';
  /** Adresy sprawy (`network:address`), których dotyczy. */
  addresses: string[];
  /** Wskaźnik 0–100 z jawnych reguł `BENEFICIARY_RULES`. */
  indicator: number;
  components: BeneficiaryComponent[];
  origins: number;
  evidence: { url: string; author?: string; service: string; quote: string }[];
  /** Zawsze hipoteza — potwierdzenie daje tylko analityk albo odpowiedź organizacji. */
  status: 'hypothesis' | 'confirmed';
  officialSite?: OfficialSiteCheck;
  donationUrl?: string;
  statement: string;
  limitations: string[];
  /** Identyfikator podmiotu w sieci organizacji z rejestrów (gdy rozpoznano). */
  registryId?: string;
}

/**
 * Beneficjenci z zapisanej analizy, a dla analiz sprzed tego etapu — liczeni z cytatów przy adresach
 * (bez sprawdzenia strony organizacji, którego teczka nie wykonuje).
 */
export function resolveBeneficiaries(findings: Finding[], intel: RunIntel | null | undefined): BeneficiaryAttribution[] {
  if (Array.isArray(intel?.beneficiaries)) return intel.beneficiaries;
  const result: BeneficiaryAttribution[] = [];
  for (const finding of findings) {
    if (finding.unrelatedPublishers < BENEFICIARY_RULES.minCitingAuthors) continue;
    const docs = finding.evidence.map((item) => ({ url: item.url, service: item.service, ...(item.author ? { author: item.author } : {}), text: item.excerpt, contentHash: item.contentHash }));
    const { mentions, warnings } = collectBeneficiaryMentions(docs, finding.address);
    const attribution = attributeBeneficiary({ address: finding.address, network: finding.network, mentions, warnings });
    if (attribution) result.push(attribution);
  }
  return result;
}

export function organizationStatement(attribution: BeneficiaryAttribution): string {
  return (
    `Adres ${shortAddress(attribution.address)} to — według publikacji cytujących — adres ${attribution.role === 'beneficjent zbiórki' ? 'zbiórki' : 'płatności'} organizacji „${attribution.name}”` +
    `${attribution.domain ? ` (${attribution.domain})` : ''}: wskazuje ją ${attribution.origins} ${attribution.origins === 1 ? 'niezależne pochodzenie' : 'niezależnych pochodzeń'} publikacji, wskaźnik ${attribution.score}/100 (hipoteza)` +
    `${attribution.officialSite?.publishesAddress ? `; potwierdzone na stronie organizacji ${attribution.officialSite.url}` : attribution.officialSite ? `; strona organizacji ${attribution.officialSite.url} — ${attribution.officialSite.note}` : ''}. ` +
    'Autorzy cytujący adres nie są jego właścicielami; wpłacający to darczyńcy, nie konta właściciela.'
  );
}

export function organizationViews(beneficiaries: BeneficiaryAttribution[], network?: OrganizationNetwork): DossierOrganization[] {
  return beneficiaries
    .filter((item) => item.attributed)
    .map((item) => {
      const registry = network?.organizations.find((org) => org.seed && org.match !== 'name_only' && org.addresses.includes(item.address));
      return {
        name: item.name,
        ...(item.domain ? { domain: item.domain } : {}),
        role: item.role,
        addresses: [addressKey(item)],
        indicator: item.score,
        components: item.components,
        origins: item.origins,
        evidence: item.evidence.map(({ url, author, service, quote }) => ({ url, ...(author ? { author } : {}), service, quote })),
        status: 'hypothesis' as const,
        ...(item.officialSite ? { officialSite: item.officialSite } : {}),
        ...(item.donationUrl ? { donationUrl: item.donationUrl } : {}),
        statement: organizationStatement(item),
        limitations: item.limitations,
        ...(registry ? { registryId: registry.id } : {}),
      };
    });
}

/** Zdanie kluczowych ustaleń — po informacji o cytowaniach, przed ustaleniami z blockchaina. */
export function insertOrganizationFindings(keyFindings: KeyFinding[], organizations: DossierOrganization[], network?: OrganizationNetwork): KeyFinding[] {
  if (organizations.length === 0 && !network?.persons.length) return keyFindings;
  const sentences: KeyFinding[] = organizations.slice(0, 2).map((org) => ({ text: org.statement, layer: 'inference' as const }));
  if (network && network.persons.length > 0) {
    const seed = network.organizations.find((org) => org.seed && org.match !== 'name_only') ?? network.organizations[0]!;
    const roles = network.persons.filter((person) => person.organizationId === seed.id).slice(0, 3);
    sentences.push({
      text:
        `Rejestry publiczne: „${seed.name}” — ${network.persons.length} ${network.persons.length === 1 ? 'osoba w roli' : 'osób w rolach'}${roles.length ? ` (np. ${roles.map((person) => `${person.name} — ${person.role}`).join('; ')})` : ''}` +
        `${network.organizations.length > 1 ? `, podmiotów powiązanych ${network.organizations.length - 1}` : ''}. To osoby odpowiedzialne za organizację według rejestru, nie właściciele adresu.`,
      layer: 'fact',
    });
  }
  const at = keyFindings.findIndex((item) => /^Adres jest (powszechnie cytowany|wymieniany)/.test(item.text));
  const result = [...keyFindings];
  result.splice(at >= 0 ? at + 1 : 0, 0, ...sentences);
  return result;
}

/** Wyjaśnienia „brak osoby” mówią teraz, czyj to adres. */
export function annotateExplanations<T extends { kind: string; text: string; suggestions: string[] }>(explanations: T[], organizations: DossierOrganization[]): T[] {
  const org = organizations[0];
  if (!org) return explanations;
  const who = `„${org.name}”${org.domain ? ` (${org.domain})` : ''}`;
  return explanations.map((item) => {
    if (item.kind === 'no_owner') {
      return {
        ...item,
        text: `${item.text} Publikacje cytujące wskazują jednak, czyj to adres: zbiórka organizacji ${who} (hipoteza, wskaźnik ${org.indicator}/100) — organizacja, nie osoba; Wskaźnik Pewności dla osoby 0% (znany adres zbiórki).`,
        suggestions: [
          org.officialSite?.publishesAddress
            ? `Zachowaj kopię strony organizacji ${org.officialSite.url}, która publikuje ten adres.`
            : `Potwierdź adres na oficjalnej stronie organizacji${org.domain ? ` (${org.domain})` : ''} albo zapytaniem do organizacji.`,
          'Wypłaty z adresu zbiórki (np. na giełdę) prowadzą do konta organizacji — dane konta zna usługa, do której trafiły środki.',
          ...item.suggestions,
        ],
      };
    }
    if (item.kind === 'widely_cited') return { ...item, text: `${item.text} Treść wokół adresu wskazuje organizację ${who} jako beneficjenta zbiórki (hipoteza).` };
    return item;
  });
}

/** Węzły organizacji, osób w rolach i relacji (warstwa tożsamości) dopisywane do grafu teczki. */
export function organizationGraph(organizations: DossierOrganization[], network: OrganizationNetwork | undefined, existing: { nodes: GraphNode[] }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const known = new Set(existing.nodes.map((node) => node.id));
  const push = (node: GraphNode) => {
    if (known.has(node.id)) return;
    known.add(node.id);
    nodes.push(node);
  };
  for (const org of organizations) {
    const id = org.registryId ?? `org:benef:${org.name}`;
    push({
      id,
      kind: 'organization',
      label: org.name,
      sublabel: `organizacja (${org.role}) · hipoteza`,
      score: org.indicator,
      status: 'hypothesis',
      ...(org.officialSite?.url ? { url: org.officialSite.url } : org.donationUrl ? { url: org.donationUrl } : {}),
    });
    for (const address of org.addresses) {
      const from = `addr:${address}`;
      if (!known.has(from)) continue;
      edges.push({
        id: `beneficiary:${from}->${id}`,
        from,
        to: id,
        kind: 'beneficiary_of',
        label: `adres ${org.role === 'beneficjent zbiórki' ? 'zbiórki' : 'płatności'} organizacji (hipoteza)`,
        weight: org.indicator,
        inferred: true,
        status: 'hypothesis',
        layer: 'identity',
        evidence: [...org.evidence.slice(0, 5).map((item) => ({ kind: 'url' as const, value: item.url })), ...(org.officialSite?.publishesAddress ? [{ kind: 'url' as const, value: org.officialSite.url }] : [])],
        explanation: org.statement,
      });
    }
  }
  if (network) {
    for (const org of network.organizations) {
      push({
        id: org.id,
        kind: 'organization',
        label: org.name,
        sublabel: org.match === 'name_only' ? 'możliwy wpis w rejestrze (zgodna tylko nazwa)' : org.seed ? 'organizacja w rejestrze' : 'podmiot powiązany (rejestr)',
        status: org.match === 'name_only' ? 'hypothesis' : 'source_fact',
        ...(org.sources[0] ? { url: org.sources[0].url } : {}),
      });
    }
    for (const person of network.persons) {
      const id = `regperson:${person.wikidata ?? person.id}`;
      push({ id, kind: 'person', label: person.name, sublabel: `osoba w roli z rejestru: ${person.role}`, status: 'source_fact', url: person.source.url });
      edges.push({
        id: `role:${person.id}`,
        from: id,
        to: person.organizationId,
        kind: 'holds_role',
        label: `pełni funkcję w: ${person.role}${person.from ? ` (od ${person.from}${person.to ? ` do ${person.to}` : ''})` : ''}`,
        status: 'source_fact',
        layer: 'identity',
        evidence: [{ kind: 'url', value: person.source.url }],
        explanation: `Osoba odpowiedzialna za organizację (rola w rejestrze ${person.source.registry}, pobrano ${person.source.retrievedAt}) — nie właściciel adresu.`,
      });
    }
    for (const [index, relation] of network.relations.entries()) {
      edges.push({
        id: `orgrel:${index}:${relation.from}->${relation.to}`,
        from: relation.from,
        to: relation.to,
        kind: 'org_relation',
        label: relation.label,
        status: relation.status === 'computed' ? 'computed' : 'source_fact',
        layer: 'identity',
        ...(relation.source ? { evidence: [{ kind: 'url' as const, value: relation.source.url }] } : {}),
        explanation: relation.explanation,
      });
    }
    for (const link of network.personLinks.filter((item) => item.kind === 'shared_organizations').slice(0, 10)) {
      const a = network.persons.find((item) => item.id === link.a);
      const b = network.persons.find((item) => item.id === link.b);
      if (!a || !b) continue;
      edges.push({
        id: `personlink:${link.a}<->${link.b}`,
        from: `regperson:${a.wikidata ?? a.id}`,
        to: `regperson:${b.wikidata ?? b.id}`,
        kind: 'related',
        label: 'wspólne organizacje (rejestr)',
        status: 'computed',
        layer: 'identity',
        explanation: link.explanation,
      });
    }
  }
  return { nodes, edges: edges.filter((edge) => known.has(edge.from) && known.has(edge.to)) };
}
