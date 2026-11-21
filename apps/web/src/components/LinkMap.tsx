// Mapa powiązań: własny SVG w układzie warstwowym (kolumny od podmiotu do kontrahentów).
import type { KeyboardEvent } from 'react';
import type { Finding, SubjectQuery } from '@olcys/core';
import { scoreLevel, shorten, truncate } from '../format.ts';
import type { ScoreLevel } from '../format.ts';
import { CLASS_LABEL, IDENTIFIER_LABEL, NETWORK_LABEL } from '../labels.ts';
import '../link-map.css';

interface MapNode {
  id: string;
  column: number;
  title: string;
  subtitle: string;
  /** Ustawione tylko dla węzłów adresów. */
  address?: { value: string; level: ScoreLevel; excluded: boolean };
}

interface MapEdge {
  from: string;
  to: string;
  /** Krawędzie prowadzące do adresu dziedziczą jego poziom wyniku. */
  score?: number;
  excluded?: boolean;
}

const COLUMNS = ['Podmiot', 'Identyfikatory', 'Źródła i profile', 'Adresy', 'Kontrahenci z etykietą'];
const NODE_WIDTH = 190;
const NODE_HEIGHT = 46;
const ROW_HEIGHT = 62;
const COLUMN_GAP = 62;
const HEADER_HEIGHT = 34;
const WIDTH = COLUMNS.length * NODE_WIDTH + (COLUMNS.length - 1) * COLUMN_GAP;
const MAX_COUNTERPARTIES = 8;

function buildGraph(subjectName: string, query: SubjectQuery, findings: Finding[]) {
  const nodes = new Map<string, MapNode>();
  const edges = new Map<string, MapEdge>();
  const addNode = (node: MapNode) => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };
  const addEdge = (edge: MapEdge) => edges.set(`${edge.from}>${edge.to}`, edge);

  addNode({ id: 'subject', column: 0, title: truncate(subjectName, 26), subtitle: 'badany podmiot' });

  const identifierId = (type: string, value: string) => `id:${type}:${value}`;
  for (const identifier of query.identifiers) {
    const id = identifierId(identifier.type, identifier.value);
    addNode({
      id,
      column: 1,
      title: truncate(identifier.value, 26),
      subtitle: IDENTIFIER_LABEL[identifier.type] ?? identifier.type,
    });
    addEdge({ from: 'subject', to: id });
  }

  for (const finding of findings) {
    const { score, excluded } = finding.confidence;
    const addressId = `addr:${finding.address}`;
    addNode({
      id: addressId,
      column: 3,
      title: shorten(finding.address, 10, 8),
      subtitle: excluded ? 'odrzucony' : `${score}% · ${NETWORK_LABEL[finding.network] ?? finding.network}`,
      address: { value: finding.address, level: scoreLevel(score, excluded), excluded },
    });

    for (const evidence of finding.evidence) {
      const { type, value } = evidence.matchedIdentifier;
      const id = identifierId(type, value);
      // Identyfikator spoza zapytania został odkryty w toku analizy.
      addNode({
        id,
        column: 1,
        title: truncate(value, 26),
        subtitle: `${IDENTIFIER_LABEL[type] ?? type} (odkryty w analizie)`,
      });
      addEdge({ from: 'subject', to: id });

      const sourceId = `src:${evidence.url}`;
      addNode({ id: sourceId, column: 2, title: truncate(evidence.service, 26), subtitle: truncate(evidence.title, 30) });
      addEdge({ from: id, to: sourceId });
      addEdge({ from: sourceId, to: addressId, score, excluded });
    }

    if (excluded) continue;
    for (const transfer of finding.chain?.transfers ?? []) {
      const labelled = transfer.counterpartyLabel || !['private', 'unknown'].includes(transfer.counterpartyClass);
      if (!labelled) continue;
      const counterpartyId = `cp:${transfer.counterparty}`;
      const count = [...nodes.values()].filter((node) => node.column === 4).length;
      if (!nodes.has(counterpartyId) && count >= MAX_COUNTERPARTIES) continue;
      addNode({
        id: counterpartyId,
        column: 4,
        title: truncate(transfer.counterpartyLabel ?? CLASS_LABEL[transfer.counterpartyClass] ?? 'kontrahent', 27),
        subtitle: `${CLASS_LABEL[transfer.counterpartyClass] ?? transfer.counterpartyClass} · ${shorten(transfer.counterparty, 6, 4)}`,
      });
      addEdge({ from: addressId, to: counterpartyId });
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Rozmieszcza węzły: stała pozycja kolumny, w pionie równomiernie i centralnie. */
function layout(nodes: MapNode[]) {
  const columns = COLUMNS.map((_, column) => nodes.filter((node) => node.column === column));
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const height = HEADER_HEIGHT + rows * ROW_HEIGHT;
  const positions = new Map<string, { x: number; y: number }>();
  columns.forEach((column, columnIndex) => {
    const offset = HEADER_HEIGHT + ((rows - column.length) * ROW_HEIGHT) / 2;
    column.forEach((node, rowIndex) => {
      positions.set(node.id, {
        x: columnIndex * (NODE_WIDTH + COLUMN_GAP),
        y: offset + rowIndex * ROW_HEIGHT + (ROW_HEIGHT - NODE_HEIGHT) / 2,
      });
    });
  });
  return { positions, height };
}

function edgeClass(edge: MapEdge): string {
  if (edge.excluded) return 'map-edge map-edge-excluded';
  if (edge.score === undefined) return 'map-edge';
  return `map-edge map-edge-scored level-${scoreLevel(edge.score)}`;
}

function NodeBox({ node, x, y, onSelect }: { node: MapNode; x: number; y: number; onSelect: (address: string) => void }) {
  const address = node.address;
  const content = (
    <>
      <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx={6} />
      <text x={10} y={19} className="map-node-title" textDecoration={address?.excluded ? 'line-through' : undefined}>
        {node.title}
      </text>
      <text x={10} y={36} className="map-node-subtitle">
        {node.subtitle}
      </text>
    </>
  );
  const transform = `translate(${x} ${y})`;
  if (!address) {
    return (
      <g className={`map-node map-column-${node.column}`} transform={transform}>
        <title>{`${node.title} — ${node.subtitle}`}</title>
        {content}
      </g>
    );
  }
  const activate = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(address.value);
    }
  };
  return (
    <g
      className={`map-node map-address level-${address.level}`}
      transform={transform}
      role="button"
      tabIndex={0}
      aria-label={`Adres ${address.value}, ${node.subtitle}. Przejdź do karty adresu.`}
      onClick={() => onSelect(address.value)}
      onKeyDown={activate}
    >
      <title>{address.value}</title>
      {content}
    </g>
  );
}

interface LinkMapProps {
  subjectName: string;
  query: SubjectQuery;
  findings: Finding[];
  onSelectAddress: (address: string) => void;
}

export function LinkMap({ subjectName, query, findings, onSelectAddress }: LinkMapProps) {
  const { nodes, edges } = buildGraph(subjectName, query, findings);
  const { positions, height } = layout(nodes);

  return (
    <div className="map-scroll">
      <svg
        className="link-map"
        viewBox={`0 0 ${WIDTH} ${height}`}
        role="group"
        aria-label="Mapa powiązań: podmiot, identyfikatory, źródła, adresy i kontrahenci"
      >
        {COLUMNS.map((label, index) => (
          <text key={label} className="map-column-label" x={index * (NODE_WIDTH + COLUMN_GAP)} y={16}>
            {label}
          </text>
        ))}
        <g fill="none">
          {edges.map((edge) => {
            const from = positions.get(edge.from);
            const to = positions.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.x + NODE_WIDTH;
            const y1 = from.y + NODE_HEIGHT / 2;
            const y2 = to.y + NODE_HEIGHT / 2;
            const bend = (to.x - x1) / 2;
            return (
              <path
                key={`${edge.from}>${edge.to}`}
                className={edgeClass(edge)}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${to.x - bend} ${y2}, ${to.x} ${y2}`}
                // Grubość krawędzi rośnie z wynikiem adresu.
                strokeWidth={edge.score !== undefined && !edge.excluded ? 1.5 + (edge.score / 100) * 3.5 : 1.5}
              />
            );
          })}
        </g>
        {nodes.map((node) => {
          const position = positions.get(node.id)!;
          return <NodeBox key={node.id} node={node} x={position.x} y={position.y} onSelect={onSelectAddress} />;
        })}
      </svg>
      <p className="map-legend">
        Grubość i kolor linii do adresu odpowiadają Wskaźnikowi Pewności. Adresy odrzucone są wyszarzone i
        przekreślone. Wybranie adresu przenosi do jego karty.
      </p>
    </div>
  );
}
