// Powiązane tożsamości: inne nazwiska i konta, które może obsługiwać ten sam operator
// albo ktoś bliski (zawsze hipoteza, dopóki analityk jej nie potwierdzi) — lokalne rozszerzenie kontraktu i czysta logika widoku.
import type { Decision, Finding, Identifier, ProfileCard } from '@olcys/core';

export type IdentityRelation = 'same_person_likely' | 'possibly_same_or_close' | 'associated';

export interface IdentityEvidence {
  kind: 'url' | 'txid' | 'attribute' | 'address' | 'evidence_id' | 'decision';
  value: string;
}

export type IdentityStatus = 'hypothesis' | 'confirmed' | 'rejected';

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
  /** Status powiązania; brak pola (starsza usługa) oznacza hipotezę. */
  status?: IdentityStatus;
  /** Konta tej tożsamości (`ProfileCard.id`, czyli `usługa|nazwa konta`). */
  accounts?: string[];
  /** Decyzje „confirmed”, które scalą tożsamość z osobą główną. */
  mergeWith: { target: 'profile' | 'address'; key: string }[];
}

export interface KnownFromCase {
  address: string;
  caseId: string;
  caseName: string;
}

export const RELATION_TEXT: Record<IdentityRelation, string> = {
  same_person_likely: 'hipoteza: możliwy wspólny operator — mocne przesłanki',
  possibly_same_or_close: 'hipoteza: możliwy wspólny operator albo osoba bliska',
  associated: 'tożsamość powiązana',
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

/**
 * Status powiązanej tożsamości. Bez jawnego statusu decyduje decyzja analityka, a gdy jej nie ma —
 * to zawsze hipoteza: sama siła przesłanek nigdy nie czyni powiązania ustaleniem.
 */
export function identityStatus(identity: Pick<LinkedIdentity, 'status' | 'decision'>): IdentityStatus {
  if (identity.status === 'confirmed' || identity.status === 'rejected' || identity.status === 'hypothesis') return identity.status;
  return identity.decision === 'confirmed' ? 'confirmed' : identity.decision === 'rejected' ? 'rejected' : 'hypothesis';
}

/**
 * Usługa i nazwa konta z identyfikatora tożsamości. Nowy format to `tozsamosc:<usługa|konto>`,
 * starszy — `tozsamosc:<nick>` (wtedy usługa jest nieznana).
 */
export function parseIdentityId(id: string): { service?: string; handle: string } {
  const key = id.startsWith('tozsamosc:') ? id.slice('tozsamosc:'.length) : id;
  const cut = key.indexOf('|');
  return cut < 0 ? { handle: key } : { service: key.slice(0, cut), handle: key.slice(cut + 1) };
}

/** Konta tożsamości do pokazania: jawne `accounts`, a gdy ich brak — profile albo konto z identyfikatora. */
export function identityAccounts(identity: Pick<LinkedIdentity, 'id' | 'accounts' | 'profiles'>): string[] {
  if (identity.accounts && identity.accounts.length > 0) return identity.accounts;
  if (identity.profiles.length > 0) return identity.profiles.map((profile) => profile.id);
  const parsed = parseIdentityId(identity.id);
  return parsed.service ? [`${parsed.service}|${parsed.handle}`] : [];
}

/** Tożsamość bez żadnego profilu to trop: znamy tylko adres. */
export const isAddressLead = (identity: LinkedIdentity) => identity.profiles.length === 0;

/** Tożsamości widoczne na liście: od najmocniejszej, odrzucone przez analityka na końcu. */
export function sortIdentities(identities: LinkedIdentity[]): LinkedIdentity[] {
  return [...identities].sort(
    (a, b) => Number(identityStatus(a) === 'rejected') - Number(identityStatus(b) === 'rejected') || b.score - a.score || a.id.localeCompare(b.id),
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
    .filter((identity) => identityStatus(identity) !== 'rejected' && !isAddressLead(identity))
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
