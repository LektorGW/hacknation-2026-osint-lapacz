// Klient RDAP (Registration Data Access Protocol, RFC 9082/9083): domena → dane abonenta, jeśli rejestr
// je publikuje. Rejestr właściwy dla domeny wskazuje plik IANA (RFC 9224, https://data.iana.org/rdap/dns.json).
// Zasady: jedno zapytanie o domenę (plik IANA pobierany raz na proces), jawny User-Agent, limit czasu,
// odmowa (4xx/5xx) kończy sprawę — bez ponawiania. Dane osobowe rejestry redagują (RODO) — niczego nie odtwarzamy.
// Zapytanie wysyła nazwę domeny do rejestru, więc klient działa wyłącznie przy włączonych źródłach publicznych.

export const RDAP_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';
export const RDAP_USER_AGENT = 'OLCyS-research/0.1 (hackathon KAS; rozwijanie sieci, RDAP)';
const TIMEOUT_MS = 10_000;

export interface RdapRegistrant {
  domain: string;
  /** Nazwa organizacji abonenta (gdy nie jest zredagowana). */
  organization?: string;
  /** Imię i nazwisko abonenta — tylko gdy rejestr je publikuje (zwykle zredagowane). */
  name?: string;
  country?: string;
  registrar?: string;
  /** Rejestr zredagował dane abonenta (RODO) — brak organizacji nie znaczy, że jej nie ma. */
  redacted: boolean;
  url: string;
  retrievedAt: string;
}

export interface RdapClient {
  lookup(domain: string, signal?: AbortSignal): Promise<RdapRegistrant | null>;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | undefined => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined);
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** Pole vCard (jCard: `["vcard", [[nazwa, {}, typ, wartość], …]]`). */
function vcardField(entity: Json, field: string): string | undefined {
  const card = arr(arr(entity.vcardArray)[1]);
  for (const item of card) {
    const row = arr(item);
    if (row[0] === field) {
      const value = row[3];
      if (Array.isArray(value)) return value.filter((part) => typeof part === 'string' && part.trim()).join(', ') || undefined;
      return str(value);
    }
  }
  return undefined;
}

const REDACTED = /redact|privacy|withheld|not disclosed|data protected|gdpr|rodo|ukryt/i;

/** Odczyt odpowiedzi RDAP dla domeny — wyłącznie pola publikowane przez rejestr. */
export function parseRdapDomain(domain: string, json: Json, url: string, retrievedAt: string): RdapRegistrant {
  const entities = arr(json.entities).map(obj).filter((item): item is Json => item !== undefined);
  const withRole = (role: string) => entities.find((entity) => arr(entity.roles).includes(role));
  const registrant = withRole('registrant');
  const registrar = withRole('registrar');
  const organization = registrant ? vcardField(registrant, 'org') : undefined;
  const name = registrant ? vcardField(registrant, 'fn') : undefined;
  const adr = registrant ? arr(arr(arr(registrant.vcardArray)[1]).find((row) => arr(row)[0] === 'adr')) : [];
  const country = str(obj(adr[1])?.['cc']) ?? str(arr(adr[3]).at(-1));
  const redactedMarks = arr(json.redacted).length > 0 || [organization, name].some((value) => value !== undefined && REDACTED.test(value));
  const clean = (value: string | undefined) => (value && !REDACTED.test(value) ? value : undefined);
  return {
    domain,
    ...(clean(organization) ? { organization: clean(organization)! } : {}),
    ...(clean(name) && clean(name) !== clean(organization) ? { name: clean(name)! } : {}),
    ...(country ? { country } : {}),
    ...(registrar ? { registrar: vcardField(registrar, 'fn') ?? vcardField(registrar, 'org') } : {}),
    redacted: redactedMarks || !registrant || (!clean(organization) && !clean(name)),
    url,
    retrievedAt,
  };
}

export function createRdapClient(options: { fetch?: typeof fetch; now?: () => Date; bootstrapUrl?: string } = {}): RdapClient {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  let services: Promise<[string[], string[]][]> | undefined;
  const get = async (url: string, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const response = await doFetch(url, { headers: { 'User-Agent': RDAP_USER_AGENT, Accept: 'application/rdap+json, application/json' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!response.ok) throw new Error(`kod ${response.status}`);
    return obj(await response.json()) ?? {};
  };
  const baseFor = async (domain: string, signal?: AbortSignal): Promise<string | undefined> => {
    services ??= get(options.bootstrapUrl ?? RDAP_BOOTSTRAP, signal).then((json) => arr(json.services).map((row) => [arr(arr(row)[0]).map(String), arr(arr(row)[1]).map(String)] as [string[], string[]]));
    let list: [string[], string[]][];
    try {
      list = await services;
    } catch (error) {
      services = undefined;
      throw error;
    }
    const labels = domain.toLowerCase().split('.');
    // Najdłuższe pasujące zakończenie (np. „com.pl” przed „pl”).
    for (let at = 0; at < labels.length; at++) {
      const suffix = labels.slice(at).join('.');
      const hit = list.find(([tlds]) => tlds.includes(suffix));
      if (hit) return hit[1].find((url) => url.startsWith('https://')) ?? hit[1][0];
    }
    return undefined;
  };
  return {
    async lookup(domain, signal) {
      const base = await baseFor(domain, signal);
      if (!base) return null;
      const url = `${base.replace(/\/+$/, '')}/domain/${encodeURIComponent(domain)}`;
      const retrievedAt = now().toISOString();
      const json = await get(url, signal);
      return parseRdapDomain(domain, json, url, retrievedAt);
    },
  };
}
