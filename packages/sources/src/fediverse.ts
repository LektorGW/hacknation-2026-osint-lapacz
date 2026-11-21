// Łącznik Mastodon / Fediwersum: publiczne API instancji (accounts/lookup),
// dostępne bez logowania. Każda instancja jest osobnym serwisem, więc
// dokument dostaje `service` równy nazwie hosta instancji.

import { readFileSync } from 'node:fs';
import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, htmlToText } from './html.ts';
import { errorMessage, parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier } from './identity.ts';

const ID = 'live-fediverse';
const LABEL = 'Mastodon / Fediwersum';
const CONFIG_URL = new URL('../config/fediverse-instances.json', import.meta.url);
const FALLBACK_INSTANCES = ['mastodon.social'];
const MAX_INSTANCES = 4;

const USERNAME = /^[A-Za-z0-9_]{1,30}$/;
const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

interface MastodonAccount {
  username?: string;
  acct?: string;
  display_name?: string;
  note?: string;
  url?: string;
  created_at?: string;
  avatar?: string;
  bot?: boolean;
  fields?: { name?: string; value?: string; verified_at?: string | null }[];
}

/** Lista instancji sprawdzanych dla samego nicka; zwraca też powód, jeśli pliku nie da się użyć. */
export function loadFediverseInstances(configUrl: URL = CONFIG_URL): { instances: string[]; problem?: string } {
  try {
    const parsed = JSON.parse(readFileSync(configUrl, 'utf8')) as { instances?: unknown[] };
    const instances = (parsed.instances ?? [])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().toLowerCase())
      .filter((item) => HOSTNAME.test(item));
    return { instances: instances.length > 0 ? instances : FALLBACK_INSTANCES };
  } catch (error) {
    return { instances: FALLBACK_INSTANCES, problem: errorMessage(error) };
  }
}

/** Co sprawdzić: konto na wskazanej instancji albo nick na liście instancji. */
export function fediverseTargets(identifier: Identifier, instances: string[]): { username: string; hosts: string[]; explicitHost: boolean } | null {
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url) return null;
    // Adresy profili: https://host/@nick oraz https://host/users/nick.
    const parts = url.pathname.split('/').filter(Boolean);
    const username = parts[0]?.startsWith('@') && parts.length === 1 ? parts[0].slice(1).split('@')[0]! : parts[0] === 'users' && parts.length === 2 ? parts[1]! : '';
    const host = url.hostname.toLowerCase();
    if (!USERNAME.test(username) || !HOSTNAME.test(host)) return null;
    return { username, hosts: [host], explicitHost: true };
  }
  const [username, host] = cleanHandle(identifier.value).split('@') as [string, string | undefined];
  if (!USERNAME.test(username)) return null;
  if (host !== undefined) {
    return HOSTNAME.test(host.toLowerCase()) ? { username, hosts: [host.toLowerCase()], explicitHost: true } : null;
  }
  return { username, hosts: instances.slice(0, MAX_INSTANCES), explicitHost: false };
}

export interface FediverseConfig {
  /** Nadpisuje listę z config/fediverse-instances.json. */
  instances?: string[];
}

export function createFediverseConnector(http: HttpClient, config: FediverseConfig = {}): SourceConnector {
  const loaded = config.instances ? { instances: config.instances } : loadFediverseInstances();
  const instances = loaded.instances.slice(0, MAX_INSTANCES);

  return {
    id: ID,
    service: 'fediverse',
    label: LABEL,
    description:
      `Publiczne API instancji Mastodon (/api/v1/accounts/lookup?acct=<nick>, bez logowania). Nick sprawdzany na liście z ` +
      `config/fediverse-instances.json (${instances.join(', ')}); zapis nick@instancja lub adres profilu — tylko na wskazanej instancji. ` +
      'Pobierane: opis konta oraz pola profilu; pola z potwierdzonym odnośnikiem (verified_at) wskazują inne profile tej samej osoby. ' +
      'Najwyżej 4 żądania na identyfikator, po jednym na instancję.',
    accepts: ['nick', 'login', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      if ('problem' in loaded && loaded.problem) context.log(`${LABEL}: nie można odczytać listy instancji: ${loaded.problem}`);
      const targets = fediverseTargets(identifier, instances);
      if (!targets) return [];
      const session = http.session(context, { label: LABEL });
      const documents: SourceDocument[] = [];

      for (const host of targets.hosts) {
        const response = await session.get(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(targets.username)}`, {
          headers: { Accept: 'application/json' },
          quietMissing: true,
          // Host wskazany w identyfikatorze nie jest zaufany — tylko adresy publiczne.
          ...(targets.explicitHost ? { publicOnly: true } : {}),
        });
        const account = response ? parseJson<MastodonAccount>(response.text) : null;
        if (!account?.username) continue;

        const note = htmlToText(account.note ?? '');
        const fields = (account.fields ?? []).filter((field) => field?.name || field?.value);
        const fieldLines = fields.map((field) => {
          const value = htmlToText(field.value ?? '').replace(/\n/g, ' ');
          return `- ${field.name ?? ''}: ${value}${field.verified_at ? ' (odnośnik potwierdzony przez instancję)' : ''}`;
        });
        const text = [
          `Profil ${account.username}@${host}`,
          account.display_name && `Nazwa wyświetlana: ${account.display_name}`,
          account.created_at && `Konto utworzone: ${account.created_at.slice(0, 10)}`,
          note && `Opis:\n${note}`,
          fieldLines.length > 0 && `Pola profilu:\n${fieldLines.join('\n')}`,
        ]
          .filter(Boolean)
          .join('\n');

        const discovered: Identifier[] = [];
        for (const field of fields) {
          if (!field.verified_at) continue;
          // Potwierdzenie oznacza, że wskazana strona odsyła z powrotem do tego profilu (rel="me").
          const href = findLinks(field.value ?? '')[0] ?? htmlToText(field.value ?? '');
          const found = profileUrlIdentifier(href);
          if (found) discovered.push(found);
        }
        for (const email of findEmails(note)) discovered.push({ type: 'email', value: email });
        // Do danych profilu trafiają wszystkie odnośniki z pól — także te niepotwierdzone przez instancję.
        const fieldUrls = fields
          .map((field) => findLinks(field.value ?? '')[0])
          .filter((href): href is string => typeof href === 'string' && /^https?:\/\//i.test(href));

        documents.push({
          connectorId: ID,
          service: host,
          url: account.url ?? `https://${host}/@${account.username}`,
          title: `Profil Mastodon: ${account.username}@${host}`,
          text,
          fetchedAt: new Date().toISOString(),
          author: account.username,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: {
            handle: account.username,
            ...(account.display_name ? { displayName: account.display_name } : {}),
            ...(findEmails(note).length > 0 ? { emails: findEmails(note) } : {}),
            ...(fieldUrls.length > 0 ? { urls: [...new Set(fieldUrls)] } : {}),
            ...(account.avatar ? { avatarUrl: account.avatar } : {}),
            ...(note ? { bio: note } : {}),
            ...(account.created_at && !Number.isNaN(Date.parse(account.created_at)) ? { createdAt: new Date(account.created_at).toISOString() } : {}),
          },
          ...discoveredField(dedupeIdentifiers(discovered, identifier, [host])),
        });
      }

      context.log(
        `${LABEL}: „${identifier.value}" — profili: ${documents.length} (sprawdzone instancje: ${targets.hosts.join(', ')}).`,
      );
      return documents;
    },
  };
}
