// Pętla „rozszerzania” (pivot): każdy profil i każdy adres podmiotu jest punktem wyjścia
// do szukania INNYCH tożsamości tej samej osoby i osób z nią powiązanych.
//
// Z profilu bierzemy cechy (e-mail, telefon, strona WWW) i szukamy innych autorów, którzy
// podają tę samą cechę; rdzeń nazwy konta („rkowalski92” → „rkowalski”) jest słabym tropem.
// Z adresu bierzemy adresy powiązane wskazane przez moduł danych blockchain (ten sam adres
// wpłat giełdy, ten sam portfel, finansowanie) i sprawdzamy, kto je publikuje jako własne.
// Każde znalezisko to TROP z opisaną ścieżką dojścia — ocenia go `aliases.ts`, a rozstrzyga analityk.

import type { ChainActivity, Identifier, Network, ProfileAttributes, SourceDocument } from '@olcys/core';
import { shortAddress } from './format.ts';
import { normalize } from './identity.ts';

/** Limity pętli w obu trybach analizy — jawne, pokazywane przez API. */
export const PIVOT_LIMITS = {
  standard: { steps: 2, queriesPerStep: 12 },
  deep: { steps: 4, queriesPerStep: 20 },
  /** Minimalna siła powiązania adresów (0–100) wg modułu danych blockchain, od której trop jest sprawdzany. */
  minLinkStrength: 50,
  /** Jaka część limitu czasu analizy może upłynąć, zanim pętla przestanie zadawać nowe pytania. */
  timeShare: 0.9,
} as const;

export type LinkKind = 'co_depositor' | 'same_wallet' | 'funded_by' | 'funds' | 'repeated_counterparty';

/** Adres powiązany z adresem podmiotu według modułu danych blockchain (pole czytane dynamicznie). */
export interface LinkedAddressInfo {
  address: string;
  kind: LinkKind;
  strength: number;
  /** Adres pośredniczący, np. indywidualny adres wpłat giełdy. */
  via?: string;
  /** Nazwa usługi, której dotyczy powiązanie (np. giełda z adresem wpłat). */
  service?: string;
  txids: string[];
  reason?: string;
}

const LINK_KINDS: LinkKind[] = ['co_depositor', 'same_wallet', 'funded_by', 'funds', 'repeated_counterparty'];

/** Adresy powiązane z aktywności adresu; brak pola albo nieznany kształt daje pustą listę. */
export function linkedAddressesOf(chain: ChainActivity | undefined): LinkedAddressInfo[] {
  const raw = (chain as { linkedAddresses?: unknown } | undefined)?.linkedAddresses;
  if (!Array.isArray(raw)) return [];
  const result: LinkedAddressInfo[] = [];
  for (const item of raw as Record<string, unknown>[]) {
    const kind = LINK_KINDS.find((value) => value === item?.kind);
    if (!kind || typeof item.address !== 'string') continue;
    result.push({
      address: item.address,
      kind,
      strength: typeof item.strength === 'number' ? item.strength : typeof item.confidence === 'number' ? (item.confidence as number) : 50,
      ...(typeof item.via === 'string' ? { via: item.via } : {}),
      ...(typeof item.service === 'string' ? { service: item.service } : typeof item.serviceName === 'string' ? { service: item.serviceName as string } : {}),
      txids: Array.isArray(item.txids) ? (item.txids as unknown[]).filter((value): value is string => typeof value === 'string') : typeof item.txid === 'string' ? [item.txid] : [],
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
    });
  }
  return result;
}

/** Trop znaleziony przez pętlę rozszerzania — z opisaną ścieżką dojścia. */
export interface PivotLead {
  step: number;
  kind: 'shared_attribute' | 'handle_pattern' | 'same_address' | 'linked_address';
  /** Cecha, adres albo rdzeń nazwy, które łączą podmiot z tropem. */
  value: string;
  attribute?: 'email' | 'phone' | 'website';
  link?: LinkedAddressInfo;
  /** Adres podmiotu, od którego prowadzi powiązanie adresów. */
  fromAddress?: string;
  /** Publikacja, do której trop doprowadził; brak, gdy powiązanego adresu nikt nie opublikował. */
  docUrl?: string;
  author?: string;
  service?: string;
  /** Ścieżka dojścia krok po kroku, zdaniami dla analityka. */
  path: string[];
}

/** Punkt wyjścia tropów: profil (cechy) lub adres (powiązania w blockchainie). */
export interface PivotSource {
  path: string[];
  author?: string;
  handle?: string;
  attributes?: ProfileAttributes;
  addresses: { network: Network; address: string; chain?: ChainActivity }[];
  /** Punkt wyjścia należy do podmiotu (krok pierwszy), a nie do tożsamości już powiązanej. */
  ofSubject: boolean;
}

export interface PivotContext {
  steps: number;
  queriesPerStep: number;
  sources: PivotSource[];
  /** Nazwy, pod którymi występuje podmiot — ich publikacje nie są „inną tożsamością”. */
  isSubjectName(name: string): boolean;
  /** Zapytanie do źródeł bezpośrednich i indeksu własnego (bez kosztownych wyszukiwarek). */
  search(identifier: Identifier): Promise<SourceDocument[]>;
  /** Fraza w treści indeksu własnego (telefon, adres strony); pusta lista bez indeksu. */
  phraseSearch(phrase: string): Promise<SourceDocument[]>;
  /** Adresy w treści dokumentu wraz z informacją, czy publikacja jest podstawą własności. */
  ownedAddresses(doc: SourceDocument): { network: Network; address: string }[];
  /** Zapisuje publikację powiązanej tożsamości; zwraca `false`, gdy to publikacja podmiotu. */
  record(doc: SourceDocument, step: number): boolean;
  expired(): boolean;
  log(message: string): void;
}

/** Rdzeń nazwy konta: bez cyfr i typowych przyrostków („rkowalski92” → „rkowalski”); `undefined`, gdy nic nie ubyło. */
export function handleStem(handle: string): string | undefined {
  const value = normalize(handle);
  const stem = value
    .replace(/[\d]+$/g, '')
    .replace(/[._-]+(?:pl|btc|eth|crypto|krypto|official|dev|p2p|trader)$/g, '')
    .replace(/[._-]+$/g, '');
  return stem.length >= 5 && stem !== value ? stem : undefined;
}

const digitsOnly = (value: string) => value.replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');

interface Task {
  key: string;
  run: () => Promise<SourceDocument[]>;
  accept: (doc: SourceDocument) => boolean;
  lead: (doc: SourceDocument | undefined) => Omit<PivotLead, 'step' | 'docUrl' | 'author' | 'service'>;
  /** Trop bez publikacji też jest wynikiem (np. współwpłacający, którego adresu nikt nie opublikował). */
  keepWithoutDocument?: boolean;
}

export async function runPivot(context: PivotContext): Promise<PivotLead[]> {
  const leads: PivotLead[] = [];
  const asked = new Set<string>();
  let sources = context.sources;

  for (let step = 1; step <= context.steps && sources.length > 0 && !context.expired(); step++) {
    const tasks: Task[] = [];
    for (const source of sources) {
      const self = normalize(source.author ?? '');
      const other = (doc: SourceDocument) => {
        const author = normalize(doc.profile?.handle ?? doc.author ?? '');
        return author !== '' && author !== self && !context.isSubjectName(author);
      };
      const origin = `${source.path.at(-1) ?? 'podmiot'}`;

      for (const email of source.attributes?.emails ?? []) {
        const value = email.trim().toLowerCase();
        tasks.push({
          key: `email:${value}`,
          run: () => context.search({ type: 'email', value }),
          accept: (doc) => other(doc) && (doc.text.toLowerCase().includes(value) || (doc.profile?.emails ?? []).some((item) => item.toLowerCase() === value)),
          lead: (doc) => ({ kind: 'shared_attribute', attribute: 'email', value, path: [...source.path, `ten sam e-mail ${value}`, `publikacja „${doc?.author}” w serwisie ${doc?.service} (${doc?.url})`] }),
        });
      }
      for (const phone of source.attributes?.phones ?? []) {
        const value = digitsOnly(phone);
        if (value.length < 9) continue;
        tasks.push({
          key: `phone:${value}`,
          // Telefon bywa zapisany z odstępami — pytamy o zapis z profilu i o same cyfry.
          run: async () => [...(await context.phraseSearch(phone.trim())), ...(await context.phraseSearch(value))],
          accept: (doc) => other(doc) && (digitsOnly(doc.text).includes(value) || (doc.profile?.phones ?? []).some((item) => digitsOnly(item) === value)),
          lead: (doc) => ({ kind: 'shared_attribute', attribute: 'phone', value: phone.trim(), path: [...source.path, `ten sam telefon ${phone.trim()}`, `publikacja „${doc?.author}” w serwisie ${doc?.service} (${doc?.url})`] }),
        });
      }
      for (const url of source.attributes?.urls ?? []) {
        const value = url.trim().replace(/\/+$/, '');
        if (!/^https?:\/\/[^/]+\.[a-z]{2,}/i.test(value)) continue;
        tasks.push({
          key: `url:${value.toLowerCase()}`,
          run: () => context.phraseSearch(value.replace(/^https?:\/\/(www\.)?/i, '')),
          accept: (doc) => other(doc),
          lead: (doc) => ({ kind: 'shared_attribute', attribute: 'website', value, path: [...source.path, `ta sama strona WWW ${value}`, `publikacja „${doc?.author}” w serwisie ${doc?.service} (${doc?.url})`] }),
        });
      }
      const stem = source.handle ? handleStem(source.handle) : undefined;
      if (stem && !context.isSubjectName(stem)) {
        tasks.push({
          key: `stem:${stem}`,
          run: () => context.search({ type: 'nick', value: stem }),
          accept: (doc) => normalize(doc.profile?.handle ?? doc.author ?? '') === stem,
          lead: (doc) => ({ kind: 'handle_pattern', value: stem, path: [...source.path, `podobna nazwa konta: rdzeń „${stem}” (słaby trop)`, `profil „${doc?.author}” w serwisie ${doc?.service} (${doc?.url})`] }),
        });
      }

      for (const item of source.addresses) {
        // Inni autorzy publikujący ten sam adres jako własny — dla adresów podmiotu zrobiło to już
        // wyszukiwanie wystąpień; tutaj sprawdzamy adresy tożsamości znalezionych w poprzednim kroku.
        if (!source.ofSubject) {
          tasks.push({
            key: `addr:${item.address}`,
            run: () => context.search({ type: 'crypto_address', value: item.address }),
            accept: (doc) => other(doc) && context.ownedAddresses(doc).some((owned) => owned.address === item.address),
            lead: (doc) => ({ kind: 'same_address', value: item.address, path: [...source.path, `ten sam adres ${shortAddress(item.address)} publikowany jako własny`, `publikacja „${doc?.author}” w serwisie ${doc?.service} (${doc?.url})`] }),
          });
        }
        for (const link of linkedAddressesOf(item.chain)) {
          if (link.strength < PIVOT_LIMITS.minLinkStrength) continue;
          const steps = [
            `adres ${shortAddress(item.address)} ${source.ofSubject ? 'podmiotu' : `(${origin})`}`,
            ...(link.via ? [`${link.kind === 'co_depositor' ? `adres wpłat ${link.service ? `usługi ${link.service} ` : ''}` : 'adres pośredni '}${shortAddress(link.via)}`] : []),
            `${LINK_TEXT[link.kind]} ${shortAddress(link.address)}`,
          ];
          tasks.push({
            key: `addr:${link.address}`,
            run: () => context.search({ type: 'crypto_address', value: link.address }),
            accept: (doc) => other(doc) && context.ownedAddresses(doc).some((owned) => owned.address === link.address),
            keepWithoutDocument: true,
            lead: (doc) => ({
              kind: 'linked_address',
              value: link.address,
              link,
              fromAddress: item.address,
              path: [...(source.ofSubject ? [] : source.path), ...steps, ...(doc ? [`adres ${shortAddress(link.address)} opublikowany jako własny przez „${doc.author}” w serwisie ${doc.service} (${doc.url})`] : ['adresu nikt nie opublikował — właściciel nieznany'])],
            }),
          });
        }
      }
    }

    const unique = new Map<string, Task>();
    for (const task of tasks) if (!asked.has(task.key) && !unique.has(task.key)) unique.set(task.key, task);
    const selected = [...unique.values()].slice(0, context.queriesPerStep);
    for (const task of selected) asked.add(task.key);
    if (selected.length === 0) break;
    context.log(`Rozszerzanie, krok ${step}: tropów do sprawdzenia ${selected.length}${unique.size > selected.length ? ` (limit ${context.queriesPerStep} na krok)` : ''}.`);

    const next: PivotSource[] = [];
    await Promise.all(
      selected.map(async (task) => {
        if (context.expired()) return;
        const found = (await task.run()).filter(task.accept);
        const seen = new Set<string>();
        for (const doc of found) {
          if (seen.has(doc.url) || !context.record(doc, step)) continue;
          seen.add(doc.url);
          const lead = task.lead(doc);
          leads.push({ ...lead, step, docUrl: doc.url, ...(doc.author ? { author: doc.author } : {}), service: doc.service });
          context.log(`Trop (${lead.kind}): ${lead.path.join(' → ')}.`);
          next.push({
            path: lead.path,
            author: doc.author,
            handle: doc.profile?.handle ?? doc.author,
            attributes: doc.profile,
            addresses: context.ownedAddresses(doc),
            ofSubject: false,
          });
        }
        if (seen.size === 0 && task.keepWithoutDocument) leads.push({ ...task.lead(undefined), step });
      }),
    );
    sources = next;
  }
  return leads;
}

const LINK_TEXT: Record<LinkKind, string> = {
  co_depositor: 'na ten sam adres wpłat wpłaca także adres',
  same_wallet: 'ten sam portfel (heurystyka) obejmuje adres',
  funded_by: 'środki na adres przyszły z adresu',
  funds: 'adres zasila adres',
  repeated_counterparty: 'wielokrotne przelewy w obie strony z adresem',
};

export const linkKindText = (kind: LinkKind): string => LINK_TEXT[kind];
