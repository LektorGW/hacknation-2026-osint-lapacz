// Przekład węzłów grafu na byty rozwijanej sieci i stałe klucze nowych bytów.
// Klucze są tymi samymi identyfikatorami, których używa graf teczki (`graph.ts`), więc rozwinięcie
// dopina się do istniejących węzłów, a po ponownej analizie — do tych samych bytów.

import { NETWORK_RELATIONS, validateAddress } from '@olcys/core';
import type { GraphNode, ProfileCard } from '@olcys/core';
import { normalize } from '../identity.ts';
import type { EdgeDraft, Entity, EntityMeta, IdentifierKind, NetworkEdge, NetworkNode } from './types.ts';

/** Typ identyfikatora w kluczu węzła (`id:<typ>:<wartość>`) — zgodny z typami wejścia analityka tam, gdzie istnieją. */
const KEY_TYPE: Record<IdentifierKind, string> = {
  email: 'email',
  phone: 'phone',
  nick: 'nick',
  domain: 'domain',
  url: 'profile_url',
  messenger: 'messenger_id',
  name: 'full_name',
  ens: 'ens_name',
};

const KIND_OF_TYPE: Record<string, IdentifierKind> = {
  email: 'email',
  phone: 'phone',
  nick: 'nick',
  login: 'nick',
  domain: 'domain',
  profile_url: 'url',
  url: 'url',
  messenger_id: 'messenger',
  full_name: 'name',
  ens_name: 'ens',
};

/** Telefon do porównań: same cyfry, bez polskiego prefiksu kraju. */
export const phoneDigits = (value: string): string => value.replace(/\D/g, '').replace(/^48(?=\d{9}$)/, '');

/** Wartość identyfikatora w postaci kanonicznej (klucz węzła). */
export function canonicalValue(kind: IdentifierKind, value: string): string {
  const text = value.trim();
  if (kind === 'phone') return phoneDigits(text);
  if (kind === 'url') return text.replace(/\/+$/, '').toLowerCase();
  if (kind === 'domain') return text.replace(/^www\./i, '').toLowerCase();
  if (kind === 'nick') return text.replace(/^@/, '').toLowerCase();
  return text.toLowerCase();
}

export const identifierKey = (kind: IdentifierKind, value: string): string => `id:${KEY_TYPE[kind]}:${canonicalValue(kind, value)}`;
export const accountKey = (service: string, handle: string): string => `profile:${service.toLowerCase()}|${normalize(handle.replace(/^@/, ''))}`;
export const addressNodeKey = (network: string, address: string): string => `addr:${network}:${address}`;
export const documentKey = (url: string): string => `source:${url}`;
export const organizationKey = (name: string): string => `org:nazwa:${normalize(name).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;
export const sanctionsEntryKey = (list: string, entryId: string): string =>
  `sankcje:${normalize(list).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '')}:${entryId}`;

/** Domeny poczty ogólnodostępnej — domena takiego adresu nic nie mówi o właścicielu. */
export const FREE_MAIL = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'pm.me', 'tutanota.com', 'tuta.io',
  'gmx.com', 'gmx.net', 'mail.com', 'aol.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'wp.pl', 'o2.pl', 'onet.pl', 'op.pl', 'interia.pl', 'poczta.onet.pl', 'tlen.pl', 'gazeta.pl', 'vp.pl', 'int.pl', 'buziaczek.pl',
]);

/** Byt z węzła grafu; `null`, gdy węzła nie da się rozwijać (np. hipoteza operatora). */
export function entityFromNode(node: GraphNode & { meta?: EntityMeta }, profiles: ProfileCard[] = []): Entity | null {
  const meta: EntityMeta = { ...(node.meta ?? {}) };
  const base = { key: node.id, label: node.label, ...(node.url ? { url: node.url } : {}) };
  switch (node.kind) {
    case 'subject':
      return { ...base, kind: 'subject', identifierKind: 'name', value: node.label, meta };
    case 'identifier': {
      const match = /^id:([^:]+):(.*)$/s.exec(node.id);
      const type = match?.[1] ?? 'nick';
      const value = match?.[2] ?? node.label;
      if (type === 'crypto_address') {
        const valid = validateAddress(node.label) ?? validateAddress(value);
        if (!valid) return null;
        return { ...base, kind: 'crypto_address', value: valid.address, meta: { ...meta, network: valid.network, address: valid.address } };
      }
      const identifierKind = KIND_OF_TYPE[type] ?? 'nick';
      return { ...base, kind: 'identifier', identifierKind, value: identifierKind === 'email' || identifierKind === 'nick' ? node.label.trim() : value, meta };
    }
    case 'profile': {
      const raw = node.id.replace(/^profile:/, '');
      const card = profiles.find((item) => item.id === raw || (node.url !== undefined && item.url === node.url));
      const [service, handle] = raw.includes('|') ? (raw.split('|', 2) as [string, string]) : [card?.service ?? '', card?.handle ?? ''];
      const attributes = card?.attributes;
      return {
        ...base,
        kind: 'account',
        value: card?.handle ?? handle ?? node.label,
        meta: {
          service: card?.service ?? service,
          handle: card?.handle ?? handle,
          ...(attributes?.displayName ? { displayName: attributes.displayName } : {}),
          ...(attributes?.emails?.length ? { emails: attributes.emails } : {}),
          ...(attributes?.phones?.length ? { phones: attributes.phones } : {}),
          ...(attributes?.urls?.length ? { urls: attributes.urls } : {}),
          ...(card?.addresses.length ? { addresses: card.addresses } : {}),
          ...meta,
        },
      };
    }
    case 'address': {
      const match = /^addr:([^:]+):(.+)$/.exec(node.id);
      if (!match) return null;
      return { ...base, kind: 'crypto_address', value: match[2]!, meta: { ...meta, network: match[1]!, address: match[2]! } };
    }
    case 'source':
      if (node.id.startsWith('reply:')) return null;
      return { ...base, kind: 'document', value: node.url ?? node.id.replace(/^source:/, ''), meta };
    case 'organization':
      return { ...base, kind: 'organization', value: node.label, meta };
    case 'person':
    case 'persona':
      return { ...base, kind: 'person', identifierKind: 'name', value: node.label, meta };
    case 'service':
      return { ...base, kind: 'service', value: node.label, meta };
    default:
      return null;
  }
}

/** Węzeł identyfikatora utworzony przez rozwinięcie. */
export function identifierNode(kind: IdentifierKind, value: string, sublabel: string, meta: EntityMeta = {}): NetworkNode {
  const display = kind === 'phone' ? value.trim() : kind === 'domain' ? canonicalValue('domain', value) : value.trim();
  return { id: identifierKey(kind, value), kind: 'identifier', label: display, sublabel, entityKind: 'identifier', meta: { ...meta, ...(kind === 'domain' ? { domain: canonicalValue('domain', value) } : {}) } };
}

/** Krawędź z katalogu relacji: status i siła z katalogu, chyba że podano jawnie; deterministyczny identyfikator. */
export function edgeFrom(draft: EdgeDraft, expander: string): NetworkEdge {
  const spec = NETWORK_RELATIONS[draft.relation];
  const status = draft.status ?? spec.status;
  const evidence = dedupeEvidence(draft.evidence);
  return {
    id: `net:${draft.relation}:${draft.from}>${draft.to}`,
    from: draft.from,
    to: draft.to,
    kind: draft.kind ?? 'related',
    label: draft.label ?? spec.label,
    status,
    ...(status === 'hypothesis' ? { inferred: true } : {}),
    weight: Math.round((draft.strength ?? spec.strength) * 100),
    strength: draft.strength ?? spec.strength,
    relation: draft.relation,
    ...(evidence.length > 0 ? { evidence } : {}),
    explanation: draft.explanation,
    layer: draft.layer ?? 'identity',
    expander,
    retrievedAt: draft.retrievedAt,
    caveat: spec.caveat,
  };
}

function dedupeEvidence(items: EdgeDraft['evidence']): EdgeDraft['evidence'] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!item.value) return false;
    const key = `${item.kind}|${item.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
}

/** Domena z adresu e-mail albo URL; `undefined` dla poczty ogólnodostępnej i adresów bez domeny. */
export function domainOf(value: string, kind: 'email' | 'url'): string | undefined {
  let host: string | undefined;
  if (kind === 'email') host = value.split('@')[1];
  else {
    try {
      host = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname;
    } catch {
      host = undefined;
    }
  }
  const domain = host?.toLowerCase().replace(/^www\./, '');
  if (!domain || !/\.[a-z]{2,}$/i.test(domain) || FREE_MAIL.has(domain)) return undefined;
  return domain;
}
