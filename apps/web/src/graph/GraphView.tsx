// Graf powiązań osoba → identyfikatory → profile → adresy → kontrahenci: własny SVG,
// układ warstwowy lub promienisty, filtry, podświetlanie sąsiadów i panel szczegółów.
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Dossier, GraphEdge, GraphNode, GraphNodeKind } from '@olcys/core';
import { DualScore, EmptyState, ExternalLink, ScoreBadge } from '../components/common.tsx';
import { useDossier } from '../components/DossierContext.tsx';
import { jointProbability } from '../dossier.ts';
import { fmtAmount, fmtDelta, fmtPln, scoreLevel, truncate } from '../format.ts';
import { CLASS_LABEL, EDGE_KIND_LABEL, IDENTITY_LABEL, NODE_KIND_LABEL, NODE_KIND_PLURAL, RELATION_LABEL, ruleLabel } from '../labels.ts';
import { Canvas } from './Canvas.tsx';
import { KIND_ORDER, edgeGeometry, filterGraph, layeredLayout, neighbourhood, radialLayout } from './layout.ts';
import type { GraphFilter, Point } from './layout.ts';

const hexagon = (r: number) =>
  Array.from({ length: 6 }, (_, index) => {
    const angle = (Math.PI / 3) * index;
    return `${(r * Math.cos(angle)).toFixed(1)},${(r * Math.sin(angle)).toFixed(1)}`;
  }).join(' ');

/** Kształt węzła zależny od rodzaju — rozróżnienie nie opiera się wyłącznie na kolorze. */
function Glyph({ kind }: { kind: GraphNodeKind }) {
  switch (kind) {
    case 'subject':
      return (
        <>
          <circle r={18} className="glyph-ring" />
          <circle r={13} />
        </>
      );
    case 'identifier':
      return <rect x={-9} y={-9} width={18} height={18} rx={3} />;
    case 'profile':
      return <rect x={-14} y={-10} width={28} height={20} rx={10} />;
    case 'address':
      return <polygon points={hexagon(14)} />;
    case 'service':
      return <polygon points="0,-14 14,0 0,14 -14,0" />;
    default:
      return <polygon points="0,-14 13,10 -13,10" />;
  }
}

function NodeDetails({ node, dossier }: { node: GraphNode; dossier: Dossier }) {
  const { tabHref } = useDossier();
  if (node.kind === 'address') {
    const finding = dossier.findings.find((item) => node.id.includes(item.address));
    if (!finding) return null;
    return (
      <>
        <p className="mono address">{finding.address}</p>
        <p>
          <DualScore joint={jointProbability(dossier, finding)} score={finding.confidence.score} excluded={finding.confidence.excluded} />
        </p>
        <h4>Skrót księgi reguł</h4>
        <ul className="plain-list">
          {finding.confidence.ledger.map((entry, index) => (
            <li key={index}>
              <strong>{fmtDelta(entry.delta)}</strong> {ruleLabel(entry.rule)}
            </li>
          ))}
        </ul>
        <p>
          <a href={tabHref('adresy')}>Pełna karta adresu</a>
        </p>
      </>
    );
  }
  if (node.kind === 'profile') {
    const profile = dossier.profiles.find((item) => node.id.endsWith(item.id) || (node.url !== undefined && item.url === node.url));
    if (!profile) return null;
    return (
      <>
        <p>
          Ocena tożsamości: <ScoreBadge score={profile.identityScore} /> — {IDENTITY_LABEL[profile.identityMatch] ?? profile.identityMatch}
        </p>
        <ul className="reasons">
          {profile.identityReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <p>
          <a href={tabHref('profile')}>Karta profilu</a>
        </p>
      </>
    );
  }
  if (node.kind === 'service') {
    const flows = dossier.findings.flatMap((finding) =>
      finding.confidence.excluded
        ? []
        : (finding.chain?.transfers ?? [])
            .filter((item) => node.id.includes(item.counterparty) || (item.counterpartyLabel !== undefined && item.counterpartyLabel === node.label))
            .map((item) => ({ ...item, cashOut: finding.chain!.cashOuts.find((cashOut) => cashOut.txid === item.txid) })),
    );
    const sums = new Map<string, number>();
    for (const item of flows) {
      const key = `${item.direction === 'in' ? 'wpływy' : 'wypływy'} ${item.asset}`;
      sums.set(key, (sums.get(key) ?? 0) + item.amount);
    }
    const pln = flows.reduce((total, item) => total + (item.cashOut?.valuePln ?? 0), 0);
    return (
      <>
        {flows[0] && <p>Klasa adresu: {CLASS_LABEL[flows[0].counterpartyClass] ?? flows[0].counterpartyClass}</p>}
        <dl className="meta">
          <div>
            <dt>Liczba przelewów</dt>
            <dd>{flows.length}</dd>
          </div>
          {[...sums].map(([key, amount]) => (
            <div key={key}>
              <dt>Suma: {key.split(' ')[0]}</dt>
              <dd>{fmtAmount(amount, key.split(' ')[1]!)}</dd>
            </div>
          ))}
          {pln > 0 && (
            <div>
              <dt>Szacunek wypłat</dt>
              <dd>{fmtPln(pln)}</dd>
            </div>
          )}
        </dl>
      </>
    );
  }
  if (node.kind === 'person') {
    const person = dossier.relatedPersons.find((item) => node.id.includes(item.id) || item.handle === node.label);
    if (!person) return null;
    return (
      <>
        <p>Siła powiązania: {person.strength}/100 — wskazówka do weryfikacji, nie ustalenie.</p>
        <ul className="plain-list">
          {person.relations.map((relation) => (
            <li key={relation.description}>
              <strong>{RELATION_LABEL[relation.kind] ?? relation.kind}:</strong> {relation.description}
            </li>
          ))}
        </ul>
        <p>
          <a href={tabHref('osoby')}>Osoby powiązane</a>
        </p>
      </>
    );
  }
  return null;
}

function NodePanel({ node, nodes, edges, onClose }: { node: GraphNode | undefined; nodes: GraphNode[]; edges: GraphEdge[]; onClose: () => void }) {
  const { dossier } = useDossier();
  if (!node) {
    return (
      <aside className="side-panel side-panel-empty">
        <p className="muted">Kliknij węzeł, żeby zobaczyć szczegóły i jego połączenia. Najechanie podświetla sąsiadów.</p>
      </aside>
    );
  }
  const label = (id: string) => nodes.find((item) => item.id === id)?.label ?? id;
  const touching = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  return (
    <aside className="side-panel" aria-label="Szczegóły węzła">
      <header>
        <div>
          <p className="eyebrow">{NODE_KIND_LABEL[node.kind]}</p>
          <h3>{node.label}</h3>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Zamknij panel szczegółów">
          ×
        </button>
      </header>
      {node.sublabel && <p className="muted">{node.sublabel}</p>}
      {node.url && (
        <p>
          <ExternalLink url={node.url}>otwórz źródło</ExternalLink>
        </p>
      )}
      <NodeDetails node={node} dossier={dossier} />
      <h4>Połączenia ({touching.length})</h4>
      <ul className="plain-list connections">
        {touching.map((edge) => (
          <li key={edge.id}>
            {edge.from === node.id ? '→' : '←'} <strong>{label(edge.from === node.id ? edge.to : edge.from)}</strong>
            <span className="muted">
              {' '}
              · {EDGE_KIND_LABEL[edge.kind] ?? edge.kind}
              {edge.inferred && ' (wnioskowanie)'}
              {edge.label && ` · ${edge.label}`}
            </span>
          </li>
        ))}
      </ul>
    </aside>
  );
}

export function GraphView() {
  const { dossier } = useDossier();
  const [radial, setRadial] = useState(false);
  const [filter, setFilter] = useState<GraphFilter>({ hideExcluded: false, cashOutOnly: false, minScore: 0 });
  const [active, setActive] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const graph = useMemo(() => filterGraph(dossier.graph.nodes, dossier.graph.edges, filter), [dossier.graph, filter]);
  const layout = useMemo(
    () => (radial ? radialLayout(graph.nodes, graph.edges) : layeredLayout(graph.nodes, graph.edges)),
    [graph, radial],
  );
  const near = useMemo(() => (active ? neighbourhood(graph.edges, active) : null), [graph.edges, active]);
  const at = (id: string): Point => layout.positions.get(id) ?? { x: 0, y: 0 };
  const kinds = KIND_ORDER.filter((kind) => dossier.graph.nodes.some((node) => node.kind === kind));

  if (dossier.graph.nodes.length <= 1) {
    return <EmptyState title="Graf jest pusty">Analiza nie znalazła profili ani adresów do połączenia z podmiotem.</EmptyState>;
  }

  const select = (id: string) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setSelected(id);
    }
  };

  return (
    <section aria-labelledby="graf-powiazan">
      <header className="section-head">
        <div>
          <h2 id="graf-powiazan">Graf powiązań</h2>
          <p className="muted">
            {graph.nodes.length} węzłów, {graph.edges.length} połączeń. Linia przerywana to wnioskowanie narzędzia, nie fakt ze źródła.
          </p>
        </div>
        <div className="segmented" role="group" aria-label="Układ grafu">
          <button type="button" aria-pressed={!radial} onClick={() => setRadial(false)}>
            Warstwowy
          </button>
          <button type="button" aria-pressed={radial} onClick={() => setRadial(true)}>
            Promienisty
          </button>
        </div>
      </header>

      <fieldset className="filters">
        <legend className="visually-hidden">Filtry grafu</legend>
        <label>
          <input type="checkbox" checked={filter.hideExcluded} onChange={(event) => setFilter({ ...filter, hideExcluded: event.target.checked })} />
          Ukryj odrzucone
        </label>
        <label>
          <input type="checkbox" checked={filter.cashOutOnly} onChange={(event) => setFilter({ ...filter, cashOutOnly: event.target.checked })} />
          Tylko wypłaty
        </label>
        <label>
          Minimalny wynik: <output>{filter.minScore}%</output>
          <input type="range" min={0} max={90} step={10} value={filter.minScore} onChange={(event) => setFilter({ ...filter, minScore: Number(event.target.value) })} />
        </label>
      </fieldset>

      <div className="graph-layout">
        <Canvas width={layout.width} height={layout.height} label="Graf powiązań podmiotu" className="link-graph">
          {layout.columns.map((column) => (
            <text key={column.kind} className="graph-column" x={column.x} y={14} textAnchor="middle">
              {NODE_KIND_PLURAL[column.kind]}
            </text>
          ))}
          {layout.centre && layout.rings.map((ring) => <circle key={ring.kind} className="graph-ring" cx={layout.centre!.x} cy={layout.centre!.y} r={ring.radius} />)}
          {graph.edges.map((edge) => {
            const geometry = edgeGeometry(at(edge.from), at(edge.to), !radial);
            const dim = near && !(edge.from === active || edge.to === active);
            return (
              <g key={edge.id} className={`gedge gedge-${edge.kind} ${edge.inferred ? 'is-inferred' : ''} ${dim ? 'is-dim' : ''}`}>
                <path d={geometry.path} strokeWidth={1.2 + (edge.weight ?? 20) / 35}>
                  <title>{`${EDGE_KIND_LABEL[edge.kind]}${edge.label ? `: ${edge.label}` : ''}`}</title>
                </path>
                {(edge.kind === 'transfer' || edge.kind === 'cash_out') && (
                  <polygon className="gedge-arrow" points="-5,-4 5,0 -5,4" transform={`translate(${geometry.mid.x},${geometry.mid.y}) rotate(${geometry.angle})`} />
                )}
              </g>
            );
          })}
          {graph.nodes.map((node) => {
            const point = at(node.id);
            const level = node.score === undefined ? '' : `level-${scoreLevel(node.score, node.excluded)}`;
            const description = `${NODE_KIND_LABEL[node.kind]}: ${node.label}${node.sublabel ? `, ${node.sublabel}` : ''}${node.score === undefined ? '' : `, wynik ${node.score}%`}${node.excluded ? ', odrzucony' : ''}`;
            return (
              <g
                key={node.id}
                data-node
                className={`gnode gnode-${node.kind} ${level} ${node.excluded ? 'is-excluded' : ''} ${near && !near.has(node.id) ? 'is-dim' : ''} ${selected === node.id ? 'is-selected' : ''}`}
                transform={`translate(${point.x},${point.y})`}
                tabIndex={0}
                role="button"
                aria-label={description}
                onClick={() => setSelected(node.id)}
                onKeyDown={select(node.id)}
                onPointerEnter={() => setActive(node.id)}
                onPointerLeave={() => setActive(null)}
                onFocus={() => setActive(node.id)}
                onBlur={() => setActive(null)}
              >
                <title>{description}</title>
                <Glyph kind={node.kind} />
                {radial ? (
                  <text className="gnode-label" y={30} textAnchor="middle">
                    {truncate(node.label, 16)}
                  </text>
                ) : (
                  <>
                    <text className="gnode-label" x={22} y={node.sublabel ? -3 : 4}>
                      {truncate(node.label, 24)}
                      {node.score !== undefined && !node.excluded && <tspan className="gnode-score"> {node.score}%</tspan>}
                    </text>
                    {node.sublabel && (
                      <text className="gnode-sub" x={22} y={12}>
                        {truncate(node.sublabel, 30)}
                      </text>
                    )}
                  </>
                )}
              </g>
            );
          })}
        </Canvas>
        <NodePanel node={graph.nodes.find((node) => node.id === selected)} nodes={dossier.graph.nodes} edges={dossier.graph.edges} onClose={() => setSelected(null)} />
      </div>

      <ul className="legend-row" aria-label="Legenda grafu">
        {kinds.map((kind) => (
          <li key={kind}>
            <svg className={`legend-glyph gnode gnode-${kind}`} viewBox="-20 -20 40 40" aria-hidden="true">
              <Glyph kind={kind} />
            </svg>
            {NODE_KIND_LABEL[kind]}
          </li>
        ))}
        <li><span className="swatch swatch-edge" /> fakt ze źródła</li>
        <li><span className="swatch swatch-edge-dashed" /> wnioskowanie</li>
        <li><span className="swatch swatch-edge-cash" /> możliwa wypłata</li>
      </ul>
    </section>
  );
}
