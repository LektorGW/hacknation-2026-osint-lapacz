// Głębokie wyszukiwanie: jedno zapytanie rozsyłane do publicznych wyszukiwarek
// wszystkich źródeł rejestru monitoringu, które mają je bez logowania — fora Discourse,
// StackExchange, Hacker News, instancje Lemmy i Mastodona. Zwraca wszystkie trafienia
// ze wszystkimi autorami; o tym, kto jest właścicielem adresu, decyduje analiza.

import type { ConnectorContext, Identifier, IdentifierType, IdentityMatch, ProfileAttributes, SourceCategory, SourceConnector, SourceDocument } from '@olcys/core';
import { findEnsNames, normalizeAddressText } from '../address-text.ts';
import { findEmails, findLinks, htmlToText } from '../html.ts';
import { errorMessage, isRefusal, parseJson } from '../http.ts';
import type { HttpClient } from '../http.ts';
import { dedupeIdentifiers, isTechnicalEmail, profileUrlIdentifier } from '../identity.ts';
import { baseUrl, hostOf, postText, toIso } from '../monitor/common.ts';
import type { MonitorSourceConfig } from '../monitor/common.ts';

const ID = 'deep-search';
const LABEL = 'Głębokie wyszukiwanie';
const STACK_API = 'https://api.stackexchange.com/2.3';
const HN_API = 'https://hn.algolia.com/api/v1/search_by_date';

export interface DeepSearchOptions {
  /** Łączny budżet czasu jednego wyszukiwania (domyślnie 45 s). */
  budgetMs?: number;
  /** Ile hostów jest odpytywanych jednocześnie (domyślnie 12). */
  concurrency?: number;
  /** Limit czasu jednego żądania (domyślnie 8 s). */
  requestTimeoutMs?: number;
  /** Ile serwisów StackExchange obejmuje wyszukiwanie (API bez klucza: 300 żądań dziennie na adres IP; domyślnie 4). */
  stackSites?: number;
  /** Najwyżej tyle dokumentów zwraca jedno wyszukiwanie (domyślnie 300). */
  maxDocuments?: number;
}

type TargetKind = 'discourse' | 'lemmy' | 'mastodon' | 'stackexchange' | 'hn';

export interface DeepTarget {
  kind: TargetKind;
  /** Host, do którego idzie zapytanie. */
  host: string;
  /** Adres bazowy forum, host instancji albo nazwa serwisu StackExchange. */
  base: string;
  label: string;
  language?: string;
}

interface Hit {
  url: string;
  title: string;
  text: string;
  service: string;
  author?: string;
  publishedAt?: string;
  profile?: ProfileAttributes;
  /** Dokument jest profilem konta (a nie wypowiedzią). */
  isProfile?: boolean;
  discovered?: Identifier[];
}

/** Cele wyszukiwania z rejestru: po jednym na host (StackExchange — po jednym na serwis, do limitu). Polskie źródła idą pierwsze. */
export function deepTargets(sources: MonitorSourceConfig[], stackSites = 4): DeepTarget[] {
  const targets = new Map<string, DeepTarget>();
  const add = (target: DeepTarget) => {
    const key = `${target.kind}|${target.kind === 'stackexchange' ? target.base : target.host}`;
    if (target.host && !targets.has(key)) targets.set(key, target);
  };
  const preferred = ['bitcoin', 'ethereum', 'monero', 'crypto'];
  const stacks = sources
    .filter((source) => source.enabled !== false && source.engine === 'stackexchange' && source.site)
    .sort((a, b) => (preferred.indexOf(a.site!) + 1 || 99) - (preferred.indexOf(b.site!) + 1 || 99))
    .slice(0, Math.max(0, stackSites));
  for (const source of sources) {
    if (source.enabled === false) continue;
    const language = source.language ? { language: source.language } : {};
    if (source.engine === 'discourse' && source.url) add({ kind: 'discourse', host: hostOf(source.url), base: baseUrl(source.url), label: source.label, ...language });
    if (source.engine === 'lemmy' && source.instance) add({ kind: 'lemmy', host: hostOf(source.instance), base: hostOf(source.instance), label: `Lemmy ${hostOf(source.instance)}`, ...language });
    if (source.engine === 'mastodon-tag' && source.instance) add({ kind: 'mastodon', host: hostOf(source.instance), base: hostOf(source.instance), label: `Mastodon ${hostOf(source.instance)}`, ...language });
    if (source.engine === 'hn') add({ kind: 'hn', host: 'hn.algolia.com', base: 'hn', label: 'Hacker News' });
  }
  for (const source of stacks) add({ kind: 'stackexchange', host: 'api.stackexchange.com', base: source.site!, label: source.label });
  return [...targets.values()].sort((a, b) => Number(b.language === 'pl') - Number(a.language === 'pl'));
}

const fold = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');

const sameAccount = (a: string | undefined, b: string): boolean => (a ?? '').trim().replace(/^@/, '').toLowerCase() === b.toLowerCase();

const NICK = /^[A-Za-z0-9_.-]{2,60}$/;
/** Na tylu forach Discourse, gdzie konto istnieje, pobierane są także jego wypowiedzi. */
const MAX_ACCOUNT_FORUMS = 8;

export function createDeepSearchConnector(http: HttpClient, sources: MonitorSourceConfig[], options: DeepSearchOptions = {}): SourceConnector {
  const targets = deepTargets(sources, options.stackSites ?? 4);
  const budgetMs = options.budgetMs ?? 45_000;
  const concurrency = Math.max(1, options.concurrency ?? 12);
  const timeoutMs = options.requestTimeoutMs ?? 8000;
  const maxDocuments = options.maxDocuments ?? 300;
  const counts = targets.reduce<Record<string, number>>((totals, target) => ({ ...totals, [target.kind]: (totals[target.kind] ?? 0) + 1 }), {});

  /** Jedno żądanie JSON; błędy trafiają do licznika, nie do dziennika (przy kilkuset hostach dziennik byłby nieczytelny). */
  interface Fetch {
    <T>(url: string): Promise<T | null>;
  }

  /** Zapytanie do jednego celu. Zwraca trafienia spełniające warunek dokładnego dopasowania. */
  async function query(target: DeepTarget, identifier: Identifier, term: string, get: Fetch): Promise<Hit[]> {
    const type = identifier.type;
    const byAccount = type === 'nick' || type === 'login';
    const byName = type === 'full_name';
    // Dla adresu wymagamy dokładnego wystąpienia; e-mail, nazwa ENS i nazwisko porównujemy bez wielkości liter.
    const contains = (text: string): boolean => (type === 'crypto_address' ? normalizeAddressText(text).includes(term) : fold(text).includes(fold(term)));

    if (target.kind === 'discourse') {
      const base = target.base;
      const avatar = (template: string | undefined) => {
        const path = template?.replace('{size}', '120');
        return path ? (path.startsWith('http') ? path : path.startsWith('//') ? `https:${path}` : `${base}${path}`) : undefined;
      };
      if (byAccount) {
        if (!NICK.test(term)) return [];
        const found = await get<{ user?: DiscourseUser }>(`${base}/u/${encodeURIComponent(term)}.json`);
        const user = found?.user;
        if (!user?.username || !sameAccount(user.username, term)) return [];
        return [discourseProfileHit(base, target.host, user, avatar(user.avatar_template))];
      }
      const result = await get<{ posts?: DiscoursePost[]; topics?: { id: number; title?: string; slug?: string }[]; users?: DiscourseUser[] }>(
        `${base}/search.json?q=${encodeURIComponent(byName ? `"${term}"` : term)}`,
      );
      if (!result) return [];
      const topics = new Map((result.topics ?? []).map((topic) => [topic.id, topic]));
      const hits: Hit[] = [];
      if (byName) {
        for (const user of result.users ?? []) {
          if (user.username && user.name && fold(user.name) === fold(term)) hits.push(discourseProfileHit(base, target.host, user, avatar(user.avatar_template)));
        }
      }
      for (const post of result.posts ?? []) {
        if (!post.username || !post.topic_id) continue;
        const text = (post.blurb ?? '').trim();
        const nameMatches = byName && post.name && fold(post.name) === fold(term);
        if (!nameMatches && !contains(text)) continue;
        const topic = topics.get(post.topic_id);
        hits.push({
          url: `${base}/t/${topic?.slug ?? 'topic'}/${post.topic_id}/${post.post_number ?? 1}`,
          title: topic?.title ?? `Post na forum ${target.host}`,
          text,
          service: target.host,
          author: post.username,
          profile: { ...(post.name ? { displayName: post.name } : {}), urls: [`${base}/u/${post.username}`], ...(avatar(post.avatar_template) ? { avatarUrl: avatar(post.avatar_template)! } : {}) },
          ...(toIso(post.created_at) ? { publishedAt: toIso(post.created_at)! } : {}),
        });
      }
      return hits;
    }

    if (target.kind === 'lemmy') {
      const api = `https://${target.host}/api/v3`;
      const personProfile = (person: LemmyPerson): ProfileAttributes => ({
        ...(person.display_name ? { displayName: person.display_name } : {}),
        ...(person.actor_id ? { urls: [person.actor_id] } : {}),
        ...(person.avatar ? { avatarUrl: person.avatar } : {}),
        ...(person.bio ? { bio: person.bio.slice(0, 2000) } : {}),
        ...(toIso(person.published) ? { createdAt: toIso(person.published)! } : {}),
      });
      const handle = (person: LemmyPerson) => {
        const home = hostOf(person.actor_id ?? '') || target.host;
        return home === target.host ? person.name! : `${person.name}@${home}`;
      };
      const fromPost = (view: LemmyPostView): Hit | null => {
        const post = view.post;
        const creator = view.creator;
        if (!post || !creator?.name) return null;
        const url = post.ap_id ?? `https://${target.host}/post/${post.id}`;
        return {
          url,
          title: post.name ?? '',
          text: [post.name, post.body, post.url].filter(Boolean).join('\n'),
          service: hostOf(url) || target.host,
          author: handle(creator),
          profile: personProfile(creator),
          ...(toIso(post.published) ? { publishedAt: toIso(post.published)! } : {}),
        };
      };
      const fromComment = (view: LemmyCommentView): Hit | null => {
        const comment = view.comment;
        const creator = view.creator;
        if (!comment?.content || !creator?.name) return null;
        const url = comment.ap_id ?? `https://${target.host}/comment/${comment.id}`;
        return {
          url,
          title: `Komentarz: ${view.post?.name ?? ''}`.trim(),
          text: comment.content,
          service: hostOf(url) || target.host,
          author: handle(creator),
          profile: personProfile(creator),
          ...(toIso(comment.published) ? { publishedAt: toIso(comment.published)! } : {}),
        };
      };
      if (byAccount) {
        if (!/^[A-Za-z0-9_]{2,60}$/.test(term)) return [];
        const found = await get<{ person_view?: { person?: LemmyPerson }; posts?: LemmyPostView[]; comments?: LemmyCommentView[] }>(
          `${api}/user?username=${encodeURIComponent(term)}&limit=20`,
        );
        const person = found?.person_view?.person;
        if (!person?.name || !sameAccount(person.name, term)) return [];
        const url = person.actor_id ?? `https://${target.host}/u/${person.name}`;
        const profile: Hit = {
          url,
          title: `Profil Lemmy: ${person.name}@${target.host}`,
          text: [`Profil Lemmy ${person.name}@${target.host}`, person.display_name && `Nazwa: ${person.display_name}`, person.bio && `Opis: ${person.bio}`].filter(Boolean).join('\n'),
          service: target.host,
          author: person.name,
          profile: personProfile(person),
          isProfile: true,
        };
        const own = [...(found!.posts ?? []).map(fromPost), ...(found!.comments ?? []).map(fromComment)].filter((hit): hit is Hit => hit !== null);
        return [profile, ...own];
      }
      const kind = byName ? 'Users' : 'All';
      const found = await get<{ posts?: LemmyPostView[]; comments?: LemmyCommentView[]; users?: { person?: LemmyPerson }[] }>(
        `${api}/search?q=${encodeURIComponent(term)}&type_=${kind}&listing_type=All&limit=20`,
      );
      if (!found) return [];
      if (byName) {
        return (found.users ?? [])
          .map((view) => view.person)
          .filter((person): person is LemmyPerson => Boolean(person?.name && person.display_name && fold(person.display_name) === fold(term)))
          .map((person) => ({
            url: person.actor_id ?? `https://${target.host}/u/${person.name}`,
            title: `Profil Lemmy: ${person.name}`,
            text: [`Profil Lemmy ${person.name}`, `Nazwa: ${person.display_name}`, person.bio && `Opis: ${person.bio}`].filter(Boolean).join('\n'),
            service: target.host,
            author: handle(person),
            profile: personProfile(person),
            isProfile: true,
          }));
      }
      return [...(found.posts ?? []).map(fromPost), ...(found.comments ?? []).map(fromComment)].filter((hit): hit is Hit => hit !== null && contains(hit.text));
    }

    if (target.kind === 'mastodon') {
      const fromAccount = (account: MastodonAccount): Hit | null => {
        if (!account.username) return null;
        const note = htmlToText(account.note ?? '');
        const fields = (account.fields ?? []).filter((field) => field?.name || field?.value);
        const fieldUrls = fields.map((field) => findLinks(field.value ?? '')[0]).filter((href): href is string => typeof href === 'string' && /^https?:\/\//i.test(href));
        const verified = fields
          .filter((field) => field.verified_at)
          .map((field) => profileUrlIdentifier(findLinks(field.value ?? '')[0] ?? ''))
          .filter((item): item is Identifier => item !== null);
        const url = account.url ?? `https://${target.host}/@${account.username}`;
        return {
          url,
          title: `Profil Mastodon: ${account.username}@${hostOf(url) || target.host}`,
          text: [
            `Profil ${account.username}@${hostOf(url) || target.host}`,
            account.display_name && `Nazwa wyświetlana: ${account.display_name}`,
            note && `Opis:\n${note}`,
            fields.length > 0 && `Pola profilu:\n${fields.map((field) => `- ${field.name ?? ''}: ${htmlToText(field.value ?? '').replace(/\n/g, ' ')}`).join('\n')}`,
          ]
            .filter(Boolean)
            .join('\n'),
          service: hostOf(url) || target.host,
          author: account.username,
          profile: {
            ...(account.display_name ? { displayName: account.display_name } : {}),
            urls: [...new Set([url, ...fieldUrls])],
            ...(account.avatar ? { avatarUrl: account.avatar } : {}),
            ...(note ? { bio: note } : {}),
            ...(toIso(account.created_at) ? { createdAt: toIso(account.created_at)! } : {}),
          },
          isProfile: true,
          discovered: verified,
        };
      };
      if (byAccount) {
        if (!/^[A-Za-z0-9_]{1,30}$/.test(term)) return [];
        const account = await get<MastodonAccount>(`https://${target.host}/api/v1/accounts/lookup?acct=${encodeURIComponent(term)}`);
        const hit = account && sameAccount(account.username, term) ? fromAccount(account) : null;
        return hit ? [hit] : [];
      }
      if (!byName) return [];
      // Wyszukiwanie kont bywa dostępne bez logowania; treści wpisów bez logowania przeszukać się nie da.
      const found = await get<{ accounts?: MastodonAccount[] }>(`https://${target.host}/api/v2/search?q=${encodeURIComponent(term)}&type=accounts&limit=5`);
      return (found?.accounts ?? [])
        .filter((account) => account.display_name && fold(account.display_name) === fold(term))
        .map(fromAccount)
        .filter((hit): hit is Hit => hit !== null);
    }

    if (target.kind === 'stackexchange') {
      const site = target.base;
      const host = site.includes('.') ? site : `${site}.stackexchange.com`;
      const siteParam = `site=${encodeURIComponent(site)}`;
      const ownerProfile = (owner: StackOwner): ProfileAttributes => ({
        ...(owner.link ? { urls: [owner.link, ...(owner.website_url && /^https?:\/\//i.test(owner.website_url) ? [owner.website_url] : [])] } : {}),
        ...(owner.location ? { location: htmlToText(owner.location) } : {}),
        ...(owner.profile_image ? { avatarUrl: owner.profile_image } : {}),
        ...(toIso(owner.creation_date) ? { createdAt: toIso(owner.creation_date)! } : {}),
      });
      if (byAccount || byName) {
        const users = await get<{ items?: StackOwner[] }>(`${STACK_API}/users?order=desc&sort=reputation&inname=${encodeURIComponent(term)}&${siteParam}&pagesize=20`);
        return (users?.items ?? [])
          .filter((user) => user.display_name && user.link && fold(htmlToText(user.display_name)) === fold(term))
          .map((user) => ({
            url: user.link!,
            title: `Profil ${host}: ${htmlToText(user.display_name!)}`,
            text: [`Profil w serwisie ${host}: ${htmlToText(user.display_name!)}`, user.location && `Lokalizacja: ${htmlToText(user.location)}`, user.website_url && `Strona: ${user.website_url}`]
              .filter(Boolean)
              .join('\n'),
            service: host,
            author: htmlToText(user.display_name!),
            profile: ownerProfile(user),
            isProfile: true,
          }));
      }
      // Wyniki wyszukiwarki nie podają autora — drugim żądaniem pobieramy znalezione posty z autorem i pełną treścią.
      const excerpts = await get<{ items?: { question_id?: number; answer_id?: number; item_type?: string; title?: string }[] }>(
        `${STACK_API}/search/excerpts?order=desc&sort=relevance&q=${encodeURIComponent(term)}&${siteParam}&pagesize=10`,
      );
      const titles = new Map<number, string>();
      for (const item of excerpts?.items ?? []) {
        const id = item.item_type === 'answer' ? item.answer_id : item.question_id;
        if (id) titles.set(id, htmlToText(item.title ?? ''));
      }
      if (titles.size === 0) return [];
      const posts = await get<{ items?: { post_id?: number; post_type?: string; body?: string; link?: string; creation_date?: number; owner?: StackOwner }[] }>(
        `${STACK_API}/posts/${[...titles.keys()].join(';')}?${siteParam}&filter=withbody&pagesize=10`,
      );
      const hits: Hit[] = [];
      for (const post of posts?.items ?? []) {
        const text = postText(post.body ?? '');
        if (!post.link || !post.owner?.display_name || !contains(text)) continue;
        hits.push({
          url: post.link,
          title: titles.get(post.post_id ?? -1) || `Post w serwisie ${host}`,
          text,
          service: host,
          author: htmlToText(post.owner.display_name),
          profile: ownerProfile(post.owner),
          ...(toIso(post.creation_date) ? { publishedAt: toIso(post.creation_date)! } : {}),
        });
      }
      return hits;
    }

    // Hacker News
    if (byAccount && !/^[A-Za-z0-9_-]{2,15}$/.test(term)) return [];
    const url = byAccount ? `${HN_API}?tags=author_${encodeURIComponent(term)}&hitsPerPage=30` : `${HN_API}?query=${encodeURIComponent(`"${term}"`)}&tags=(story,comment)&hitsPerPage=30`;
    const result = await get<{ hits?: HnHit[] }>(url);
    const hits: Hit[] = [];
    for (const hit of result?.hits ?? []) {
      if (!hit.objectID || !hit.author) continue;
      const body = postText(hit.comment_text ?? hit.story_text ?? '');
      const title = htmlToText(hit.title ?? hit.story_title ?? '');
      const text = [body, !body && hit.url ? `${title}\n${hit.url}` : ''].filter(Boolean).join('\n') || title;
      if (byAccount ? !sameAccount(hit.author, term) : !contains(text)) continue;
      hits.push({
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        title,
        text,
        service: 'news.ycombinator.com',
        author: hit.author,
        profile: { urls: [`https://news.ycombinator.com/user?id=${hit.author}`] },
        ...(toIso(hit.created_at ?? undefined) ? { publishedAt: toIso(hit.created_at ?? undefined)! } : {}),
      });
    }
    return hits;
  }

  function discourseProfileHit(base: string, host: string, user: DiscourseUser, avatarUrl: string | undefined): Hit {
    const website = user.website ? profileUrlIdentifier(/^https?:\/\//i.test(user.website) ? user.website : `https://${user.website}`) : null;
    const bio = htmlToText(user.bio_excerpt ?? user.bio_cooked ?? '');
    return {
      url: `${base}/u/${user.username}`,
      title: `Profil na forum ${host}: ${user.username}`,
      text: [
        `Profil na forum ${host}: ${user.username}`,
        user.name && `Nazwa: ${user.name}`,
        user.title && `Tytuł: ${user.title}`,
        user.location && `Lokalizacja: ${user.location}`,
        user.website && `Strona: ${user.website}`,
        bio && `Opis: ${bio}`,
      ]
        .filter(Boolean)
        .join('\n'),
      service: host,
      author: user.username!,
      profile: {
        ...(user.name ? { displayName: user.name } : {}),
        urls: [`${base}/u/${user.username}`, ...(website ? [website.value] : [])],
        ...(user.location ? { location: user.location } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
        ...(bio ? { bio } : {}),
        ...(toIso(user.created_at) ? { createdAt: toIso(user.created_at)! } : {}),
      },
      isProfile: true,
      ...(website ? { discovered: [website] } : {}),
    };
  }

  function toDocument(hit: Hit, identifier: Identifier, identityMatch: IdentityMatch): SourceDocument {
    const text = normalizeAddressText(hit.text.trim() || hit.title).slice(0, 20_000);
    const author = hit.author?.trim().replace(/^@/, '') || undefined;
    const discovered = dedupeIdentifiers(
      [
        ...(hit.discovered ?? []),
        ...findEmails(text)
          .filter((email) => !isTechnicalEmail(email))
          .map((value): Identifier => ({ type: 'email', value })),
        ...findEnsNames(text).map((value): Identifier => ({ type: 'ens_name', value })),
      ],
      identifier,
      [hit.service],
    ).slice(0, 8);
    const category: SourceCategory = hit.isProfile ? 'own_profile' : 'forum_post';
    return {
      connectorId: ID,
      service: hit.service,
      url: hit.url,
      title: hit.title.trim() || text.slice(0, 80),
      text,
      fetchedAt: new Date().toISOString(),
      category,
      identityMatch,
      matchedIdentifier: identifier,
      ...(author ? { author, profile: { handle: author, ...hit.profile } } : {}),
      ...(hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
      ...(discovered.length > 0 ? { discoveredIdentifiers: discovered } : {}),
    };
  }

  const accepts: IdentifierType[] = ['nick', 'login', 'email', 'crypto_address', 'full_name', 'ens_name'];

  return {
    id: ID,
    service: 'deep-search',
    label: LABEL,
    description:
      `Jedno zapytanie rozsyłane do publicznych wyszukiwarek źródeł rejestru monitoringu (hostów: ${targets.length}; fora Discourse: ${counts.discourse ?? 0}, ` +
      `instancje Lemmy: ${counts.lemmy ?? 0}, instancje Mastodona: ${counts.mastodon ?? 0}, serwisy StackExchange: ${counts.stackexchange ?? 0}, Hacker News: ${counts.hn ?? 0}). ` +
      'Discourse: /search.json?q= (adres, e-mail, nazwa ENS, nazwisko) albo profil /u/<nick>.json; Lemmy: /api/v3/search i /api/v3/user; Mastodon: /api/v1/accounts/lookup ' +
      '(nazwisko: /api/v2/search?type=accounts); StackExchange: /search/excerpts i /posts albo /users?inname=; HN: Algolia search_by_date. ' +
      `Dopasowanie dokładne: nazwa konta równa nickowi, adres obecny w treści. Jedno żądanie na host (StackExchange: dwa), ${concurrency} hostów naraz, ` +
      `limit czasu żądania ${Math.round(timeoutMs / 1000)} s, łączny budżet ${Math.round(budgetMs / 1000)} s. Zwraca wszystkich autorów trafień.`,
    accepts,
    enabledByDefault: false,

    async search(identifier, context) {
      if (!accepts.includes(identifier.type)) return [];
      const term = identifier.value.trim().replace(/^@/, '');
      if (term.length < 3 || term.length > 120) return [];
      if (targets.length === 0) {
        context.log(`${LABEL}: rejestr źródeł jest pusty — nic do przeszukania.`);
        return [];
      }
      const byAccount = identifier.type === 'nick' || identifier.type === 'login';
      // Konto o dokładnie tej nazwie to trafienie po identyfikatorze; wzmianka w czyjejś treści — tylko poszlaka.
      const identityMatch: IdentityMatch = byAccount ? 'exact_identifier' : 'name_only';

      const started = Date.now();
      const deadline = AbortSignal.timeout(budgetMs);
      const signal = context.signal ? AbortSignal.any([context.signal, deadline]) : deadline;
      const inner: ConnectorContext = { signal, log: () => undefined };
      const stats = { answered: 0, refused: 0, failed: 0, skipped: 0, withHits: 0 };
      const failures = new Map<string, number>();
      const documents = new Map<string, SourceDocument>();
      /** Fora Discourse, na których znaleziono konto o tej nazwie — w drugiej fazie pobieramy jego wypowiedzi. */
      const accountForums: DeepTarget[] = [];

      async function runTarget(target: DeepTarget): Promise<void> {
        if (signal.aborted) {
          stats.skipped += 1;
          return;
        }
        let responded = false;
        let problem: string | undefined;
        const get: Fetch = async <T>(url: string): Promise<T | null> => {
          try {
            const response = await http.get(url, inner, { headers: { Accept: 'application/json' }, timeoutMs });
            // 404 to zwykła odpowiedź „nie ma takiego konta" — host odpowiedział.
            if (response.ok || response.status === 404) responded = true;
            if (isRefusal(response.status)) problem = `odmowa (kod ${response.status})`;
            else if (!response.ok && response.status !== 404) problem = `kod ${response.status}`;
            return response.ok ? parseJson<T>(response.text) : null;
          } catch (error) {
            const name = error instanceof Error ? error.name : '';
            problem = name === 'TimeoutError' || name === 'AbortError' ? 'limit czasu' : errorMessage(error).slice(0, 60);
            return null;
          }
        };
        let hits: Hit[] = [];
        try {
          hits = await query(target, identifier, term, get);
        } catch (error) {
          problem = `nieoczekiwana odpowiedź: ${errorMessage(error).slice(0, 60)}`;
        }
        if (responded) stats.answered += 1;
        else if (problem?.startsWith('odmowa')) stats.refused += 1;
        else if (problem) stats.failed += 1;
        if (problem && !responded) failures.set(problem, (failures.get(problem) ?? 0) + 1);
        if (byAccount && target.kind === 'discourse' && hits.length > 0) accountForums.push(target);
        let added = 0;
        for (const hit of hits) {
          if (documents.size >= maxDocuments || !hit.url || documents.has(hit.url)) continue;
          documents.set(hit.url, toDocument(hit, identifier, identityMatch));
          added += 1;
        }
        if (added > 0) {
          stats.withHits += 1;
          const authors = [...new Set(hits.map((hit) => hit.author).filter(Boolean))].slice(0, 5).join(', ');
          context.log(`${LABEL}: znaleziono w ${target.label} (${target.host}) — dokumentów: ${added}${authors ? `, autorzy: ${authors}` : ''}.`);
        }
      }

      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
          while (next < targets.length) await runTarget(targets[next++]!);
        }),
      );

      // Druga faza: wypowiedzi znalezionego konta — jedno dodatkowe żądanie na forum, najwyżej MAX_ACCOUNT_FORUMS forów, w ramach budżetu czasu.
      await Promise.all(
        accountForums.slice(0, MAX_ACCOUNT_FORUMS).map(async (target) => {
          if (signal.aborted) return;
          try {
            const response = await http.get(`${target.base}/search.json?q=${encodeURIComponent(`@${term}`)}`, inner, { headers: { Accept: 'application/json' }, timeoutMs });
            const result = response.ok ? parseJson<{ posts?: DiscoursePost[]; topics?: { id: number; title?: string; slug?: string }[] }>(response.text) : null;
            const topics = new Map((result?.topics ?? []).map((topic) => [topic.id, topic]));
            let added = 0;
            for (const post of result?.posts ?? []) {
              if (!sameAccount(post.username, term) || !post.topic_id || documents.size >= maxDocuments) continue;
              const topic = topics.get(post.topic_id);
              const url = `${target.base}/t/${topic?.slug ?? 'topic'}/${post.topic_id}/${post.post_number ?? 1}`;
              if (documents.has(url) || !(post.blurb ?? '').trim()) continue;
              documents.set(
                url,
                toDocument(
                  {
                    url,
                    title: topic?.title ?? `Post na forum ${target.host}`,
                    text: post.blurb!.trim(),
                    service: target.host,
                    author: post.username!,
                    profile: { ...(post.name ? { displayName: post.name } : {}), urls: [`${target.base}/u/${post.username}`] },
                    ...(toIso(post.created_at) ? { publishedAt: toIso(post.created_at)! } : {}),
                  },
                  identifier,
                  identityMatch,
                ),
              );
              added += 1;
            }
            if (added > 0) context.log(`${LABEL}: wypowiedzi konta „${term}" na forum ${target.host} — dokumentów: ${added}.`);
          } catch {
            // Druga faza jest dodatkiem — błąd jednego forum nie zmienia wyniku pierwszej.
          }
        }),
      );

      const authors = new Set([...documents.values()].map((document) => `${document.service}|${document.author ?? ''}`));
      const failureNote = [...failures.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([reason, count]) => `${reason} ×${count}`)
        .join(', ');
      context.log(
        `${LABEL}: „${term}" — hostów ${targets.length}: odpowiedziało ${stats.answered}, z trafieniami ${stats.withHits}, odmówiło ${stats.refused}, błędów ${stats.failed}, ` +
          `pominiętych po wyczerpaniu budżetu czasu ${stats.skipped}; dokumentów ${documents.size}, autorów ${authors.size}, czas ${Math.round((Date.now() - started) / 100) / 10} s` +
          `${failureNote ? `; najczęstsze błędy: ${failureNote}` : ''}.`,
      );
      return [...documents.values()];
    },
  };
}

// ---------- Kształty odpowiedzi ----------

interface DiscourseUser {
  id?: number;
  username?: string;
  name?: string | null;
  title?: string | null;
  avatar_template?: string;
  location?: string | null;
  website?: string | null;
  bio_excerpt?: string | null;
  bio_cooked?: string | null;
  created_at?: string;
}

interface DiscoursePost {
  username?: string;
  name?: string | null;
  avatar_template?: string;
  created_at?: string;
  blurb?: string;
  post_number?: number;
  topic_id?: number;
}

interface LemmyPerson {
  name?: string;
  display_name?: string;
  actor_id?: string;
  avatar?: string;
  bio?: string;
  published?: string;
}

interface LemmyPostView {
  post?: { id?: number; name?: string; body?: string; url?: string; ap_id?: string; published?: string };
  creator?: LemmyPerson;
}

interface LemmyCommentView {
  comment?: { id?: number; content?: string; ap_id?: string; published?: string };
  creator?: LemmyPerson;
  post?: { name?: string };
}

interface MastodonAccount {
  username?: string;
  display_name?: string;
  note?: string;
  url?: string;
  avatar?: string;
  created_at?: string;
  fields?: { name?: string; value?: string; verified_at?: string | null }[];
}

interface StackOwner {
  display_name?: string;
  link?: string;
  profile_image?: string;
  user_id?: number;
  location?: string;
  website_url?: string;
  creation_date?: number;
}

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
