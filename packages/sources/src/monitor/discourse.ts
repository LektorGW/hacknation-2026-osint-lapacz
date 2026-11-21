// Silnik `discourse`: publiczne API forów Discourse. Najnowsze posty z `/posts.json`
// (zapasowo lista wątków `/latest.json` i treść najnowszego wątku `/t/<id>.json`),
// wyszukiwanie przez `/search.json`, dane profilu z `/u/<nick>.json`.

import type { Identifier, ProfileAttributes } from '@olcys/core';
import { parseJson } from '../http.ts';
import { profileUrlIdentifier } from '../identity.ts';
import { baseUrl, hostOf, normalizedUrl, postText, searchTerm, toIso } from './common.ts';
import type { EngineAdapter, EngineRun, MonitorPost } from './common.ts';

interface DiscoursePost {
  id?: number;
  username?: string;
  name?: string | null;
  avatar_template?: string;
  created_at?: string;
  cooked?: string;
  blurb?: string;
  post_number?: number;
  topic_id?: number;
  topic_slug?: string;
  topic_title?: string;
}

interface DiscourseTopic {
  id: number;
  title?: string;
  fancy_title?: string;
  slug?: string;
  created_at?: string;
  last_posted_at?: string;
  last_poster_username?: string;
  excerpt?: string;
  posters?: { user_id?: number; description?: string }[];
}

interface DiscourseUser {
  id?: number;
  username?: string;
  name?: string | null;
  avatar_template?: string;
  location?: string | null;
  website?: string | null;
  bio_excerpt?: string | null;
  created_at?: string;
}

const JSON_HEADERS = { Accept: 'application/json' };

function profileOf(base: string, user: DiscoursePost | DiscourseUser): ProfileAttributes {
  const avatar = user.avatar_template?.replace('{size}', '120');
  const details = user as DiscourseUser;
  const website = details.website ? profileUrlIdentifier(/^https?:\/\//i.test(details.website) ? details.website : `https://${details.website}`)?.value : undefined;
  return {
    ...(user.name ? { displayName: user.name } : {}),
    urls: [`${base}/u/${user.username}`, ...(website ? [website] : [])],
    ...(details.location ? { location: details.location } : {}),
    ...(avatar ? { avatarUrl: avatar.startsWith('http') ? avatar : avatar.startsWith('//') ? `https:${avatar}` : `${base}${avatar}` } : {}),
    ...(details.bio_excerpt ? { bio: details.bio_excerpt } : {}),
    ...(toIso(details.created_at) && 'bio_excerpt' in details ? { createdAt: toIso(details.created_at)! } : {}),
  };
}

function toPost(base: string, post: DiscoursePost, title: string | undefined, slug: string | undefined, extra: Partial<MonitorPost> = {}): MonitorPost | null {
  if (!post.username || !post.topic_id) return null;
  const published = toIso(post.created_at);
  return {
    url: `${base}/t/${slug ?? post.topic_slug ?? 'topic'}/${post.topic_id}/${post.post_number ?? 1}`,
    title: title ?? post.topic_title ?? '',
    text: post.cooked ? postText(post.cooked) : (post.blurb ?? '').trim(),
    service: hostOf(base),
    author: post.username,
    profile: profileOf(base, post),
    ...(published ? { publishedAt: published } : {}),
    ...extra,
  };
}

async function getJson<T>(run: EngineRun, url: string, quietMissing = false): Promise<T | null> {
  const response = await run.session.get(url, { headers: JSON_HEADERS, minIntervalMs: run.intervalMs, quietMissing });
  return response ? parseJson<T>(response.text) : null;
}

export const discourseEngine: EngineAdapter = {
  accepts: ['nick', 'login', 'crypto_address'],
  describe: (source) =>
    `Forum Discourse ${hostOf(source.url)}: najnowsze posty z publicznego API (/posts.json; gdy niedostępne — lista wątków /latest.json). ` +
    'Wyszukiwanie: profil /u/<nick>.json i /search.json?q=<adres lub @nick>. Najwyżej 2 żądania na przebieg.',
  service: (source) => hostOf(source.url),
  problem: (source) => (source.url && hostOf(source.url) ? null : 'brak pola „url"'),
  requestHost: (source) => hostOf(source.url),
  addressKey: (source) => normalizedUrl(source.url),

  async discover(run) {
    const base = baseUrl(run.source.url!);
    const latestPosts = await getJson<{ latest_posts?: DiscoursePost[] }>(run, `${base}/posts.json`, true);
    const direct = (latestPosts?.latest_posts ?? []).map((post) => toPost(base, post, undefined, undefined)).filter((post): post is MonitorPost => post !== null);
    if (direct.length > 0 || run.session.refused) return direct;

    // Część forów nie udostępnia /posts.json — zostaje lista wątków: tytuł i zajawka przypisane autorowi wątku.
    const latest = await getJson<{ users?: DiscourseUser[]; topic_list?: { topics?: DiscourseTopic[] } }>(run, `${base}/latest.json`);
    const users = new Map((latest?.users ?? []).map((user) => [user.id, user]));
    const posts: MonitorPost[] = [];
    for (const topic of latest?.topic_list?.topics ?? []) {
      const starter = users.get(topic.posters?.[0]?.user_id);
      if (!starter?.username) continue;
      const built = toPost(
        base,
        { username: starter.username, name: starter.name, avatar_template: starter.avatar_template, topic_id: topic.id, post_number: 1, created_at: topic.created_at },
        topic.title,
        topic.slug,
        { text: (topic.excerpt ?? topic.title ?? '').trim() },
      );
      if (built) posts.push(built);
    }
    return posts;
  },

  async search(run, identifier: Identifier) {
    const base = baseUrl(run.source.url!);
    const term = searchTerm(identifier);
    const byAddress = identifier.type === 'crypto_address';
    if (!byAddress && !/^[A-Za-z0-9_.-]{2,60}$/.test(term)) return [];

    let profile: ProfileAttributes | undefined;
    if (!byAddress) {
      const found = await getJson<{ user?: DiscourseUser }>(run, `${base}/u/${encodeURIComponent(term)}.json`, true);
      if (!found?.user?.username) return [];
      profile = profileOf(base, found.user);
    }

    const query = byAddress ? term : `@${term}`;
    const result = await getJson<{ posts?: DiscoursePost[]; topics?: DiscourseTopic[] }>(run, `${base}/search.json?q=${encodeURIComponent(query)}`);
    const topics = new Map((result?.topics ?? []).map((topic) => [topic.id, topic]));
    const posts: MonitorPost[] = [];
    for (const post of result?.posts ?? []) {
      if (!byAddress && post.username?.toLowerCase() !== term.toLowerCase()) continue;
      const topic = topics.get(post.topic_id ?? -1);
      const built = toPost(base, post, topic?.title ?? topic?.fancy_title, topic?.slug);
      if (!built) continue;
      // Zajawka wyszukiwarki bywa ucięta; posta, w którego zajawce nie widać adresu, nie da się potwierdzić — pomijamy.
      if (byAddress && !built.text.includes(term)) continue;
      if (profile) built.profile = { ...built.profile, ...profile };
      posts.push(built);
    }
    return posts;
  },
};
