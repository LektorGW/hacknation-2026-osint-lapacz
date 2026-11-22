// Osoba publiczna: dopasowanie podmiotu sprawy (imię i nazwisko) do wpisu osoby w Wikidata i — dopiero po
// potwierdzeniu drugą cechą albo decyzją analityka — sieć organizacji tej osoby z rejestrów publicznych.
//
// Źródło i podstawa: Wikidata (dane strukturalne CC0), docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 9; dalsze kroki
// (osoby w rolach, jednostki dominujące i zależne) wykonuje istniejący etap sieci organizacji (`org-network.ts`).
//
// Zasady uczciwości:
// - samo imię i nazwisko NIGDY nie wystarcza: wpis jest przyjęty (jako hipoteza dopasowania) tylko wtedy, gdy drugą
//   cechą zgadza się z danymi sprawy — konto w serwisie (porównanie nazw kont, bez pobierania tych serwisów) albo
//   domena oficjalnej strony (P856) równa domenie adresu e-mail / strony ze sprawy; numery PESEL i podobne nie są używane;
// - bez drugiej cechy wpis jest tylko „możliwą osobą publiczną o tym nazwisku (niepotwierdzoną)” — bez rozwijania;
//   rozwinięcie następuje po decyzji analityka;
// - kilka osób o tym samym nazwisku = lista kandydatów, bez automatycznego wyboru;
// - rola w organizacji nie oznacza własności adresu; relacja (rola, wspólna organizacja, rodzina) nie jest dowodem.

import { validateAddress } from '@olcys/core';
import type { Identifier } from '@olcys/core';
import { registrableDomain } from './beneficiary.ts';
import { ORG_USER_AGENT, REGISTRY_TERMS, buildOrganizationNetwork, retryAfterMs } from './org-network.ts';
import type { OrgEntity, OrganizationNetwork, PersonInRole, RegistrySource } from './org-network.ts';

export const PUBLIC_FIGURE_LIMITS = {
  /** Najwyżej tyle organizacji w sieci osoby publicznej (zamiast 10 w sieci organizacji z analizy). */
  maxOrganizations: 40,
  /** Najwyżej tyle ról osób w sieci osoby publicznej (zamiast 15). */
  maxPersons: 60,
  /** Najwyżej tyle obliczonych powiązań osoba ↔ osoba. */
  maxPersonLinks: 60,
  /** Najwyżej tyle zapytań do rejestrów na jedno dopasowanie i rozwinięcie. */
  maxRequests: 45,
  /** Ilu organizacjom osoby rozwijać osoby w rolach i podmioty powiązane: hipoteza dopasowania / potwierdzenie analityka. */
  expandOrganizations: { 1: 6, 2: 12 } as Record<1 | 2, number>,
  /** Głębokość automatyczna: dopasowanie potwierdzone drugą cechą (hipoteza) — 1, potwierdzone przez analityka — 2. */
  depthHypothesis: 1,
  depthConfirmed: 2,
  maxCandidates: 8,
  requestTimeoutMs: 15_000,
} as const;

/** Własny limit czasu etapu w analizie (dopasowanie + rozwinięcie głębokości 1). */
export const PUBLIC_FIGURE_STAGE_MS = 45_000;

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const RETRY_DELAY_MS = 1500;
const SPACING_MS = 250;

/** Właściwości kont w serwisach (porównujemy wyłącznie nazwy kont; serwisów nie pobieramy). */
export const ACCOUNT_PROPERTIES: { property: string; label: string; hosts: string[] }[] = [
  { property: 'P2002', label: 'nazwa konta X (Twitter)', hosts: ['x.com', 'twitter.com'] },
  { property: 'P2037', label: 'nazwa konta GitHub', hosts: ['github.com'] },
  { property: 'P4033', label: 'adres konta Mastodon', hosts: [] },
  { property: 'P7085', label: 'nazwa konta TikTok', hosts: ['tiktok.com'] },
  { property: 'P2003', label: 'nazwa konta Instagram', hosts: ['instagram.com'] },
  { property: 'P2397', label: 'identyfikator kanału YouTube', hosts: ['youtube.com'] },
  { property: 'P6634', label: 'identyfikator profilu LinkedIn', hosts: ['linkedin.com'] },
];

/** Role osoby we właściwościach jej wpisu (osoba → organizacja). */
const DIRECT_ROLES: Record<string, string> = {
  P39: 'stanowisko',
  P108: 'zatrudnienie (pracodawca)',
  P463: 'członkostwo',
  P1830: 'właściciel (według Wikidata)',
};
/** Role we wpisach organizacji wskazujące tę osobę (organizacja → osoba). */
const INVERSE_ROLES: Record<string, string> = {
  P169: 'dyrektor generalny (CEO)',
  P112: 'założyciel',
  P488: 'przewodniczący',
  P1037: 'dyrektor / kierownik',
  P3320: 'członek zarządu',
  P127: 'właściciel / udziałowiec (według Wikidata)',
};
/** Kolejność ważności ról przy wyborze organizacji do rozwinięcia. */
const ROLE_PRIORITY = ['P169', 'P112', 'P488', 'P1037', 'P3320', 'P127', 'P1830', 'P39', 'P108', 'P463'];
/** Kwalifikatory stanowiska (P39) wskazujące organizację. */
const POSITION_ORG_QUALIFIERS = ['P642', 'P2389', 'P108', 'P5054'];
/** Relacje rodzinne (tylko na żądanie analityka). */
export const FAMILY_PROPERTIES: Record<string, string> = {
  P26: 'małżonek / małżonka',
  P22: 'ojciec',
  P25: 'matka',
  P3373: 'rodzeństwo',
  P40: 'dziecko',
};
/** Właściwości adresów kryptowalutowych w Wikidata (sprawdzone: istnieje wyłącznie adres kontraktu tokena Ethereum). */
export const CRYPTO_PROPERTIES: Record<string, string> = { P10824: 'adres kontraktu tokena Ethereum' };
/** Klasy (P31) organizacji — dla wpisów wskazujących osobę jako założyciela / właściciela (mogą to być też przedmioty). */
const ORG_CLASSES = new Set([
  'Q43229', 'Q4830453', 'Q783794', 'Q891723', 'Q6881511', 'Q163740', 'Q157031', 'Q2659904', 'Q327333', 'Q7210356', 'Q7278', 'Q3918', 'Q31855', 'Q15911314',
  'Q484652', 'Q1331793', 'Q18388277', 'Q1058914', 'Q210167', 'Q4671277', 'Q2085381', 'Q1589009', 'Q167037', 'Q658255', 'Q1785733', 'Q21980538', 'Q166280', 'Q22687', 'Q1664720',
]);
/** Cechy wpisu typowe dla organizacji (siedziba, branża, zatrudnienie, LEI, zarząd…). */
const ORG_FEATURES = ['P159', 'P452', 'P1128', 'P2139', 'P414', 'P1278', 'P169', 'P488', 'P3320', 'P749', 'P355', 'P1454', 'P856'];

/** Domeny, których zgodność nic nie mówi o osobie (serwisy, poczta ogólnodostępna, hosting). */
const GENERIC_DOMAINS = new Set([
  'x.com', 'twitter.com', 'github.com', 'github.io', 'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be', 'linkedin.com', 'facebook.com', 'threads.net', 'bsky.app', 'reddit.com',
  'medium.com', 'substack.com', 'wikipedia.org', 'wikidata.org', 'google.com', 'gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me', 'protonmail.com',
  'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl', 'gazeta.pl', 't.me', 'telegram.org', 'linktr.ee', 'deno.dev', 'ngrok.io', 'vercel.app', 'netlify.app', 'gravatar.com',
]);

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

// ---------- Typy wyniku ----------

export interface PublicFigureEvidence {
  kind: 'account' | 'website';
  /** Właściwość Wikidata (np. `P2002`). */
  property: string;
  propertyLabel: string;
  /** Wartość we wpisie Wikidata. */
  wikidataValue: string;
  /** Wartość ze sprawy (nazwa konta, domena). */
  caseValue: string;
  /** Gdzie w sprawie znaleziono wartość (URL profilu albo identyfikator analityka). */
  caseSource: string;
  origin: 'analyst' | 'profile' | 'profile_link';
  explanation: string;
}

export interface PublicFigureCandidate {
  wikidataId: string;
  label: string;
  description?: string;
  url: string;
  corroborated: boolean;
}

export interface PublicFigureRole {
  organizationId: string;
  organization: string;
  wikidataOrganization: string;
  property: string;
  role: string;
  from?: string;
  to?: string;
  /** Adres URL przypisu (P854) przy stwierdzeniu, gdy Wikidata go podaje. */
  reference?: string;
  source: string;
}

export interface PublicFigureAddress {
  /** Byt sieci, którego wpis podaje adres (`org:wikidata:Q…` albo `regperson:Q…`). */
  entityId: string;
  entityName: string;
  network: string;
  address: string;
  property: string;
  propertyLabel: string;
  source: string;
  note: string;
}

export interface PublicFigure {
  /** Imię i nazwisko ze sprawy, dla którego szukano wpisu. */
  query: string;
  wikidataId?: string;
  label?: string;
  description?: string;
  url?: string;
  /** Druga cecha zgodna z danymi sprawy (konto, domena strony). Puste = zgodne tylko imię i nazwisko. */
  matchedBy: PublicFigureEvidence[];
  /** Zawsze hipoteza dopasowania, dopóki nie potwierdzi jej analityk. */
  status: 'hypothesis' | 'confirmed' | 'rejected';
  /** `corroborated` — jeden wpis z drugą cechą; `name_only` — jeden wpis, zgodne tylko nazwisko; `ambiguous` — kilka osób. */
  match: 'corroborated' | 'name_only' | 'ambiguous';
  /** Inne osoby (ludzie) o tym samym imieniu i nazwisku w Wikidata. */
  candidates?: PublicFigureCandidate[];
  statement: string;
  notes: string[];
  sources: RegistrySource[];
  /** Organizacje i role osoby (z datami i przypisami), gdy sieć rozwinięto. */
  roles?: PublicFigureRole[];
  cryptoAddresses?: PublicFigureAddress[];
  /** Jak rozwinięto sieć: głębokość, automatycznie (analiza) czy po decyzji analityka. */
  expansion?: { depth: number; automatic: boolean; note: string; expansionId?: string };
  /** Liczniki siatki (organizacje, osoby, relacje) — liczone w teczce. */
  counts?: { organizations: number; persons: number; relations: number };
  decision?: { decision: 'confirmed' | 'rejected'; decidedAt: string; author: string; note?: string };
}

// ---------- Cechy sprawy do porównania ----------

export interface CaseProfileInput {
  service: string;
  url: string;
  handle?: string;
  urls?: string[];
  emails?: string[];
}

interface CaseAccount {
  property: string;
  handle: string;
  source: string;
  origin: PublicFigureEvidence['origin'];
}
interface CaseDomain {
  domain: string;
  source: string;
  origin: PublicFigureEvidence['origin'];
}
export interface CaseAttributes {
  accounts: CaseAccount[];
  domains: CaseDomain[];
}

const cleanHandle = (value: string) => value.trim().replace(/^@+/, '').toLowerCase();
const hostOf = (url: string): string | undefined => {
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  } catch {
    return undefined;
  }
};
const RESERVED_PATHS = new Set(['i', 'home', 'search', 'share', 'hashtag', 'explore', 'settings', 'messages', 'notifications', 'orgs', 'sponsors', 'topics', 'features', 'about', 'login', 'p', 'reel', 'accounts', 'stories', 'watch', 'results']);

/** Konto w serwisie wskazane adresem URL: właściwość Wikidata + nazwa konta; `undefined`, gdy URL nie wskazuje konta. */
export function accountFromUrl(url: string): { property: string; handle: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile)\./, '');
  const path = parsed.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
  const platform = ACCOUNT_PROPERTIES.find((item) => item.hosts.includes(host));
  if (platform) {
    let handle: string | undefined;
    if (platform.property === 'P2002') handle = path[0] === 'intent' ? (parsed.searchParams.get('screen_name') ?? undefined) : path[0];
    else if (platform.property === 'P7085') handle = path[0]?.startsWith('@') ? path[0] : undefined;
    else if (platform.property === 'P2397') handle = path[0] === 'channel' ? path[1] : undefined;
    else if (platform.property === 'P6634') handle = path[0] === 'in' ? path[1] : undefined;
    else handle = path[0];
    if (!handle || RESERVED_PATHS.has(handle.toLowerCase()) || !/^@?[\w.-]{1,100}$/.test(handle)) return undefined;
    return { property: platform.property, handle: cleanHandle(handle) };
  }
  // Konto w sieci Mastodon (ActivityPub): https://serwer/@nazwa albo https://serwer/users/nazwa → nazwa@serwer.
  const name = path[0]?.startsWith('@') ? path[0].slice(1) : path[0] === 'users' || path[0] === 'u' ? path[1] : undefined;
  if (name && path.length <= 2 && /^[\w.-]{1,100}$/.test(name)) return { property: 'P4033', handle: `${name.toLowerCase()}@${host}` };
  return undefined;
}

/** Cechy sprawy do porównania z wpisem: konta (nazwy kont w serwisach) i domeny (e-mail, strony). */
export function caseAttributesFrom(identifiers: Identifier[], profiles: CaseProfileInput[]): CaseAttributes {
  const accounts: CaseAccount[] = [];
  const domains: CaseDomain[] = [];
  const addAccount = (item: CaseAccount) => {
    if (!accounts.some((known) => known.property === item.property && known.handle === item.handle && known.origin === item.origin)) accounts.push(item);
  };
  const addDomain = (value: string | undefined, source: string, origin: CaseDomain['origin']) => {
    if (!value) return;
    const domain = registrableDomain(value);
    if (!domain.includes('.') || GENERIC_DOMAINS.has(domain) || domains.some((known) => known.domain === domain && known.origin === origin)) return;
    domains.push({ domain, source, origin });
  };
  for (const identifier of identifiers) {
    const value = identifier.value.trim();
    if (identifier.type === 'email') addDomain(value.split('@')[1], value, 'analyst');
    if (identifier.type === 'profile_url') {
      const account = accountFromUrl(value);
      if (account) addAccount({ ...account, source: value, origin: 'analyst' });
      else addDomain(hostOf(value), value, 'analyst');
    }
  }
  for (const profile of profiles) {
    const host = hostOf(profile.url);
    const service = profile.service.toLowerCase();
    const platform = ACCOUNT_PROPERTIES.find((item) => item.hosts.includes(service) || item.hosts.includes(`${service}.com`) || (host !== undefined && item.hosts.includes(host)));
    if (platform && profile.handle && !profile.handle.includes('@')) addAccount({ property: platform.property, handle: cleanHandle(profile.handle), source: profile.url, origin: 'profile' });
    else if (profile.handle && /^[\w.-]+@[\w.-]+\.[a-z]{2,}$/i.test(profile.handle.replace(/^@/, ''))) addAccount({ property: 'P4033', handle: cleanHandle(profile.handle), source: profile.url, origin: 'profile' });
    for (const url of profile.urls ?? []) {
      if (url.replace(/\/+$/, '') === profile.url.replace(/\/+$/, '')) continue;
      const account = accountFromUrl(url);
      if (account && account.property !== 'P4033') addAccount({ ...account, source: profile.url, origin: 'profile_link' });
      else if (!account) addDomain(hostOf(url), profile.url, 'profile_link');
    }
    for (const email of profile.emails ?? []) addDomain(email.split('@')[1], profile.url, 'profile');
  }
  return { accounts, domains };
}

// ---------- Klient Wikidata (budżet, User-Agent, jedna ponowna próba) ----------

export interface WikidataClientOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
  signal?: AbortSignal;
  reserve?: () => boolean;
  maxRequests?: number;
}

export interface WikidataClient {
  get(url: string): Promise<{ json?: Json; source?: RegistrySource }>;
  entities(ids: string[], props?: string): Promise<Map<string, Json>>;
  readonly requests: number;
  readonly limitHit: number;
  readonly failures: string[];
  readonly sources: RegistrySource[];
  readonly cache: Map<string, Json>;
  now(): Date;
}

export function createWikidataClient(options: WikidataClientOptions = {}): WikidataClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const max = options.maxRequests ?? PUBLIC_FIGURE_LIMITS.maxRequests;
  let requests = 0;
  let limitHit = 0;
  let lastAt = 0;
  const failures: string[] = [];
  const sources: RegistrySource[] = [];
  const cache = new Map<string, Json>();
  const get = async (url: string): Promise<{ json?: Json; source?: RegistrySource }> => {
    if (requests >= max || (options.reserve && !options.reserve())) {
      limitHit++;
      return {};
    }
    requests++;
    const retrievedAt = now().toISOString();
    // Odstęp między zapytaniami (zasady Wikimedia — bez serii zapytań kończących się kodem 429).
    const wait = lastAt + SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
    for (let attempt = 0; ; attempt++) {
      try {
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(PUBLIC_FIGURE_LIMITS.requestTimeoutMs)]) : AbortSignal.timeout(PUBLIC_FIGURE_LIMITS.requestTimeoutMs);
        const response = await doFetch(url, { headers: { 'User-Agent': ORG_USER_AGENT, Accept: 'application/json' }, signal });
        if (!response.ok) throw Object.assign(new Error(`kod ${response.status}`), { retryable: response.status === 429 || response.status >= 500, retryAfterMs: retryAfterMs(response) });
        const json = obj(await response.json());
        const source: RegistrySource = { registry: 'Wikidata', url, retrievedAt, terms: REGISTRY_TERMS.Wikidata };
        sources.push(source);
        return { ...(json ? { json } : {}), source };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Kod 429 (przeciążenie) — do dwóch ponowień z przerwą z nagłówka Retry-After; inne błędy — jedno.
        const limit = (error as { retryAfterMs?: number }).retryAfterMs !== undefined ? 2 : 1;
        if (attempt < limit && (error as { retryable?: boolean }).retryable !== false && !options.signal?.aborted) {
          log(`[osoba publiczna] Wikidata: ${message} — ponawiam raz po przerwie.`);
          await new Promise((resolve) => setTimeout(resolve, (error as { retryAfterMs?: number }).retryAfterMs ?? RETRY_DELAY_MS));
          continue;
        }
        failures.push(message);
        log(`[osoba publiczna] Wikidata: błąd zapytania — ${message}.`);
        return {};
      }
    }
  };
  return {
    get,
    async entities(ids, props = 'labels|descriptions|aliases|claims') {
      const result = new Map<string, Json>();
      for (const id of ids) if (cache.has(id)) result.set(id, cache.get(id)!);
      const missing = [...new Set(ids.filter((id) => !result.has(id) && /^Q\d+$/.test(id)))];
      for (let at = 0; at < missing.length; at += 40) {
        const chunk = missing.slice(at, at + 40);
        const { json } = await get(`${WIKIDATA_API}?action=wbgetentities&ids=${chunk.join('|')}&props=${props}&languages=pl|en&format=json`);
        for (const [id, entity] of Object.entries(obj(json?.entities) ?? {})) {
          if (!obj(entity) || obj(entity)!.missing !== undefined) continue;
          result.set(id, obj(entity)!);
          if (props.includes('claims')) cache.set(id, obj(entity)!);
        }
      }
      return result;
    },
    get requests() {
      return requests;
    },
    get limitHit() {
      return limitHit;
    },
    failures,
    sources,
    cache,
    now,
  };
}

// ---------- Odczyt wpisów ----------

const labelOf = (entity: Json | undefined, fallback: string) => str(obj(obj(entity?.labels)?.pl)?.value) ?? str(obj(obj(entity?.labels)?.en)?.value) ?? fallback;
const descriptionOf = (entity: Json | undefined) => str(obj(obj(entity?.descriptions)?.pl)?.value) ?? str(obj(obj(entity?.descriptions)?.en)?.value);
const claimsOf = (entity: Json | undefined, property: string) =>
  arr(obj(entity?.claims)?.[property])
    .map(obj)
    .filter((item): item is Json => item !== undefined && item.rank !== 'deprecated');
const claimValue = (claim: Json) => obj(obj(claim.mainsnak)?.datavalue)?.value;
const claimItem = (claim: Json) => str(obj(claimValue(claim))?.id);
const claimString = (claim: Json) => str(claimValue(claim));
const qualifierValues = (claim: Json, property: string) => arr(obj(claim.qualifiers)?.[property]).map((snak) => obj(obj(snak)?.datavalue)?.value);
const qualifierItem = (claim: Json, property: string) => qualifierValues(claim, property).map((value) => str(obj(value)?.id)).find(Boolean);
const timeOf = (value: unknown): string | undefined => {
  const time = str(obj(value)?.time);
  const match = time ? /^[+-](\d{4})-(\d{2})-(\d{2})/.exec(time) : null;
  if (!match) return undefined;
  return match[2] === '00' ? match[1] : match[3] === '00' ? `${match[1]}-${match[2]}` : `${match[1]}-${match[2]}-${match[3]}`;
};
const qualifierTime = (claim: Json, property: string) => timeOf(qualifierValues(claim, property)[0]);
const referenceUrl = (claim: Json): string | undefined => {
  for (const reference of arr(claim.references).map(obj)) {
    const url = arr(obj(reference?.snaks)?.P854).map((snak) => str(obj(obj(snak)?.datavalue)?.value)).find(Boolean);
    if (url) return url;
  }
  return undefined;
};
const isHuman = (entity: Json | undefined) => claimsOf(entity, 'P31').some((claim) => claimItem(claim) === 'Q5');
const looksLikeOrganization = (entity: Json | undefined) =>
  claimsOf(entity, 'P31').some((claim) => ORG_CLASSES.has(claimItem(claim) ?? '')) || ORG_FEATURES.some((property) => claimsOf(entity, property).length > 0);
const entityUrl = (id: string) => `https://www.wikidata.org/wiki/${id}`;

/** Postać nazwy do porównań: bez znaków diakrytycznych, wielkości liter i interpunkcji. */
export const personNameKey = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const namesOf = (entity: Json): string[] => [
  ...Object.values(obj(entity.labels) ?? {}).map((item) => str(obj(item)?.value)),
  ...Object.values(obj(entity.aliases) ?? {}).flatMap((items) => arr(items).map((item) => str(obj(item)?.value))),
].filter((item): item is string => Boolean(item));

/** Druga cecha: konta i domena oficjalnej strony wpisu zgodne z danymi sprawy. */
export function corroborationOf(entity: Json, attributes: CaseAttributes): PublicFigureEvidence[] {
  const evidence: PublicFigureEvidence[] = [];
  const originText: Record<PublicFigureEvidence['origin'], string> = {
    analyst: 'identyfikator podany przez analityka',
    profile: 'profil znaleziony w sprawie',
    profile_link: 'odnośnik w profilu znalezionym w sprawie',
  };
  for (const spec of ACCOUNT_PROPERTIES) {
    for (const value of claimsOf(entity, spec.property).map(claimString).filter((item): item is string => Boolean(item))) {
      const wanted = cleanHandle(value);
      for (const account of attributes.accounts.filter((item) => item.property === spec.property && item.handle === wanted)) {
        if (evidence.some((item) => item.property === spec.property && item.caseSource === account.source)) continue;
        evidence.push({
          kind: 'account',
          property: spec.property,
          propertyLabel: spec.label,
          wikidataValue: value,
          caseValue: account.handle,
          caseSource: account.source,
          origin: account.origin,
          explanation: `${spec.label} we wpisie Wikidata (${spec.property}) = „${value}” — ta sama nazwa konta co ${originText[account.origin]} (${account.source}). Porównano nazwy kont; serwisu nie pobierano.`,
        });
      }
    }
  }
  for (const url of claimsOf(entity, 'P856').map(claimString).filter((item): item is string => Boolean(item))) {
    const host = hostOf(url);
    const domain = host ? registrableDomain(host) : undefined;
    if (!domain || GENERIC_DOMAINS.has(domain)) continue;
    for (const item of attributes.domains.filter((candidate) => candidate.domain === domain)) {
      if (evidence.some((known) => known.property === 'P856' && known.caseValue === domain)) continue;
      evidence.push({
        kind: 'website',
        property: 'P856',
        propertyLabel: 'oficjalna strona',
        wikidataValue: url,
        caseValue: domain,
        caseSource: item.source,
        origin: item.origin,
        explanation: `Oficjalna strona we wpisie Wikidata (P856) ${url} — ta sama domena ${domain} co ${originText[item.origin]} (${item.source}).`,
      });
    }
  }
  // Najpierw dane analityka, potem profile, na końcu odnośniki w profilach.
  const order: PublicFigureEvidence['origin'][] = ['analyst', 'profile', 'profile_link'];
  return evidence.sort((a, b) => order.indexOf(a.origin) - order.indexOf(b.origin));
}

// ---------- Dopasowanie podmiotu do wpisu osoby ----------

export interface ResolveParams {
  /** Imiona i nazwiska podmiotu (wejście analityka, nazwa kandydata głównego). */
  names: string[];
  attributes: CaseAttributes;
  client: WikidataClient;
}

/** Wpis osoby (P31 = człowiek) o dokładnie zgodnej etykiecie albo aliasie; wynik — hipoteza albo lista kandydatów. */
export async function resolvePublicFigure(params: ResolveParams): Promise<PublicFigure | undefined> {
  const names = [...new Set(params.names.map((name) => name.trim()).filter((name) => name.split(/\s+/).length >= 2))].slice(0, 2);
  if (names.length === 0) return undefined;
  const keys = new Set(names.map(personNameKey));
  const hits: string[] = [];
  for (const name of names) {
    for (const language of ['en', 'pl']) {
      const { json } = await params.client.get(`${WIKIDATA_API}?action=wbsearchentities&search=${encodeURIComponent(name)}&language=${language}&uselang=${language}&type=item&limit=10&format=json`);
      for (const hit of arr(json?.search).map(obj)) {
        const id = str(hit?.id);
        const texts = [str(hit?.label), str(obj(hit?.match)?.text), ...arr(hit?.aliases).map(str)].filter((item): item is string => Boolean(item));
        if (id && texts.some((text) => keys.has(personNameKey(text))) && !hits.includes(id)) hits.push(id);
      }
    }
  }
  if (hits.length === 0) return undefined;
  const found = await params.client.entities(hits.slice(0, 20));
  const humans = hits.filter((id) => {
    const entity = found.get(id);
    return entity !== undefined && isHuman(entity) && namesOf(entity).some((text) => keys.has(personNameKey(text)));
  });
  if (humans.length === 0) return undefined;
  const sources = params.client.sources.slice(-3);
  const assessed = humans.map((id) => ({ id, entity: found.get(id)!, evidence: corroborationOf(found.get(id)!, params.attributes) }));
  const candidate = (item: (typeof assessed)[number]): PublicFigureCandidate => ({
    wikidataId: item.id,
    label: labelOf(item.entity, item.id),
    ...(descriptionOf(item.entity) ? { description: descriptionOf(item.entity)! } : {}),
    url: entityUrl(item.id),
    corroborated: item.evidence.length > 0,
  });
  const corroborated = assessed.filter((item) => item.evidence.length > 0);
  const query = names[0]!;
  // Kilka osób, a drugą cechą zgadza się dokładnie jedna — ta jest hipotezą, pozostałe zostają kandydatami.
  const chosen = corroborated.length === 1 ? corroborated[0]! : assessed.length === 1 ? assessed[0]! : undefined;
  const others = assessed.filter((item) => item !== chosen).slice(0, PUBLIC_FIGURE_LIMITS.maxCandidates).map(candidate);
  if (!chosen) {
    return {
      query,
      matchedBy: [],
      status: 'hypothesis',
      match: 'ambiguous',
      candidates: assessed.slice(0, PUBLIC_FIGURE_LIMITS.maxCandidates).map(candidate),
      statement:
        `W Wikidata jest ${assessed.length} osób o imieniu i nazwisku „${query}”` +
        `${corroborated.length > 1 ? ` (drugą cechą zgadza się ${corroborated.length} z nich)` : ''} — nie wybrano żadnej automatycznie; wybór należy do analityka.`,
      notes: ['Wiele osób o tym samym imieniu i nazwisku: lista kandydatów bez automatycznego wyboru i bez rozwijania sieci.'],
      sources,
    };
  }
  const label = labelOf(chosen.entity, chosen.id);
  const description = descriptionOf(chosen.entity);
  const base = { query, wikidataId: chosen.id, label, ...(description ? { description } : {}), url: entityUrl(chosen.id), sources, ...(others.length > 0 ? { candidates: others } : {}) };
  if (chosen.evidence.length > 0) {
    return {
      ...base,
      matchedBy: chosen.evidence,
      status: 'hypothesis',
      match: 'corroborated',
      statement:
        `Możliwe dopasowanie do wpisu osoby publicznej: ${label} (Wikidata ${chosen.id}${description ? `, ${description}` : ''}) — zgodne imię i nazwisko oraz druga cecha: ` +
        `${chosen.evidence.map((item) => `${item.propertyLabel} „${item.caseValue}”`).join(', ')}. To hipoteza dopasowania do potwierdzenia przez analityka.`,
      notes: [
        ...(chosen.evidence.every((item) => item.origin === 'profile_link')
          ? ['Druga cecha pochodzi wyłącznie z odnośnika w profilu znalezionym w sprawie (profil może być kopią, mostem albo parodią) — dopasowanie wymaga potwierdzenia analityka.']
          : []),
        ...(others.length > 0 ? [`W Wikidata są też inne osoby o tym imieniu i nazwisku (${others.length}) — bez zgodnej drugiej cechy.`] : []),
      ],
    };
  }
  return {
    ...base,
    matchedBy: [],
    status: 'hypothesis',
    match: 'name_only',
    statement: `Możliwa osoba publiczna o tym nazwisku (niepotwierdzona): ${label} (Wikidata ${chosen.id}${description ? `, ${description}` : ''}) — zgodne tylko imię i nazwisko, żadna druga cecha sprawy nie zgadza się z wpisem. Sieci nie rozwijano; rozwinięcie po decyzji analityka.`,
    notes: ['Zgodne tylko imię i nazwisko — to może być inna osoba o tym samym nazwisku.'],
  };
}

// ---------- Sieć organizacji osoby publicznej ----------

export interface PublicFigureNetworkParams {
  wikidataId: string;
  label?: string;
  /** 1 — hipoteza dopasowania (druga cecha), 2 — dopasowanie potwierdzone przez analityka. */
  depth: 1 | 2;
  client: WikidataClient;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  signal?: AbortSignal;
  reserve?: () => boolean;
}

export interface PublicFigureNetworkResult {
  network: OrganizationNetwork;
  roles: PublicFigureRole[];
  cryptoAddresses: PublicFigureAddress[];
}

/** Osoba → organizacje (role z datami) → istniejący etap sieci organizacji dla najważniejszych z nich, w limitach. */
export async function buildPublicFigureNetwork(params: PublicFigureNetworkParams): Promise<PublicFigureNetworkResult> {
  const { client } = params;
  const qid = params.wikidataId;
  const log = params.log ?? (() => {});
  const notes: string[] = [];
  const person = (await client.entities([qid])).get(qid);
  const name = labelOf(person, params.label ?? qid);
  const retrievedAt = client.now().toISOString();
  const source = (url: string): RegistrySource => ({ registry: 'Wikidata', url, retrievedAt, terms: REGISTRY_TERMS.Wikidata });

  // Role zapisane we wpisie osoby (stanowisko z organizacją, pracodawca, członkostwo, własność).
  interface Draft { org: string; property: string; role: string; from?: string; to?: string; reference?: string; source: string; positionItem?: string }
  const drafts: Draft[] = [];
  for (const [property, role] of Object.entries(DIRECT_ROLES)) {
    for (const claim of claimsOf(person, property)) {
      const value = claimItem(claim);
      if (!value) continue;
      const org = property === 'P39' ? POSITION_ORG_QUALIFIERS.map((qualifier) => qualifierItem(claim, qualifier)).find(Boolean) : value;
      if (!org) continue;
      const from = qualifierTime(claim, 'P580');
      const to = qualifierTime(claim, 'P582');
      const reference = referenceUrl(claim);
      drafts.push({ org, property, role, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(reference ? { reference } : {}), source: `${entityUrl(qid)}#${property}`, ...(property === 'P39' ? { positionItem: value } : {}) });
    }
  }
  // Organizacje, których wpis wskazuje tę osobę (CEO, założyciel, przewodniczący, dyrektor, zarząd, właściciel) — wyszukiwarka Wikidata.
  const inverse = Object.keys(INVERSE_ROLES).map((property) => `${property}=${qid}`).join('|');
  const { json: search } = await client.get(`${WIKIDATA_API}?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:${inverse}`)}&srnamespace=0&srlimit=50&format=json`);
  const inverseIds = arr(obj(search?.query)?.search)
    .map((hit) => str(obj(hit)?.title))
    .filter((id): id is string => Boolean(id && /^Q\d+$/.test(id)));
  const orgIds = [...new Set([...drafts.map((draft) => draft.org), ...inverseIds, ...drafts.flatMap((draft) => (draft.positionItem ? [draft.positionItem] : []))])].filter((id) => id !== qid);
  const details = await client.entities(orgIds, 'labels|descriptions|claims');
  for (const id of inverseIds) {
    const entity = details.get(id);
    for (const [property, role] of Object.entries(INVERSE_ROLES)) {
      for (const claim of claimsOf(entity, property).filter((item) => claimItem(item) === qid)) {
        const from = qualifierTime(claim, 'P580');
        const to = qualifierTime(claim, 'P582');
        const reference = referenceUrl(claim);
        drafts.push({ org: id, property, role, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(reference ? { reference } : {}), source: `${entityUrl(id)}#${property}` });
      }
    }
  }
  // Tylko organizacje: ludzie i przedmioty (np. pojazd „należący do” osoby) nie są podmiotami sieci.
  let skippedObjects = 0;
  const usable = drafts.filter((draft) => {
    const entity = details.get(draft.org);
    if (!entity || isHuman(entity)) return false;
    const inverseOnly = draft.property === 'P112' || draft.property === 'P127' || draft.property === 'P1830';
    if (inverseOnly && !looksLikeOrganization(entity)) {
      skippedObjects++;
      return false;
    }
    return true;
  });
  if (skippedObjects > 0) notes.push(`Pominięto ${skippedObjects} wpisów wskazujących osobę jako założyciela lub właściciela, które nie wyglądają na organizacje (np. przedmioty, dzieła).`);
  const rank = (draft: Draft) => (draft.to ? 100 : 0) + ROLE_PRIORITY.indexOf(draft.property);
  usable.sort((a, b) => rank(a) - rank(b) || labelOf(details.get(a.org), a.org).localeCompare(labelOf(details.get(b.org), b.org), 'pl'));
  const orderedOrgs = [...new Set(usable.map((draft) => draft.org))];
  const kept = orderedOrgs.slice(0, PUBLIC_FIGURE_LIMITS.maxOrganizations);
  const skippedOrgs = orderedOrgs.length - kept.length;

  const roleText = (draft: Draft) => (draft.positionItem ? `${DIRECT_ROLES.P39}: ${labelOf(details.get(draft.positionItem), draft.positionItem)}` : draft.role);
  const presetOrganizations: OrgEntity[] = kept.map((id) => {
    const entity = details.get(id);
    const site = claimsOf(entity, 'P856').map(claimString).map((url) => (url ? hostOf(url) : undefined)).find(Boolean);
    const lei = claimsOf(entity, 'P1278').map(claimString).find(Boolean);
    return {
      id: `org:wikidata:${id}`,
      name: labelOf(entity, id),
      match: 'identifier',
      matchNote: `Wpis Wikidata ${id} — podmiot, w którym ${name} pełni rolę według Wikidata (rozpoznany po identyfikatorze QID).`,
      identifiers: { wikidata: id, ...(site ? { website: registrableDomain(site) } : {}), ...(lei ? { lei } : {}) },
      seed: false,
      addresses: [],
      sources: [source(entityUrl(id))],
    };
  });
  const keptSet = new Set(kept);
  const roles: PublicFigureRole[] = usable
    .filter((draft) => keptSet.has(draft.org))
    .map((draft) => ({
      organizationId: `org:wikidata:${draft.org}`,
      organization: labelOf(details.get(draft.org), draft.org),
      wikidataOrganization: draft.org,
      property: draft.property,
      role: roleText(draft),
      ...(draft.from ? { from: draft.from } : {}),
      ...(draft.to ? { to: draft.to } : {}),
      ...(draft.reference ? { reference: draft.reference } : {}),
      source: draft.source,
    }));
  const presetPersons: Omit<PersonInRole, 'relation'>[] = roles.map((role) => ({
    id: `person:wikidata:${qid}:${role.organizationId}:${role.property}${role.from ? `:${role.from}` : ''}`,
    name,
    masked: false,
    role: role.role,
    organizationId: role.organizationId,
    ...(role.from ? { from: role.from } : {}),
    ...(role.to ? { to: role.to } : {}),
    source: source(role.source),
    wikidata: qid,
  }));

  // Krok 1 (i 2 po potwierdzeniu) istniejącego etapu sieci organizacji dla najważniejszych podmiotów.
  const expandCount = PUBLIC_FIGURE_LIMITS.expandOrganizations[params.depth];
  const seeds = kept.slice(0, expandCount).map((id) => ({ name: labelOf(details.get(id), id), wikidata: id, addresses: [], origin: `organizacja osoby publicznej ${name} (Wikidata ${qid})` }));
  const network = await buildOrganizationNetwork({
    seeds,
    ...(params.fetch ? { fetch: params.fetch } : {}),
    deep: params.depth >= 2,
    now: () => client.now(),
    log,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.reserve ? { reserve: params.reserve } : {}),
    limits: {
      maxOrganizations: PUBLIC_FIGURE_LIMITS.maxOrganizations,
      maxPersons: PUBLIC_FIGURE_LIMITS.maxPersons,
      maxPersonLinks: PUBLIC_FIGURE_LIMITS.maxPersonLinks,
      maxRequests: Math.max(0, PUBLIC_FIGURE_LIMITS.maxRequests - client.requests),
    },
    entityCache: client.cache,
    preset: { organizations: presetOrganizations, persons: presetPersons },
    centralPerson: qid,
    skipNonprofitSearch: true,
  });
  network.sources.unshift(...client.sources);
  if (skippedOrgs > 0) {
    network.stops.unshift({ stage: 'organizations', reason: 'query_limit', detail: `Osoba publiczna: limit ${PUBLIC_FIGURE_LIMITS.maxOrganizations} organizacji — pominięto ${skippedOrgs} dalszych podmiotów z rolami tej osoby.`, skipped: skippedOrgs });
  }
  if (kept.length > expandCount) {
    network.stops.unshift({
      stage: 'organizations',
      reason: 'depth_limit',
      detail: `Osoba publiczna: osoby w rolach i podmioty powiązane rozwinięto dla ${expandCount} najważniejszych organizacji (bieżące role, zarząd, założyciel); pozostałe ${kept.length - expandCount} pokazano z rolą osoby — każdą można rozwinąć osobno („Rozwiń”).`,
      skipped: kept.length - expandCount,
    });
  }
  if (client.limitHit > 0) network.stops.unshift({ stage: 'organizations', reason: 'query_limit', detail: `Osoba publiczna: limit ${PUBLIC_FIGURE_LIMITS.maxRequests} zapytań do Wikidata (albo budżet) — pominięto ${client.limitHit} zapytań.`, skipped: client.limitHit });
  if (client.failures.length > 0) network.stops.unshift({ stage: 'organizations', reason: 'source_error', detail: `Wikidata nie odpowiedziała (${client.failures.length}×: ${client.failures[0]}) — sieć osoby publicznej jest niepełna.`, skipped: client.failures.length });
  network.notes.push(
    ...notes,
    `Sieć osoby publicznej ${name} (Wikidata ${qid}): organizacje rozpoznane po identyfikatorze QID; role z dat i przypisów Wikidata. Rola w organizacji nie oznacza własności adresu; relacja nie jest dowodem.`,
  );

  // Adresy kryptowalutowe podane we wpisach bytów sieci (właściwość istnieje tylko dla kontraktów tokenów Ethereum).
  const cryptoAddresses: PublicFigureAddress[] = [];
  const entityIds = new Map<string, { id: string; name: string }>([[qid, { id: `regperson:${qid}`, name }], ...network.organizations.filter((org) => org.identifiers.wikidata).map((org) => [org.identifiers.wikidata!, { id: org.id, name: org.name }] as const)]);
  for (const [wikidataId, target] of entityIds) {
    const entity = client.cache.get(wikidataId);
    for (const [property, propertyLabel] of Object.entries(CRYPTO_PROPERTIES)) {
      for (const value of claimsOf(entity, property).map(claimString)) {
        const valid = value ? validateAddress(value) : null;
        if (!valid || cryptoAddresses.some((item) => item.address === valid.address)) continue;
        cryptoAddresses.push({
          entityId: target.id,
          entityName: target.name,
          network: valid.network,
          address: valid.address,
          property,
          propertyLabel,
          source: `${entityUrl(wikidataId)}#${property}`,
          note: `Wikidata podaje dla „${target.name}” ${propertyLabel} (${property}) — adres kandydujący bytu z rejestru (fakt o wpisie, nie o właścicielu środków); analiza łańcucha przez „Rozwiń”.`,
        });
      }
    }
  }
  log(`[osoba publiczna] ${name} (${qid}): organizacji ${network.organizations.length}, osób w rolach ${network.persons.length}, relacji ${network.relations.length}, zapytań Wikidata ${client.requests}.`);
  return { network, roles, cryptoAddresses };
}

// ---------- Relacje rodzinne (wyłącznie na żądanie) ----------

export interface FamilyRelation {
  wikidataId: string;
  label: string;
  description?: string;
  property: string;
  relation: string;
  source: string;
  retrievedAt: string;
}

/** Osoby wskazane we wpisie relacjami rodzinnymi — tylko te, które same mają wpis w Wikidata (identyfikator QID). */
export async function familyOf(wikidataId: string, client: WikidataClient): Promise<FamilyRelation[]> {
  const person = (await client.entities([wikidataId])).get(wikidataId);
  const drafts = Object.entries(FAMILY_PROPERTIES).flatMap(([property, relation]) =>
    claimsOf(person, property)
      .map(claimItem)
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id, property, relation })),
  );
  if (drafts.length === 0) return [];
  const related = await client.entities(drafts.map((draft) => draft.id).slice(0, 40), 'labels|descriptions|claims');
  const retrievedAt = client.now().toISOString();
  return drafts
    .filter((draft) => related.has(draft.id) && isHuman(related.get(draft.id)))
    .map((draft) => ({
      wikidataId: draft.id,
      label: labelOf(related.get(draft.id), draft.id),
      ...(descriptionOf(related.get(draft.id)) ? { description: descriptionOf(related.get(draft.id))! } : {}),
      property: draft.property,
      relation: draft.relation,
      source: `${entityUrl(wikidataId)}#${draft.property}`,
      retrievedAt,
    }));
}

// ---------- Etap analizy ----------

export interface PublicFigureStageParams {
  names: string[];
  identifiers: Identifier[];
  profiles: CaseProfileInput[];
  fetch?: typeof fetch;
  now?: () => Date;
  log?: (message: string) => void;
  signal?: AbortSignal;
  reserve?: () => boolean;
}

/**
 * Dopasowanie podmiotu do osoby publicznej i — tylko przy drugiej zgodnej cesze — automatyczne rozwinięcie sieci
 * (głębokość 1). Bez drugiej cechy: wpis kandydujący, bez rozwijania.
 */
export async function runPublicFigureStage(params: PublicFigureStageParams): Promise<{ publicFigure?: PublicFigure; network?: OrganizationNetwork }> {
  const client = createWikidataClient({
    ...(params.fetch ? { fetch: params.fetch } : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.reserve ? { reserve: params.reserve } : {}),
  });
  const figure = await resolvePublicFigure({ names: params.names, attributes: caseAttributesFrom(params.identifiers, params.profiles), client });
  if (!figure) {
    if (client.failures.length > 0) params.log?.(`[osoba publiczna] Wikidata nie odpowiedziała — dopasowania nie sprawdzono (${client.failures[0]}).`);
    return {};
  }
  if (figure.match !== 'corroborated' || !figure.wikidataId) {
    params.log?.(`[osoba publiczna] ${figure.statement}`);
    return { publicFigure: figure };
  }
  const depth = PUBLIC_FIGURE_LIMITS.depthHypothesis as 1;
  const { network, roles, cryptoAddresses } = await buildPublicFigureNetwork({
    wikidataId: figure.wikidataId,
    ...(figure.label ? { label: figure.label } : {}),
    depth,
    client,
    ...(params.fetch ? { fetch: params.fetch } : {}),
    ...(params.log ? { log: params.log } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.reserve ? { reserve: params.reserve } : {}),
  });
  return {
    publicFigure: {
      ...figure,
      roles,
      ...(cryptoAddresses.length > 0 ? { cryptoAddresses } : {}),
      expansion: { depth, automatic: true, note: 'Rozwinięto automatycznie na głębokość 1 — dopasowanie potwierdzone drugą cechą (hipoteza). Po potwierdzeniu przez analityka: głębokość 2.' },
    },
    network,
  };
}

// ---------- Teczka: decyzja analityka, scalanie sieci, liczniki, graf ----------

export interface PublicFigureDecision {
  target: string;
  key: string;
  decision: 'confirmed' | 'rejected';
  decidedAt: string;
  author: string;
  note?: string;
  withdrawnAt?: string;
}

/** Obowiązująca decyzja analityka (najnowsza, niewycofana) zmienia status dopasowania; wybór kandydata to też decyzja. */
export function applyPublicFigureDecision(figure: PublicFigure | undefined, decisions: PublicFigureDecision[]): PublicFigure | undefined {
  if (!figure) return undefined;
  const active = decisions.filter((item) => item.target === 'public_figure' && !item.withdrawnAt);
  const latest = new Map<string, PublicFigureDecision>();
  for (const decision of active) latest.set(decision.key.trim().toUpperCase(), decision);
  const confirmed = [...latest.values()].filter((item) => item.decision === 'confirmed').at(-1);
  const withDecision = (decision: PublicFigureDecision) => ({ decision: decision.decision, decidedAt: decision.decidedAt, author: decision.author, ...(decision.note ? { note: decision.note } : {}) });
  if (confirmed) {
    const key = confirmed.key.trim().toUpperCase();
    if (key === figure.wikidataId) return { ...figure, status: 'confirmed', decision: withDecision(confirmed) };
    const chosen = figure.candidates?.find((item) => item.wikidataId === key);
    if (chosen) {
      return {
        ...figure,
        wikidataId: chosen.wikidataId,
        label: chosen.label,
        ...(chosen.description ? { description: chosen.description } : {}),
        url: chosen.url,
        status: 'confirmed',
        candidates: [
          ...(figure.wikidataId && figure.label && figure.url ? [{ wikidataId: figure.wikidataId, label: figure.label, ...(figure.description ? { description: figure.description } : {}), url: figure.url, corroborated: figure.matchedBy.length > 0 }] : []),
          ...(figure.candidates ?? []).filter((item) => item.wikidataId !== key),
        ],
        matchedBy: [],
        roles: undefined,
        cryptoAddresses: undefined,
        expansion: undefined,
        decision: withDecision(confirmed),
      } as PublicFigure;
    }
  }
  const rejected = figure.wikidataId ? latest.get(figure.wikidataId) : undefined;
  if (rejected?.decision === 'rejected') return { ...figure, status: 'rejected', decision: withDecision(rejected) };
  return figure;
}

/** Suma dwóch sieci organizacji (bez powtórzeń po identyfikatorach) — sieć z analizy + sieć osoby publicznej. */
export function mergeOrganizationNetworks(base: OrganizationNetwork | undefined, extra: OrganizationNetwork | undefined): OrganizationNetwork | undefined {
  if (!base) return extra;
  if (!extra) return base;
  const byId = <T,>(items: T[], key: (item: T) => string) => [...new Map(items.map((item) => [key(item), item] as const)).values()];
  return {
    organizations: byId([...base.organizations, ...extra.organizations], (org) => org.id),
    persons: byId([...base.persons, ...extra.persons], (person) => person.id),
    relations: byId([...base.relations, ...extra.relations], (relation) => `${relation.kind}|${relation.from}|${relation.to}`),
    personLinks: byId([...base.personLinks, ...extra.personLinks], (link) => `${link.a}|${link.b}`),
    sources: [...base.sources, ...extra.sources],
    stops: [...base.stops, ...extra.stops],
    notes: [...new Set([...base.notes, ...extra.notes])],
    limits: base.limits,
  };
}

/** Liczniki siatki: organizacje, osoby (różne), relacje (role, relacje organizacji, powiązania osób). */
export function networkCounts(network: OrganizationNetwork | undefined): { organizations: number; persons: number; relations: number } {
  if (!network) return { organizations: 0, persons: 0, relations: 0 };
  return {
    organizations: network.organizations.length,
    persons: new Set(network.persons.map((person) => person.wikidata ?? person.id)).size,
    relations: network.persons.length + network.relations.length + network.personLinks.length,
  };
}

export interface FigureGraphNode {
  id: string;
  kind: 'person' | 'address';
  label: string;
  sublabel?: string;
  status?: 'hypothesis' | 'confirmed' | 'source_fact' | 'rejected';
  url?: string;
  meta?: Record<string, unknown>;
}
export interface FigureGraphEdge {
  id: string;
  from: string;
  to: string;
  kind: 'related' | 'documented_by';
  label: string;
  status: 'hypothesis' | 'confirmed' | 'source_fact' | 'rejected';
  inferred?: boolean;
  layer: 'identity';
  evidence: { kind: 'url'; value: string }[];
  explanation: string;
}

/** Klucz węzła osoby publicznej — ten sam co osoby w roli z rejestru (`regperson:Q…`), więc role dopinają się do niego. */
export const publicFigureNodeId = (wikidataId: string) => `regperson:${wikidataId}`;

/** Węzeł osoby publicznej (warstwa tożsamości) połączony z podmiotem krawędzią „dopasowanie do wpisu Wikidata”. */
export function publicFigureGraph(figure: PublicFigure | undefined, subjectId: string): { nodes: FigureGraphNode[]; edges: FigureGraphEdge[] } {
  if (!figure?.wikidataId || !figure.url || figure.status === 'rejected') return { nodes: [], edges: [] };
  const id = publicFigureNodeId(figure.wikidataId);
  const confirmed = figure.status === 'confirmed';
  const weak = figure.match !== 'corroborated' && !confirmed;
  const nodes: FigureGraphNode[] = [
    {
      id,
      kind: 'person',
      label: figure.label ?? figure.wikidataId,
      sublabel: weak
        ? 'możliwa osoba publiczna o tym nazwisku (niepotwierdzona)'
        : `osoba publiczna (Wikidata ${figure.wikidataId}) · ${confirmed ? 'dopasowanie potwierdzone przez analityka' : 'hipoteza dopasowania'}`,
      status: confirmed ? 'confirmed' : 'hypothesis',
      url: figure.url,
      meta: { registry: { wikidata: figure.wikidataId }, publicFigure: confirmed ? 'confirmed' : figure.match },
    },
  ];
  const edges: FigureGraphEdge[] = [
    {
      id: `publicfigure:${subjectId}->${id}`,
      from: subjectId,
      to: id,
      kind: 'related',
      label: 'dopasowanie do wpisu Wikidata',
      status: confirmed ? 'confirmed' : 'hypothesis',
      ...(confirmed ? {} : { inferred: true }),
      layer: 'identity',
      evidence: [{ kind: 'url', value: figure.url }, ...[...new Set(figure.matchedBy.map((item) => item.caseSource))].filter((value) => /^https?:\/\//.test(value)).map((value) => ({ kind: 'url' as const, value }))],
      explanation: `${figure.statement}${figure.matchedBy.length > 0 ? ` Dowody: ${figure.matchedBy.map((item) => item.explanation).join(' ')}` : ''}`,
    },
  ];
  for (const item of figure.cryptoAddresses ?? []) {
    const addressId = `addr:${item.network}:${item.address}`;
    nodes.push({ id: addressId, kind: 'address', label: `${item.address.slice(0, 8)}…${item.address.slice(-6)}`, sublabel: `${item.propertyLabel} (Wikidata) — adres kandydujący`, status: 'source_fact', url: item.source });
    edges.push({ id: `wikidata-address:${item.entityId}->${addressId}`, from: item.entityId, to: addressId, kind: 'documented_by', label: `${item.propertyLabel} według Wikidata (${item.property})`, status: 'source_fact', layer: 'identity', evidence: [{ kind: 'url', value: item.source }], explanation: item.note });
  }
  return { nodes, edges };
}

/** Zdanie kluczowych ustaleń o osobie publicznej (wniosek — dopasowanie jest hipotezą do potwierdzenia). */
export function publicFigureFinding(figure: PublicFigure | undefined): { text: string; layer: 'inference' } | undefined {
  if (!figure || figure.status === 'rejected') return undefined;
  const counts = figure.counts && figure.counts.organizations > 0 ? ` Siatka: ${figure.counts.organizations} organizacji, ${figure.counts.persons} osób, ${figure.counts.relations} relacji.` : '';
  const status = figure.status === 'confirmed' ? ' Dopasowanie potwierdził analityk.' : '';
  return { text: `${figure.statement}${status}${counts} Rola w organizacji nie oznacza własności adresu; relacja nie jest dowodem.`, layer: 'inference' };
}
