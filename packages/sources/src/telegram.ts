// Łącznik Telegram: wyłącznie publiczny podgląd kanału w przeglądarce
// (t.me/s/<nazwa>), dostępny bez logowania. Prywatnych czatów, grup i kont
// bez publicznego podglądu łącznik nie czyta — zwraca wtedy pusty wynik.

import { readFileSync } from 'node:fs';
import { extractAddresses } from '@olcys/core';
import type { ConnectorContext, DiscoveringConnector, Identifier, ProfileAttributes, SourceDocument } from '@olcys/core';
import { findEmails, findLinks, htmlToText, innerByClass } from './html.ts';
import { errorMessage } from './http.ts';
import type { HttpClient } from './http.ts';
import { dedupeIdentifiers, discoveredField, handleFromIdentifier, parseHttpUrl, profileUrlIdentifier, serviceOf } from './identity.ts';

const ID = 'live-telegram';
const SERVICE = 't.me';
const LABEL = 'Telegram (kanały publiczne)';
const HOSTS = ['t.me', 'telegram.me'];
const CONFIG_URL = new URL('../config/telegram-channels.json', import.meta.url);
/** Nazwy publiczne Telegrama: 4–32 znaki, litery, cyfry i podkreślenie, zaczynają się literą. */
const USERNAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
const MAX_MESSAGE_DOCUMENTS = 10;
/** Ile kanałów z listy przegląda jedno wywołanie `discover` (po jednym żądaniu na kanał). */
const MAX_DISCOVER_CHANNELS = 10;

export interface TelegramMessage {
  id: string;
  text: string;
  publishedAt?: string;
}

export interface TelegramChannel {
  title: string;
  description: string;
  descriptionHtml: string;
  messages: TelegramMessage[];
}

/** Rozbiera stronę podglądu kanału; `null`, gdy to nie jest kanał z publicznym podglądem. */
export function parseTelegramPreview(html: string): TelegramChannel | null {
  const info = innerByClass(html, 'tgme_channel_info');
  const firstMessage = html.indexOf('tgme_widget_message_wrap');
  if (!info && firstMessage < 0) return null;

  const title = htmlToText(innerByClass(html, 'tgme_channel_info_header_title')?.inner ?? '').replace(/\n/g, ' ');
  const descriptionHtml = innerByClass(html, 'tgme_channel_info_description')?.inner ?? '';

  const messages: TelegramMessage[] = [];
  const marker = /data-post="([^"\/]+)\/(\d+)"/g;
  const starts: { id: string; at: number }[] = [];
  for (let match = marker.exec(html); match; match = marker.exec(html)) starts.push({ id: match[2]!, at: match.index });
  starts.forEach((start, index) => {
    const chunk = html.slice(start.at, starts[index + 1]?.at ?? html.length);
    const body = innerByClass(chunk, 'tgme_widget_message_text');
    const text = body ? htmlToText(body.inner) : '';
    if (!text) return;
    const time = /<time\b[^>]*\bdatetime="([^"]+)"/.exec(chunk)?.[1];
    const parsed = time ? Date.parse(time) : NaN;
    messages.push({ id: start.id, text, ...(Number.isNaN(parsed) ? {} : { publishedAt: new Date(parsed).toISOString() }) });
  });

  return { title, description: htmlToText(descriptionHtml), descriptionHtml, messages };
}

/** Lista publicznych kanałów przeglądanych przez `discover`; zwraca też powód, jeśli pliku nie da się użyć. */
export function loadTelegramChannels(configUrl: URL = CONFIG_URL): { channels: string[]; problem?: string } {
  try {
    const parsed = JSON.parse(readFileSync(configUrl, 'utf8')) as { channels?: unknown[] };
    return { channels: cleanChannels(parsed.channels ?? []) };
  } catch (error) {
    return { channels: [], problem: errorMessage(error) };
  }
}

function cleanChannels(values: unknown[]): string[] {
  const names = values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?/i, '').replace(/^@/, ''))
    .filter((item) => USERNAME.test(item));
  return [...new Set(names)];
}

function channelName(identifier: Identifier): string | null {
  if (identifier.type === 'profile_url') {
    const url = parseHttpUrl(identifier.value);
    if (!url || !HOSTS.includes(serviceOf(url))) return null;
    // Zarówno t.me/<nazwa>, jak i t.me/s/<nazwa>.
    const parts = url.pathname.split('/').filter(Boolean);
    const name = parts[0] === 's' ? parts[1] : parts[0];
    return name && USERNAME.test(name) ? name : null;
  }
  // Komunikator bywa podawany jako „@nazwa" albo „t.me/nazwa".
  const value = identifier.value.trim().replace(/^(?:https?:\/\/)?(?:t|telegram)\.me\/(?:s\/)?/i, '');
  const name = handleFromIdentifier({ type: identifier.type, value }, HOSTS);
  return name && USERNAME.test(name) ? name : null;
}

export interface TelegramConfig {
  /** Nadpisuje listę z config/telegram-channels.json. */
  channels?: string[];
}

export function createTelegramConnector(http: HttpClient, config: TelegramConfig = {}): DiscoveringConnector {
  const loaded = config.channels ? { channels: cleanChannels(config.channels) } : loadTelegramChannels();
  const channels = loaded.channels.slice(0, MAX_DISCOVER_CHANNELS);

  /** Jedno żądanie: strona podglądu kanału. */
  async function fetchChannel(name: string, context: ConnectorContext): Promise<TelegramChannel | null> {
    const session = http.session(context, { label: LABEL, limit: 1 });
    const response = await session.get(`https://t.me/s/${name}`, { allowedContentTypes: ['text/html'], quietMissing: true });
    const channel = response ? parseTelegramPreview(response.text) : null;
    if (!channel && !session.refused) context.log(`${LABEL}: „${name}" — brak kanału z publicznym podglądem.`);
    return channel;
  }

  /** Odnośniki z opisu kanału — bez odsyłaczy do samego Telegrama (inne kanały, boty). */
  function describedLinks(channel: TelegramChannel): Identifier[] {
    const found: Identifier[] = [];
    for (const href of findLinks(channel.descriptionHtml)) {
      const link = profileUrlIdentifier(href);
      if (link && !HOSTS.includes(serviceOf(new URL(link.value)))) found.push(link);
    }
    return found;
  }

  function profileOf(name: string, channel: TelegramChannel): ProfileAttributes {
    const urls = describedLinks(channel).map((item) => item.value);
    const emails = findEmails(channel.description);
    return {
      handle: name,
      ...(channel.title ? { displayName: channel.title } : {}),
      ...(emails.length > 0 ? { emails } : {}),
      ...(urls.length > 0 ? { urls } : {}),
      ...(channel.description ? { bio: channel.description } : {}),
    };
  }

  /** Wiadomości z adresem kryptowalutowym, od najnowszych. */
  function messageDocuments(name: string, channel: TelegramChannel, identifier: Identifier, limit: number): SourceDocument[] {
    const profile = profileOf(name, channel);
    return channel.messages
      .filter((message) => extractAddresses(message.text).length > 0)
      .reverse()
      .slice(0, limit)
      .map((message) => ({
        connectorId: ID,
        service: SERVICE,
        url: `https://t.me/${name}/${message.id}`,
        title: `Kanał Telegram ${name}: wiadomość ${message.id}`,
        text: message.text,
        fetchedAt: new Date().toISOString(),
        author: name,
        category: 'settlement_message' as const,
        identityMatch: 'exact_identifier' as const,
        matchedIdentifier: identifier,
        profile,
        ...(message.publishedAt ? { publishedAt: message.publishedAt } : {}),
      }));
  }

  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Publiczny podgląd kanału Telegram w przeglądarce (t.me/s/<nazwa>, bez logowania): opis kanału oraz ostatnie wiadomości ' +
      'widoczne na stronie podglądu (około 20). Dokumentem staje się opis kanału i każda wiadomość zawierająca adres kryptowalutowy. ' +
      'Konta, grupy i kanały bez publicznego podglądu nie są czytane. Jedno żądanie na identyfikator. ' +
      `Typowanie: ostatnie wiadomości z adresami z kanałów wymienionych w config/telegram-channels.json (pozycji: ${channels.length}).`,
    accepts: ['messenger_id', 'nick', 'profile_url'],
    enabledByDefault: true,

    async search(identifier, context) {
      const name = channelName(identifier);
      if (!name) return [];
      const channel = await fetchChannel(name, context);
      if (!channel) return [];

      const discovered = [...describedLinks(channel)];
      for (const email of findEmails(channel.description)) discovered.push({ type: 'email', value: email });

      const messages = messageDocuments(name, channel, identifier, MAX_MESSAGE_DOCUMENTS);
      const documents: SourceDocument[] = [
        {
          connectorId: ID,
          service: SERVICE,
          url: `https://t.me/s/${name}`,
          title: `Kanał Telegram ${name}: opis`,
          text: [`Kanał Telegram: ${name}`, channel.title && `Nazwa: ${channel.title}`, `Opis: ${channel.description || 'brak'}`]
            .filter(Boolean)
            .join('\n'),
          fetchedAt: new Date().toISOString(),
          author: name,
          category: 'own_profile',
          identityMatch: 'exact_identifier',
          matchedIdentifier: identifier,
          profile: profileOf(name, channel),
          ...discoveredField(dedupeIdentifiers(discovered, identifier)),
        },
        ...messages,
      ];

      context.log(
        `${LABEL}: „${name}" — wiadomości na stronie podglądu: ${channel.messages.length}, z adresem: ${messages.length}.`,
      );
      return documents;
    },

    async discover(context, limit) {
      if ('problem' in loaded && loaded.problem) context.log(`${LABEL}: nie można odczytać listy kanałów: ${loaded.problem}`);
      if (channels.length === 0) {
        context.log(`${LABEL}: lista kanałów do typowania (config/telegram-channels.json) jest pusta.`);
        return [];
      }
      const wanted = Math.max(1, Math.floor(limit) || 1);
      const documents: SourceDocument[] = [];
      for (const name of channels) {
        const channel = await fetchChannel(name, context);
        if (channel) documents.push(...messageDocuments(name, channel, { type: 'nick', value: name }, MAX_MESSAGE_DOCUMENTS));
      }
      // Najświeższe wiadomości ze wszystkich kanałów razem.
      documents.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
      context.log(`${LABEL}: typowanie — kanałów: ${channels.length}, wiadomości z adresem: ${documents.length}.`);
      return documents.slice(0, wanted);
    },
  };
}
