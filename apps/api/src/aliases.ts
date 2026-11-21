// Powiązane tożsamości: inne nazwy, pod którymi może występować ta sama osoba, oraz osoby
// bliskie lub podstawione. Każda tożsamość ma relację do osoby głównej z jawnym wynikiem,
// przesłankami (każda z dowodem: adres URL, txid, cecha, adres) i ścieżką dojścia.
//
// Relacje (wszystkie liczby w `ALIAS_RULES`):
//   same_person_likely     — mocna przesłanka: ten sam e-mail lub telefon, ten sam niewspółdzielony adres
//                            publikowany jako własny, wspólny adres wpłat giełdy lub portfel + publikacja adresu;
//   possibly_same_or_close — średnia: wspólny adres wpłat lub portfel bez publikacji, wspólna strona lub awatar,
//                            wielokrotne przelewy w obie strony, to samo nazwisko i miejscowość;
//   associated             — słaba: jednokierunkowy przelew lub finansowanie, podobna nazwa konta.
// Tożsamości o innym imieniu i nazwisku nigdy nie scalamy z osobą główną automatycznie —
// to może być ta sama osoba, osoba bliska albo podstawiona. Rozstrzyga analityk.

import type { Decision, Finding, PersonCandidate, ProfileCard, ScoreRules } from '@olcys/core';
import { OWNERSHIP_CATEGORIES } from './analysis.ts';
import type { ProfileNode } from './entity.ts';
import { formatAmount, plural, roundPln, shortAddress, sumByYear } from './format.ts';
import { normalize } from './identity.ts';
import type { AuthorComparison } from './intel.ts';
import { looksLikePersonName, tieBetween } from './persons.ts';
import { linkKindText } from './pivot.ts';
import type { PivotLead } from './pivot.ts';
import { normalizeServiceLabel } from './services.ts';

export const ALIAS_RULES = {
  same_person_likely: { base: 85, perExtraStrong: 5, perMedium: 3, max: 97 },
  possibly_same_or_close: { base: 55, perExtraMedium: 5, max: 75, maxStyleBonus: 10 },
  associated: { base: 30, perExtra: 5, max: 45 },
  /**
   * Minimalny wynik, od którego tożsamość trafia do teczki. Słabsze tropy (sama podobna nazwa konta,
   * sam odczyt stylu przez model, jednokierunkowy przelew) zostają w dzienniku analizy i są tylko policzone —
   * inaczej teczka wciągałaby przypadkowe osoby.
   */
  minScore: 50,
  description:
    'Mocna przesłanka (ten sam e-mail, telefon, adres publikowany jako własny, wspólny adres wpłat giełdy z publikacją adresu) daje relację „prawdopodobnie ta sama osoba” (85–97). ' +
    'Średnia (wspólny adres wpłat bez publikacji, strona, awatar, przelewy w obie strony, to samo nazwisko i miejscowość) — „możliwe: ta sama osoba albo bliska” (55–75, podobny styl najwyżej +10). ' +
    'Słaba (jednokierunkowy przelew, finansowanie, podobna nazwa konta) — „powiązana” (30–45). Tożsamości nie są scalane z osobą główną bez decyzji analityka.',
} as const;

export type IdentityRelation = 'same_person_likely' | 'possibly_same_or_close' | 'associated';

export interface IdentityEvidence {
  kind: 'url' | 'txid' | 'attribute' | 'address';
  value: string;
}

export interface LinkedIdentity {
  id: string;
  displayName: string;
  fullName?: string;
  handles: string[];
  relation: IdentityRelation;
  /** Siła powiązania z osobą główną, 0–100. */
  score: number;
  reasons: { text: string; evidence: IdentityEvidence[] }[];
  profiles: ProfileCard[];
  /** `published`: opublikowany jako własny; `shared_with_subject`: ten sam adres co u podmiotu; `linked:<rodzaj>`: wskazany przez dane blockchain. */
  addresses: { address: string; network: string; basis: string }[];
  /** Szacunkowe wypłaty z adresów tej tożsamości — liczone osobno od podmiotu. */
  cashOutPlnByYear: Record<string, number>;
  cashOutProof: { id: string; address: string; serviceName: string; amount: number; asset: string; valuePln?: number; trailConfidence: number; hops: number; statement: string }[];
  /** Ścieżka dojścia krok po kroku. */
  path: string[];
  /** Zastrzeżenie pokazywane przy karcie tożsamości. */
  note: string;
  /** Decyzja analityka dla profilu tej tożsamości („rejected” = inna osoba; „confirmed” scala i tożsamość znika z listy). */
  decision?: Decision;
  /** Decyzje „confirmed”, które scalą tożsamość z osobą główną i przeliczą teczkę. */
  mergeWith: { target: 'profile'; key: string }[];
}

export interface AliasInput {
  main?: PersonCandidate;
  mainNodes: ProfileNode[];
  /** Profile innych kandydatów na osobę (znalezione jak profile podmiotu, ale niescalone). */
  otherNodes: ProfileNode[];
  /** Profile autorów spoza podmiotu: z pętli rozszerzania, współpublikujący, kontrahenci. */
  externalNodes: ProfileNode[];
  leads: PivotLead[];
  /** Adresy powiązane z podmiotem. */
  linked: Finding[];
  /** Wszystkie adresy analizy — do rozpoznania adresów współdzielonych. */
  allFindings: Finding[];
  authorComparisons?: AuthorComparison[];
  /** Decyzja analityka dla profilu (także spoza profili podmiotu). */
  decisionOf: (node: ProfileNode) => Decision | undefined;
  rules: ScoreRules;
}

/** `style`: odczyt modelu o podobnym stylu — nie jest przesłanką samodzielną, tylko dodatkiem do wyniku. */
type Strength = 'strong' | 'medium' | 'weak' | 'style';
interface Reason {
  strength: Strength;
  text: string;
  evidence: IdentityEvidence[];
  path?: string[];
  /** Tylko `style`: punkty doliczane do relacji „możliwe: ta sama osoba albo bliska”. */
  bonus?: number;
}

const NOTE =
  'To może być ta sama osoba pod inną nazwą, osoba bliska albo podstawiona — do rozstrzygnięcia przez analityka. ' +
  'Decyzja „potwierdzony” dla profilu scala tożsamość z osobą główną i przelicza teczkę; „odrzucony” zostawia ją jako powiązaną.';

const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').trim().toLowerCase();
/** Nazwisko do porównań; formy żeńskie i męskie (Kowalska / Kowalski) są traktowane jako to samo nazwisko. */
const surname = (name: string | undefined) =>
  name && looksLikePersonName(name.trim()) ? fold(name).split(/\s+/).at(-1)!.replace(/(sk|ck|dzk)a$/, '$1i') : undefined;
const label = (node: ProfileNode) => `„${node.card.handle ?? node.card.url}” (${node.card.service})`;

/** Adresy, które profil publikuje jako własne (profil, oferta), a nie tylko wymienia. */
const ownedKeys = (node: ProfileNode): string[] => [
  ...new Set(node.sightings.filter((item) => OWNERSHIP_CATEGORIES.includes(item.category)).flatMap((item) => item.addresses)),
];

export function buildLinkedIdentities(input: AliasInput): { identities: LinkedIdentity[]; hidden: number } {
  const groups = new Map<string, { nodes: ProfileNode[]; reasons: Reason[]; extraAddresses: { address: string; network: string; basis: string }[] }>();
  const groupFor = (key: string) => {
    let group = groups.get(key);
    if (!group) {
      group = { nodes: [], reasons: [], extraAddresses: [] };
      groups.set(key, group);
    }
    return group;
  };
  const keyOf = (node: ProfileNode) => normalize(node.card.handle ?? node.card.url);
  for (const node of [...input.otherNodes, ...input.externalNodes]) {
    const group = groupFor(keyOf(node));
    if (!group.nodes.some((known) => known.card.id === node.card.id)) group.nodes.push(node);
  }

  const linkedKeys = new Set(input.linked.map((finding) => `${finding.network}:${finding.address}`));
  const add = (reasons: Reason[], reason: Reason) => {
    if (!reasons.some((known) => known.text === reason.text)) reasons.push(reason);
  };

  for (const group of groups.values()) {
    for (const node of group.nodes) {
      const urls = new Set(node.sightings.map((item) => item.url));
      const owned = ownedKeys(node);

      // ---------- Wspólne cechy z profilami osoby głównej ----------
      for (const main of input.mainNodes) {
        const { features } = tieBetween(main, node, input.allFindings, input.rules);
        const pair: IdentityEvidence[] = [{ kind: 'url', value: main.card.url }, { kind: 'url', value: node.card.url }];
        const origin = `profil ${label(main)} podmiotu`;
        const target = `profil ${label(node)} (${node.card.url})`;
        if (features.email) add(group.reasons, { strength: 'strong', text: `Ten sam e-mail ${features.email} w profilu podmiotu ${label(main)} i w profilu ${label(node)}.`, evidence: [{ kind: 'attribute', value: features.email }, ...pair], path: [origin, `ten sam e-mail ${features.email}`, target] });
        if (features.phone) add(group.reasons, { strength: 'strong', text: `Ten sam telefon ${features.phone} w profilu podmiotu ${label(main)} i w profilu ${label(node)}.`, evidence: [{ kind: 'attribute', value: features.phone }, ...pair], path: [origin, `ten sam telefon ${features.phone}`, target] });
        if (features.website) add(group.reasons, { strength: 'medium', text: `Ta sama strona WWW ${features.website} w profilu podmiotu ${label(main)} i w profilu ${label(node)}.`, evidence: [{ kind: 'attribute', value: features.website }, ...pair], path: [origin, `ta sama strona WWW ${features.website}`, target] });
        if (features.avatar) add(group.reasons, { strength: 'medium', text: `Ten sam awatar w profilu podmiotu ${label(main)} i w profilu ${label(node)}.`, evidence: pair, path: [origin, 'ten sam awatar', target] });
        const sameSurname = surname(main.card.attributes.displayName) !== undefined && surname(main.card.attributes.displayName) === surname(node.card.attributes.displayName);
        if (sameSurname && features.sameLocation && !features.sameName) {
          add(group.reasons, { strength: 'medium', text: `To samo nazwisko i ta sama miejscowość (${features.sameLocation}): „${main.card.attributes.displayName}” i „${node.card.attributes.displayName}”.`, evidence: [{ kind: 'attribute', value: features.sameLocation }, ...pair], path: [origin, `to samo nazwisko i miejscowość ${features.sameLocation}`, target] });
        }
        const style = input.authorComparisons?.find((item) => [item.a, item.b].includes(main.card.id) && [item.a, item.b].includes(node.card.id));
        if (style && style.likelihood >= 50) {
          const bonus = Math.min(ALIAS_RULES.possibly_same_or_close.maxStyleBonus, Math.round(style.likelihood / 10));
          add(group.reasons, { strength: 'style', text: `Model ${style.model}: podobny styl wypowiedzi (${style.likelihood}%) — przesłanka dodatkowa (+${bonus}), sama nie tworzy powiązania.`, evidence: pair, bonus });
        }
      }

      // ---------- Współpublikacja adresu podmiotu jako własnego (bez pary profili) ----------
      for (const key of owned) {
        if (!linkedKeys.has(key)) continue;
        const finding = input.linked.find((item) => `${item.network}:${item.address}` === key);
        if (!finding || finding.unrelatedPublishers >= input.rules.sharedAddressThreshold) continue;
        add(group.reasons, {
          strength: 'strong',
          text: `Adres podmiotu ${shortAddress(finding.address)} publikuje jako własny także profil ${label(node)}.`,
          evidence: [{ kind: 'address', value: finding.address }, { kind: 'url', value: node.card.url }],
          path: [`adres ${shortAddress(finding.address)} podmiotu`, 'ten sam adres publikowany jako własny', `profil ${label(node)} (${node.card.url})`],
        });
      }

      // ---------- Przelewy między adresami podmiotu a adresami tej tożsamości ----------
      for (const key of owned) {
        const address = key.slice(key.indexOf(':') + 1);
        for (const finding of input.linked) {
          const transfers = (finding.chain?.transfers ?? []).filter((transfer) => transfer.counterparty === address);
          if (transfers.length === 0) continue;
          const both = transfers.some((transfer) => transfer.direction === 'in') && transfers.some((transfer) => transfer.direction === 'out');
          add(group.reasons, {
            strength: both ? 'medium' : 'weak',
            text:
              `${both ? 'Przelewy w obie strony' : transfers[0]!.direction === 'out' ? 'Przelew z adresu podmiotu' : 'Przelew na adres podmiotu'} między adresem podmiotu ${shortAddress(finding.address)} ` +
              `a adresem ${shortAddress(address)} opublikowanym przez ${label(node)} (${transfers.length} ${plural(transfers.length, 'przelew', 'przelewy', 'przelewów')}).`,
            evidence: [{ kind: 'address', value: address }, ...transfers.slice(0, 5).map((transfer) => ({ kind: 'txid' as const, value: transfer.txid })), { kind: 'url', value: node.card.url }],
            path: [`adres ${shortAddress(finding.address)} podmiotu`, `${both ? 'przelewy w obie strony' : 'przelew'} z adresem ${shortAddress(address)}`, `adres opublikowany przez ${label(node)} (${node.card.url})`],
          });
        }
      }

      // ---------- Tropy pętli rozszerzania prowadzące do tego profilu ----------
      for (const lead of input.leads) {
        if (!lead.docUrl || !urls.has(lead.docUrl)) continue;
        const where: IdentityEvidence = { kind: 'url', value: lead.docUrl };
        if (lead.kind === 'shared_attribute') {
          const strength: Strength = lead.attribute === 'website' ? 'medium' : 'strong';
          const what = lead.attribute === 'email' ? 'e-mail' : lead.attribute === 'phone' ? 'telefon' : 'stronę WWW';
          add(group.reasons, { strength, text: `Publikacja ${label(node)} podaje ${what} podmiotu: ${lead.value}.`, evidence: [{ kind: 'attribute', value: lead.value }, where], path: lead.path });
        } else if (lead.kind === 'handle_pattern') {
          add(group.reasons, { strength: 'weak', text: `Podobna nazwa konta (rdzeń „${lead.value}”) — słaby trop, sam nie świadczy o tej samej osobie.`, evidence: [{ kind: 'attribute', value: lead.value }, where], path: lead.path });
        } else if (lead.kind === 'same_address') {
          add(group.reasons, { strength: 'strong', text: `Adres ${shortAddress(lead.value)} publikuje jako własny także ${label(node)}.`, evidence: [{ kind: 'address', value: lead.value }, where], path: lead.path });
        } else if (lead.link) {
          const strength: Strength = lead.link.kind === 'co_depositor' || lead.link.kind === 'same_wallet' ? 'strong' : lead.link.kind === 'repeated_counterparty' ? 'medium' : 'weak';
          add(group.reasons, {
            strength,
            text: `Powiązanie adresów w blockchainie: ${linkKindText(lead.link.kind)} ${shortAddress(lead.value)}${lead.link.via ? ` (przez ${shortAddress(lead.link.via)})` : ''}, a adres ten publikuje jako własny ${label(node)}.`,
            evidence: [{ kind: 'address', value: lead.value }, ...(lead.link.via ? [{ kind: 'address' as const, value: lead.link.via }] : []), ...lead.link.txids.slice(0, 5).map((txid) => ({ kind: 'txid' as const, value: txid })), where],
            path: lead.path,
          });
        }
      }
    }
  }

  // Adres powiązany w blockchainie, którego nikt nie opublikował, NIE jest tożsamością — teczka pokazuje
  // go przy adresie podmiotu jako „inny adres tego samego portfela / adres powiązany”, bez udawania osoby.

  const identities: LinkedIdentity[] = [];
  let hidden = 0;
  for (const [key, group] of groups) {
    // Sam odczyt stylu przez model nie jest przesłanką — bez innej podstawy tożsamości nie ma.
    if (!group.reasons.some((reason) => reason.strength !== 'style')) {
      if (group.reasons.length > 0) hidden++;
      continue;
    }
    const count = (strength: Strength) => group.reasons.filter((reason) => reason.strength === strength).length;
    const [strong, medium, weak] = [count('strong'), count('medium'), count('weak')];
    const styleBonus = Math.max(0, ...group.reasons.filter((reason) => reason.strength === 'style').map((reason) => reason.bonus ?? 0));
    let relation: IdentityRelation;
    let score: number;
    if (strong > 0) {
      relation = 'same_person_likely';
      const rule = ALIAS_RULES.same_person_likely;
      score = Math.min(rule.max, rule.base + (strong - 1) * rule.perExtraStrong + medium * rule.perMedium);
    } else if (medium > 0) {
      relation = 'possibly_same_or_close';
      const rule = ALIAS_RULES.possibly_same_or_close;
      score = Math.min(rule.max, rule.base + (medium - 1) * rule.perExtraMedium) + styleBonus;
    } else {
      relation = 'associated';
      const rule = ALIAS_RULES.associated;
      score = Math.min(rule.max, rule.base + (weak - 1) * rule.perExtra);
    }

    if (score < ALIAS_RULES.minScore) {
      hidden++;
      continue;
    }
    // Odczyt stylu pokazujemy tylko tam, gdzie wpłynął na wynik.
    if (relation !== 'possibly_same_or_close') group.reasons = group.reasons.filter((reason) => reason.strength !== 'style');

    const handles = [...new Set(group.nodes.map((node) => node.card.handle).filter((value): value is string => Boolean(value)))];
    const fullName = group.nodes.map((node) => node.card.attributes.displayName?.trim()).find((name) => name !== undefined && looksLikePersonName(name));
    const addresses = [
      ...new Map(
        group.nodes.flatMap((node) =>
          ownedKeys(node).map((addressKey) => {
            const [network, address] = [addressKey.slice(0, addressKey.indexOf(':')), addressKey.slice(addressKey.indexOf(':') + 1)];
            return [addressKey, { address, network, basis: linkedKeys.has(addressKey) ? 'shared_with_subject' : 'published' }] as const;
          }),
        ),
      ).values(),
      ...group.extraAddresses,
    ];
    // Aktywność własnych adresów tożsamości: znanych z jej publikacji, nieprzypisanych podmiotowi.
    const own = input.allFindings.filter((finding) => addresses.some((item) => item.basis === 'published' && item.address === finding.address));
    const order: Strength[] = ['strong', 'medium', 'weak', 'style'];
    const reasons = [...group.reasons].sort((a, b) => order.indexOf(a.strength) - order.indexOf(b.strength));
    const decision = group.nodes.map((node) => input.decisionOf(node)).find((value) => value !== undefined);
    identities.push({
      id: `tozsamosc:${key}`,
      displayName: fullName ?? handles[0] ?? `Nieznany właściciel adresu ${shortAddress(group.extraAddresses[0]?.address ?? key)}`,
      ...(fullName ? { fullName } : {}),
      handles,
      relation,
      score,
      reasons: reasons.map(({ text, evidence }) => ({ text, evidence })),
      profiles: group.nodes.map((node) => ({
        ...node.card,
        identityScore: score,
        identityReasons: ['Profil powiązanej tożsamości — nie jest zaliczony do profili podmiotu.'],
      })),
      addresses,
      cashOutPlnByYear: sumByYear(own.map((finding) => finding.chain?.cashOutPlnByYear ?? {})),
      cashOutProof: own.flatMap((finding) =>
        (finding.chain?.trails ?? []).map((trail) => ({
          id: trail.id,
          address: trail.sourceAddress,
          serviceName: normalizeServiceLabel(trail.serviceName),
          amount: trail.amount,
          asset: trail.asset,
          ...(trail.valuePln !== undefined ? { valuePln: trail.valuePln } : {}),
          trailConfidence: trail.confidence,
          hops: trail.hops.length,
          statement:
            `Z adresu powiązanej tożsamości ${shortAddress(trail.sourceAddress)} przekazano ${formatAmount(trail.amount)} ${trail.asset}` +
            `${trail.valuePln !== undefined ? ` (ok. ${roundPln(trail.valuePln)})` : ''} do usługi ${normalizeServiceLabel(trail.serviceName)} — pewność ścieżki ${trail.confidence}%.`,
        })),
      ),
      path: reasons.find((reason) => reason.path)?.path ?? [],
      note: NOTE,
      ...(decision ? { decision } : {}),
      mergeWith: group.nodes.map((node) => ({ target: 'profile' as const, key: node.card.id })),
    });
  }
  return { identities: identities.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName, 'pl')), hidden };
}

const RELATION_LABEL: Record<IdentityRelation, string> = {
  same_person_likely: 'prawdopodobnie ta sama osoba',
  possibly_same_or_close: 'możliwe: ta sama osoba albo osoba bliska',
  associated: 'osoba powiązana',
};

export const identityRelationLabel = (relation: IdentityRelation): string => RELATION_LABEL[relation];
