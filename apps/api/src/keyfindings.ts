// Kluczowe ustalenia: 3–7 zdań zrozumiałych dla laika, układanych REGUŁAMI z danych
// teczki (bez modelu językowego). Kolejność odpowiada wadze dla analityka:
// kto to jest → z jakimi giełdami jest powiązany → jakie adresy i kwoty → zastrzeżenia.

import type { Dossier, Finding, PersonCandidate, ProfileCard, RelatedPerson, ServiceLink, SourceCategory } from '@olcys/core';
import type { AddressReplacement } from './diff.ts';
import { formatAmount, formatDate, plural, roundPln, shortAddress } from './format.ts';
import { identityRelationLabel } from './aliases.ts';
import type { LinkedIdentity } from './aliases.ts';
import type { Explanation, UnconfirmedAddress } from './explain.ts';
import type { MentionSummary } from './intel.ts';
import type { CashOutProof } from './proof.ts';
import { fundingSentence, isIncidentSource, seizureSentence } from './provenance.ts';
import type { FundingSourceView, SeizureView } from './provenance.ts';
import { describeServiceLink, isCashOutService } from './services.ts';

type KeyFinding = Dossier['keyFindings'][number];

export interface KeyFindingsInput {
  /** Sprawa dotyczy samego adresu (bez identyfikatorów osoby). */
  addressOnly?: boolean;
  /** Badany adres jest powszechnie cytowany. */
  widelyCited?: boolean;
  /** Wyjaśnienia braku wyniku — najważniejsze otwiera listę ustaleń. */
  explanations?: Explanation[];
  /** Adresy do potwierdzenia przez analityka. */
  unconfirmed?: UnconfirmedAddress[];
  /** Zajęcia środków i pochodzenie środków z publicznych etykiet. */
  seizures?: SeizureView[];
  fundingSources?: FundingSourceView[];
  /** Powiązane tożsamości — najmocniejsza trafia do ustaleń. */
  linkedIdentities?: LinkedIdentity[];
  /** Wzmianki o identyfikatorach podmiotu u innych autorów. */
  mentions: MentionSummary[];
  /** Dowód spieniężenia — gdy jest, jego zdania idą zaraz po ustaleniu osoby. */
  proofs: CashOutProof[];
  persons: PersonCandidate[];
  profiles: ProfileCard[];
  serviceLinks: ServiceLink[];
  findings: Finding[];
  linked: Finding[];
  cashOutPlnByYear: Record<string, number>;
  replacements: AddressReplacement[];
  relatedPersons: RelatedPerson[];
  priority: number;
  connectorCount: number;
}

const MAX_FINDINGS = 7;
const MIN_FINDINGS = 3;

const PLACE: Record<SourceCategory, string> = {
  cryptographic_proof: 'w zapisie potwierdzonym kryptograficznie w serwisie',
  own_profile: 'na własnym profilu w serwisie',
  sale_offer: 'w ogłoszeniu w serwisie',
  settlement_message: 'w wiadomości rozliczeniowej w serwisie',
  forum_post: 'we wpisie na forum',
  mass_comment: 'w masowym komentarzu w serwisie',
};

const list = (items: string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} i ${items.at(-1)}`);

function personSentences(input: KeyFindingsInput): KeyFinding[] {
  const [main, ...others] = input.persons;
  if (!main || main.probability === 0) return [];
  const profiles = input.profiles.filter((profile) => main.profileIds.includes(profile.id));
  const services = [...new Set(profiles.map((profile) => profile.service))];
  // Pierwsza przesłanka to podstawa oceny; bez prefiksu punktowego czyta się ją jak zdanie.
  const basis = (main.reasons[0] ?? '').replace(/^Podstawa \d+: /, '').replace(/\.$/, '');
  const who = main.fullName
    ? `Najbardziej prawdopodobna osoba: ${main.fullName}`
    : `Najbardziej prawdopodobna osoba posługuje się nazwą „${profiles.find((profile) => profile.handle)?.handle ?? '—'}” (imienia i nazwiska źródła nie ujawniają)`;
  const result: KeyFinding[] = [
    {
      text: `${who} — prawdopodobieństwo ${main.probability}%; ${profiles.length} ${plural(profiles.length, 'profil', 'profile', 'profili')} w: ${list(services)}. Podstawa: ${basis}.`,
      layer: 'inference',
    },
  ];
  const foreign = others.filter((person) => person.probability > 0);
  if (foreign.length > 0) {
    const names = input.profiles
      .filter((profile) => foreign.some((person) => person.profileIds.includes(profile.id)))
      .map((profile) => `${profile.handle ?? profile.url} w ${profile.service}`);
    result.push({
      text: `Część śladów (${plural(names.length, 'profil', 'profile', 'profile')}: ${list(names.slice(0, 3))}) należy prawdopodobnie do innej osoby — brak wiązania z osobą główną, dlatego nie wliczono ich do jej wyniku.`,
      layer: 'inference',
    });
  }
  return result;
}

function serviceSentences(links: ServiceLink[]): KeyFinding[] {
  const layerOf = (link: ServiceLink): KeyFinding['layer'] =>
    link.inferredOnly ? 'inference' : link.outPln !== undefined || link.inPln !== undefined ? 'calculation' : 'fact';
  const cashOut = links.filter((link) => isCashOutService(link.kind));
  const shown = cashOut.slice(0, 2);
  const result = shown.map((link) => ({ text: describeServiceLink(link), layer: layerOf(link) }));
  if (cashOut.length > shown.length) {
    result.push({
      text: `Pozostałe usługi wypłat powiązane z podmiotem: ${list(cashOut.slice(2).map((link) => link.name))}.`,
      layer: 'calculation',
    });
  }
  const wallets = links.filter((link) => link.kind === 'wallet');
  if (wallets.length > 0) {
    result.push({ text: `Podmiot wymienia w publicznych treściach portfele: ${list(wallets.map((link) => link.name))} — informacja o sposobie przechowywania środków.`, layer: 'fact' });
  }
  return result;
}

/** Zdania o dowodzie spieniężenia: wiele ścieżek z jednego adresu do jednej usługi to jedno zdanie. */
function proofFindings(proofs: CashOutProof[]): KeyFinding[] {
  const groups = new Map<string, CashOutProof[]>();
  for (const proof of proofs) {
    const key = `${proof.address}|${proof.serviceName}`;
    groups.set(key, [...(groups.get(key) ?? []), proof]);
  }
  return [...groups.values()].slice(0, 2).map((group) => {
    const [best] = group;
    if (group.length === 1) return { text: best!.statement, layer: best!.layer };
    const assets = new Set(group.map((proof) => proof.trail.asset));
    const amount = assets.size === 1 ? ` łącznie ${formatAmount(group.reduce((sum, proof) => sum + proof.trail.amount, 0))} ${best!.trail.asset}` : '';
    const valued = group.filter((proof) => proof.trail.valuePln !== undefined);
    const value = valued.length > 0 ? ` (ok. ${roundPln(valued.reduce((sum, proof) => sum + proof.trail.valuePln!, 0))})` : '';
    const lowest = Math.min(...group.map((proof) => proof.combinedConfidence));
    return {
      text:
        `Udokumentowano ${group.length} ${plural(group.length, 'przekazanie', 'przekazania', 'przekazań')}${amount}${value} z adresu ${shortAddress(best!.address)} do usługi ${best!.serviceName} — ` +
        `łączna pewność ustalenia ${lowest === best!.combinedConfidence ? `${lowest}%` : `od ${lowest}% do ${best!.combinedConfidence}%`}.`,
      layer: group.some((proof) => proof.layer === 'inference') ? ('inference' as const) : ('calculation' as const),
    };
  });
}

function addressSentence(best: (Finding & { subjectProbability?: number }) | undefined): KeyFinding[] {
  if (!best || best.evidence.length === 0) return [];
  const places = [...new Set(best.evidence.map((item) => `${PLACE[item.category]} ${item.service}`))];
  return [
    {
      text:
        `Adres ${shortAddress(best.address)} opublikowano ${list(places.slice(0, 3))} (Wskaźnik Pewności ${best.confidence.score}% — ${best.confidence.tier}` +
        `${best.subjectProbability === undefined ? '' : `; łączne prawdopodobieństwo, że adres należy do osoby ze sprawy: ${best.subjectProbability}%`}).`,
      layer: 'calculation',
    },
  ];
}

export function buildKeyFindings(input: KeyFindingsInput): KeyFinding[] {
  const active = input.findings.filter((finding) => !finding.confidence.excluded);
  const best = [...active].sort((a, b) => b.confidence.score - a.confidence.score)[0];
  const proofSentences = proofFindings(input.proofs.filter((proof) => !proof.ownerUnconfirmed));
  // Brak adresu podmiotu albo zapytanie o nazwę serwisu: to analityk musi przeczytać najpierw.
  const opening = (input.explanations ?? []).filter((item) => item.kind === 'service_name' || item.kind === 'no_addresses' || item.kind === 'only_unconfirmed');
  const leadExplanations: KeyFinding[] = opening.slice(0, 2).map((item) => ({
    text: `${item.text} Co można zrobić: ${item.suggestions[0]}`,
    layer: item.kind === 'service_name' ? ('inference' as const) : ('fact' as const),
  }));
  // Najbliższy adres do potwierdzenia: co o nim wiadomo i co da potwierdzenie.
  const pendingAddress = input.unconfirmed?.[0];
  const pendingProof = pendingAddress ? input.proofs.find((proof) => proof.ownerUnconfirmed && proof.address === pendingAddress.address) : undefined;
  const pendingSentences: KeyFinding[] = pendingProof
    ? [{ text: pendingProof.statement, layer: 'inference' }]
    : pendingAddress
      ? [
          {
            text:
              `Znaleziono adres ${shortAddress(pendingAddress.address)}, którego nie potwierdzono jako należącego do podmiotu (prawdopodobieństwo ${pendingAddress.personAddressProbability}%)` +
              `${pendingAddress.chain ? `; w blockchainie ma ${pendingAddress.chain.transfers} ${plural(pendingAddress.chain.transfers, 'przelew', 'przelewy', 'przelewów')}` : ''}. ` +
              'Decyzja analityka „potwierdzony” dla profilu lub adresu przeliczy teczkę z tym adresem.',
            layer: 'inference',
          },
        ]
      : [];
  // Sprawa samego adresu bez ustalonego właściciela: najpierw jasna informacja, że publikacje go nie wskazują.
  const cites = input.addressOnly && input.persons.length === 0 ? input.mentions.filter((item) => item.identifier.type === 'crypto_address') : [];
  const addressLead: KeyFinding[] =
    cites.length > 0
      ? [
          {
            text:
              `Adres jest ${input.widelyCited ? 'powszechnie cytowany' : 'wymieniany w cudzych publikacjach'} ` +
              `(co najmniej ${Math.max(...cites.map((item) => item.authors))} ${plural(Math.max(...cites.map((item) => item.authors)), 'autor', 'autorów', 'autorów')} w ` +
              `${Math.max(...cites.map((item) => item.services))} ${plural(Math.max(...cites.map((item) => item.services)), 'serwisie', 'serwisach', 'serwisach')}) — ` +
              'nie da się wskazać właściciela na podstawie publikacji. Poniżej ustalenia z samego blockchaina.',
            layer: 'fact',
          },
        ]
      : [];
  // W sprawie samego adresu zdania o usługach mówią o adresie, nie o osobie.
  const services = serviceSentences(input.serviceLinks).map((item) =>
    input.addressOnly ? { ...item, text: item.text.replace(/^Podmiot jest powiązany/, 'Badany adres jest powiązany') } : item,
  );
  // Zajęcie przez organ państwa i pochodzenie środków z incydentu: fakty z publicznych etykiet adresów.
  const seized = input.seizures ?? [];
  const provenance: KeyFinding[] = [];
  if (seized[0]) {
    provenance.push({
      text: seizureSentence(seized[0]) + (seized.length > 1 ? ` Łącznie takich przelewów: ${seized.length}.` : ''),
      layer: 'fact',
    });
  }
  const origin = (input.fundingSources ?? []).find(isIncidentSource) ?? (input.fundingSources ?? []).find((item) => item.label !== undefined);
  if (origin) provenance.push({ text: fundingSentence(origin), layer: origin.hops > 1 ? 'inference' : 'fact' });
  const result: KeyFinding[] = [...leadExplanations, ...addressLead, ...personSentences(input), ...provenance, ...pendingSentences, ...proofSentences, ...services, ...addressSentence(best)];

  const identity = input.linkedIdentities?.[0];
  if (identity) {
    result.push({
      text:
        `Powiązana tożsamość: „${identity.displayName}” — ${identityRelationLabel(identity.relation)} (siła ${identity.score}/100). ${identity.reasons[0]!.text} ` +
        'To wskazówka do rozstrzygnięcia przez analityka: ta sama osoba, osoba bliska albo podstawiona.',
      layer: 'inference',
    });
  }

  const years = Object.entries(input.cashOutPlnByYear).sort(([a], [b]) => a.localeCompare(b));
  const total = years.reduce((sum, [, value]) => sum + value, 0);
  if (total > 0) {
    result.push({
      text:
        `Łączna szacunkowa wartość możliwych wypłat na waluty tradycyjne z ${input.linked.length} ${plural(input.linked.length, 'adresu powiązanego', 'adresów powiązanych', 'adresów powiązanych')}: ${roundPln(total)}` +
        (years.length > 1 ? ` (${years.map(([year, value]) => `${year}: ${roundPln(value)}`).join(', ')})` : ` w ${years[0]![0]} r.`) +
        ' — szacunek po kursie z dnia transakcji, nie ustalenie przychodu.',
      layer: 'calculation',
    });
  }

  for (const replacement of input.replacements.slice(0, 1)) {
    result.push({
      text: `Między ${formatDate(replacement.archivedAt)} a ${formatDate(replacement.observedAt)} adres w publikacji ${replacement.url} został podmieniony (${shortAddress(replacement.from)} → ${shortAddress(replacement.to)}).`,
      layer: 'fact',
    });
  }

  const strongest = best?.evidence.length ? best.confidence.ledger.find((entry) => entry.rule.startsWith('identity.')) : undefined;
  if (strongest && /same_handle|common_handle|name_only/.test(strongest.rule)) {
    result.push({
      text: 'Uwaga: powiązanie najlepszego adresu z podmiotem opiera się na samej zgodności nicku lub nazwiska — tożsamość profilu wymaga potwierdzenia drugim identyfikatorem.',
      layer: 'inference',
    });
  }

  if (input.relatedPersons.length > 0) {
    const top = input.relatedPersons[0]!;
    result.push({
      text: `Wskazano ${input.relatedPersons.length} ${plural(input.relatedPersons.length, 'osobę potencjalnie powiązaną', 'osoby potencjalnie powiązane', 'osób potencjalnie powiązanych')} (najsilniej: „${top.handle}”, siła ${top.strength}/100) — to wskazówka do weryfikacji, nie ustalenie.`,
      layer: 'inference',
    });
  }

  const cited = [...input.mentions].filter((item) => cites.length === 0 || item.identifier.type !== 'crypto_address').sort((a, b) => b.authors - a.authors)[0];
  if (cited) {
    result.push({
      text: `Identyfikator „${cited.identifier.value}” wymienia ${cited.atLeast ? 'co najmniej ' : ''}${cited.authors} innych autorów w ${cited.services} ${plural(cited.services, 'serwisie', 'serwisach', 'serwisach')} (${cited.documents} publikacji) — to wzmianki o podmiocie, a nie jego profile; nie przypisano ich podmiotowi.`,
      layer: 'fact',
    });
  }

  const excluded = input.findings.length - active.length;
  const fillers: KeyFinding[] = [
    {
      text:
        input.findings.length === 0
          ? `W ${input.connectorCount} przeszukanych źródłach nie znaleziono żadnego adresu kryptowalutowego powiązanego z podanymi identyfikatorami.`
          : `Znaleziono ${input.findings.length} ${plural(input.findings.length, 'adres', 'adresy', 'adresów')}, z czego ${input.linked.length} uznano za powiązane z podmiotem, a ${excluded} odrzucono (adresy pośredników lub decyzja analityka).`,
      layer: 'calculation',
    },
    { text: `Priorytet sprawy: ${input.priority}/100 (wynik obliczeń według jawnego wzoru).`, layer: 'calculation' },
    ...(total > 0
      ? []
      : [{ text: 'W pobranych transakcjach adresów powiązanych nie stwierdzono przelewów do giełd ani innych usług wypłat na waluty tradycyjne.', layer: 'fact' as const }]),
  ];
  const trimmed = result.slice(0, MAX_FINDINGS);
  // Uzupełnienie do minimum trzech zdań; priorytet dopisujemy zawsze, gdy jest miejsce.
  for (const filler of fillers) {
    if (trimmed.length < MIN_FINDINGS || (filler === fillers[1] && trimmed.length < MAX_FINDINGS)) trimmed.push(filler);
  }
  return trimmed;
}
