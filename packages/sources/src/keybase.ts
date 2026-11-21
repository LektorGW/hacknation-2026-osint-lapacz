// Łącznik Keybase: publiczne API bez klucza. Użytkownik Keybase podpisuje swoim
// kluczem zarówno adresy kryptowalutowe, jak i dowody posiadania kont w innych
// serwisach — to najmocniejszy rodzaj śladu (dowód kryptograficzny).

import type { Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-keybase';
const SERVICE = 'keybase.io';
const LABEL = 'Keybase';
const API = 'https://keybase.io/_/api/1.0/user/lookup.json';
const FIELDS = 'basics,profile,proofs_summary,cryptocurrency_addresses';

interface KeybaseProof {
  proof_type?: string;
  nametag?: string;
  state?: number;
  service_url?: string;
  proof_url?: string;
  human_url?: string;
}

interface KeybaseUser {
  id?: string;
  basics?: { username?: string; ctime?: number; mtime?: number };
  profile?: { full_name?: string | null; location?: string | null; bio?: string | null } | null;
  proofs_summary?: { all?: KeybaseProof[] } | null;
  cryptocurrency_addresses?: Record<string, { address?: string; sig_id?: string }[]> | null;
}

interface LookupResponse {
  status?: { code?: number; name?: string; desc?: string };
  them?: (KeybaseUser | null)[] | KeybaseUser | null;
}

/** Parametr wyszukiwania Keybase: nazwa użytkownika albo konto w innym serwisie potwierdzone dowodem. */
interface Query {
  key: 'usernames' | 'github' | 'twitter' | 'reddit' | 'hackernews';
  value: string;
}

const LIMITS: Record<Query['key'], RegExp> = {
  usernames: /^[a-z0-9_]{2,16}$/i,
  github: /^[a-z0-9](?:[a-z0-9-]{0,38})$/i,
  twitter: /^[a-z0-9_]{1,15}$/i,
  reddit: /^[a-z0-9_-]{3,20}$/i,
  hackernews: /^[a-z0-9_-]{2,15}$/i,
};

/** Jakie zapytania wynikają z identyfikatora — najwyżej 4. */
export function keybaseQueries(identifier: Identifier): Query[] {
  const queries: Query[] = [];
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url) return [];
    const parts = url.pathname.split('/').filter(Boolean).map((part) => cleanHandle(decodeURIComponent(part)));
    const host = serviceOf(url);
    if (host === 'keybase.io' && parts[0]) queries.push({ key: 'usernames', value: parts[0] });
    else if (host === 'github.com' && parts[0]) queries.push({ key: 'github', value: parts[0] });
    else if ((host === 'twitter.com' || host === 'x.com') && parts[0]) queries.push({ key: 'twitter', value: parts[0] });
    else if (host === 'reddit.com' && (parts[0] === 'user' || parts[0] === 'u') && parts[1]) {
      queries.push({ key: 'reddit', value: parts[1] });
    } else if (host === 'news.ycombinator.com' && url.searchParams.get('id')) {
      queries.push({ key: 'hackernews', value: url.searchParams.get('id')! });
    }
  } else {
    const handle = cleanHandle(identifier.value);
    for (const key of ['usernames', 'github', 'twitter', 'reddit'] as const) queries.push({ key, value: handle });
  }
  return queries.filter((query) => LIMITS[query.key].test(query.value)).slice(0, 4);
}

const PROOF_LABEL: Record<string, string> = {
  twitter: 'Twitter/X',
  github: 'GitHub',
  reddit: 'Reddit',
  hackernews: 'Hacker News',
  generic_web_site: 'strona WWW',
  dns: 'domena (DNS)',
};

function proofIdentifier(proof: KeybaseProof): Identifier | null {
  const name = proof.nametag?.trim();
  if (!name) return null;
  switch (proof.proof_type) {
    case 'github':
      return { type: 'login', value: name };
    case 'twitter':
    case 'reddit':
    case 'hackernews':
      return { type: 'nick', value: name };
    case 'generic_web_site':
    case 'dns':
      return profileUrlIdentifier(proof.service_url && /^https?:/i.test(proof.service_url) ? proof.service_url : `https://${name}`);
    default:
      return proof.service_url ? profileUrlIdentifier(proof.service_url) : null;
  }
}

function toDocument(user: KeybaseUser, identifier: Identifier, foundBy: Query): SourceDocument | null {
  const username = user.basics?.username;
  if (!username) return null;
  // Sam nick nie mówi, w którym serwisie jest kontem: trafienie przez dowód konta GitHub/Twitter/Reddit
  // o tej nazwie to zgadywanie — ocenę, czy to ta sama osoba, zostawiamy analizie.
  const guessed = foundBy.key !== 'usernames' && identifier.type !== 'profile_url';
  // Adres profilu w innym serwisie + dowód Keybase dla tego właśnie konta = tożsamość potwierdzona kryptograficznie.
  const proven = foundBy.key !== 'usernames' && identifier.type === 'profile_url';

  const addressLines: string[] = [];
  for (const [currency, entries] of Object.entries(user.cryptocurrency_addresses ?? {})) {
    for (const entry of entries ?? []) {
      if (entry?.address) addressLines.push(`- ${currency}: ${entry.address}${entry.sig_id ? ` (podpis ${entry.sig_id})` : ''}`);
    }
  }

  // Stan 1 oznacza dowód sprawdzony przez Keybase; pozostałe (usunięte, tymczasowo niedostępne) pomijamy.
  const proofs = (user.proofs_summary?.all ?? []).filter((proof) => proof?.state === 1 && proof.nametag);
  const proofLines = proofs.map((proof) => {
    const label = PROOF_LABEL[proof.proof_type ?? ''] ?? proof.proof_type ?? 'inne';
    const where = proof.service_url ? ` — ${proof.service_url}` : '';
    const evidence = proof.proof_url ?? proof.human_url;
    return `- ${label}: ${proof.nametag}${where}${evidence ? ` (dowód: ${evidence})` : ''}`;
  });

  const text = [
    `Profil Keybase: ${username}`,
    user.profile?.full_name && `Imię i nazwisko: ${user.profile.full_name}`,
    user.profile?.location && `Lokalizacja: ${user.profile.location}`,
    user.profile?.bio && `Bio: ${user.profile.bio}`,
    foundBy.key !== 'usernames' && `Odnaleziony przez dowód konta ${PROOF_LABEL[foundBy.key] ?? foundBy.key}: ${foundBy.value}`,
    guessed &&
      `UWAGA: nie wiadomo, czy nick podany przez analityka to konto ${PROOF_LABEL[foundBy.key] ?? foundBy.key} — zgadza się tylko nazwa, właścicielem może być inna osoba.`,
    addressLines.length > 0
      ? `Adresy kryptowalutowe podpisane kluczem użytkownika:\n${addressLines.join('\n')}`
      : 'Adresy kryptowalutowe podpisane kluczem użytkownika: brak',
    proofLines.length > 0
      ? `Konta i strony potwierdzone dowodem kryptograficznym:\n${proofLines.join('\n')}`
      : 'Konta i strony potwierdzone dowodem kryptograficznym: brak',
  ]
    .filter(Boolean)
    .join('\n');

  const discovered: Identifier[] = [];
  // Profil znaleziony przez dowód innego konta ujawnia nazwę użytkownika Keybase.
  if (foundBy.key !== 'usernames' && !guessed) discovered.push({ type: 'nick', value: username });
  // Profil dopasowany przez zgadywaną nazwę nie uruchamia dalszego wyszukiwania.
  for (const proof of guessed ? [] : proofs) {
    const found = proofIdentifier(proof);
    if (found) discovered.push(found);
  }

  const urls = [...new Set(proofs.map((proof) => proof.service_url).filter((url): url is string => Boolean(url)))];
  const profile: ProfileAttributes = {
    handle: username,
    ...(user.profile?.full_name ? { displayName: user.profile.full_name } : {}),
    ...(user.profile?.location ? { location: user.profile.location } : {}),
    ...(user.profile?.bio ? { bio: user.profile.bio } : {}),
    ...(urls.length > 0 ? { urls } : {}),
    ...(user.basics?.ctime ? { createdAt: new Date(user.basics.ctime * 1000).toISOString() } : {}),
  };

  return {
    connectorId: ID,
    service: SERVICE,
    url: `https://keybase.io/${username}`,
    title: `Keybase: ${username} — podpisane adresy i dowody kont`,
    text,
    fetchedAt: new Date().toISOString(),
    author: username,
    // Adresy i dowody są podpisane kluczem użytkownika.
    category: 'cryptographic_proof',
    identityMatch: proven ? 'verified_link' : 'exact_identifier',
    matchedIdentifier: identifier,
    profile,
    ...(user.basics?.mtime ? { publishedAt: new Date(user.basics.mtime * 1000).toISOString() } : {}),
    ...discoveredField(
      dedupeIdentifiers(
        discovered.filter((item) => item.value.toLowerCase() !== cleanHandle(identifier.value).toLowerCase()),
        identifier,
      ),
    ),
  };
}

export function createKeybaseConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczne API Keybase (user/lookup.json, bez klucza): użytkownik o podanej nazwie oraz użytkownicy, którzy dowodem ' +
      'kryptograficznym potwierdzili konto GitHub, Twitter/X lub Reddit o tej nazwie (dla adresu profilu — także Hacker News). ' +
      'Pobierane pola: basics, profile, proofs_summary, cryptocurrency_addresses. Adresy są podpisane kluczem użytkownika. ' +
      'Tożsamość jest oznaczana jako potwierdzona tylko wtedy, gdy podano adres profilu, a Keybase ma dowód dla tego właśnie konta. ' +
      'Najwyżej 4 żądania na identyfikator.',
    accepts: ['nick', 'login', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const queries = keybaseQueries(identifier);
      if (queries.length === 0) return [];
      const session = http.session(context, { label: LABEL });
      const documents = new Map<string, SourceDocument>();

      for (const query of queries) {
        const url = `${API}?${query.key}=${encodeURIComponent(query.value)}&fields=${FIELDS}`;
        const response = await session.get(url, { headers: { Accept: 'application/json' } });
        if (!response) {
          if (session.refused) break;
          continue;
        }
        const body = parseJson<LookupResponse>(response.text);
        if (!body || (body.status?.code ?? 0) !== 0) {
          context.log(`${LABEL}: nieoczekiwana odpowiedź dla ${query.key}=${query.value} (${body?.status?.name ?? 'nie JSON'}).`);
          continue;
        }
        const them = Array.isArray(body.them) ? body.them : body.them ? [body.them] : [];
        for (const user of them.slice(0, 3)) {
          if (!user?.basics?.username || documents.has(user.basics.username)) continue;
          const document = toDocument(user, identifier, query);
          if (document) documents.set(user.basics.username, document);
        }
      }

      context.log(`${LABEL}: „${identifier.value}" — profili: ${documents.size} (zapytań: ${session.used}).`);
      return [...documents.values()];
    },
  };
}
