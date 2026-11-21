// Cykl życia sprawy: stany, przejścia i powiązania z innymi sprawami.
//
// Sprawy nie wolno usunąć, dopóki łączy się z inną OTWARTĄ sprawą — usunięcie zniszczyłoby materiał,
// na który powołuje się trwające postępowanie. Powiązania liczymy wprost z zapisanych danych:
//  - wspólny adres kryptowalutowy (wyniki analizy, identyfikatory wejściowe, adresy z odpowiedzi usług),
//  - bezpośredni przelew (adres jednej sprawy jest kontrahentem adresu drugiej),
//  - wspólny identyfikator wejściowy albo wspólny profil (konto w serwisie, adres profilu),
//  - ta sama odpowiedź usługi (usługa + sygnatura),
//  - osoba powiązana wskazująca inną sprawę (teczka, `relatedPersons[].caseId`),
//  - rozwinięcie sieci, które dotarło do bytu innej sprawy (w dowolnym kierunku).

import type { AnalysisRun } from '@olcys/core';
import type { RunIntel } from './intel.ts';
import type { ExpansionRecord } from './network/types.ts';
import type { ServiceReply } from './service-reply.ts';
import type { CaseStatus, CaseSummary, Storage } from './storage.ts';

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = { open: 'otwarta', closed: 'zamknięta', archived: 'zarchiwizowana' };

export type LinkKind = 'adres' | 'przelew' | 'identyfikator' | 'profil' | 'odpowiedz-uslugi' | 'osoba-powiazana' | 'rozwiniecie-sieci';

export const LINK_KIND_LABEL: Record<LinkKind, string> = {
  adres: 'wspólny adres kryptowalutowy',
  przelew: 'bezpośredni przelew między adresami spraw',
  identyfikator: 'wspólny identyfikator',
  profil: 'wspólny profil (konto w serwisie)',
  'odpowiedz-uslugi': 'ta sama odpowiedź usługi (sygnatura)',
  'osoba-powiazana': 'osoba powiązana wskazuje tę sprawę',
  'rozwiniecie-sieci': 'rozwinięcie sieci dotarło do bytu drugiej sprawy',
};

/** Dane sprawy potrzebne do wykrywania powiązań (zbiory kluczy w postaci kanonicznej). */
export interface CaseLinkData {
  caseId: string;
  caseName: string;
  status: CaseStatus;
  /** Adresy kryptowalutowe sprawy (bez sieci; adresy EVM małymi literami). */
  addresses: Set<string>;
  /** Kontrahenci adresów sprawy (z historii przelewów). */
  counterparties: Set<string>;
  /** Identyfikatory wejściowe `typ:wartość`. */
  identifiers: Set<string>;
  /** Profile: `serwis|autor` i adresy profili. */
  profiles: Set<string>;
  /** Odpowiedzi usług: `usługa|sygnatura`. */
  replyRefs: Set<string>;
  /** Byty dodane przez rozwinięcia sieci (klucze węzłów, adresy, adresy URL). */
  expansionKeys: Set<string>;
  /** Sprawy wskazane w teczce jako powiązane (osoby powiązane z `caseId`). */
  relatedCaseIds: Set<string>;
}

export interface CaseLinkReason {
  kind: LinkKind;
  label: string;
  /** Wartości, które łączą sprawy (do 5) — tylko do wglądu analityka, nie trafiają do audytu ani śladu usunięcia. */
  values: string[];
}

export interface CaseLink {
  caseId: string;
  caseName: string;
  status: CaseStatus;
  /** Powiązanie z otwartą sprawą blokuje usunięcie. */
  blocking: boolean;
  reasons: CaseLinkReason[];
}

/** Adres w postaci do porównań: adresy EVM (0x…) bez rozróżniania wielkości liter. */
export const addressKeyOf = (address: string): string => {
  const text = address.trim();
  return /^0x[0-9a-f]{40}$/i.test(text) ? text.toLowerCase() : text;
};

const identifierKeyOf = (type: string, value: string) => `${type}:${value.trim().replace(/^@/, '').toLowerCase()}`;
const urlKeyOf = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** Zbiera dane sprawy do porównań. `relatedCaseIds` podaje wywołujący (z teczki), bo jej złożenie kosztuje. */
export function linkDataOf(input: {
  summary: CaseSummary;
  run?: AnalysisRun | null;
  intel?: RunIntel | null;
  replies?: ServiceReply[];
  expansions?: ExpansionRecord[];
  relatedCaseIds?: Iterable<string>;
}): CaseLinkData {
  const { summary, run, intel } = input;
  const addresses = new Set<string>();
  const counterparties = new Set<string>();
  const identifiers = new Set<string>();
  const profiles = new Set<string>();
  const replyRefs = new Set<string>();
  const expansionKeys = new Set<string>();

  for (const identifier of summary.query.identifiers) {
    identifiers.add(identifierKeyOf(identifier.type, identifier.value));
    if (identifier.type === 'crypto_address') addresses.add(addressKeyOf(identifier.value));
    if (identifier.type === 'profile_url') profiles.add(urlKeyOf(identifier.value));
  }
  for (const finding of run?.findings ?? []) {
    if (finding.confidence.excluded) continue;
    addresses.add(addressKeyOf(finding.address));
    for (const transfer of finding.chain?.transfers ?? []) {
      if (transfer.counterparty) counterparties.add(addressKeyOf(transfer.counterparty));
    }
  }
  for (const sighting of intel?.sightings ?? []) {
    // Tylko dokumenty przypisane podmiotowi — cudze publikacje tego samego adresu to wzmianki, nie wspólny profil.
    if (sighting.role !== 'subject') continue;
    if (sighting.author) profiles.add(`${sighting.service.toLowerCase()}|${sighting.author.trim().replace(/^@/, '').toLowerCase()}`);
  }
  for (const step of intel?.trail ?? []) {
    if (step.identifier.type === 'crypto_address') addresses.add(addressKeyOf(step.identifier.value));
    else identifiers.add(identifierKeyOf(step.identifier.type, step.identifier.value));
  }
  for (const reply of input.replies ?? []) {
    if (reply.withdrawnAt) continue;
    replyRefs.add(`${reply.serviceId.toLowerCase()}|${reply.reference.trim().toLowerCase()}`);
    for (const match of reply.payload.matches ?? []) {
      if (match.depositAddress) addresses.add(addressKeyOf(match.depositAddress));
    }
  }
  for (const expansion of input.expansions ?? []) {
    if (expansion.withdrawnAt) continue;
    for (const node of expansion.results.nodes) {
      if (node.known) continue;
      expansionKeys.add(node.id.toLowerCase());
      const address = /^addr:[^:]+:(.+)$/.exec(node.id)?.[1];
      if (address) expansionKeys.add(`adres:${addressKeyOf(address)}`);
      if (node.url) expansionKeys.add(`url:${urlKeyOf(node.url)}`);
    }
  }
  return {
    caseId: summary.id,
    caseName: summary.name,
    status: summary.status ?? 'open',
    addresses,
    counterparties,
    identifiers,
    profiles,
    replyRefs,
    expansionKeys,
    relatedCaseIds: new Set(input.relatedCaseIds ?? []),
  };
}

const common = (left: Set<string>, right: Set<string>): string[] => [...left].filter((value) => right.has(value));

/** Klucze bytów sprawy w postaci kluczy węzłów sieci — do porównania z rozwinięciami drugiej sprawy. */
function entityKeysOf(data: CaseLinkData): Map<string, string> {
  const keys = new Map<string, string>();
  for (const address of data.addresses) keys.set(`adres:${address}`, address);
  for (const identifier of data.identifiers) {
    const [type, ...rest] = identifier.split(':');
    keys.set(`id:${type}:${rest.join(':')}`, rest.join(':'));
  }
  for (const profile of data.profiles) {
    if (profile.includes('|')) keys.set(`profile:${profile}`, profile);
    else keys.set(`url:${profile}`, profile);
  }
  return keys;
}

/** Powiązania sprawy `target` z pozostałymi sprawami; `blocking` = druga sprawa jest otwarta. */
export function findCaseLinks(target: CaseLinkData, others: CaseLinkData[]): CaseLink[] {
  const links: CaseLink[] = [];
  const targetEntities = entityKeysOf(target);
  for (const other of others) {
    if (other.caseId === target.caseId) continue;
    const reasons: CaseLinkReason[] = [];
    const add = (kind: LinkKind, values: string[]) => {
      const unique = [...new Set(values)];
      if (unique.length > 0) reasons.push({ kind, label: LINK_KIND_LABEL[kind], values: unique.slice(0, 5) });
    };
    add('adres', common(target.addresses, other.addresses));
    add('przelew', [...common(target.addresses, other.counterparties), ...common(target.counterparties, other.addresses)]);
    add('identyfikator', common(target.identifiers, other.identifiers).filter((key) => !key.startsWith('crypto_address:')));
    add('profil', common(target.profiles, other.profiles));
    add('odpowiedz-uslugi', common(target.replyRefs, other.replyRefs));
    add('osoba-powiazana', [
      ...(target.relatedCaseIds.has(other.caseId) ? [`teczka sprawy „${target.caseName}”`] : []),
      ...(other.relatedCaseIds.has(target.caseId) ? [`teczka sprawy „${other.caseName}”`] : []),
    ]);
    const otherEntities = entityKeysOf(other);
    add('rozwiniecie-sieci', [
      ...[...target.expansionKeys].filter((key) => otherEntities.has(key)).map((key) => otherEntities.get(key)!),
      ...[...other.expansionKeys].filter((key) => targetEntities.has(key)).map((key) => targetEntities.get(key)!),
    ]);
    if (reasons.length > 0) links.push({ caseId: other.caseId, caseName: other.caseName, status: other.status, blocking: other.status === 'open', reasons });
  }
  return links.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.caseName.localeCompare(b.caseName, 'pl'));
}

/**
 * Dane wszystkich spraw z bazy (ostatnia zakończona analiza, profile, odpowiedzi usług, rozwinięcia).
 * `relatedFor` (osoby powiązane z teczki) jest liczone tylko dla spraw z `withRelated` — złożenie teczki kosztuje.
 */
export async function collectLinkData(
  storage: Storage,
  options: { relatedFor?: (summary: CaseSummary, run: AnalysisRun) => Promise<string[]>; withRelated?: Set<string> } = {},
): Promise<CaseLinkData[]> {
  const cases = await storage.listCases();
  const result: CaseLinkData[] = [];
  for (const summary of cases) {
    const last = summary.runs.filter((run) => run.status === 'completed').at(-1);
    const [run, intel, replies, expansions] = await Promise.all([
      last ? storage.getRun(last.id) : null,
      last ? storage.getRunIntel(last.id) : null,
      storage.listServiceReplies(summary.id),
      storage.listNetworkExpansions(summary.id),
    ]);
    const wanted = options.relatedFor && run && (!options.withRelated || options.withRelated.has(summary.id));
    const related = wanted ? await options.relatedFor!(summary, run!).catch(() => []) : [];
    result.push(linkDataOf({ summary, run, intel, replies, expansions, relatedCaseIds: related }));
  }
  return result;
}

/** Komunikat 409 dla sprawy powiązanej z otwartymi sprawami. */
export function linkedMessage(links: CaseLink[]): string {
  const blocking = links.filter((link) => link.blocking);
  return `Nie można usunąć — sprawa jest powiązana z: ${blocking.map((link) => `„${link.caseName}” (${link.reasons.map((reason) => reason.label).join(', ')})`).join('; ')}. Zamknij lub rozstrzygnij powiązane sprawy, zanim usuniesz tę.`;
}
