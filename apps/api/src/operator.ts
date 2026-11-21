// Wskaźniki A i B (opis pojęć w `packages/core/src/indicators.ts`):
//   A. konto → portfel: na ile KONKRETNE KONTO publicznie deklaruje związek z adresem;
//   B. wspólny operator: na ile dwa KONKRETNE KONTA może obsługiwać ten sam operator.
//
// Oba są jawną sumą składników — każdy ma regułę, wagę, źródło, dowód, wyjaśnienie, ocenę
// niezależności i ograniczenia. Żaden nie jest ustaleniem tożsamości: hipoteza wspólnego operatora
// staje się „potwierdzona” wyłącznie decyzją analityka (cel `link`, klucz `linkKey(a, b)`).

import { INDICATOR_SCALE, combineComponents, computeConfidence, indicatorLevel, linkKey } from '@olcys/core';
import type {
  AccountWalletLink,
  ClaimStatus,
  ComponentDraft,
  Decision,
  EvidenceRef,
  Finding,
  HypothesisStatus,
  Independence,
  OperatorHypothesis,
  ScoreComponent,
  ScoreRules,
} from '@olcys/core';
import { AI_RULES } from './ai-rules.ts';
import { OWNERSHIP_CATEGORIES } from './analysis.ts';
import type { ProfileNode } from './entity.ts';
import { shortAddress } from './format.ts';
import { addressKey, sightingKey } from './intel.ts';
import type { AuthorComparison } from './intel.ts';
import { PERSON_RULES, createTieScorer, nameConflict } from './persons.ts';
import { linkKindText } from './pivot.ts';
import type { LinkKind, PivotLead } from './pivot.ts';
import type { DecisionRecord } from './storage.ts';

export const OPERATOR_RULES = {
  /** Najwyżej tyle hipotez wspólnego operatora w teczce (hipotezy z decyzją analityka są zawsze). */
  maxHypotheses: 50,
  maxAccountWalletLinks: 200,
  /** Kontrdowody miękkie i twarde — punkty odejmowane od wskaźnika. */
  conflict: { declared_name: 10, location: 10, analyst_rejected: 100 },
  /** Powiązanie adresów obu kont w samym blockchainie, według rodzaju. */
  linkedAddress: { same_wallet: 70, co_depositor: 60, repeated_counterparty: 30, funded_by: 20, funds: 20 } satisfies Record<LinkKind, number>,
  /** Konto tylko wymienia adres (wypowiedź, komentarz), a nie podaje go jako własny. */
  mentionPenalty: 20,
  description:
    'Wspólny operator: każda wspólna cecha pary kont jest składnikiem o wadze z reguł łączenia profili (e-mail 100, telefon 100, wzajemne odnośniki 90, ' +
    'ten sam adres publikowany jako własny 80, strona WWW 50, awatar 50, rzadki nick ze zgodną nazwą lub lokalizacją 50, sam nick 20, sama nazwa 15). ' +
    'Wskaźnik = najmocniejszy składnik + 20% każdego kolejnego niezależnego (najwyżej +15) − kontrdowody; bez decyzji analityka najwyżej 95, ' +
    'a przy kontrdowodzie twardym (sprzeczne deklarowane nazwiska, sprzeczność w grupie kont) najwyżej 45. Adresy giełd, kontraktów, zbiórek i adresy ' +
    'współdzielone nie są liczone. Konto → portfel: Wskaźnik Pewności adresu liczony wyłącznie z publikacji danego konta; sama wzmianka obniża go o 20, ' +
    'a adres usługi lub kontraktu daje 0 z adnotacją, że to nie jest portfel prywatny.',
} as const;

const fold = (value: string): string => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').trim().toLowerCase().replace(/\s+/g, ' ');
const digits = (value: string): string => value.replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');
const label = (node: ProfileNode): string => `„${node.card.handle ?? node.card.url}” (${node.card.service})`;
const persona = (node: ProfileNode): string => node.card.attributes.displayName?.trim() || node.card.handle || node.card.url;
const addressOf = (key: string): string => key.slice(key.indexOf(':') + 1);

const NOT_IDENTITY = 'Przesłanki wspólnego operatora — nie jest to ustalenie tożsamości.';

const HYPOTHESIS_LIMITATIONS = [
  'Wskaźnik opisuje przesłanki, że dwa konta obsługuje ten sam operator; nie ustala, kim ten operator jest.',
  'Uwzględniono wyłącznie cechy widoczne w przeszukanych źródłach publicznych.',
  'Bez decyzji analityka hipoteza pozostaje wnioskowaniem narzędzia.',
];

export interface OperatorInput {
  /** Wszystkie konta znane teczce (po jednym na `ProfileCard.id`): profile podmiotu i konta powiązanych tożsamości. */
  accounts: ProfileNode[];
  /** Adresy zapisanej analizy — do rozpoznania adresów współdzielonych i kopii publikacji. */
  findings: Finding[];
  rules: ScoreRules;
  /** `ProfileCard.id` → identyfikator kandydata na osobę (z `resolvePersons`). */
  personOfProfile: Map<string, string>;
  /** Połączenia pominięte przez `resolvePersons` z powodu sprzeczności: `linkKey` → powód. */
  blockedPairs: Map<string, string>;
  /** Decyzje analityka o profilach: `ProfileCard.id` → decyzja. */
  profileDecisions: Map<string, Decision>;
  /** Obowiązujące decyzje analityka o parach kont: `linkKey` → decyzja. */
  linkDecisions: Map<string, DecisionRecord>;
  authorComparisons?: AuthorComparison[];
  /** Tropy pętli rozszerzania — wspólna cecha podana w treści publikacji, powiązania adresów w blockchainie. */
  leads?: PivotLead[];
}

/** Wskaźnik B: hipotezy wspólnego operatora dla par kont, od najmocniejszej. */
export function buildOperatorHypotheses(input: OperatorInput): OperatorHypothesis[] {
  const { ties } = PERSON_RULES;
  const tieBetween = createTieScorer(input.findings, input.rules);
  const leadsOf = (node: ProfileNode): PivotLead[] => (input.leads ?? []).filter((lead) => lead.docUrl !== undefined && node.sightings.some((item) => item.url === lead.docUrl));
  const leads = new Map(input.accounts.map((node) => [node.card.id, leadsOf(node)]));
  const hypotheses: OperatorHypothesis[] = [];

  for (let i = 0; i < input.accounts.length; i++) {
    for (let j = i + 1; j < input.accounts.length; j++) {
      // Kolejność kont zgodna z kluczem pary.
      const [a, b] = [input.accounts[i]!, input.accounts[j]!].sort((x, y) => x.card.id.localeCompare(y.card.id)) as [ProfileNode, ProfileNode];
      const id = linkKey(a.card.id, b.card.id);
      if (a.card.id === b.card.id) continue;
      const decision = input.linkDecisions.get(id);
      const tie = tieBetween(a, b);
      const { features } = tie;
      const pairUrls: EvidenceRef[] = [{ kind: 'url', value: a.card.url }, { kind: 'url', value: b.card.url }];
      const source = [...new Set([a.card.service, b.card.service])].join(' + ');
      const drafts: ComponentDraft[] = [];
      const path: string[] = [];
      /** Ścieżka dojścia zapisana przez pętlę rozszerzania — gdy to ona doprowadziła do drugiego konta. */
      let leadPath: string[] | undefined;
      const supports = (rule: string, weight: number, explanation: string, limitations: string[], evidence: EvidenceRef[] = [], originKey?: string, from = source) => {
        drafts.push({ rule, weight, direction: 'supports', source: from, evidence: [...evidence, ...pairUrls], explanation, limitations, ...(originKey ? { originKey } : {}) });
      };
      const contradicts = (rule: string, weight: number, explanation: string, limitations: string[], evidence: EvidenceRef[] = [], blocking = false, from = source) => {
        drafts.push({ rule, weight, direction: 'contradicts', source: from, evidence: [...evidence, ...pairUrls], explanation, limitations, ...(blocking ? { blocking } : {}) });
      };

      // ---------- Przesłanki ----------
      if (features.email) {
        supports('operator.same_email', ties.same_email, `Oba konta podają ten sam e-mail ${features.email}.`, ['Skrzynka może być wspólna (firmowa, rodzinna) albo podana cudzo — e-mail nie wskazuje, kto faktycznie obsługuje konto.'], [{ kind: 'attribute', value: features.email }], `email:${features.email}`);
        path.push(`ten sam e-mail ${features.email}`);
      }
      if (features.phone) {
        supports('operator.same_phone', ties.same_phone, `Oba konta podają ten sam telefon ${features.phone}.`, ['Numer może być wspólny (firma, rodzina) albo przejęty po poprzednim abonencie.'], [{ kind: 'attribute', value: features.phone }], `phone:${features.phone}`);
        path.push(`ten sam telefon ${features.phone}`);
      }
      if (features.links) {
        // Odnośnik wynikający wyłącznie ze wspólnej cechy (np. konto znalezione po e-mailu drugiego) nie jest osobną przesłanką.
        const viaValues = features.linkVia ?? [];
        const sameAs = (value: string): string | undefined =>
          features.email && value === features.email
            ? `email:${features.email}`
            : features.phone && digits(value) === features.phone
              ? `phone:${features.phone}`
              : features.website && value.includes(features.website.replace(/^https?:\/\//, ''))
                ? `website:${features.website}`
                : undefined;
        const origins = viaValues.map(sameAs);
        const originKey = origins.length > 0 && origins.every((origin) => origin !== undefined && origin === origins[0]) ? origins[0]! : `link:${id}`;
        const refs: EvidenceRef[] = viaValues.slice(0, 5).map((value) => ({ kind: 'attribute', value }));
        if (features.links === 'mutual') {
          supports('operator.mutual_links', ties.mutual_links, `Konta wskazują się nawzajem (${viaValues.join(', ') || 'odnośniki w obu profilach'}).`, ['Wzajemne odnośniki świadczą o związku kont; mogą też łączyć wspólników albo markę z osobą, która ją prowadzi.'], refs, originKey);
        } else {
          supports('operator.one_way_link', features.linkWeight ?? ties.one_way_link, `Jedno konto wskazuje drugie (${viaValues.join(', ') || 'odnośnik w profilu'}), bez odnośnika zwrotnego.`, ['Jednostronny odnośnik może umieścić każdy — wskazane konto nie musi o nim wiedzieć.'], refs, originKey);
        }
        path.push(features.links === 'mutual' ? 'wzajemne odnośniki między kontami' : 'jednostronny odnośnik między kontami');
      }
      for (const key of features.addresses) {
        supports('operator.same_owned_address', ties.same_address, `Oba konta publikują adres ${shortAddress(addressOf(key))} jako własny, w niezależnych treściach.`, ['Wspólny adres do wpłat mogą podawać także wspólnicy, rodzina albo pośrednik; publikacja nie dowodzi dysponowania kluczem prywatnym.'], [{ kind: 'address', value: addressOf(key) }], `address:${key}`);
        path.push(`ten sam adres ${shortAddress(addressOf(key))} publikowany jako własny`);
      }
      for (const key of [...(features.copiedAddresses ?? []), ...(features.mentionedAddresses ?? [])]) {
        const copied = features.copiedAddresses?.includes(key) === true;
        supports(
          'operator.same_address_mention',
          ties.same_address_mention,
          copied
            ? `Oba konta zamieściły tę samą treść z adresem ${shortAddress(addressOf(key))} — kopia publikacji, nie dwie niezależne deklaracje.`
            : `Adres ${shortAddress(addressOf(key))} występuje w publikacjach obu kont, ale co najmniej jedno tylko go wymienia lub cytuje.`,
          ['Ten sam adres w skopiowanej publikacji / wzmiance — nie dowodzi wspólnego operatora: treść może skopiować lub zacytować każdy.'],
          [{ kind: 'address', value: addressOf(key) }],
          // Przy adresie publikowanym jako własny wzmianka o innym adresie jest przesłanką tego samego rodzaju.
          features.addresses.length > 0 ? `address:${features.addresses[0]}` : 'address:mention',
        );
      }
      if (features.website) {
        supports('operator.same_website', ties.same_website, `Oba konta podają tę samą stronę WWW ${features.website}.`, ['Strona może należeć do firmy, sklepu albo społeczności, do której odsyła wiele osób.'], [{ kind: 'attribute', value: features.website }], `website:${features.website}`);
        path.push(`ta sama strona WWW ${features.website}`);
      }
      if (features.avatar) {
        supports('operator.same_avatar', ties.same_avatar, 'Oba konta mają ten sam awatar.', ['Obraz można skopiować z cudzego profilu; popularne grafiki powtarzają się u wielu osób.'], a.card.attributes.avatarUrl ? [{ kind: 'attribute', value: a.card.attributes.avatarUrl }] : [], 'avatar');
      }
      if (features.rareHandle) {
        supports(
          'operator.rare_handle_with_name_or_location',
          ties.rare_handle_with_name_or_location,
          `Ten sam rzadki nick „${a.card.handle}” i zgodna ${features.sameName ? 'nazwa wyświetlana' : `lokalizacja (${features.sameLocation})`}.`,
          ['Zgodność nicku i jednej cechy opisowej nadal może być zbiegiem okoliczności albo podszyciem się pod cudzą nazwę.'],
          [{ kind: 'attribute', value: a.card.handle ?? '' }],
          'handle',
        );
        path.push(`ten sam nick „${a.card.handle}” i zgodna ${features.sameName ? 'nazwa' : 'lokalizacja'}`);
      } else {
        if (features.sameHandle) {
          supports('operator.same_handle', ties.same_handle, `Oba konta używają tego samego nicku „${a.card.handle}”.`, ['Ten sam nick jest często używany przez różne osoby w różnych serwisach — sam niczego nie dowodzi.'], [{ kind: 'attribute', value: a.card.handle ?? '' }], 'handle');
          path.push(`ten sam nick „${a.card.handle}”`);
        }
        if (features.sameName) {
          supports('operator.same_name', ties.same_name, `Oba konta mają tę samą nazwę wyświetlaną „${a.card.attributes.displayName?.trim()}”.`, ['Możliwa zbieżność imion i nazwisk (imiennik); nazwę wyświetlaną ustawia się dowolnie.'], [{ kind: 'attribute', value: a.card.attributes.displayName?.trim() ?? '' }], 'name');
        }
      }
      const style = input.authorComparisons?.find((item) => item.a !== item.b && [item.a, item.b].includes(a.card.id) && [item.a, item.b].includes(b.card.id));
      if (style && style.likelihood >= 50) {
        const { maxBonus } = AI_RULES.authorComparison;
        supports(
          'operator.style_similarity',
          Math.min(maxBonus, Math.round((style.likelihood / 100) * maxBonus)),
          `Model ${style.model}: podobny styl wypowiedzi obu kont (${style.likelihood}%).`,
          ['Odczyt modelu językowego jest słabą przesłanką dodatkową — sam nie tworzy hipotezy i nie łączy kont.'],
          [],
          'style',
          `model ${style.model}`,
        );
      }

      // ---------- Tropy pętli rozszerzania: cecha jednego konta podana w treści publikacji drugiego ----------
      for (const [owner, publisher] of [[a, b], [b, a]] as const) {
        for (const lead of leads.get(publisher.card.id) ?? []) {
          const where: EvidenceRef = { kind: 'url', value: lead.docUrl! };
          if (lead.kind === 'shared_attribute') {
            const attributes = owner.card.attributes;
            if (lead.attribute === 'email' && !features.email && (attributes.emails ?? []).some((value) => fold(value) === fold(lead.value))) {
              supports('operator.same_email', ties.same_email, `Publikacja konta ${label(publisher)} podaje e-mail konta ${label(owner)}: ${lead.value}.`, ['Skrzynka może być wspólna (firmowa, rodzinna) albo podana cudzo — e-mail nie wskazuje, kto faktycznie obsługuje konto.'], [{ kind: 'attribute', value: lead.value }, where], `email:${fold(lead.value)}`);
              leadPath ??= lead.path;
            } else if (lead.attribute === 'phone' && !features.phone && (attributes.phones ?? []).some((value) => digits(value) === digits(lead.value))) {
              supports('operator.same_phone', ties.same_phone, `Publikacja konta ${label(publisher)} podaje telefon konta ${label(owner)}: ${lead.value}.`, ['Numer może być wspólny (firma, rodzina) albo przejęty po poprzednim abonencie.'], [{ kind: 'attribute', value: lead.value }, where], `phone:${digits(lead.value)}`);
              leadPath ??= lead.path;
            } else if (lead.attribute === 'website' && !features.website && (attributes.urls ?? []).some((value) => fold(value).includes(fold(lead.value).replace(/^https?:\/\//, '')))) {
              supports('operator.same_website', ties.same_website, `Publikacja konta ${label(publisher)} podaje stronę WWW konta ${label(owner)}: ${lead.value}.`, ['Strona może należeć do firmy, sklepu albo społeczności, do której odsyła wiele osób.'], [{ kind: 'attribute', value: lead.value }, where], `website:${fold(lead.value)}`);
              leadPath ??= lead.path;
            }
          } else if (lead.kind === 'linked_address' && lead.link && lead.fromAddress && owner.card.addresses.some((key) => addressOf(key) === lead.fromAddress)) {
            supports(
              'operator.linked_addresses',
              OPERATOR_RULES.linkedAddress[lead.link.kind],
              `Powiązanie adresów w blockchainie: adres ${shortAddress(lead.fromAddress)} konta ${label(owner)} — ${linkKindText(lead.link.kind)} ${shortAddress(lead.value)}, publikowany przez konto ${label(publisher)}.`,
              ['Powiązanie adresów wynika z heurystyki na danych blockchain; wspólny adres wpłat lub przelewy zdarzają się także między różnymi osobami (pośrednik, kontrahent).'],
              [{ kind: 'address', value: lead.fromAddress }, { kind: 'address', value: lead.value }, ...lead.link.txids.slice(0, 5).map((txid) => ({ kind: 'txid' as const, value: txid })), where],
              `chain:${lead.fromAddress}:${lead.value}`,
              'dane blockchain',
            );
            leadPath ??= lead.path;
          }
        }
      }

      const supportCount = drafts.length;
      if (supportCount === 0 && !decision) continue;
      const supportWeight = Math.max(tie.weight, ...drafts.map((draft) => draft.weight));

      // ---------- Kontrdowody ----------
      const namesDiffer = nameConflict(a, b);
      if (namesDiffer) {
        contradicts(
          'operator.conflict.declared_name',
          OPERATOR_RULES.conflict.declared_name,
          `Konta deklarują różne imiona i nazwiska: „${a.card.attributes.displayName?.trim()}” i „${b.card.attributes.displayName?.trim()}”.`,
          ['Różne deklarowane nazwiska nie wykluczają wspólnego operatora (pseudonim, osoba podstawiona, konto prowadzone za kogoś) — ale wykluczają automatyczne łączenie.'],
          [{ kind: 'attribute', value: a.card.attributes.displayName?.trim() ?? '' }, { kind: 'attribute', value: b.card.attributes.displayName?.trim() ?? '' }],
          decision?.decision !== 'confirmed',
        );
      }
      const [locationA, locationB] = [a.card.attributes.location, b.card.attributes.location];
      if (locationA && locationB && fold(locationA) !== fold(locationB)) {
        contradicts('operator.conflict.location', OPERATOR_RULES.conflict.location, `Konta podają różne lokalizacje: ${locationA} i ${locationB}.`, ['Lokalizację w profilu wpisuje się dowolnie i rzadko aktualizuje — to kontrdowód miękki.'], [{ kind: 'attribute', value: locationA }, { kind: 'attribute', value: locationB }]);
      }
      const clusterConflict = input.blockedPairs.get(id);
      if (clusterConflict && !namesDiffer && decision?.decision !== 'rejected') {
        contradicts('operator.conflict.cluster', 0, `Kont nie zaliczono do jednego kandydata na osobę: ${clusterConflict}.`, ['Sprzeczność dotyczy innych kont z tych samych grup — sama para może być powiązana.'], [], true, 'reguły łączenia profili');
      }
      for (const key of features.excludedAddresses ?? []) {
        contradicts(
          'operator.shared_or_institutional_address',
          0,
          `Oba konta publikują adres ${shortAddress(addressOf(key))}, ale jest to adres giełdy, kontraktu, zbiórki, miksera, instytucji albo adres podawany przez wiele niepowiązanych osób — NIE został policzony jako przesłanka wspólnego operatora.`,
          ['Z takiego adresu korzysta wiele niepowiązanych osób; jego publikacja niczego nie mówi o operatorze konta.'],
          [{ kind: 'address', value: addressOf(key) }],
          false,
          'dane blockchain i publiczne etykiety',
        );
      }
      const decisionRef: EvidenceRef[] = decision ? [{ kind: 'decision', value: decision.id }] : [];
      if (decision?.decision === 'rejected') {
        contradicts('operator.conflict.analyst_rejected', OPERATOR_RULES.conflict.analyst_rejected, `Analityk odrzucił hipotezę wspólnego operatora (${decision.author}, ${decision.decidedAt.slice(0, 10)})${decision.note ? `: „${decision.note}”` : ''}.`, ['Decyzję można wycofać — wynik wraca wtedy do stanu automatycznego.'], decisionRef, true, 'decyzja analityka');
      }
      const bothProfilesConfirmed = input.profileDecisions.get(a.card.id) === 'confirmed' && input.profileDecisions.get(b.card.id) === 'confirmed';
      const isConfirmed = decision?.decision === 'confirmed' || (bothProfilesConfirmed && decision?.decision !== 'rejected');
      if (isConfirmed) {
        supports(
          'operator.analyst_confirmed',
          100,
          decision ? `Analityk potwierdził wspólnego operatora (${decision.author}, ${decision.decidedAt.slice(0, 10)})${decision.note ? `: „${decision.note}”` : ''}.` : 'Analityk potwierdził oba profile jako profile osoby głównej.',
          ['Potwierdzenie jest ustaleniem analityka na podstawie materiału sprawy, nie dowodem kryptograficznym.'],
          decisionRef,
          'decision',
          'decyzja analityka',
        );
      }

      const blocking = drafts.some((draft) => draft.direction === 'contradicts' && draft.blocking);
      const sameCandidate = input.personOfProfile.get(a.card.id) !== undefined && input.personOfProfile.get(a.card.id) === input.personOfProfile.get(b.card.id);
      const status: HypothesisStatus =
        decision?.decision === 'rejected' ? 'rejected' : isConfirmed ? 'confirmed' : blocking && supportWeight >= PERSON_RULES.joinThreshold ? 'blocked' : sameCandidate ? 'auto_grouped' : 'hypothesis';
      const combined = combineComponents('common_operator', drafts, { confirmed: status === 'confirmed', limitations: HYPOTHESIS_LIMITATIONS });
      // Hipoteza odrzucona przez analityka ma wskaźnik 0 bez względu na przesłanki — te zostają widoczne w składnikach.
      const indicator = status === 'rejected' ? { ...combined, score: 0, level: indicatorLevel(0) } : combined;

      const pairText = `kont ${label(a)} i ${label(b)}`;
      const blockReason = drafts.find((draft) => draft.direction === 'contradicts' && draft.blocking)?.explanation;
      const statement =
        status === 'confirmed'
          ? `Wspólny operator ${pairText} przyjęty decyzją analityka — to ustalenie analityka, nie automatyczne ustalenie tożsamości.`
          : status === 'rejected'
            ? `Hipoteza wspólnego operatora ${pairText} odrzucona decyzją analityka — konta są traktowane osobno.`
            : `${NOT_IDENTITY} Dotyczy ${pairText}: wskaźnik ${indicator.score}/100 (${indicator.level}).` +
              (status === 'auto_grouped' ? ' Narzędzie zaliczyło oba konta do jednego kandydata na osobę; to nadal wnioskowanie do weryfikacji przez analityka.' : '') +
              (status === 'blocked' ? ` Mimo mocnych przesłanek kont nie połączono: ${blockReason ?? 'kontrdowód twardy'}` : '');

      // Ścieżka: skąd narzędzie zna drugie konto i co łączy oba.
      const [first, second] = a.step <= b.step ? [a, b] : [b, a];
      const found = second.step > 0 ? ` — znalezione w kroku ${second.step} po identyfikatorze „${second.matchedIdentifier.value}”` : '';
      const fullPath = path.length === 0 && leadPath ? leadPath : [`konto ${label(first)} (${first.card.url})`, ...path.slice(0, 4), `konto ${label(second)} (${second.card.url})${found}`];

      hypotheses.push({
        id,
        accounts: [a.card.id, b.card.id],
        accountLabels: [`${a.card.handle ?? a.card.url} (${a.card.service})`, `${b.card.handle ?? b.card.url} (${b.card.service})`],
        personas: [persona(a), persona(b)],
        indicator,
        status,
        statement,
        path: fullPath,
        ...(decision ? { decision: { decision: decision.decision, decidedAt: decision.decidedAt, author: decision.author, ...(decision.note ? { note: decision.note } : {}), id: decision.id } } : {}),
      });
    }
  }

  hypotheses.sort((x, y) => y.indicator.score - x.indicator.score || x.id.localeCompare(y.id));
  // Limit dotyczy hipotez automatycznych; rozstrzygnięte przez analityka zostają zawsze (do wglądu i wycofania).
  let automatic = 0;
  return hypotheses.filter((item) => item.decision !== undefined || automatic++ < OPERATOR_RULES.maxHypotheses);
}

// ---------- A. Konto → portfel ----------

export interface AccountWalletInput {
  /** Konta jak w `OperatorInput.accounts`; najpierw profile podmiotu. */
  accounts: ProfileNode[];
  /** Adresy zapisanej analizy, z pełnym zestawem śladów (przed korektami teczki). */
  findings: Finding[];
  rules: ScoreRules;
  /** Obowiązująca decyzja analityka o adresie (`network:address` albo sam adres). */
  addressDecisionOf?: (finding: Finding) => DecisionRecord | undefined;
}

const INDEPENDENCE_OF_RULE = (rule: string, independentSources: number): Independence =>
  rule.startsWith('base.') ? (independentSources > 1 ? 'independent' : 'single') : rule.startsWith('synergy.') ? 'independent' : rule === 'independence.copies_merged' ? 'dependent' : 'not_applicable';

/** Wskaźnik A: na ile dane KONTO deklaruje związek z adresem — bez oceny, czyje to konto. */
export function buildAccountWalletLinks(input: AccountWalletInput): AccountWalletLink[] {
  const links: AccountWalletLink[] = [];
  const findingOf = new Map(input.findings.map((finding) => [addressKey(finding), finding]));
  for (const node of input.accounts) {
    const docs = new Set(node.sightings.map(sightingKey));
    for (const key of node.card.addresses) {
      const finding = findingOf.get(key);
      const own = (finding?.evidence ?? []).filter((item) => docs.has(sightingKey(item)));
      if (!finding || own.length === 0) continue;
      const addressClass = finding.chain?.profile.addressClass ?? 'unknown';
      // Pytanie brzmi „czy KONTO deklaruje adres”, nie „czyje to konto” — stąd brak korekty tożsamości.
      const result = computeConfidence({ evidence: own.map((item) => ({ ...item, identityMatch: 'exact_identifier' as const })), addressClass, unrelatedPublishers: finding.unrelatedPublishers }, input.rules);
      const serviceOf = new Map(own.map((item) => [item.id, item.service]));
      const components: ScoreComponent[] = result.ledger.map((entry) => {
        const weight = entry.weight ?? entry.delta;
        const refs: EvidenceRef[] = [
          ...[...new Set(entry.sources ?? [])].map((value) => ({ kind: 'url' as const, value })),
          ...entry.evidenceIds.map((value) => ({ kind: 'evidence_id' as const, value })),
          { kind: 'address', value: finding.address },
        ];
        return {
          rule: `wallet.${entry.rule}`,
          weight,
          applied: entry.delta,
          direction: weight < 0 || entry.rule.startsWith('exclusion.') ? 'contradicts' : 'supports',
          source: [...new Set(entry.evidenceIds.map((evidenceId) => serviceOf.get(evidenceId)).filter((value): value is string => value !== undefined))].join(' + ') || node.card.service,
          evidence: refs,
          explanation: entry.explanation,
          independence: INDEPENDENCE_OF_RULE(entry.rule, result.independentSources ?? 1),
          ...(entry.independence ? { independenceNote: entry.independence } : {}),
          limitations: entry.limitations ?? [],
          ...(entry.rule.startsWith('exclusion.') ? { blocking: true } : {}),
        };
      });
      let score = result.score;
      const limitations = ['Wskaźnik dotyczy deklaracji konta, nie tego, kto konto obsługuje ani kto dysponuje kluczem prywatnym adresu.'];
      const notPrivateWallet = result.excluded;
      if (notPrivateWallet) limitations.push('Adres usługi, kontraktu, zbiórki, miksera lub instytucji: publikacja odnotowana, ale to NIE jest portfel prywatny konta.');
      const declares = own.some((item) => OWNERSHIP_CATEGORIES.includes(item.category));
      if (!declares && !notPrivateWallet) {
        const applied = -Math.min(score, OPERATOR_RULES.mentionPenalty);
        score += applied;
        components.push({
          rule: 'wallet.mention_only',
          weight: -OPERATOR_RULES.mentionPenalty,
          applied,
          direction: 'contradicts',
          source: node.card.service,
          evidence: [...own.map((item) => ({ kind: 'url' as const, value: item.url })), { kind: 'address', value: finding.address }],
          explanation: 'Konto wymienia adres w wypowiedzi lub komentarzu, ale nie podaje go jako własnego (profil, oferta, rozliczenie, dowód kryptograficzny).',
          independence: 'not_applicable',
          limitations: ['wzmianka, nie deklaracja własności'],
        });
        limitations.push('wzmianka, nie deklaracja własności');
      }
      const decision = input.addressDecisionOf?.(finding);
      let status: ClaimStatus = 'computed';
      if (decision) {
        status = decision.decision;
        const rejected = decision.decision === 'rejected';
        const applied = rejected ? -score : 0;
        score += applied;
        components.push({
          rule: rejected ? 'wallet.decision.address_rejected' : 'wallet.decision.address_confirmed',
          weight: rejected ? -100 : 0,
          applied,
          direction: rejected ? 'contradicts' : 'supports',
          source: 'decyzja analityka',
          evidence: [{ kind: 'decision', value: decision.id }, { kind: 'address', value: finding.address }],
          explanation: rejected
            ? `Adres odrzucony przez analityka (${decision.author}, ${decision.decidedAt.slice(0, 10)})${decision.note ? `: „${decision.note}”` : ''}.`
            : `Adres potwierdzony przez analityka jako adres podmiotu (${decision.author}, ${decision.decidedAt.slice(0, 10)})${decision.note ? `: „${decision.note}”` : ''} — wskaźnik deklaracji konta pozostaje bez zmian.`,
          independence: 'not_applicable',
          limitations: ['Decyzja dotyczy adresu w sprawie; można ją wycofać.'],
          ...(rejected ? { blocking: true } : {}),
        });
      }
      links.push({
        id: `${node.card.id}=>${key}`,
        accountId: node.card.id,
        service: node.card.service,
        ...(node.card.handle ? { handle: node.card.handle } : {}),
        accountUrl: node.card.url,
        address: finding.address,
        network: finding.network,
        addressClass,
        notPrivateWallet,
        indicator: { kind: 'account_wallet', score, level: indicatorLevel(score), calibrated: false, scale: INDICATOR_SCALE, components, limitations },
        status,
      });
    }
  }
  // Kolejność kont (profile podmiotu pierwsze) jest zachowana przy równych wynikach.
  const order = new Map(input.accounts.map((node, index) => [node.card.id, index]));
  return links
    .sort((x, y) => order.get(x.accountId)! - order.get(y.accountId)! || y.indicator.score - x.indicator.score || x.id.localeCompare(y.id))
    .slice(0, OPERATOR_RULES.maxAccountWalletLinks);
}
