// Dodatkowe wyszukiwarki śladów: treść repozytoriów GitHuba (wymaga tokenu), publiczne
// serwisy wiedzy o adresach Bitcoin (WalletExplorer, BitcoinWhosWho) oraz archiwalne
// kopie profilu Twitter/X o nazwie równej nickowi.

import { validateAddress } from '@olcys/core';
import type { Identifier, ProfileAttributes, SourceCategory, SourceConnector, SourceDocument } from '@olcys/core';
import { normalizeAddressText } from '../address-text.ts';
import { htmlToText, innerByClass } from '../html.ts';
import { parseJson } from '../http.ts';
import type { HttpClient } from '../http.ts';
import { cleanHandle, isTechnicalEmail } from '../identity.ts';
import { attributeOf, selectAll } from '../monitor/html-list.ts';
import { createWaybackConnector } from '../wayback.ts';

// ---------- GitHub: wyszukiwanie w treści ----------

const GITHUB_API = 'https://api.github.com';
const GITHUB_ID = 'live-github-search';
const GITHUB_LABEL = 'GitHub — wyszukiwanie w treści';

interface TextMatch {
  fragment?: string;
}

interface GithubOwner {
  login?: string;
  avatar_url?: string;
  html_url?: string;
}

interface CodeItem {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { name?: string; full_name?: string; owner?: GithubOwner; fork?: boolean };
  text_matches?: TextMatch[];
}

interface IssueItem {
  html_url?: string;
  title?: string;
  body?: string | null;
  created_at?: string;
  user?: GithubOwner;
  text_matches?: TextMatch[];
}

interface CommitItem {
  html_url?: string;
  commit?: { message?: string; author?: { name?: string; email?: string; date?: string } };
  author?: GithubOwner | null;
  repository?: { full_name?: string };
}

interface UserItem {
  login?: string;
  html_url?: string;
  avatar_url?: string;
}

/** Plik, w którym właściciel repozytorium sam się przedstawia: README, FUNDING, repozytorium profilu albo strona `<login>.github.io`. */
function isOwnProfileFile(item: CodeItem): boolean {
  const owner = item.repository?.owner?.login?.toLowerCase() ?? '';
  const repo = item.repository?.name?.toLowerCase() ?? '';
  const path = (item.path ?? '').toLowerCase();
  if (item.repository?.fork) return false;
  if (/(^|\/)funding\.yml$/.test(path)) return true;
  if (/^readme(\.[a-z]+)?$/.test(path) || /^(docs\/)?(donate|donations|support|sponsors?)(\.[a-z]+)?$/.test(path)) return true;
  return owner !== '' && (repo === owner || repo === `${owner}.github.io`) && !path.includes('/');
}

const ownerProfile = (owner: GithubOwner): ProfileAttributes => ({
  urls: [owner.html_url ?? `https://github.com/${owner.login}`],
  ...(owner.avatar_url ? { avatarUrl: owner.avatar_url } : {}),
});

/** Fragment tekstu wokół szukanej frazy (treść zgłoszenia bywa bardzo długa). */
function around(text: string, term: string, radius = 600): string {
  const at = text.indexOf(term);
  return at < 0 ? text.slice(0, radius * 2) : text.slice(Math.max(0, at - radius), at + term.length + radius);
}

export function createGithubSearchConnector(http: HttpClient, config: { token?: string } = {}): SourceConnector {
  return {
    id: GITHUB_ID,
    service: 'github.com',
    label: GITHUB_LABEL,
    description:
      'Wyszukiwarka GitHuba (api.github.com/search, wymaga tokenu GITHUB_TOKEN): dla adresu kryptowalutowego — dokładna fraza w kodzie i plikach ' +
      '(/search/code, z fragmentem tekstu), w zgłoszeniach (/search/issues) i w opisach commitów (/search/commits); dla e-maila — commity autora ' +
      '(author-email:) i konta z tym adresem (in:email); dla nicka — konto o tym loginie (in:login). Autor = właściciel repozytorium albo autor wpisu; ' +
      'README, FUNDING.yml i repozytorium profilu liczą się jako własny profil. Najwyżej 3 zapytania na identyfikator; zwraca wszystkich autorów.',
    accepts: ['crypto_address', 'email', 'nick', 'login'],
    // Bez tokenu wyszukiwarka nie działa, więc łącznik nie bierze domyślnie udziału w analizie.
    enabledByDefault: Boolean(config.token),

    async search(identifier, context) {
      if (!config.token) {
        context.log(`${GITHUB_LABEL}: wymaga tokenu — ustaw GITHUB_TOKEN. Źródło pominięte.`);
        return [];
      }
      const type = identifier.type;
      const term = type === 'email' ? identifier.value.trim().toLowerCase() : cleanHandle(identifier.value);
      if (type === 'crypto_address' && !validateAddress(term)) return [];
      if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(term)) return [];
      if ((type === 'nick' || type === 'login') && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(term)) return [];

      const session = http.session(context, {
        label: GITHUB_LABEL,
        limit: 3,
        refusalMessage: (status) => `${GITHUB_LABEL}: limit zapytań wyszukiwarki GitHuba albo odrzucony token (kod ${status}) — pomijam dalsze zapytania.`,
      });
      const get = async <T>(path: string, textMatch = false): Promise<T | null> => {
        const response = await session.get(`${GITHUB_API}${path}`, {
          headers: {
            Accept: textMatch ? 'application/vnd.github.text-match+json' : 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            Authorization: `Bearer ${config.token}`,
          },
        });
        return response ? parseJson<T>(response.text) : null;
      };
      const documents: SourceDocument[] = [];
      const seen = new Set<string>();
      const push = (
        url: string | undefined,
        title: string,
        text: string,
        author: string | undefined,
        category: SourceCategory,
        profile: ProfileAttributes,
        publishedAt?: string,
      ) => {
        if (!url || !author || seen.has(url) || !text.trim()) return;
        seen.add(url);
        documents.push({
          connectorId: GITHUB_ID,
          service: 'github.com',
          url,
          title,
          text: normalizeAddressText(text).slice(0, 20_000),
          fetchedAt: new Date().toISOString(),
          author,
          category,
          // Wyszukiwanie po adresie zwraca wszystkich publikujących; o właścicielu decyduje analiza.
          identityMatch: type === 'crypto_address' ? 'name_only' : 'exact_identifier',
          matchedIdentifier: identifier,
          profile: { handle: author, ...profile },
          ...(publishedAt ? { publishedAt } : {}),
        });
      };
      const quoted = encodeURIComponent(`"${term}"`);

      if (type === 'crypto_address') {
        const code = await get<{ items?: CodeItem[] }>(`/search/code?q=${quoted}&per_page=30`, true);
        for (const item of code?.items ?? []) {
          const owner = item.repository?.owner;
          const fragments = (item.text_matches ?? []).map((match) => match.fragment ?? '').filter((fragment) => fragment.includes(term));
          // Bez fragmentu zawierającego adres nie da się potwierdzić trafienia.
          if (!owner?.login || fragments.length === 0) continue;
          push(
            item.html_url,
            `${item.repository?.full_name}: ${item.path}`,
            `Plik ${item.path} w repozytorium ${item.repository?.full_name}:\n${fragments.join('\n…\n')}`,
            owner.login,
            isOwnProfileFile(item) ? 'own_profile' : 'forum_post',
            ownerProfile(owner),
          );
        }
        const issues = session.refused ? null : await get<{ items?: IssueItem[] }>(`/search/issues?q=${quoted}&per_page=30`, true);
        for (const item of issues?.items ?? []) {
          const body = `${item.title ?? ''}\n${item.body ?? ''}`;
          if (!item.user?.login || !body.includes(term)) continue;
          push(item.html_url, item.title ?? 'Zgłoszenie GitHub', around(body, term), item.user.login, 'forum_post', ownerProfile(item.user), item.created_at);
        }
        const commits = session.refused ? null : await get<{ items?: CommitItem[] }>(`/search/commits?q=${quoted}&per_page=30`);
        for (const item of commits?.items ?? []) {
          const message = item.commit?.message ?? '';
          const author = item.author?.login ?? item.commit?.author?.name;
          if (!message.includes(term)) continue;
          push(item.html_url, `Commit w ${item.repository?.full_name ?? 'repozytorium'}`, message, author, 'forum_post', item.author?.login ? ownerProfile(item.author) : {}, item.commit?.author?.date);
        }
      } else if (type === 'email') {
        const commits = await get<{ items?: CommitItem[] }>(`/search/commits?q=${encodeURIComponent(`author-email:${term}`)}&sort=author-date&order=desc&per_page=30`);
        // Wiele commitów jednej osoby to jeden ślad: konto i nazwa, którymi podpisuje ten e-mail.
        const byAuthor = new Map<string, { item: CommitItem; count: number; repos: Set<string> }>();
        for (const item of commits?.items ?? []) {
          if (item.commit?.author?.email?.toLowerCase() !== term) continue;
          const key = item.author?.login ?? item.commit.author.name ?? '';
          if (!key) continue;
          const entry = byAuthor.get(key) ?? { item, count: 0, repos: new Set<string>() };
          entry.count += 1;
          if (item.repository?.full_name) entry.repos.add(item.repository.full_name);
          byAuthor.set(key, entry);
        }
        for (const [author, entry] of byAuthor) {
          const name = entry.item.commit?.author?.name;
          push(
            entry.item.author?.html_url ?? entry.item.html_url,
            `Commity podpisane adresem ${term}: ${author}`,
            `Commity podpisane adresem ${term} (źródło: api.github.com/search/commits, author-email).\nAutor: ${name ?? author}${entry.item.author?.login ? ` (konto ${entry.item.author.login})` : ''}\n` +
              `Liczba commitów w wynikach: ${entry.count}; repozytoria: ${[...entry.repos].slice(0, 5).join(', ') || 'brak danych'}`,
            author,
            'own_profile',
            { ...(entry.item.author?.login ? ownerProfile(entry.item.author) : {}), ...(name ? { displayName: name } : {}), ...(isTechnicalEmail(term) ? {} : { emails: [term] }) },
            entry.item.commit?.author?.date,
          );
        }
        const users = session.refused ? null : await get<{ items?: UserItem[] }>(`/search/users?q=${encodeURIComponent(`${term} in:email`)}&per_page=5`);
        for (const user of users?.items ?? []) {
          if (!user.login) continue;
          push(user.html_url ?? `https://github.com/${user.login}`, `Konto GitHub z publicznym adresem ${term}: ${user.login}`, `Konto GitHub ${user.login} podaje publicznie adres e-mail ${term}.`, user.login, 'own_profile', {
            ...ownerProfile(user),
            emails: [term],
          });
        }
      } else {
        const users = await get<{ items?: UserItem[] }>(`/search/users?q=${encodeURIComponent(`${term} in:login`)}&per_page=10`);
        for (const user of users?.items ?? []) {
          // Wyszukiwarka dopasowuje fragmenty loginu — bierzemy tylko dokładną zgodność.
          if (user.login?.toLowerCase() !== term.toLowerCase()) continue;
          push(user.html_url ?? `https://github.com/${user.login}`, `Konto GitHub: ${user.login}`, `Konto GitHub o loginie ${user.login}.`, user.login, 'own_profile', ownerProfile(user));
        }
      }

      const authors = new Set(documents.map((document) => document.author));
      context.log(`${GITHUB_LABEL}: „${term}" — dokumentów: ${documents.length}, autorów: ${authors.size} (zapytań: ${session.used}).`);
      return documents;
    },
  };
}

// ---------- Serwisy wiedzy o adresach Bitcoin ----------

function bitcoinAddress(identifier: Identifier): string | null {
  const valid = validateAddress(identifier.value.trim());
  return valid && valid.network === 'bitcoin' ? valid.address : null;
}

/** WalletExplorer: nazwa portfela (klastra adresów), do którego należy adres. */
export function createWalletExplorerConnector(http: HttpClient): SourceConnector {
  const id = 'live-walletexplorer';
  const label = 'WalletExplorer';
  return {
    id,
    service: 'walletexplorer.com',
    label,
    description:
      'Publiczna strona adresu w serwisie WalletExplorer (walletexplorer.com/address/<adres>, bez klucza): nazwa portfela, do którego serwis zalicza adres ' +
      '(np. giełda, bramka płatnicza, serwis hazardowy). Tylko adresy Bitcoin; dokument powstaje wyłącznie dla portfela nazwanego. Jedno żądanie na adres.',
    accepts: ['crypto_address'],
    enabledByDefault: true,

    async search(identifier, context) {
      const address = bitcoinAddress(identifier);
      if (!address) return [];
      const url = `https://www.walletexplorer.com/address/${address}`;
      const page = await http.session(context, { label, limit: 1 }).get(url, { allowedContentTypes: ['text/html'], quietMissing: true });
      if (!page) return [];
      const note = innerByClass(page.text, 'walletnote');
      const name = htmlToText(innerByClass(note?.inner ?? '', 'wallet_name')?.inner ?? '').trim();
      // Portfele bez nazwy mają identyfikator w nawiasach kwadratowych, np. [022c1bcdb3] — to nie jest wiedza o właścicielu.
      if (!name || /^\[[0-9a-f]+\]$/i.test(name)) {
        context.log(`${label}: adres ${address} — portfel bez nazwy${name ? ` ${name}` : ''}.`);
        return [];
      }
      const walletHref = selectAll(note?.inner ?? '', 'a[href^=/wallet/]')[0];
      context.log(`${label}: adres ${address} należy do portfela „${name}".`);
      return [
        {
          connectorId: id,
          service: 'walletexplorer.com',
          url,
          title: `WalletExplorer: adres w portfelu „${name}"`,
          text: `Serwis WalletExplorer zalicza adres ${address} do portfela „${name}". To przypisanie wynika z analizy powiązań między adresami (wspólne wejścia transakcji), a nie z deklaracji właściciela.`,
          fetchedAt: new Date().toISOString(),
          // „Autorem" jest nazwany portfel — kandydat na właściciela adresu (zwykle usługa, nie osoba).
          author: name,
          category: 'forum_post',
          identityMatch: 'name_only',
          matchedIdentifier: identifier,
          profile: { handle: name, urls: [walletHref ? new URL(attributeOf(walletHref.open, 'href')!, url).toString() : url] },
        },
      ];
    },
  };
}

/** BitcoinWhosWho: zgłoszenia oszustw i publiczne strony, na których widziano adres. */
export function createBitcoinWhosWhoConnector(http: HttpClient): SourceConnector {
  const id = 'live-bitcoinwhoswho';
  const label = 'BitcoinWhosWho';
  return {
    id,
    service: 'bitcoinwhoswho.com',
    label,
    description:
      'Publiczna strona adresu w serwisie BitcoinWhosWho (bitcoinwhoswho.com/address/<adres>, bez klucza): ostrzeżenie o zgłoszonych oszustwach („Scam Alert") ' +
      'oraz lista stron WWW, na których serwis zauważył ten adres („Website Appearances"), z datami. Tylko adresy Bitcoin. Jedno żądanie na adres.',
    accepts: ['crypto_address'],
    enabledByDefault: true,

    async search(identifier, context) {
      const address = bitcoinAddress(identifier);
      if (!address) return [];
      const url = `https://www.bitcoinwhoswho.com/address/${address}`;
      const page = await http.session(context, { label, limit: 1 }).get(url, { allowedContentTypes: ['text/html'], quietMissing: true });
      if (!page) return [];
      const alerts = selectAll(page.text, 'span.top_scam_alert')
        .filter((element) => !/display\s*:\s*none/i.test(attributeOf(element.open, 'style') ?? ''))
        .map((element) => htmlToText(element.inner).replace(/\n/g, ' ').trim())
        .filter(Boolean);
      const table = selectAll(page.text, 'div[id=url_bitcoin_found_table]')[0]?.inner ?? '';
      const sightings: string[] = [];
      for (const row of selectAll(table, 'div.row')) {
        const cells = selectAll(row.inner, 'div').map((cell) => htmlToText(cell.inner).replace(/\n/g, ' ').trim());
        const link = selectAll(row.inner, 'a[href^=http]')[0];
        const href = link ? attributeOf(link.open, 'href') : undefined;
        if (!href) continue;
        sightings.push(`- ${cells[0] ?? ''}: ${href}${cells[1] ? ` — ${cells[1].slice(0, 160)}` : ''}`);
      }
      const alert = alerts.join('; ') || 'brak danych';
      const flagged = alerts.some((text) => !/none/i.test(text));
      if (sightings.length === 0 && !flagged) {
        context.log(`${label}: adres ${address} — brak zgłoszeń i wystąpień (${alert}).`);
        return [];
      }
      context.log(`${label}: adres ${address} — ${alert}; stron z wystąpieniami: ${sightings.length}.`);
      return [
        {
          connectorId: id,
          service: 'bitcoinwhoswho.com',
          url,
          title: `BitcoinWhosWho: zgłoszenia i wystąpienia adresu`,
          text: [
            `Serwis BitcoinWhosWho o adresie ${address}:`,
            `Ostrzeżenie o oszustwach: ${alert}`,
            sightings.length > 0 ? `Strony, na których serwis zauważył adres (data — adres strony — opis):\n${sightings.slice(0, 40).join('\n')}` : 'Strony z wystąpieniami adresu: brak',
          ].join('\n'),
          fetchedAt: new Date().toISOString(),
          // Dokument opisuje adres, nie osobę — bez autora, żeby analiza nie liczyła serwisu jako publikującego.
          category: 'forum_post',
          identityMatch: 'name_only',
          matchedIdentifier: identifier,
        },
      ];
    },
  };
}

// ---------- Archiwalne kopie profilu Twitter/X ----------

/** Wayback Machine dla `twitter.com/<nick>`: dawne opisy profilu (bio) z adresami i odnośnikami. */
export function createWaybackTwitterConnector(http: HttpClient): SourceConnector {
  const base = createWaybackConnector(http);
  const id = 'live-wayback-twitter';
  return {
    id,
    service: 'web.archive.org',
    label: 'Wayback Machine — profil Twitter/X',
    description:
      'Archiwalne kopie profilu twitter.com/<nick> z Wayback Machine (CDX API): do 3 kopii rozłożonych w czasie — dawne opisy profilu i przypięte wpisy. ' +
      'Bieżącego profilu łącznik nie pobiera (wymaga logowania). Najwyżej 4 żądania na identyfikator.',
    accepts: ['nick', 'login'],
    enabledByDefault: true,

    async search(identifier, context) {
      const handle = cleanHandle(identifier.value);
      if (!/^[A-Za-z0-9_]{2,15}$/.test(handle)) return [];
      const documents = await base.search({ type: 'profile_url', value: `https://twitter.com/${handle}` }, context);
      return documents.map((document) => ({ ...document, connectorId: id, matchedIdentifier: identifier }));
    },
  };
}
