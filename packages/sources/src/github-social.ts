// Relacje konta w serwisie z kodem (graf społeczny): publiczne organizacje, obserwujący i obserwowani,
// własne repozytoria i ich współtwórcy. Pierwsza implementacja: GitHub REST API (https://api.github.com).
// Interfejs `SocialGraphProvider` jest wspólny — GitLab, Codeberg i inne serwisy z kodem można dopisać
// jako kolejnych dostawców bez zmian w ekspanderze sieci.
//
// Zasady:
//   - tylko udokumentowane punkty REST API, jawny User-Agent, token (opcjonalny) wyłącznie w nagłówku
//     Authorization do api.github.com;
//   - limit zapytań API jest respektowany: 403/429 albo `x-ratelimit-remaining: 0` kończy pobieranie
//     bez ponawiania (zapisany powód), a każde żądanie rezerwuje miejsce w budżecie rozwinięcia;
//   - limity liczności: organizacje 30, obserwujący 30 i obserwowani 30 (najnowsze strony listy),
//     własne repozytoria 30, współtwórcy 10 na repozytorium (największy wkład); gwiazdek nie pobieramy;
//   - obserwowanie konta nie świadczy o znajomości; współtwórca repozytorium to relacja zawodowa/projektowa.

import type { Fetcher } from './http.ts';
import { DEFAULT_TIMEOUT_MS, USER_AGENT } from './http.ts';

export const GITHUB_SOCIAL_LIMITS = {
  organizations: 30,
  followers: 30,
  following: 30,
  repos: 30,
  contributorsPerRepo: 10,
} as const;

/** Konto w serwisie (osoba lub organizacja) — zawsze konto, nigdy osoba. */
export interface SocialAccount {
  login: string;
  url: string;
  kind: 'user' | 'organization' | 'bot';
}

export interface SocialRepo {
  /** `właściciel/nazwa`. */
  fullName: string;
  url: string;
  fork: boolean;
  pushedAt?: string;
  /** Współtwórcy według serwisu (największy wkład pierwszy); bez kont automatów. Brak = nie pobrano. */
  contributors?: { login: string; url: string; contributions: number }[];
}

export interface SocialStop {
  reason: 'budget' | 'rate_limit' | 'source_error' | 'limit' | 'missing';
  detail: string;
  skipped?: number;
}

/** Wynik jednego odczytu relacji konta. */
export interface SocialGraph {
  service: string;
  login: string;
  profileUrl: string;
  organizations: SocialAccount[];
  followers: SocialAccount[];
  following: SocialAccount[];
  repos: SocialRepo[];
  /** Liczby podane przez serwis (całe listy, nie tylko pobrane). */
  totals: { followers?: number; following?: number; publicRepos?: number };
  /** Adresy API, z których pochodzą dane (dowody). */
  sources: string[];
  retrievedAt: string;
  requests: number;
  stops: SocialStop[];
}

export interface SocialGraphContext {
  /** Rezerwuje jedno zapytanie w budżecie; `false` — budżet wyczerpany. */
  reserve: () => boolean;
  log: (message: string) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

/** Dostawca relacji konta w jednym serwisie (GitHub dziś; GitLab, Codeberg — do dopisania). */
export interface SocialGraphProvider {
  id: string;
  /** Host serwisu, jak w kluczu konta (`profile:github.com|nazwa`). */
  service: string;
  label: string;
  /** Odwołanie do rozdziału dokumentu o podstawie prawnej. */
  legalBasis: string;
  /** Szacunkowa liczba zapytań na konto (do planu rozwinięcia). */
  estimate: number;
  /** Czy nazwa konta ma postać przyjmowaną przez serwis. */
  accepts(handle: string): boolean;
  fetch(handle: string, context: SocialGraphContext): Promise<SocialGraph | null>;
}

export interface GithubSocialConfig {
  fetcher?: Fetcher;
  /** Token GitHub; funkcja — odczyt przy każdym żądaniu (klucz można zmienić bez restartu). */
  token?: string | (() => string | undefined);
  apiBase?: string;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const PER_PAGE = 30;

interface ApiAccount {
  login?: string;
  html_url?: string;
  type?: string;
}

const accountOf = (item: ApiAccount, organization = false): SocialAccount | null =>
  item.login && LOGIN.test(item.login.replace(/\[bot\]$/, ''))
    ? {
        login: item.login,
        url: item.html_url ?? `https://github.com/${item.login}`,
        kind: organization || item.type === 'Organization' ? 'organization' : item.type === 'Bot' || /\[bot\]$/.test(item.login) ? 'bot' : 'user',
      }
    : null;

export function createGithubSocialProvider(config: GithubSocialConfig = {}): SocialGraphProvider {
  const api = (config.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const fetcher: Fetcher = config.fetcher ?? ((target, init) => fetch(target, init));
  const token = () => (typeof config.token === 'function' ? config.token() : config.token)?.trim() || undefined;

  return {
    id: 'github-social',
    service: 'github.com',
    label: 'GitHub REST API — organizacje, obserwujący, współtwórcy',
    legalBasis: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, „Relacje konta w serwisach z kodem i konta zadeklarowane na stronach WWW” — GitHub REST API',
    // Profil, organizacje, po 2 strony obserwujących i obserwowanych, lista repozytoriów, współtwórcy kilku repozytoriów.
    estimate: 12,
    accepts: (handle) => LOGIN.test(handle.replace(/^@/, '')),

    async fetch(handle, context) {
      const login = handle.replace(/^@/, '').trim();
      if (!LOGIN.test(login)) return null;
      const now = context.now ?? (() => new Date());
      const graph: SocialGraph = {
        service: 'github.com',
        login,
        profileUrl: `https://github.com/${login}`,
        organizations: [],
        followers: [],
        following: [],
        repos: [],
        totals: {},
        sources: [],
        retrievedAt: now().toISOString(),
        requests: 0,
        stops: [],
      };
      let halted = false;

      /** Jedno żądanie API: budżet, limit serwisu, błędy — zapisane jako powód zatrzymania, bez wyjątków. */
      const get = async <T>(path: string): Promise<T | null> => {
        if (halted) return null;
        if (!context.reserve()) {
          halted = true;
          graph.stops.push({ reason: 'budget', detail: `Budżet zapytań wyczerpany — GitHub: nie pobrano ${path}.` });
          return null;
        }
        graph.requests++;
        const secret = token();
        const timeout = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
        const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
        try {
          const response = await fetcher(`${api}${path}`, {
            headers: {
              'User-Agent': USER_AGENT,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
            },
            signal,
            redirect: 'follow',
          });
          const remaining = response.headers?.get('x-ratelimit-remaining');
          if (response.status === 403 || response.status === 429) {
            halted = true;
            graph.stops.push({ reason: 'rate_limit', detail: `GitHub odmówił albo wyczerpano limit zapytań API (kod ${response.status}) — pobieranie przerwano bez ponawiania${secret ? '' : '; token GITHUB_TOKEN podnosi limit z 60 do 5000 zapytań na godzinę'}.` });
            return null;
          }
          if (response.status === 404) {
            graph.stops.push({ reason: 'missing', detail: `GitHub: brak zasobu ${path}.` });
            return null;
          }
          if (!response.ok) {
            graph.stops.push({ reason: 'source_error', detail: `GitHub: kod ${response.status} dla ${path}.` });
            return null;
          }
          const body = JSON.parse(await response.text()) as T;
          graph.sources.push(`${api}${path}`);
          if (remaining !== null && remaining !== undefined && Number(remaining) <= 0) {
            halted = true;
            graph.stops.push({ reason: 'rate_limit', detail: 'GitHub: wyczerpano limit zapytań API (x-ratelimit-remaining: 0) — kolejnych żądań nie wysłano.' });
          }
          return body;
        } catch (error) {
          graph.stops.push({ reason: 'source_error', detail: `GitHub: ${path} — ${error instanceof Error ? error.message : String(error)}.` });
          return null;
        }
      };

      const user = await get<{ login?: string; html_url?: string; followers?: number; following?: number; public_repos?: number; type?: string }>(`/users/${encodeURIComponent(login)}`);
      if (!user?.login) {
        if (!graph.stops.length) graph.stops.push({ reason: 'missing', detail: `GitHub: brak konta „${login}”.` });
        return graph.requests > 0 ? graph : null;
      }
      graph.login = user.login;
      graph.profileUrl = user.html_url ?? graph.profileUrl;
      graph.totals = { ...(user.followers !== undefined ? { followers: user.followers } : {}), ...(user.following !== undefined ? { following: user.following } : {}), ...(user.public_repos !== undefined ? { publicRepos: user.public_repos } : {}) };
      const base = `/users/${encodeURIComponent(user.login)}`;

      // Publiczne członkostwa w organizacjach (tylko te, które konto samo upubliczniło).
      const orgs = (await get<ApiAccount[]>(`${base}/orgs?per_page=${GITHUB_SOCIAL_LIMITS.organizations}`)) ?? [];
      graph.organizations = orgs.map((item) => accountOf(item, true)).filter((item): item is SocialAccount => item !== null).slice(0, GITHUB_SOCIAL_LIMITS.organizations);

      /** Najnowsze wpisy listy (serwis podaje je od najstarszych): ostatnia strona, a gdy niepełna — także przedostatnia. */
      const recent = async (kind: 'followers' | 'following', total: number | undefined, cap: number): Promise<SocialAccount[]> => {
        if (!total) return [];
        const pages = Math.ceil(total / PER_PAGE);
        const wanted = pages > 1 && total % PER_PAGE !== 0 ? [pages - 1, pages] : [pages];
        const items: ApiAccount[] = [];
        for (const page of wanted) items.push(...((await get<ApiAccount[]>(`${base}/${kind}?per_page=${PER_PAGE}&page=${page}`)) ?? []));
        const accounts = items.map((item) => accountOf(item)).filter((item): item is SocialAccount => item !== null && item.kind !== 'bot');
        if (total > cap) graph.stops.push({ reason: 'limit', detail: `GitHub: ${kind === 'followers' ? 'obserwujących' : 'obserwowanych'} jest ${total} — pobrano ${Math.min(cap, accounts.length)} najnowszych (limit ${cap}).`, skipped: total - cap });
        return accounts.slice(-cap).reverse();
      };
      graph.followers = await recent('followers', user.followers, GITHUB_SOCIAL_LIMITS.followers);
      graph.following = await recent('following', user.following, GITHUB_SOCIAL_LIMITS.following);

      // Własne repozytoria (bez gwiazdek — za dużo szumu), ostatnio zmieniane pierwsze.
      const repos = (await get<{ full_name?: string; html_url?: string; fork?: boolean; pushed_at?: string }[]>(`${base}/repos?type=owner&sort=pushed&per_page=${GITHUB_SOCIAL_LIMITS.repos}`)) ?? [];
      graph.repos = repos
        .filter((repo) => repo.full_name)
        .slice(0, GITHUB_SOCIAL_LIMITS.repos)
        .map((repo) => ({ fullName: repo.full_name!, url: repo.html_url ?? `https://github.com/${repo.full_name}`, fork: Boolean(repo.fork), ...(repo.pushed_at ? { pushedAt: repo.pushed_at } : {}) }));
      if ((user.public_repos ?? 0) > GITHUB_SOCIAL_LIMITS.repos) {
        graph.stops.push({ reason: 'limit', detail: `GitHub: publicznych repozytoriów jest ${user.public_repos} — pobrano ${GITHUB_SOCIAL_LIMITS.repos} ostatnio zmienianych.`, skipped: user.public_repos! - GITHUB_SOCIAL_LIMITS.repos });
      }

      // Współtwórcy — tylko repozytoriów własnych (rozwidlenie ma współtwórców projektu źródłowego), do budżetu.
      let skipped = 0;
      for (const repo of graph.repos) {
        if (repo.fork) continue;
        if (halted) {
          skipped++;
          continue;
        }
        const list = await get<{ login?: string; html_url?: string; type?: string; contributions?: number }[]>(`/repos/${repo.fullName.split('/').map(encodeURIComponent).join('/')}/contributors?per_page=${GITHUB_SOCIAL_LIMITS.contributorsPerRepo}`);
        if (!list) continue;
        repo.contributors = list
          .filter((item) => item.login && item.type !== 'Bot' && !/\[bot\]$/.test(item.login))
          .sort((a, b) => (b.contributions ?? 0) - (a.contributions ?? 0))
          .slice(0, GITHUB_SOCIAL_LIMITS.contributorsPerRepo)
          .map((item) => ({ login: item.login!, url: item.html_url ?? `https://github.com/${item.login}`, contributions: item.contributions ?? 0 }));
      }
      if (skipped > 0) graph.stops.push({ reason: 'budget', detail: `GitHub: współtwórców ${skipped} repozytoriów nie pobrano (budżet albo limit API).`, skipped });

      context.log(
        `GitHub (relacje): ${graph.login} — organizacje ${graph.organizations.length}, obserwujący ${graph.followers.length}, obserwowani ${graph.following.length}, ` +
          `repozytoria ${graph.repos.length} (zapytań: ${graph.requests}).`,
      );
      return graph;
    },
  };
}
