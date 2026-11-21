// Łącznik ENS (Ethereum Name Service) przez publiczne API ensdata.net
// (zapasowo ensideas.com). Rekord ENS jest zapisem w blockchainie dokonanym
// przez właściciela nazwy: wiąże nazwę z adresem oraz — w rekordach tekstowych —
// z profilami w innych serwisach.

import type { Identifier, IdentityMatch, SourceCategory, SourceConnector, SourceDocument } from '@olcys/core';
import { parseJson } from './http.ts';
import type { HttpClient, HttpSession } from './http.ts';
import { cleanHandle, dedupeIdentifiers, discoveredField, parseHttpUrl, profileUrlIdentifier, sameHandle } from './identity.ts';

const ID = 'live-ens';
const SERVICE = 'ens.domains';
const LABEL = 'ENS';
const PRIMARY = 'https://api.ensdata.net';
const FALLBACK = 'https://api.ensideas.com/ens/resolve';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ENS_NAME = /^(?:[a-z0-9_-]+\.)+[a-z]{2,}$/;
const ENS_LABEL = /^[a-z0-9_-]{3,40}$/;

/** Rekordy tekstowe, które pokazujemy i porównujemy z identyfikatorem. */
const TEXT_KEYS = ['name', 'github', 'twitter', 'telegram', 'reddit', 'keybase', 'discord', 'email', 'url', 'description', 'location', 'farcaster', 'lens'];
const KEY_ALIASES: Record<string, string> = {
  'com.github': 'github',
  'com.twitter': 'twitter',
  'com.x': 'twitter',
  'org.telegram': 'telegram',
  'com.reddit': 'reddit',
  'io.keybase': 'keybase',
  'com.discord': 'discord',
};

export interface EnsRecord {
  name?: string;
  address?: string;
  texts: Record<string, string>;
  /** Adresy w innych sieciach zapisane w rekordzie (np. BTC). */
  wallets: Record<string, string>;
  avatar?: string;
}

/** Ujednolica odpowiedzi ensdata.net i ensideas.com. */
export function parseEnsResponse(json: unknown): EnsRecord | null {
  if (!json || typeof json !== 'object') return null;
  const data = json as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const record: EnsRecord = { texts: {}, wallets: {} };
  record.address = text(data.address);
  const avatar = text(data.avatar_url) ?? text(data.avatar);
  if (avatar && /^https?:\/\//i.test(avatar)) record.avatar = avatar;
  record.name = text(data.ens_primary) ?? text(data.ens) ?? text(data.name);
  if (record.address && !EVM_ADDRESS.test(record.address)) record.address = undefined;

  const addText = (rawKey: string, value: unknown) => {
    const key = KEY_ALIASES[rawKey] ?? rawKey;
    const cleaned = text(value);
    if (cleaned && TEXT_KEYS.includes(key) && !record.texts[key]) record.texts[key] = cleaned;
  };
  for (const [key, value] of Object.entries(data)) {
    // Na najwyższym poziomie `name` bywa nazwą ENS (ensideas), a nie rekordem tekstowym z imieniem.
    if (key === 'name' && (typeof value !== 'string' || ENS_NAME.test(value.trim().toLowerCase()))) continue;
    addText(key, value);
  }
  for (const nested of [data.records, data.texts, data.text]) {
    if (nested && typeof nested === 'object') for (const [key, value] of Object.entries(nested)) addText(key, value);
  }

  if (data.wallets && typeof data.wallets === 'object') {
    for (const [coin, value] of Object.entries(data.wallets as Record<string, unknown>)) {
      const address = text(value) ?? text((value as { address?: unknown } | null)?.address);
      if (address) record.wallets[coin] = address;
    }
  }
  return record.address || record.name ? record : null;
}

/** Nazwa konta z wartości rekordu: sam nick albo ostatni człon adresu profilu. */
function handleOf(value: string): string {
  const url = /^https?:\/\//i.test(value) ? parseHttpUrl(value) : null;
  const last = url ? url.pathname.split('/').filter(Boolean).at(-1) ?? '' : value;
  return cleanHandle(last);
}

/** Czy rekordy tekstowe wskazują ten sam nick lub e-mail co identyfikator podany przez analityka. */
export function recordsPointTo(record: EnsRecord, identifier: Identifier): string | null {
  const wanted = cleanHandle(identifier.value);
  if (identifier.type === 'email') {
    return record.texts.email && sameHandle(record.texts.email, wanted) ? 'email' : null;
  }
  for (const key of ['github', 'twitter', 'telegram', 'reddit', 'keybase']) {
    const value = record.texts[key];
    if (value && sameHandle(handleOf(value), wanted)) return key;
  }
  const url = record.texts.url ? parseHttpUrl(record.texts.url) : null;
  if (url) {
    const tail = url.pathname.split('/').filter(Boolean).at(-1);
    if (tail && sameHandle(tail, wanted)) return 'url';
  }
  return null;
}

function discoveredFrom(record: EnsRecord): Identifier[] {
  const found: Identifier[] = [];
  const texts = record.texts;
  if (texts.github) found.push({ type: 'login', value: handleOf(texts.github) });
  for (const key of ['twitter', 'reddit', 'keybase']) if (texts[key]) found.push({ type: 'nick', value: handleOf(texts[key]!) });
  if (texts.telegram) found.push({ type: 'messenger_id', value: handleOf(texts.telegram) });
  if (texts.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texts.email)) found.push({ type: 'email', value: texts.email.toLowerCase() });
  const url = texts.url ? profileUrlIdentifier(/^https?:\/\//i.test(texts.url) ? texts.url : `https://${texts.url}`) : null;
  if (url) found.push(url);
  return found;
}

/** Strony i profile wskazane w rekordach tekstowych — jako pełne adresy. */
function profileUrls(record: EnsRecord): string[] {
  const texts = record.texts;
  const urls: string[] = [];
  if (texts.url) urls.push(/^https?:\/\//i.test(texts.url) ? texts.url : `https://${texts.url}`);
  if (texts.github) urls.push(`https://github.com/${handleOf(texts.github)}`);
  if (texts.twitter) urls.push(`https://x.com/${handleOf(texts.twitter)}`);
  if (texts.telegram) urls.push(`https://t.me/${handleOf(texts.telegram)}`);
  if (texts.keybase) urls.push(`https://keybase.io/${handleOf(texts.keybase)}`);
  return urls;
}

function describe(record: EnsRecord, heading: string): string {
  const texts = Object.entries(record.texts).map(([key, value]) => `- ${key}: ${value}`);
  const wallets = Object.entries(record.wallets).map(([coin, address]) => `- ${coin}: ${address}`);
  return [
    heading,
    `Nazwa ENS: ${record.name ?? 'brak'}`,
    `Adres (ETH): ${record.address ?? 'brak'}`,
    wallets.length > 0 && `Adresy w innych sieciach zapisane w rekordzie:\n${wallets.join('\n')}`,
    texts.length > 0 ? `Rekordy tekstowe ustawione przez właściciela nazwy:\n${texts.join('\n')}` : 'Rekordy tekstowe: brak',
  ]
    .filter(Boolean)
    .join('\n');
}

export function createEnsConnector(http: HttpClient): SourceConnector {
  /** Najpierw ensdata.net; ensideas.com tylko wtedy, gdy pierwsze źródło zawiodło (nie przy „brak nazwy"). */
  async function resolve(target: string, session: HttpSession): Promise<EnsRecord | null> {
    const headers = { Accept: 'application/json' };
    const primary = await session.get(`${PRIMARY}/${encodeURIComponent(target)}`, { headers, quietMissing: true });
    if (primary) return parseEnsResponse(parseJson(primary.text));
    if (session.lastStatus === 404 || session.lastStatus === 400) return null;
    const fallback = await session.get(`${FALLBACK}/${encodeURIComponent(target)}`, { headers, quietMissing: true });
    return fallback ? parseEnsResponse(parseJson(fallback.text)) : null;
  }

  return {
    id: ID,
    service: SERVICE,
    label: LABEL,
    description:
      'Ethereum Name Service przez publiczne API api.ensdata.net (zapasowo api.ensideas.com): nazwa ENS → adres i rekordy tekstowe ' +
      '(github, twitter, url, e-mail); nick lub login → próba nazwy <nick>.eth (słabe dopasowanie, chyba że rekordy tekstowe ' +
      'wskazują ten sam nick lub e-mail); adres EVM → nazwa główna (rozwiązanie odwrotne) przyjmowana tylko wtedy, gdy nazwa wskazuje z powrotem ' +
      'ten sam adres. Najwyżej 2 żądania na identyfikator (4 dla adresu: w obie strony).',
    accepts: ['ens_name', 'nick', 'login', 'crypto_address'],
    enabledByDefault: true,

    async search(identifier, context) {
      const raw = cleanHandle(identifier.value).toLowerCase();
      let target: string;
      let guessed = false;
      if (identifier.type === 'crypto_address') {
        if (!EVM_ADDRESS.test(identifier.value.trim())) return [];
        target = identifier.value.trim();
      } else if (identifier.type === 'ens_name') {
        target = raw.includes('.') ? raw : `${raw}.eth`;
        if (!ENS_NAME.test(target)) return [];
      } else if (raw.endsWith('.eth') && ENS_NAME.test(raw)) {
        target = raw;
      } else {
        if (!ENS_LABEL.test(raw)) return [];
        target = `${raw}.eth`;
        guessed = true;
      }

      // Adres: rozwiązanie odwrotne i sprawdzenie w przód (po 2 żądania: ensdata + zapas ensideas).
      const session = http.session(context, { label: LABEL, limit: identifier.type === 'crypto_address' ? 4 : 2 });
      let record = await resolve(target, session);
      if (!record || !record.address) {
        if (!session.refused) context.log(`${LABEL}: „${target}" — brak rekordu.`);
        return [];
      }
      if (identifier.type === 'crypto_address' && record.name) {
        // Nazwa główna (rekord odwrotny) dowodzi czegokolwiek tylko wtedy, gdy nazwa wskazuje z powrotem ten sam adres:
        // rekord odwrotny ustawia właściciel adresu, ale wpisać w nim można dowolną nazwę.
        const forward = await resolve(record.name, session);
        if (!forward?.address || forward.address.toLowerCase() !== target.toLowerCase()) {
          context.log(
            `${LABEL}: adres ${target} ma nazwę główną ${record.name}, ale ` +
              (forward?.address ? `nazwa wskazuje inny adres (${forward.address})` : 'nie udało się sprawdzić, czy nazwa wskazuje ten adres') +
              ' — nazwy nie przyjęto.',
          );
          return [];
        }
        record = { ...forward, name: record.name, address: forward.address };
      }

      let category: SourceCategory = 'cryptographic_proof';
      let identityMatch: IdentityMatch = 'exact_identifier';
      let heading: string;
      let withDiscovered = true;

      if (identifier.type === 'crypto_address') {
        if (!record.name) {
          context.log(`${LABEL}: adres ${target} nie ma nazwy głównej ENS.`);
          return [];
        }
        // Dokument opisuje adres, nie podmiot — o powiązaniu z podmiotem decyduje analiza (autor = nazwa ENS).
        identityMatch = 'name_only';
        heading =
          'Rozwiązanie odwrotne ENS: właściciel adresu ustawił dla niego nazwę główną, a nazwa wskazuje z powrotem ten sam adres ' +
          '(sprawdzenie w obie strony — zapis w blockchainie dokonany kluczem adresu).';
      } else if (guessed) {
        record.name = target;
        const confirmedBy = recordsPointTo(record, identifier);
        if (confirmedBy) {
          // Właściciel nazwy sam zapisał w blockchainie wskazanie na identyfikator podmiotu.
          identityMatch = 'verified_link';
          heading = `Nazwa ${target} odgadnięta z identyfikatora „${identifier.value}" i potwierdzona rekordem tekstowym „${confirmedBy}" zapisanym w blockchainie przez właściciela nazwy.`;
        } else {
          category = 'own_profile';
          identityMatch = 'name_only';
          withDiscovered = false;
          heading = `UWAGA: nazwa ${target} została odgadnięta z nicka „${identifier.value}". Zgadza się tylko nazwa — rekordy tekstowe nie wskazują tego nicka, właścicielem może być inna osoba.`;
        }
      } else {
        record.name = target;
        heading = 'Rekord ENS: zapis w blockchainie dokonany przez właściciela nazwy.';
      }

      const name = record.name!;
      const discovered: Identifier[] = [];
      if (withDiscovered) {
        if (identifier.type !== 'ens_name') discovered.push({ type: 'ens_name', value: name });
        discovered.push(...discoveredFrom(record));
      }
      const document: SourceDocument = {
        connectorId: ID,
        service: SERVICE,
        // Ten sam adres dla obu kierunków rozwiązania — jeden ślad, nie dwa.
        url: `https://app.ens.domains/${name}`,
        title: `ENS: ${name}`,
        text: describe(record, heading),
        fetchedAt: new Date().toISOString(),
        author: name,
        category,
        identityMatch,
        matchedIdentifier: identifier,
        profile: {
          handle: name,
          ...(record.texts.name ? { displayName: record.texts.name } : {}),
          ...(record.texts.email ? { emails: [record.texts.email.toLowerCase()] } : {}),
          ...(profileUrls(record).length > 0 ? { urls: profileUrls(record) } : {}),
          ...(record.texts.location ? { location: record.texts.location } : {}),
          ...(record.avatar ? { avatarUrl: record.avatar } : {}),
          ...(record.texts.description ? { bio: record.texts.description } : {}),
        },
        ...discoveredField(
          dedupeIdentifiers(
            discovered.filter((item) => !sameHandle(item.value, identifier.value)),
            identifier,
          ),
        ),
      };
      context.log(`${LABEL}: „${target}" → ${name} / ${record.address} (${identityMatch}).`);
      return [document];
    },
  };
}
