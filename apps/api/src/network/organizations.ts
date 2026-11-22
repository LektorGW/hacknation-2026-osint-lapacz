// Adapter sieci organizacji (moduł `org-network.ts`: KRS, Wikidata, GLEIF) jako dostawca ekspanderów
// „organizacja → osoby w rolach, jednostka dominująca, spółki zależne” i „osoba w roli → inne organizacje”.
// Moduł jest wczytywany dynamicznie: gdy go nie ma, droga jest niedostępna (powód zatrzymania), nic nie pęka.

export interface OrgSeedInput {
  name: string;
  domain?: string;
  krs?: string;
  lei?: string;
  wikidata?: string;
  origin: string;
}

export interface OrgNetworkResult {
  organizations: { id: string; name: string; match: string; matchNote: string; identifiers: Record<string, string | undefined>; sources: { url: string; retrievedAt: string; registry: string }[] }[];
  persons: { id: string; name: string; masked: boolean; role: string; organizationId: string; from?: string; to?: string; source: { url: string; retrievedAt: string; registry: string }; wikidata?: string }[];
  relations: { from: string; to: string; kind: string; label: string; status: 'source_fact' | 'computed'; source?: { url: string; retrievedAt: string; registry: string }; explanation: string }[];
  stops: { reason: string; detail: string; skipped?: number }[];
}

export interface OrganizationProvider {
  label: string;
  /** Organizacja → sieć z rejestrów (krok 1). */
  expand(seed: OrgSeedInput, options: { signal?: AbortSignal; reserve: () => boolean; log: (message: string) => void }): Promise<OrgNetworkResult>;
  /** Osoba w roli (Wikidata) → inne organizacje, w których pełni role. */
  rolesOf?(person: { wikidata: string; name: string }, options: { signal?: AbortSignal; reserve: () => boolean; log: (message: string) => void }): Promise<{ organizations: { id: string; name: string; role: string; url: string; retrievedAt: string }[] }>;
  /** Osoba (Wikidata) → osoby wskazane relacjami rodzinnymi, które same mają wpis w Wikidata (tylko na żądanie). */
  familyOf?(person: { wikidata: string; name: string }, options: { signal?: AbortSignal; reserve: () => boolean; log: (message: string) => void }): Promise<{ wikidataId: string; label: string; description?: string; property: string; relation: string; source: string; retrievedAt: string }[]>;
}

const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const ROLES: Record<string, string> = { P112: 'założyciel', P169: 'dyrektor generalny (CEO)', P1037: 'dyrektor / kierownik', P488: 'przewodniczący', P3320: 'członek zarządu' };

/** Dostawca oparty na `buildOrganizationNetwork`; `null`, gdy modułu nie ma na dysku. */
export async function createRegistryOrganizationProvider(options: { fetch?: typeof fetch; now?: () => Date } = {}): Promise<OrganizationProvider | null> {
  let build: ((params: Record<string, unknown>) => Promise<OrgNetworkResult>) | undefined;
  let userAgent = 'OLCyS-research/0.1 (hackathon KAS)';
  try {
    const module = (await import('../org-network.ts')) as { buildOrganizationNetwork?: (params: Record<string, unknown>) => Promise<OrgNetworkResult>; ORG_USER_AGENT?: string };
    build = module.buildOrganizationNetwork;
    if (module.ORG_USER_AGENT) userAgent = module.ORG_USER_AGENT;
  } catch {
    build = undefined;
  }
  if (!build) return null;
  const run = build;
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  return {
    label: 'Rejestry organizacji (KRS, Wikidata, GLEIF) — moduł sieci organizacji',
    expand: (seed, context) =>
      run({
        seeds: [{ ...seed, addresses: [] }],
        fetch: doFetch,
        deep: false,
        now,
        log: context.log,
        reserve: context.reserve,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    async rolesOf(person, context) {
      if (!/^Q\d+$/.test(person.wikidata) || !context.reserve()) return { organizations: [] };
      const query = `SELECT ?org ?orgLabel ?prop WHERE { VALUES ?prop { ${Object.keys(ROLES).map((property) => `wdt:${property}`).join(' ')} } ?org ?prop wd:${person.wikidata} . SERVICE wikibase:label { bd:serviceParam wikibase:language "pl,en". } } LIMIT 10`;
      const url = `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`;
      const retrievedAt = now().toISOString();
      const timeout = AbortSignal.timeout(15_000);
      const response = await doFetch(url, { headers: { 'User-Agent': userAgent, Accept: 'application/sparql-results+json' }, signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout });
      if (!response.ok) throw new Error(`Wikidata: kod ${response.status}`);
      const json = (await response.json()) as { results?: { bindings?: Record<string, { value?: string }>[] } };
      const organizations = (json.results?.bindings ?? []).flatMap((row) => {
        const id = row.org?.value?.split('/').pop();
        const name = row.orgLabel?.value;
        const property = row.prop?.value?.split('/').pop();
        return id && name && property ? [{ id: `org:wikidata:${id}`, name, role: ROLES[property] ?? property, url: `https://www.wikidata.org/wiki/${id}`, retrievedAt }] : [];
      });
      return { organizations };
    },
    async familyOf(person, context) {
      if (!/^Q\d+$/.test(person.wikidata)) return [];
      const module = await import('../public-figure.ts');
      const client = module.createWikidataClient({ fetch: doFetch, now, log: context.log, reserve: context.reserve, maxRequests: 3, ...(context.signal ? { signal: context.signal } : {}) });
      const relations = await module.familyOf(person.wikidata, client);
      if (relations.length === 0 && client.failures.length > 0) throw new Error(`Wikidata: ${client.failures[0]}`);
      return relations;
    },
  };
}
