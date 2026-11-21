// Listy sankcyjne i listy ryzyka jako dostawcy ekspandera „listy sankcyjne”.
//
// Zasada dowodowa: trafienie jest FAKTEM ŹRÓDŁOWYM wyłącznie dla bytu z listy i wyłącznie przy dokładnej
// zgodności identyfikatora (adres kryptowalutowy, numer rejestrowy, e-mail). Zgodna sama nazwa to hipoteza
// (możliwy imiennik). Osoby i konta powiązane z bytem z listy NIE dziedziczą trafienia — ścieżka do podmiotu
// pokazuje status każdego kroku.
//
// Dostawcy:
//   - OFAC SDN — adresy kryptowalutowe z lokalnej kopii (`@olcys/chain`, getDefaultSanctions), bez zapytań;
//   - moduł list sankcyjnych drugiego zespołu (`packages/*/src/sanctions/**`) — podłączany, gdy jest na dysku;
//   - lista SYNTETYCZNA piaskownicy (`/sankcje/api/search`) — tylko dla bytów z danych demonstracyjnych.

import type { ExpandContext } from './expander.ts';

export interface SanctionsQuery {
  names: string[];
  addresses: { network: string; address: string }[];
  /** Inne identyfikatory do dokładnego porównania (e-mail, numer rejestrowy). */
  identifiers: string[];
  /** Byt pochodzi z danych demonstracyjnych. */
  synthetic: boolean;
}

export interface SanctionsHit {
  list: string;
  /** Stały identyfikator listy (np. `ofac-sdn`) — ten sam klucz węzła wpisu co w grafie teczki. */
  listId?: string;
  entryId: string;
  entryName: string;
  entryType: 'person' | 'organization' | 'other';
  match: 'identifier' | 'name';
  /** Wartość, która się zgodziła (adres, nazwa, identyfikator). */
  matchedValue: string;
  url?: string;
  listDate?: string;
  programs?: string[];
  /** Wpis z listy syntetycznej (demonstracja) — nie jest prawdziwą listą sankcyjną. */
  synthetic?: boolean;
}

export interface SanctionsProvider {
  id: string;
  label: string;
  legalBasis: string;
  /** Czy zapytanie wychodzi poza system (wymaga ENABLE_LIVE). */
  outbound: boolean;
  /** Działa tylko dla bytów z danych demonstracyjnych. */
  syntheticOnly?: boolean;
  screen(query: SanctionsQuery, context: Pick<ExpandContext, 'signal' | 'log'>): Promise<SanctionsHit[]>;
}

/** Nazwa do porównań: małe litery, bez znaków diakrytycznych, form prawnych i interpunkcji. */
export function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ł/g, 'l')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(sp\.? ?z ?o\.? ?o\.?|s\.? ?a\.?|ltd\.?|llc|inc\.?|gmbh|limited|corp\.?|co\.?)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** OFAC SDN: adresy kryptowalutowe z lokalnej kopii listy (sprawdzenie bez zapytań). */
export async function createOfacProvider(): Promise<SanctionsProvider | null> {
  let list: { source: string; fetchedAt?: string; size: number; lookup(address: string): { address: string; asset: string; entity: string } | undefined } | undefined;
  try {
    const chain = (await import('@olcys/chain')) as { getDefaultSanctions?: () => typeof list };
    list = chain.getDefaultSanctions?.();
  } catch {
    list = undefined;
  }
  if (!list) return null;
  const sdn = list;
  return {
    id: 'ofac-sdn',
    label: 'OFAC SDN — adresy kryptowalutowe (kopia lokalna)',
    legalBasis: 'docs/ZRODLA-PODSTAWA-PRAWNA.md, rozdz. 4 — OFAC SDN (kopia lokalna)',
    outbound: false,
    async screen(query) {
      const hits: SanctionsHit[] = [];
      for (const item of query.addresses) {
        const entry = sdn.lookup(item.address);
        if (!entry) continue;
        hits.push({
          list: 'OFAC SDN',
          entryId: `${entry.asset}:${entry.address}`,
          entryName: entry.entity,
          entryType: 'other',
          match: 'identifier',
          matchedValue: item.address,
          url: 'https://sanctionssearch.ofac.treas.gov/',
          ...(sdn.fetchedAt ? { listDate: sdn.fetchedAt.slice(0, 10) } : {}),
        });
      }
      return hits;
    },
  };
}

/**
 * Lista SYNTETYCZNA piaskownicy (apps/sandbox, `/sankcje/api/search?q=`). Wpisy są zmyślone i oznaczone;
 * dostawca odpowiada wyłącznie dla bytów pochodzących z danych demonstracyjnych.
 */
export function createSandboxSanctionsProvider(sandboxUrl: string, doFetch: typeof fetch = globalThis.fetch): SanctionsProvider {
  const base = sandboxUrl.replace(/\/+$/, '');
  return {
    id: 'sandbox-sankcje',
    label: 'Lista sankcyjna SYNTETYCZNA (piaskownica — dane zmyślone)',
    legalBasis: 'dane syntetyczne piaskownicy — bez zapytań do prawdziwych list',
    outbound: false,
    syntheticOnly: true,
    async screen(query, context) {
      const hits: SanctionsHit[] = [];
      const seen = new Set<string>();
      const values = [...query.addresses.map((item) => item.address), ...query.identifiers, ...query.names].filter(Boolean).slice(0, 12);
      for (const value of values) {
        let rows: Record<string, unknown>[] = [];
        try {
          const response = await doFetch(`${base}/sankcje/api/search?q=${encodeURIComponent(value)}`, context.signal ? { signal: context.signal } : {});
          if (!response.ok) continue;
          rows = (await response.json()) as Record<string, unknown>[];
        } catch (error) {
          context.log(`Lista syntetyczna piaskownicy nie odpowiedziała: ${error instanceof Error ? error.message : String(error)}.`);
          return hits;
        }
        for (const row of Array.isArray(rows) ? rows : []) {
          const entryId = String(row.id ?? '');
          const key = `${entryId}|${value}`;
          if (!entryId || seen.has(key)) continue;
          seen.add(key);
          hits.push({
            list: String(row.list ?? 'Lista syntetyczna (piaskownica)'),
            entryId,
            entryName: String(row.name ?? entryId),
            entryType: row.type === 'person' ? 'person' : row.type === 'organization' ? 'organization' : 'other',
            match: row.matchedBy === 'name' ? 'name' : 'identifier',
            matchedValue: value,
            url: `${base}/sankcje/wpis/${encodeURIComponent(entryId)}`,
            ...(typeof row.listedAt === 'string' ? { listDate: row.listedAt } : {}),
            ...(Array.isArray(row.programs) ? { programs: (row.programs as unknown[]).map(String) } : {}),
            synthetic: true,
          });
        }
      }
      return hits;
    },
  };
}

/**
 * Adapter modułu list sankcyjnych drugiego zespołu: szuka w pakietach funkcji dopasowującej i normalizuje jej
 * wynik. Brak modułu = brak dostawcy (rozwinięcie pokaże powód zatrzymania). Kształt wyniku czytany ostrożnie.
 */
export async function discoverSanctionsModules(): Promise<SanctionsProvider[]> {
  const providers: SanctionsProvider[] = [];
  const names = ['screenSanctions', 'matchSanctions', 'screenEntity', 'checkSanctions'];
  for (const specifier of ['@olcys/sources', '@olcys/chain', '@olcys/core']) {
    let module: Record<string, unknown>;
    try {
      module = (await import(specifier)) as Record<string, unknown>;
    } catch {
      continue;
    }
    const name = names.find((item) => typeof module[item] === 'function');
    if (!name) continue;
    const screen = module[name] as (input: unknown) => unknown;
    providers.push({
      id: `sankcje:${specifier}`,
      label: 'Oficjalne listy sankcyjne i ostrzeżeń (migawki lokalne modułu list ryzyka)',
      legalBasis: 'docs/ZRODLA-PODSTAWA-PRAWNA.md — oficjalne listy sankcyjne i ostrzeżeń (moduł list ryzyka, sprawdzenie lokalne)',
      outbound: false,
      async screen(query) {
        const raw = await Promise.resolve(screen({ names: query.names, addresses: query.addresses, identifiers: query.identifiers }));
        const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { hits?: unknown })?.hits) ? ((raw as { hits: unknown[] }).hits) : [];
        return rows.flatMap((row): SanctionsHit[] => {
          const item = row as Record<string, unknown>;
          const entry = (item.entry ?? item) as Record<string, unknown>;
          const entryName = String(entry.name ?? entry.entryName ?? item.name ?? '');
          const entryId = String(entry.id ?? entry.entryId ?? item.entryId ?? entryName);
          if (!entryName) return [];
          const kind = String(item.match ?? item.matchType ?? item.matchedBy ?? 'name');
          return [
            {
              list: String(item.list ?? entry.list ?? item.source ?? entry.source ?? 'lista sankcyjna'),
              ...(typeof item.listId === 'string' ? { listId: item.listId } : {}),
              entryId,
              entryName,
              entryType: entry.type === 'person' || entry.type === 'individual' ? 'person' : entry.type === 'organization' || entry.type === 'entity' ? 'organization' : 'other',
              match: /address|identifier|exact|id/i.test(kind) && !/name|fuzzy/i.test(kind) ? 'identifier' : 'name',
              matchedValue: String(item.matchedValue ?? item.value ?? item.query ?? entryName),
              ...(typeof (item.url ?? entry.url) === 'string' ? { url: String(item.url ?? entry.url) } : {}),
              ...(typeof item.listDate === 'string' ? { listDate: item.listDate } : {}),
              ...(Array.isArray(item.programs) ? { programs: (item.programs as unknown[]).map(String) } : {}),
            },
          ];
        });
      },
    });
  }
  return providers;
}
