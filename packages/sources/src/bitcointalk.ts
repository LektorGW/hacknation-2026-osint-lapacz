// Łącznik Bitcointalk: publiczna strona profilu użytkownika forum
// (index.php?action=profile;u=<id>), dostępna bez logowania. Wyszukiwanie po
// nicku wymaga konta, dlatego łącznik przyjmuje wyłącznie adres profilu.

import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, htmlToText, innerByClass } from './html.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-bitcointalk';
const SERVICE = 'bitcointalk.org';
const LABEL = 'Bitcointalk';

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

export function createBitcointalkConnector(http: HttpClient): SourceConnector {
  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczna strona profilu forum Bitcointalk pod podanym adresem (index.php?action=profile;u=<numer>, bez logowania): ' +
      'nazwa użytkownika, pole „Bitcoin address", strona WWW i podpis pod postami. Wyszukiwanie po nicku wymaga konta, ' +
      'więc nie jest wykonywane. Jedno żądanie na identyfikator.',
    accepts: ['profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const userId = bitcointalkUserId(identifier);
      if (!userId) return [];
      const url = `https://bitcointalk.org/index.php?action=profile;u=${userId}`;
      const session = http.session(context, { label: LABEL, limit: 1 });
      const page = await session.get(url, { encoding: 'iso-8859-1', allowedContentTypes: ['text/html'] });
      if (!page) return [];
      const profile = parseBitcointalkProfile(page.text);
      if (!profile) {
        context.log(`${LABEL}: profil u=${userId} — brak danych profilu na stronie (profil nie istnieje lub jest ukryty).`);
        return [];
      }

      const text = [
        `Profil Bitcointalk: ${profile.fields.Name} (u=${userId})`,
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
        `${LABEL}: profil „${profile.fields.Name}" (u=${userId}) — pole „Bitcoin address": ${profile.fields['Bitcoin address'] ? 'jest' : 'brak'}.`,
      );
      return [document];
    },
  };
}
