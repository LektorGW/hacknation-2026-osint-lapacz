// Łączniki serwisów z kodem (poza GitHubem): GitLab.com i Codeberg (Forgejo). Czytają wyłącznie to,
// co widzi każdy niezalogowany użytkownik: dane profilu, listę publicznych projektów z opisami
// oraz README profilu. Adresy kryptowalutowe trafiają do analizy przez treść dokumentów.
//
// Podstawa (sprawdzone 22.11.2026, wiersze w docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 12):
//   • GitLab API Terms of Use (https://handbook.gitlab.com/handbook/legal/api-terms/) — 1.1: prawo „to access and use
//     the GitLab APIs”; 1.3.9: zakaz „bulk collection or scraping of information, including for repeated or systematic
//     bulk exporting” — łącznik wykonuje pojedyncze, celowane zapytania (najwyżej 4 na identyfikator).
//     Wyszukiwarka kodu GitLab („Every call to this API requires authentication.”, zakres `blobs` tylko w planach
//     Premium/Ultimate) — nie jest używana. Wyszukiwarka użytkowników (/users?search=) bez logowania odpowiada
//     „403 Forbidden - Not authorized to access /api/v4/users” (sprawdzone 22.11.2026) → imię i nazwisko tylko z tokenem.
//   • Codeberg — Imprint (https://codeberg.org/codeberg/org/src/branch/main/Imprint.md): „Please refer to the official
//     Forgejo Swagger API documentation for information to access the API endpoints.”; regulamin §2(5): nadmierny ruch
//     → ostrzeżenie; robots.txt: „Crawl-delay: 2” — łącznik zachowuje odstęp 2 s.

import type { Identifier, ProfileAttributes, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails } from './html.ts';
import { parseJson } from './http.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, handleFromIdentifier, profileUrlIdentifier } from './identity.ts';

/** Z README bierzemy początek — adres w sekcji „wsparcie” mieści się dużo wcześniej. */
const MAX_README_CHARS = 20_000;
const MAX_PROJECTS = 20;

const withScheme = (value: string): string => (/^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`);

/** Najwyżej tyle profili zgodnych nazwiskiem zwraca jeden serwis. */
export const MAX_NAME_MATCHES = 5;

/** Słowa imienia i nazwiska bez znaków diakrytycznych i wielkości liter („Łukasz Żak” → [„lukasz”, „zak”]). */
export function nameTokens(value: string): string[] {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Imię i nazwisko nadające się do wyszukiwania: co najmniej dwa słowa, bez znaków spoza nazw osób. */
export function searchableName(identifier: { type: string; value: string }): string | null {
  if (identifier.type !== 'full_name') return null;
  const value = identifier.value.trim().replace(/\s+/g, ' ');
  if (value.length < 4 || value.length > 100 || !/^[\p{L}' .-]+$/u.test(value)) return null;
  return nameTokens(value).filter((token) => token.length >= 2).length >= 2 ? value : null;
}

/**
 * Kolejność wyników wyszukiwania po nazwisku: najpierw pełna zgodność nazwy wyświetlanej (te same słowa w dowolnej
 * kolejności, bez znaków diakrytycznych), potem nazwy zawierające wszystkie szukane słowa (np. z drugim imieniem).
 * Konta zgodne tylko loginem odpadają. Najwyżej `MAX_NAME_MATCHES`.
 */
export function rankByName<T>(items: T[], displayName: (item: T) => string | null | undefined, query: string): { item: T; exact: boolean }[] {
  const wanted = nameTokens(query);
  const key = [...wanted].sort().join(' ');
  const ranked: { item: T; exact: boolean }[] = [];
  for (const item of items) {
    const tokens = nameTokens(displayName(item) ?? '');
    if (tokens.length === 0) continue;
    if ([...tokens].sort().join(' ') === key) ranked.push({ item, exact: true });
    else if (wanted.every((token) => tokens.includes(token))) ranked.push({ item, exact: false });
  }
  return [...ranked.filter((entry) => entry.exact), ...ranked.filter((entry) => !entry.exact)].slice(0, MAX_NAME_MATCHES);
}

const NAMESAKE_NOTE = 'UWAGA: profil odnaleziony wyłącznie po imieniu i nazwisku — może należeć do innej osoby o tym samym nazwisku (imiennik).';

/** Odnośniki z profilu (strona, konta w innych serwisach) jako identyfikatory odkryte. */
function linkIdentifiers(urls: (string | null | undefined)[]): Identifier[] {
  return urls
    .filter((url): url is string => Boolean(url?.trim()))
    .map((url) => profileUrlIdentifier(withScheme(url)))
    .filter((item): item is Identifier => Boolean(item));
}

// ---------- GitLab.com ----------

const GITLAB = 'https://gitlab.com';
const GITLAB_SERVICE = 'gitlab.com';
const GITLAB_LABEL = 'GitLab';
/** Nazwy użytkowników GitLab: litery, cyfry, „_”, „-”, „.”; pierwszy znak alfanumeryczny. */
const GITLAB_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

interface GitlabUserBasic {
  id: number;
  username: string;
  name?: string;
  state?: string;
  public_email?: string;
  avatar_url?: string;
  web_url?: string;
}

interface GitlabUserFull extends GitlabUserBasic {
  bio?: string;
  location?: string;
  website_url?: string;
  twitter?: string;
  github?: string;
  linkedin?: string;
  discord?: string;
  organization?: string;
  job_title?: string;
  created_at?: string;
}

interface GitlabProject {
  name?: string;
  path?: string;
  path_with_namespace?: string;
  description?: string | null;
  web_url?: string;
  default_branch?: string;
  last_activity_at?: string;
}

export interface GitlabConfig {
  /**
   * Opcjonalny token (zakres `read_api` wystarcza) — GitLab udostępnia pełny profil (bio, strona, konta w innych
   * serwisach) tylko zalogowanym. Trafia wyłącznie w nagłówku PRIVATE-TOKEN do gitlab.com.
   */
  token?: string;
}

export function createGitlabConnector(http: HttpClient, config: GitlabConfig = {}): SourceConnector {
  const id = 'live-gitlab';
  const headers = { Accept: 'application/json', ...(config.token ? { 'PRIVATE-TOKEN': config.token } : {}) };
  return {
    id,
    service: GITLAB_SERVICE,
    label: GITLAB_LABEL,
    description:
      'Publiczne REST API GitLab.com (gitlab.com/api/v4): użytkownik o podanej nazwie (/users?username=), lista jego publicznych ' +
      `projektów z opisami (do ${MAX_PROJECTS}) oraz README profilu (projekt <nazwa>/<nazwa>). ` +
      (config.token
        ? 'Z tokenem GITLAB_TOKEN także pełny profil: bio, strona, konta Twitter/X, GitHub, LinkedIn. '
        : 'Bez tokenu GitLab nie udostępnia bio ani strony z profilu (ustaw GITLAB_TOKEN). ') +
      (config.token
        ? `Imię i nazwisko: wyszukiwarka użytkowników (/users?search=, wymaga tokenu), najwyżej ${MAX_NAME_MATCHES} profili zgodnych nazwą — oznaczanych jako możliwi imiennicy. `
        : 'Wyszukiwanie po imieniu i nazwisku wymaga tokenu GITLAB_TOKEN (GitLab.com odmawia go bez logowania). ') +
      'Wyszukiwarka kodu GitLab nie jest używana (wymaga logowania i płatnego planu). Najwyżej 4 żądania na identyfikator.',
    // Wyszukiwarka użytkowników GitLab.com bez logowania odpowiada 403 — bez tokenu nie przyjmujemy imienia i nazwiska.
    accepts: config.token ? ['login', 'nick', 'profile_url', 'full_name'] : ['login', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      if (identifier.type === 'full_name') {
        const name = config.token ? searchableName(identifier) : null;
        if (!name) return [];
        const session = http.session(context, { label: GITLAB_LABEL, limit: 1 });
        const response = await session.get(`${GITLAB}/api/v4/users?search=${encodeURIComponent(name)}&per_page=20`, { headers, quietMissing: true });
        const users = response ? parseJson<GitlabUserBasic[]>(response.text) : null;
        const matches = rankByName(Array.isArray(users) ? users.filter((user) => user?.username && user.state !== 'blocked') : [], (user) => user.name, name);
        context.log(`${GITLAB_LABEL}: „${name}" — profili zgodnych nazwą: ${matches.length}.`);
        return matches.map(({ item: user, exact }): SourceDocument => ({
          connectorId: id,
          service: GITLAB_SERVICE,
          url: user.web_url ?? `${GITLAB}/${user.username}`,
          title: `Profil GitLab: ${user.username} (zgodne imię i nazwisko)`,
          text: [
            `Profil GitLab: ${user.username}`,
            user.name && `Imię i nazwisko (wyświetlane): ${user.name}`,
            user.public_email && `E-mail publiczny: ${user.public_email}`,
            exact ? 'Nazwa wyświetlana zgodna z szukaną.' : 'Nazwa wyświetlana zawiera szukane imię i nazwisko (z dodatkowymi słowami).',
            NAMESAKE_NOTE,
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          author: user.username,
          category: 'own_profile',
          identityMatch: 'name_only',
          matchedIdentifier: identifier,
          profile: { handle: user.username, ...(user.name ? { displayName: user.name } : {}), ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) },
          ...discoveredField(dedupeIdentifiers(user.public_email ? [{ type: 'email', value: user.public_email.toLowerCase() }] : [], identifier)),
        }));
      }
      const login = handleFromIdentifier(identifier, [GITLAB_SERVICE]);
      if (!login || !GITLAB_LOGIN.test(login)) return [];
      const session = http.session(context, {
        label: GITLAB_LABEL,
        refusalMessage: (status) =>
          `${GITLAB_LABEL}: odmowa lub limit zapytań (kod ${status})${config.token ? ' — token GITLAB_TOKEN odrzucony lub wyczerpany' : ''}. Pomijam dalsze zapytania.`,
      });
      const getJson = async <T>(path: string): Promise<T | null> => {
        const response = await session.get(`${GITLAB}/api/v4${path}`, { headers, quietMissing: true });
        return response ? parseJson<T>(response.text) : null;
      };

      const found = await getJson<GitlabUserBasic[]>(`/users?username=${encodeURIComponent(login)}`);
      const basic = Array.isArray(found) ? found.find((user) => user?.username?.toLowerCase() === login.toLowerCase()) : undefined;
      if (!basic?.id) {
        if (!session.refused) context.log(`${GITLAB_LABEL}: brak użytkownika „${login}".`);
        return [];
      }
      // Pełny profil GitLab zwraca tylko zalogowanym — bez tokenu nie wysyłamy zapytania skazanego na 403.
      const full = config.token ? await getJson<GitlabUserFull>(`/users/${basic.id}`) : null;
      const user: GitlabUserFull = { ...basic, ...(full ?? {}) };
      const webUrl = user.web_url ?? `${GITLAB}/${user.username}`;

      const links = linkIdentifiers([
        user.website_url,
        user.twitter && `https://x.com/${user.twitter.replace(/^@/, '')}`,
        user.github && `https://github.com/${user.github.replace(/^@/, '')}`,
        user.linkedin && (/^https?:/i.test(user.linkedin) ? user.linkedin : `https://www.linkedin.com/in/${user.linkedin}`),
      ]);
      const emails = [...new Set([user.public_email?.toLowerCase(), ...findEmails(user.bio ?? '')].filter((email): email is string => Boolean(email)))];
      const profile: ProfileAttributes = {
        handle: user.username,
        ...(user.name ? { displayName: user.name } : {}),
        ...(emails.length > 0 ? { emails } : {}),
        ...(links.length > 0 ? { urls: links.map((item) => item.value) } : {}),
        ...(user.location ? { location: user.location } : {}),
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        ...(user.bio ? { bio: user.bio } : {}),
        ...(user.created_at ? { createdAt: user.created_at } : {}),
      };
      const base = {
        connectorId: id,
        service: GITLAB_SERVICE,
        author: user.username,
        category: 'own_profile' as const,
        identityMatch: 'exact_identifier' as const,
        matchedIdentifier: identifier,
        profile,
      };
      const discovered: Identifier[] = [...emails.map((value): Identifier => ({ type: 'email', value })), ...links];
      if (user.github) discovered.push({ type: 'login', value: user.github.replace(/^@/, '') });
      const documents: SourceDocument[] = [
        {
          ...base,
          url: webUrl,
          title: `Profil GitLab: ${user.username}`,
          text: [
            `Profil GitLab: ${user.username}`,
            user.name && `Imię i nazwisko: ${user.name}`,
            user.bio && `Bio: ${user.bio}`,
            user.job_title && `Stanowisko: ${user.job_title}`,
            user.organization && `Organizacja: ${user.organization}`,
            user.location && `Lokalizacja: ${user.location}`,
            user.website_url && `Strona: ${user.website_url}`,
            user.public_email && `E-mail publiczny: ${user.public_email}`,
            user.twitter && `Twitter/X: ${user.twitter}`,
            user.github && `GitHub: ${user.github}`,
            user.linkedin && `LinkedIn: ${user.linkedin}`,
            user.discord && `Discord: ${user.discord}`,
            !config.token && 'Uwaga: bez tokenu GitLab nie udostępnia bio, strony ani kont w innych serwisach.',
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          ...discoveredField(dedupeIdentifiers(discovered, identifier, [GITLAB_SERVICE])),
        },
      ];

      const projects = await getJson<GitlabProject[]>(`/users/${basic.id}/projects?per_page=${MAX_PROJECTS}&order_by=last_activity_at&simple=true`);
      if (Array.isArray(projects) && projects.length > 0) {
        const newest = projects.map((project) => project.last_activity_at).filter((time): time is string => Boolean(time)).sort().at(-1);
        documents.push({
          ...base,
          url: `${webUrl}?tab=projects`,
          title: `Publiczne projekty GitLab użytkownika ${user.username}`,
          text: [
            `Publiczne projekty użytkownika GitLab ${user.username} (opisy podane przez właściciela):`,
            ...projects.map((project) => `- ${project.path_with_namespace ?? project.name}: ${project.description?.trim() || '(bez opisu)'} ${project.web_url ?? ''}`.trim()),
          ].join('\n'),
          fetchedAt: new Date().toISOString(),
          ...(newest ? { publishedAt: newest } : {}),
        });

        // README profilu leży w projekcie o nazwie równej nazwie użytkownika.
        const own = projects.find((project) => project.path?.toLowerCase() === user.username.toLowerCase());
        if (own) {
          const path = encodeURIComponent(`${user.username}/${own.path}`);
          const readme = await session.get(
            `${GITLAB}/api/v4/projects/${path}/repository/files/README.md/raw?ref=${encodeURIComponent(own.default_branch || 'HEAD')}`,
            { headers, quietMissing: true },
          );
          if (readme?.text.trim()) {
            const text = readme.text.slice(0, MAX_README_CHARS);
            documents.push({
              ...base,
              url: own.web_url ?? `${GITLAB}/${user.username}/${own.path}`,
              title: `README profilu GitLab ${user.username}`,
              text,
              fetchedAt: new Date().toISOString(),
              ...discoveredField(dedupeIdentifiers(findEmails(text).map((value): Identifier => ({ type: 'email', value })), identifier)),
            });
          }
        }
      }

      context.log(`${GITLAB_LABEL}: „${login}" — dokumentów: ${documents.length} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}

// ---------- Codeberg (Forgejo) ----------

const CODEBERG = 'https://codeberg.org';
const CODEBERG_SERVICE = 'codeberg.org';
const CODEBERG_LABEL = 'Codeberg';
const CODEBERG_LOGIN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
/** robots.txt Codeberg: „Crawl-delay: 2”. */
const CODEBERG_INTERVAL_MS = 2000;

interface ForgejoUser {
  login?: string;
  full_name?: string;
  email?: string;
  avatar_url?: string;
  html_url?: string;
  location?: string;
  website?: string;
  description?: string;
  created?: string;
}

interface ForgejoRepo {
  name?: string;
  full_name?: string;
  description?: string;
  html_url?: string;
  website?: string;
  default_branch?: string;
  updated_at?: string;
}

export function createCodebergConnector(http: HttpClient): SourceConnector {
  const id = 'live-codeberg';
  return {
    id,
    service: CODEBERG_SERVICE,
    label: CODEBERG_LABEL,
    description:
      'Publiczne API Codeberg (Forgejo, codeberg.org/api/v1): profil użytkownika o podanej nazwie (imię, opis, strona, lokalizacja), ' +
      `lista jego publicznych repozytoriów z opisami (do ${MAX_PROJECTS}) oraz README profilu (repozytorium .profile). ` +
      `Imię i nazwisko: wyszukiwarka użytkowników (/users/search?q=), najwyżej ${MAX_NAME_MATCHES} profili zgodnych nazwą — oznaczanych jako możliwi imiennicy. ` +
      'Najwyżej 3 żądania na identyfikator, odstęp 2 s (Crawl-delay serwisu).',
    accepts: ['login', 'nick', 'profile_url', 'full_name'],
    enabledByDefault: true,

    async search(identifier, context) {
      if (identifier.type === 'full_name') {
        const name = searchableName(identifier);
        if (!name) return [];
        const session = http.session(context, { label: CODEBERG_LABEL, limit: 1 });
        const response = await session.get(`${CODEBERG}/api/v1/users/search?q=${encodeURIComponent(name)}&limit=20`, {
          headers: { Accept: 'application/json' },
          quietMissing: true,
          minIntervalMs: CODEBERG_INTERVAL_MS,
        });
        const users = (response ? parseJson<{ data?: ForgejoUser[] }>(response.text)?.data : null) ?? [];
        const matches = rankByName(users.filter((user) => user?.login), (user) => user.full_name, name);
        context.log(`${CODEBERG_LABEL}: „${name}" — profili zgodnych nazwą: ${matches.length}.`);
        return matches.map(({ item: user, exact }): SourceDocument => {
          const links = linkIdentifiers([user.website]);
          return {
            connectorId: id,
            service: CODEBERG_SERVICE,
            url: user.html_url ?? `${CODEBERG}/${user.login}`,
            title: `Profil Codeberg: ${user.login} (zgodne imię i nazwisko)`,
            text: [
              `Profil Codeberg: ${user.login}`,
              user.full_name && `Imię i nazwisko (wyświetlane): ${user.full_name}`,
              user.description && `Opis: ${user.description}`,
              user.location && `Lokalizacja: ${user.location}`,
              user.website && `Strona: ${user.website}`,
              exact ? 'Nazwa wyświetlana zgodna z szukaną.' : 'Nazwa wyświetlana zawiera szukane imię i nazwisko (z dodatkowymi słowami).',
              NAMESAKE_NOTE,
            ]
              .filter(Boolean)
              .join('\n'),
            fetchedAt: new Date().toISOString(),
            author: user.login!,
            category: 'own_profile',
            identityMatch: 'name_only',
            matchedIdentifier: identifier,
            profile: {
              handle: user.login!,
              ...(user.full_name ? { displayName: user.full_name } : {}),
              ...(user.location ? { location: user.location } : {}),
              ...(user.description ? { bio: user.description } : {}),
              ...(links.length > 0 ? { urls: links.map((item) => item.value) } : {}),
            },
            ...discoveredField(dedupeIdentifiers([...findEmails(`${user.email ?? ''} ${user.description ?? ''}`).map((value): Identifier => ({ type: 'email', value })), ...links], identifier, [CODEBERG_SERVICE])),
          };
        });
      }
      const login = handleFromIdentifier(identifier, [CODEBERG_SERVICE]);
      if (!login || !CODEBERG_LOGIN.test(login)) return [];
      const session = http.session(context, { label: CODEBERG_LABEL, limit: 3 });
      const get = (path: string) =>
        session.get(`${CODEBERG}/api/v1${path}`, { headers: { Accept: 'application/json' }, quietMissing: true, minIntervalMs: CODEBERG_INTERVAL_MS });

      const userResponse = await get(`/users/${encodeURIComponent(login)}`);
      const user = userResponse ? parseJson<ForgejoUser>(userResponse.text) : null;
      if (!user?.login || user.login.toLowerCase() !== login.toLowerCase()) {
        if (!session.refused) context.log(`${CODEBERG_LABEL}: brak użytkownika „${login}".`);
        return [];
      }
      const htmlUrl = user.html_url ?? `${CODEBERG}/${user.login}`;
      const links = linkIdentifiers([user.website]);
      const emails = [...new Set([user.email?.toLowerCase(), ...findEmails(user.description ?? '')].filter((email): email is string => Boolean(email)))];
      const profile: ProfileAttributes = {
        handle: user.login,
        ...(user.full_name ? { displayName: user.full_name } : {}),
        ...(links.length > 0 ? { urls: links.map((item) => item.value) } : {}),
        ...(user.location ? { location: user.location } : {}),
        ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
        ...(user.description ? { bio: user.description } : {}),
        ...(user.created ? { createdAt: user.created } : {}),
      };
      const base = {
        connectorId: id,
        service: CODEBERG_SERVICE,
        author: user.login,
        category: 'own_profile' as const,
        identityMatch: 'exact_identifier' as const,
        matchedIdentifier: identifier,
        profile,
      };
      const documents: SourceDocument[] = [
        {
          ...base,
          url: htmlUrl,
          title: `Profil Codeberg: ${user.login}`,
          text: [
            `Profil Codeberg: ${user.login}`,
            user.full_name && `Imię i nazwisko: ${user.full_name}`,
            user.description && `Opis: ${user.description}`,
            user.location && `Lokalizacja: ${user.location}`,
            user.website && `Strona: ${user.website}`,
          ]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          // Adresy „…@noreply.codeberg.org” odrzuca dedupeIdentifiers.
          ...discoveredField(dedupeIdentifiers([...emails.map((value): Identifier => ({ type: 'email', value })), ...links], identifier, [CODEBERG_SERVICE])),
        },
      ];

      const reposResponse = await get(`/users/${encodeURIComponent(user.login)}/repos?limit=${MAX_PROJECTS}`);
      const repos = reposResponse ? parseJson<ForgejoRepo[]>(reposResponse.text) : null;
      if (Array.isArray(repos) && repos.length > 0) {
        const newest = repos.map((repo) => repo.updated_at).filter((time): time is string => Boolean(time)).sort().at(-1);
        documents.push({
          ...base,
          url: `${htmlUrl}?tab=repositories`,
          title: `Publiczne repozytoria Codeberg użytkownika ${user.login}`,
          text: [
            `Publiczne repozytoria użytkownika Codeberg ${user.login} (opisy podane przez właściciela):`,
            ...repos.map((repo) => `- ${repo.full_name ?? repo.name}: ${repo.description?.trim() || '(bez opisu)'}${repo.website ? ` — strona: ${repo.website}` : ''} ${repo.html_url ?? ''}`.trim()),
          ].join('\n'),
          fetchedAt: new Date().toISOString(),
          ...(newest ? { publishedAt: newest } : {}),
        });
        // README profilu Forgejo leży w repozytorium `.profile` — pytamy tylko, gdy ono istnieje.
        if (repos.some((repo) => repo.name === '.profile')) {
          const readme = await get(`/repos/${encodeURIComponent(user.login)}/.profile/raw/README.md`);
          if (readme?.text.trim()) {
            const text = readme.text.slice(0, MAX_README_CHARS);
            documents.push({
              ...base,
              url: `${CODEBERG}/${user.login}/.profile`,
              title: `README profilu Codeberg ${user.login}`,
              text,
              fetchedAt: new Date().toISOString(),
              ...discoveredField(dedupeIdentifiers(findEmails(text).map((value): Identifier => ({ type: 'email', value })), identifier)),
            });
          }
        }
      }

      context.log(`${CODEBERG_LABEL}: „${login}" — dokumentów: ${documents.length} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}
