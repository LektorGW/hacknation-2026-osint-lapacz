// Łączniki GitHub: publiczne REST API. Czytają wyłącznie to, co widzi każdy
// niezalogowany użytkownik: dane profilu, README profilu, FUNDING.yml oraz
// publiczne gisty. Token jest opcjonalny i służy tylko podniesieniu limitu
// zapytań — trafia wyłącznie w nagłówku Authorization do api.github.com.

import type { ConnectorContext, Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, htmlToText } from './html.ts';
import { parseJson } from './http.ts';
import type { HttpClient, HttpSession } from './http.ts';
import { dedupeIdentifiers, discoveredField, handleFromIdentifier, profileUrlIdentifier } from './identity.ts';

const API = 'https://api.github.com';
const SERVICE = 'github.com';
const LABEL = 'GitHub';
const GISTS_LABEL = 'GitHub Gist';

const MAX_GIST_FILES = 3;
/** Z pliku gista bierzemy początek — adres w notatce „donate" mieści się dużo wcześniej. */
const MAX_GIST_CHARS = 20_000;

interface GithubUser {
  login: string;
  html_url: string;
  name: string | null;
  bio: string | null;
  company: string | null;
  location: string | null;
  blog: string | null;
  email: string | null;
  twitter_username: string | null;
  avatar_url?: string | null;
  created_at: string;
  updated_at: string;
}

interface GistFile {
  filename?: string;
  language?: string | null;
  content?: string;
  truncated?: boolean;
}

interface Gist {
  id: string;
  html_url: string;
  description: string | null;
  created_at?: string;
  updated_at?: string;
  owner?: { login?: string; avatar_url?: string };
  files?: Record<string, GistFile>;
}

export interface GithubConfig {
  /** Opcjonalny token (bez żadnych uprawnień) — podnosi limit zapytań z 60 do 5000 na godzinę. */
  token?: string;
}

/** Loginy GitHuba: litery, cyfry i łączniki, do 39 znaków. Inne wartości nie mogą być loginem. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function loginFrom(identifier: Identifier, hosts: string[]): string | null {
  const login = handleFromIdentifier(identifier, hosts);
  return login && LOGIN.test(login) ? login : null;
}

function openSession(http: HttpClient, context: ConnectorContext, label: string, config: GithubConfig): HttpSession {
  return http.session(context, {
    label,
    refusalMessage: (status) =>
      `${label}: limit zapytań GitHub (kod ${status}) — ustaw GITHUB_TOKEN` +
      (config.token ? ' (podany token został odrzucony lub wyczerpał limit)' : '') +
      '. Pomijam dalsze zapytania.',
  });
}

function apiHeaders(accept: string, config: GithubConfig): Record<string, string> {
  return {
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
  };
}

export function createGithubConnector(http: HttpClient, config: GithubConfig = {}): SourceConnector {
  const id = 'live-github';
  return {
    id,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczne REST API GitHuba (api.github.com): profil użytkownika o podanym loginie (bio, strona, e-mail, konto Twitter/X), ' +
      'README profilu (repozytorium <login>/<login>) oraz FUNDING.yml (w repozytorium profilu lub .github). ' +
      `Najwyżej 4 żądania na identyfikator; ${config.token ? 'z tokenem (wyższy limit zapytań)' : 'bez tokenu (limit 60 zapytań na godzinę na adres IP)'}.`,
    accepts: ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const login = loginFrom(identifier, [SERVICE]);
      if (!login) return [];
      const session = openSession(http, context, LABEL, config);
      const documents: SourceDocument[] = [];
      const get = async (path: string, accept: string, quietMissing = true) =>
        (await session.get(`${API}${path}`, { headers: apiHeaders(accept, config), quietMissing }))?.text ?? null;

      const userJson = await get(`/users/${login}`, 'application/vnd.github+json');
      const user = userJson ? parseJson<GithubUser>(userJson) : null;
      if (!user?.login) {
        if (!session.refused) context.log(`${LABEL}: brak użytkownika „${login}".`);
        return [];
      }

      const blogUrl = user.blog?.trim() ? (/^https?:\/\//i.test(user.blog.trim()) ? user.blog.trim() : `https://${user.blog.trim()}`) : undefined;
      const profileEmails = [...new Set([user.email?.toLowerCase(), ...findEmails(user.bio ?? '')].filter((email): email is string => Boolean(email)))];
      const profileUrls = [blogUrl, user.twitter_username ? `https://x.com/${user.twitter_username}` : undefined].filter((url): url is string => Boolean(url));
      const profile: ProfileAttributes = {
        handle: user.login,
        ...(user.name ? { displayName: user.name } : {}),
        ...(profileEmails.length > 0 ? { emails: profileEmails } : {}),
        ...(profileUrls.length > 0 ? { urls: profileUrls } : {}),
        ...(user.location ? { location: user.location } : {}),
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(user.created_at ? { createdAt: user.created_at } : {}),
      };
      const base = {
        connectorId: id,
        service: SERVICE,
        author: user.login,
        category: 'own_profile' as const,
        identityMatch: 'exact_identifier' as const,
        matchedIdentifier: identifier,
        profile,
      };

      const profileText = [
        `Profil GitHub: ${user.login}`,
        user.name && `Imię i nazwisko: ${user.name}`,
        user.bio && `Bio: ${user.bio}`,
        user.company && `Firma: ${user.company}`,
        user.location && `Lokalizacja: ${user.location}`,
        user.blog && `Strona: ${user.blog}`,
        user.email && `E-mail: ${user.email}`,
        user.twitter_username && `Twitter/X: ${user.twitter_username}`,
      ]
        .filter(Boolean)
        .join('\n');
      const discovered: Identifier[] = [];
      if (user.email) discovered.push({ type: 'email', value: user.email.toLowerCase() });
      if (user.twitter_username) discovered.push({ type: 'nick', value: user.twitter_username });
      if (user.blog?.trim()) {
        const blog = profileUrlIdentifier(/^https?:\/\//i.test(user.blog.trim()) ? user.blog.trim() : `https://${user.blog.trim()}`);
        if (blog) discovered.push(blog);
      }
      for (const email of findEmails(user.bio ?? '')) discovered.push({ type: 'email', value: email });
      documents.push({
        ...base,
        url: user.html_url,
        title: `Profil GitHub: ${user.login}`,
        text: profileText,
        fetchedAt: new Date().toISOString(),
        publishedAt: user.updated_at,
        ...discoveredField(dedupeIdentifiers(discovered, identifier)),
      });

      // README profilu leży w repozytorium o nazwie równej loginowi.
      const readme = await get(`/repos/${user.login}/${user.login}/readme`, 'application/vnd.github.raw+json');
      if (readme) {
        const text = htmlToText(readme);
        const emails = findEmails(text).map((value): Identifier => ({ type: 'email', value }));
        documents.push({
          ...base,
          url: `https://github.com/${user.login}/${user.login}`,
          title: `README profilu ${user.login}`,
          text,
          fetchedAt: new Date().toISOString(),
          ...discoveredField(dedupeIdentifiers(emails, identifier)),
        });
      }

      // FUNDING.yml: w repozytorium profilu albo we wspólnym repozytorium `.github`.
      const fundingPaths = [
        { repo: user.login, file: '.github/FUNDING.yml' },
        { repo: '.github', file: 'FUNDING.yml' },
      ];
      for (const { repo, file } of fundingPaths) {
        const funding = await get(`/repos/${user.login}/${repo}/contents/${file}`, 'application/vnd.github.raw+json');
        if (!funding) continue;
        documents.push({
          ...base,
          url: `https://github.com/${user.login}/${repo}/blob/HEAD/${file}`,
          title: `FUNDING.yml użytkownika ${user.login}`,
          text: funding,
          fetchedAt: new Date().toISOString(),
        });
        break;
      }

      context.log(`${LABEL}: „${login}" — dokumentów: ${documents.length} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}

/** Publiczne gisty to osobny łącznik z własnym limitem żądań; `service` pozostaje `github.com`. */
export function createGithubGistsConnector(http: HttpClient, config: GithubConfig = {}): SourceConnector {
  const id = 'live-github-gists';
  return {
    id,
    service: SERVICE,
    label: GISTS_LABEL,
    description:
      'Publiczne gisty użytkownika GitHub (api.github.com/users/<login>/gists): lista z opisami i nazwami plików oraz treść ' +
      `pierwszego pliku z najwyżej ${MAX_GIST_FILES} ostatnio zmienionych gistów. Najwyżej 4 żądania na identyfikator.`,
    accepts: ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const login = loginFrom(identifier, [SERVICE, 'gist.github.com']);
      if (!login) return [];
      const session = openSession(http, context, GISTS_LABEL, config);
      const headers = apiHeaders('application/vnd.github+json', config);

      const listResponse = await session.get(`${API}/users/${login}/gists?per_page=30`, { headers, quietMissing: true });
      const gists = listResponse ? parseJson<Gist[]>(listResponse.text) : null;
      if (!Array.isArray(gists) || gists.length === 0) {
        if (!session.refused) context.log(`${GISTS_LABEL}: „${login}" — brak publicznych gistów.`);
        return [];
      }

      const owner = gists[0]!.owner?.login ?? login;
      const avatarUrl = gists[0]!.owner?.avatar_url;
      const base = {
        connectorId: id,
        service: SERVICE,
        author: owner,
        category: 'own_profile' as const,
        identityMatch: 'exact_identifier' as const,
        matchedIdentifier: identifier,
        profile: { handle: owner, ...(avatarUrl ? { avatarUrl } : {}) } as ProfileAttributes,
      };
      const documents: SourceDocument[] = [
        {
          ...base,
          url: `https://gist.github.com/${owner}`,
          title: `Publiczne gisty użytkownika ${owner} — opisy`,
          text: gists
            .map((gist) => `- ${gist.description?.trim() || '(bez opisu)'} [pliki: ${Object.keys(gist.files ?? {}).join(', ') || 'brak'}] ${gist.html_url}`)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          ...(gists[0]!.updated_at ? { publishedAt: gists[0]!.updated_at } : {}),
        },
      ];

      for (const listed of gists.slice(0, MAX_GIST_FILES)) {
        if (!/^[0-9a-f]+$/i.test(listed.id)) continue;
        const response = await session.get(`${API}/gists/${listed.id}`, { headers });
        if (!response) {
          if (session.refused) break;
          continue;
        }
        const gist = parseJson<Gist>(response.text);
        const file = Object.values(gist?.files ?? {})[0];
        if (!gist || !file?.content) continue;
        const text = [
          gist.description?.trim() && `Opis: ${gist.description.trim()}`,
          `Plik: ${file.filename ?? '(bez nazwy)'}`,
          file.content.slice(0, MAX_GIST_CHARS),
        ]
          .filter(Boolean)
          .join('\n');
        documents.push({
          ...base,
          url: gist.html_url,
          title: `Gist ${owner}: ${gist.description?.trim() || file.filename || gist.id}`,
          text,
          fetchedAt: new Date().toISOString(),
          ...(gist.updated_at ?? gist.created_at ? { publishedAt: (gist.updated_at ?? gist.created_at)! } : {}),
        });
      }

      context.log(`${GISTS_LABEL}: „${login}" — gistów: ${gists.length}, dokumentów: ${documents.length} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}
