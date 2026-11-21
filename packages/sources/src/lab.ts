// Łączniki do laboratorium tożsamości (apps/identity-lab) — SYMULACJA LOKALNA, nie prawdziwe serwisy.
// Laboratorium udaje 27 portali (społecznościowe, ogłoszeniowe, fora); ich nazwy nawiązują do znanych
// serwisów, ale wszystkie konta, treści i adresy `lab1…` są syntetyczne. Każdy portal ma własny łącznik
// i własną wartość `service`, bo od niej zależy, czy dwa ślady liczą się jako niezależne źródła.
//
// Łączniki korzystają WYŁĄCZNIE z publicznego API laboratorium:
//   GET /api/accounts?service=&q=   — wyszukiwanie kont (nick, e-mail, nazwa wyświetlana),
//   GET /api/accounts/:id           — profil z treściami (wpisy, oferty, wątki),
//   GET /api/portal/:slug           — publiczna zawartość portalu (wyszukiwanie adresu w treściach).
// Nigdy nie czytają prawdy wzorcowej ani wyników silnika laboratorium (`/api/ground-truth`,
// `/api/resolve`, `/api/evaluate`, `/api/export/*`); `/api/search` też jest pomijane, bo zwraca
// hipotezy silnika laboratorium, a nie surowe dane publiczne.

import { validateAddress } from '@olcys/core';
import type {
  ConnectorContext,
  Identifier,
  IdentifierType,
  IdentityMatch,
  ProfileAttributes,
  SourceCategory,
  SourceConnector,
  SourceDocument,
} from '@olcys/core';
import { findEmails, findPhones } from './html.ts';
import { errorMessage, httpGet, parseJson } from './http.ts';
import type { Fetcher } from './http.ts';

export type LabPortalCategory = 'social' | 'marketplace' | 'forum';

export interface LabPortal {
  /** Identyfikator serwisu w API laboratorium (`serviceId` kont i treści). */
  id: string;
  /** Fragment ścieżki portalu (`/s/<slug>`, `/api/portal/<slug>`). */
  slug: string;
  /** Nazwa bez dopisku laboratorium — w etykiecie łącznika zawsze z przedrostkiem „LAB: ”. */
  name: string;
  category: LabPortalCategory;
  about: string;
}

/** Katalog portali laboratorium (apps/identity-lab/lib/services.mjs). */
export const LAB_PORTALS: LabPortal[] = [
  { id: 'social-x', slug: 'x', name: 'X', category: 'social', about: 'mikroblog' },
  { id: 'social-facebook', slug: 'facebook', name: 'Facebook', category: 'social', about: 'profile i lokalne społeczności' },
  { id: 'social-instagram', slug: 'instagram', name: 'Instagram', category: 'social', about: 'fotorelacje' },
  { id: 'social-tiktok', slug: 'tiktok', name: 'TikTok', category: 'social', about: 'krótkie materiały wideo opisane wpisami' },
  { id: 'social-linkedin', slug: 'linkedin', name: 'LinkedIn', category: 'social', about: 'profile zawodowe' },
  { id: 'market-allegro', slug: 'allegro', name: 'Allegro', category: 'marketplace', about: 'oferty i aukcje' },
  { id: 'market-olx', slug: 'olx', name: 'OLX', category: 'marketplace', about: 'ogłoszenia lokalne' },
  { id: 'market-vinted', slug: 'vinted', name: 'Vinted', category: 'marketplace', about: 'rzeczy z drugiej ręki' },
  { id: 'market-ebay', slug: 'ebay', name: 'eBay', category: 'marketplace', about: 'aukcje kolekcjonerskie' },
  { id: 'market-amazon', slug: 'amazon', name: 'Amazon', category: 'marketplace', about: 'katalog produktów i konta sprzedających' },
  { id: 'market-etsy', slug: 'etsy', name: 'Etsy', category: 'marketplace', about: 'rękodzieło' },
  { id: 'market-sprzedajemy', slug: 'sprzedajemy', name: 'Sprzedajemy', category: 'marketplace', about: 'ogłoszenia drobne' },
  { id: 'forum-rower', slug: 'forum-rowerowe', name: 'Rowerowy Szlak', category: 'forum', about: 'forum rowerowe' },
  { id: 'forum-foto', slug: 'forum-fotograficzne', name: 'Kadr i Światło', category: 'forum', about: 'forum fotograficzne' },
  { id: 'forum-elektronika', slug: 'forum-elektroniki', name: 'Lutownia', category: 'forum', about: 'forum elektroniki' },
  { id: 'forum-moto', slug: 'forum-motoryzacyjne', name: 'Garaż Dyskusyjny', category: 'forum', about: 'forum motoryzacyjne' },
  { id: 'forum-ogrod', slug: 'forum-ogrodnicze', name: 'Zielony Zakątek', category: 'forum', about: 'forum ogrodnicze' },
  { id: 'forum-kuchnia', slug: 'forum-kulinarne', name: 'Wspólny Stół', category: 'forum', about: 'forum kulinarne' },
  { id: 'forum-gry', slug: 'forum-gier', name: 'Następna Tura', category: 'forum', about: 'forum gier' },
  { id: 'forum-it', slug: 'forum-programistyczne', name: 'Kod Otwarty', category: 'forum', about: 'forum programistyczne' },
  { id: 'forum-podroze', slug: 'forum-podroznicze', name: 'Poza Mapą', category: 'forum', about: 'forum podróżnicze' },
  { id: 'forum-dom', slug: 'forum-domowe', name: 'Dom od Podstaw', category: 'forum', about: 'forum o remontach i wnętrzach' },
  { id: 'forum-ksiazki', slug: 'forum-ksiazkowe', name: 'Między Stronami', category: 'forum', about: 'forum książkowe' },
  { id: 'forum-muzyka', slug: 'forum-muzyczne', name: 'Drugi Refren', category: 'forum', about: 'forum muzyczne' },
  { id: 'forum-bieganie', slug: 'forum-biegowe', name: 'Równe Tempo', category: 'forum', about: 'forum biegowe' },
  { id: 'forum-lokalne', slug: 'forum-miejskie', name: 'Nasza Dzielnica', category: 'forum', about: 'forum sąsiedzkie' },
  { id: 'forum-krypto', slug: 'forum-blockchain', name: 'Łańcuch Rozmów', category: 'forum', about: 'forum o testowym łańcuchu LAB' },
];

/** Przedrostek identyfikatorów łączników laboratorium. */
export const LAB_PREFIX = 'lab-';

/** Jedyne ścieżki API laboratorium, z których łączniki mogą korzystać. */
const ALLOWED_PATHS = ['/api/accounts', '/api/portal/'];

// ---------- Kształt publicznych danych laboratorium ----------

interface LabAccount {
  id: string;
  serviceId: string;
  username: string;
  displayName?: string;
  email?: string;
  bio?: string;
  location?: string;
  joinedAt?: string;
  walletAddresses?: string[];
}

interface LabPost {
  id: string;
  accountId: string;
  text: string;
  createdAt?: string;
}

interface LabListing {
  id: string;
  accountId: string;
  title?: string;
  description?: string;
  price?: number;
  currency?: string;
  createdAt?: string;
}

interface LabReply {
  id: string;
  accountId: string;
  text: string;
  createdAt?: string;
}

interface LabThread {
  id: string;
  accountId: string;
  title?: string;
  text: string;
  createdAt?: string;
  replies?: LabReply[];
}

interface LabContent {
  posts?: LabPost[];
  listings?: LabListing[];
  threads?: LabThread[];
}

interface LabAccountDetail extends LabContent {
  account: LabAccount;
}

interface LabPortalData extends LabContent {
  accounts?: LabAccount[];
}

export interface LabConnectorOptions {
  /** Zamiennik `fetch` (testy na atrapach). */
  fetcher?: Fetcher;
  /** Jak długo pamiętać pobraną zawartość portalu (wyszukiwanie adresów); domyślnie 15 s, 0 wyłącza. */
  portalCacheMs?: number;
}

const ACCEPTS: IdentifierType[] = ['full_name', 'nick', 'login', 'email', 'crypto_address'];

/** Górne limity jednego wyszukiwania — łącznik ma być przewidywalny także dla dużego zbioru. */
const MAX_ACCOUNTS = 10;
const MAX_CONTENT_PER_ACCOUNT = 30;
const MAX_ADDRESS_DOCUMENTS = 60;
const PORTAL_MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_PORTAL_CACHE_MS = 15_000;

const CONTENT_CATEGORY: Record<LabPortalCategory, SourceCategory> = {
  // Wpis na własnej tablicy to publikacja we własnym profilu (tak samo jak w piaskownicy).
  social: 'own_profile',
  marketplace: 'sale_offer',
  forum: 'forum_post',
};

const handleKey = (value: string): string => value.trim().replace(/^@/, '').toLowerCase();
const fold = (value: string): string =>
  value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l').replace(/Ł/g, 'L').trim().toLowerCase().replace(/\s+/g, ' ');
const unique = <T,>(values: T[]): T[] => [...new Set(values)];

/** Wzmianki „@konto” w opisie (nie fragmenty adresów e-mail). */
function findMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9._%+-])@([A-Za-z0-9_][A-Za-z0-9_.-]{2,29})/g)) found.push(match[1]!.replace(/[.-]+$/, ''));
  return unique(found);
}

type MatchedBy = 'handle' | 'email' | 'name' | 'address';

/** Po czym konto pasuje do identyfikatora — dopasowanie dokładne, nie podciąg. */
function matchAccount(account: LabAccount, identifier: Identifier): MatchedBy | null {
  const value = identifier.value.trim();
  if (identifier.type === 'nick' || identifier.type === 'login') return handleKey(account.username) === handleKey(value) ? 'handle' : null;
  if (identifier.type === 'email') {
    const wanted = value.toLowerCase();
    return (account.email ?? '').toLowerCase() === wanted || findEmails(account.bio ?? '').includes(wanted) ? 'email' : null;
  }
  if (identifier.type === 'full_name') return account.displayName !== undefined && fold(account.displayName) === fold(value) ? 'name' : null;
  return null;
}

/** Publiczne dane konta jako atrybuty profilu: to, co portal pokazuje, plus kontakt podany w opisie. */
function profileOf(account: LabAccount): ProfileAttributes {
  const bio = account.bio?.trim();
  const emails = unique([...(account.email ? [account.email.toLowerCase()] : []), ...findEmails(bio ?? '')]);
  const phones = findPhones(bio ?? '');
  return {
    handle: account.username,
    ...(account.displayName ? { displayName: account.displayName } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(account.location ? { location: account.location } : {}),
    ...(bio ? { bio } : {}),
    ...(account.joinedAt ? { createdAt: account.joinedAt } : {}),
  };
}

interface ContentItem {
  /** Parametr adresu dokumentu — każda treść ma własny adres, żeby nie zlewała się z profilem. */
  param: string;
  id: string;
  accountId: string;
  title: string;
  text: string;
  category: SourceCategory;
  publishedAt?: string;
}

/** Treści portalu w jednej postaci: wpisy, oferty, wątki i odpowiedzi — każda jako wypowiedź jednego autora. */
function contentItems(portal: LabPortal, data: LabContent, includeReplies: boolean): ContentItem[] {
  const label = `LAB: ${portal.name}`;
  const items: ContentItem[] = [];
  for (const post of data.posts ?? []) {
    items.push({ param: 'wpis', id: post.id, accountId: post.accountId, title: `Wpis w ${label}`, text: post.text, category: CONTENT_CATEGORY.social, publishedAt: post.createdAt });
  }
  for (const listing of data.listings ?? []) {
    const price = listing.price !== undefined ? `\nCena: ${listing.price} ${listing.currency ?? ''}`.trimEnd() : '';
    items.push({
      param: 'oferta',
      id: listing.id,
      accountId: listing.accountId,
      title: listing.title ?? `Oferta w ${label}`,
      text: `${listing.title ?? ''}\n${listing.description ?? ''}${price}`.trim(),
      category: CONTENT_CATEGORY.marketplace,
      publishedAt: listing.createdAt,
    });
  }
  for (const thread of data.threads ?? []) {
    // Dokument zawiera wyłącznie wypowiedź autora wątku — odpowiedzi innych osób są osobnymi dokumentami.
    items.push({
      param: 'watek',
      id: thread.id,
      accountId: thread.accountId,
      title: thread.title ?? `Wątek w ${label}`,
      text: `${thread.title ?? ''}\n${thread.text}`.trim(),
      category: CONTENT_CATEGORY.forum,
      publishedAt: thread.createdAt,
    });
    if (!includeReplies) continue;
    for (const reply of thread.replies ?? []) {
      items.push({
        param: 'odpowiedz',
        id: reply.id,
        accountId: reply.accountId,
        title: `Odpowiedź w wątku „${thread.title ?? thread.id}”`,
        text: reply.text,
        category: CONTENT_CATEGORY.forum,
        publishedAt: reply.createdAt,
      });
    }
  }
  return items;
}

function createLabConnector(portal: LabPortal, base: string, options: LabConnectorOptions, portalCache: Map<string, { at: number; data: Promise<LabPortalData | null> }>): SourceConnector {
  const id = `${LAB_PREFIX}${portal.slug}`;
  const service = `${portal.slug}.lab.test`;
  const label = `LAB: ${portal.name}`;
  const profileUrl = (accountId: string) => `${base}/s/${portal.slug}/profile/${encodeURIComponent(accountId)}`;

  async function getJson<T>(path: string, context: ConnectorContext, maxBytes?: number): Promise<T | null> {
    if (!ALLOWED_PATHS.some((allowed) => path.startsWith(allowed))) throw new Error(`niedozwolona ścieżka API laboratorium: ${path}`);
    const response = await httpGet(`${base}${path}`, context, { ...(options.fetcher ? { fetcher: options.fetcher } : {}), ...(maxBytes ? { maxBytes } : {}) });
    if (!response.ok) {
      context.log(`${label}: ${path} — kod ${response.status}.`);
      return null;
    }
    const parsed = parseJson<T>(response.text);
    if (parsed === null) context.log(`${label}: ${path} — odpowiedź nie jest poprawnym JSON-em.`);
    return parsed;
  }

  /** Publiczna zawartość portalu; pamiętana krótko, bo wyszukiwanie adresu pyta o nią wiele razy z rzędu. */
  function portalData(context: ConnectorContext): Promise<LabPortalData | null> {
    const ttl = options.portalCacheMs ?? DEFAULT_PORTAL_CACHE_MS;
    const cached = portalCache.get(portal.slug);
    if (cached && ttl > 0 && Date.now() - cached.at < ttl) return cached.data;
    const data = getJson<LabPortalData>(`/api/portal/${encodeURIComponent(portal.slug)}`, context, PORTAL_MAX_BYTES).catch((error) => {
      portalCache.delete(portal.slug);
      throw error;
    });
    if (ttl > 0) {
      portalCache.set(portal.slug, { at: Date.now(), data });
      void data.then((value) => value === null && portalCache.delete(portal.slug)).catch(() => undefined);
    }
    return data;
  }

  const baseDocument = (account: LabAccount, identifier: Identifier, identityMatch: IdentityMatch) => ({
    connectorId: id,
    service,
    fetchedAt: new Date().toISOString(),
    identityMatch,
    matchedIdentifier: identifier,
    author: account.username,
    profile: profileOf(account),
  });

  /** Strona profilu: wszystko, co portal pokazuje o koncie, łącznie z „publicznymi adresami portfeli”. */
  function profileDocument(account: LabAccount, identifier: Identifier, identityMatch: IdentityMatch, matchedBy: MatchedBy): SourceDocument {
    const wallets = account.walletAddresses ?? [];
    const text = [
      `${account.displayName ?? account.username} (@${account.username})`,
      account.bio ?? '',
      account.location ? `Lokalizacja: ${account.location}` : '',
      account.email ? `E-mail: ${account.email}` : '',
      wallets.length > 0 ? `Publiczne adresy portfeli: ${wallets.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    // Wskazówki o innych kontach bierzemy tylko z dokumentów pewnie powiązanych z podmiotem —
    // konto imiennika ani cudza wzmianka o adresie nie uruchamiają dalszego wyszukiwania.
    const discovered: Identifier[] = [];
    if (identityMatch !== 'name_only') {
      const self = identifier.value.trim().toLowerCase();
      if (matchedBy === 'email') discovered.push({ type: 'nick', value: account.username });
      for (const email of profileOf(account).emails ?? []) if (email !== self) discovered.push({ type: 'email', value: email });
      for (const mention of findMentions(account.bio ?? '')) {
        if (handleKey(mention) !== handleKey(account.username) && handleKey(mention) !== handleKey(identifier.value)) discovered.push({ type: 'nick', value: mention });
      }
    }
    return {
      ...baseDocument(account, identifier, identityMatch),
      url: profileUrl(account.id),
      title: `${account.displayName ?? account.username} (@${account.username}) — profil w ${label}`,
      text,
      category: 'own_profile',
      ...(discovered.length > 0 ? { discoveredIdentifiers: discovered } : {}),
    };
  }

  function contentDocument(account: LabAccount, item: ContentItem, identifier: Identifier, identityMatch: IdentityMatch): SourceDocument {
    const discovered: Identifier[] =
      identityMatch === 'name_only'
        ? []
        : findEmails(item.text)
            .filter((email) => email !== identifier.value.trim().toLowerCase())
            .map((email) => ({ type: 'email' as const, value: email }));
    return {
      ...baseDocument(account, identifier, identityMatch),
      url: `${profileUrl(account.id)}?${item.param}=${encodeURIComponent(item.id)}`,
      title: item.title,
      text: item.text,
      category: item.category,
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
      ...(discovered.length > 0 ? { discoveredIdentifiers: discovered } : {}),
    };
  }

  /** Konta pasujące do identyfikatora osoby: profil i treści każdego z nich. */
  async function searchPerson(identifier: Identifier, context: ConnectorContext): Promise<SourceDocument[]> {
    const query = identifier.value.trim().replace(/^@/, '');
    const listed = await getJson<{ accounts?: LabAccount[] }>(`/api/accounts?service=${encodeURIComponent(portal.id)}&q=${encodeURIComponent(query)}&limit=1000`, context);
    const matches = (listed?.accounts ?? [])
      .map((account) => ({ account, matchedBy: matchAccount(account, identifier) }))
      .filter((entry): entry is { account: LabAccount; matchedBy: MatchedBy } => entry.matchedBy !== null);
    if (matches.length > MAX_ACCOUNTS) context.log(`${label}: „${identifier.value}” pasuje do ${matches.length} kont — pobrano pierwsze ${MAX_ACCOUNTS}.`);
    const documents: SourceDocument[] = [];
    for (const { account: listedAccount, matchedBy } of matches.slice(0, MAX_ACCOUNTS)) {
      // Samo imię i nazwisko nie wskazuje osoby — dokument dostaje najsłabsze powiązanie.
      const identityMatch: IdentityMatch = matchedBy === 'name' ? 'name_only' : 'exact_identifier';
      const detail = await getJson<LabAccountDetail>(`/api/accounts/${encodeURIComponent(listedAccount.id)}`, context);
      const account = detail?.account ?? listedAccount;
      documents.push(profileDocument(account, identifier, identityMatch, matchedBy));
      if (!detail) continue;
      for (const item of contentItems(portal, detail, false).slice(0, MAX_CONTENT_PER_ACCOUNT)) {
        if (item.accountId === account.id && item.text) documents.push(contentDocument(account, item, identifier, identityMatch));
      }
    }
    return documents;
  }

  /**
   * Kto publikuje adres: profile z adresem na liście „publiczne adresy portfeli” oraz treści z adresem.
   * To dokumenty cudzego autorstwa względem zapytania — właściciela rozstrzyga analiza, nie łącznik.
   */
  async function searchAddress(address: string, identifier: Identifier, context: ConnectorContext): Promise<SourceDocument[]> {
    const data = await portalData(context);
    if (!data) return [];
    const wanted = address.toLowerCase();
    const accounts = new Map((data.accounts ?? []).map((account) => [account.id, account]));
    const documents: SourceDocument[] = [];
    for (const account of accounts.values()) {
      const listed = (account.walletAddresses ?? []).some((item) => item.toLowerCase() === wanted) || (account.bio ?? '').toLowerCase().includes(wanted);
      if (listed) documents.push(profileDocument(account, identifier, 'name_only', 'address'));
    }
    for (const item of contentItems(portal, data, true)) {
      if (!item.text.toLowerCase().includes(wanted)) continue;
      const account = accounts.get(item.accountId);
      // Autor spoza portalu (nie powinno się zdarzyć) zostaje pominięty: bez konta nie ma komu przypisać treści.
      if (account) documents.push(contentDocument(account, item, identifier, 'name_only'));
    }
    if (documents.length > MAX_ADDRESS_DOCUMENTS) context.log(`${label}: adres ${address} występuje w ${documents.length} dokumentach — zwrócono pierwsze ${MAX_ADDRESS_DOCUMENTS}.`);
    return documents.slice(0, MAX_ADDRESS_DOCUMENTS);
  }

  return {
    id,
    service,
    label,
    description:
      `Symulacja lokalna (laboratorium tożsamości, dane syntetyczne) — nie jest to prawdziwy serwis: ${portal.about}. ` +
      'Wyszukiwanie kont po nicku, e-mailu, nazwie wyświetlanej albo adresie lab1…; profil z treściami (wpisy, oferty, wątki).',
    accepts: ACCEPTS,
    enabledByDefault: true,

    async search(identifier, context) {
      let documents: SourceDocument[] = [];
      try {
        if (identifier.type === 'crypto_address') {
          const valid = validateAddress(identifier.value.trim());
          // Portale laboratorium znają wyłącznie adresy sieci laboratoryjnej.
          if (valid?.network !== 'lab') return [];
          documents = await searchAddress(valid.address, identifier, context);
        } else if (ACCEPTS.includes(identifier.type)) {
          documents = await searchPerson(identifier, context);
        }
      } catch (error) {
        context.log(`${label}: błąd podczas wyszukiwania „${identifier.value}”: ${errorMessage(error)}`);
      }
      context.log(`${label}: „${identifier.value}” — dokumentów: ${documents.length}.`);
      return documents;
    },
  };
}

/** Łączniki wszystkich portali laboratorium; `labUrl` to adres panelu (domyślnie http://127.0.0.1:8787). */
export function createLabConnectors(labUrl: string, options: LabConnectorOptions = {}): SourceConnector[] {
  const base = labUrl.replace(/\/+$/, '');
  const portalCache = new Map<string, { at: number; data: Promise<LabPortalData | null> }>();
  return LAB_PORTALS.map((portal) => createLabConnector(portal, base, options, portalCache));
}
