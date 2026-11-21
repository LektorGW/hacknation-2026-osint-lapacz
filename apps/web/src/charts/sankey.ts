// Układ diagramu przepływu (typ Sankey) w ustalonych kolumnach — czysta funkcja bez DOM.

export interface SankeyNodeInput {
  id: string;
  column: number;
  label: string;
}

export interface SankeyLinkInput {
  source: string;
  target: string;
  value: number;
}

export interface SankeyNode extends SankeyNodeInput {
  x: number;
  y: number;
  height: number;
  value: number;
}

export interface SankeyLink extends SankeyLinkInput {
  width: number;
  /** Środek wstęgi po stronie źródła i celu. */
  sourceY: number;
  targetY: number;
  x0: number;
  x1: number;
}

export interface SankeyLayout {
  nodes: SankeyNode[];
  links: SankeyLink[];
}

export interface SankeyOptions {
  width: number;
  height: number;
  nodeWidth?: number;
  gap?: number;
}

export function layoutSankey(
  inputNodes: SankeyNodeInput[],
  inputLinks: SankeyLinkInput[],
  { width, height, nodeWidth = 14, gap = 12 }: SankeyOptions,
): SankeyLayout {
  const links = inputLinks.filter((link) => link.value > 0);
  const total = (id: string, side: 'source' | 'target') =>
    links.filter((link) => link[side] === id).reduce((sum, link) => sum + link.value, 0);
  const valued = inputNodes
    .map((node) => ({ ...node, value: Math.max(total(node.id, 'source'), total(node.id, 'target')) }))
    .filter((node) => node.value > 0);
  if (valued.length === 0) return { nodes: [], links: [] };

  const columnIds = [...new Set(valued.map((node) => node.column))].sort((a, b) => a - b);
  const columns = columnIds.map((column) => valued.filter((node) => node.column === column));
  // Jedna skala dla wszystkich kolumn — wyznacza ją kolumna najciaśniejsza.
  const scale = Math.min(
    ...columns.map((nodes) => (height - gap * (nodes.length - 1)) / nodes.reduce((sum, node) => sum + node.value, 0)),
  );

  const placed = new Map<string, SankeyNode>();
  const centre = (id: string) => placed.get(id)!.y + placed.get(id)!.height / 2;
  const step = columns.length > 1 ? (width - nodeWidth) / (columns.length - 1) : 0;
  columns.forEach((nodes, index) => {
    // Pierwsza kolumna malejąco po wartości; kolejne według średniego położenia źródeł.
    const barycentre = (id: string) => {
      const incoming = links.filter((link) => link.target === id && placed.has(link.source));
      const weight = incoming.reduce((sum, link) => sum + link.value, 0);
      if (weight === 0) return Number.MAX_VALUE;
      return incoming.reduce((sum, link) => sum + centre(link.source) * link.value, 0) / weight;
    };
    const keys = new Map(nodes.map((node) => [node.id, index === 0 ? -node.value : barycentre(node.id)]));
    const ordered = [...nodes].sort(
      (a, b) => keys.get(a.id)! - keys.get(b.id)! || b.value - a.value || a.id.localeCompare(b.id),
    );
    const used = ordered.reduce((sum, node) => sum + node.value * scale, 0) + gap * (ordered.length - 1);
    let y = (height - used) / 2;
    for (const node of ordered) {
      const nodeHeight = node.value * scale;
      placed.set(node.id, { ...node, x: index * step, y, height: nodeHeight });
      y += nodeHeight + gap;
    }
  });

  const usable = links.filter((link) => placed.has(link.source) && placed.has(link.target));
  const offsets = new Map<string, number>();
  const take = (key: string, amount: number) => {
    const from = offsets.get(key) ?? 0;
    offsets.set(key, from + amount);
    return from + amount / 2;
  };
  const sourceY = new Map<SankeyLinkInput, number>();
  const targetY = new Map<SankeyLinkInput, number>();
  // Wstęgi wychodzą w kolejności położenia celu (i odwrotnie), żeby nie krzyżowały się przy węźle.
  for (const link of [...usable].sort((a, b) => centre(a.target) - centre(b.target))) {
    sourceY.set(link, placed.get(link.source)!.y + take(`s:${link.source}`, link.value * scale));
  }
  for (const link of [...usable].sort((a, b) => centre(a.source) - centre(b.source))) {
    targetY.set(link, placed.get(link.target)!.y + take(`t:${link.target}`, link.value * scale));
  }

  return {
    nodes: [...placed.values()],
    links: usable.map((link) => ({
      ...link,
      width: link.value * scale,
      sourceY: sourceY.get(link)!,
      targetY: targetY.get(link)!,
      x0: placed.get(link.source)!.x + nodeWidth,
      x1: placed.get(link.target)!.x,
    })),
  };
}
