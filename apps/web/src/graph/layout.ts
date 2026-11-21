// Układ grafu powiązań — czyste, deterministyczne funkcje bez DOM.
import type { GraphEdge, GraphNode, GraphNodeKind } from '@olcys/core';

export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  positions: Map<string, Point>;
  width: number;
  height: number;
  /** Układ warstwowy: położenie nagłówków kolumn. */
  columns: { kind: GraphNodeKind; x: number; label?: string }[];
  /** Układ promienisty: promienie pierścieni wokół `centre`. */
  rings: { kind: GraphNodeKind; radius: number }[];
  centre?: Point;
}

/** Kolejność kolumn (i pierścieni): od podmiotu przez hipotezy operatora, persony i konta do kontrahentów. */
export const KIND_ORDER: GraphNodeKind[] = ['subject', 'operator', 'persona', 'identifier', 'profile', 'source', 'address', 'service', 'person'];

type Adjacency = Map<string, string[]>;

function adjacency(nodes: GraphNode[], edges: GraphEdge[]): Adjacency {
  const result: Adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!result.has(edge.from) || !result.has(edge.to) || edge.from === edge.to) continue;
    result.get(edge.from)!.push(edge.to);
    result.get(edge.to)!.push(edge.from);
  }
  return result;
}

function groupByKind(nodes: GraphNode[]): { kind: GraphNodeKind; ids: string[] }[] {
  return KIND_ORDER.map((kind) => ({
    kind,
    ids: nodes.filter((node) => node.kind === kind).map((node) => node.id),
  })).filter((group) => group.ids.length > 0);
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Redukcja przecięć: węzły kolumny sortujemy po średniej pozycji sąsiadów w kolumnach
 * już ułożonych (metoda barycentryczna), na przemian od lewej i od prawej.
 */
function orderColumns(groups: { ids: string[] }[], neighbours: Adjacency, sweeps = 6): string[][] {
  const columns = groups.map((group) => [...group.ids]);
  const columnOf = new Map<string, number>();
  columns.forEach((ids, index) => ids.forEach((id) => columnOf.set(id, index)));
  const rank = new Map<string, number>();
  const rerank = (ids: string[]) =>
    ids.forEach((id, index) => rank.set(id, ids.length > 1 ? index / (ids.length - 1) : 0.5));
  columns.forEach(rerank);

  const sortColumn = (index: number, side: (other: number) => boolean) => {
    const ids = columns[index]!;
    const current = new Map(ids.map((id, position) => [id, position]));
    const keys = new Map(
      ids.map((id) => {
        const ranks = neighbours
          .get(id)!
          .filter((other) => side(columnOf.get(other)!))
          .map((other) => rank.get(other)!);
        return [id, ranks.length > 0 ? mean(ranks) : rank.get(id)!];
      }),
    );
    ids.sort((a, b) => keys.get(a)! - keys.get(b)! || current.get(a)! - current.get(b)!);
    rerank(ids);
  };

  for (let sweep = 0; sweep < sweeps; sweep += 1) {
    for (let index = 1; index < columns.length; index += 1) sortColumn(index, (other) => other < index);
    for (let index = columns.length - 2; index >= 0; index -= 1) sortColumn(index, (other) => other > index);
  }
  return columns;
}

export interface LayeredOptions {
  columnGap?: number;
  rowGap?: number;
  padding?: number;
}

/** Układ warstwowy: kolumny wg rodzaju węzła, wiersze w stałym odstępie, kolumny wyśrodkowane w pionie. */
export function layeredLayout(nodes: GraphNode[], edges: GraphEdge[], options: LayeredOptions = {}): GraphLayout {
  const groups = groupByKind(nodes);
  // Odstępy dobrane do podpisów 13 px: kolumna mieści podpis z 24 znaków, wiersz — podpis i drugi wiersz opisu.
  // Przy wielu kolumnach (graf śledczy ma ich do dziewięciu) odstęp jest nieco mniejszy; szerszy graf przesuwa się, a nie kurczy.
  const { columnGap = groups.length > 6 ? 250 : 280, rowGap = 62, padding = 56 } = options;
  const ordered = orderColumns(groups, adjacency(nodes, edges));
  const rows = Math.max(1, ...ordered.map((ids) => ids.length));
  const positions = new Map<string, Point>();
  ordered.forEach((ids, column) => {
    const offset = ((rows - ids.length) * rowGap) / 2;
    ids.forEach((id, row) => positions.set(id, { x: padding + column * columnGap, y: padding + offset + row * rowGap }));
  });
  return {
    positions,
    // Zapas z prawej na podpisy ostatniej kolumny.
    width: padding * 2 + Math.max(0, groups.length - 1) * columnGap + 190,
    height: padding * 2 + (rows - 1) * rowGap,
    columns: groups.map((group, column) => ({ kind: group.kind, x: padding + column * columnGap })),
    rings: [],
  };
}

/**
 * Układ przepływów blockchain: od lewej do prawej zgodnie z kierunkiem przelewów.
 * Kolumna węzła = najdłuższa ścieżka od źródeł przepływu (węzłów bez wpływów); cykle przerywamy
 * w miejscu, w którym krawędź wracałaby do węzła już odwiedzanego.
 */
export function flowLayout(nodes: GraphNode[], edges: GraphEdge[], options: LayeredOptions = {}): GraphLayout {
  // Szerokie kolumny: na krawędziach przepływu stoją kwoty („0,35 BTC · 137 tys. zł”).
  const { columnGap = 400, rowGap = 72, padding = 56 } = options;
  const ids = new Set(nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  const incoming = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
  }
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string, level: number) => {
    if (visiting.has(id) || (depth.get(id) ?? -1) >= level) return;
    depth.set(id, level);
    visiting.add(id);
    for (const next of outgoing.get(id)!) visit(next, level + 1);
    visiting.delete(id);
  };
  for (const node of nodes) if (incoming.get(node.id) === 0) visit(node.id, 0);
  // Węzły leżące wyłącznie na cyklu nie mają źródła — zaczynamy od pierwszego nieodwiedzonego.
  for (const node of nodes) if (!depth.has(node.id)) visit(node.id, 0);

  const levels = Math.max(0, ...depth.values()) + 1;
  const groups = Array.from({ length: levels }, (_, level) => ({ ids: nodes.filter((node) => depth.get(node.id) === level).map((node) => node.id) }));
  const ordered = orderColumns(groups, adjacency(nodes, edges));
  const rows = Math.max(1, ...ordered.map((column) => column.length));
  const positions = new Map<string, Point>();
  ordered.forEach((column, level) => {
    const offset = ((rows - column.length) * rowGap) / 2;
    column.forEach((id, row) => positions.set(id, { x: padding + level * columnGap, y: padding + offset + row * rowGap }));
  });
  return {
    positions,
    width: padding * 2 + Math.max(0, levels - 1) * columnGap + 190,
    height: padding * 2 + (rows - 1) * rowGap,
    columns: groups.map((_, level) => ({ kind: 'address' as GraphNodeKind, x: padding + level * columnGap, label: level === 0 ? 'Początek przepływu' : `Krok ${level}` })),
    rings: [],
  };
}

export interface RadialOptions {
  ringGap?: number;
  /** Najmniejsza odległość między środkami węzłów na jednym pierścieniu. */
  minDistance?: number;
  padding?: number;
}

/** Układ promienisty: podmiot w środku, kolejne rodzaje węzłów na coraz większych pierścieniach. */
export function radialLayout(nodes: GraphNode[], edges: GraphEdge[], options: RadialOptions = {}): GraphLayout {
  const { ringGap = 150, minDistance = 112, padding = 90 } = options;
  const groups = groupByKind(nodes);
  const neighbours = adjacency(nodes, edges);
  const hasCentre = groups[0]?.kind === 'subject' && groups[0].ids.length === 1;
  const angles = new Map<string, number>();
  const radii = new Map<string, number>();
  const rings: { kind: GraphNodeKind; radius: number }[] = [];

  let radius = 0;
  for (const group of hasCentre ? groups.slice(1) : groups) {
    const count = group.ids.length;
    const needed = count > 1 ? minDistance / (2 * Math.sin(Math.PI / count)) : 0;
    radius = Math.max(radius + ringGap, needed);
    rings.push({ kind: group.kind, radius });

    // Kąt docelowy: średnia kołowa kątów sąsiadów z pierścieni wewnętrznych.
    const desired = new Map<string, number>();
    for (const id of group.ids) {
      const inner = neighbours
        .get(id)!
        .filter((other) => angles.has(other))
        .map((other) => angles.get(other)!);
      if (inner.length > 0) desired.set(id, Math.atan2(mean(inner.map(Math.sin)), mean(inner.map(Math.cos))));
    }
    const index = new Map(group.ids.map((id, position) => [id, position]));
    const ordered = [...group.ids].sort(
      (a, b) => (desired.get(a) ?? Math.PI * 2) - (desired.get(b) ?? Math.PI * 2) || index.get(a)! - index.get(b)!,
    );
    // Równe odstępy zachowują kolejność; obrót pierścienia przybliża węzły do ich sąsiadów.
    const step = (Math.PI * 2) / count;
    const shifts = ordered.flatMap((id, position) => (desired.has(id) ? [desired.get(id)! - position * step] : []));
    const rotation =
      shifts.length > 0 ? Math.atan2(mean(shifts.map(Math.sin)), mean(shifts.map(Math.cos))) : -Math.PI / 2;
    ordered.forEach((id, position) => {
      angles.set(id, rotation + position * step);
      radii.set(id, radius);
    });
  }

  const centre = { x: radius + padding, y: radius + padding };
  const placed = nodes.map((node) => {
    const r = radii.get(node.id) ?? 0;
    const angle = angles.get(node.id) ?? 0;
    return { id: node.id, x: centre.x + r * Math.cos(angle), y: centre.y + r * Math.sin(angle) };
  });
  // Podpisy stoją pod węzłami: rozsuwamy te, które by na siebie zachodziły.
  const separated = separateBoxes(placed.map((item) => ({ ...item, width: LABEL_BOX.width, height: LABEL_BOX.height })));
  const positions = new Map<string, Point>(separated.map((item) => [item.id, { x: item.x, y: item.y }]));
  const maxY = Math.max(centre.y * 2, ...separated.map((item) => item.y + padding));
  return { positions, width: centre.x * 2, height: maxY, columns: [], rings, centre };
}

/** Prostokąt podpisu węzła w układzie promienistym (podpis i drugi wiersz pod węzłem). */
export const LABEL_BOX = { width: 118, height: 46 };

export interface Box {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: Box, b: Box, gap: number) => Math.abs(a.x - b.x) < (a.width + b.width) / 2 + gap && Math.abs(a.y - b.y) < (a.height + b.height) / 2 + gap;

/**
 * Proste rozsuwanie kolizji: prostokąty (środek, wymiary) przetwarzamy od góry; ten, który nachodzi
 * na już ustawiony, przesuwamy w dół o brakującą odległość. Deterministyczne, bez zmiany kolejności.
 */
export function separateBoxes(boxes: Box[], gap = 4, maxRounds = 50): Box[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const done: Box[] = [];
  for (const box of sorted) {
    const current = { ...box };
    for (let round = 0; round < maxRounds; round += 1) {
      const hit = done.find((other) => overlaps(current, other, gap));
      if (!hit) break;
      current.y = hit.y + (hit.height + current.height) / 2 + gap;
    }
    done.push(current);
  }
  const byId = new Map(done.map((box) => [box.id, box]));
  return boxes.map((box) => byId.get(box.id)!);
}

export interface GraphFilter {
  hideExcluded: boolean;
  cashOutOnly: boolean;
  minScore: number;
}

/** Filtry widoku: po odfiltrowaniu usuwamy także węzły, które straciły wszystkie połączenia. */
export function filterGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  filter: GraphFilter,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  let keptNodes = nodes.filter(
    (node) =>
      node.kind === 'subject' ||
      (!(filter.hideExcluded && node.excluded) && !(node.score !== undefined && node.score < filter.minScore)),
  );
  let keptEdges = edges.filter((edge) => !(filter.cashOutOnly && edge.kind === 'transfer'));
  for (;;) {
    const ids = new Set(keptNodes.map((node) => node.id));
    keptEdges = keptEdges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
    const connected = new Set(keptEdges.flatMap((edge) => [edge.from, edge.to]));
    const next = keptNodes.filter((node) => node.kind === 'subject' || connected.has(node.id));
    if (next.length === keptNodes.length) return { nodes: keptNodes, edges: keptEdges };
    keptNodes = next;
  }
}

/** Węzeł i jego bezpośredni sąsiedzi — do podświetlania. */
export function neighbourhood(edges: { from: string; to: string }[], id: string): Set<string> {
  const result = new Set([id]);
  for (const edge of edges) {
    if (edge.from === id) result.add(edge.to);
    if (edge.to === id) result.add(edge.from);
  }
  return result;
}

export interface EdgeGeometry {
  path: string;
  mid: Point;
  /** Kierunek krawędzi w połowie długości, w stopniach. */
  angle: number;
}

/** Punkt i kierunek na krzywej `edgeGeometry` w miejscu `t` (0 = początek, 1 = koniec) — np. strzałka bliżej celu. */
export function pointOnEdge(from: Point, to: Point, curved: boolean, t: number): { point: Point; angle: number } {
  const degrees = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!curved || from.x === to.x) {
    return { point: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, angle: degrees(to.x - from.x, to.y - from.y) };
  }
  const bend = (to.x - from.x) / 2;
  const c1 = { x: from.x + bend, y: from.y };
  const c2 = { x: to.x - bend, y: to.y };
  const u = 1 - t;
  const at = (a: number, b: number, c: number, d: number) => u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  const slope = (a: number, b: number, c: number, d: number) => 3 * u * u * (b - a) + 6 * u * t * (c - b) + 3 * t * t * (d - c);
  return {
    point: { x: at(from.x, c1.x, c2.x, to.x), y: at(from.y, c1.y, c2.y, to.y) },
    angle: degrees(slope(from.x, c1.x, c2.x, to.x), slope(from.y, c1.y, c2.y, to.y)),
  };
}

/** Krzywa między węzłami: w układzie warstwowym pozioma „esowata”, w promienistym odcinek. */
export function edgeGeometry(from: Point, to: Point, curved: boolean): EdgeGeometry {
  const degrees = (dx: number, dy: number) => (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!curved) {
    return {
      path: `M${from.x},${from.y}L${to.x},${to.y}`,
      mid: { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
      angle: degrees(to.x - from.x, to.y - from.y),
    };
  }
  // Węzły tej samej kolumny łączymy łukiem wychodzącym w prawo.
  const sameColumn = from.x === to.x;
  const bend = sameColumn ? 70 : (to.x - from.x) / 2;
  const c1 = { x: from.x + bend, y: from.y };
  const c2 = { x: sameColumn ? to.x + bend : to.x - bend, y: to.y };
  return {
    path: `M${from.x},${from.y}C${c1.x},${c1.y} ${c2.x},${c2.y} ${to.x},${to.y}`,
    mid: { x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8, y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8 },
    angle: degrees(to.x - from.x + (c2.x - c1.x), to.y - from.y + (c2.y - c1.y)),
  };
}
