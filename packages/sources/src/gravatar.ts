// Łącznik Gravatar: publiczny profil w formacie JSON. Profil jest dostępny pod
// skrótem adresu e-mail (SHA-256, dawniej MD5) albo pod nazwą użytkownika.
// Do serwisu trafia wyłącznie skrót e-maila, nigdy sam adres.

import { createHash } from 'node:crypto';
import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, handleFromIdentifier, profileUrlIdentifier } from './identity.ts';

const ID = 'live-gravatar';
const SERVICE = 'gravatar.com';
const LABEL = 'Gravatar';
const MAX_DISCOVERED = 8;

interface GravatarEntry {
  hash?: string;
  profileUrl?: string;
  preferredUsername?: string;
  thumbnailUrl?: string;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string } | unknown[];
  emails?: { primary?: string | boolean; value?: string }[];
  phoneNumbers?: { type?: string; value?: string }[];
  aboutMe?: string;
  currentLocation?: string;
  job_title?: string;
  company?: string;
  accounts?: { domain?: string; display?: string; url?: string; username?: string; verified?: boolean | string; shortname?: string; name?: string }[];
  urls?: { value?: string; title?: string }[];
  currency?: { type?: string; value?: string }[];
  wallets?: unknown;
  payments?: { crypto_wallets?: unknown; links?: { label?: string; url?: string }[] };
  last_profile_edit?: string;
}

const hashHex = (algorithm: 'sha256' | 'md5', email: string) =>
  createHash(algorithm).update(email.trim().toLowerCase(), 'utf8').digest('hex');

/** Portfele z profilu: starsze pole `currency`, nowsze `wallets` i `payments.crypto_wallets`. */
function collectWallets(entry: GravatarEntry): string[] {
  const lines: string[] = [];
  const add = (label: unknown, address: unknown) => {
    if (typeof address === 'string' && address.trim()) lines.push(`- ${typeof label === 'string' && label ? label : 'portfel'}: ${address.trim()}`);
  };
  for (const item of entry.currency ?? []) add(item?.type, item?.value);
  for (const source of [entry.wallets, entry.payments?.crypto_wallets]) {
    if (Array.isArray(source)) {
      for (const item of source as Record<string, unknown>[]) add(item?.label ?? item?.type ?? item?.name, item?.address ?? item?.value);
    } else if (source && typeof source === 'object') {
      for (const [label, address] of Object.entries(source)) add(label, address);
    }
  }
  return [...new Set(lines)];
}

const isVerified = (value: boolean | string | undefined) => value === true || value === 'true';

export function createGravatarConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczny profil Gravatar w formacie JSON: dla e-maila gravatar.com/<SHA-256 adresu>.json (zapasowo skrót MD5), ' +
      'dla nicka gravatar.com/<nick>.json. Pola: nazwa, opis „o mnie", zweryfikowane konta, odnośniki i portfele kryptowalutowe. ' +
      'Do serwisu wysyłany jest wyłącznie skrót e-maila. Najwyżej 2 żądania na identyfikator.',
    accepts: ['email', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const slugs: string[] = [];
      if (identifier.type === 'email') {
        const email = identifier.value.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return [];
        slugs.push(hashHex('sha256', email), hashHex('md5', email));
      } else {
        const handle = handleFromIdentifier(identifier, [SERVICE]);
        if (!handle || !/^[a-z0-9_-]{2,60}$/i.test(handle)) return [];
        slugs.push(handle.toLowerCase());
      }

      const session = http.session(context, { label: LABEL });
      let entry: GravatarEntry | undefined;
      for (const slug of slugs) {
        const response = await session.get(`https://gravatar.com/${slug}.json`, {
          headers: { Accept: 'application/json' },
          quietMissing: true,
        });
        if (response) {
          entry = parseJson<{ entry?: GravatarEntry[] }>(response.text)?.entry?.[0];
          if (entry) break;
        }
        // Skrót MD5 sprawdzamy tylko wtedy, gdy pod SHA-256 nie ma profilu.
        if (session.lastStatus !== 404) break;
      }
      if (!entry) {
        if (!session.refused) context.log(`${LABEL}: brak publicznego profilu dla „${identifier.value}".`);
        return [];
      }

      const username = entry.preferredUsername?.trim();
      const nameParts = entry.name && !Array.isArray(entry.name) ? entry.name : undefined;
      const fullName = nameParts?.formatted?.trim() || [nameParts?.givenName, nameParts?.familyName].filter(Boolean).join(' ').trim() || undefined;
      const emails = [
        ...new Set(
          [identifier.type === 'email' ? identifier.value : undefined, ...(entry.emails ?? []).map((item) => item?.value)]
            .filter((value): value is string => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
            .map((value) => value.trim().toLowerCase()),
        ),
      ];
      const phones = [...new Set((entry.phoneNumbers ?? []).map((item) => item?.value?.replace(/[\s-]/g, '')).filter((value): value is string => Boolean(value)))];
      const wallets = collectWallets(entry);
      const accounts = (entry.accounts ?? []).filter((account) => account?.url);
      const urls = (entry.urls ?? []).filter((item) => item?.value);
      const text = [
        `Profil Gravatar: ${username ?? entry.displayName ?? identifier.value}`,
        entry.displayName && `Nazwa wyświetlana: ${entry.displayName}`,
        fullName && `Imię i nazwisko: ${fullName}`,
        emails.length > 0 && `E-mail: ${emails.join(', ')}`,
        phones.length > 0 && `Telefon: ${phones.join(', ')}`,
        entry.currentLocation && `Lokalizacja: ${entry.currentLocation}`,
        entry.job_title && `Stanowisko: ${entry.job_title}`,
        entry.company && `Firma: ${entry.company}`,
        entry.aboutMe && `O mnie: ${entry.aboutMe}`,
        wallets.length > 0 && `Portfele kryptowalutowe podane w profilu:\n${wallets.join('\n')}`,
        accounts.length > 0 &&
          `Konta w innych serwisach:\n${accounts
            .map((account) => `- ${account.name ?? account.shortname ?? account.domain ?? 'konto'}: ${account.url}${isVerified(account.verified) ? ' (zweryfikowane)' : ''}`)
            .join('\n')}`,
        urls.length > 0 && `Odnośniki:\n${urls.map((item) => `- ${item.title ? `${item.title}: ` : ''}${item.value}`).join('\n')}`,
      ]
        .filter(Boolean)
        .join('\n');

      const discovered: Identifier[] = [];
      // Profil znaleziony po e-mailu ujawnia nazwę użytkownika.
      if (identifier.type === 'email' && username) discovered.push({ type: 'nick', value: username });
      for (const account of accounts) {
        const found = isVerified(account.verified) ? profileUrlIdentifier(account.url!) : null;
        if (found) discovered.push(found);
      }
      for (const email of emails) discovered.push({ type: 'email', value: email });
      // Odnośniki wpisane przez właściciela profilu — deklaracja własnych stron.
      for (const item of urls) {
        const found = profileUrlIdentifier(item.value!);
        if (found) discovered.push(found);
      }

      const document: SourceDocument = {
        connectorId: ID,
        service: SERVICE,
        url: entry.profileUrl ?? `https://gravatar.com/${username ?? slugs[0]}`,
        title: `Profil Gravatar: ${username ?? entry.displayName ?? 'bez nazwy'}`,
        text,
        fetchedAt: new Date().toISOString(),
        author: username ?? entry.displayName ?? identifier.value,
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: {
          ...(username ? { handle: username } : {}),
          ...(fullName ?? entry.displayName ? { displayName: fullName ?? entry.displayName } : {}),
          // Profil wisi pod skrótem e-maila podanego przez analityka — serwis sam potwierdza przypisanie.
          ...(emails.length > 0 ? { emails } : {}),
          ...(phones.length > 0 ? { phones } : {}),
          ...(accounts.length + urls.length > 0 ? { urls: [...new Set([...accounts.map((account) => account.url!), ...urls.map((item) => item.value!)])] } : {}),
          ...(entry.currentLocation ? { location: entry.currentLocation } : {}),
          ...(entry.thumbnailUrl ? { avatarUrl: entry.thumbnailUrl } : {}),
          ...(entry.aboutMe ? { bio: entry.aboutMe } : {}),
        },
        ...(entry.last_profile_edit && !Number.isNaN(Date.parse(entry.last_profile_edit))
          ? { publishedAt: new Date(entry.last_profile_edit).toISOString() }
          : {}),
        ...discoveredField(dedupeIdentifiers(discovered, identifier, [SERVICE]).slice(0, MAX_DISCOVERED)),
      };
      context.log(`${LABEL}: „${identifier.value}" — profil ${document.url}, portfeli: ${wallets.length}.`);
      return [document];
    },
  };
}
