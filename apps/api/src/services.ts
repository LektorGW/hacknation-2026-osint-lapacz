// Powiązania podmiotu z giełdami, portfelami i innymi usługami — sedno teczki.
// Odpowiada na pytanie analityka: z jaką usługą podmiot jest powiązany, na jakiej
// podstawie, na jaką kwotę i po jakich danych usługa znajdzie konto klienta.
//
// Agregacja jest po USŁUDZE, nie po adresie: „Binance 14” i „Binance: Hot Wallet”
// to jedna usługa. Podstawy z blockchaina (przelewy) i z publicznych treści
// (wzmianki, odnośniki polecające) łączą się w jeden wpis z jawną siłą powiązania.

import { readFileSync } from 'node:fs';
import type {
  AddressClass,
  CashOutIndicator,
  CashOutKind,
  Finding,
  Network,
  ServiceKind,
  ServiceLink,
  ServiceLinkBasis,
  SourceDocument,
} from '@olcys/core';
import { formatAmount, plural, roundPln, shortAddress } from './format.ts';
import { addressKey } from './intel.ts';

/** Wzmianka o usłudze albo odnośnik do konta znaleziony w publicznej treści. */
export interface ServiceMention {
  service: string;
  kind: ServiceKind;
  basis: 'web_mention' | 'account_link';
  /** Cytat z treści albo sam odnośnik. */
  excerpt: string;
}

/** Zewnętrzne rozpoznawanie usług po etykiecie (np. `matchService` z `@olcys/chain`). */
export type ExternalServiceMatcher = (text: string) => { name: string; category?: string } | undefined;

interface CatalogEntry {
  name: string;
  kind: ServiceKind;
  keywords: string[];
  domains: string[];
  pattern: RegExp;
}

let catalog: CatalogEntry[] | undefined;

/** Lista usług z `data/services.json`; słowa-klucze dopasowywane jako całe słowa. */
function getCatalog(): CatalogEntry[] {
  if (catalog) return catalog;
  const parsed = JSON.parse(readFileSync(new URL('../data/services.json', import.meta.url), 'utf8')) as {
    services: { name: string; kind: ServiceKind; keywords: string[]; domains?: string[] }[];
  };
  catalog = parsed.services.map((item) => {
    const words = item.keywords.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return {
      ...item,
      domains: item.domains ?? [],
      pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?![\\p{L}\\p{N}])`, 'iu'),
    };
  });
  return catalog;
}

/** Siła powiązania z usługą — jawne wartości, pokazywane także przez API. */
export const SERVICE_STRENGTH_RULES = {
  base: {
    transfer_out: 70,
    transfer_in: 60,
    deposit_address: 45,
    account_link: 40,
    web_mention: 20,
  } as Record<ServiceLinkBasis, number>,
  /** Za każdy przelew ponad pierwszy, najwyżej `maxExtraTransfers`. */
  extraTransfer: 5,
  maxExtraTransfers: 10,
  /** Za szacunkową wartość przelewów od 10 tys. zł / od 100 tys. zł. */
  valueFrom10k: 5,
  valueFrom100k: 10,
  /** Za drugi rodzaj przelewów (wpłaty i wypłaty). */
  bothDirections: 5,
  /** Za niezależne potwierdzenie: blockchain i publiczna treść jednocześnie. */
  chainAndWeb: 15,
  description:
    'Punktem wyjścia jest najmocniejsza podstawa: przelew na oznaczony portfel usługi (70), przelew z usługi (60), ' +
    'prawdopodobny adres wpłat z wnioskowania (45), odnośnik do konta lub polecający (40), sama wzmianka (20). ' +
    'Kolejne przelewy, większa wartość i niezależne podstawy (blockchain + publiczna treść) podnoszą wynik, najwyżej do 100.',
} as const;

const KIND_LABEL: Record<ServiceKind, string> = {
  exchange: 'giełda',
  p2p: 'serwis wymiany P2P',
  payment_gateway: 'bramka płatnicza',
  crypto_card: 'karta kryptowalutowa',
  wallet: 'portfel',
  defi: 'usługa DeFi',
  mixer: 'mikser',
  other: 'usługa',
};

export const serviceKindLabel = (kind: ServiceKind): string => KIND_LABEL[kind];

const BASIS_LABEL: Record<ServiceLinkBasis, string> = {
  transfer_out: 'przelew z adresu podmiotu na adres usługi (fakt z blockchaina)',
  transfer_in: 'przelew z adresu usługi na adres podmiotu (fakt z blockchaina)',
  deposit_address: 'przelew przez prawdopodobny adres wpłat w usłudze (wnioskowanie)',
  web_mention: 'wzmianka o usłudze w publicznej treści podmiotu',
  account_link: 'odnośnik do konta lub odnośnik polecający w usłudze',
};

export const serviceBasisLabel = (basis: ServiceLinkBasis): string => BASIS_LABEL[basis];

/** Usługi, w których można zamienić kryptowaluty na waluty tradycyjne. */
export const isCashOutService = (kind: ServiceKind): boolean =>
  kind === 'exchange' || kind === 'p2p' || kind === 'payment_gateway' || kind === 'crypto_card';

const KIND_BY_CASH_OUT: Record<CashOutKind, ServiceKind> = {
  exchange_deposit: 'exchange',
  p2p_service: 'p2p',
  payment_gateway: 'payment_gateway',
  crypto_card: 'crypto_card',
  stablecoin_swap: 'defi',
};

const KIND_BY_CLASS: Partial<Record<AddressClass, ServiceKind>> = {
  exchange: 'exchange',
  mixer: 'mixer',
  smart_contract: 'defi',
  institutional: 'other',
};

const EXTERNAL_KINDS: ServiceKind[] = ['exchange', 'p2p', 'payment_gateway', 'crypto_card'];

const INFERRED_LABEL = /adres wpłat giełdy „([^”]+)”/i;
const INFERRED_WALLET = /portfela giełdy „[^”]+”\s*\(([^)\s]+)\)/i;

/**
 * Nazwa usługi z etykiety adresu: część przed dwukropkiem, bez numeru portfela
 * i słów technicznych („Binance-Hot 2” → „Binance”).
 */
export function normalizeServiceLabel(label: string): string {
  let name = (label.split(':')[0] ?? label).trim();
  const suffix = /[\s\-_#]*(?:hot|cold|deposit|deposits|withdrawal|withdrawals|wallet|portfel|\d+)$/iu;
  while (suffix.test(name) && name.replace(suffix, '').trim().length > 0) name = name.replace(suffix, '').trim();
  return name;
}

/** Usługa rozpoznana po etykiecie: lista lokalna, potem zewnętrzna, na końcu sama etykieta. */
export function resolveService(
  label: string,
  fallbackKind: ServiceKind,
  matcher?: ExternalServiceMatcher,
): { name: string; kind: ServiceKind } {
  const local = getCatalog().find((item) => item.pattern.test(label));
  if (local) return { name: local.name, kind: local.kind };
  const external = matcher?.(label);
  const externalKind = EXTERNAL_KINDS.find((kind) => kind === external?.category);
  // Wpisy ogólne („Bramka (ogólnie)”) mówią tylko o rodzaju, nie o nazwie usługi.
  if (external && !external.name.includes('(ogólnie)')) return { name: external.name, kind: externalKind ?? fallbackKind };
  return { name: normalizeServiceLabel(label), kind: externalKind ?? fallbackKind };
}

const serviceId = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'usluga';

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const ACCOUNT_PARAMS = ['ref', 'referral', 'referralcode', 'refcode', 'invite', 'invitecode', 'affiliate', 'advertiserno', 'rcode'];
const ACCOUNT_PATH = /\/(?:referral|ref|invite|join|u|user|users|profile|advertiser|advertiserdetail)(?:[/-]|$)/i;

const excerptAround = (text: string, index: number, length: number): string =>
  text
    .slice(Math.max(0, index - 70), index + length + 70)
    .replace(/\s+/g, ' ')
    .trim();

function entryForUrl(raw: string): { entry: CatalogEntry; account: boolean } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const entry = getCatalog().find((item) => item.domains.some((domain) => host === domain || host.endsWith(`.${domain}`)));
  if (!entry) return undefined;
  const params = [...url.searchParams.keys()].map((key) => key.toLowerCase());
  return { entry, account: params.some((key) => ACCOUNT_PARAMS.includes(key)) || ACCOUNT_PATH.test(url.pathname) };
}

/**
 * Wzmianki o usługach w treści: nazwy z listy (całe słowa) oraz odnośniki w domenie
 * usługi. Odnośnik z parametrem polecającym albo ścieżką profilu to `account_link`.
 */
export function detectServiceMentions(text: string, extraUrls: string[] = []): ServiceMention[] {
  const found = new Map<string, ServiceMention>();
  const add = (entry: CatalogEntry, basis: ServiceMention['basis'], excerpt: string) => {
    const key = `${entry.name}|${basis}`;
    if (!found.has(key)) found.set(key, { service: entry.name, kind: entry.kind, basis, excerpt: excerpt.slice(0, 300) });
  };

  for (const raw of [...(text.match(URL_PATTERN) ?? []), ...extraUrls]) {
    const hit = entryForUrl(raw.replace(/[.,;]+$/, ''));
    if (hit) add(hit.entry, hit.account ? 'account_link' : 'web_mention', raw.replace(/[.,;]+$/, ''));
  }
  // Nazwy szukamy poza odnośnikami, żeby jeden odnośnik nie liczył się dwa razy.
  const prose = text.replace(URL_PATTERN, (url) => ' '.repeat(url.length));
  for (const entry of getCatalog()) {
    const hit = entry.pattern.exec(prose);
    if (hit && !found.has(`${entry.name}|web_mention`)) add(entry, 'web_mention', excerptAround(text, hit.index, hit[0].length));
  }
  return [...found.values()];
}

/** Wzmianki w dokumencie podmiotu: treść, opis i odnośniki profilu oraz sam adres dokumentu. */
export function mentionsInDocument(doc: SourceDocument): ServiceMention[] {
  const mentions = detectServiceMentions([doc.text, doc.profile?.bio ?? ''].join('\n'), doc.profile?.urls ?? []);
  // Dokument pobrany z domeny usługi to konto lub oferta podmiotu w tej usłudze.
  const own = entryForUrl(doc.url);
  if (own && !mentions.some((item) => item.service === own.entry.name && item.basis === 'account_link')) {
    mentions.push({ service: own.entry.name, kind: own.entry.kind, basis: 'account_link', excerpt: doc.url });
  }
  return mentions;
}

/** Publiczna treść podmiotu, w której szukano wzmianek. */
export interface MentionSource {
  url: string;
  mentions: ServiceMention[];
  evidenceId?: string;
}

export interface ServiceLinkInput {
  /** Adresy powiązane z podmiotem — ich przelewy tworzą powiązania z usługami. */
  subjectFindings: Finding[];
  /** Adresy wykluczone klasą (np. giełdy), które podmiot sam opublikował. */
  publishedServiceFindings: Finding[];
  mentionSources: MentionSource[];
  /** Nazwy kont i e-maile podmiotu — dane, po których usługa może wyszukać klienta. */
  accountNames: string[];
  matcher?: ExternalServiceMatcher;
}

type LinkTransfer = ServiceLink['transfers'][number];

interface Accumulator {
  name: string;
  kind: ServiceKind;
  networks: Set<Network>;
  basis: Set<ServiceLinkBasis>;
  transfers: (LinkTransfer & { inferred: boolean })[];
  mentions: ServiceLink['mentions'];
  accountLinks: { url: string; link: string }[];
  publishedAddresses: { address: string; url: string }[];
}

const MAX_HINT_TRANSFERS = 5;

const describeTransfer = (transfer: LinkTransfer): string =>
  `${transfer.time.slice(0, 10)} ${formatAmount(transfer.amount)} ${transfer.asset} tx ${transfer.txid}` +
  (transfer.valuePln !== undefined ? ` (ok. ${roundPln(transfer.valuePln)})` : '');

function listTransfers(transfers: LinkTransfer[]): string {
  const shown = transfers.slice(0, MAX_HINT_TRANSFERS).map(describeTransfer).join('; ');
  const rest = transfers.length - MAX_HINT_TRANSFERS;
  return rest > 0 ? `${shown}; oraz ${rest} ${plural(rest, 'kolejny', 'kolejne', 'kolejnych')} (pełna lista w tabeli przelewów)` : shown;
}

const groupBy = <T>(items: T[], key: (item: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
};

const sumPln = (transfers: LinkTransfer[]): number | undefined => {
  const valued = transfers.filter((item) => item.valuePln !== undefined);
  return valued.length > 0 ? Math.round(valued.reduce((sum, item) => sum + item.valuePln!, 0) * 100) / 100 : undefined;
};

const przelew = (count: number) => plural(count, 'przelew', 'przelewy', 'przelewów');

/** Dane, po których usługa znajdzie konto klienta — każde zdanie samodzielne. */
function requestHints(item: Accumulator, accountNames: string[]): string[] {
  const hints: string[] = [];
  const outgoing = item.transfers.filter((transfer) => transfer.direction === 'out');

  for (const [via, transfers] of groupBy(outgoing.filter((transfer) => transfer.viaAddress), (transfer) => transfer.viaAddress!)) {
    hints.push(
      `Adres wpłat ${via} — prawdopodobny indywidualny adres wpłat klienta w usłudze ${item.name} (wnioskowanie narzędzia, do potwierdzenia przez usługę); ` +
        `${transfers.length} ${plural(transfers.length, 'wpłata', 'wpłaty', 'wpłat')} z adresu podmiotu ${transfers[0]!.subjectAddress}: ${listTransfers(transfers)}.`,
    );
  }
  for (const [pair, transfers] of groupBy(outgoing.filter((transfer) => !transfer.viaAddress), (transfer) => `${transfer.subjectAddress}|${transfer.serviceAddress}`)) {
    const [subject, service] = pair.split('|');
    hints.push(
      `Przelewy z adresu podmiotu ${subject} na adres usługi ${item.name} ${service} (${transfers.length}): ${listTransfers(transfers)}. ` +
        'Usługa może wskazać konto klienta, na które zaksięgowano te wpłaty.',
    );
  }
  for (const [pair, transfers] of groupBy(item.transfers.filter((transfer) => transfer.direction === 'in'), (transfer) => `${transfer.subjectAddress}|${transfer.serviceAddress}`)) {
    const [subject, service] = pair.split('|');
    hints.push(
      `Wypłaty z adresu usługi ${item.name} ${service} na adres podmiotu ${subject} (${transfers.length}): ${listTransfers(transfers)}. ` +
        'Usługa może wskazać konto klienta, z którego zlecono te wypłaty.',
    );
  }
  for (const published of item.publishedAddresses) {
    hints.push(`Adres ${published.address} oznaczony jako adres usługi ${item.name} podmiot sam opublikował w ${published.url} — możliwy adres wpłat na jego konto.`);
  }
  for (const link of item.accountLinks) {
    hints.push(`Odnośnik do konta lub odnośnik polecający w usłudze ${item.name}, opublikowany w ${link.url}: ${link.link}`);
  }
  if (hints.length === 0) {
    for (const mention of item.mentions.slice(0, 3)) {
      hints.push(`Wzmianka o usłudze ${item.name} w publikacji ${mention.url}: „${mention.excerpt}”.`);
    }
  }
  if (item.kind !== 'wallet' && accountNames.length > 0) {
    hints.push(`Nazwy kont i adresy e-mail podmiotu, po których usługa ${item.name} może wyszukać klienta: ${accountNames.join(', ')}.`);
  }
  return hints;
}

function strengthOf(item: Accumulator): { strength: number; reasons: string[] } {
  const rules = SERVICE_STRENGTH_RULES;
  const basis = [...item.basis].sort((a, b) => rules.base[b] - rules.base[a]);
  const strongest = basis[0]!;
  let strength = rules.base[strongest];
  const reasons = [`Najmocniejsza podstawa: ${BASIS_LABEL[strongest]} — ${rules.base[strongest]} pkt.`];

  const count = item.transfers.length;
  if (count > 1) {
    const bonus = Math.min(rules.maxExtraTransfers, (count - 1) * rules.extraTransfer);
    strength += bonus;
    reasons.push(`Liczba przelewów: ${count} — +${bonus} pkt.`);
  }
  const value = (sumPln(item.transfers) ?? 0);
  if (value >= 10_000) {
    const bonus = value >= 100_000 ? rules.valueFrom100k : rules.valueFrom10k;
    strength += bonus;
    reasons.push(`Szacunkowa wartość wycenionych przelewów: ${roundPln(value)} — +${bonus} pkt.`);
  }
  if (item.transfers.some((transfer) => transfer.direction === 'in') && item.transfers.some((transfer) => transfer.direction === 'out')) {
    strength += rules.bothDirections;
    reasons.push(`Przelewy w obu kierunkach (do usługi i z usługi) — +${rules.bothDirections} pkt.`);
  }
  const onChain = count > 0;
  const onWeb = item.basis.has('web_mention') || item.basis.has('account_link');
  if (onChain && onWeb) {
    strength += rules.chainAndWeb;
    reasons.push(`Dwie niezależne podstawy: przelewy w blockchainie oraz publiczna treść podmiotu — +${rules.chainAndWeb} pkt.`);
  }
  if (basis.length === 1 && strongest === 'deposit_address') {
    reasons.push('Powiązanie opiera się wyłącznie na wnioskowaniu o adresie wpłat — wymaga potwierdzenia przez usługę.');
  }
  if (!onChain) {
    reasons.push(
      item.kind === 'wallet'
        ? 'Informacja o sposobie przechowywania środków — bez przelewów i kwot.'
        : 'Brak przelewów między adresami podmiotu a tą usługą — podstawą jest tylko publiczna treść.',
    );
  }
  return { strength: Math.min(100, strength), reasons };
}

export function buildServiceLinks(input: ServiceLinkInput): ServiceLink[] {
  const byId = new Map<string, Accumulator>();
  const accumulator = (name: string, kind: ServiceKind): Accumulator => {
    const id = serviceId(name);
    let item = byId.get(id);
    if (!item) {
      item = { name, kind, networks: new Set(), basis: new Set(), transfers: [], mentions: [], accountLinks: [], publishedAddresses: [] };
      byId.set(id, item);
    }
    // Rodzaj znany z blockchaina lub z listy jest dokładniejszy niż „inna usługa”.
    if (item.kind === 'other' && kind !== 'other') item.kind = kind;
    return item;
  };

  const ownAddresses = new Set(input.subjectFindings.map(addressKey));

  for (const finding of input.subjectFindings) {
    const cashOuts = new Map<string, CashOutIndicator>(
      (finding.chain?.cashOuts ?? []).map((item) => [`${item.txid}|${item.counterparty}`, item]),
    );
    for (const transfer of finding.chain?.transfers ?? []) {
      if (ownAddresses.has(addressKey({ network: finding.network, address: transfer.counterparty }))) continue;
      const cashOut = transfer.direction === 'out' ? cashOuts.get(`${transfer.txid}|${transfer.counterparty}`) : undefined;
      const inferredName = INFERRED_LABEL.exec(transfer.counterpartyLabel ?? '')?.[1] ?? INFERRED_LABEL.exec(cashOut?.explanation ?? '')?.[1];
      const inferred = transfer.direction === 'out' && (inferredName !== undefined || /^WNIOSKOWANIE/.test(cashOut?.explanation ?? ''));
      const label = inferredName ?? transfer.counterpartyLabel ?? cashOut?.counterpartyLabel;
      const classKind = KIND_BY_CLASS[transfer.counterpartyClass];
      const fallbackKind = (cashOut ? KIND_BY_CASH_OUT[cashOut.kind] : undefined) ?? classKind ?? 'other';
      const known = label ? getCatalog().some((item) => item.pattern.test(label)) || input.matcher?.(label) !== undefined : false;
      // Usługą jest kontrahent ze wskaźnikiem wypłaty, z klasą pośrednika albo o rozpoznanej nazwie.
      if (!cashOut && !inferred && !classKind && !known) continue;
      if (/^ENS:/i.test(label ?? '') && !cashOut) continue;

      const service = label
        ? resolveService(label, fallbackKind, input.matcher)
        : { name: `Usługa bez nazwy (${shortAddress(transfer.counterparty)})`, kind: fallbackKind };
      const item = accumulator(service.name, service.kind);
      item.networks.add(finding.network);
      item.basis.add(inferred ? 'deposit_address' : transfer.direction === 'out' ? 'transfer_out' : 'transfer_in');
      const wallet = inferred ? INFERRED_WALLET.exec(cashOut?.explanation ?? '')?.[1] : undefined;
      item.transfers.push({
        txid: transfer.txid,
        time: transfer.time,
        direction: transfer.direction,
        asset: transfer.asset,
        amount: transfer.amount,
        ...(cashOut?.valuePln !== undefined ? { valuePln: cashOut.valuePln } : {}),
        subjectAddress: finding.address,
        // Przy wnioskowaniu po stronie usługi jest portfel zbiorczy, a kontrahent to adres pośredni.
        serviceAddress: wallet ?? transfer.counterparty,
        ...(inferred ? { viaAddress: transfer.counterparty } : {}),
        explorerUrl: transfer.explorerUrl,
        inferred,
      });
    }
  }

  for (const finding of input.publishedServiceFindings) {
    const label = finding.chain?.profile.label;
    const kind = KIND_BY_CLASS[finding.chain?.profile.addressClass ?? 'unknown'];
    if (!label || !kind || finding.evidence.length === 0) continue;
    const service = resolveService(label, kind, input.matcher);
    const item = accumulator(service.name, service.kind);
    item.networks.add(finding.network);
    item.basis.add('web_mention');
    for (const evidence of finding.evidence) {
      item.mentions.push({ url: evidence.url, excerpt: evidence.excerpt, evidenceId: evidence.id });
      item.publishedAddresses.push({ address: finding.address, url: evidence.url });
    }
  }

  for (const source of input.mentionSources) {
    for (const mention of source.mentions) {
      const item = accumulator(mention.service, mention.kind);
      item.basis.add(mention.basis);
      if (item.mentions.some((known) => known.url === source.url && known.excerpt === mention.excerpt)) continue;
      item.mentions.push({ url: source.url, excerpt: mention.excerpt, ...(source.evidenceId ? { evidenceId: source.evidenceId } : {}) });
      if (mention.basis === 'account_link') item.accountLinks.push({ url: source.url, link: mention.excerpt });
    }
  }

  const links: ServiceLink[] = [];
  for (const [id, item] of byId) {
    item.transfers.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const transfers = item.transfers.map(({ inferred: _inferred, ...transfer }) => transfer);
    const outgoing = transfers.filter((transfer) => transfer.direction === 'out');
    const incoming = transfers.filter((transfer) => transfer.direction === 'in');
    const { strength, reasons } = strengthOf(item);
    const outPln = sumPln(outgoing);
    const inPln = sumPln(incoming);
    links.push({
      id,
      name: item.name,
      kind: item.kind,
      networks: [...item.networks],
      basis: [...item.basis].sort((a, b) => SERVICE_STRENGTH_RULES.base[b] - SERVICE_STRENGTH_RULES.base[a]),
      strength,
      reasons,
      inferredOnly: [...item.basis].every((basis) => basis === 'deposit_address'),
      ...(transfers.length > 0 ? { firstSeen: transfers[0]!.time, lastSeen: transfers.at(-1)!.time } : {}),
      transfersOut: outgoing.length,
      transfersIn: incoming.length,
      ...(outPln !== undefined ? { outPln } : {}),
      ...(inPln !== undefined ? { inPln } : {}),
      transfers,
      mentions: item.mentions,
      requestHints: requestHints(item, input.accountNames),
    });
  }
  // Najpierw usługi wypłat na waluty tradycyjne, w nich od najmocniejszego powiązania.
  return links.sort(
    (a, b) => Number(isCashOutService(b.kind)) - Number(isCashOutService(a.kind)) || b.strength - a.strength || a.name.localeCompare(b.name, 'pl'),
  );
}

/** Jedno zdanie o powiązaniu z usługą — do kluczowych ustaleń i raportu. */
export function describeServiceLink(link: ServiceLink): string {
  const kind = KIND_LABEL[link.kind];
  if (link.transfers.length === 0) {
    return link.kind === 'wallet'
      ? `Podmiot wymienia portfel ${link.name} w publicznych treściach — informacja o sposobie przechowywania środków, bez kwot.`
      : link.basis.includes('account_link')
        ? `Podmiot opublikował odnośnik do konta lub odnośnik polecający w usłudze ${link.name} (${kind}); przelewów na jej adresy nie stwierdzono.`
        : `Podmiot wymienia usługę ${link.name} (${kind}) w publicznych treściach; przelewów na jej adresy nie stwierdzono.`;
  }
  const years = [...new Set(link.transfers.map((transfer) => transfer.time.slice(0, 4)))].sort();
  const period = years.length > 1 ? `w latach ${years[0]}–${years.at(-1)}` : `w ${years[0]} r.`;
  const parts: string[] = [];
  if (link.transfersOut > 0) {
    parts.push(
      `${link.transfersOut} ${przelew(link.transfersOut)} do usługi` +
        (link.outPln !== undefined ? ` o szacunkowej wartości ${roundPln(link.outPln)}` : ''),
    );
  }
  if (link.transfersIn > 0) parts.push(`${link.transfersIn} ${przelew(link.transfersIn)} z usługi na adres podmiotu`);
  const basis = link.inferredOnly
    ? 'wnioskowanie o adresie wpłat — do potwierdzenia przez usługę'
    : link.basis.includes('deposit_address')
      ? 'fakt z blockchaina + wnioskowanie o adresie wpłat'
      : 'fakt z blockchaina';
  const web = link.mentions.length > 0 ? '; dodatkowo usługa występuje w publicznych treściach podmiotu' : '';
  return `Podmiot jest powiązany z usługą ${link.name} (${kind}): ${parts.join(' oraz ')} ${period} (${basis}${web}).`;
}
