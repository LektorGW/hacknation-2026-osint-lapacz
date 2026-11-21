// Łącznik keys.openpgp.org: publiczny serwer kluczy OpenPGP (API „VKS").
// Adres e-mail → klucz publiczny, o ile WŁAŚCICIEL adresu sam potwierdził jego publikację (opt-in);
// z klucza odczytujemy odcisk, datę utworzenia i pozostałe potwierdzone adresy e-mail tej samej osoby.
//
// Podstawa (sprawdzone 21.11.2026):
//   • https://keys.openpgp.org/about/api — „GET /vks/v1/by-email/<URI-ENCODED EMAIL-ADDRESS> Retrieves the key with the
//     given Email Address. Only exact matches are accepted. Lookup by email address requires opt-in by the owner of the
//     email address." oraz „Requests by email address are limited to one request per minute. […] There is a burst window of 50.";
//   • https://keys.openpgp.org/about/usage — „We offer an API for integrated support in OpenPGP applications.";
//   • https://keys.openpgp.org/about/privacy — „Addresses are searchable by exact email address, but not by associated name.
//     Enumeration of addresses is not possible."; serwis nie ma pliku robots.txt (404).
// Łącznik pyta wyłącznie o dokładny adres podany w analizie (żadnego wyliczania adresów), jedno żądanie na identyfikator,
// odstęp co najmniej 5 s i najwyżej 30 zapytań na godzinę (średnio poniżej limitu 1/min, w granicach okna 50).

import { createHash } from 'node:crypto';
import type { Identifier, SourceConnector, SourceDocument } from '@olcys/core';
import { findEmails } from './html.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField } from './identity.ts';

const ID = 'live-openpgp';
const SERVICE = 'keys.openpgp.org';
const LABEL = 'Serwer kluczy OpenPGP (keys.openpgp.org)';
const MIN_INTERVAL_MS = 5000;
export const OPENPGP_HOURLY_LIMIT = 30;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

export interface OpenPgpKeyInfo {
  /** Odcisk klucza głównego (wielkie litery, szesnastkowo); tylko dla kluczy w wersji 4. */
  fingerprint?: string;
  /** Data utworzenia klucza głównego (ISO 8601). */
  createdAt?: string;
  /** Identyfikatory użytkownika zapisane w kluczu („Imię Nazwisko <adres>"). */
  userIds: string[];
}

/** Odczytuje z klucza w osłonie ASCII pakiet klucza głównego i identyfikatory użytkownika; `null`, gdy to nie klucz. */
export function parseArmoredKey(armored: string): OpenPgpKeyInfo | null {
  const match = /-----BEGIN PGP PUBLIC KEY BLOCK-----([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/.exec(armored);
  if (!match) return null;
  const lines = match[1]!.split(/\r?\n/).map((line) => line.trim());
  // Nagłówki osłony kończy pusty wiersz; suma kontrolna to wiersz zaczynający się od „=".
  const firstBlank = lines.findIndex((line, i) => i > 0 && line === '');
  const hasHeaders = lines.some((line) => /^[A-Za-z-]+: /.test(line));
  const body = lines
    .slice(hasHeaders && firstBlank >= 0 ? firstBlank : 0)
    .filter((line) => line && !line.startsWith('=') && /^[A-Za-z0-9+/=]+$/.test(line))
    .join('');
  const bytes = Buffer.from(body, 'base64');
  const info: OpenPgpKeyInfo = { userIds: [] };
  let offset = 0;
  let packets = 0;
  while (offset < bytes.length && packets++ < 500) {
    const header = bytes[offset++]!;
    if ((header & 0x80) === 0) break;
    let tag: number;
    let length: number;
    if (header & 0x40) {
      // Nowy format pakietu.
      tag = header & 0x3f;
      const first = bytes[offset++]!;
      if (first < 192) length = first;
      else if (first < 224) length = ((first - 192) << 8) + bytes[offset++]! + 192;
      else if (first === 255) {
        length = bytes.readUInt32BE(offset);
        offset += 4;
      } else break; // Długości częściowe nie występują w pakietach, których szukamy.
    } else {
      tag = (header >> 2) & 0x0f;
      const kind = header & 0x03;
      if (kind === 0) length = bytes[offset++]!;
      else if (kind === 1) {
        length = bytes.readUInt16BE(offset);
        offset += 2;
      } else if (kind === 2) {
        length = bytes.readUInt32BE(offset);
        offset += 4;
      } else break;
    }
    if (length === undefined || offset + length > bytes.length) break;
    const packet = bytes.subarray(offset, offset + length);
    offset += length;
    if (tag === 6 && !info.fingerprint && packet[0] === 4 && packet.length > 5) {
      const prefix = Buffer.from([0x99, (packet.length >> 8) & 0xff, packet.length & 0xff]);
      info.fingerprint = createHash('sha1').update(prefix).update(packet).digest('hex').toUpperCase();
      info.createdAt = new Date(packet.readUInt32BE(1) * 1000).toISOString();
    }
    if (tag === 13 && info.userIds.length < 20) info.userIds.push(packet.toString('utf8').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200));
  }
  return info.fingerprint || info.userIds.length > 0 ? info : null;
}

export function createOpenPgpConnector(http: HttpClient): SourceConnector {
  /** Czasy ostatnich zapytań — okno godzinne. */
  let recent: number[] = [];

  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczny serwer kluczy keys.openpgp.org (udokumentowane API: /vks/v1/by-email/<adres>; wyszukiwanie tylko po dokładnym adresie, ' +
      'który właściciel sam potwierdził do publikacji). Wynik: odcisk klucza, data utworzenia i pozostałe potwierdzone adresy e-mail ' +
      `z tego samego klucza — wskazują inne skrzynki tej samej osoby. Jedno żądanie na adres, odstęp 5 s, najwyżej ${OPENPGP_HOURLY_LIMIT} zapytań na godzinę ` +
      '(limit serwisu: średnio 1 zapytanie o e-mail na minutę).',
    accepts: ['email'],
    enabledByDefault: true,

    async search(identifier, context) {
      const email = identifier.value.trim().toLowerCase();
      if (identifier.type !== 'email' || !EMAIL.test(email)) return [];
      const now = Date.now();
      recent = recent.filter((time) => now - time < 3_600_000);
      if (recent.length >= OPENPGP_HOURLY_LIMIT) {
        context.log(`${LABEL}: wyczerpano godzinny limit ${OPENPGP_HOURLY_LIMIT} zapytań łącznika — pomijam „${email}".`);
        return [];
      }
      recent.push(now);
      const url = `https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`;
      const session = http.session(context, { label: LABEL, limit: 1 });
      const response = await session.get(url, { quietMissing: true, minIntervalMs: MIN_INTERVAL_MS, maxBytes: 262_144 });
      if (!response) {
        if (session.lastStatus === 404) context.log(`${LABEL}: „${email}" — brak opublikowanego klucza.`);
        return [];
      }
      const key = parseArmoredKey(response.text);
      if (!key) {
        context.log(`${LABEL}: „${email}" — odpowiedź nie zawiera klucza publicznego.`);
        return [];
      }
      const emails = [...new Set(key.userIds.flatMap((userId) => findEmails(userId)))];
      const names = [...new Set(key.userIds.map((userId) => userId.replace(/<[^>]*>/g, '').replace(/\([^)]*\)/g, '').trim()).filter((name) => name && !name.includes('@')))];
      const others = emails.filter((item) => item !== email);
      const document: SourceDocument = {
        connectorId: ID,
        service: SERVICE,
        url: key.fingerprint ? `https://keys.openpgp.org/vks/v1/by-fingerprint/${key.fingerprint}` : url,
        title: `Klucz OpenPGP: ${email}`,
        text: [
          `Klucz publiczny OpenPGP opublikowany dla adresu ${email} (keys.openpgp.org)`,
          key.fingerprint && `Odcisk klucza: ${key.fingerprint}`,
          key.createdAt && `Klucz utworzony: ${key.createdAt.slice(0, 10)}`,
          key.userIds.length > 0 ? `Identyfikatory w kluczu (adresy potwierdzone przez właściciela w serwisie kluczy):\n${key.userIds.map((userId) => `- ${userId}`).join('\n')}` : 'Klucz nie zawiera identyfikatorów użytkownika.',
          others.length > 0 && `Inne adresy e-mail w tym samym kluczu: ${others.join(', ')}`,
        ]
          .filter(Boolean)
          .join('\n'),
        fetchedAt: new Date().toISOString(),
        author: email,
        category: 'own_profile',
        identityMatch: 'exact_identifier',
        matchedIdentifier: identifier,
        profile: {
          handle: email,
          ...(names[0] ? { displayName: names[0] } : {}),
          emails: emails.length > 0 ? emails : [email],
          ...(key.createdAt ? { createdAt: key.createdAt } : {}),
        },
        ...(key.createdAt ? { publishedAt: key.createdAt } : {}),
        ...discoveredField(dedupeIdentifiers(others.map((value): Identifier => ({ type: 'email', value })), identifier)),
      };
      context.log(`${LABEL}: „${email}" — klucz ${key.fingerprint ?? 'bez odcisku v4'}, innych adresów w kluczu: ${others.length}.`);
      return [document];
    },
  };
}
