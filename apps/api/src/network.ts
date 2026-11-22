// „Siatka adresu”: kto wpłacał i dokąd wypływały środki — ZBIORCZO, z samych danych blockchain zapisanych
// w analizie (bez nowych zapytań). Wpłacający nie są kontami właściciela (darczyńcy, klienci), więc teczka
// nie tworzy dla nich osób: pokazuje liczby, największych kontrahentów i punkty zapytania (usługi, które znają
// nadawców albo właściciela konta odbiorcy).

import type { Finding, GraphEdge, GraphNode, ServiceLink } from '@olcys/core';
import { formatAmount, plural, roundPln, shortAddress } from './format.ts';
import type { RelatedAddress } from './provenance.ts';

/** Ilu największych kontrahentów pokazać w każdą stronę. */
export const NETWORK_TOP = 10;
/** Najwyżej tyle adresów powiązanych heurystyką trafia do grafu (najmocniejsze najpierw). */
export const NETWORK_GRAPH_RELATED = 25;

export interface NetworkCounterparty {
  address: string;
  transfers: number;
  amount: number;
  asset: string;
  /** Nazwa usługi, gdy adres ma publiczną etykietę albo należy do usługi z powiązań. */
  service?: string;
  /** Kontrahenta sprawdzono w publikacjach (limit największych kontrahentów). */
  checkedInPublications?: boolean;
}

/** Usługa po drugiej stronie przelewów — punkt zapytania. */
export interface InquiryPoint {
  service: string;
  kind: string;
  direction: 'in' | 'out';
  transfers: number;
  amount: number;
  asset: string;
  valuePln?: number;
  /** Zdanie dla analityka: co ta usługa wie. */
  note: string;
}

export interface AddressNetworkSide {
  transfers: number;
  counterparties: number;
  amount: number;
  /** Udział kwoty od/do usług z etykietą (0–1). */
  serviceShare: number;
  unlabelledTransfers: number;
  unlabelledAmount: number;
  top: NetworkCounterparty[];
  inquiryPoints: InquiryPoint[];
}

export interface AddressNetwork {
  address: string;
  network: string;
  asset: string;
  /** Pobrane / wszystkie transakcje adresu (historia może być niepełna). */
  coverage: { fetched: number; total?: number; note?: string };
  incoming: AddressNetworkSide;
  outgoing: AddressNetworkSide;
  /** Adresy tego samego portfela i inne powiązania heurystyczne (z `relatedAddresses`). */
  cluster: { sameWallet: number; coDepositors: number; other: number; strongest: { address: string; kind: string; strength: number }[] };
  /** Kontrahentów bez etykiety sprawdzonych w publikacjach i limit tej analizy. */
  publicationCheck: { checked: number; limit?: number };
  /** Zdania dla analityka (po polsku), w kolejności ważności. */
  statements: string[];
  /** Dlaczego wpłacający nie są pokazywani jako osoby. */
  privacyNote: string;
}

export interface NetworkInput {
  finding: Finding;
  serviceLinks: ServiceLink[];
  relatedAddresses?: RelatedAddress[];
  checkedCounterparties?: string[];
  maxCounterparties?: number;
  /** Adres jest zbiórką organizacji — wpłacający to darczyńcy. */
  organization?: string;
}

export const PRIVACY_NOTE =
  'Wpłacający to darczyńcy lub klienci — nie są kontami właściciela. Narzędzie nie tworzy dla nich osób ani profili; ' +
  'nadawców zna wyłącznie usługa, z której wysłano środki (punkt zapytania).';

const round8 = (value: number) => Math.round(value * 1e8) / 1e8;

function side(finding: Finding, direction: 'in' | 'out', serviceLinks: ServiceLink[], checked: Set<string>): AddressNetworkSide {
  const asset = finding.chain?.profile.nativeAsset ?? '';
  const transfers = (finding.chain?.transfers ?? []).filter((item) => item.direction === direction && item.asset === asset);
  // Przelewy przypisane usługom (z etykiet, listy usług i wnioskowania o adresach wpłat).
  const serviceOf = new Map<string, ServiceLink>();
  for (const link of serviceLinks) {
    for (const transfer of link.transfers) {
      if (transfer.direction === direction && transfer.subjectAddress === finding.address) serviceOf.set(`${transfer.txid}|${transfer.viaAddress ?? transfer.serviceAddress}`, link);
    }
  }
  const linkFor = (txid: string, counterparty: string) => serviceOf.get(`${txid}|${counterparty}`);
  const byParty = new Map<string, NetworkCounterparty>();
  const points = new Map<string, InquiryPoint>();
  let unlabelledTransfers = 0;
  let unlabelledAmount = 0;
  let serviceAmount = 0;
  for (const transfer of transfers) {
    const link = linkFor(transfer.txid, transfer.counterparty);
    const service = link?.name ?? (transfer.counterpartyClass === 'exchange' || transfer.counterpartyClass === 'mixer' ? transfer.counterpartyLabel ?? 'usługa bez nazwy' : undefined);
    const party = byParty.get(transfer.counterparty) ?? { address: transfer.counterparty, transfers: 0, amount: 0, asset, ...(service ? { service } : {}) };
    party.transfers++;
    party.amount = round8(party.amount + transfer.amount);
    if (checked.has(`${finding.network}:${transfer.counterparty}`)) party.checkedInPublications = true;
    byParty.set(transfer.counterparty, party);
    if (service) {
      serviceAmount += transfer.amount;
      const point = points.get(service) ?? { service, kind: link?.kind ?? transfer.counterpartyClass, direction, transfers: 0, amount: 0, asset, note: '' };
      point.transfers++;
      point.amount = round8(point.amount + transfer.amount);
      const pln = link?.transfers.find((item) => item.txid === transfer.txid)?.valuePln;
      if (pln !== undefined) point.valuePln = Math.round(((point.valuePln ?? 0) + pln) * 100) / 100;
      points.set(service, point);
    } else {
      unlabelledTransfers++;
      unlabelledAmount += transfer.amount;
    }
  }
  const amount = round8(transfers.reduce((sum, item) => sum + item.amount, 0));
  const inquiryPoints = [...points.values()]
    .map((point) => ({
      ...point,
      // Wartość w PLN z powiązania z usługą, gdy wyceniono przelewy.
      ...(point.valuePln === undefined && direction === 'out' ? (() => {
        const link = serviceLinks.find((item) => item.name === point.service);
        return link?.outPln !== undefined && link.transfersOut === point.transfers ? { valuePln: link.outPln } : {};
      })() : {}),
    }))
    .map((point) => ({
      ...point,
      note:
        direction === 'in'
          ? `${point.transfers} ${plural(point.transfers, 'wpłata', 'wpłaty', 'wpłat')} z ${point.service} (${formatAmount(point.amount)} ${asset}) — ${point.service} zna nadawców (dane klientów, którzy zlecili wypłatę na ten adres).`
          : `${point.transfers} ${plural(point.transfers, 'przelew', 'przelewy', 'przelewów')} do ${point.service} (${formatAmount(point.amount)} ${asset}${point.valuePln !== undefined ? `, ok. ${roundPln(point.valuePln)}` : ''}) — ${point.service} zna właściciela konta, na które trafiały środki.`,
    }))
    .sort((a, b) => b.amount - a.amount);
  return {
    transfers: transfers.length,
    counterparties: byParty.size,
    amount,
    serviceShare: amount > 0 ? Math.round((serviceAmount / amount) * 1000) / 1000 : 0,
    unlabelledTransfers,
    unlabelledAmount: round8(unlabelledAmount),
    top: [...byParty.values()].sort((a, b) => b.amount - a.amount).slice(0, NETWORK_TOP),
    inquiryPoints,
  };
}

const pct = (share: number) => `${Math.round(share * 100)}%`;

/** Siatka jednego adresu sprawy z zapisanych danych blockchain; `undefined`, gdy adres nie ma danych z łańcucha. */
export function buildAddressNetwork(input: NetworkInput): AddressNetwork | undefined {
  const { finding } = input;
  const chain = finding.chain;
  if (!chain) return undefined;
  const asset = chain.profile.nativeAsset;
  const checked = new Set(input.checkedCounterparties ?? []);
  const incoming = side(finding, 'in', input.serviceLinks, checked);
  const outgoing = side(finding, 'out', input.serviceLinks, checked);
  const related = input.relatedAddresses ?? [];
  const cluster = {
    sameWallet: related.filter((item) => item.kind === 'same_wallet').length,
    coDepositors: related.filter((item) => item.kind === 'co_depositor').length,
    other: related.filter((item) => item.kind !== 'same_wallet' && item.kind !== 'co_depositor').length,
    strongest: [...related].sort((a, b) => b.strength - a.strength).slice(0, 5).map((item) => ({ address: item.address, kind: item.kind, strength: item.strength })),
  };
  const fetched = chain.transfers.length;
  const partialNote = chain.limitations.find((item) => /pobrano \d+ z \d+ transakcji/.test(item));
  const coverage = { fetched, ...(chain.profile.txCount ? { total: chain.profile.txCount } : {}), ...(partialNote ? { note: partialNote } : {}) };
  const short = shortAddress(finding.address);
  const statements: string[] = [];
  const inPoints = incoming.inquiryPoints;
  const outPoints = outgoing.inquiryPoints;
  statements.push(
    `Wpływy: ${incoming.transfers} ${plural(incoming.transfers, 'przelew', 'przelewy', 'przelewów')} od ${incoming.counterparties} różnych nadawców (${formatAmount(incoming.amount)} ${asset})` +
      `${input.organization ? ` — to wpłaty darczyńców na zbiórkę organizacji „${input.organization}”` : ''}; ` +
      `z usług z etykietą ${pct(incoming.serviceShare)} kwoty, od nadawców bez etykiety ${incoming.unlabelledTransfers} ${plural(incoming.unlabelledTransfers, 'przelew', 'przelewy', 'przelewów')}.`,
  );
  for (const point of inPoints.slice(0, 3)) statements.push(point.note);
  statements.push(
    `Wypływy: ${outgoing.transfers} ${plural(outgoing.transfers, 'przelew', 'przelewy', 'przelewów')} do ${outgoing.counterparties} ${plural(outgoing.counterparties, 'odbiorcy', 'odbiorców', 'odbiorców')} (${formatAmount(outgoing.amount)} ${asset}); ` +
      `do usług z etykietą ${pct(outgoing.serviceShare)} kwoty${outgoing.unlabelledTransfers > 0 ? `, do odbiorców bez etykiety ${outgoing.unlabelledTransfers} ${plural(outgoing.unlabelledTransfers, 'przelew', 'przelewy', 'przelewów')}` : ''}.`,
  );
  for (const point of outPoints.slice(0, 3)) statements.push(point.note);
  if (cluster.sameWallet + cluster.coDepositors + cluster.other > 0) {
    statements.push(
      `Ten sam portfel (heurystyka wspólnych wejść): ${cluster.sameWallet} ${plural(cluster.sameWallet, 'adres', 'adresy', 'adresów')}` +
        `${cluster.coDepositors > 0 ? `; współwpłacający na te same adresy wpłat giełdy: ${cluster.coDepositors}` : ''}` +
        `${cluster.other > 0 ? `; inne powiązania: ${cluster.other}` : ''} — hipotezy z blockchaina, nie ustalenia.`,
    );
  }
  if (coverage.total && coverage.total > fetched) {
    statements.push(`Zestawienie obejmuje pobraną część historii: ${fetched} z ${coverage.total} transakcji adresu ${short} — liczby nadawców i kwot są dolnym oszacowaniem.`);
  }
  const checkedCount = [...checked].filter((key) => key.startsWith(`${finding.network}:`)).length;
  statements.push(
    `W publikacjach sprawdzono ${checkedCount} największych kontrahentów bez etykiety${input.maxCounterparties !== undefined ? ` (limit ${input.maxCounterparties} w tej analizie)` : ''} — grafu nie rozwijamy po wszystkich kontrahentach.`,
  );
  return {
    address: finding.address,
    network: finding.network,
    asset,
    coverage,
    incoming,
    outgoing,
    cluster,
    publicationCheck: { checked: checkedCount, ...(input.maxCounterparties !== undefined ? { limit: input.maxCounterparties } : {}) },
    statements,
    privacyNote: PRIVACY_NOTE,
  };
}

/**
 * Węzły i krawędzie „adres ↔ adres” (warstwa blockchain): adresy tego samego portfela i inne powiązania
 * heurystyczne (status hipotezy) oraz bezpośrednie przelewy między adresami sprawy (fakt źródłowy).
 * Kontrahenci-darczyńcy nie dostają węzłów osób — wyłącznie adresy.
 */
export function addressLinkGraph(findings: (Finding & { relatedAddresses?: RelatedAddress[] })[], existing: { nodes: GraphNode[]; edges: GraphEdge[] }): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const known = new Set(existing.nodes.map((node) => node.id));
  const edgeIds = new Set(existing.edges.map((edge) => edge.id));
  const addressNode = (network: string, address: string, sublabel: string) => {
    const id = `addr:${network}:${address}`;
    if (!known.has(id)) {
      known.add(id);
      nodes.push({ id, kind: 'address', label: shortAddress(address), sublabel, status: 'hypothesis' });
    }
    return id;
  };
  const KIND_TEXT: Record<string, string> = {
    same_wallet: 'ten sam portfel (heurystyka wspólnych wejść)',
    co_depositor: 'wspólny adres wpłat giełdy (heurystyka)',
    funded_by: 'źródło zasilenia adresu (heurystyka)',
    funds: 'adres zasilany z adresu sprawy (heurystyka)',
    repeated_counterparty: 'powtarzający się kontrahent (heurystyka)',
  };
  for (const finding of findings) {
    const from = `addr:${finding.network}:${finding.address}`;
    if (!known.has(from)) continue;
    for (const item of [...(finding.relatedAddresses ?? [])].sort((a, b) => b.strength - a.strength).slice(0, NETWORK_GRAPH_RELATED)) {
      // Zasilenie w którąkolwiek stronę to płatność: sam przelew jest zapisem w blockchainie (fakt),
      // a hipotezą pozostaje dopiero to, czy odbiorca to nowy portfel tej samej osoby, czy ktoś, komu zapłacono.
      if (item.kind === 'funds' || item.kind === 'funded_by') {
        const other = addressNode(finding.network, item.address, item.kind === 'funds' ? 'odbiorca płatności z adresu sprawy' : 'nadawca płatności na adres sprawy');
        const [payer, payee] = item.kind === 'funds' ? [from, other] : [other, from];
        const id = `payment:${payer}->${payee}`;
        if (edgeIds.has(id)) continue;
        edgeIds.add(id);
        const count = item.txids.length;
        edges.push({
          id,
          from: payer,
          to: payee,
          kind: 'payment',
          label: `płatność${count > 1 ? ` (${count} przelewy)` : ''}${item.kind === 'funds' ? ' z adresu sprawy' : ' na adres sprawy'}`,
          weight: item.strength,
          status: 'source_fact',
          layer: 'chain',
          evidence: item.txids.slice(0, 5).map((txid) => ({ kind: 'txid' as const, value: txid })),
          explanation:
            `${item.kind === 'funds' ? 'Adres sprawy zapłacił temu adresowi' : 'Ten adres zapłacił na adres sprawy'} — przelew jest zapisem w blockchainie. ` +
            'Do ustalenia pozostaje, kto jest po drugiej stronie: nowy portfel tej samej osoby czy ktoś, komu zapłacono (hipoteza). ' +
            (item.reason ?? ''),
        });
        continue;
      }
      const to = addressNode(finding.network, item.address, KIND_TEXT[item.kind] ?? item.kind);
      const id = `related:${from}->${to}`;
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      edges.push({
        id,
        from,
        to,
        kind: 'related',
        label: KIND_TEXT[item.kind] ?? item.kind,
        weight: item.strength,
        inferred: true,
        status: 'hypothesis',
        layer: 'chain',
        evidence: item.txids.slice(0, 5).map((txid) => ({ kind: 'txid' as const, value: txid })),
        explanation: item.reason ?? `Powiązanie heurystyczne (${KIND_TEXT[item.kind] ?? item.kind}) — wnioskowanie, nie zapis w blockchainie.`,
      });
    }
  }
  // Bezpośrednie przelewy między adresami obecnymi w sprawie (adres podmiotu, adresy tożsamości i organizacji).
  const caseAddresses = new Map(findings.map((finding) => [`${finding.network}:${finding.address}`, finding]));
  for (const finding of findings) {
    for (const transfer of finding.chain?.transfers ?? []) {
      const other = caseAddresses.get(`${finding.network}:${transfer.counterparty}`);
      if (!other || other === finding) continue;
      const [a, b] = transfer.direction === 'out' ? [finding.address, other.address] : [other.address, finding.address];
      const from = `addr:${finding.network}:${a}`;
      const to = `addr:${finding.network}:${b}`;
      if (!known.has(from) || !known.has(to)) continue;
      const id = `direct:${transfer.txid}:${from}->${to}`;
      if (edgeIds.has(id)) continue;
      edgeIds.add(id);
      edges.push({
        id,
        from,
        to,
        kind: 'transfer',
        label: `${formatAmount(transfer.amount)} ${transfer.asset}`,
        status: 'source_fact',
        layer: 'chain',
        evidence: [{ kind: 'txid', value: transfer.txid }],
        explanation: 'Bezpośredni przelew między adresami sprawy — zapis w blockchainie.',
      });
    }
  }
  return { nodes, edges };
}
