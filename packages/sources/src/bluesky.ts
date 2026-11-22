// Łącznik Bluesky: publiczne, nieuwierzytelnione API AppView (public.api.bsky.app).
//
// Podstawa (sprawdzone 21.11.2026):
//   • https://public.api.bsky.app/robots.txt: „Crawling the public parts of the API is allowed. HTTP 429 ("backoff")
//     status codes are used for rate-limiting. Up to a handful concurrent requests should be ok." + „User-agent: * / Allow: /";
//   • dokumentacja Bluesky (bsky-docs, advanced-guides/rate-limits) kieruje zapytania „public web" do public.api.bsky.app;
//     strony dokumentacji nie dało się ponownie odczytać 21.11.2026 (pusta treść) — rozstrzyga robots.txt hosta API.
// Zapytania: app.bsky.actor.getProfile (profil) i app.bsky.feed.getAuthorFeed (ostatnie wpisy konta) — dwa żądania
// na identyfikator, jedno po drugim; po kodzie 429 łącznik rezygnuje (wspólny klient HTTP nie ponawia odmów).
// Nick sprawdzamy tylko jako dokładną nazwę konta. Wyszukiwarka kont (app.bsky.actor.searchActors, leksykon:
// „Find actors (profiles) matching search criteria. Does not require auth.”) służy wyłącznie imieniu i nazwisku —
// jedno żądanie, wynik zawsze „zgodne tylko imię i nazwisko” (sprawdzone 22.11.2026).

import type { ConnectorContext, Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { displayNameMatch, NAME_SEARCH_REASON } from './name-candidates.ts';
import { extractAddresses } from '@olcys/core';
import { findEnsNames, normalizeAddressText } from './address-text.ts';
import { findEmails } from './html.ts';
import { parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-bluesky';
const SERVICE = 'bsky.app';
const LABEL = 'Bluesky';
const API = 'https://public.api.bsky.app/xrpc';
const FEED_LIMIT = 30;
/** Najwyżej tyle wpisów z adresem lub podpisem trafia do wyniku jako osobne dokumenty. */
const MAX_POST_DOCUMENTS = 5;

/** Nazwa konta: domena (`nick.bsky.social`, własna domena) albo identyfikator DID. */
const HANDLE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
const DID = /^did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/;
const SHORT_NICK = /^[a-z0-9](?:[a-z0-9-]{1,16}[a-z0-9])$/;

interface BskyProfile {
  did?: string;
  handle?: string;
  displayName?: string;
  description?: string;
  avatar?: string;
  createdAt?: string;
}

interface BskyFeed {
  feed?: {
    post?: {
      uri?: string;
      author?: { did?: string; handle?: string };
      record?: { text?: string; createdAt?: string; facets?: { features?: { $type?: string; uri?: string }[] }[] };
    };
    reason?: { $type?: string };
  }[];
}

/** Nazwa konta do sprawdzenia; sam nick bez domeny oznacza konto w domyślnej domenie `bsky.social`. */
export function blueskyActor(identifier: Identifier): string | null {
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url || serviceOf(url) !== SERVICE) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const actor = parts[0] === 'profile' && parts[1] ? decodeURIComponent(parts[1]).toLowerCase() : '';
    return HANDLE.test(actor) || DID.test(actor) ? actor : null;
  }
  const value = cleanHandle(identifier.value).toLowerCase();
  if (DID.test(value)) return value;
  if (value.includes('@')) return null;
  if (HANDLE.test(value)) return value;
  return SHORT_NICK.test(value) ? `${value}.bsky.social` : null;
}

const isoOrUndefined = (value: string | undefined): string | undefined =>
  value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : undefined;

/** Najwyżej tyle kont z wyszukiwarki trafia do wyniku dla jednego imienia i nazwiska. */
export const BLUESKY_NAME_RESULTS = 5;

/** Wyszukiwarka kont (app.bsky.actor.searchActors): jedno żądanie, dokumenty z widoku profilu w odpowiedzi. */
async function searchActorsByName(http: HttpClient, identifier: Identifier, context: ConnectorContext): Promise<SourceDocument[]> {
  const name = identifier.value.trim().replace(/\s+/g, ' ');
  if (name.split(' ').length < 2 || name.length > 100) return [];
  const session = http.session(context, { label: `${LABEL} — wyszukiwarka kont`, limit: 1 });
  const response = await session.get(`${API}/app.bsky.actor.searchActors?q=${encodeURIComponent(name)}&limit=25`, { headers: { Accept: 'application/json' } });
  const body = response ? parseJson<{ actors?: BskyProfile[] }>(response.text) : null;
  const found: { document: SourceDocument; exact: boolean }[] = [];
  let mismatched = 0;
  const fetchedAt = new Date().toISOString();
  for (const actor of body?.actors ?? []) {
    const handle = actor?.handle?.toLowerCase();
    if (!handle || !actor.did || !HANDLE.test(handle)) continue;
    const match = displayNameMatch(actor.displayName, name);
    if (!match) {
      mismatched++;
      continue;
    }
    const description = (actor.description ?? '').trim();
    const createdAt = isoOrUndefined(actor.createdAt);
    const discovered: Identifier[] = [];
    for (const email of findEmails(description)) discovered.push({ type: 'email', value: email });
    for (const link of description.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []) {
      const linked = profileUrlIdentifier(link.replace(/[.,;]+$/, ''));
      if (linked) discovered.push(linked);
    }
    if (!handle.endsWith('.bsky.social')) discovered.push({ type: 'profile_url', value: `https://${handle}/` });
    found.push({
      exact: match === 'exact',
      document: {
        connectorId: ID,
        service: SERVICE,
        url: `https://bsky.app/profile/${handle}`,
        title: `Profil Bluesky: ${handle}`,
        text: [
          `Profil Bluesky: ${handle} (${actor.did})`,
          actor.displayName && `Nazwa wyświetlana: ${actor.displayName}`,
          createdAt && `Konto utworzone: ${createdAt.slice(0, 10)}`,
          description && `Opis:\n${description}`,
        ]
          .filter(Boolean)
          .join('\n'),
        fetchedAt,
        author: handle,
        category: 'own_profile',
        identityMatch: 'name_only',
        identityNote: NAME_SEARCH_REASON,
        matchedIdentifier: identifier,
        profile: {
          handle,
          ...(actor.displayName ? { displayName: actor.displayName } : {}),
          ...(findEmails(description).length > 0 ? { emails: findEmails(description) } : {}),
          ...(actor.avatar ? { avatarUrl: actor.avatar } : {}),
          ...(description ? { bio: description } : {}),
          ...(createdAt ? { createdAt } : {}),
        },
        ...discoveredField(dedupeIdentifiers(discovered, identifier, [SERVICE])),
      },
    });
  }
  const ordered = [...found.filter((item) => item.exact), ...found.filter((item) => !item.exact)].map((item) => item.document);
  const kept = ordered.slice(0, BLUESKY_NAME_RESULTS);
  const skipped = ordered.length - kept.length;
  if (response) {
    context.log(
      `${LABEL}: wyszukiwarka kont „${name}” — kont z pasującą nazwą ${ordered.length}, przyjętych ${kept.length}` +
        (mismatched > 0 ? `, odrzuconych (inna nazwa wyświetlana) ${mismatched}` : '') +
        (skipped > 0 ? `; pominięto ${skipped} dalszych wyników (limit ${BLUESKY_NAME_RESULTS})` : '') +
        '.',
    );
  }
  return kept;
}

export function createBlueskyConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczne API Bluesky bez logowania (public.api.bsky.app; robots.txt: „Crawling the public parts of the API is allowed"): ' +
      'profil konta (app.bsky.actor.getProfile) i do 30 ostatnich własnych wpisów (app.bsky.feed.getAuthorFeed, bez podanych dalej). ' +
      'Nick bez domeny jest sprawdzany jako <nick>.bsky.social; można podać pełną nazwę konta albo adres profilu. ' +
      'Wynik: opis profilu oraz najwyżej 5 wpisów zawierających adres kryptowalutowy lub podpisaną wiadomość. Dwa żądania na identyfikator. ' +
      'Imię i nazwisko: wyszukiwarka kont app.bsky.actor.searchActors (leksykon: „Does not require auth.”), jedno żądanie; przyjmowane ' +
      `tylko konta z pasującą nazwą wyświetlaną, najwyżej ${BLUESKY_NAME_RESULTS}, jako „zgodne tylko imię i nazwisko”.`,
    accepts: ['nick', 'login', 'profile_url', 'full_name'],
    enabledByDefault: true,

    async search(identifier, context) {
      if (identifier.type === 'full_name') return searchActorsByName(http, identifier, context);
      const actor = blueskyActor(identifier);
      if (!actor) return [];
      const session = http.session(context, { label: LABEL, limit: 2 });
      const headers = { Accept: 'application/json' };
      const response = await session.get(`${API}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, { headers, quietMissing: true });
      // Nieistniejące konto API zgłasza kodem 400 („Profile not found") — to zwykły brak wyniku.
      const profile = response ? parseJson<BskyProfile>(response.text) : null;
      if (!profile?.handle || !profile.did) {
        context.log(`${LABEL}: „${identifier.value}" — brak konta ${actor}.`);
        return [];
      }
      const handle = profile.handle.toLowerCase();
      const profileUrl = `https://bsky.app/profile/${handle}`;
      const description = (profile.description ?? '').trim();
      const fetchedAt = new Date().toISOString();
      const createdAt = isoOrUndefined(profile.createdAt);
      const attributes = {
        handle,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(findEmails(description).length > 0 ? { emails: findEmails(description) } : {}),
        ...(profile.avatar ? { avatarUrl: profile.avatar } : {}),
        ...(description ? { bio: description } : {}),
        ...(createdAt ? { createdAt } : {}),
      };

      const discovered: Identifier[] = [];
      for (const email of findEmails(description)) discovered.push({ type: 'email', value: email });
      for (const link of description.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []) {
        const found = profileUrlIdentifier(link.replace(/[.,;]+$/, ''));
        if (found) discovered.push(found);
      }
      for (const name of findEnsNames(description)) discovered.push({ type: 'ens_name', value: name });
      // Własna domena jako nazwa konta jest potwierdzona przez protokół (rekord DNS albo plik .well-known wskazuje to konto).
      if (!handle.endsWith('.bsky.social')) discovered.push({ type: 'profile_url', value: `https://${handle}/` });

      const documents: SourceDocument[] = [
        {
          connectorId: ID,
          service: SERVICE,
          url: profileUrl,
          title: `Profil Bluesky: ${handle}`,
          text: [
            `Profil Bluesky: ${handle} (${profile.did})`,
            profile.displayName && `Nazwa wyświetlana: ${profile.displayName}`,
            createdAt && `Konto utworzone: ${createdAt.slice(0, 10)}`,
            description && `Opis:\n${description}`,
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt,
          author: handle,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: attributes,
          ...discoveredField(dedupeIdentifiers(discovered, identifier, [SERVICE])),
        },
      ];

      const feedResponse = await session.get(`${API}/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(profile.did)}&limit=${FEED_LIMIT}&filter=posts_no_replies`, {
        headers,
        quietMissing: true,
      });
      const feed = feedResponse ? parseJson<BskyFeed>(feedResponse.text) : null;
      let scanned = 0;
      for (const item of feed?.feed ?? []) {
        if (documents.length > MAX_POST_DOCUMENTS) break;
        const post = item.post;
        // Wpis podany dalej ma innego autora — nie jest publikacją tego konta.
        if (!post?.uri || item.reason || post.author?.did !== profile.did) continue;
        scanned++;
        const links = (post.record?.facets ?? []).flatMap((facet) => facet.features ?? []).flatMap((feature) => (feature.uri ? [feature.uri] : []));
        // Pełne adresy odnośników (w treści bywają skrócone) dopisujemy pod wpisem — mogą wskazywać adres w eksploratorze.
        const body = [post.record?.text ?? '', ...links].join('\n').trim();
        const hasAddress = extractAddresses(normalizeAddressText(body)).length > 0;
        if (!hasAddress && !/-----BEGIN [A-Z ]*SIGNED MESSAGE-----|"sig(?:nature)?"\s*:/i.test(body)) continue;
        const rkey = post.uri.split('/').at(-1)!;
        const publishedAt = isoOrUndefined(post.record?.createdAt);
        documents.push({
          connectorId: ID,
          service: SERVICE,
          url: `${profileUrl}/post/${rkey}`,
          title: `Wpis Bluesky: ${handle}${publishedAt ? ` (${publishedAt.slice(0, 10)})` : ''}`,
          text: `Wpis konta ${handle} w serwisie Bluesky:\n${body}`,
          fetchedAt,
          author: handle,
          // Wpis na własnej osi czasu konta — jak wpis na własnym profilu w serwisie społecznościowym.
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: attributes,
          ...(publishedAt ? { publishedAt } : {}),
        });
      }

      context.log(`${LABEL}: „${identifier.value}" — konto ${handle}, przejrzanych własnych wpisów: ${scanned}, wpisów z adresem: ${documents.length - 1}.`);
      return documents;
    },
  };
}
