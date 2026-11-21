// Łączniki do fikcyjnych serwisów piaskownicy (apps/sandbox).
// Każdy serwis ma własny łącznik i własną wartość `service`, bo od niej zależy,
// czy dwa ślady liczą się jako niezależne źródła.

import type {
  ConnectorContext,
  DiscoveringConnector,
  Identifier,
  IdentifierType,
  IdentityMatch,
  ProfileAttributes,
  SourceCategory,
  SourceConnector,
  SourceDocument,
} from '@olcys/core';
import { extractContent, findEmails, findPhones, findRelMeLinks, htmlToText, innerByClass } from './html.ts';
import { errorMessage, httpGet } from './http.ts';

/** Wynik wyszukiwarki serwisu piaskownicy. */
interface SearchHit {
  url: string;
  title: string;
  author?: string;
  publishedAt?: string;
  snippet?: string;
  /** Rodzaj dokumentu: profile, page, offer, post, mail, comment, message. */
  kind?: string;
  /** Po czym wyszukiwarka trafiła: handle, email, name, address. */
  matchedBy?: string;
  /** Tylko archiwum: czas wykonania kopii i serwis, z którego pochodzi oryginał. */
  archivedAt?: string;
  originalService?: string;
  /** Publiczne dane konta autora podawane przez serwis. */
  profile?: ProfileAttributes;
}

interface SandboxService {
  /** Prefiks ścieżki serwisu w piaskownicy. */
  prefix: string;
  label: string;
  description: string;
  fallbackCategory: SourceCategory;
  categoryByKind: Record<string, SourceCategory>;
  /** Czy serwis ma listę najnowszych publikacji (`/api/recent`) — podstawa metody `discover`. */
  recent?: boolean;
}

const SERVICES: SandboxService[] = [
  {
    prefix: 'gitpub',
    recent: true,
    label: 'GitPub (piaskownica)',
    description: 'Profile programistów: bio, README i sekcja „Wesprzyj mnie". Wyszukiwanie po loginie, e-mailu, nazwisku lub adresie.',
    fallbackCategory: 'own_profile',
    categoryByKind: { profile: 'own_profile' },
  },
  {
    prefix: 'www',
    recent: true,
    label: 'Strony osobiste (piaskownica)',
    description: 'Prywatne strony WWW. Wyszukiwanie po właścicielu strony (nick, e-mail, nazwisko) lub adresie.',
    fallbackCategory: 'own_profile',
    categoryByKind: { page: 'own_profile' },
  },
  {
    prefix: 'targ',
    recent: true,
    label: 'Targ — ogłoszenia (piaskownica)',
    description: 'Ogłoszenia sprzedaży i oferty P2P. Wyszukiwanie po nicku ogłoszeniodawcy lub adresie.',
    fallbackCategory: 'sale_offer',
    categoryByKind: { offer: 'sale_offer' },
  },
  {
    prefix: 'forum',
    recent: true,
    label: 'Forum Kopaczy (piaskownica)',
    description: 'Posty na forum branżowym i wiadomości z listy dyskusyjnej (ze stopkami). Wyszukiwanie po autorze lub adresie.',
    fallbackCategory: 'forum_post',
    categoryByKind: { post: 'forum_post', mail: 'settlement_message' },
  },
  {
    prefix: 'spolecznosc',
    recent: true,
    label: 'Społeczność (piaskownica)',
    description: 'Profile, wpisy i komentarze w serwisie społecznościowym. Komentarze pod cudzymi wpisami liczone jako masowe.',
    fallbackCategory: 'mass_comment',
    categoryByKind: { profile: 'own_profile', post: 'own_profile', comment: 'mass_comment' },
  },
  {
    prefix: 'komunikator',
    recent: true,
    label: 'Komunikator Gołąb (piaskownica)',
    description: 'Wiadomości z publicznych kanałów grupowych, w tym rozliczenia „przelej na …". Wyszukiwanie po nicku lub adresie.',
    fallbackCategory: 'settlement_message',
    categoryByKind: { message: 'settlement_message' },
  },
];

const ALL_TYPES: IdentifierType[] = ['full_name', 'nick', 'login', 'email', 'messenger_id', 'crypto_address'];

/** Górne limity jednego wyszukiwania — piaskownica jest mała, ale łącznik ma być przewidywalny. */
const MAX_HITS = 30;
const MAX_LINKED_PROFILES = 3;

const sameHandle = (a: string, b: string) => a.replace(/^@/, '').toLowerCase() === b.replace(/^@/, '').toLowerCase();

/**
 * Sposób powiązania dokumentu z podmiotem. Trafienie po loginie/nicku lub
 * e-mailu autora to dokładny identyfikator. Trafienie po samym nazwisku albo po
 * adresie w treści (dokument cudzego autorstwa) dostaje najsłabsze powiązanie.
 */
function identityFor(hit: SearchHit, identifier: Identifier): IdentityMatch {
  if (hit.matchedBy === 'handle' || hit.matchedBy === 'email') return 'exact_identifier';
  if (!hit.matchedBy && hit.author && sameHandle(hit.author, identifier.value)) return 'exact_identifier';
  return 'name_only';
}

function dedupe(identifiers: Identifier[]): Identifier[] {
  const seen = new Set<string>();
  return identifiers.filter((item) => {
    const key = `${item.type}:${item.value.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface ConnectorSpec {
  id: string;
  service: string;
  prefix: string;
  label: string;
  description: string;
  /** Serwis i kategoria pojedynczego trafienia. */
  classify(hit: SearchHit): { service: string; category: SourceCategory };
  /** Czy podążać za odnośnikami rel="me" w obrębie tego samego serwisu. */
  followLinkedProfiles: boolean;
  /** Czy łącznik potrafi wskazać najnowsze publikacje bez identyfikatora osoby. */
  recent: boolean;
}

/** Ile najnowszych publikacji łącznik pobiera najwyżej w jednym wywołaniu `discover`. */
const MAX_DISCOVER = 50;

const unique = (values: (string | undefined)[]): string[] => [...new Set(values.filter((value): value is string => Boolean(value)))];

/** Łączy dane konta podane przez serwis z tym, co autor sam napisał w treści dokumentu. */
function buildProfile(hit: SearchHit, content: string, text: string, links: string[]): ProfileAttributes | undefined {
  if (!hit.author) return undefined;
  const given = hit.profile ?? {};
  const emails = unique([...(given.emails ?? []), ...findEmails(text)].map((email) => email.toLowerCase()));
  const phones = unique([...(given.phones ?? []).map((phone) => phone.replace(/[\s-]/g, '')), ...findPhones(text)]);
  const urls = unique([...(given.urls ?? []), ...links]);
  const bio = given.bio ?? (htmlToText(innerByClass(content, 'bio')?.inner ?? '') || undefined);
  return {
    ...given,
    handle: given.handle ?? hit.author.replace(/^@/, ''),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(urls.length > 0 ? { urls } : {}),
    ...(bio ? { bio } : {}),
  };
}

function createConnector(spec: ConnectorSpec, sandboxUrl: string): SourceConnector {
  const base = sandboxUrl.replace(/\/+$/, '');

  async function searchHits(query: string, context: ConnectorContext): Promise<SearchHit[]> {
    const response = await httpGet(`${base}/${spec.prefix}/api/search?q=${encodeURIComponent(query)}`, context);
    if (!response.ok) {
      context.log(`${spec.label}: wyszukiwarka odpowiedziała kodem ${response.status} dla „${query}".`);
      return [];
    }
    return (JSON.parse(response.text) as SearchHit[]).slice(0, MAX_HITS);
  }

  /** Pobiera stronę trafienia i buduje dokument; zwraca też profile wskazane przez rel="me". */
  async function loadDocument(
    hit: SearchHit,
    identifier: Identifier,
    identityMatch: IdentityMatch,
    context: ConnectorContext,
  ): Promise<{ document: SourceDocument; linkedHandles: string[] } | null> {
    const url = new URL(hit.url, `${base}/`).toString();
    const response = await httpGet(url, context);
    if (!response.ok) {
      context.log(`${spec.label}: nie udało się pobrać ${url} (kod ${response.status}).`);
      return null;
    }
    const content = extractContent(response.text);
    const text = htmlToText(content);
    const { service, category } = spec.classify(hit);

    // Wskazówki o innych kontach bierzemy tylko z dokumentów pewnie powiązanych
    // z podmiotem — konto imiennika nie może uruchomić dalszego wyszukiwania.
    const discovered: Identifier[] = [];
    const linkedHandles: string[] = [];
    // Odnośniki rel="me" to profile wskazane przez samego autora — część jego danych profilowych.
    const relMe = findRelMeLinks(content).map((href) => new URL(href, url).toString());
    const profile = buildProfile(hit, content, text, relMe);
    if (identityMatch !== 'name_only') {
      if (hit.matchedBy === 'email' && hit.author) discovered.push({ type: 'nick', value: hit.author });
      for (const email of findEmails(text)) {
        if (email !== identifier.value.toLowerCase()) discovered.push({ type: 'email', value: email });
      }
      for (const href of relMe) {
        const target = new URL(href);
        const handle = decodeURIComponent(target.pathname.split('/').filter(Boolean).at(-1) ?? '');
        if (!handle) continue;
        const sameService = target.origin === new URL(url).origin && target.pathname.startsWith(`/${spec.prefix}/`);
        if (sameService && spec.followLinkedProfiles) linkedHandles.push(handle);
        else discovered.push({ type: 'nick', value: handle });
      }
    }

    const document: SourceDocument = {
      connectorId: spec.id,
      service,
      url,
      title: hit.title,
      text,
      fetchedAt: new Date().toISOString(),
      category,
      identityMatch,
      matchedIdentifier: identifier,
      ...(hit.author ? { author: hit.author } : {}),
      ...(hit.archivedAt ? { archivedAt: hit.archivedAt } : hit.publishedAt ? { publishedAt: hit.publishedAt } : {}),
      ...(discovered.length > 0 ? { discoveredIdentifiers: dedupe(discovered) } : {}),
      ...(profile ? { profile } : {}),
    };
    return { document, linkedHandles };
  }

  /** Najnowsze publikacje serwisu — każda jako dokument swojego autora. */
  async function discover(context: ConnectorContext, limit: number): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    const wanted = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_DISCOVER));
    try {
      const response = await httpGet(`${base}/${spec.prefix}/api/recent?limit=${wanted}`, context);
      if (!response.ok) {
        context.log(`${spec.label}: lista najnowszych publikacji odpowiedziała kodem ${response.status}.`);
        return [];
      }
      for (const hit of (JSON.parse(response.text) as SearchHit[]).slice(0, wanted)) {
        if (!hit.author) continue;
        const author: Identifier = { type: 'nick', value: hit.author.replace(/^@/, '') };
        const loaded = await loadDocument(hit, author, 'exact_identifier', context);
        if (loaded) documents.push(loaded.document);
      }
    } catch (error) {
      context.log(`${spec.label}: błąd podczas pobierania najnowszych publikacji: ${errorMessage(error)}`);
    }
    context.log(`${spec.label}: najnowsze publikacje — dokumentów: ${documents.length}.`);
    return documents;
  }

  const connector: SourceConnector = {
    id: spec.id,
    service: spec.service,
    label: spec.label,
    description: spec.description,
    accepts: ALL_TYPES,
    enabledByDefault: true,

    async search(identifier, context) {
      const documents: SourceDocument[] = [];
      const seenUrls = new Set<string>();
      const linked = new Set<string>();
      try {
        for (const hit of await searchHits(identifier.value, context)) {
          const loaded = await loadDocument(hit, identifier, identityFor(hit, identifier), context);
          if (!loaded) continue;
          documents.push(loaded.document);
          seenUrls.add(loaded.document.url);
          for (const handle of loaded.linkedHandles) linked.add(handle);
        }

        // Jeden krok dalej: konta w tym samym serwisie, które potwierdzony profil
        // sam wskazał jako własne. Dalszych odnośników już nie śledzimy.
        for (const handle of [...linked].slice(0, MAX_LINKED_PROFILES)) {
          const hits = (await searchHits(handle, context)).filter((hit) => hit.matchedBy === 'handle');
          for (const hit of hits) {
            if (seenUrls.has(new URL(hit.url, `${base}/`).toString())) continue;
            const loaded = await loadDocument(hit, identifier, 'linked_profile', context);
            if (!loaded) continue;
            documents.push(loaded.document);
            seenUrls.add(loaded.document.url);
          }
          if (hits.length > 0) context.log(`${spec.label}: profil powiązany „${handle}" — dokumentów: ${hits.length}.`);
        }
      } catch (error) {
        context.log(`${spec.label}: błąd podczas wyszukiwania „${identifier.value}": ${errorMessage(error)}`);
      }
      context.log(`${spec.label}: „${identifier.value}" — dokumentów: ${documents.length}.`);
      return documents;
    },
  };
  if (!spec.recent) return connector;
  const discovering: DiscoveringConnector = { ...connector, discover };
  return discovering;
}

export function createSandboxConnectors(sandboxUrl: string): SourceConnector[] {
  const live = SERVICES.map((service) =>
    createConnector(
      {
        id: `sandbox-${service.prefix}`,
        service: `${service.prefix}.sandbox`,
        prefix: service.prefix,
        label: service.label,
        description: service.description,
        classify: (hit) => ({
          service: `${service.prefix}.sandbox`,
          category: service.categoryByKind[hit.kind ?? ''] ?? service.fallbackCategory,
        }),
        followLinkedProfiles: true,
        recent: service.recent === true,
      },
      sandboxUrl,
    ),
  );

  // Kopia archiwalna nie jest niezależnym źródłem: dokument dostaje `service`
  // oryginału, żeby ta sama strona „na żywo" i w archiwum nie dawały premii za synergię.
  const archive = createConnector(
    {
      id: 'sandbox-archiwum',
      service: 'archiwum.sandbox',
      prefix: 'archiwum',
      label: 'Archiwum Sieci (piaskownica)',
      description: 'Archiwalne kopie stron z datami zapisu — pozwalają wykryć podmianę adresu. Wyszukiwanie po autorze strony lub adresie.',
      classify: (hit) => {
        const original = SERVICES.find((service) => service.prefix === hit.originalService);
        return {
          service: original ? `${original.prefix}.sandbox` : 'archiwum.sandbox',
          category: original?.categoryByKind[hit.kind ?? ''] ?? original?.fallbackCategory ?? 'forum_post',
        };
      },
      followLinkedProfiles: false,
      recent: false,
    },
    sandboxUrl,
  );

  return [...live, archive];
}
