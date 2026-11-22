// Organizacje i siatka adresu: kształty zwracane przez usługę analizy (pola teczki `organizations`,
// `organizationNetwork`, `addressNetwork`) oraz czysta logika widoków.

export interface OrganizationComponent {
  rule: string;
  delta: number;
  explanation: string;
  sources?: string[];
}

export interface DossierOrganization {
  name: string;
  domain?: string;
  role: 'beneficjent zbiórki' | 'odbiorca płatności';
  addresses: string[];
  indicator: number;
  components: OrganizationComponent[];
  origins: number;
  evidence: { url: string; author?: string; service: string; quote: string }[];
  status: 'hypothesis' | 'confirmed';
  officialSite?: { url: string; publishesAddress: boolean; checkedAt: string; note: string };
  donationUrl?: string;
  statement: string;
  limitations: string[];
  registryId?: string;
}

export interface RegistrySource {
  registry: string;
  url: string;
  retrievedAt: string;
  terms: string;
}

export interface OrgEntity {
  id: string;
  name: string;
  match: 'identifier' | 'domain' | 'name_only' | 'related';
  matchNote: string;
  identifiers: Record<string, string | undefined>;
  seed: boolean;
  addresses: string[];
  sources: RegistrySource[];
  weakCandidates?: { registry: string; name: string; identifier: string; url: string; note: string }[];
}

export interface PersonInRole {
  id: string;
  name: string;
  masked: boolean;
  role: string;
  organizationId: string;
  from?: string;
  to?: string;
  source: RegistrySource;
  wikidata?: string;
  publishedIdentifiers?: { github?: string; x?: string; website?: string };
  publicProfiles?: { url: string; service: string; title: string }[];
  relation: string;
}

export interface OrganizationNetwork {
  organizations: OrgEntity[];
  persons: PersonInRole[];
  relations: { from: string; to: string; kind: string; label: string; status: string; source?: RegistrySource; explanation: string }[];
  personLinks: { a: string; b: string; kind: string; organizations: string[]; status: string; explanation: string }[];
  sources: RegistrySource[];
  stops: { stage: string; reason: string; detail: string; skipped?: number }[];
  notes: string[];
}

/** Druga cecha zgodna z danymi sprawy (konto w serwisie, domena oficjalnej strony). */
export interface PublicFigureEvidence {
  kind: 'account' | 'website';
  property: string;
  propertyLabel: string;
  wikidataValue: string;
  caseValue: string;
  caseSource: string;
  origin: 'analyst' | 'profile' | 'profile_link';
  explanation: string;
}

export interface PublicFigureRole {
  organizationId: string;
  organization: string;
  wikidataOrganization: string;
  property: string;
  role: string;
  from?: string;
  to?: string;
  reference?: string;
  source: string;
}

/** Dopasowanie podmiotu do osoby publicznej w Wikidata (pole teczki `publicFigure`). */
export interface PublicFigure {
  query: string;
  wikidataId?: string;
  label?: string;
  description?: string;
  url?: string;
  matchedBy: PublicFigureEvidence[];
  status: 'hypothesis' | 'confirmed' | 'rejected';
  match: 'corroborated' | 'name_only' | 'ambiguous';
  candidates?: { wikidataId: string; label: string; description?: string; url: string; corroborated: boolean }[];
  statement: string;
  notes: string[];
  roles?: PublicFigureRole[];
  cryptoAddresses?: { entityId: string; entityName: string; network: string; address: string; property: string; propertyLabel: string; source: string; note: string }[];
  expansion?: { depth: number; automatic: boolean; note: string; expansionId?: string };
  counts?: { organizations: number; persons: number; relations: number };
  decision?: { decision: 'confirmed' | 'rejected'; decidedAt: string; author: string; note?: string };
}

/** „Siatka: X organizacji, Y osób, Z relacji” — z liczników teczki albo z sieci organizacji. */
export function networkCountText(counts: { organizations: number; persons: number; relations: number }): string {
  return `Siatka: ${counts.organizations} organizacji, ${counts.persons} osób, ${counts.relations} relacji`;
}

/** Status dopasowania słowami — hipoteza nigdy nie wygląda na potwierdzenie. */
export function publicFigureStatusText(figure: PublicFigure): string {
  if (figure.status === 'confirmed') return 'dopasowanie potwierdzone przez analityka';
  if (figure.status === 'rejected') return 'dopasowanie odrzucone przez analityka';
  if (figure.match === 'corroborated') return 'hipoteza dopasowania';
  if (figure.match === 'ambiguous') return 'kilka osób o tym nazwisku — wybór należy do analityka';
  return 'możliwa osoba publiczna o tym nazwisku (niepotwierdzona)';
}

export interface NetworkCounterparty {
  address: string;
  transfers: number;
  amount: number;
  asset: string;
  service?: string;
  checkedInPublications?: boolean;
}

export interface InquiryPoint {
  service: string;
  kind: string;
  direction: 'in' | 'out';
  transfers: number;
  amount: number;
  asset: string;
  valuePln?: number;
  note: string;
}

export interface AddressNetworkSide {
  transfers: number;
  counterparties: number;
  amount: number;
  serviceShare: number;
  unlabelledTransfers: number;
  unlabelledAmount: number;
  top: NetworkCounterparty[];
  inquiryPoints: InquiryPoint[];
}

export interface AddressNetwork {
  address: string;
  network: string;
  asset: string;
  coverage: { fetched: number; total?: number; note?: string };
  incoming: AddressNetworkSide;
  outgoing: AddressNetworkSide;
  cluster: { sameWallet: number; coDepositors: number; other: number; strongest: { address: string; kind: string; strength: number }[] };
  publicationCheck: { checked: number; limit?: number };
  statements: string[];
  privacyNote: string;
}

/** Organizacja do kafla „Kto to prawdopodobnie jest”, gdy nie wskazano osoby. */
export function leadOrganization(dossier: { organizations?: DossierOrganization[]; persons: { probability: number }[] }): DossierOrganization | undefined {
  if (dossier.persons.some((person) => person.probability > 0)) return undefined;
  return [...(dossier.organizations ?? [])].sort((a, b) => b.indicator - a.indicator)[0];
}

/** Osoby w rolach pogrupowane po organizacji (kolejność organizacji jak w sieci). */
export function rolesByOrganization(network: OrganizationNetwork): { organization: OrgEntity; persons: PersonInRole[] }[] {
  return network.organizations.map((organization) => ({ organization, persons: network.persons.filter((person) => person.organizationId === organization.id) }));
}

export const shareText = (share: number) => `${Math.round(share * 100)}%`;
