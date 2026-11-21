// Ekspandery: każdy rozwija jeden rodzaj bytu w jeden rodzaj relacji. Kolejność na liście jest kolejnością
// wykonania — tańsze (dane z teczki, przetwarzanie lokalne) przed zapytaniami do źródeł.
//
// Granice uczciwości wbudowane w ekspandery:
//   - kontrahenci przelewów, darczyńcy i współwpłacający są WYŁĄCZNIE węzłami adresów, nigdy osobami;
//   - rola w organizacji (rejestr) łączy osobę z organizacją, nigdy z adresem;
//   - zgodny sam nick, wspólna wzmianka i heurystyki portfela to hipotezy;
//   - trafienie na liście sankcyjnej jest faktem wyłącznie dla bytu z listy;
//   - dane demonstracyjne nie trafiają do prawdziwych rejestrów ani list.

import { extractAddresses, validateAddress } from '@olcys/core';
import type { ChainActivity, Identifier, IdentifierType, SourceConnector, SourceDocument } from '@olcys/core';
import { OWNERSHIP_CATEGORIES } from '../analysis.ts';
import { shortAddress } from '../format.ts';
import { normalize } from '../identity.ts';
import { linkedAddressesOf } from '../pivot.ts';
import { accountKey, addressNodeKey, canonicalValue, documentKey, domainOf, edgeFrom, identifierNode, organizationKey, phoneDigits, sanctionsEntryKey } from './entities.ts';
import { LEGAL, isSyntheticConnector, searchConnector } from './expander.ts';
import type { ExpandContext, Expander } from './expander.ts';
import type { SanctionsHit, SanctionsQuery } from './sanctions.ts';
import type { EdgeDraft, Entity, EntityMeta, ExpanderOutput, ExpansionSourceError, IdentifierKind, NetworkEdge, NetworkNode } from './types.ts';

/** Najwyżej tyle nowych bytów z jednego ekspandera dla jednego bytu. */
export const PER_EXPANDER_LIMIT = 12;
/** Najwyżej tylu kontrahentów przelewów (największych). */
export const COUNTERPARTY_LIMIT = 8;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Zbieracz wyniku jednego ekspandera. */
function collector(expander: string) {
  const nodes = new Map<string, NetworkNode>();
  const edges = new Map<string, NetworkEdge>();
  const errors: ExpansionSourceError[] = [];
  const notes: ExpanderOutput['notes'] = [];
  let requests = 0;
  return {
    node(node: NetworkNode) {
      if (!nodes.has(node.id)) nodes.set(node.id, node);
      return node.id;
    },
    edge(draft: EdgeDraft) {
      if (draft.from === draft.to) return;
      const edge = edgeFrom(draft, expander);
      if (!edges.has(edge.id)) edges.set(edge.id, edge);
    },
    error(source: string, error: unknown) {
      errors.push({ source, expander, message: error instanceof Error ? error.message : String(error) });
    },
    note(note: NonNullable<ExpanderOutput['notes']>[number]) {
      notes.push({ ...note, expander });
    },
    count(n = 1) {
      requests += n;
    },
    get size() {
      return nodes.size;
    },
    done(): ExpanderOutput {
      return { nodes: [...nodes.values()], edges: [...edges.values()], errors, notes, requests };
    },
  };
}
type Out = ReturnType<typeof collector>;

/** Zapytanie do łącznika w ramach budżetu; błąd i brak budżetu zapisane, nie rzucane. */
async function ask(connector: SourceConnector, identifier: Identifier, context: ExpandContext, out: Out): Promise<SourceDocument[]> {
  if (!context.reserve()) {
    out.note({ reason: 'budget', detail: `Budżet zapytań wyczerpany — nie zapytano źródła ${connector.label} o „${identifier.value}”.`, skipped: 1 });
    return [];
  }
  out.count();
  try {
    return await searchConnector(connector, identifier, context);
  } catch (error) {
    out.error(connector.label, error);
    return [];
  }
}

const connectorsFor = (type: IdentifierType, context: ExpandContext) => context.connectors.filter((connector) => connector.accepts.includes(type)).slice(0, 8);

const handleOf = (doc: SourceDocument): string | undefined => (doc.profile?.handle ?? doc.author)?.trim().replace(/^@/, '') || undefined;

/** Adresy, które dokument publikuje jako WŁASNE (kategoria własności: profil, oferta, rozliczenie, dowód). */
const ownedAddresses = (doc: SourceDocument): string[] =>
  OWNERSHIP_CATEGORIES.includes(doc.category) ? extractAddresses(doc.text).map((item) => `${item.network}:${item.address}`) : [];

/** Węzeł konta z dokumentu (autor publikacji); `null`, gdy źródło nie podaje autora. */
function accountNode(doc: SourceDocument, context: ExpandContext): NetworkNode | null {
  const handle = handleOf(doc);
  if (!handle) return null;
  const synthetic = isSyntheticConnector(doc.connectorId) || context.synthetic;
  const addresses = ownedAddresses(doc);
  const meta: EntityMeta = {
    service: doc.service,
    handle,
    ...(doc.profile?.displayName ? { displayName: doc.profile.displayName } : {}),
    ...(doc.profile?.emails?.length ? { emails: [...new Set(doc.profile.emails.map((item) => item.toLowerCase()))] } : {}),
    ...(doc.profile?.phones?.length ? { phones: [...new Set(doc.profile.phones)] } : {}),
    ...(doc.profile?.urls?.length ? { urls: [...new Set(doc.profile.urls)] } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    ...(synthetic ? { synthetic: true } : {}),
  };
  return {
    id: accountKey(doc.service, handle),
    kind: 'profile',
    label: handle,
    sublabel: `${doc.service} — konto z rozwinięcia${doc.profile?.displayName ? ` („${doc.profile.displayName}”)` : ''}`,
    url: doc.url,
    entityKind: 'account',
    meta,
  };
}

function mergeMeta(node: NetworkNode, extra: EntityMeta): void {
  const meta = (node.meta ??= {});
  for (const key of ['emails', 'phones', 'urls', 'addresses'] as const) {
    const values = [...new Set([...(meta[key] ?? []), ...(extra[key] ?? [])])];
    if (values.length > 0) meta[key] = values;
  }
  meta.displayName ??= extra.displayName;
}

function addressNode(key: string, sublabel: string, meta: EntityMeta = {}): NetworkNode | null {
  const [network, ...rest] = key.split(':');
  const address = rest.join(':');
  if (!network || !address) return null;
  return { id: addressNodeKey(network, address), kind: 'address', label: shortAddress(address), sublabel, entityKind: 'crypto_address', meta: { ...meta, network, address } };
}

const docEvidence = (doc: SourceDocument) => [{ kind: 'url' as const, value: doc.url }];
const isoOf = (doc: SourceDocument, context: ExpandContext) => doc.fetchedAt ?? context.now().toISOString();

// ---------- 1. Konto → identyfikatory, które publikuje ----------

const accountIdentifiers: Expander = {
  id: 'konto-identyfikatory',
  group: 'accounts',
  label: 'Konto → identyfikatory, które publikuje (e-mail, telefon, adresy)',
  reads: 'Dane konta z teczki albo z jego publikacji: e-maile, telefony i adresy kryptowalutowe podane przez samo konto.',
  provider: 'teczka sprawy; bez danych w teczce — łącznik serwisu konta (wyszukiwanie po nazwie konta)',
  legalBasis: `${LEGAL.dossier}; ${LEGAL.existingConnectors}`,
  produces: ['publishes_identifier'],
  applies: (entity) => entity.kind === 'account',
  cost: (entity, context) => (hasPublished(entity.meta) ? 0 : serviceConnectors(entity, context).length),
  async run(entity, context) {
    const out = collector(this.id);
    let meta = entity.meta;
    let evidenceUrl = entity.url;
    let retrievedAt = context.now().toISOString();
    if (!hasPublished(meta) && meta.handle) {
      for (const connector of serviceConnectors(entity, context)) {
        for (const doc of await ask(connector, { type: 'nick', value: meta.handle }, context, out)) {
          if (normalize(handleOf(doc) ?? '') !== normalize(meta.handle)) continue;
          const node = accountNode(doc, context);
          if (!node) continue;
          meta = { ...meta, ...node.meta, emails: [...new Set([...(meta.emails ?? []), ...(node.meta?.emails ?? [])])], addresses: [...new Set([...(meta.addresses ?? []), ...(node.meta?.addresses ?? [])])] };
          evidenceUrl ??= doc.url;
          retrievedAt = isoOf(doc, context);
        }
      }
    }
    const evidence = (attribute: string) => [...(evidenceUrl ? [{ kind: 'url' as const, value: evidenceUrl }] : []), { kind: 'attribute' as const, value: attribute }];
    const where = `konto ${meta.handle ?? entity.label}${meta.service ? ` w serwisie ${meta.service}` : ''}`;
    for (const email of (meta.emails ?? []).slice(0, PER_EXPANDER_LIMIT)) {
      const to = out.node(identifierNode('email', email, 'e-mail opublikowany przez konto'));
      out.edge({ from: entity.key, to, relation: 'publishes_identifier', kind: 'links_to', explanation: `${capital(where)} podaje adres e-mail ${email}.`, evidence: evidence(`e-mail: ${email}`), retrievedAt });
    }
    for (const phone of (meta.phones ?? []).slice(0, PER_EXPANDER_LIMIT)) {
      if (phoneDigits(phone).length < 9) continue;
      const to = out.node(identifierNode('phone', phone, 'telefon opublikowany przez konto'));
      out.edge({ from: entity.key, to, relation: 'publishes_identifier', kind: 'links_to', explanation: `${capital(where)} podaje numer telefonu ${phone}.`, evidence: evidence(`telefon: ${phone}`), retrievedAt });
    }
    for (const key of (meta.addresses ?? []).slice(0, PER_EXPANDER_LIMIT)) {
      const node = addressNode(key, 'adres opublikowany przez konto', meta.synthetic ? { synthetic: true } : {});
      if (!node) continue;
      const to = out.node(node);
      out.edge({
        from: entity.key,
        to,
        relation: 'publishes_identifier',
        kind: 'publishes',
        label: 'publikuje adres',
        explanation: `${capital(where)} publikuje adres ${node.meta?.address} jako własny. Publikacja jest deklaracją autora — nie dowodzi dysponowania kluczem.`,
        evidence: evidence(`adres: ${node.meta?.address}`),
        retrievedAt,
      });
    }
    if (out.size === 0) out.note({ reason: 'no_results', detail: `${capital(where)}: brak opublikowanych identyfikatorów do rozwinięcia.` });
    return out.done();
  },
};

const hasPublished = (meta: EntityMeta) => Boolean(meta.emails?.length || meta.phones?.length || meta.addresses?.length);
const serviceConnectors = (entity: Entity, context: ExpandContext) =>
  entity.meta.handle && entity.meta.service ? context.connectors.filter((connector) => connector.service === entity.meta.service && connector.accepts.includes('nick')).slice(0, 3) : [];
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// ---------- 2. Konto → konta, do których prowadzą jego odnośniki ----------

const accountLinks: Expander = {
  id: 'konto-odnosniki',
  group: 'accounts',
  label: 'Konto → konta i strony wskazane odnośnikami (także wzajemnie)',
  reads: 'Odnośniki podane w profilu konta (strony, inne profile) i odnośniki zwrotne znanych kont.',
  provider: 'teczka sprawy i wcześniejsze rozwinięcia (bez zapytań)',
  legalBasis: LEGAL.dossier,
  produces: ['links_account', 'mutual_link'],
  applies: (entity) => entity.kind === 'account',
  cost: () => 0,
  async run(entity, context) {
    const out = collector(this.id);
    const retrievedAt = context.now().toISOString();
    const clean = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
    const own = entity.url ? clean(entity.url) : undefined;
    for (const url of (entity.meta.urls ?? []).slice(0, PER_EXPANDER_LIMIT)) {
      const target = [...context.nodes.values()].find((node) => node.kind === 'profile' && node.id !== entity.key && node.url !== undefined && clean(node.url) === clean(url));
      const mutual = target && own !== undefined && (target.meta?.urls ?? []).some((item) => clean(item) === own);
      const evidence = [...(entity.url ? [{ kind: 'url' as const, value: entity.url }] : []), { kind: 'attribute' as const, value: `odnośnik: ${url}` }];
      if (target) {
        out.edge({
          from: entity.key,
          to: target.id,
          relation: mutual ? 'mutual_link' : 'links_account',
          kind: 'links_to',
          explanation: mutual ? `Konta wskazują się nawzajem odnośnikami (${url} i ${entity.url}).` : `Profil wskazuje konto ${target.label} odnośnikiem ${url}.`,
          evidence,
          retrievedAt,
        });
        continue;
      }
      const domain = domainOf(url, 'url');
      const to = out.node(identifierNode('url', url, 'odnośnik w profilu konta', domain ? { domain } : {}));
      out.edge({ from: entity.key, to, relation: 'links_account', kind: 'links_to', explanation: `Profil konta wskazuje adres ${url}.`, evidence, retrievedAt });
    }
    if (out.size === 0 && !(entity.meta.urls ?? []).length) out.note({ reason: 'no_results', detail: `Konto ${entity.label}: profil nie podaje odnośników.` });
    return out.done();
  },
};

// ---------- 3. Identyfikator → inne konta, które go publikują ----------

const TYPE_OF: Partial<Record<IdentifierKind, IdentifierType>> = { email: 'email', nick: 'nick', messenger: 'messenger_id' };

const identifierAccounts: Expander = {
  id: 'identyfikator-konta',
  group: 'accounts',
  label: 'Identyfikator → inne konta, które go publikują',
  reads: 'Publiczne profile i publikacje zawierające ten sam e-mail, telefon, nick albo adres strony.',
  provider: 'łączniki źródeł użyte w analizie sprawy (e-mail, nick, komunikator); telefon i strona — indeks własny (lokalnie)',
  legalBasis: `${LEGAL.existingConnectors}; indeks własny — ${LEGAL.local}`,
  produces: ['same_email', 'same_phone', 'same_nick', 'same_url'],
  applies: (entity) => entity.kind === 'identifier' && ['email', 'nick', 'phone', 'url', 'messenger'].includes(entity.identifierKind ?? ''),
  cost: (entity, context) => {
    const type = TYPE_OF[entity.identifierKind!];
    return type ? connectorsFor(type, context).length : 0;
  },
  async run(entity, context) {
    const out = collector(this.id);
    const kind = entity.identifierKind!;
    const value = (entity.value ?? entity.label).trim();
    const type = TYPE_OF[kind];
    let docs: SourceDocument[] = [];
    if (type) {
      for (const connector of connectorsFor(type, context)) docs.push(...(await ask(connector, { type, value }, context, out)));
    } else {
      const phrases = kind === 'phone' ? [value, phoneDigits(value)] : [value.replace(/^https?:\/\/(www\.)?/i, '')];
      for (const phrase of [...new Set(phrases)]) {
        try {
          docs.push(
            ...(await context.corpusPhrase(phrase, 30)).map((doc): SourceDocument => ({
              connectorId: doc.connectorId,
              service: doc.service,
              url: doc.url,
              title: doc.title,
              text: doc.text,
              fetchedAt: doc.fetchedAt,
              ...(doc.author ? { author: doc.author } : {}),
              category: doc.category,
              identityMatch: 'name_only',
              matchedIdentifier: { type: 'nick', value: phrase },
              ...(doc.profile ? { profile: doc.profile } : {}),
            })),
          );
        } catch (error) {
          out.error('indeks własny', error);
        }
      }
    }
    docs = [...new Map(docs.map((doc) => [doc.url, doc])).values()].sort((a, b) => a.url.localeCompare(b.url));
    const lower = value.toLowerCase();
    const digits = phoneDigits(value);
    const accept = (doc: SourceDocument): boolean => {
      if (kind === 'email') return (doc.profile?.emails ?? []).some((item) => item.toLowerCase() === lower) || doc.text.toLowerCase().includes(lower);
      if (kind === 'phone') return digits.length >= 9 && ((doc.profile?.phones ?? []).some((item) => phoneDigits(item) === digits) || phoneDigits(doc.text).includes(digits));
      if (kind === 'nick' || kind === 'messenger') return normalize(handleOf(doc) ?? '') === normalize(value.replace(/^@/, ''));
      return doc.text.toLowerCase().includes(lower.replace(/^https?:\/\/(www\.)?/, ''));
    };
    const relation = kind === 'email' ? 'same_email' : kind === 'phone' ? 'same_phone' : kind === 'url' ? 'same_url' : 'same_nick';
    for (const doc of docs) {
      if (out.size >= PER_EXPANDER_LIMIT) {
        out.note({ reason: 'node_limit', detail: `Identyfikator „${value}”: pokazano ${PER_EXPANDER_LIMIT} kont, pozostałe pominięto.` });
        break;
      }
      if (!accept(doc)) continue;
      const node = accountNode(doc, context);
      if (!node || node.id === entity.key) continue;
      const existing = out.done().nodes.find((item) => item.id === node.id);
      if (existing) mergeMeta(existing, node.meta ?? {});
      const to = out.node(node);
      out.edge({
        from: entity.key,
        to,
        relation,
        kind: 'found_profile',
        explanation:
          relation === 'same_nick'
            ? `Konto ${node.label} w serwisie ${doc.service} używa tej samej nazwy „${value}” — zbieżność nazwy, nie ustalenie tożsamości.`
            : `Konto ${node.label} w serwisie ${doc.service} publikuje ten sam ${kind === 'email' ? 'adres e-mail' : kind === 'phone' ? 'numer telefonu' : 'adres strony'} „${value}”.`,
        evidence: [...docEvidence(doc), { kind: 'attribute', value: `${kind}: ${value}` }],
        retrievedAt: isoOf(doc, context),
      });
    }
    if (out.size === 0) out.note({ reason: 'no_results', detail: `Identyfikator „${value}”: źródła nie wskazały innych kont.` });
    return out.done();
  },
};

// ---------- 4. E-mail / strona → domena ----------

const identifierDomain: Expander = {
  id: 'identyfikator-domena',
  group: 'accounts',
  label: 'E-mail lub strona → domena',
  reads: 'Zapis identyfikatora (część po „@” albo nazwa hosta); domeny poczty ogólnodostępnej są pomijane.',
  provider: 'obliczenie lokalne',
  legalBasis: LEGAL.local,
  produces: ['email_domain'],
  applies: (entity) => entity.kind === 'identifier' && (entity.identifierKind === 'email' || entity.identifierKind === 'url'),
  cost: () => 0,
  async run(entity, context) {
    const out = collector(this.id);
    const value = (entity.value ?? entity.label).trim();
    const domain = domainOf(value, entity.identifierKind === 'email' ? 'email' : 'url');
    if (!domain) {
      out.note({ reason: 'not_applicable', detail: `„${value}”: domena poczty ogólnodostępnej albo brak domeny — nic nie mówi o właścicielu.` });
      return out.done();
    }
    const to = out.node(identifierNode('domain', domain, 'domena', { domain, ...(entity.meta.synthetic ? { synthetic: true } : {}) }));
    out.edge({ from: entity.key, to, relation: 'email_domain', kind: 'links_to', explanation: `Domena wynika z zapisu „${value}”.`, evidence: [{ kind: 'attribute', value: `domena: ${domain}` }], retrievedAt: context.now().toISOString() });
    return out.done();
  },
};

// ---------- 5. Domena → kontakty opublikowane na oficjalnej stronie ----------

const domainSite: Expander = {
  id: 'domena-strona',
  group: 'accounts',
  label: 'Domena → kontakty opublikowane na stronie domeny',
  reads: 'Strona główna domeny (jedna strona, robots.txt respektowany): opublikowane e-maile i telefony.',
  provider: 'łącznik `live-www`',
  legalBasis: LEGAL.www,
  produces: ['site_contact'],
  applies: (entity) => entity.kind === 'identifier' && entity.identifierKind === 'domain',
  cost: () => 2,
  unavailable: (entity, context) =>
    entity.meta.synthetic || context.synthetic
      ? { reason: 'not_applicable', detail: 'Domena z danych demonstracyjnych — strony w internecie nie są pobierane.' }
      : !context.live
        ? { reason: 'not_live', detail: 'Pobranie strony domeny wymaga włączenia źródeł publicznych (ENABLE_LIVE).' }
        : !context.connectors.some((connector) => connector.id === 'live-www')
          ? { reason: 'no_provider', detail: 'Łącznik `live-www` nie jest wybrany w analizie tej sprawy.' }
          : null,
  async run(entity, context) {
    const out = collector(this.id);
    const domain = canonicalValue('domain', entity.value ?? entity.label);
    const www = context.connectors.find((connector) => connector.id === 'live-www')!;
    for (const doc of await ask(www, { type: 'profile_url', value: `https://${domain}/` }, context, out)) {
      const emails = [...new Set([...(doc.profile?.emails ?? []), ...(doc.text.match(EMAIL) ?? [])].map((item) => item.toLowerCase()))].filter((email) => email.endsWith(`@${domain}`) || (doc.profile?.emails ?? []).includes(email));
      for (const email of emails.slice(0, 6)) {
        const to = out.node(identifierNode('email', email, 'kontakt na stronie domeny'));
        out.edge({ from: entity.key, to, relation: 'site_contact', kind: 'links_to', explanation: `Strona ${doc.url} publikuje adres e-mail ${email}.`, evidence: [...docEvidence(doc), { kind: 'attribute', value: `e-mail: ${email}` }], retrievedAt: isoOf(doc, context) });
      }
      for (const phone of (doc.profile?.phones ?? []).slice(0, 4)) {
        if (phoneDigits(phone).length < 9) continue;
        const to = out.node(identifierNode('phone', phone, 'kontakt na stronie domeny'));
        out.edge({ from: entity.key, to, relation: 'site_contact', kind: 'links_to', explanation: `Strona ${doc.url} publikuje numer telefonu ${phone}.`, evidence: [...docEvidence(doc), { kind: 'attribute', value: `telefon: ${phone}` }], retrievedAt: isoOf(doc, context) });
      }
    }
    if (out.size === 0) out.note({ reason: 'no_results', detail: `Strona domeny ${domain}: brak opublikowanych kontaktów (albo robots.txt nie pozwala jej pobrać).` });
    return out.done();
  },
};

// ---------- 6. Domena → abonent domeny (RDAP) ----------

const domainRdap: Expander = {
  id: 'domena-rdap',
  group: 'organizations',
  label: 'Domena → organizacja abonenta (RDAP)',
  reads: 'Dane rejestracyjne domeny z rejestru (RDAP): nazwa organizacji abonenta, jeśli rejestr ją publikuje.',
  provider: 'RDAP rejestru domeny (adres z pliku IANA)',
  legalBasis: LEGAL.rdap,
  produces: ['rdap_registrant'],
  applies: (entity) => entity.kind === 'identifier' && entity.identifierKind === 'domain',
  cost: () => 2,
  unavailable: (entity, context) =>
    entity.meta.synthetic || context.synthetic
      ? { reason: 'not_applicable', detail: 'Domena z danych demonstracyjnych — rejestr domen nie jest pytany.' }
      : !context.live
        ? { reason: 'not_live', detail: 'Zapytanie RDAP wysyła nazwę domeny do rejestru — wymaga włączenia źródeł publicznych (ENABLE_LIVE).' }
        : !context.rdap
          ? { reason: 'no_provider', detail: 'Klient RDAP nie jest skonfigurowany.' }
          : null,
  async run(entity, context) {
    const out = collector(this.id);
    const domain = canonicalValue('domain', entity.value ?? entity.label);
    if (!context.reserve()) {
      out.note({ reason: 'budget', detail: `Budżet zapytań wyczerpany — nie zapytano RDAP o ${domain}.`, skipped: 1 });
      return out.done();
    }
    out.count(2);
    try {
      const record = await context.rdap!.lookup(domain, context.signal);
      if (!record) {
        out.note({ reason: 'no_provider', detail: `Dla domeny ${domain} plik IANA nie wskazuje rejestru RDAP.` });
      } else if (!record.organization) {
        out.note({ reason: 'no_results', detail: `RDAP (${record.url}): dane abonenta ${record.redacted ? 'zredagowane przez rejestr (RODO)' : 'nie podane'}${record.registrar ? `; rejestrator: ${record.registrar}` : ''}.` });
      } else {
        const to = out.node({ id: organizationKey(record.organization), kind: 'organization', label: record.organization, sublabel: `abonent domeny ${domain} według RDAP${record.country ? ` (${record.country})` : ''}`, status: 'source_fact', entityKind: 'organization', meta: { domain }, url: record.url });
        out.edge({
          from: entity.key,
          to,
          relation: 'rdap_registrant',
          kind: 'links_to',
          explanation: `Rejestr domen podaje „${record.organization}” jako abonenta domeny ${domain}${record.registrar ? ` (rejestrator: ${record.registrar})` : ''}.`,
          evidence: [{ kind: 'url', value: record.url }, { kind: 'attribute', value: `abonent: ${record.organization}` }],
          retrievedAt: record.retrievedAt,
        });
      }
    } catch (error) {
      out.error('RDAP', error);
    }
    return out.done();
  },
};

// ---------- 7. Adres → ten sam portfel, wspólny adres wpłat, kontrahenci ----------

const addressFlows: Expander = {
  id: 'adres-przeplywy',
  group: 'flows',
  label: 'Adres → ten sam portfel, wspólny adres wpłat, bezpośredni kontrahenci',
  reads: 'Aktywność adresu w blockchainie: heurystyki portfela, powiązania modułu blockchain i przelewy (najwięksi kontrahenci).',
  provider: 'zapisana aktywność z teczki; dla nowego adresu — dostawcy danych blockchain (@olcys/chain)',
  legalBasis: `${LEGAL.dossier}; ${LEGAL.chain}`,
  produces: ['same_wallet', 'co_depositor', 'counterparty'],
  applies: (entity) => entity.kind === 'crypto_address',
  cost: (entity, context) => (findingOf(entity, context)?.chain ? 0 : 1),
  unavailable: (entity, context) =>
    findingOf(entity, context)?.chain || context.chainProviders.some((provider) => provider.supports(entity.meta.network as never, entity.meta.address ?? ''))
      ? null
      : { reason: 'no_provider', detail: `Brak dostawcy danych blockchain dla sieci ${entity.meta.network}.` },
  async run(entity, context) {
    const out = collector(this.id);
    const network = entity.meta.network!;
    const address = entity.meta.address!;
    let activity: ChainActivity | undefined = findingOf(entity, context)?.chain;
    if (!activity) {
      if (!context.reserve()) {
        out.note({ reason: 'budget', detail: `Budżet zapytań wyczerpany — nie pobrano aktywności adresu ${shortAddress(address)}.`, skipped: 1 });
        return out.done();
      }
      out.count();
      const connectorContext = { log: (message: string) => context.log(`[blockchain] ${message}`), ...(context.signal ? { signal: context.signal } : {}) };
      try {
        const supported = context.chainProviders.filter((provider) => provider.supports(network as never, address));
        activity = context.resolveActivity ? await context.resolveActivity(supported, network as never, address, connectorContext) : await supported[0]?.getActivity(network as never, address, connectorContext);
      } catch (error) {
        out.error('dane blockchain', error);
      }
    }
    if (!activity) {
      out.note({ reason: 'no_results', detail: `Brak danych blockchain dla adresu ${shortAddress(address)}.` });
      return out.done();
    }
    const retrievedAt = context.now().toISOString();
    const synthetic = entity.meta.synthetic || context.synthetic ? { synthetic: true } : {};
    const seen = new Set<string>([address.toLowerCase()]);
    for (const item of (activity.cluster?.addresses ?? []).slice(0, PER_EXPANDER_LIMIT)) {
      if (seen.has(item.address.toLowerCase())) continue;
      seen.add(item.address.toLowerCase());
      const to = out.node(addressNode(`${network}:${item.address}`, 'ten sam portfel (heurystyka) — adres, nie osoba', synthetic)!);
      out.edge({ from: entity.key, to, relation: 'same_wallet', kind: 'related', layer: 'chain', explanation: `Adres zaliczony do tego samego portfela heurystyką: ${item.reason}.`, evidence: [{ kind: 'address', value: item.address }, ...(item.txid ? [{ kind: 'txid' as const, value: item.txid }] : [])], retrievedAt });
    }
    for (const link of linkedAddressesOf(activity).slice(0, PER_EXPANDER_LIMIT)) {
      if (seen.has(link.address.toLowerCase())) continue;
      seen.add(link.address.toLowerCase());
      const relation = link.kind === 'co_depositor' ? 'co_depositor' : link.kind === 'same_wallet' ? 'same_wallet' : 'counterparty';
      const to = out.node(addressNode(`${network}:${link.address}`, relation === 'co_depositor' ? `współwpłacający${link.service ? ` (${link.service})` : ''} — adres, nie osoba` : 'adres powiązany w blockchainie — nie osoba', synthetic)!);
      out.edge({
        from: entity.key,
        to,
        relation,
        kind: relation === 'counterparty' ? 'transfer' : 'related',
        layer: 'chain',
        explanation: link.reason ?? (relation === 'co_depositor' ? `Oba adresy wpłacają na ten sam adres wpłat${link.service ? ` usługi ${link.service}` : ''}${link.via ? ` (${shortAddress(link.via)})` : ''}.` : 'Powiązanie wskazane przez moduł danych blockchain.'),
        evidence: [...link.txids.slice(0, 5).map((value) => ({ kind: 'txid' as const, value })), { kind: 'address', value: link.address }],
        retrievedAt,
      });
    }
    // Najwięksi bezpośredni kontrahenci — wyłącznie jako adresy (darczyńca, klient ≠ osoba ze sprawy).
    const parties = new Map<string, { address: string; amount: number; count: number; asset: string; directions: Set<string>; txids: string[]; label?: string; url: string }>();
    for (const transfer of activity.transfers) {
      if (!transfer.counterparty || seen.has(transfer.counterparty.toLowerCase())) continue;
      const entry = parties.get(transfer.counterparty) ?? { address: transfer.counterparty, amount: 0, count: 0, asset: transfer.asset, directions: new Set<string>(), txids: [], ...(transfer.counterpartyLabel ? { label: transfer.counterpartyLabel } : {}), url: transfer.explorerUrl };
      entry.amount += transfer.amount;
      entry.count += 1;
      entry.directions.add(transfer.direction);
      entry.txids.push(transfer.txid);
      parties.set(transfer.counterparty, entry);
    }
    const top = [...parties.values()].sort((a, b) => b.amount - a.amount || a.address.localeCompare(b.address));
    for (const party of top.slice(0, COUNTERPARTY_LIMIT)) {
      if (!validateAddress(party.address)) continue;
      const to = out.node(addressNode(`${network}:${party.address}`, party.label ? `kontrahent z etykietą: ${party.label}` : 'kontrahent przelewu — anonimowy adres, nie osoba', synthetic)!);
      const both = party.directions.size > 1;
      const incoming = !both && party.directions.has('in');
      out.edge({
        from: incoming ? to : entity.key,
        to: incoming ? entity.key : to,
        relation: 'counterparty',
        kind: 'transfer',
        layer: 'chain',
        label: `${party.count} przel.${both ? ' w obie strony' : ''}, ${party.amount.toLocaleString('pl-PL', { maximumFractionDigits: 8 })} ${party.asset}`,
        explanation: `Przelewy zapisane w blockchainie (${party.count}). Kontrahent jest tylko adresem — nadawca lub odbiorca może być dowolną osobą (darczyńca, klient, usługa).`,
        evidence: [...party.txids.slice(0, 5).map((value) => ({ kind: 'txid' as const, value })), { kind: 'url', value: party.url }],
        retrievedAt,
      });
    }
    if (top.length > COUNTERPARTY_LIMIT) out.note({ reason: 'node_limit', detail: `Adres ${shortAddress(address)}: pokazano ${COUNTERPARTY_LIMIT} największych z ${top.length} kontrahentów.`, skipped: top.length - COUNTERPARTY_LIMIT });
    if (out.size === 0) out.note({ reason: 'no_results', detail: `Adres ${shortAddress(address)}: brak powiązanych adresów i kontrahentów w pobranych danych.` });
    return out.done();
  },
};

const findingOf = (entity: Entity, context: ExpandContext) =>
  context.findings.find((finding) => finding.network === entity.meta.network && finding.address.toLowerCase() === (entity.meta.address ?? '').toLowerCase());

// ---------- 8. Adres → publikacje, które go cytują ----------

const addressPublications: Expander = {
  id: 'adres-publikacje',
  group: 'publications',
  label: 'Adres → publikacje, które go cytują, i ich autorzy',
  reads: 'Publiczne publikacje zawierające pełny adres; autor publikacji jako konto (nie jako osoba).',
  provider: 'łączniki źródeł użyte w analizie sprawy (wyszukiwanie po adresie)',
  legalBasis: LEGAL.existingConnectors,
  produces: ['cited_in', 'authored', 'publishes_identifier'],
  applies: (entity) => entity.kind === 'crypto_address',
  cost: (_entity, context) => connectorsFor('crypto_address', context).length,
  async run(entity, context) {
    const out = collector(this.id);
    const address = entity.meta.address!;
    const docs: SourceDocument[] = [];
    for (const connector of connectorsFor('crypto_address', context)) docs.push(...(await ask(connector, { type: 'crypto_address', value: address }, context, out)));
    const unique = [...new Map(docs.map((doc) => [doc.url, doc])).values()].filter((doc) => doc.text.toLowerCase().includes(address.toLowerCase())).sort((a, b) => a.url.localeCompare(b.url));
    for (const doc of unique.slice(0, PER_EXPANDER_LIMIT)) {
      const retrievedAt = isoOf(doc, context);
      const docNode = out.node({
        id: documentKey(doc.url),
        kind: 'source',
        label: doc.title || doc.service,
        sublabel: `publikacja w ${doc.service}${doc.publishedAt ? ` z ${doc.publishedAt.slice(0, 10)}` : ''}; pozyskano ${retrievedAt.slice(0, 10)}`,
        url: doc.url,
        status: 'source_fact',
        entityKind: 'document',
        ...(isSyntheticConnector(doc.connectorId) ? { meta: { synthetic: true } } : {}),
      });
      out.edge({ from: entity.key, to: docNode, relation: 'cited_in', kind: 'documented_by', label: 'adres w publikacji', explanation: `Publikacja „${doc.title}” zawiera ten adres.`, evidence: docEvidence(doc), retrievedAt });
      const account = accountNode(doc, context);
      if (!account) continue;
      const to = out.node(account);
      out.edge({ from: to, to: docNode, relation: 'authored', kind: 'documented_by', explanation: `Autor publikacji według serwisu ${doc.service}: ${account.label}.`, evidence: docEvidence(doc), retrievedAt });
      const owns = OWNERSHIP_CATEGORIES.includes(doc.category);
      out.edge({
        from: to,
        to: entity.key,
        relation: owns ? 'publishes_identifier' : 'cited_in',
        kind: owns ? 'publishes' : 'links_to',
        label: owns ? 'publikuje adres jako własny' : 'wymienia adres w publikacji',
        explanation: owns
          ? `Konto ${account.label} publikuje adres w ${doc.category === 'sale_offer' ? 'ogłoszeniu' : 'publikacji własnej'} — deklaracja autora, nie dowód dysponowania kluczem.`
          : `Konto ${account.label} wymienia adres w publikacji (np. wpis na forum) — to nie deklaracja własności.`,
        evidence: [...docEvidence(doc), { kind: 'address', value: address }],
        retrievedAt,
      });
    }
    if (unique.length > PER_EXPANDER_LIMIT) out.note({ reason: 'node_limit', detail: `Adres ${shortAddress(address)}: pokazano ${PER_EXPANDER_LIMIT} z ${unique.length} publikacji.`, skipped: unique.length - PER_EXPANDER_LIMIT });
    if (unique.length === 0) out.note({ reason: 'no_results', detail: `Adres ${shortAddress(address)}: źródła nie wskazały publikacji.` });
    return out.done();
  },
};

// ---------- 9. Publikacja → identyfikatory wymienione w tej samej publikacji ----------

const documentMentions: Expander = {
  id: 'publikacja-wzmianki',
  group: 'publications',
  label: 'Publikacja → identyfikatory wymienione w tej samej treści (słaba poszlaka)',
  reads: 'Zapisana kopia treści publikacji (z analizy albo indeksu własnego): e-maile i adresy kryptowalutowe.',
  provider: 'kopie treści zapisane w analizie i indeks własny (bez zapytań)',
  legalBasis: LEGAL.local,
  produces: ['co_mentioned'],
  applies: (entity) => entity.kind === 'document' && Boolean(entity.value),
  cost: () => 0,
  async run(entity, context) {
    const out = collector(this.id);
    const url = entity.value!;
    let text: string | undefined;
    try {
      text = (await context.documents()).find((doc) => doc.url === url)?.text ?? (await context.corpusDocument(url))?.text;
    } catch (error) {
      out.error('kopie treści', error);
    }
    if (!text) {
      out.note({ reason: 'no_results', detail: `Brak zapisanej kopii treści ${url} — publikacji nie pobierano ponownie.` });
      return out.done();
    }
    const retrievedAt = context.now().toISOString();
    const synthetic = entity.meta.synthetic || context.synthetic ? { synthetic: true } : {};
    const emails = [...new Set((text.match(EMAIL) ?? []).map((item) => item.toLowerCase()))].sort();
    for (const email of emails.slice(0, 6)) {
      const to = out.node(identifierNode('email', email, 'wymieniony w tej samej publikacji', synthetic));
      out.edge({ from: entity.key, to, relation: 'co_mentioned', kind: 'links_to', explanation: `Adres e-mail ${email} występuje w tej samej publikacji — wspólna wzmianka to bardzo słaba przesłanka.`, evidence: [{ kind: 'url', value: url }, { kind: 'attribute', value: `e-mail: ${email}` }], retrievedAt });
    }
    for (const item of extractAddresses(text).slice(0, 6)) {
      const to = out.node(addressNode(`${item.network}:${item.address}`, 'adres wymieniony w tej samej publikacji', synthetic)!);
      out.edge({ from: entity.key, to, relation: 'co_mentioned', kind: 'links_to', explanation: `Adres ${item.address} występuje w tej samej publikacji — wspólna wzmianka to bardzo słaba przesłanka.`, evidence: [{ kind: 'url', value: url }, { kind: 'address', value: item.address }], retrievedAt });
    }
    if (out.size === 0) out.note({ reason: 'no_results', detail: 'Publikacja nie wymienia innych identyfikatorów.' });
    return out.done();
  },
};

// ---------- 10. Organizacja → osoby w rolach, jednostka dominująca, spółki zależne ----------

const organizationRegistries: Expander = {
  id: 'organizacja-rejestry',
  group: 'organizations',
  label: 'Organizacja → osoby w rolach, jednostka dominująca, spółki zależne (rejestry)',
  reads: 'Wpisy rejestrów publicznych (KRS, Wikidata, GLEIF) po identyfikatorach organizacji; sama zgodna nazwa nie rozwija osób.',
  provider: 'moduł sieci organizacji (org-network.ts)',
  legalBasis: LEGAL.registries,
  produces: ['holds_role', 'org_parent', 'shared_officer'],
  applies: (entity) => entity.kind === 'organization',
  cost: () => 6,
  unavailable: (entity, context) =>
    entity.meta.synthetic || context.synthetic
      ? { reason: 'not_applicable', detail: 'Organizacja z danych demonstracyjnych — prawdziwe rejestry nie są pytane.' }
      : !context.live
        ? { reason: 'not_live', detail: 'Zapytania do rejestrów organizacji wymagają włączenia źródeł publicznych (ENABLE_LIVE).' }
        : !context.organizations
          ? { reason: 'no_provider', detail: 'Moduł sieci organizacji nie jest dostępny.' }
          : null,
  async run(entity, context) {
    const out = collector(this.id);
    const fromId = (prefix: string) => (entity.key.startsWith(prefix) ? entity.key.slice(prefix.length).split(':')[0] : undefined);
    const krs = entity.meta.registry?.krs ?? fromId('org:krs:');
    const lei = entity.meta.registry?.lei ?? fromId('org:lei:');
    const wikidata = entity.meta.registry?.wikidata ?? fromId('org:wikidata:');
    let used = 0;
    let result;
    try {
      result = await context.organizations!.expand(
        { name: entity.label, ...(entity.meta.domain ? { domain: entity.meta.domain } : {}), ...(krs ? { krs } : {}), ...(lei ? { lei } : {}), ...(wikidata ? { wikidata } : {}), origin: `rozwinięcie węzła ${entity.label}` },
        { reserve: () => (context.reserve() ? (used++, true) : false), log: context.log, ...(context.signal ? { signal: context.signal } : {}) },
      );
    } catch (error) {
      out.error('rejestry organizacji', error);
      return out.done();
    } finally {
      out.count(used);
    }
    // Organizacja wskazana przez analityka = pierwszy podmiot rozpoznany po identyfikatorze albo domenie.
    const alias = new Map<string, string>();
    const seed = result.organizations.find((org) => (org as { seed?: boolean }).seed && org.match !== 'name_only') ?? result.organizations.find((org) => org.match === 'identifier' || org.match === 'domain');
    if (seed) alias.set(seed.id, entity.key);
    for (const org of result.organizations.filter((item) => item.match === 'name_only')) {
      out.note({ reason: 'no_results', detail: `„${org.name}”: zgodna tylko nazwa — wpis możliwy, niepotwierdzony; osób nie rozwijano.` });
    }
    const orgNode = (id: string) => {
      if (alias.has(id)) return alias.get(id)!;
      const org = result.organizations.find((item) => item.id === id);
      if (!org || org.match === 'name_only') return undefined;
      return out.node({ id: org.id, kind: 'organization', label: org.name, sublabel: org.matchNote, status: 'source_fact', entityKind: 'organization', ...(org.sources[0] ? { url: org.sources[0].url } : {}), meta: { registry: { ...(org.identifiers.krs ? { krs: org.identifiers.krs } : {}), ...(org.identifiers.lei ? { lei: org.identifiers.lei } : {}), ...(org.identifiers.wikidata ? { wikidata: org.identifiers.wikidata } : {}) }, ...(org.identifiers.website ? { domain: org.identifiers.website } : {}) } });
    };
    for (const person of result.persons.slice(0, PER_EXPANDER_LIMIT)) {
      const org = orgNode(person.organizationId);
      if (!org) continue;
      const id = person.wikidata ? `person:wikidata:${person.wikidata}` : `person:${person.id}`;
      out.node({ id, kind: 'person', label: person.name, sublabel: `${person.role} — rola w rejestrze${person.masked ? ' (dane zamaskowane przez rejestr)' : ''}; nie własność adresu`, status: 'source_fact', entityKind: 'person', url: person.source.url, ...(person.wikidata ? { meta: { registry: { wikidata: person.wikidata } } } : {}) });
      out.edge({ from: id, to: org, relation: 'holds_role', kind: 'holds_role', label: person.role, explanation: `Według rejestru ${person.source.registry}: ${person.name} — ${person.role}${person.from ? ` od ${person.from}` : ''}${person.to ? ` do ${person.to}` : ''}. Rola w organizacji nie oznacza własności adresu.`, evidence: [{ kind: 'url', value: person.source.url }], retrievedAt: person.source.retrievedAt });
    }
    for (const relation of result.relations) {
      const from = orgNode(relation.from);
      const to = orgNode(relation.to);
      if (!from || !to) continue;
      out.edge({ from, to, relation: relation.kind === 'shared_officer' ? 'shared_officer' : 'org_parent', kind: 'org_relation', label: relation.label, status: relation.status, explanation: relation.explanation, evidence: relation.source ? [{ kind: 'url', value: relation.source.url }] : [{ kind: 'attribute', value: relation.label }], retrievedAt: relation.source?.retrievedAt ?? context.now().toISOString() });
    }
    for (const stop of result.stops.filter((item) => item.reason !== 'depth_limit')) out.note({ reason: stop.reason === 'source_error' ? 'source_error' : stop.reason === 'query_limit' ? 'budget' : 'no_results', detail: stop.detail, ...(stop.skipped ? { skipped: stop.skipped } : {}) });
    if (out.size === 0) out.note({ reason: 'no_results', detail: `„${entity.label}”: rejestry nie wskazały osób ani podmiotów powiązanych.` });
    return out.done();
  },
};

// ---------- 11. Osoba w roli → inne organizacje ----------

const wikidataOf = (entity: Entity) => entity.meta.registry?.wikidata ?? /^person:wikidata:(Q\d+)/.exec(entity.key)?.[1];

const personOrganizations: Expander = {
  id: 'osoba-organizacje',
  group: 'organizations',
  label: 'Osoba w roli → inne organizacje, w których pełni role',
  reads: 'Role osoby w rejestrze Wikidata (założyciel, zarząd, dyrektor) — tylko dla osób rozpoznanych w rejestrze.',
  provider: 'Wikidata (zapytanie SPARQL) przez moduł sieci organizacji',
  legalBasis: LEGAL.registries,
  produces: ['holds_role'],
  applies: (entity) => entity.kind === 'person' && Boolean(wikidataOf(entity)),
  cost: () => 1,
  unavailable: (_entity, context) =>
    !context.live
      ? { reason: 'not_live', detail: 'Zapytanie do Wikidata wymaga włączenia źródeł publicznych (ENABLE_LIVE).' }
      : !context.organizations?.rolesOf
        ? { reason: 'no_provider', detail: 'Moduł sieci organizacji nie jest dostępny.' }
        : null,
  async run(entity, context) {
    const out = collector(this.id);
    let used = 0;
    try {
      const { organizations } = await context.organizations!.rolesOf!({ wikidata: wikidataOf(entity)!, name: entity.label }, { reserve: () => (context.reserve() ? (used++, true) : false), log: context.log, ...(context.signal ? { signal: context.signal } : {}) });
      for (const org of organizations.slice(0, PER_EXPANDER_LIMIT)) {
        const to = out.node({ id: org.id, kind: 'organization', label: org.name, sublabel: 'organizacja, w której osoba pełni rolę (Wikidata)', status: 'source_fact', entityKind: 'organization', url: org.url, meta: { registry: { wikidata: org.id.replace('org:wikidata:', '') } } });
        out.edge({ from: entity.key, to, relation: 'holds_role', kind: 'holds_role', label: org.role, explanation: `Według Wikidata ${entity.label} — ${org.role} w „${org.name}”. Rola nie oznacza własności adresu.`, evidence: [{ kind: 'url', value: org.url }], retrievedAt: org.retrievedAt });
      }
    } catch (error) {
      out.error('Wikidata', error);
    } finally {
      out.count(used);
    }
    if (out.size === 0) out.note({ reason: 'no_results', detail: `${entity.label}: rejestr nie wskazał innych organizacji.` });
    return out.done();
  },
};

// ---------- 12. Byt → wpisy na listach sankcyjnych i listach ryzyka ----------

function sanctionsQuery(entity: Entity, context: ExpandContext): SanctionsQuery {
  const meta = entity.meta;
  const names = entity.kind === 'account' ? [meta.displayName] : entity.kind === 'crypto_address' || entity.kind === 'document' ? [] : entity.kind === 'identifier' && entity.identifierKind !== 'name' ? [] : [entity.value ?? entity.label];
  const addresses = entity.kind === 'crypto_address' ? [{ network: meta.network!, address: meta.address! }] : (meta.addresses ?? []).map((key) => ({ network: key.split(':')[0]!, address: key.split(':').slice(1).join(':') }));
  const identifiers = [
    ...(meta.emails ?? []),
    ...(entity.kind === 'identifier' && entity.identifierKind !== 'name' ? [entity.value ?? entity.label] : []),
    ...Object.values(meta.registry ?? {}).filter((value): value is string => Boolean(value)),
  ];
  return { names: names.filter((name): name is string => Boolean(name && name.trim().length >= 5)), addresses, identifiers, synthetic: Boolean(meta.synthetic || context.synthetic) };
}

const sanctions: Expander = {
  id: 'listy-sankcyjne',
  group: 'sanctions',
  label: 'Byt → wpisy na listach sankcyjnych i listach ryzyka',
  reads: 'Nazwa, adresy kryptowalutowe i identyfikatory bytu porównane z lokalnymi kopiami list (dokładny identyfikator = fakt; sama nazwa = hipoteza).',
  provider: 'listy sankcyjne (OFAC SDN — kopia lokalna; moduł list sankcyjnych; w demonstracji lista syntetyczna)',
  legalBasis: LEGAL.sanctions,
  produces: ['sanctions_hit', 'sanctions_name_match'],
  applies: (entity) => ['subject', 'person', 'organization', 'account', 'crypto_address', 'service'].includes(entity.kind) || (entity.kind === 'identifier' && ['email', 'name', 'domain'].includes(entity.identifierKind ?? '')),
  cost: (entity, context) => providersFor(entity, context).filter((provider) => provider.outbound).length,
  unavailable: (entity, context) => (providersFor(entity, context).length === 0 ? { reason: 'no_provider', detail: 'Brak list sankcyjnych do porównania w tej konfiguracji.' } : null),
  async run(entity, context) {
    const out = collector(this.id);
    const query = sanctionsQuery(entity, context);
    if (query.names.length + query.addresses.length + query.identifiers.length === 0) {
      out.note({ reason: 'not_applicable', detail: `${entity.label}: brak nazwy ani identyfikatorów do porównania z listami.` });
      return out.done();
    }
    const hits: SanctionsHit[] = [];
    for (const provider of providersFor(entity, context)) {
      if (provider.outbound) {
        if (!context.reserve()) {
          out.note({ reason: 'budget', detail: `Budżet zapytań wyczerpany — pominięto listę ${provider.label}.`, skipped: 1 });
          continue;
        }
        out.count();
      }
      try {
        hits.push(...(await provider.screen(query, context)));
      } catch (error) {
        out.error(provider.label, error);
      }
    }
    const retrievedAt = context.now().toISOString();
    for (const hit of hits.sort((a, b) => a.entryId.localeCompare(b.entryId)).slice(0, PER_EXPANDER_LIMIT)) {
      // Ten sam klucz wpisu co w grafie teczki (`sankcje:<lista>:<wpis>`), więc trafienia z teczki i z rozwinięć łączą się.
      const entryKey = hit.listId ? `sankcje:${hit.listId}:${hit.entryId}` : sanctionsEntryKey(hit.list, hit.entryId);
      out.node({
        id: entryKey,
        kind: hit.entryType === 'person' ? 'person' : 'organization',
        label: hit.entryName,
        sublabel: `wpis na liście: ${hit.list}${hit.synthetic ? ' — LISTA SYNTETYCZNA (dane zmyślone, demonstracja)' : ''}`,
        status: 'source_fact',
        entityKind: hit.entryType === 'person' ? 'person' : 'organization',
        ...(hit.url ? { url: hit.url } : {}),
        meta: { sanctioned: { list: hit.list, entryId: hit.entryId, ...(hit.synthetic ? { synthetic: true } : {}) }, ...(hit.synthetic ? { synthetic: true } : {}) },
      });
      const evidence: EdgeDraft['evidence'] = [...(hit.url ? [{ kind: 'url' as const, value: hit.url }] : []), { kind: 'attribute', value: `${hit.list}: ${hit.entryName} (${hit.entryId})${hit.listDate ? `, stan listy ${hit.listDate}` : ''}` }];
      const caution = hit.synthetic ? ' Wpis pochodzi z LISTY SYNTETYCZNEJ piaskownicy — nie jest prawdziwą sankcją.' : ' Potwierdź w aktualnej wersji listy.';
      const matchedAddress = query.addresses.find((item) => item.address.toLowerCase() === hit.matchedValue.toLowerCase());
      if (hit.match === 'identifier' && matchedAddress && entity.kind !== 'crypto_address') {
        // Trafienie dotyczy ADRESU opublikowanego przez konto: fakt dla adresu, konto łączy z nim osobna relacja.
        const node = addressNode(`${matchedAddress.network}:${matchedAddress.address}`, 'adres opublikowany przez konto', query.synthetic ? { synthetic: true } : {});
        if (!node) continue;
        const address = out.node(node);
        out.edge({ from: entity.key, to: address, relation: 'publishes_identifier', kind: 'publishes', label: 'publikuje adres', explanation: `Konto ${entity.label} publikuje adres ${matchedAddress.address} jako własny — deklaracja autora.`, evidence: [{ kind: 'address', value: matchedAddress.address }, ...(entity.url ? [{ kind: 'url' as const, value: entity.url }] : [])], retrievedAt });
        out.edge({ from: address, to: entryKey, relation: 'sanctions_hit', kind: 'documented_by', explanation: `Adres ${matchedAddress.address} figuruje we wpisie „${hit.entryName}” (${hit.list}). Trafienie dotyczy wyłącznie bytu z listy.${caution}`, evidence: [...evidence, { kind: 'address', value: matchedAddress.address }], retrievedAt });
        continue;
      }
      const exact = hit.match === 'identifier';
      out.edge({
        from: entity.key,
        to: entryKey,
        relation: exact ? 'sanctions_hit' : 'sanctions_name_match',
        kind: 'documented_by',
        explanation: exact
          ? `Identyfikator „${hit.matchedValue}” figuruje we wpisie „${hit.entryName}” (${hit.list}). Trafienie dotyczy wyłącznie bytu z listy.${caution}`
          : `Nazwa „${hit.matchedValue}” jest zgodna z wpisem „${hit.entryName}” (${hit.list}) — możliwy imiennik; porównaj identyfikatory.${caution}`,
        evidence,
        retrievedAt,
      });
    }
    if (hits.length === 0) out.note({ reason: 'no_results', detail: `${entity.label}: brak trafień na listach (${providersFor(entity, context).map((provider) => provider.label).join(', ')}).` });
    return out.done();
  },
};

const providersFor = (entity: Entity, context: ExpandContext) =>
  context.sanctions.filter((provider) => (provider.syntheticOnly ? Boolean(entity.meta.synthetic || context.synthetic) : true) && (!provider.outbound || context.live));

/** Wszystkie ekspandery w kolejności wykonania. */
export const EXPANDERS: Expander[] = [
  accountIdentifiers,
  accountLinks,
  identifierDomain,
  identifierAccounts,
  domainSite,
  domainRdap,
  addressFlows,
  addressPublications,
  documentMentions,
  organizationRegistries,
  personOrganizations,
  sanctions,
];
