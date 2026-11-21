// Widok „uniwersum podmiotu”: tożsamości i adresy osoby po lewej, huby giełd i portfeli po prawej,
// krawędzie z kwotami w PLN. Płótno ma własne ciemne tło niezależnie od motywu aplikacji.
import { useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { DualScore, ExternalLink, LayerTag, ShortAddress } from '../components/common.tsx';
import { useDossier } from '../components/DossierContext.tsx';
import { ServiceCard } from '../components/ServiceCards.tsx';
import { jointProbability } from '../dossier.ts';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln, fmtPlnCompact, truncate } from '../format.ts';
import { NETWORK_LABEL, NETWORK_SHORT, SERVICE_KIND_LABEL } from '../labels.ts';
import { Canvas } from './Canvas.tsx';
import { buildUniverse, universeHighlight } from './universe.ts';
import type { UniverseEdge, UniverseNode } from './universe.ts';

/** Dzieli podpis na najwyżej dwa wiersze mieszczące się w kole. */
function wrap(label: string, max: number): string[] {
  // Słowo dłuższe niż wiersz dzielimy, zamiast je ucinać.
  const words = label.split(/\s+/).flatMap((word) => word.match(new RegExp(`.{1,${max}}`, 'gu')) ?? []);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last !== undefined && `${last} ${word}`.length <= max) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.length <= 2 ? lines.map((line) => truncate(line, max)) : [truncate(lines[0]!, max), truncate(lines.slice(1).join(' '), max)];
}

const EDGE_KIND_TEXT: Record<UniverseEdge['kind'], string> = {
  out: 'przelewy z adresu podmiotu do usługi',
  in: 'przelewy z usługi na adres podmiotu',
  mention: 'wzmianka lub konto w profilu',
  bank: 'możliwe wyjście do walut tradycyjnych — szacunek',
  spoke: '',
};

function edgeSummary(edge: UniverseEdge, nodes: Map<string, UniverseNode>): string {
  const from = nodes.get(edge.from)?.label ?? '';
  const to = nodes.get(edge.to)?.label ?? '';
  const crypto = Object.entries(edge.amounts)
    .map(([asset, amount]) => fmtAmount(amount, asset))
    .join(', ');
  const period = edge.firstTime ? `, okres ${fmtDate(edge.firstTime)} – ${fmtDate(edge.lastTime)}` : '';
  const count = edge.transfers.length > 0 ? `, liczba przelewów: ${edge.transfers.length}` : '';
  const value = edge.valuePln === undefined ? '' : `, szacunkowo ${fmtPln(edge.valuePln)}`;
  return `${from} → ${to}: ${EDGE_KIND_TEXT[edge.kind]}${value}${crypto ? ` (${crypto})` : ''}${count}${period}${edge.dashed ? '; wnioskowanie' : ''}`;
}

/** Podpis pigułki bez wyceny w PLN: kwota w walucie krypto. */
function pillAmount(edge: UniverseEdge): string {
  const [asset, amount] = Object.entries(edge.amounts)[0] ?? [];
  return asset === undefined ? 'bez wyceny' : truncate(`${amount!.toLocaleString('pl-PL', { maximumFractionDigits: 3 })} ${asset}`, 12);
}

const activate = (action: () => void) => (event: KeyboardEvent) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    action();
  }
};

function BankIcon({ x, y }: { x: number; y: number }) {
  return (
    <path
      className="uni-bank-icon"
      transform={`translate(${x - 16},${y - 16})`}
      d="M2 12 16 3l14 9v3H2zM6 15v10M12 15v10M20 15v10M26 15v10M2 29h28M4 25h24"
    />
  );
}

function NodeShape({ node }: { node: UniverseNode }) {
  const { x, y, r } = node;
  switch (node.role) {
    case 'subject':
      return (
        <>
          <circle className="uni-subject-ring" cx={x} cy={y} r={r + 7} />
          <circle className="uni-hub" cx={x} cy={y} r={r} />
          {wrap(node.label, 13).map((line, index, lines) => (
            <text key={index} className="uni-hub-label" x={x} y={y + (index - (lines.length - 1) / 2) * 15} textAnchor="middle" dominantBaseline="central">
              {line}
            </text>
          ))}
        </>
      );
    case 'service':
      return (
        <>
          <circle className="uni-hub" cx={x} cy={y} r={r} />
          {wrap(node.label, 11).map((line, index, lines) => (
            <text key={index} className="uni-hub-label" x={x} y={y + (index - (lines.length - 1) / 2) * 13} textAnchor="middle" dominantBaseline="central">
              {line}
            </text>
          ))}
          <text className="uni-caption" x={x} y={y - r - 5} textAnchor="middle">
            {SERVICE_KIND_LABEL[node.serviceKind ?? 'other']}
          </text>
        </>
      );
    case 'address':
      return (
        <>
          <circle className="uni-address" cx={x} cy={y} r={r} />
          <text className="uni-address-net" x={x} y={y - 6} textAnchor="middle" dominantBaseline="central">
            {NETWORK_SHORT[node.sublabel as keyof typeof NETWORK_SHORT] ?? node.sublabel}
          </text>
          <text className="uni-address-score" x={x} y={y + 9} textAnchor="middle" dominantBaseline="central">
            {node.tone === 'excluded' ? 'wykl.' : `${node.score}%`}
          </text>
          <text className="uni-caption" x={x} y={y + r + 14} textAnchor="middle">
            {node.label}
          </text>
        </>
      );
    case 'bank':
      return (
        <>
          <BankIcon x={x} y={y - 6} />
          <text className="uni-hub-label" x={x} y={y + 24} textAnchor="middle">
            Bank
          </text>
          <text className="uni-caption" x={x} y={y + 38} textAnchor="middle">
            waluty tradycyjne — szacunek
          </text>
        </>
      );
    case 'service-address':
      return <circle className="uni-satellite" cx={x} cy={y} r={r} />;
    default:
      return (
        <>
          <circle className="uni-satellite" cx={x} cy={y} r={r} />
          <text className="uni-caption" x={x - r - 6} y={y} textAnchor="end" dominantBaseline="central">
            {truncate(node.label, 30)}
          </text>
        </>
      );
  }
}

type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

function TransferList({ edge }: { edge: UniverseEdge }) {
  if (edge.transfers.length === 0) return <p className="muted">To powiązanie nie wynika z przelewów.</p>;
  return (
    <ul className="plain-list transfer-list">
      {edge.transfers.map((item) => (
        <li key={`${item.txid}-${item.direction}`}>
          <strong>{fmtAmount(item.amount, item.asset)}</strong>
          {item.valuePln !== undefined && <span> ≈ {fmtPln(item.valuePln)}</span>}
          <span className="muted"> · {fmtDateTime(item.time)}</span>
          <br />
          <ShortAddress value={item.subjectAddress} /> {item.direction === 'out' ? '→' : '←'} <ShortAddress value={item.serviceAddress} />
          {item.viaAddress && (
            <span className="muted">
              {' '}
              przez <ShortAddress value={item.viaAddress} />
            </span>
          )}{' '}
          <ExternalLink url={item.explorerUrl}>eksplorator</ExternalLink>
        </li>
      ))}
    </ul>
  );
}

function Panel({ selection, nodes, edges, onClose }: { selection: Selection; nodes: Map<string, UniverseNode>; edges: UniverseEdge[]; onClose: () => void }) {
  const { dossier, tabHref } = useDossier();
  if (!selection) {
    return (
      <aside className="side-panel side-panel-empty">
        <p className="muted">Kliknij hub usługi, adres albo krawędź, żeby zobaczyć szczegóły: podstawę powiązania, przelewy i punkty zapytania.</p>
      </aside>
    );
  }
  const close = (
    <button type="button" className="icon-button" onClick={onClose} aria-label="Zamknij panel szczegółów">
      ×
    </button>
  );
  if (selection.type === 'edge') {
    const edge = edges.find((item) => item.id === selection.id);
    if (!edge) return null;
    return (
      <aside className="side-panel" aria-label="Szczegóły powiązania">
        <header>
          <h3>{EDGE_KIND_TEXT[edge.kind]}</h3>
          {close}
        </header>
        <p>{edgeSummary(edge, nodes)}</p>
        <p>
          <LayerTag layer={edge.dashed ? 'inference' : 'fact'} /> {edge.valuePln !== undefined && <LayerTag layer="calc" />}
        </p>
        <TransferList edge={edge} />
      </aside>
    );
  }
  const node = nodes.get(selection.id);
  if (!node) return null;
  const service = node.role === 'service' || node.role === 'bank' ? dossier.serviceLinks.find((link) => link.id === node.ref) : undefined;
  const finding = node.role === 'address' ? dossier.findings.find((item) => item.address === node.ref) : undefined;
  return (
    <aside className="side-panel" aria-label={service ? 'Karta usługi' : 'Szczegóły węzła'}>
      <header>
        <h3>{service && node.role === 'service' ? 'Karta usługi' : node.label}</h3>
        {close}
      </header>
      {node.role === 'bank' && (
        <p>
          <LayerTag layer="inference" /> {node.description} Łącznie: {fmtPln(service?.outPln ?? 0)}. Potwierdzenie wymaga danych od operatora usługi.
        </p>
      )}
      {service && node.role === 'service' && <ServiceCard link={service} compact />}
      {finding && (
        <>
          <p className="mono address">{finding.address}</p>
          <p>
            {NETWORK_LABEL[finding.network]} · <DualScore joint={jointProbability(dossier, finding)} score={finding.confidence.score} excluded={finding.confidence.excluded} />
          </p>
          <p>{finding.confidence.tier}</p>
          <p>
            <a href={tabHref('adresy')}>Karta adresu: księga reguł i ślady</a>
          </p>
        </>
      )}
      {!service && !finding && <p>{node.description}</p>}
      {node.role === 'profile' && (
        <p>
          <a href={tabHref('profile')}>Karta profilu i przesłanki tożsamości</a>
        </p>
      )}
    </aside>
  );
}

function EdgeTable({ edges, nodes }: { edges: UniverseEdge[]; nodes: Map<string, UniverseNode> }) {
  return (
    <div className="table-scroll">
      <table className="table table-dense">
        <caption className="visually-hidden">Powiązania adresów i profili podmiotu z usługami</caption>
        <thead>
          <tr>
            <th scope="col">Od</th>
            <th scope="col">Do</th>
            <th scope="col">Rodzaj</th>
            <th scope="col" className="num">Przelewy</th>
            <th scope="col">Okres</th>
            <th scope="col" className="num">Kwota krypto</th>
            <th scope="col" className="num">Szacunek PLN</th>
            <th scope="col">Warstwa</th>
          </tr>
        </thead>
        <tbody>
          {edges.map((edge) => (
            <tr key={edge.id}>
              <td>{nodes.get(edge.from)?.label}</td>
              <td>{nodes.get(edge.to)?.label}</td>
              <td>{EDGE_KIND_TEXT[edge.kind]}</td>
              <td className="num">{edge.transfers.length || '—'}</td>
              <td>{edge.firstTime ? `${fmtDate(edge.firstTime)} – ${fmtDate(edge.lastTime)}` : '—'}</td>
              <td className="num">
                {Object.entries(edge.amounts)
                  .map(([asset, amount]) => fmtAmount(amount, asset))
                  .join(', ') || '—'}
              </td>
              <td className="num">{edge.valuePln === undefined ? '—' : fmtPln(edge.valuePln)}</td>
              <td>
                <LayerTag layer={edge.dashed ? 'inference' : 'fact'} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UniverseView() {
  const { dossier } = useDossier();
  const graph = useMemo(
    () =>
      buildUniverse({
        name: dossier.persons[0]?.fullName ?? dossier.subject.name,
        identifiers: dossier.subject.identifiers,
        profiles: dossier.profiles,
        findings: dossier.findings,
        services: dossier.serviceLinks,
      }),
    [dossier],
  );
  const nodes = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const [active, setActive] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [asTable, setAsTable] = useState(false);
  const highlight = useMemo(() => (active ? universeHighlight(graph, active) : null), [graph, active]);
  const links = graph.edges.filter((edge) => edge.kind !== 'spoke');
  const dimNode = (id: string) => (highlight && !highlight.has(id) ? 'is-dim' : '');
  const dimEdge = (edge: UniverseEdge) =>
    highlight && !(highlight.has(edge.from) && highlight.has(edge.to) && (edge.from === active || edge.to === active || edge.kind === 'spoke'))
      ? 'is-dim'
      : '';
  const hover = (id: string | null) => ({
    onPointerEnter: () => setActive(id),
    onPointerLeave: () => setActive(null),
    onFocus: () => setActive(id),
    onBlur: () => setActive(null),
  });

  return (
    <section className="universe-section" aria-labelledby="uniwersum">
      <header className="section-head">
        <div>
          <h2 id="uniwersum">Powiązania z giełdami i portfelami</h2>
          <p className="muted">
            Po lewej tożsamości i adresy osoby, po prawej usługi. Kwoty to szacunek w PLN; linia przerywana oznacza wnioskowanie.
          </p>
        </div>
        <button type="button" className="button button-small" aria-pressed={asTable} onClick={() => setAsTable((value) => !value)}>
          {asTable ? 'Pokaż jako graf' : 'Pokaż jako tabelę'}
        </button>
      </header>

      {asTable ? (
        <EdgeTable edges={links} nodes={nodes} />
      ) : (
        <div className="graph-layout">
          <Canvas
            width={graph.width}
            height={graph.height}
            label="Graf powiązań podmiotu z giełdami i portfelami"
            className="universe"
            defs={
              <>
                <defs>
                  <pattern id="uni-grid" width="36" height="36" patternUnits="userSpaceOnUse">
                    <path className="uni-grid-line" d="M36 0H0V36" />
                    <circle className="uni-grid-dot" cx="0" cy="0" r="1.2" />
                  </pattern>
                </defs>
                <rect width="100%" height="100%" fill="url(#uni-grid)" />
              </>
            }
          >
            {graph.edges
              .filter((edge) => edge.kind === 'spoke')
              .map((edge) => (
                <line key={edge.id} className={`uni-spoke ${dimEdge(edge)}`} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
              ))}
            {links.map((edge) => (
              <g
                key={edge.id}
                data-node
                className={`uni-edge uni-edge-${edge.kind} ${edge.dashed ? 'is-inferred' : ''} ${dimEdge(edge)} ${selection?.id === edge.id ? 'is-selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={edgeSummary(edge, nodes)}
                onClick={() => setSelection({ type: 'edge', id: edge.id })}
                onKeyDown={activate(() => setSelection({ type: 'edge', id: edge.id }))}
              >
                <title>{edgeSummary(edge, nodes)}</title>
                <line className="uni-edge-hit" x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} />
                <line className="uni-edge-line" x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} strokeWidth={edge.width} />
                {edge.kind !== 'mention' && (
                  <line className="uni-flow" x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} strokeWidth={Math.max(1.5, edge.width / 2.5)} />
                )}
                {edge.pill && (
                  <g transform={`translate(${edge.pill.x},${edge.pill.y})`}>
                    <rect className="uni-pill" x={-36} y={-11} width={72} height={22} rx={11} />
                    <text className="uni-pill-text" textAnchor="middle" dominantBaseline="central">
                      {edge.valuePln === undefined ? pillAmount(edge) : fmtPlnCompact(edge.valuePln)}
                    </text>
                  </g>
                )}
              </g>
            ))}
            {graph.nodes.map((node) => (
              <g
                key={node.id}
                data-node
                className={`uni-node uni-${node.role} tone-${node.tone} ${node.serviceKind ? `kind-${node.serviceKind}` : ''} ${dimNode(node.id)} ${selection?.id === node.id ? 'is-selected' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={node.description}
                onClick={() => setSelection({ type: 'node', id: node.id })}
                onKeyDown={activate(() => setSelection({ type: 'node', id: node.id }))}
                {...hover(node.id)}
              >
                <title>{node.description}</title>
                <NodeShape node={node} />
              </g>
            ))}
          </Canvas>
          <Panel selection={selection} nodes={nodes} edges={graph.edges} onClose={() => setSelection(null)} />
        </div>
      )}

      <ul className="legend-row universe-legend" aria-label="Legenda grafu">
        <li><span className="swatch swatch-hub-ok" /> hub: podmiot / giełda</li>
        <li><span className="swatch swatch-hub-amber" /> hub: P2P, bramka, karta</li>
        <li><span className="swatch swatch-hub-other" /> hub: portfel, DeFi, inne</li>
        <li><span className="swatch swatch-sat-ok" /> satelita: adres lub profil potwierdzony</li>
        <li><span className="swatch swatch-sat-amber" /> satelita: wymaga uwagi (adres wpłat z wnioskowania, słaba tożsamość)</li>
        <li><span className="swatch swatch-sat-grey" /> satelita: nieznany lub odrzucony</li>
        <li><span className="swatch swatch-line" /> przelewy (kwota w pigułce, grubość wg wartości)</li>
        <li><span className="swatch swatch-dashed" /> linia przerywana: wnioskowanie</li>
        <li><span className="swatch swatch-mention" /> wzmianka lub konto w profilu</li>
        <li><span className="swatch swatch-bank" /> ikona banku: możliwe wyjście do walut tradycyjnych — szacunek, wniosek do weryfikacji</li>
      </ul>
    </section>
  );
}
