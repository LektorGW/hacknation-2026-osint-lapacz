// Osoby powiązane z badanym podmiotem. Każde powiązanie jest WSKAZÓWKĄ do weryfikacji,
// nigdy ustaleniem: wspólny adres może być zbiórką, a przelew — zwykłą płatnością.

import type { AnalysisRun, Finding, RelatedPerson, RelationKind, ScoreRules } from '@olcys/core';
import { unlabeledCounterparties } from './counterparties.ts';
import { buildProfileNodes } from './entity.ts';
import type { ProfileNode } from './entity.ts';
import { formatAmount, shortAddress } from './format.ts';
import { normalize } from './identity.ts';
import { addressKey } from './intel.ts';
import type { Sighting } from './intel.ts';
import { PRIORITY_RULES } from './priority.ts';

/** Ostatnia analiza innej sprawy — do szukania wspólnych kontrahentów. */
export interface OtherCase {
  caseId: string;
  caseName: string;
  run: AnalysisRun;
}

/** Osoba powiązana; `caseId`, gdy powiązanie prowadzi do innej sprawy w bazie. */
export type RelatedPersonView = RelatedPerson & { caseId?: string };

export const RELATION_STRENGTH = {
  shared_address: 60,
  shared_address_many_publishers: 20,
  transacted_own_profile: 70,
  transacted_other_publication: 55,
  transacted_mass_comment: 35,
  case_transacted: 75,
  case_same_address: 65,
  common_counterparty: 40,
  extra_common_counterparty: 10,
  max_common_counterparty: 60,
  shared_contact: 80,
  shared_website: 50,
  /** Za każdy kolejny rodzaj powiązania tej samej osoby. */
  extra_kind: 10,
} as const;

export interface RelationsInput {
  run: AnalysisRun;
  /** Adresy powiązane z podmiotem (po decyzjach analityka). */
  linked: Finding[];
  sightings: Sighting[];
  /** Profile osoby głównej — do porównania cech. */
  subjectProfiles: ProfileNode[];
  otherCases: OtherCase[];
  rules: ScoreRules;
}

interface Draft {
  person: RelatedPersonView;
  points: number[];
}

const linkedOf = (run: AnalysisRun): Finding[] =>
  run.findings.filter((finding) => !finding.confidence.excluded && finding.confidence.score >= PRIORITY_RULES.linkedMinScore);

export function buildRelatedPersons(input: RelationsInput): RelatedPersonView[] {
  const drafts = new Map<string, Draft>();
  const draftFor = (id: string, handle: string, caseId?: string): Draft => {
    let draft = drafts.get(id);
    if (!draft) {
      draft = { person: { id, handle, services: [], relations: [], strength: 0, profileUrls: [], ...(caseId ? { caseId } : {}) }, points: [] };
      drafts.set(id, draft);
    }
    return draft;
  };
  const relate = (draft: Draft, kind: RelationKind, via: string, description: string, points: number) => {
    if (draft.person.relations.some((item) => item.kind === kind && item.via === via && item.description === description)) return;
    draft.person.relations.push({ kind, via, description });
    draft.points.push(points);
  };
  const noteProfile = (draft: Draft, node: ProfileNode) => {
    if (!draft.person.services.includes(node.card.service)) draft.person.services.push(node.card.service);
    for (const sighting of node.sightings) {
      if (!draft.person.profileUrls.includes(sighting.url)) draft.person.profileUrls.push(sighting.url);
    }
  };

  const linkedKeys = new Set(input.linked.map(addressKey));
  const findingByKey = new Map(input.run.findings.map((finding) => [addressKey(finding), finding]));
  const others = [
    ...buildProfileNodes(input.run, input.sightings, 'co_publisher'),
    ...buildProfileNodes(input.run, input.sightings, 'counterparty_publisher'),
  ];

  for (const node of others) {
    const handle = node.card.handle ?? node.card.url;
    const draft = draftFor(`osoba:${normalize(handle)}`, handle);
    noteProfile(draft, node);

    for (const sighting of node.sightings) {
      for (const key of sighting.addresses) {
        const address = key.slice(key.indexOf(':') + 1);
        if (sighting.role === 'co_publisher') {
          // (a) Ten sam adres publikuje inna osoba.
          const finding = findingByKey.get(key);
          if (!finding || finding.confidence.excluded) continue;
          const many = finding.unrelatedPublishers >= input.rules.sharedAddressThreshold;
          relate(
            draft,
            'shared_address',
            key,
            `Adres ${shortAddress(address)} przypisywany podmiotowi opublikował(a) także „${handle}” w serwisie ${sighting.service} (${sighting.url}).` +
              (many ? ` Adres publikuje ${finding.unrelatedPublishers} niepowiązanych autorów — prawdopodobnie adres współdzielony, słaba wskazówka.` : ''),
            many ? RELATION_STRENGTH.shared_address_many_publishers : RELATION_STRENGTH.shared_address,
          );
        } else {
          // (b) Adres tej osoby jest kontrahentem adresu podmiotu.
          for (const finding of input.linked) {
            const transfers = (finding.chain?.transfers ?? []).filter((transfer) => transfer.counterparty === address);
            if (transfers.length === 0) continue;
            const sum = (direction: 'in' | 'out') =>
              transfers.filter((transfer) => transfer.direction === direction).reduce((total, transfer) => total + transfer.amount, 0);
            const asset = transfers[0]!.asset;
            const parts = [
              sum('out') > 0 ? `wysłał na niego łącznie ${formatAmount(sum('out'))} ${asset}` : '',
              sum('in') > 0 ? `otrzymał z niego łącznie ${formatAmount(sum('in'))} ${asset}` : '',
            ].filter(Boolean);
            relate(
              draft,
              'transacted',
              key,
              `Adres podmiotu ${shortAddress(finding.address)} ${parts.join(' i ')} (${transfers.length} przel.); adres ${shortAddress(address)} ` +
                `opublikował(a) „${handle}” w serwisie ${sighting.service} (${sighting.url}).`,
              sighting.category === 'own_profile'
                ? RELATION_STRENGTH.transacted_own_profile
                : sighting.category === 'mass_comment'
                  ? RELATION_STRENGTH.transacted_mass_comment
                  : RELATION_STRENGTH.transacted_other_publication,
            );
          }
        }
      }
    }

    // (d) Wspólne cechy profili: ten sam e-mail, telefon albo strona.
    for (const subject of input.subjectProfiles) {
      const shared = (left: string[] | undefined, right: string[] | undefined) =>
        (left ?? []).map((value) => value.trim().toLowerCase()).find((value) => (right ?? []).map((item) => item.trim().toLowerCase()).includes(value));
      const email = shared(node.card.attributes.emails, subject.card.attributes.emails);
      const phone = shared(node.card.attributes.phones, subject.card.attributes.phones);
      const website = shared(node.card.attributes.urls, subject.card.attributes.urls);
      const describe = (what: string, value: string) =>
        `Profil „${handle}” (${node.card.service}) i profil podmiotu w ${subject.card.service} mają ${what}: ${value}. Może to być ta sama osoba pod inną nazwą.`;
      if (email) relate(draft, 'shared_attribute', email, describe('ten sam e-mail', email), RELATION_STRENGTH.shared_contact);
      if (phone) relate(draft, 'shared_attribute', phone, describe('ten sam telefon', phone), RELATION_STRENGTH.shared_contact);
      if (website) relate(draft, 'shared_attribute', website, describe('tę samą stronę WWW', website), RELATION_STRENGTH.shared_website);
    }
  }

  // (c) Inne sprawy w bazie: wspólny adres, bezpośredni przelew albo wspólny kontrahent bez etykiety.
  const ownCounterparties = new Map(unlabeledCounterparties(input.linked, linkedKeys).map((item) => [addressKey(item), item]));
  for (const other of input.otherCases) {
    const theirs = linkedOf(other.run);
    if (theirs.length === 0) continue;
    const theirKeys = new Set(theirs.map(addressKey));
    const draft = draftFor(`sprawa:${other.caseId}`, other.caseName, other.caseId);

    for (const key of linkedKeys) {
      if (theirKeys.has(key)) {
        relate(draft, 'shared_address', key, `Adres ${shortAddress(key.slice(key.indexOf(':') + 1))} jest powiązany także z podmiotem sprawy „${other.caseName}”.`, RELATION_STRENGTH.case_same_address);
      }
    }
    for (const [key, counterparty] of ownCounterparties) {
      if (theirKeys.has(key)) {
        relate(
          draft,
          'transacted',
          key,
          `Adres podmiotu miał przelewy (łącznie ${formatAmount(counterparty.total)}) z adresem ${shortAddress(counterparty.address)}, powiązanym z podmiotem sprawy „${other.caseName}”.`,
          RELATION_STRENGTH.case_transacted,
        );
      }
    }
    const common = unlabeledCounterparties(theirs, theirKeys).filter((item) => ownCounterparties.has(addressKey(item)));
    if (common.length > 0) {
      relate(
        draft,
        'common_counterparty',
        addressKey(common[0]!),
        `Wspólny kontrahent bez etykiety z podmiotem sprawy „${other.caseName}”: ${common.map((item) => shortAddress(item.address)).join(', ')} — możliwy wspólny pośrednik.`,
        Math.min(
          RELATION_STRENGTH.max_common_counterparty,
          RELATION_STRENGTH.common_counterparty + (common.length - 1) * RELATION_STRENGTH.extra_common_counterparty,
        ),
      );
    }
  }

  const persons: RelatedPersonView[] = [];
  for (const { person, points } of drafts.values()) {
    if (person.relations.length === 0) continue;
    const kinds = new Set(person.relations.map((item) => item.kind)).size;
    person.strength = Math.min(100, Math.max(...points) + (kinds - 1) * RELATION_STRENGTH.extra_kind);
    persons.push(person);
  }
  return persons.sort((a, b) => b.strength - a.strength || a.handle.localeCompare(b.handle, 'pl'));
}
