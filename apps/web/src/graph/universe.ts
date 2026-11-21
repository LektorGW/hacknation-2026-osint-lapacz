// „Uniwersum podmiotu” i jego powiązania z giełdami, portfelami i innymi usługami:
// model i deterministyczny układ widoku na ciemnym płótnie — czyste funkcje bez DOM.
import type { Finding, Identifier, ProfileCard, ServiceKind, ServiceLink } from '@olcys/core';

export type UniverseRole = 'subject' | 'identifier' | 'profile' | 'address' | 'service' | 'service-address' | 'bank';
export type Tone = 'ok' | 'attention' | 'unknown' | 'excluded';

export interface UniverseNode {
  id: string;
  role: UniverseRole;
  x: number;
  y: number;
  r: number;
  label: string;
  sublabel?: string;
  /** Pełny opis tekstowy — dla czytników ekranu i podpowiedzi. */
  description: string;
  tone: Tone;
  /** Hub, do którego należy satelita (podświetlanie grupy). */
  hubId?: string;
  serviceKind?: ServiceKind;
  /** Identyfikator obiektu teczki: usługi, profilu albo adres. */
  ref?: string;
  score?: number;
}

export type UniverseEdgeKind = 'out' | 'in' | 'mention' | 'bank' | 'spoke';
export type UniverseTransfer = ServiceLink['transfers'][number];

export interface UniverseEdge {
  id: string;
  kind: UniverseEdgeKind;
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Położenie „pigułki” z kwotą. */
  pill?: { x: number; y: number };
  valuePln?: number;
  /** Sumy w walutach krypto, do podpowiedzi. */
  amounts: Record<string, number>;
  transfers: UniverseTransfer[];
  firstTime?: string;
  lastTime?: string;
  /** Linia przerywana: powiązanie z wnioskowania, nie z faktu. */
  dashed: boolean;
  width: number;
  serviceId?: string;
}

export interface UniverseGraph {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  width: number;
  height: number;
}

export interface UniverseInput {
  name: string;
  identifiers: { identifier: Identifier; origin: 'analyst' | 'discovered' }[];
  profiles: ProfileCard[];
  findings: Finding[];
  services: ServiceLink[];
}

const SUBJECT_R = 46;
const ADDRESS_R = 27;
const SMALL_R = 11;
const SERVICE_R = 38;
const SERVICE_GAP = 172;
const COLUMN_SHIFT = 300;
const ARC = (150 * Math.PI) / 180;
/** Usługi, przez które środki mogą wyjść do walut tradycyjnych. */
const FIAT_KINDS: ServiceKind[] = ['exchange', 'p2p', 'payment_gateway', 'crypto_card'];

const short = (value: string, head = 6, tail = 4) =>
  value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;

/** Punkty równomiernie na łuku o środku `mid` (radiany); jeden punkt trafia w środek łuku. */
function arc(count: number, mid: number, radius: number, cx: number, cy: number, span = ARC) {
  return Array.from({ length: count }, (_, index) => {
    const angle = count === 1 ? mid : mid - span / 2 + (span * index) / (count - 1);
    return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
}

const arcRadius = (count: number, spacing: number, min: number) => Math.max(min, (spacing * (count - 1)) / ARC);

export function buildUniverse(input: UniverseInput): UniverseGraph {
  const nodes: UniverseNode[] = [];
  const edges: UniverseEdge[] = [];
  const services = input.services;

  const findings = [...input.findings].sort(
    (a, b) => Number(a.confidence.excluded) - Number(b.confidence.excluded) || b.confidence.score - a.confidence.score,
  );
  const identities = [
    ...input.profiles.map((profile) => ({ profile, identifier: undefined })),
    ...input.identifiers.map(({ identifier }) => ({ profile: undefined, identifier })),
  ];

  const leftRadius = arcRadius(identities.length, 34, 128);
  const rightRadius = arcRadius(findings.length, 78, 196);
  const subjectX = 70 + leftRadius + 110;
  const serviceX = subjectX + rightRadius + 360;
  // Przy większej liczbie usług huby stoją na przemian w dwóch kolumnach — graf nie rośnie nadmiernie w pionie.
  const zigzag = services.length > 4;
  const rowGap = zigzag ? SERVICE_GAP / 2 : SERVICE_GAP;
  const bankX = serviceX + (zigzag ? COLUMN_SHIFT : 0) + 230;
  const innerHeight = Math.max((services.length - 1) * rowGap + SERVICE_GAP, 2 * Math.max(leftRadius, rightRadius) + 80, 420);
  const padding = 70;
  const cy = padding + innerHeight / 2;

  nodes.push({
    id: 'subject',
    role: 'subject',
    x: subjectX,
    y: cy,
    r: SUBJECT_R,
    label: input.name,
    description: `Badany podmiot: ${input.name}. Profile: ${input.profiles.length}, adresy: ${findings.length}.`,
    tone: 'ok',
  });

  const spoke = (to: UniverseNode): UniverseEdge => ({
    id: `spoke:${to.id}`,
    kind: 'spoke',
    from: to.hubId!,
    to: to.id,
    x1: nodes.find((node) => node.id === to.hubId)!.x,
    y1: nodes.find((node) => node.id === to.hubId)!.y,
    x2: to.x,
    y2: to.y,
    amounts: {},
    transfers: [],
    dashed: false,
    width: 1,
  });
  const addSatellite = (node: UniverseNode) => {
    nodes.push(node);
    edges.push(spoke(node));
  };

  // Lewa strona: tożsamości podmiotu — profile i identyfikatory.
  arc(identities.length, Math.PI, leftRadius, subjectX, cy).forEach((point, index) => {
    const { profile, identifier } = identities[index]!;
    if (profile) {
      const rejected = profile.decision === 'rejected';
      addSatellite({
        id: `profile:${profile.id}`,
        role: 'profile',
        ...point,
        r: SMALL_R,
        label: profile.handle ? `${profile.handle} · ${profile.service}` : profile.service,
        description: `Profil ${profile.handle ?? ''} w serwisie ${profile.service}; pewność tożsamości ${profile.identityScore}%${rejected ? '; odrzucony przez analityka' : ''}.`,
        tone: rejected ? 'excluded' : profile.identityScore >= 80 ? 'ok' : profile.identityScore >= 50 ? 'attention' : 'unknown',
        hubId: 'subject',
        ref: profile.id,
        score: profile.identityScore,
      });
    } else if (identifier) {
      addSatellite({
        id: `identifier:${identifier.type}:${identifier.value}`,
        role: 'identifier',
        ...point,
        r: SMALL_R - 3,
        label: identifier.value,
        description: `Identyfikator podmiotu: ${identifier.value}.`,
        tone: 'ok',
        hubId: 'subject',
      });
    }
  });

  // Prawa strona: adresy podmiotu, od najwyższego Wskaźnika Pewności.
  const addressNode = new Map<string, UniverseNode>();
  arc(findings.length, 0, rightRadius, subjectX, cy).forEach((point, index) => {
    const finding = findings[index]!;
    const { score, excluded } = finding.confidence;
    const node: UniverseNode = {
      id: `address:${finding.address}`,
      role: 'address',
      ...point,
      r: ADDRESS_R,
      label: short(finding.address, 5, 4),
      sublabel: finding.network,
      description: `Adres ${finding.address} w sieci ${finding.network}; ${excluded ? 'wykluczony' : `Wskaźnik Pewności ${score}%`}.`,
      tone: excluded ? 'excluded' : score >= 60 ? 'ok' : 'attention',
      hubId: 'subject',
      ref: finding.address,
      score,
    };
    addressNode.set(finding.address, node);
    addSatellite(node);
  });

  // Usługi w kolumnie; kolejność wg średniego położenia powiązanych adresów (mniej przecięć).
  const barycentre = (service: ServiceLink) => {
    const ys = service.transfers.flatMap((item) => addressNode.get(item.subjectAddress)?.y ?? []);
    return ys.length > 0 ? ys.reduce((sum, y) => sum + y, 0) / ys.length : Number.MAX_VALUE;
  };
  const ordered = [...services].sort(
    (a, b) => barycentre(a) - barycentre(b) || b.strength - a.strength || a.id.localeCompare(b.id),
  );
  const maxValue = Math.max(1, ...services.flatMap((service) => [service.outPln ?? 0, service.inPln ?? 0]));
  const widthFor = (value: number | undefined) => 2 + 5 * Math.sqrt((value ?? 0) / maxValue);
  const top = cy - ((ordered.length - 1) * rowGap) / 2;
  let hasBank = false;

  ordered.forEach((service, row) => {
    const hub: UniverseNode = {
      id: `service:${service.id}`,
      role: 'service',
      x: serviceX + (zigzag && row % 2 === 1 ? COLUMN_SHIFT : 0),
      y: top + row * rowGap,
      r: SERVICE_R,
      label: service.name,
      description: `Usługa ${service.name}; siła powiązania ${service.strength}%; przelewy do usługi: ${service.transfersOut}, z usługi: ${service.transfersIn}.`,
      tone: service.inferredOnly ? 'attention' : 'ok',
      serviceKind: service.kind,
      ref: service.id,
      score: service.strength,
    };
    nodes.push(hub);

    // Satelity usługi: jej adresy biorące udział w przelewach; adres wpłat z wnioskowania na bursztynowo.
    const serviceAddresses = new Map<string, boolean>();
    for (const item of service.transfers) {
      if (item.viaAddress) serviceAddresses.set(item.viaAddress, true);
      if (!serviceAddresses.has(item.serviceAddress)) serviceAddresses.set(item.serviceAddress, false);
    }
    [...serviceAddresses].forEach(([address, inferred], index, all) => {
      const angle = -Math.PI / 2 + (2 * Math.PI * index) / all.length;
      addSatellite({
        id: `${hub.id}:${address}`,
        role: 'service-address',
        x: hub.x + 64 * Math.cos(angle),
        y: hub.y + 64 * Math.sin(angle),
        r: SMALL_R,
        label: short(address),
        description: inferred
          ? `Prawdopodobny adres wpłat w usłudze ${service.name}: ${address} (wnioskowanie).`
          : `Adres usługi ${service.name}: ${address}.`,
        tone: inferred ? 'attention' : 'ok',
        hubId: hub.id,
        ref: address,
      });
    });

    // Krawędzie adres podmiotu ↔ usługa: osobno wypływy i wpływy, zsumowane.
    const groups = new Map<string, UniverseTransfer[]>();
    for (const item of service.transfers) {
      const key = `${item.direction}:${item.subjectAddress}`;
      groups.set(key, [...(groups.get(key) ?? []), item]);
    }
    for (const [key, transfers] of groups) {
      const direction = transfers[0]!.direction;
      const address = addressNode.get(transfers[0]!.subjectAddress);
      if (!address) continue;
      const both = groups.has(`${direction === 'out' ? 'in' : 'out'}:${address.ref}`);
      const dx = hub.x - address.x;
      const dy = hub.y - address.y;
      const length = Math.hypot(dx, dy) || 1;
      // Krawędzie w przeciwnych kierunkach rozsuwamy prostopadle, żeby się nie pokrywały.
      const shift = both ? (direction === 'out' ? -9 : 9) : 0;
      const nx = (-dy / length) * shift;
      const ny = (dx / length) * shift;
      const a = { x: address.x + (dx / length) * address.r + nx, y: address.y + (dy / length) * address.r + ny };
      const b = { x: hub.x - (dx / length) * hub.r + nx, y: hub.y - (dy / length) * hub.r + ny };
      const [start, end] = direction === 'out' ? [a, b] : [b, a];
      const valued = transfers.filter((item) => item.valuePln !== undefined);
      const valuePln = valued.length > 0 ? valued.reduce((sum, item) => sum + item.valuePln!, 0) : undefined;
      const amounts: Record<string, number> = {};
      for (const item of transfers) amounts[item.asset] = (amounts[item.asset] ?? 0) + item.amount;
      const at = direction === 'out' ? 0.5 : 0.3;
      edges.push({
        id: `${key}>${service.id}`,
        kind: direction,
        from: direction === 'out' ? address.id : hub.id,
        to: direction === 'out' ? hub.id : address.id,
        x1: start.x,
        y1: start.y,
        x2: end.x,
        y2: end.y,
        pill: { x: a.x + (b.x - a.x) * at, y: a.y + (b.y - a.y) * at },
        valuePln,
        amounts,
        transfers,
        firstTime: transfers.reduce((min, item) => (item.time < min ? item.time : min), transfers[0]!.time),
        lastTime: transfers.reduce((max, item) => (item.time > max ? item.time : max), transfers[0]!.time),
        dashed: service.inferredOnly || transfers.every((item) => item.viaAddress !== undefined),
        width: widthFor(valuePln),
        serviceId: service.id,
      });
    }

    // Wzmianki i konta: cienka krawędź od profilu, w którym je znaleziono (albo od podmiotu).
    const sources = new Set<string>();
    for (const mention of service.mentions) {
      const profile = input.profiles.find(
        (item) => (mention.evidenceId && item.evidenceIds.includes(mention.evidenceId)) || mention.url.startsWith(item.url),
      );
      sources.add(profile ? `profile:${profile.id}` : 'subject');
    }
    for (const sourceId of sources) {
      const source = nodes.find((node) => node.id === sourceId)!;
      edges.push({
        id: `mention:${sourceId}>${service.id}`,
        kind: 'mention',
        from: source.id,
        to: hub.id,
        x1: source.x,
        y1: source.y,
        x2: hub.x,
        y2: hub.y,
        amounts: {},
        transfers: [],
        dashed: false,
        width: 1.2,
        serviceId: service.id,
      });
    }

    // Ikona banku: możliwe wyjście do walut tradycyjnych — zawsze szacunek i wniosek.
    if (FIAT_KINDS.includes(service.kind) && (service.outPln ?? 0) > 0) {
      hasBank = true;
      const bank: UniverseNode = {
        id: `bank:${service.id}`,
        role: 'bank',
        x: bankX,
        y: hub.y,
        r: 24,
        label: 'Bank',
        description: `Możliwe wyjście do walut tradycyjnych przez ${service.name} — szacunek, wniosek do weryfikacji.`,
        tone: 'unknown',
        hubId: hub.id,
        ref: service.id,
      };
      nodes.push(bank);
      edges.push({
        id: `bank>${service.id}`,
        kind: 'bank',
        from: hub.id,
        to: bank.id,
        x1: hub.x + hub.r,
        y1: hub.y,
        x2: bank.x - bank.r,
        y2: bank.y,
        pill: { x: bankX - 96, y: hub.y },
        valuePln: service.outPln,
        amounts: {},
        transfers: service.transfers.filter((item) => item.direction === 'out'),
        dashed: true,
        width: Math.max(3, widthFor(service.outPln)),
        serviceId: service.id,
      });
    }
  });

  return {
    nodes,
    edges,
    width: services.length === 0 ? serviceX - 200 : hasBank ? bankX + 90 : serviceX + (zigzag ? COLUMN_SHIFT : 0) + 150,
    height: innerHeight + padding * 2,
  };
}

/** Węzły podświetlane razem z danym: hub z satelitami oraz końce jego krawędzi. */
export function universeHighlight(graph: UniverseGraph, id: string): Set<string> {
  const node = graph.nodes.find((item) => item.id === id);
  const result = new Set([id]);
  if (!node) return result;
  if (node.role === 'service' || node.role === 'subject') {
    for (const item of graph.nodes) if (item.hubId === id) result.add(item.id);
  }
  for (const edge of graph.edges) {
    if (edge.from === id) result.add(edge.to);
    if (edge.to === id) result.add(edge.from);
  }
  return result;
}
