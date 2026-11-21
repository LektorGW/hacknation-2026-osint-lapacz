// Sieć organizacji z REJESTRÓW PUBLICZNYCH: organizacja wskazana w analizie (beneficjent zbiórki, wpis KRS)
// → osoby pełniące w niej role (zarząd, prokurenci, rada nadzorcza, założyciele, dyrektorzy) → podmioty
// powiązane (jednostka dominująca, spółki zależne, wspólny członek zarządu).
//
// Źródła i podstawa prawna: docs/ZRODLA-PODSTAWA-PRAWNA.md, sekcja „Rejestry organizacji”.
//   • KRS (api-krs.ms.gov.pl, odpis aktualny; dane osobowe API maskuje — pokazujemy je tak, jak podaje rejestr),
//   • Wikidata (dane strukturalne na CC0; wbgetentities / wbsearchentities, w trybie głębokim zapytanie SPARQL),
//   • GLEIF LEI (CC0; jednostka dominująca i spółki zależne po numerze LEI),
//   • ProPublica Nonprofit Explorer (organizacje non-profit w USA; wyłącznie identyfikacja podmiotu — API nie podaje
//     członków zarządu; dane z podaniem źródła, bez rozpowszechniania zbioru).
//
// Zasady uczciwości:
// - osoba pełniąca rolę w organizacji NIE jest właścicielem adresu — relacja „osoba odpowiedzialna za organizację
//   (rola w rejestrze)”; osoby pokazujemy wyłącznie w roli publicznej z rejestru;
// - organizację rozpoznajemy po identyfikatorach (domena strony = oficjalna strona w rejestrze, KRS, LEI); zgodna
//   tylko nazwa to słabe dopasowanie: wpis jest pokazany jako „możliwy”, bez rozwijania osób i bez scalania;
// - rozszerzanie ograniczone: krok 1 (osoby i bezpośrednio powiązane podmioty), limity osób i podmiotów, powody
//   zatrzymania jak w innych etapach; krok 2 (inne podmioty tej osoby w rejestrze) tylko w trybie głębokim.

import { beneficiaryKey, registrableDomain } from './beneficiary.ts';

export const ORG_NETWORK_LIMITS = {
  maxPersons: 15,
  maxOrganizations: 10,
  /** Najwyżej tyle zapytań do rejestrów na sprawę. */
  maxRequests: 30,
  requestTimeoutMs: 15_000,
  /** Krok 2 (tryb głęboki): dla ilu osób szukać innych podmiotów w tym samym rejestrze. */
  deepPersons: 5,
  /** Najwyżej tyle profili publicznych osoby z identyfikatorów podanych przez rejestr. */
  maxProfileLookups: 5,
} as const;

/** Zasady Wikimedia wymagają opisowego User-Agent z kontaktem — operator podaje go w `OLCYS_CONTACT` (e-mail albo strona). */
export const ORG_USER_AGENT = `OLCyS-research/0.1 (${process.env.OLCYS_CONTACT?.trim() || 'hackathon KAS; kontakt przez organizatora'})`;

export type RegistryName = 'KRS' | 'Wikidata' | 'GLEIF' | 'ProPublica';

export const REGISTRY_TERMS: Record<RegistryName, string> = {
  KRS: 'Otwarte API KRS Ministerstwa Sprawiedliwości (dane jawne rejestru; dane osobowe zamaskowane przez API)',
  Wikidata: 'Wikidata — dane strukturalne CC0',
  GLEIF: 'GLEIF LEI — dane CC0',
  ProPublica: 'ProPublica Nonprofit Explorer API — z podaniem źródła, bez rozpowszechniania zbioru',
};

export interface RegistrySource {
  registry: RegistryName;
  url: string;
  retrievedAt: string;
  terms: string;
}

export interface OrgEntity {
  id: string;
  name: string;
  /** Jak rozpoznano podmiot: identyfikator (KRS/LEI), domena oficjalnej strony, albo tylko nazwa (słabe). */
  match: 'identifier' | 'domain' | 'name_only' | 'related';
  matchNote: string;
  identifiers: { krs?: string; nip?: string; regon?: string; lei?: string; wikidata?: string; ein?: string; website?: string };
  /** Organizacja wskazana w analizie (beneficjent adresu, wpis KRS), a nie podmiot powiązany. */
  seed: boolean;
  /** Adresy sprawy, których dotyczy organizacja (beneficjent zbiórki). */
  addresses: string[];
  sources: RegistrySource[];
  /** Wpisy w innych rejestrach zgodne tylko nazwą — NIE scalone z podmiotem. */
  weakCandidates?: { registry: RegistryName; name: string; identifier: string; url: string; note: string }[];
}

export interface PersonInRole {
  id: string;
  name: string;
  /** Imię i nazwisko zamaskowane przez rejestr (KRS) — osoba nie jest porównywana między podmiotami. */
  masked: boolean;
  role: string;
  organizationId: string;
  from?: string;
  to?: string;
  source: RegistrySource;
  wikidata?: string;
  /** Identyfikatory opublikowane przez rejestr (Wikidata): profile publiczne OSOBY, niepowiązane z adresem. */
  publishedIdentifiers?: { github?: string; x?: string; website?: string };
  publicProfiles?: { url: string; service: string; title: string }[];
  /** Zawsze: rola w rejestrze, nie własność adresu. */
  relation: 'osoba odpowiedzialna za organizację (rola w rejestrze)';
}

export interface OrgRelation {
  from: string;
  to: string;
  kind: 'parent' | 'subsidiary' | 'shared_officer' | 'other_role_of_officer';
  label: string;
  status: 'source_fact' | 'computed';
  source?: RegistrySource;
  explanation: string;
}

export interface PersonLink {
  a: string;
  b: string;
  kind: 'same_organization' | 'shared_organizations';
  organizations: string[];
  status: 'computed';
  explanation: string;
}

export interface OrgStop {
  stage: 'organizations';
  reason: 'depth_limit' | 'query_limit' | 'low_reliability' | 'source_error' | 'no_new_leads' | 'time_limit';
  detail: string;
  skipped?: number;
}

export interface OrganizationNetwork {
  organizations: OrgEntity[];
  persons: PersonInRole[];
  relations: OrgRelation[];
  personLinks: PersonLink[];
  sources: RegistrySource[];
  stops: OrgStop[];
  notes: string[];
  limits: typeof ORG_NETWORK_LIMITS & { deep: boolean };
}

export interface OrgSeed {
  name: string;
  domain?: string;
  krs?: string;
  lei?: string;
  wikidata?: string;
  addresses: string[];
  /** Skąd organizacja: np. „beneficjent zbiórki adresu bc1q…”. */
  origin: string;
}

export interface OrgNetworkParams {
  seeds: OrgSeed[];
  fetch?: typeof fetch;
  deep?: boolean;
  now?: () => Date;
  log?: (message: string) => void;
  signal?: AbortSignal;
  /** Rezerwuje zapytanie w budżecie analizy; `false` — budżet wyczerpany. */
  reserve?: () => boolean;
  /** Profile publiczne osoby z identyfikatora podanego przez rejestr (np. login GitHub) — istniejące łączniki. */
  lookupProfile?: (identifier: { type: 'login'; value: string }) => Promise<{ url: string; service: string; title: string }[]>;
}

const KRS_API = 'https://api-krs.ms.gov.pl/api/krs/OdpisAktualny';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
/** Przerwa przed jedyną ponowną próbą zapytania do rejestru po błędzie sieci, 429 albo 5xx. */
const REGISTRY_RETRY_DELAY_MS = 1500;
const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
const GLEIF_API = 'https://api.gleif.org/api/v1/lei-records';
const PROPUBLICA_API = 'https://projects.propublica.org/nonprofits/api/v2/search.json';

/** Role osób w Wikidata (właściwość → rola po polsku). */
const WIKIDATA_ROLES: Record<string, string> = {
  P112: 'założyciel',
  P169: 'dyrektor generalny (CEO)',
  P1037: 'dyrektor / kierownik',
  P488: 'przewodniczący',
  P3320: 'członek zarządu',
};

/** Formy prawne na końcu nazwy z rejestru. */
const LEGAL_FORM = /\s*(?:SPÓŁKA AKCYJNA|SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ|SPÓŁKA KOMANDYTOWA|SPÓŁKA JAWNA|S\.A\.|SP\. Z O\.O\.|INC\.?|LTD\.?|LLC|GMBH|AG)\s*$/i;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Usuwa z tekstu rejestru numery PESEL i podobne ciągi cyfr (np. w opisie prokury) — pokazujemy tylko rolę. */
const scrub = (text: string) => text.replace(/\(?\s*PESEL[:\s]*\d{6,}\s*\)?/gi, '').replace(/\d{11}/g, '').replace(/\s+/g, ' ').trim();

const wikidataTime = (value: unknown): string | undefined => {
  const time = str(obj(obj(value)?.datavalue)?.value && obj(obj(obj(value)?.datavalue)?.value)?.time);
  const match = time ? /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(time) : null;
  if (!match) return undefined;
  return match[2] === '00' ? match[1] : match[3] === '00' ? `${match[1]}-${match[2]}` : `${match[1]}-${match[2]}-${match[3]}`;
};

const domainOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return registrableDomain(new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname);
  } catch {
    return undefined;
  }
};

/** Etap sieci organizacji: rejestry publiczne, ograniczone rozszerzanie, jawne źródła i powody zatrzymania. */
export async function buildOrganizationNetwork(params: OrgNetworkParams): Promise<OrganizationNetwork> {
  const doFetch = params.fetch ?? globalThis.fetch;
  const now = params.now ?? (() => new Date());
  const log = params.log ?? (() => {});
  const deep = params.deep === true;
  const limits = { ...ORG_NETWORK_LIMITS, deep };
  const organizations: OrgEntity[] = [];
  const persons: PersonInRole[] = [];
  const relations: OrgRelation[] = [];
  const sources: RegistrySource[] = [];
  const stops: OrgStop[] = [];
  const notes: string[] = [];
  let requests = 0;
  let requestLimitHit = 0;
  const failures = new Map<string, { count: number; message: string }>();

  const get = async (registry: RegistryName, url: string, accept = 'application/json'): Promise<{ json?: Json; source?: RegistrySource; status: number }> => {
    if (requests >= limits.maxRequests || (params.reserve && !params.reserve())) {
      requestLimitHit++;
      return { status: 0 };
    }
    requests++;
    const retrievedAt = now().toISOString();
    // Chwilowy błąd sieci albo przeciążenie (5xx, 429) — jedna ponowna próba po krótkiej przerwie.
    for (let attempt = 0; ; attempt++) {
      try {
        const signal = params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(limits.requestTimeoutMs)]) : AbortSignal.timeout(limits.requestTimeoutMs);
        const response = await doFetch(url, { headers: { 'User-Agent': ORG_USER_AGENT, Accept: accept }, signal });
        if (response.status === 404) return { status: 404 };
        if (!response.ok) throw Object.assign(new Error(`kod ${response.status}`), { retryable: response.status === 429 || response.status >= 500 });
        const json = obj(await response.json());
        const source: RegistrySource = { registry, url, retrievedAt, terms: REGISTRY_TERMS[registry] };
        sources.push(source);
        return { ...(json ? { json } : {}), source, status: response.status };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const retryable = (error as { retryable?: boolean }).retryable !== false && !params.signal?.aborted;
        if (attempt === 0 && retryable) {
          log(`[rejestry] ${registry}: ${message} — ponawiam raz po przerwie.`);
          await new Promise((resolve) => setTimeout(resolve, REGISTRY_RETRY_DELAY_MS));
          continue;
        }
        const entry = failures.get(registry) ?? { count: 0, message };
        entry.count++;
        failures.set(registry, entry);
        log(`[rejestry] ${registry}: błąd zapytania ${url} — ${message}.`);
        return { status: -1 };
      }
    }
  };

  const findOrg = (test: (org: OrgEntity) => boolean) => organizations.find(test);
  const addOrg = (org: OrgEntity): OrgEntity | undefined => {
    // Scalanie wyłącznie po identyfikatorach (KRS, LEI, Wikidata, domena strony) — nigdy po samej nazwie.
    const same = findOrg(
      (known) =>
        (org.identifiers.krs !== undefined && known.identifiers.krs === org.identifiers.krs) ||
        (org.identifiers.lei !== undefined && known.identifiers.lei === org.identifiers.lei) ||
        (org.identifiers.wikidata !== undefined && known.identifiers.wikidata === org.identifiers.wikidata) ||
        (org.identifiers.website !== undefined && known.identifiers.website === org.identifiers.website && org.match !== 'name_only' && known.match !== 'name_only'),
    );
    if (same) {
      same.identifiers = { ...org.identifiers, ...same.identifiers };
      same.sources.push(...org.sources);
      same.seed ||= org.seed;
      for (const address of org.addresses) if (!same.addresses.includes(address)) same.addresses.push(address);
      if (same.match === 'related' && org.match !== 'related') {
        same.match = org.match;
        same.matchNote = org.matchNote;
      }
      return same;
    }
    if (organizations.length >= limits.maxOrganizations) {
      orgsSkipped.push(org.name);
      return undefined;
    }
    organizations.push(org);
    return org;
  };
  let personsSkipped = 0;
  const orgsSkipped: string[] = [];
  const addPerson = (person: Omit<PersonInRole, 'relation'>) => {
    if (persons.some((known) => known.organizationId === person.organizationId && known.role === person.role && known.name === person.name && known.wikidata === person.wikidata)) return;
    if (persons.length >= limits.maxPersons) {
      personsSkipped++;
      return;
    }
    persons.push({ ...person, relation: 'osoba odpowiedzialna za organizację (rola w rejestrze)' });
  };

  // ---------- KRS ----------
  const fromKrs = async (krs: string, seed: OrgSeed | undefined): Promise<OrgEntity | undefined> => {
    let json: Json | undefined;
    let source: RegistrySource | undefined;
    for (const register of ['P', 'S']) {
      const result = await get('KRS', `${KRS_API}/${krs}?rejestr=${register}&format=json`);
      if (result.json && obj(obj(obj(result.json.odpis)?.dane)?.dzial1)) {
        json = result.json;
        source = result.source;
        break;
      }
      if (result.status !== 404) break;
    }
    const data = obj(obj(json?.odpis)?.dane);
    const entity = obj(obj(data?.dzial1)?.danePodmiotu);
    const name = str(entity?.nazwa);
    if (!data || !entity || !name || !source) {
      notes.push(`KRS ${krs}: brak aktualnego odpisu.`);
      return undefined;
    }
    const ids = obj(entity.identyfikatory);
    const site = str(obj(obj(data.dzial1)?.siedzibaIAdres)?.adresStronyInternetowej);
    const org = addOrg({
      id: `org:krs:${krs}`,
      name,
      match: 'identifier',
      matchNote: `Rozpoznano po numerze KRS ${krs}.`,
      identifiers: { krs, ...(str(ids?.nip) ? { nip: str(ids?.nip)! } : {}), ...(str(ids?.regon) ? { regon: str(ids?.regon)! } : {}), ...(domainOf(site) ? { website: domainOf(site)! } : {}) },
      seed: seed !== undefined,
      addresses: seed?.addresses ?? [],
      sources: [source],
    });
    if (!org) return undefined;
    const dzial2 = obj(data.dzial2);
    const maskedName = (member: Json) => {
      const names = obj(member.imiona);
      const surname = obj(member.nazwisko);
      return str(member.nazwa) ?? ([str(names?.imie), str(names?.imieDrugie), str(surname?.nazwiskoICzlon), str(surname?.nazwiskoIICzlon)].filter(Boolean).join(' ') || 'brak danych');
    };
    const representation = obj(dzial2?.reprezentacja);
    const organName = str(representation?.nazwaOrganu) ?? str(representation?.nazwaOrgan) ?? 'organ reprezentacji';
    for (const [index, member] of arr(representation?.sklad).map(obj).entries()) {
      if (!member) continue;
      addPerson({ id: `${org.id}:rep:${index}`, name: maskedName(member), masked: true, role: (str(member.funkcjaWOrganie) ?? `członek: ${organName}`).toLowerCase(), organizationId: org.id, source: source! });
    }
    for (const organ of arr(dzial2?.organNadzoru).map(obj)) {
      for (const [index, member] of arr(organ?.sklad).map(obj).entries()) {
        if (!member) continue;
        addPerson({ id: `${org.id}:nadzor:${index}`, name: maskedName(member), masked: true, role: `członek: ${(str(organ?.nazwa) ?? 'organ nadzoru').toLowerCase()}`, organizationId: org.id, source: source! });
      }
    }
    for (const [index, member] of arr(dzial2?.prokurenci).map(obj).entries()) {
      if (!member) continue;
      const kind = str(member.rodzajProkury);
      addPerson({ id: `${org.id}:prokura:${index}`, name: maskedName(member), masked: true, role: `prokurent${kind ? ` (${scrub(kind.split(',')[0]!).toLowerCase()})` : ''}`, organizationId: org.id, source: source! });
    }
    notes.push(`KRS ${krs} („${name}”): imiona i nazwiska członków organów API rejestru podaje zamaskowane — pełne dane w odpisie z KRS; osoby nie są porównywane między podmiotami.`);
    return org;
  };

  // ---------- Wikidata ----------
  const entities = async (ids: string[]): Promise<Map<string, Json>> => {
    const result = new Map<string, Json>();
    for (let at = 0; at < ids.length; at += 40) {
      const chunk = ids.slice(at, at + 40);
      const { json } = await get('Wikidata', `${WIKIDATA_API}?action=wbgetentities&ids=${chunk.join('|')}&props=labels|claims&languages=pl|en&format=json`);
      for (const [id, entity] of Object.entries(obj(json?.entities) ?? {})) if (obj(entity)) result.set(id, obj(entity)!);
    }
    return result;
  };
  const label = (entity: Json | undefined, fallback: string) => str(obj(obj(entity?.labels)?.pl)?.value) ?? str(obj(obj(entity?.labels)?.en)?.value) ?? fallback;
  const claims = (entity: Json | undefined, property: string) => arr(obj(entity?.claims)?.[property]).map(obj).filter((item): item is Json => item !== undefined);
  const claimValue = (claim: Json) => obj(obj(claim.mainsnak)?.datavalue)?.value;
  const claimItem = (claim: Json) => str(obj(claimValue(claim))?.id);
  const claimString = (claim: Json) => str(claimValue(claim));
  const qualifier = (claim: Json, property: string) => arr(obj(claim.qualifiers)?.[property])[0];
  const websites = (entity: Json | undefined) => claims(entity, 'P856').map(claimString).filter((url): url is string => Boolean(url));
  const isHuman = (entity: Json | undefined) => claims(entity, 'P31').some((claim) => claimItem(claim) === 'Q5');

  const fromWikidata = async (seed: OrgSeed | undefined, known: OrgEntity | undefined): Promise<OrgEntity | undefined> => {
    const domain = seed?.domain ?? known?.identifiers.website;
    let qid = seed?.wikidata ?? known?.identifiers.wikidata;
    let entity: Json | undefined;
    let match: OrgEntity['match'] = 'identifier';
    let matchNote = qid ? `Wpis Wikidata ${qid} wskazany wprost.` : '';
    if (!qid) {
      const name = seed?.name ?? known?.name;
      if (!name) return undefined;
      const hits: string[] = [];
      // Nazwa z rejestru bywa pełną nazwą prawną („ORLEN SPÓŁKA AKCYJNA”), a etykieta Wikidata — krótką („Orlen”):
      // drugie zapytanie bez formy prawnej. Wynik i tak musi się zgadzać domeną oficjalnej strony.
      const short = name.replace(LEGAL_FORM, '').replace(/[\s,.-]+$/, '').trim();
      const queries = [...new Set([name, ...(domain && short && short !== name ? [short] : [])])];
      for (const query of queries) {
        for (const language of ['en', 'pl']) {
          const { json } = await get('Wikidata', `${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(query)}&language=${language}&type=item&limit=5&format=json`);
          for (const hit of arr(json?.search).map(obj)) if (str(hit?.id) && !hits.includes(str(hit?.id)!)) hits.push(str(hit?.id)!);
          if (hits.length > 0) break;
        }
        if (hits.length > 0) break;
      }
      if (hits.length === 0) return undefined;
      const found = await entities(hits);
      // Ten sam podmiot tylko przy zgodnej domenie oficjalnej strony (P856) — zgodna nazwa to słabe dopasowanie.
      const byDomain = domain ? hits.find((id) => websites(found.get(id)).some((url) => domainOf(url) === domain)) : undefined;
      if (byDomain) {
        qid = byDomain;
        entity = found.get(byDomain);
        match = 'domain';
        matchNote = `Wpis Wikidata ${byDomain}: oficjalna strona (P856) w domenie ${domain} — ta sama domena co w kontekście adresu / rejestrze.`;
      } else {
        const byName = hits.find((id) => beneficiaryKey(label(found.get(id), '')) === beneficiaryKey(name));
        if (byName && known) {
          known.weakCandidates = [
            ...(known.weakCandidates ?? []),
            { registry: 'Wikidata', name: label(found.get(byName), byName), identifier: byName, url: `https://www.wikidata.org/wiki/${byName}`, note: 'Zgodna tylko nazwa (bez zgodnej domeny) — możliwy, niepotwierdzony wpis; nie scalono i nie rozwijano osób.' },
          ];
          return known;
        }
        if (byName && seed) {
          return addOrg({
            id: `org:wikidata:${byName}`,
            name: label(found.get(byName), byName),
            match: 'name_only',
            matchNote: `Zgodna tylko nazwa z „${seed.name}” (bez zgodnej domeny ani identyfikatora) — słabe dopasowanie: wpis pokazany jako możliwy, osób nie rozwijano.`,
            identifiers: { wikidata: byName },
            seed: true,
            addresses: seed.addresses,
            sources: sources.filter((item) => item.registry === 'Wikidata').slice(-1),
          });
        }
        return undefined;
      }
    } else {
      entity = (await entities([qid])).get(qid);
    }
    if (!entity || !qid) return undefined;
    const site = websites(entity).map(domainOf).find(Boolean);
    const source = sources.filter((item) => item.registry === 'Wikidata').at(-1)!;
    const lei = claims(entity, 'P1278').map(claimString).find(Boolean);
    const identifiers = { wikidata: qid, ...(site ? { website: site } : {}), ...(lei ? { lei } : {}) };
    // Podmiot znany z KRS dostaje identyfikatory Wikidata (dopasowanie po domenie strony z odpisu) — bez nowego węzła.
    const org = known
      ? Object.assign(known, { identifiers: { ...identifiers, ...known.identifiers }, sources: [...known.sources, source], matchNote: `${known.matchNote} ${matchNote}`.trim() })
      : addOrg({
          id: `org:wikidata:${qid}`,
          name: label(entity, seed?.name ?? qid),
          match,
          matchNote,
          identifiers,
          seed: seed !== undefined,
          addresses: seed?.addresses ?? [],
          sources: [source],
        });
    if (!org) return undefined;
    // Osoby w rolach i podmioty powiązane (krok 1).
    const roleClaims = Object.keys(WIKIDATA_ROLES).flatMap((property) => claims(entity, property).map((claim) => ({ property, claim })));
    // P749 — jednostka dominująca; P127 — właściciel / udziałowiec; P355 — spółka zależna.
    const parentClaims = [...claims(entity, 'P749').map((claim) => ({ claim, property: 'P749' })), ...claims(entity, 'P127').map((claim) => ({ claim, property: 'P127' }))];
    const childClaims = claims(entity, 'P355').map((claim) => ({ claim, property: 'P355' }));
    const referenced = [...new Set([...roleClaims.map(({ claim }) => claimItem(claim)), ...parentClaims.map(({ claim }) => claimItem(claim)), ...childClaims.map(({ claim }) => claimItem(claim))].filter((id): id is string => Boolean(id)))];
    const details = referenced.length > 0 ? await entities(referenced) : new Map<string, Json>();
    const detailSource = sources.filter((item) => item.registry === 'Wikidata').at(-1) ?? source;
    for (const { property, claim } of roleClaims) {
      const id = claimItem(claim);
      if (!id) continue;
      const person = details.get(id);
      if (person && !isHuman(person)) continue;
      const github = claims(person, 'P2037').map(claimString).find(Boolean);
      const x = claims(person, 'P2002').map(claimString).find(Boolean);
      const website = websites(person)[0];
      const from = wikidataTime(qualifier(claim, 'P580'));
      const to = wikidataTime(qualifier(claim, 'P582'));
      addPerson({
        id: `person:wikidata:${id}:${org.id}:${property}`,
        name: label(person, id),
        masked: false,
        role: WIKIDATA_ROLES[property]!,
        organizationId: org.id,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        source: { ...detailSource, url: `https://www.wikidata.org/wiki/${qid}#${property}` },
        wikidata: id,
        ...(github || x || website ? { publishedIdentifiers: { ...(github ? { github } : {}), ...(x ? { x } : {}), ...(website ? { website } : {}) } } : {}),
      });
    }
    for (const [claimsOf, kind] of [[parentClaims, 'parent'], [childClaims, 'subsidiary']] as const) {
      for (const { claim, property } of claimsOf) {
        const id = claimItem(claim);
        const related = id ? details.get(id) : undefined;
        if (!id || !related) continue;
        if (isHuman(related)) {
          addPerson({ id: `person:wikidata:${id}:${org.id}:owner`, name: label(related, id), masked: false, role: 'właściciel / udziałowiec organizacji (wg Wikidata)', organizationId: org.id, source: { ...detailSource, url: `https://www.wikidata.org/wiki/${qid}#P127` }, wikidata: id });
          continue;
        }
        const site = websites(related).map(domainOf).find(Boolean);
        const other = addOrg({
          id: `org:wikidata:${id}`,
          name: label(related, id),
          match: 'related',
          matchNote: `Podmiot powiązany z „${org.name}” według Wikidata (${kind === 'parent' ? 'jednostka dominująca / właściciel' : 'spółka zależna'}).`,
          identifiers: { wikidata: id, ...(site ? { website: site } : {}) },
          seed: false,
          addresses: [],
          sources: [detailSource],
        });
        // Wpis wskazujący ten sam podmiot (np. ta sama domena) nie jest relacją.
        if (!other || other.id === org.id) continue;
        const owner = property === 'P127';
        relations.push({
          from: kind === 'parent' ? other.id : org.id,
          to: kind === 'parent' ? org.id : other.id,
          kind: kind === 'parent' ? 'parent' : 'subsidiary',
          label: owner ? 'właściciel / udziałowiec → podmiot' : 'jednostka dominująca → spółka zależna',
          status: 'source_fact',
          source: { ...detailSource, url: `https://www.wikidata.org/wiki/${qid}#${property}` },
          explanation: owner
            ? `Według Wikidata „${other.name}” jest właścicielem lub udziałowcem „${org.name}”.`
            : `Według Wikidata „${kind === 'parent' ? other.name : org.name}” jest jednostką dominującą wobec „${kind === 'parent' ? org.name : other.name}”.`,
        });
      }
    }
    return org;
  };

  // ---------- GLEIF (po numerze LEI) ----------
  const fromGleif = async (org: OrgEntity) => {
    const lei = org.identifiers.lei;
    if (!lei) return;
    for (const [path, kind] of [['direct-parent', 'parent'], ['direct-children', 'subsidiary']] as const) {
      const { json, source } = await get('GLEIF', `${GLEIF_API}/${lei}/${path}`, 'application/vnd.api+json');
      const records = arr(json?.data).length > 0 ? arr(json?.data) : obj(json?.data) ? [json!.data] : [];
      for (const record of records.slice(0, 5).map(obj)) {
        const otherLei = str(record?.id);
        const name = str(obj(obj(obj(record?.attributes)?.entity)?.legalName)?.name);
        if (!otherLei || !name || !source) continue;
        const other = addOrg({ id: `org:lei:${otherLei}`, name, match: 'related', matchNote: `Podmiot powiązany z „${org.name}” według GLEIF (LEI ${otherLei}).`, identifiers: { lei: otherLei }, seed: false, addresses: [], sources: [source] });
        if (!other || other.id === org.id) continue;
        relations.push({
          from: kind === 'parent' ? other.id : org.id,
          to: kind === 'parent' ? org.id : other.id,
          kind,
          label: 'jednostka dominująca → spółka zależna',
          status: 'source_fact',
          source,
          explanation: `Według GLEIF (relacja „${path}”) „${kind === 'parent' ? name : org.name}” jest jednostką dominującą wobec „${kind === 'parent' ? org.name : name}”.`,
        });
      }
    }
  };

  // ---------- ProPublica (identyfikacja non-profit w USA; tylko wpis kandydujący) ----------
  const fromProPublica = async (org: OrgEntity, name: string) => {
    const { json, source } = await get('ProPublica', `${PROPUBLICA_API}?q=${encodeURIComponent(name)}`);
    const hit = arr(json?.organizations).map(obj).find((item) => beneficiaryKey(str(item?.name) ?? '') === beneficiaryKey(name));
    if (!hit || !source) return;
    const ein = String(hit.ein ?? '');
    org.weakCandidates = [
      ...(org.weakCandidates ?? []),
      {
        registry: 'ProPublica',
        name: str(hit.name) ?? name,
        identifier: `EIN ${str(hit.strein) ?? ein}`,
        url: `https://projects.propublica.org/nonprofits/organizations/${ein}`,
        note: `Organizacja non-profit w USA (${[str(hit.city), str(hit.state)].filter(Boolean).join(', ')}) zgodna tylko nazwą — wpis kandydujący, nie scalony; API nie podaje członków zarządu (są w formularzu IRS 990 pod odnośnikiem).`,
      },
    ];
  };

  // ---------- Krok 1: organizacje z analizy ----------
  for (const seed of params.seeds) {
    if (params.signal?.aborted) break;
    let org: OrgEntity | undefined;
    if (seed.krs) org = await fromKrs(seed.krs, seed);
    const viaWikidata = await fromWikidata(org ? undefined : seed, org);
    org = org ?? viaWikidata;
    if (!org) {
      notes.push(`„${seed.name}”: nie znaleziono wpisu w rejestrach po identyfikatorach (domena${seed.domain ? ` ${seed.domain}` : ''}, KRS, LEI).`);
      continue;
    }
    if (org.match !== 'name_only') {
      await fromGleif(org);
      if (!seed.krs) await fromProPublica(org, seed.name);
    }
  }

  // ---------- Krok 2 (tryb głęboki): inne podmioty, w których ta sama osoba pełni rolę ----------
  const withWikidata = [...new Map(persons.filter((person) => person.wikidata).map((person) => [person.wikidata!, person])).values()];
  if (deep) {
    for (const person of withWikidata.slice(0, limits.deepPersons)) {
      const query = `SELECT ?org ?orgLabel ?prop WHERE { VALUES ?prop { ${Object.keys(WIKIDATA_ROLES).map((property) => `wdt:${property}`).join(' ')} } ?org ?prop wd:${person.wikidata} . SERVICE wikibase:label { bd:serviceParam wikibase:language "pl,en". } } LIMIT 10`;
      const { json, source } = await get('Wikidata', `${WIKIDATA_SPARQL}?format=json&query=${encodeURIComponent(query)}`, 'application/sparql-results+json');
      for (const row of arr(obj(json?.results)?.bindings).map(obj)) {
        const id = str(obj(row?.org)?.value)?.split('/').pop();
        const name = str(obj(row?.orgLabel)?.value);
        const property = str(obj(row?.prop)?.value)?.split('/').pop();
        if (!id || !name || !property || !source || organizations.some((org) => org.identifiers.wikidata === id && org.id === person.organizationId)) continue;
        const other = addOrg({ id: `org:wikidata:${id}`, name, match: 'related', matchNote: `Inny podmiot tej osoby w rejestrze (Wikidata): „${person.name}” — ${WIKIDATA_ROLES[property] ?? property}.`, identifiers: { wikidata: id }, seed: false, addresses: [], sources: [source] });
        if (!other || other.id === person.organizationId) continue;
        addPerson({ ...person, id: `person:wikidata:${person.wikidata}:${other.id}:${property}`, role: WIKIDATA_ROLES[property] ?? property, organizationId: other.id, source, publicProfiles: undefined } as PersonInRole);
        relations.push({ from: person.organizationId, to: other.id, kind: 'other_role_of_officer', label: 'inne podmioty tej osoby w rejestrze', status: 'source_fact', source, explanation: `„${person.name}” pełni rolę także w „${name}” (Wikidata) — to rola w rejestrze, nie powiązanie z adresem.` });
      }
    }
  } else if (withWikidata.length > 0) {
    stops.push({ stage: 'organizations', reason: 'depth_limit', detail: 'Inne podmioty osób pełniących role (krok 2) sprawdza tylko tryb głęboki.', skipped: withWikidata.length });
  }
  if (organizations.some((org) => org.identifiers.krs) && deep) {
    notes.push('KRS: rejestr nie udostępnia wyszukiwania po osobie (dane zamaskowane) — innych podmiotów członków organów nie ustalono.');
  }

  // ---------- Profile publiczne osób z identyfikatorów opublikowanych przez rejestr ----------
  if (params.lookupProfile) {
    let lookups = 0;
    for (const person of persons) {
      const login = person.publishedIdentifiers?.github;
      if (!login) continue;
      if (lookups >= limits.maxProfileLookups) {
        stops.push({ stage: 'organizations', reason: 'query_limit', detail: `Profile publiczne sprawdzono dla ${limits.maxProfileLookups} osób z identyfikatorem z rejestru.` });
        break;
      }
      lookups++;
      const profiles = await params.lookupProfile({ type: 'login', value: login });
      if (profiles.length > 0) person.publicProfiles = profiles.slice(0, 3);
    }
  }

  // ---------- Obliczone: wspólny członek zarządu, osoby tej samej organizacji ----------
  const byWikidata = new Map<string, PersonInRole[]>();
  for (const person of persons) if (person.wikidata && !person.masked) byWikidata.set(person.wikidata, [...(byWikidata.get(person.wikidata) ?? []), person]);
  for (const [, roles] of byWikidata) {
    const orgs = [...new Set(roles.map((item) => item.organizationId))];
    for (let i = 0; i < orgs.length; i++) {
      for (let j = i + 1; j < orgs.length; j++) {
        if (relations.some((item) => item.kind === 'shared_officer' && ((item.from === orgs[i] && item.to === orgs[j]) || (item.from === orgs[j] && item.to === orgs[i])))) continue;
        relations.push({ from: orgs[i]!, to: orgs[j]!, kind: 'shared_officer', label: 'wspólny członek zarządu', status: 'computed', explanation: `„${roles[0]!.name}” pełni role w obu podmiotach (według rejestru) — wynik obliczeń.` });
      }
    }
  }
  const personLinks: PersonLink[] = [];
  const identityOf = (person: PersonInRole) => person.wikidata ?? person.id;
  const orgsOf = new Map<string, Set<string>>();
  for (const person of persons) orgsOf.set(identityOf(person), (orgsOf.get(identityOf(person)) ?? new Set()).add(person.organizationId));
  const people = [...orgsOf.keys()];
  for (let i = 0; i < people.length && personLinks.length < 30; i++) {
    for (let j = i + 1; j < people.length && personLinks.length < 30; j++) {
      const shared = [...orgsOf.get(people[i]!)!].filter((org) => orgsOf.get(people[j]!)!.has(org));
      if (shared.length === 0) continue;
      const a = persons.find((item) => identityOf(item) === people[i])!;
      const b = persons.find((item) => identityOf(item) === people[j])!;
      const names = shared.map((id) => organizations.find((org) => org.id === id)?.name ?? id);
      personLinks.push({
        a: a.id,
        b: b.id,
        kind: shared.length > 1 ? 'shared_organizations' : 'same_organization',
        organizations: shared,
        status: 'computed',
        explanation: `„${a.name}” i „${b.name}” pełnią role w ${names.map((name) => `„${name}”`).join(', ')} (według rejestru) — wspólna organizacja, nie powiązanie z adresem.`,
      });
    }
  }

  // ---------- Powody zatrzymania ----------
  if (orgsSkipped.length > 0) {
    stops.push({ stage: 'organizations', reason: 'query_limit', detail: `Limit ${limits.maxOrganizations} organizacji w sprawie — pominięto ${orgsSkipped.length} dalszych podmiotów (np. ${orgsSkipped.slice(0, 3).map((name) => `„${name}”`).join(', ')}).`, skipped: orgsSkipped.length });
  }
  if (personsSkipped > 0) stops.push({ stage: 'organizations', reason: 'query_limit', detail: `Limit ${limits.maxPersons} osób w sieci organizacji — pominięto ${personsSkipped} dalszych ról.`, skipped: personsSkipped });
  if (requestLimitHit > 0) stops.push({ stage: 'organizations', reason: 'query_limit', detail: `Limit ${limits.maxRequests} zapytań do rejestrów (albo budżet analizy) — pominięto ${requestLimitHit} zapytań.`, skipped: requestLimitHit });
  for (const [registry, failure] of failures) stops.push({ stage: 'organizations', reason: 'source_error', detail: `${registry} nie odpowiedział (${failure.count}×: ${failure.message}) — ta część sieci jest niepełna.`, skipped: failure.count });
  stops.push({ stage: 'organizations', reason: 'depth_limit', detail: `Rozszerzanie organizacji: krok 1 (osoby w rolach i bezpośrednio powiązane podmioty)${deep ? ' oraz krok 2 (inne podmioty tych osób w rejestrze)' : ''}; dalszych kroków nie wykonuje się.` });
  notes.push('Osoba pełniąca rolę w organizacji NIE jest właścicielem adresu — to osoba odpowiedzialna za organizację według rejestru publicznego. Powiązanie adresu z organizacją pozostaje hipotezą, dopóki nie potwierdzi go strona organizacji albo jej odpowiedź.');
  log(`[rejestry] Sieć organizacji: podmiotów ${organizations.length}, osób w rolach ${persons.length}, relacji ${relations.length}, zapytań ${requests}.`);
  return { organizations, persons, relations, personLinks, sources, stops, notes, limits };
}

/** Numery KRS podane wprost w tekście („KRS 0000012345”). */
export function krsNumbersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<![\p{L}\p{N}])KRS(?:[\s:]|\s*nr\.?\s*)*(\d{10})(?!\d)/giu)].map((match) => match[1]!).filter((value) => Number(value) > 0))];
}
