// Łącznik Bitcointalk: publiczna strona profilu użytkownika forum, dostępna bez logowania —
// po numerze (index.php?action=profile;u=<id>) albo po nazwie użytkownika (action=profile;user=<nick>).
//
// Podstawa (sprawdzone 21.11.2026):
//   • https://bitcointalk.org/robots.txt zawiera wyłącznie wiersz „Sitemap: …" — żadnych zakazów dla robotów;
//   • zasada administratora forum (wpis theymos z 12.02.2015, przytoczony w wątku topic=5240891): „The rules are the same
//     as for humans. […] No one is allowed to access the site more often than once per second on average." —
//     łącznik wysyła jedno żądanie na identyfikator i zachowuje odstęp co najmniej 1,5 s między żądaniami;
//   • strona profilu po numerze i po nazwie odpowiada gościom kodem 200.
// Świadomie NIE są używane: lista i wyszukiwarka użytkowników (action=mlist — wymagają logowania),
// wyszukiwarka postów (action=search — brak jasnej zgody na użycie automatyczne, ciężkie zapytanie POST)
// ani kanał RSS (wyłączony przez forum).

import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, htmlToText, innerByClass } from './html.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-bitcointalk';
const SERVICE = 'bitcointalk.org';
const LABEL = 'Bitcointalk';
/** Zasada forum: najwyżej jedno żądanie na sekundę; zostawiamy zapas. */
const MIN_INTERVAL_MS = 1500;
/** Nazwy użytkowników forum: litery, cyfry, odstęp i kilka znaków przestankowych. */
const NICK = /^[\p{L}\p{N}][\p{L}\p{N} ._\-]{1,39}$/u;

/** Pola tabeli profilu, które trafiają do dokumentu. */
const FIELDS = ['Name', 'Position', 'Date Registered', 'Last Active', 'Website', 'Bitcoin address', 'Other contact info', 'Location', 'Email'];

export interface BitcointalkProfile {
  fields: Record<string, string>;
  signature: string;
  website?: string;
}

/** Numer użytkownika z adresu profilu; `null`, gdy adres nie wskazuje profilu Bitcointalk. */
export function bitcointalkUserId(identifier: Identifier): string | null {
  if (identifier.type !== 'profile_url') return null;
  const url = parseHttpUrl(identifier.value);
  if (!url || serviceOf(url) !== SERVICE) return null;
  return /[?;&]action=profile\b/.test(url.search) ? /[?;&]u=(\d{1,9})\b/.exec(url.search)?.[1] ?? null : null;
}

/** Rozbiera stronę profilu: wiersze tabeli „Etykieta: wartość" oraz podpis. */
export function parseBitcointalkProfile(html: string): BitcointalkProfile | null {
  const fields: Record<string, string> = {};
  let website: string | undefined;
  // Wiersz tabeli: <td><b>Etykieta: </b></td><td>wartość</td>.
  const row = /<td\b[^>]*>\s*<b>([^<:]{2,40}):\s*<\/b>\s*<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/gi;
  for (let match = row.exec(html); match; match = row.exec(html)) {
    const label = match[1]!.trim();
    const known = FIELDS.find((field) => field.toLowerCase() === label.toLowerCase());
    if (!known) continue;
    const value = htmlToText(match[2]!).replace(/\n/g, ' ').trim();
    if (value && !fields[known]) fields[known] = value;
    if (known === 'Website') website = findLinks(match[2]!)[0];
  }
  if (!fields.Name) return null;
  const signature = htmlToText(innerByClass(html, 'signature')?.inner ?? '');
  return { fields, signature, ...(website ? { website } : {}) };
}

/** `February 09, 2010, 12:49:38 AM` → ISO 8601 (forum podaje czas UTC). */
function registeredAt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value.replace(/,(?=\s*\d{1,2}:)/, '')} UTC`);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/** Nazwa użytkownika do wyszukania profilu; `null`, gdy identyfikator nie jest nickiem albo ma niedozwolone znaki. */
export function bitcointalkNick(identifier: Identifier): string | null {
  if (identifier.type !== 'nick' && identifier.type !== 'login') return null;
  const nick = identifier.value.trim().replace(/^@/, '');
  return NICK.test(nick) ? nick : null;
}

export function createBitcointalkConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczna strona profilu forum Bitcointalk (bez logowania): po adresie profilu (index.php?action=profile;u=<numer>) ' +
      'albo po nicku (index.php?action=profile;user=<nick>). Pobierane: nazwa użytkownika, pole „Bitcoin address", strona WWW ' +
      'i podpis pod postami. robots.txt forum niczego nie zakazuje; zasada forum to najwyżej 1 żądanie na sekundę — łącznik ' +
      'wysyła jedno żądanie na identyfikator z odstępem co najmniej 1,5 s. Lista użytkowników i wyszukiwarka postów nie są używane.',
    accepts: ['profile_url', 'nick', 'login'],
    enabledByDefault: true,

    async search(identifier, context) {
      const byId = bitcointalkUserId(identifier);
      const nick = byId ? null : bitcointalkNick(identifier);
      if (!byId && !nick) return [];
      const requestUrl = byId
        ? `https://bitcointalk.org/index.php?action=profile;u=${byId}`
        : `https://bitcointalk.org/index.php?action=profile;user=${encodeURIComponent(nick!)}`;
      const session = http.session(context, { label: LABEL, limit: 1 });
      const page = await session.get(requestUrl, { encoding: 'iso-8859-1', allowedContentTypes: ['text/html'], minIntervalMs: MIN_INTERVAL_MS });
      if (!page) return [];
      const profile = parseBitcointalkProfile(page.text);
      if (!profile) {
        context.log(`${LABEL}: profil ${byId ? `u=${byId}` : `„${nick}"`} — brak danych profilu na stronie (profil nie istnieje lub jest ukryty).`);
        return [];
      }
      // Wyszukanie po nicku przyjmujemy tylko wtedy, gdy strona pokazuje dokładnie tę nazwę użytkownika.
      if (nick && profile.fields.Name!.trim().toLowerCase() !== nick.toLowerCase()) {
        context.log(`${LABEL}: strona zwrócona dla „${nick}" dotyczy użytkownika „${profile.fields.Name}" — pominięto.`);
        return [];
      }
      // Numer użytkownika z odnośników na stronie daje trwały adres profilu (nick można zmienić).
      const userId = byId ?? /action=profile;u=(\d{1,9})(?!\d)/.exec(page.text)?.[1] ?? null;
      const url = userId ? `https://bitcointalk.org/index.php?action=profile;u=${userId}` : requestUrl;

      const text = [
        `Profil Bitcointalk: ${profile.fields.Name}${userId ? ` (u=${userId})` : ''}`,
        ...FIELDS.filter((field) => field !== 'Name' && profile.fields[field]).map((field) => `${field}: ${profile.fields[field]}`),
        profile.signature && `Podpis pod postami:\n${profile.signature}`,
      ]
        .filter(Boolean)
        .join('\n');

      const discovered: Identifier[] = [];
      const website = profile.website ? profileUrlIdentifier(profile.website) : null;
      if (website) discovered.push(website);
      for (const email of findEmails(profile.fields['Other contact info'] ?? '')) discovered.push({ type: 'email', value: email });

      const document: SourceDocument = {
        connectorId: ID,
        service: SERVICE,
        url,
        title: `Profil Bitcointalk: ${profile.fields.Name}`,
        text,
        fetchedAt: new Date().toISOString(),
        author: profile.fields.Name!,
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: {
          handle: profile.fields.Name!,
          ...(profile.website && /^https?:\/\//i.test(profile.website) ? { urls: [profile.website] } : {}),
          ...(findEmails(profile.fields['Other contact info'] ?? '').length > 0 ? { emails: findEmails(profile.fields['Other contact info'] ?? '') } : {}),
          ...(profile.fields.Location ? { location: profile.fields.Location } : {}),
          ...(profile.signature ? { bio: profile.signature } : {}),
          ...(registeredAt(profile.fields['Date Registered']) ? { createdAt: registeredAt(profile.fields['Date Registered'])! } : {}),
        },
        // Forum nie podaje daty zmiany profilu („Last Active" to czas logowania), więc bez publishedAt.
        ...discoveredField(dedupeIdentifiers(discovered, identifier, [SERVICE])),
      };
      context.log(
        `${LABEL}: profil „${profile.fields.Name}"${userId ? ` (u=${userId})` : ''} — pole „Bitcoin address": ${profile.fields['Bitcoin address'] ? 'jest' : 'brak'}.`,
      );
      return [document];
    },
  };
}
