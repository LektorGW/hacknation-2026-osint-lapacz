// Powiązane tożsamości: inne nazwiska i konta, które mogą należeć do tej samej osoby
// albo kogoś bliskiego — lokalne rozszerzenie kontraktu i czysta logika widoku.
import type { Decision, Finding, Identifier, ProfileCard } from '@olcys/core';

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
  /** `published`, `shared_with_subject` albo `linked:<rodzaj>`. */
  addresses: { address: string; network: string; basis: string }[];
  cashOutPlnByYear: Record<string, number>;
  cashOutProof: { id: string; address: string; serviceName: string; amount: number; asset: string; valuePln?: number; trailConfidence: number; hops: number; statement: string }[];
  /** Ścieżka dojścia krok po kroku, od podmiotu do tożsamości. */
  path: string[];
  note: string;
  decision?: Decision;
  /** Decyzje „confirmed”, które scalą tożsamość z osobą główną. */
  mergeWith: { target: 'profile' | 'address'; key: string }[];
}

export interface KnownFromCase {
  address: string;
  caseId: string;
  caseName: string;
}

export const RELATION_TEXT: Record<IdentityRelation, string> = {
  same_person_likely: 'prawdopodobnie ta sama osoba',
  possibly_same_or_close: 'możliwe, że ta sama osoba albo ktoś bliski',
  associated: 'osoba powiązana',
};

/** Poziom kolorystyczny relacji — spójny z poziomami pewności w całym interfejsie. */
export const RELATION_LEVEL: Record<IdentityRelation, 'high' | 'likely' | 'low'> = {
  same_person_likely: 'high',
  possibly_same_or_close: 'likely',
  associated: 'low',
};

const BASIS_TEXT: Record<string, string> = {
  published: 'opublikowany jako własny',
  shared_with_subject: 'ten sam adres co u podmiotu',
  transfer: 'bezpośredni przelew',
  shared_deposit: 'wspólny adres wpłat giełdy',
  common_counterparty: 'wspólny kontrahent',
  cluster: 'ten sam portfel',
};

/** Podstawa przypisania adresu tożsamości słownie; nieznany rodzaj pokazujemy bez zmian. */
export function basisText(basis: string): string {
  const kind = basis.startsWith('linked:') ? basis.slice('linked:'.length) : basis;
  const text = BASIS_TEXT[kind] ?? kind;
  return basis.startsWith('linked:') ? `wskazany przez dane blockchain: ${text}` : text;
}

/** Tożsamość bez żadnego profilu to trop: znamy tylko adres. */
export const isAddressLead = (identity: LinkedIdentity) => identity.profiles.length === 0;

/** Tożsamości widoczne na liście: od najmocniejszej, odrzucone przez analityka na końcu. */
export function sortIdentities(identities: LinkedIdentity[]): LinkedIdentity[] {
  return [...identities].sort(
    (a, b) => Number(a.decision === 'rejected') - Number(b.decision === 'rejected') || b.score - a.score || a.id.localeCompare(b.id),
  );
}

/** Identyfikatory do założenia osobnej sprawy: nicki, imię i nazwisko, adresy profili. */
export function identityIdentifiers(identity: LinkedIdentity): Identifier[] {
  const result: Identifier[] = [];
  const add = (identifier: Identifier) => {
    if (identifier.value && !result.some((item) => item.type === identifier.type && item.value === identifier.value)) result.push(identifier);
  };
  if (identity.fullName) add({ type: 'full_name', value: identity.fullName });
  for (const handle of identity.handles) add({ type: 'nick', value: handle });
  for (const profile of identity.profiles) add({ type: 'profile_url', value: profile.url });
  if (result.length === 0) for (const item of identity.addresses) add({ type: 'crypto_address', value: item.address });
  return result;
}

/** Skrót do karty ustalenia: najmocniejsze nieodrzucone tożsamości z profilem. */
export function identityHeadline(identities: LinkedIdentity[], limit = 2): string[] {
  return sortIdentities(identities)
    .filter((identity) => identity.decision !== 'rejected' && !isAddressLead(identity))
    .slice(0, limit)
    .map((identity) => `${identity.displayName} — ${RELATION_TEXT[identity.relation]} (${identity.score})`);
}

/** Suma „łącznie z tożsamościami prawdopodobnie tymi samymi”, jeśli różni się od sumy osoby głównej. */
export function likelySameTotal(totals: { cashOutPlnTotal?: number; cashOutPlnTotalWithLikelySame?: number; cashOutPlnByYear: Record<string, number> }): number | undefined {
  const own = totals.cashOutPlnTotal ?? Object.values(totals.cashOutPlnByYear).reduce((sum, value) => sum + value, 0);
  const combined = totals.cashOutPlnTotalWithLikelySame;
  return combined !== undefined && Math.round(combined) !== Math.round(own) ? combined : undefined;
}

/** Adres eksploratora dla identyfikatora transakcji — tylko gdy ta transakcja jest w danych teczki. */
export function explorerForTxid(findings: Finding[], txid: string): string | undefined {
  for (const finding of findings) {
    const transfer = finding.chain?.transfers.find((item) => item.txid === txid);
    if (transfer) return transfer.explorerUrl;
  }
  return undefined;
}

/** Krótki opis krawędzi na mapie i w grafie: rodzaj najmocniejszego dowodu. */
export function linkLabel(identity: LinkedIdentity): string {
  const text = identity.reasons[0]?.text ?? RELATION_TEXT[identity.relation];
  return text.length > 44 ? `${text.slice(0, 43)}…` : text;
}
