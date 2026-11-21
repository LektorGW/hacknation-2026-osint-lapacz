// Łącznik Nostr: identyfikator NIP-05 (`nazwa@domena`) → klucz publiczny konta.
//
// Podstawa (sprawdzone 21.11.2026):
//   • NIP-05 (https://github.com/nostr-protocol/nips/blob/master/05.md, status „final"): „make a GET request to
//     https://<domain>/.well-known/nostr.json?name=<local-part>. The result should be a JSON document object with a key
//     "names" that should then be a mapping of names to hex formatted public keys" — punkt końcowy zdefiniowany przez
//     protokół właśnie po to, by odpytywały go programy klienckie. Jedno żądanie GET na identyfikator, bez przekierowań
//     (specyfikacja ich zabrania), tylko do hostów publicznych.
//   • Profil konta (zdarzenie kind 0: nazwa, opis, strona, adres Lightning) jest dostępny wyłącznie przez przekaźniki
//     WebSocket. Publiczne przekaźniki (relay.damus.io, nos.lol, relay.primal.net) nie wymagają logowania ani opłat
//     (dokument NIP-11), ale ŻADEN nie publikuje jednoznacznej zgody na odczyt automatyczny, a regulaminu nos.lol nie dało
//     się odczytać. Dlatego odczyt z przekaźników jest DOMYŚLNIE WYŁĄCZONY: działa tylko, gdy operator poda listę
//     przekaźników, których zasady sam zaakceptował (zmienna NOSTR_RELAYS albo opcja `nostrRelays`). Wtedy łącznik wysyła
//     jedno zapytanie REQ (kind 0, limit 1) do pierwszego odpowiadającego przekaźnika i zamyka połączenie.
//   • Otwartego API HTTP do profili z opublikowanymi zasadami użycia automatycznego nie znaleziono (api.nostr.band
//     nie odpowiadał; pamięć podręczna Primal nie ma opublikowanych zasad) — nie jest używane.

import type { Identifier, ProfileAttributes, SourceConnector } from '@olcys/core';
import { findEmails } from './html.ts';
import { errorMessage, parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, profileUrlIdentifier } from './identity.ts';

const ID = 'live-nostr';
const LABEL = 'Nostr (NIP-05)';
const NIP05 = /^([a-z0-9._-]{1,64})@((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/;
const PUBKEY = /^[0-9a-f]{64}$/;
const RELAY_URL = /^wss:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[\w./-]*)?$/i;
const RELAY_TIMEOUT_MS = 6000;
const MAX_RELAYS = 2;

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32Polymod(values: number[]): number {
  const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) checksum ^= generators[i]!;
  }
  return checksum >>> 0;
}

/** Klucz publiczny w zapisie `npub1…` (NIP-19, bech32) — w tej postaci pokazują go klienty Nostr. */
export function npubOf(hexPubkey: string): string {
  const data: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of Buffer.from(hexPubkey, 'hex')) {
    acc = ((acc << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const hrp = 'npub';
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >>> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const polymod = bech32Polymod([...expanded, ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (polymod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((value) => BECH32_CHARSET[value]).join('')}`;
}

/** Identyfikator NIP-05 z wartości wpisanej przez analityka; `_@domena` to konto główne domeny. */
export function nip05Of(identifier: Identifier): { name: string; domain: string } | null {
  if (identifier.type === 'profile_url' || identifier.type === 'crypto_address') return null;
  const match = NIP05.exec(cleanHandle(identifier.value).toLowerCase());
  return match ? { name: match[1]!, domain: match[2]! } : null;
}

/** Treść zdarzenia kind 0 (profil) — pola używane przez klienty Nostr. */
export interface NostrProfile {
  name?: string;
  display_name?: string;
  about?: string;
  website?: string;
  nip05?: string;
  lud16?: string;
  picture?: string;
}

/** Pobranie profilu (kind 0) z przekaźnika; w testach podmieniane atrapą. */
export type NostrRelayQuery = (relayUrl: string, pubkey: string, signal?: AbortSignal) => Promise<NostrProfile | null>;

/** Jedno zapytanie REQ o profil przez WebSocket: czeka na EVENT albo EOSE, potem zamyka połączenie. */
export const queryRelay: NostrRelayQuery = (relayUrl, pubkey, signal) =>
  new Promise((resolve, reject) => {
    const Socket = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!Socket) return reject(new Error('środowisko nie udostępnia WebSocket'));
    const socket = new Socket(relayUrl);
    const subscription = `olcys-${Date.now().toString(36)}`;
    let done = false;
    const finish = (result: NostrProfile | null, error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        if (socket.readyState === 1) socket.send(JSON.stringify(['CLOSE', subscription]));
        socket.close();
      } catch {
        // Połączenie mogło się już zamknąć.
      }
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(null, new Error('przekroczono limit czasu')), RELAY_TIMEOUT_MS);
    signal?.addEventListener('abort', () => finish(null, new Error('przerwano')), { once: true });
    socket.addEventListener('open', () => socket.send(JSON.stringify(['REQ', subscription, { kinds: [0], authors: [pubkey], limit: 1 }])));
    socket.addEventListener('error', () => finish(null, new Error('błąd połączenia')));
    socket.addEventListener('close', () => finish(null));
    socket.addEventListener('message', (event: { data: unknown }) => {
      const message = parseJson<unknown[]>(String(event.data));
      if (!Array.isArray(message) || message[1] !== subscription) return;
      if (message[0] === 'EOSE' || message[0] === 'CLOSED') return finish(null);
      const item = message[2] as { kind?: number; pubkey?: string; content?: string } | undefined;
      if (message[0] !== 'EVENT' || item?.kind !== 0 || item.pubkey !== pubkey) return;
      finish(parseJson<NostrProfile>(item.content ?? '') ?? null);
    });
  });

export interface NostrConfig {
  /** Przekaźniki (wss://…), z których wolno pobrać profil; pusta lista wyłącza odczyt z przekaźników. */
  relays?: string[];
  relayQuery?: NostrRelayQuery;
}

const text = (value: unknown, max = 600): string | undefined => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

export function createNostrConnector(http: HttpClient, config: NostrConfig = {}): SourceConnector {
  const relays = (config.relays ?? []).map((relay) => relay.trim()).filter((relay) => RELAY_URL.test(relay)).slice(0, MAX_RELAYS);
  const relayQuery = config.relayQuery ?? queryRelay;

  return {
    id: ID,
    service: 'nostr',
    label: LABEL,
    description:
      'Identyfikator Nostr NIP-05 w postaci nazwa@domena: jedno żądanie GET https://<domena>/.well-known/nostr.json?name=<nazwa> ' +
      '(punkt końcowy zdefiniowany w specyfikacji protokołu), wynik to klucz publiczny konta (npub). ' +
      (relays.length > 0
        ? `Profil konta (kind 0: opis, strona, adres Lightning) jest pobierany jednym zapytaniem z przekaźników wskazanych przez operatora: ${relays.join(', ')}.`
        : 'Odczyt profilu z przekaźników WebSocket jest wyłączony (przekaźniki publiczne nie publikują jednoznacznej zgody na odczyt automatyczny); włącza go operator zmienną NOSTR_RELAYS.'),
    accepts: ['messenger_id', 'nick', 'login'],
    enabledByDefault: true,

    async search(identifier, context) {
      const target = nip05Of(identifier);
      if (!target) return [];
      const session = http.session(context, { label: LABEL, limit: 1 });
      const url = `https://${target.domain}/.well-known/nostr.json?name=${encodeURIComponent(target.name)}`;
      // Domena pochodzi z identyfikatora — tylko hosty publiczne i bez przekierowań (wymóg NIP-05).
      const response = await session.get(url, { headers: { Accept: 'application/json' }, publicOnly: true, maxRedirects: 0, quietMissing: true, maxBytes: 262_144 });
      const body = response ? parseJson<{ names?: Record<string, unknown> }>(response.text) : null;
      const names = body?.names && typeof body.names === 'object' ? body.names : {};
      const entry = Object.entries(names).find(([name]) => name.toLowerCase() === target.name);
      const pubkey = typeof entry?.[1] === 'string' ? entry[1].toLowerCase() : '';
      if (!PUBKEY.test(pubkey)) {
        context.log(`${LABEL}: „${identifier.value}" — domena ${target.domain} nie potwierdza takiego identyfikatora.`);
        return [];
      }
      const npub = npubOf(pubkey);
      const nip05 = `${target.name}@${target.domain}`;

      let profile: NostrProfile | null = null;
      let relayUsed: string | undefined;
      for (const relay of relays) {
        try {
          profile = await relayQuery(relay, pubkey, context.signal);
          relayUsed = relay;
          if (profile) break;
        } catch (error) {
          context.log(`${LABEL}: przekaźnik ${relay} — ${errorMessage(error)}.`);
        }
      }

      const about = text(profile?.about, 2000);
      const website = text(profile?.website, 200);
      const lightning = text(profile?.lud16, 120);
      const claimed = text(profile?.nip05, 120)?.toLowerCase();
      const confirmed = claimed === nip05 || (target.name === '_' && claimed === target.domain);
      const discovered: Identifier[] = [];
      const websiteId = website ? profileUrlIdentifier(/^https?:\/\//i.test(website) ? website : `https://${website}`) : null;
      if (websiteId) discovered.push(websiteId);
      for (const email of findEmails(about ?? '')) discovered.push({ type: 'email', value: email });
      const attributes: ProfileAttributes = {
        handle: nip05,
        ...(text(profile?.display_name, 100) ?? text(profile?.name, 100) ? { displayName: (text(profile?.display_name, 100) ?? text(profile?.name, 100))! } : {}),
        ...(websiteId ? { urls: [websiteId.value] } : {}),
        ...(about ? { bio: about } : {}),
      };

      context.log(`${LABEL}: „${identifier.value}" — klucz ${npub}${profile ? `, profil z ${relayUsed}` : relays.length > 0 ? ', profilu nie pobrano' : ''}.`);
      return [
        {
          connectorId: ID,
          service: target.domain,
          url,
          title: `Nostr: ${nip05}`,
          text: [
            `Identyfikator Nostr (NIP-05): ${nip05}`,
            `Domena ${target.domain} wskazuje dla tej nazwy klucz publiczny: ${npub} (hex: ${pubkey})`,
            `Profil w przeglądarce: https://njump.me/${npub}`,
            profile
              ? [
                  `Profil konta (zdarzenie kind 0 z przekaźnika ${relayUsed}; podpis zdarzenia nie był sprawdzany):`,
                  text(profile.name, 100) && `Nazwa: ${text(profile.name, 100)}`,
                  text(profile.display_name, 100) && `Nazwa wyświetlana: ${text(profile.display_name, 100)}`,
                  about && `Opis:\n${about}`,
                  website && `Strona: ${website}`,
                  lightning && `Adres Lightning (lud16): ${lightning}`,
                  claimed && `Identyfikator NIP-05 podany w profilu: ${claimed}${confirmed ? ' — zgodny z domeną (potwierdzenie dwustronne)' : ' — INNY niż sprawdzany'}`,
                ]
                  .filter(Boolean)
                  .join('\n')
              : 'Profil konta (opis, strona, adres Lightning) nie został pobrany — jest dostępny tylko przez przekaźniki WebSocket.',
          ].join('\n'),
          fetchedAt: new Date().toISOString(),
          author: nip05,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: attributes,
          ...discoveredField(dedupeIdentifiers(discovered, identifier, [target.domain])),
        },
      ];
    },
  };
}
