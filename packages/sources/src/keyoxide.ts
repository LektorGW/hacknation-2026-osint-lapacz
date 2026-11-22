// Łącznik dowodów tożsamości Ariadne / Keyoxide, weryfikowanych LOKALNIE.
//
// Właściciel klucza OpenPGP wpisuje do podpisu własnego klucza adnotacje `proof@ariadne.id=<adres konta>`
// (deklaracja podpisana kluczem), a na koncie w innym serwisie publikuje odcisk klucza (`openpgp4fpr:<odcisk>`).
// Dowód jest dwustronny: klucz wskazuje konto i konto wskazuje klucz. Tylko taki potwierdzony w obie strony
// dowód daje dokument `verified_link`; deklaracje niesprawdzone są słabymi identyfikatorami odkrytymi.
//
// Podstawa (sprawdzone 22.11.2026, wiersze w docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 12):
//   • API keyoxide.org (https://spec.keyoxide.org/spec/2/, `/api/3/profile/fetch?doVerification=true`) — NIE jest używane:
//     https://keyoxide.org/robots.txt to „User-agent: * / Allow: /$ / Disallow: /”, serwis nie publikuje warunków
//     korzystania z API, a weryfikacja po stronie serwera pobierałaby cudze serwisy w naszym imieniu (pośrednik).
//   • Klucz pobieramy z keys.openpgp.org (rozdz. 7, ten sam host i limity co `live-openpgp`): „GET /vks/v1/by-email/…”,
//     „GET /vks/v1/by-fingerprint/…” (https://keys.openpgp.org/about/api).
//   • Dowody sprawdzamy wyłącznie w serwisach, które narzędzie i tak odpytuje na własnych zasadach: API GitHuba (gist),
//     API Codeberg i GitLab (opis repozytorium dowodowego) oraz rekord DNS TXT domeny (zapytanie DNS, bez HTTP).
//     Pozostałe deklaracje (Mastodon, Matrix, XMPP…) zostają oznaczone „niesprawdzone”.

import { Resolver } from 'node:dns/promises';
import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from './http.ts';
import type { HttpClient, HttpSession } from './http.ts';
import { dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier } from './identity.ts';
import { parseArmoredKey } from './openpgp.ts';

const ID = 'live-keyoxide';
const SERVICE = 'keys.openpgp.org';
const LABEL = 'Dowody tożsamości Ariadne (Keyoxide)';
const KOO = 'https://keys.openpgp.org/vks/v1';
const MIN_INTERVAL_MS = 5000;
export const KEYOXIDE_HOURLY_LIMIT = 30;
/** Najwyżej tyle deklaracji sprawdzamy w serwisach (HTTP) dla jednego klucza. */
const MAX_HTTP_CHECKS = 3;
const MAX_DNS_CHECKS = 2;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const FINGERPRINT = /^(?:openpgp4fpr:)?([0-9A-Fa-f]{40})$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NOTATION_NAMES = new Set(['proof@ariadne.id', 'proof@metacode.biz']);

// ---------- Pakiety OpenPGP ----------

interface Packet {
  tag: number;
  body: Uint8Array;
}

function armorBytes(armored: string): Uint8Array | null {
  const match = /-----BEGIN PGP PUBLIC KEY BLOCK-----([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/.exec(armored);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/).map((line) => line.trim());
  const firstBlank = lines.findIndex((line, i) => i > 0 && line === '');
  const hasHeaders = lines.some((line) => /^[A-Za-z-]+: /.test(line));
  const body = lines
    .slice(hasHeaders && firstBlank >= 0 ? firstBlank : 0)
    .filter((line) => line && !line.startsWith('=') && /^[A-Za-z0-9+/=]+$/.test(line))
    .join('');
  return new Uint8Array(Buffer.from(body, 'base64'));
}

function readPackets(bytes: Uint8Array): Packet[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < view.length && packets.length < 1000) {
    const header = view[offset++]!;
    if ((header & 0x80) === 0) break;
    let tag: number;
    let length: number;
    if (header & 0x40) {
      tag = header & 0x3f;
      const first = view[offset++]!;
      if (first < 192) length = first;
      else if (first < 224) length = ((first - 192) << 8) + view[offset++]! + 192;
      else if (first === 255) {
        length = view.readUInt32BE(offset);
        offset += 4;
      } else break;
    } else {
      tag = (header >> 2) & 0x0f;
      const kind = header & 0x03;
      if (kind === 0) length = view[offset++]!;
      else if (kind === 1) {
        length = view.readUInt16BE(offset);
        offset += 2;
      } else if (kind === 2) {
        length = view.readUInt32BE(offset);
        offset += 4;
      } else break;
    }
    if (offset + length > view.length) break;
    packets.push({ tag, body: view.subarray(offset, offset + length) });
    offset += length;
  }
  return packets;
}

interface SignatureInfo {
  type: number;
  created: number;
  issuerFingerprint?: string;
  notations: { name: string; value: string }[];
}

/** Podpisy w wersji 4 i 6: tylko podpakiety haszowane (objęte podpisem) — niehaszowanych nie wolno uznać za deklarację. */
function readSignature(body: Uint8Array): SignatureInfo | null {
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const version = view[0];
  if (version !== 4 && version !== 6) return null;
  const lengthBytes = version === 4 ? 2 : 4;
  if (view.length < 4 + lengthBytes) return null;
  const hashedLength = version === 4 ? view.readUInt16BE(4) : view.readUInt32BE(4);
  const start = 4 + lengthBytes;
  const end = Math.min(start + hashedLength, view.length);
  const info: SignatureInfo = { type: view[1]!, created: 0, notations: [] };
  let offset = start;
  while (offset < end) {
    const first = view[offset++]!;
    let length: number;
    if (first < 192) length = first;
    else if (first < 255) length = ((first - 192) << 8) + view[offset++]! + 192;
    else {
      length = view.readUInt32BE(offset);
      offset += 4;
    }
    if (length < 1 || offset + length > end) break;
    const type = view[offset]! & 0x7f;
    const data = view.subarray(offset + 1, offset + length);
    offset += length;
    if (type === 2 && data.length >= 4) info.created = data.readUInt32BE(0);
    if (type === 33 && data.length >= 21) info.issuerFingerprint = Buffer.from(data.subarray(1)).toString('hex').toUpperCase();
    if (type === 20 && data.length >= 8) {
      const nameLength = data.readUInt16BE(4);
      const valueLength = data.readUInt16BE(6);
      if (8 + nameLength + valueLength > data.length) continue;
      info.notations.push({
        name: data.subarray(8, 8 + nameLength).toString('utf8'),
        value: data.subarray(8 + nameLength, 8 + nameLength + valueLength).toString('utf8'),
      });
    }
  }
  return info;
}

export interface AriadneClaim {
  /** Adres konta lub zasobu zadeklarowany przez właściciela klucza. */
  uri: string;
  /** Identyfikator użytkownika klucza (np. „Imię <adres>”), którego podpis zawiera deklarację. */
  userId: string;
}

/**
 * Deklaracje `proof@ariadne.id` z klucza w osłonie ASCII: dla każdego identyfikatora użytkownika bierzemy
 * najnowszy podpis certyfikujący wystawiony przez sam klucz (starsze są zastąpione i mogą zawierać wycofane deklaracje).
 */
export function ariadneClaims(armored: string): { fingerprint?: string; claims: AriadneClaim[] } {
  const bytes = armorBytes(armored);
  const key = parseArmoredKey(armored);
  if (!bytes || !key) return { claims: [] };
  const fingerprint = key.fingerprint;
  const newest = new Map<string, SignatureInfo>();
  let currentUid: string | null = null;
  for (const packet of readPackets(bytes)) {
    if (packet.tag === 14) currentUid = null; // podklucz: jego podpisy nie dotyczą identyfikatorów
    if (packet.tag === 13) currentUid = Buffer.from(packet.body).toString('utf8').replace(/[\u0000-\u001f]/g, ' ').trim();
    if (packet.tag !== 2 || currentUid === null) continue;
    const signature = readSignature(packet.body);
    if (!signature || signature.type < 0x10 || signature.type > 0x13) continue;
    if (signature.issuerFingerprint && fingerprint && signature.issuerFingerprint !== fingerprint) continue;
    const previous = newest.get(currentUid);
    if (!previous || signature.created >= previous.created) newest.set(currentUid, signature);
  }
  const claims: AriadneClaim[] = [];
  const seen = new Set<string>();
  for (const [userId, signature] of newest) {
    for (const notation of signature.notations) {
      const uri = notation.value.trim();
      if (!NOTATION_NAMES.has(notation.name) || !uri || seen.has(uri) || claims.length >= 30) continue;
      seen.add(uri);
      claims.push({ uri, userId });
    }
  }
  return { ...(fingerprint ? { fingerprint } : {}), claims };
}

// ---------- Weryfikacja deklaracji ----------

type ClaimKind = 'github' | 'codeberg' | 'gitlab' | 'dns' | 'other';

interface ClassifiedClaim extends AriadneClaim {
  kind: ClaimKind;
  /** Nazwa konta albo domena. */
  account?: string;
  /** Usługa konta (host) — `service` dokumentu dowodu. */
  service?: string;
  /** Adres profilu konta (identyfikator do dalszego wyszukiwania). */
  profileUrl?: string;
  /** Zasób dowodu w API serwisu. */
  proofApi?: string;
}

export function classifyClaim(claim: AriadneClaim): ClassifiedClaim {
  const dns = /^dns:([^?]+)(?:\?.*)?$/i.exec(claim.uri);
  if (dns) {
    const domain = dns[1]!.toLowerCase();
    return DOMAIN.test(domain) ? { ...claim, kind: 'dns', account: domain, service: domain, profileUrl: `https://${domain}/` } : { ...claim, kind: 'other' };
  }
  const url = parseHttpUrl(claim.uri);
  if (!url || url.protocol !== 'https:') return { ...claim, kind: 'other' };
  const parts = url.pathname.split('/').filter(Boolean);
  const host = url.hostname.toLowerCase();
  if (host === 'gist.github.com' && parts.length === 2 && /^[A-Za-z0-9-]{1,39}$/.test(parts[0]!) && /^[0-9a-f]{1,64}$/i.test(parts[1]!)) {
    return { ...claim, kind: 'github', account: parts[0], service: 'github.com', profileUrl: `https://github.com/${parts[0]}`, proofApi: `https://api.github.com/gists/${parts[1]}` };
  }
  if (host === 'codeberg.org' && parts.length === 2 && /^(?:gitea|forgejo)_proof$/.test(parts[1]!) && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/.test(parts[0]!)) {
    return { ...claim, kind: 'codeberg', account: parts[0], service: 'codeberg.org', profileUrl: `https://codeberg.org/${parts[0]}`, proofApi: `https://codeberg.org/api/v1/repos/${parts[0]}/${parts[1]}` };
  }
  if (host === 'gitlab.com' && parts.length === 2 && parts[1] === 'gitlab_proof' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(parts[0]!)) {
    return { ...claim, kind: 'gitlab', account: parts[0], service: 'gitlab.com', profileUrl: `https://gitlab.com/${parts[0]}`, proofApi: `https://gitlab.com/api/v4/projects/${encodeURIComponent(`${parts[0]}/gitlab_proof`)}` };
  }
  return { ...claim, kind: 'other' };
}

const KIND_LABEL: Record<ClaimKind, string> = { github: 'GitHub (gist)', codeberg: 'Codeberg', gitlab: 'GitLab', dns: 'domena (DNS TXT)', other: 'inny serwis' };

type ClaimStatus = 'verified' | 'failed' | 'unchecked';

const STATUS_LABEL: Record<ClaimStatus, string> = {
  verified: 'POTWIERDZONA w obie strony',
  failed: 'NIEPOTWIERDZONA — dowodu nie znaleziono albo konto należy do kogoś innego',
  unchecked: 'niesprawdzona — łącznik nie weryfikuje tego serwisu',
};

/** Czy treść dowodu wskazuje odcisk klucza (`openpgp4fpr:<odcisk>` albo sam odcisk). */
const mentionsFingerprint = (text: string, fingerprint: string): boolean => text.toLowerCase().includes(fingerprint.toLowerCase());

async function verifyOverHttp(claim: ClassifiedClaim, fingerprint: string, session: HttpSession, githubToken?: string): Promise<ClaimStatus> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (claim.kind === 'github') {
    headers['X-GitHub-Api-Version'] = '2022-11-28';
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`;
  }
  const response = await session.get(claim.proofApi!, { headers, quietMissing: true, ...(claim.kind === 'codeberg' ? { minIntervalMs: 2000 } : {}) });
  if (!response) return session.refused ? 'unchecked' : 'failed';
  const account = claim.account!.toLowerCase();
  if (claim.kind === 'github') {
    const gist = parseJson<{ owner?: { login?: string }; description?: string | null; files?: Record<string, { content?: string }> }>(response.text);
    if (gist?.owner?.login?.toLowerCase() !== account) return 'failed';
    const content = [gist.description ?? '', ...Object.values(gist.files ?? {}).map((file) => file?.content ?? '')].join('\n');
    return mentionsFingerprint(content, fingerprint) ? 'verified' : 'failed';
  }
  if (claim.kind === 'codeberg') {
    const repo = parseJson<{ owner?: { login?: string }; description?: string | null }>(response.text);
    return repo?.owner?.login?.toLowerCase() === account && mentionsFingerprint(repo.description ?? '', fingerprint) ? 'verified' : 'failed';
  }
  const project = parseJson<{ path_with_namespace?: string; description?: string | null }>(response.text);
  return project?.path_with_namespace?.toLowerCase() === `${account}/gitlab_proof` && mentionsFingerprint(project.description ?? '', fingerprint) ? 'verified' : 'failed';
}

export type TxtResolver = (domain: string) => Promise<string[][]>;

const systemResolveTxt: TxtResolver = (domain) => {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  return resolver.resolveTxt(domain);
};

export interface KeyoxideConfig {
  /** Opcjonalny token GitHub (ten sam co w `live-github`) — tylko do odczytu gista z dowodem. */
  githubToken?: string;
  /** Zamiennik zapytania DNS TXT (testy). */
  resolveTxt?: TxtResolver;
}

/** Czego szukać: dokładny e-mail albo odcisk klucza (40 znaków szesnastkowych, opcjonalnie z prefiksem `openpgp4fpr:`). */
export function keyoxideLookup(identifier: Identifier): { url: string; label: string } | null {
  const value = identifier.value.trim();
  if (identifier.type === 'email') {
    const email = value.toLowerCase();
    return EMAIL.test(email) ? { url: `${KOO}/by-email/${encodeURIComponent(email)}`, label: email } : null;
  }
  if (identifier.type === 'login') {
    const fingerprint = FINGERPRINT.exec(value)?.[1]?.toUpperCase();
    return fingerprint ? { url: `${KOO}/by-fingerprint/${fingerprint}`, label: fingerprint } : null;
  }
  return null;
}

export function createKeyoxideConnector(http: HttpClient, config: KeyoxideConfig = {}): SourceConnector {
  const resolveTxt = config.resolveTxt ?? systemResolveTxt;
  let recent: number[] = [];

  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Dowody tożsamości Ariadne (format Keyoxide) weryfikowane lokalnie: klucz OpenPGP pobrany z keys.openpgp.org po dokładnym adresie e-mail ' +
      'albo odcisku („openpgp4fpr:<odcisk>”), z podpisu klucza odczytywane są deklaracje proof@ariadne.id, a każda deklaracja konta GitHub (gist), ' +
      'Codeberg, GitLab lub domeny (DNS TXT) jest sprawdzana w drugą stronę — czy konto publikuje odcisk tego klucza. Tylko dowód potwierdzony ' +
      'w obie strony daje ślad „potwierdzona tożsamość”; pozostałe deklaracje są słabymi tropami. API keyoxide.org nie jest używane. ' +
      `Najwyżej 1 żądanie o klucz (odstęp 5 s, ${KEYOXIDE_HOURLY_LIMIT} na godzinę), ${MAX_HTTP_CHECKS} sprawdzenia w serwisach i ${MAX_DNS_CHECKS} zapytania DNS.`,
    accepts: ['email', 'login'],
    enabledByDefault: true,

    async search(identifier, context) {
      const lookup = keyoxideLookup(identifier);
      if (!lookup) return [];
      const now = Date.now();
      recent = recent.filter((time) => now - time < 3_600_000);
      if (recent.length >= KEYOXIDE_HOURLY_LIMIT) {
        context.log(`${LABEL}: wyczerpano godzinny limit ${KEYOXIDE_HOURLY_LIMIT} zapytań łącznika — pomijam „${lookup.label}".`);
        return [];
      }
      recent.push(now);
      const session = http.session(context, { label: LABEL, limit: 1 + MAX_HTTP_CHECKS });
      const response = await session.get(lookup.url, { quietMissing: true, minIntervalMs: MIN_INTERVAL_MS, maxBytes: 262_144 });
      if (!response) {
        if (session.lastStatus === 404) context.log(`${LABEL}: „${lookup.label}" — brak opublikowanego klucza.`);
        return [];
      }
      const { fingerprint, claims } = ariadneClaims(response.text);
      if (!fingerprint) {
        context.log(`${LABEL}: „${lookup.label}" — odpowiedź nie zawiera klucza w wersji 4.`);
        return [];
      }
      if (claims.length === 0) {
        context.log(`${LABEL}: „${lookup.label}" — klucz ${fingerprint} nie zawiera deklaracji proof@ariadne.id.`);
        return [];
      }

      const classified = claims.map(classifyClaim);
      const statuses = new Map<ClassifiedClaim, ClaimStatus>();
      let httpChecks = 0;
      let dnsChecks = 0;
      for (const claim of classified) {
        let status: ClaimStatus = 'unchecked';
        if (claim.kind === 'dns' && dnsChecks < MAX_DNS_CHECKS) {
          dnsChecks++;
          try {
            const records = (await resolveTxt(claim.account!)).map((parts) => parts.join(''));
            status = records.some((record) => mentionsFingerprint(record, fingerprint)) ? 'verified' : 'failed';
          } catch {
            status = 'failed';
          }
        } else if (claim.proofApi && httpChecks < MAX_HTTP_CHECKS) {
          httpChecks++;
          status = await verifyOverHttp(claim, fingerprint, session, config.githubToken);
        }
        statuses.set(claim, status);
      }

      const fetchedAt = new Date().toISOString();
      const verified = classified.filter((claim) => statuses.get(claim) === 'verified');
      // Słabe tropy: deklaracje niepotwierdzone, o ile wskazują adres http(s) (konto do sprawdzenia innym łącznikiem).
      const weak = classified
        .filter((claim) => statuses.get(claim) !== 'verified')
        .map((claim) => (claim.profileUrl ? profileUrlIdentifier(claim.profileUrl) : /^https:\/\//i.test(claim.uri) ? profileUrlIdentifier(claim.uri) : null))
        .filter((item): item is Identifier => Boolean(item));
      const profileUrl = `https://keyoxide.org/${fingerprint}`;
      const documents: SourceDocument[] = [
        {
          connectorId: ID,
          service: SERVICE,
          url: profileUrl,
          title: `Deklaracje tożsamości Ariadne klucza ${fingerprint}`,
          text: [
            `Klucz OpenPGP ${fingerprint} (pobrany z keys.openpgp.org dla „${lookup.label}") zawiera podpisane deklaracje kont (proof@ariadne.id).`,
            'Deklaracja jest podpisana kluczem, ale potwierdza tożsamość dopiero wtedy, gdy konto samo publikuje odcisk klucza (dowód dwustronny).',
            ...classified.map((claim) => `- ${KIND_LABEL[claim.kind]}: ${claim.uri} — ${STATUS_LABEL[statuses.get(claim)!]} (identyfikator klucza: ${claim.userId})`),
            `Sprawdzono lokalnie: ${verified.length} potwierdzonych z ${classified.length} deklaracji.`,
          ].join('\n'),
          fetchedAt,
          author: lookup.label,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { handle: lookup.label },
          ...discoveredField(dedupeIdentifiers(weak, identifier)),
        },
      ];
      for (const claim of verified) {
        const account = claim.profileUrl ? profileUrlIdentifier(claim.profileUrl) : null;
        documents.push({
          connectorId: ID,
          service: claim.service!,
          url: claim.kind === 'dns' ? claim.profileUrl! : claim.uri,
          title: `Dowód Ariadne: klucz ${fingerprint} ↔ ${KIND_LABEL[claim.kind]} ${claim.account}`,
          text: [
            `Dowód tożsamości potwierdzony w obie strony (format Ariadne / Keyoxide):`,
            `1. Klucz OpenPGP ${fingerprint} (${claim.userId}) deklaruje w podpisanej adnotacji proof@ariadne.id: ${claim.uri}`,
            claim.kind === 'dns'
              ? `2. Rekord DNS TXT domeny ${claim.account} zawiera odcisk tego klucza (openpgp4fpr:${fingerprint.toLowerCase()}).`
              : `2. Zasób ${claim.uri} należy do konta ${claim.account} i zawiera odcisk tego klucza (openpgp4fpr:${fingerprint.toLowerCase()}).`,
            `Wniosek: konto ${KIND_LABEL[claim.kind]} „${claim.account}" i adres „${lookup.label}" należą do posiadacza tego samego klucza.`,
          ].join('\n'),
          fetchedAt,
          author: claim.account!,
          category: 'cryptographic_proof',
          identityMatch: 'verified_link',
          matchedIdentifier: identifier,
          profile: { handle: claim.account!, ...(claim.profileUrl ? { urls: [claim.profileUrl] } : {}) },
          ...discoveredField(dedupeIdentifiers(account ? [account] : [], identifier)),
        });
      }
      context.log(`${LABEL}: „${lookup.label}" — deklaracji: ${classified.length}, potwierdzonych w obie strony: ${verified.length} (zapytań HTTP: ${session.used}, DNS: ${dnsChecks}).`);
      return documents;
    },
  };
}
