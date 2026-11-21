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
