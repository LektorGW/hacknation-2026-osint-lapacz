// Silniki oparte na publicznych API: osie czasu hashtagów Mastodona, StackExchange,
// Hacker News (Algolia), podgląd kanałów Telegram oraz — tylko z tokenem — wyszukiwarka GitHuba.

import type { Identifier, ProfileAttributes } from '@olcys/core';
import { findLinks, htmlToText } from '../html.ts';
import { parseJson } from '../http.ts';
import { profileUrlIdentifier } from '../identity.ts';
import { parseTelegramPreview } from '../telegram.ts';
import { SLOW_INTERVAL_MS, hostOf, postText, searchTerm, toIso } from './common.ts';
import type { EngineAdapter, EngineRun, MonitorPost } from './common.ts';

const JSON_HEADERS = { Accept: 'application/json' };

async function getJson<T>(run: EngineRun, url: string, headers: Record<string, string> = JSON_HEADERS): Promise<T | null> {
  const response = await run.session.get(url, { headers, minIntervalMs: run.intervalMs, quietMissing: true });
  return response ? parseJson<T>(response.text) : null;
}

// ---------- Mastodon: oś czasu hashtagu ----------

interface MastodonStatus {
  id?: string;
  created_at?: string;
  url?: string | null;
  uri?: string;
  content?: string;
  spoiler_text?: string;
  account?: {
    username?: string;
    acct?: string;
    display_name?: string;
    url?: string;
    avatar?: string;
    note?: string;
    created_at?: string;
    bot?: boolean;
    fields?: { name?: string; value?: string; verified_at?: string | null }[];
  };
}

export const mastodonTagEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Publiczna oś czasu hashtagu #${source.tag} na instancji ${source.instance} (/api/v1/timelines/tag/<tag>, bez logowania): ` +
    'treść wpisów oraz dane konta autora (nazwa, opis, pola profilu, awatar). Jedno żądanie na przebieg; bez wyszukiwania.',
  service: (source) => hostOf(source.instance),
  problem: (source) =>
    !source.instance || !hostOf(source.instance) ? 'brak pola „instance"' : !source.tag || !/^[\p{L}\p{N}_]{1,60}$/u.test(source.tag) ? 'brak lub niepoprawne pole „tag"' : null,
  requestHost: (source) => hostOf(source.instance),
  addressKey: (source) => `${hostOf(source.instance)}#${(source.tag ?? '').toLowerCase()}`,

  async discover(run) {
    const instance = hostOf(run.source.instance);
    const statuses = await getJson<MastodonStatus[]>(run, `https://${instance}/api/v1/timelines/tag/${encodeURIComponent(run.source.tag!)}?limit=20`);
    const posts: MonitorPost[] = [];
    for (const status of Array.isArray(statuses) ? statuses : []) {
      const account = status.account;
      const url = status.url ?? status.uri;
      if (!account?.acct || !url || account.bot) continue;
      const fieldUrls = (account.fields ?? [])
        .map((field) => findLinks(field.value ?? '')[0])
        .filter((href): href is string => typeof href === 'string' && /^https?:\/\//i.test(href));
      const verified: Identifier[] = (account.fields ?? [])
        .filter((field) => field.verified_at)
        .map((field) => profileUrlIdentifier(findLinks(field.value ?? '')[0] ?? ''))
        .filter((item): item is Identifier => item !== null);
      const bio = htmlToText(account.note ?? '');
      const profile: ProfileAttributes = {
        ...(account.display_name ? { displayName: account.display_name } : {}),
        urls: [...new Set([account.url, ...fieldUrls].filter((value): value is string => Boolean(value)))],
        ...(account.avatar ? { avatarUrl: account.avatar } : {}),
        ...(bio ? { bio } : {}),
        ...(toIso(account.created_at) ? { createdAt: toIso(account.created_at)! } : {}),
      };
      const text = postText(status.content ?? '');
      posts.push({
        url,
        title: text.split('\n')[0]!.slice(0, 100),
        text,
        // Wpis może pochodzić z innej instancji niż odpytywana — źródłem jest serwer autora.
        service: hostOf(account.url ?? url) || instance,
        author: account.acct,
        profile,
        discovered: verified,
        ...(toIso(status.created_at) ? { publishedAt: toIso(status.created_at)! } : {}),
      });
    }
    return posts;
  },
};

// ---------- StackExchange ----------

interface StackOwner {
  display_name?: string;
  link?: string;
  profile_image?: string;
  user_id?: number;
  location?: string;
  website_url?: string;
  creation_date?: number;
}

interface StackItem {
  title?: string;
  body?: string;
  link?: string;
  creation_date?: number;
  owner?: StackOwner;
  question_id?: number;
  answer_id?: number;
  post_id?: number;
  post_type?: string;
}

const STACK_API = 'https://api.stackexchange.com/2.3';
const stackHost = (site: string) => (site.includes('.') ? site : `${site}.stackexchange.com`);

function stackProfile(owner: StackOwner): ProfileAttributes {
  const website = owner.website_url ? profileUrlIdentifier(owner.website_url)?.value : undefined;
  return {
    ...(owner.link || website ? { urls: [owner.link, website].filter((value): value is string => Boolean(value)) } : {}),
    ...(owner.location ? { location: htmlToText(owner.location) } : {}),
    ...(owner.profile_image ? { avatarUrl: owner.profile_image } : {}),
    ...(toIso(owner.creation_date) ? { createdAt: toIso(owner.creation_date)! } : {}),
  };
}

function stackPosts(site: string, items: StackItem[] | undefined, kind: 'question' | 'answer', owner?: StackOwner): MonitorPost[] {
  const host = stackHost(site);
  const posts: MonitorPost[] = [];
  for (const item of items ?? []) {
    const author = item.owner ?? owner;
    if (!author?.display_name) continue;
    const isAnswer = kind === 'answer' || item.post_type === 'answer';
    const id = isAnswer ? (item.answer_id ?? item.post_id) : (item.question_id ?? item.post_id);
    const url = item.link ?? (id ? `https://${host}/${isAnswer ? 'a' : 'q'}/${id}` : undefined);
    if (!url) continue;
    posts.push({
      url,
      title: htmlToText(item.title ?? (isAnswer ? `Odpowiedź w serwisie ${host}` : '')),
      text: postText(item.body ?? ''),
      service: host,
      author: htmlToText(author.display_name),
      profile: stackProfile(author),
      ...(toIso(item.creation_date) ? { publishedAt: toIso(item.creation_date)! } : {}),
    });
  }
  return posts;
}

export const stackExchangeEngine: EngineAdapter = {
  accepts: ['nick', 'login', 'crypto_address'],
  describe: (source) =>
    `Publiczne API StackExchange dla serwisu ${stackHost(source.site ?? '')}: najnowsze pytania z treścią (/questions, filter=withbody). ` +
    'Wyszukiwanie: /search/advanced?q=<adres> oraz /users?inname=<nick> i posty znalezionego użytkownika. Jedno żądanie na przebieg (limit API bez klucza: 300 dziennie na adres IP).',
  service: (source) => stackHost(source.site ?? ''),
  problem: (source) => (source.site && /^[a-z0-9.-]{2,60}$/i.test(source.site) ? null : 'brak lub niepoprawne pole „site"'),
  requestHost: () => 'api.stackexchange.com',
  addressKey: (source) => `stackexchange:${(source.site ?? '').toLowerCase()}`,

  async discover(run) {
    const site = run.source.site!;
    const questions = await getJson<{ items?: StackItem[] }>(
      run,
      `${STACK_API}/questions?order=desc&sort=creation&site=${encodeURIComponent(site)}&filter=withbody&pagesize=20`,
    );
    return stackPosts(site, questions?.items, 'question');
  },

  async search(run, identifier) {
    const site = run.source.site!;
    const term = searchTerm(identifier);
    const siteParam = `site=${encodeURIComponent(site)}`;
    if (identifier.type === 'crypto_address') {
      const found = await getJson<{ items?: StackItem[] }>(
        run,
        `${STACK_API}/search/advanced?order=desc&sort=creation&q=${encodeURIComponent(term)}&${siteParam}&pagesize=20&filter=withbody`,
      );
      return stackPosts(site, found?.items, 'question').filter((post) => post.text.includes(term));
    }
    const users = await getJson<{ items?: StackOwner[] }>(run, `${STACK_API}/users?order=desc&sort=reputation&inname=${encodeURIComponent(term)}&${siteParam}&pagesize=20`);
    // Nazwy wyświetlane nie są unikalne — bierzemy tylko dokładną zgodność; ocenę, czy to ta osoba, robi analiza.
    const user = (users?.items ?? []).find((item) => item.display_name?.toLowerCase() === term.toLowerCase());
    if (!user?.user_id) return [];
    const posts = await getJson<{ items?: StackItem[] }>(run, `${STACK_API}/users/${user.user_id}/posts?order=desc&sort=creation&${siteParam}&pagesize=20&filter=withbody`);
    return stackPosts(site, posts?.items, 'question', user);
  },
};

// ---------- Hacker News (Algolia) ----------

interface HnHit {
  objectID?: string;
  author?: string;
  created_at?: string;
  title?: string | null;
  story_title?: string | null;
  comment_text?: string | null;
  story_text?: string | null;
  url?: string | null;
}

const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';

function hnPosts(hits: HnHit[] | undefined): MonitorPost[] {
  const posts: MonitorPost[] = [];
  for (const hit of hits ?? []) {
    if (!hit.objectID || !hit.author) continue;
    const body = postText(hit.comment_text ?? hit.story_text ?? '');
    const title = htmlToText(hit.title ?? hit.story_title ?? '');
    posts.push({
      url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
      title,
      text: [body, !body && hit.url ? `${title}\n${hit.url}` : ''].filter(Boolean).join('\n') || title,
      service: 'news.ycombinator.com',
      author: hit.author,
      profile: { urls: [`https://news.ycombinator.com/user?id=${hit.author}`] },
      ...(toIso(hit.created_at ?? undefined) ? { publishedAt: toIso(hit.created_at ?? undefined)! } : {}),
    });
  }
  return posts;
}

export const hnEngine: EngineAdapter = {
  accepts: ['nick', 'login', 'crypto_address'],
  describe: (source) =>
    `Hacker News przez publiczne API Algolia (hn.algolia.com/api/v1/search_by_date): najnowsze komentarze dla frazy „${source.query}". ` +
    'Wyszukiwanie: fraza = adres w cudzysłowie albo wpisy autora (tags=author_<nick>). Jedno żądanie na przebieg.',
  service: () => 'news.ycombinator.com',
  problem: (source) => (source.query?.trim() ? null : 'brak pola „query"'),
  requestHost: () => 'hn.algolia.com',
  addressKey: (source) => `hn:${(source.query ?? '').trim().toLowerCase()}`,

  async discover(run) {
    const result = await getJson<{ hits?: HnHit[] }>(run, `${HN_API}?query=${encodeURIComponent(run.source.query!.trim())}&tags=comment&hitsPerPage=20`);
    return hnPosts(result?.hits);
  },

  async search(run, identifier) {
    const term = searchTerm(identifier);
    if (identifier.type === 'crypto_address') {
      const result = await getJson<{ hits?: HnHit[] }>(run, `${HN_API}?query=${encodeURIComponent(`"${term}"`)}&tags=(story,comment)&hitsPerPage=30`);
      return hnPosts(result?.hits).filter((post) => post.text.includes(term));
    }
    if (!/^[A-Za-z0-9_-]{2,15}$/.test(term)) return [];
    const result = await getJson<{ hits?: HnHit[] }>(run, `${HN_API}?tags=author_${encodeURIComponent(term)}&hitsPerPage=30`);
    return hnPosts(result?.hits).filter((post) => post.author?.toLowerCase() === term.toLowerCase());
  },
};

// ---------- Telegram: publiczny podgląd kanału ----------

const TELEGRAM_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;

export const telegramEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Publiczny podgląd kanału Telegram t.me/s/${source.channel} (bez logowania): ostatnie wiadomości widoczne na stronie podglądu (około 20), autor = kanał. Jedno żądanie na przebieg.`,
  service: () => 't.me',
  problem: (source) => (source.channel && TELEGRAM_NAME.test(source.channel.replace(/^@/, '')) ? null : 'brak lub niepoprawne pole „channel"'),
  intervalMs: SLOW_INTERVAL_MS,
  requestHost: () => 't.me',
  addressKey: (source) => `t.me/${(source.channel ?? '').replace(/^@/, '').toLowerCase()}`,

  async discover(run) {
    const name = run.source.channel!.replace(/^@/, '');
    const response = await run.session.get(`https://t.me/s/${name}`, { allowedContentTypes: ['text/html'], minIntervalMs: run.intervalMs, quietMissing: true });
    const channel = response ? parseTelegramPreview(response.text) : null;
    if (!channel) {
      if (response) run.context.log(`${run.source.label}: „${name}" nie jest kanałem z publicznym podglądem.`);
      return [];
    }
    const urls = findLinks(channel.descriptionHtml).filter((href) => /^https?:\/\//i.test(href) && !/^https?:\/\/(?:t|telegram)\.me\//i.test(href));
    const profile: ProfileAttributes = {
      ...(channel.title ? { displayName: channel.title } : {}),
      urls: [`https://t.me/${name}`, ...urls],
      ...(channel.description ? { bio: channel.description } : {}),
    };
    return channel.messages.map((message) => ({
      url: `https://t.me/${name}/${message.id}`,
      title: `${channel.title || name}: wiadomość ${message.id}`,
      text: message.text,
      service: 't.me',
      author: name,
      profile,
      ...(message.publishedAt ? { publishedAt: message.publishedAt } : {}),
    }));
  },
};

// ---------- Lemmy: najnowsze wpisy społeczności ----------

interface LemmyView {
  post?: { id?: number; name?: string; body?: string; url?: string; ap_id?: string; published?: string };
  creator?: { name?: string; display_name?: string; actor_id?: string; avatar?: string; bio?: string; published?: string; bot_account?: boolean };
}

export const lemmyEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Społeczność Lemmy ${source.community}@${source.instance}: najnowsze wpisy z publicznego API (/api/v3/post/list?community_name=…&sort=New) ` +
    'z treścią oraz danymi konta autora. Jedno żądanie na przebieg; bez wyszukiwania.',
  service: (source) => hostOf(source.instance),
  problem: (source) =>
    !source.instance || !hostOf(source.instance) ? 'brak pola „instance"' : !source.community || !/^[\w.@-]{1,80}$/.test(source.community) ? 'brak lub niepoprawne pole „community"' : null,
  requestHost: (source) => hostOf(source.instance),
  addressKey: (source) => `lemmy:${hostOf(source.instance)}/${(source.community ?? '').toLowerCase()}`,

  async discover(run) {
    const instance = hostOf(run.source.instance);
    const result = await getJson<{ posts?: LemmyView[] }>(
      run,
      `https://${instance}/api/v3/post/list?community_name=${encodeURIComponent(run.source.community!)}&sort=New&limit=20`,
    );
    const posts: MonitorPost[] = [];
    for (const view of result?.posts ?? []) {
      const post = view.post;
      const creator = view.creator;
      const url = post?.ap_id ?? (post?.id ? `https://${instance}/post/${post.id}` : undefined);
      if (!post || !url || !creator?.name || creator.bot_account) continue;
      const home = hostOf(creator.actor_id ?? '') || instance;
      const title = (post.name ?? '').trim();
      const profile: ProfileAttributes = {
        ...(creator.display_name ? { displayName: creator.display_name } : {}),
        ...(creator.actor_id ? { urls: [creator.actor_id] } : {}),
        ...(creator.avatar ? { avatarUrl: creator.avatar } : {}),
        ...(creator.bio ? { bio: creator.bio.slice(0, 2000) } : {}),
        ...(toIso(creator.published) ? { createdAt: toIso(creator.published)! } : {}),
      };
      posts.push({
        url,
        title,
        // Treść wpisu Lemmy to Markdown; wiersze cytatów („> …") należą do innych osób.
        text: [title, (post.body ?? '').split('\n').filter((line) => !line.trimStart().startsWith('>')).join('\n').trim(), post.url ?? ''].filter(Boolean).join('\n'),
        service: hostOf(url) || instance,
        // Konto z innej instancji zapisujemy jak w Fediwersum: nick@host.
        author: home === instance ? creator.name : `${creator.name}@${home}`,
        profile,
        ...(toIso(post.published) ? { publishedAt: toIso(post.published)! } : {}),
      });
    }
    return posts;
  },
};

// ---------- GitHub: wyszukiwarka zgłoszeń (wymaga tokenu) ----------

interface GithubIssue {
  html_url?: string;
  title?: string;
  body?: string | null;
  created_at?: string;
  user?: { login?: string; avatar_url?: string; html_url?: string };
}

export const githubSearchEngine: EngineAdapter = {
  accepts: [],
  describe: (source) =>
    `Wyszukiwarka zgłoszeń i dyskusji GitHuba (api.github.com/search/issues) dla frazy „${source.query}", od najnowszych. ` +
    'Działa wyłącznie z tokenem (GITHUB_TOKEN) — bez niego źródło jest pomijane. Jedno żądanie na przebieg.',
  service: () => 'github.com',
  problem: (source) => (source.query?.trim() ? null : 'brak pola „query"'),
  requestHost: () => 'api.github.com',
  addressKey: (source) => `github-search:${(source.query ?? '').trim().toLowerCase()}`,

  async discover(run) {
    if (!run.githubToken) {
      run.context.log(`${run.source.label}: wyszukiwarka GitHuba wymaga tokenu — ustaw GITHUB_TOKEN. Źródło pominięte.`);
      return [];
    }
    const result = await getJson<{ items?: GithubIssue[] }>(
      run,
      `https://api.github.com/search/issues?q=${encodeURIComponent(run.source.query!.trim())}&sort=created&order=desc&per_page=30`,
      { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: `Bearer ${run.githubToken}` },
    );
    const posts: MonitorPost[] = [];
    for (const item of result?.items ?? []) {
      if (!item.html_url || !item.user?.login) continue;
      posts.push({
        url: item.html_url,
        title: item.title ?? '',
        text: (item.body ?? '').slice(0, 20_000) || (item.title ?? ''),
        service: 'github.com',
        author: item.user.login,
        profile: { urls: [item.user.html_url ?? `https://github.com/${item.user.login}`], ...(item.user.avatar_url ? { avatarUrl: item.user.avatar_url } : {}) },
        ...(toIso(item.created_at) ? { publishedAt: toIso(item.created_at)! } : {}),
      });
    }
    return posts;
  },
};
