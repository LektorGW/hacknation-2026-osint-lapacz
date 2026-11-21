// Graf śledczy: podmiot → hipotezy operatora → persony → konta → adresy → usługi. Własny SVG,
// układ warstwowy, promienisty albo przepływowy (warstwa blockchain), statusy relacji, zwijanie gałęzi,
// filtry, ścieżka dowodowa i decyzje analityka w panelu bocznym.
import { useMemo, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode } from 'react';
import type { ClaimStatus, Dossier, GraphEdge, GraphNode, GraphNodeKind } from '@olcys/core';
import { DualScore, EmptyState, ExternalLink, ScoreBadge } from '../components/common.tsx';
import { DecisionControls, DecisionHistory, useDossier } from '../components/DossierContext.tsx';
import { EvidenceRefs, OperatorDecision, OperatorHypothesisDetails, IndicatorScore, StatusBadge } from '../components/Indicators.tsx';
import { SyntheticTag } from '../components/Mode.tsx';
import { addressKey, jointProbability } from '../dossier.ts';
import { fmtAmount, fmtDelta, fmtPln, scoreLevel, truncate } from '../format.ts';
import {
  CLAIM_STATUSES,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_MEANING,
  CLASS_LABEL,
  EDGE_KIND_LABEL,
  IDENTITY_LABEL,
  NODE_KIND_LABEL,
  NODE_KIND_PLURAL,
  ORDINAL_NOTE,
  RELATION_LABEL,
  ruleLabel,
} from '../labels.ts';
import { Canvas } from './Canvas.tsx';
import { RELATION_TEXT } from '../identities.ts';
import type { FullDossier } from '../proof.ts';
import {
  applyView,
  childMap,
  collapseGraph,
  edgeLayer,
  edgeStatus,
  findEvidencePath,
  hypothesisForEdge,
  linkKeyOf,
  nodeStatus,
  sourceCounts,
  toggled,
} from './investigation.ts';
import type { EvidencePath, LayerView } from './investigation.ts';
import { KIND_ORDER, edgeGeometry, flowLayout, layeredLayout, neighbourhood, radialLayout } from './layout.ts';
import type { Point } from './layout.ts';

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
    case 'operator':
      return <polygon points="0,-15 14,-5 9,13 -9,13 -14,-5" />;
    case 'persona':
      return <ellipse rx={15} ry={10} />;
    case 'identifier':
      return <rect x={-9} y={-9} width={18} height={18} rx={3} />;
    case 'profile':
      return <rect x={-14} y={-10} width={28} height={20} rx={10} />;
    case 'address':
      return <polygon points={hexagon(14)} />;
    case 'service':
      return <polygon points="0,-14 14,0 0,14 -14,0" />;
    case 'source':
      return <path d="M-8,-11 H4 L9,-6 V11 H-8 Z" />;
    default:
      return <polygon points="0,-14 13,10 -13,10" />;
  }
}

type Selection = { type: 'node'; id: string } | { type: 'edge'; id: string } | null;

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
        <DecisionControls target="address" decisionKey={addressKey(finding)} confirmLabel="To adres tej osoby" rejectLabel="To nie jest adres tej osoby" />
        <h4>Historia zmian</h4>
        <DecisionHistory keys={[addressKey(finding)]} />
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
        <DecisionControls target="profile" decisionKey={profile.id} confirmLabel="Potwierdź: konto podmiotu" rejectLabel="Odrzuć: to nie konto podmiotu" />
        <h4>Historia zmian</h4>
        <DecisionHistory keys={[profile.id]} />
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
  if (node.kind === 'person' && node.id.startsWith('identity:')) {
    const identity = (dossier as FullDossier).linkedIdentities?.find((item) => node.id === `identity:${item.id}`);
    if (!identity) return null;
    return (
      <>
        <p>
          {RELATION_TEXT[identity.relation] ?? identity.relation} — wskaźnik powiązania {identity.score}/100 (hipoteza, nie ustalenie).
        </p>
        <ol className="plain-list">
          {identity.path.map((step, index) => (
            <li key={index}>
              {index + 1}. {step}
            </li>
          ))}
        </ol>
        <p>
          <a href={tabHref('tozsamosci')}>Karta powiązanej tożsamości</a>
        </p>
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

/** Status prostym językiem: znaczek i jedno zdanie, co on oznacza. */
function StatusExplained({ status }: { status: ClaimStatus }) {
  return (
    <div className={`status-explained st-${status}`}>
      <StatusBadge status={status} />
      <p>{CLAIM_STATUS_MEANING[status]}</p>
    </div>
  );
}

function OrdinalScore({ label, value }: { label: string; value: number }) {
  return (
    <p className="ordinal-score">
      {label}: <strong>{value}/100</strong>
      <span className="cell-note">{ORDINAL_NOTE}</span>
    </p>
  );
}

interface PanelActions {
  select(selection: Selection): void;
  pathToSubject?: () => void;
  pickTarget(): void;
  clearPath(): void;
  toggleCollapse?: () => void;
  toggleSources?: () => void;
}

function PathSection({ path, ends, label, onClear }: { path: EvidencePath | null; ends: { from: string; to: string }; label: (id: string) => string; onClear: () => void }) {
  return (
    <section className="path-panel" aria-label="Ścieżka dowodowa">
      <header>
        <h4>Ścieżka dowodowa</h4>
        <button type="button" className="button button-small" onClick={onClear}>
          Wyczyść
        </button>
      </header>
      <p className="muted">
        {label(ends.from)} → {label(ends.to)}
      </p>
      {!path ? (
        <p className="notice notice-inline">
          Brak ścieżki w widocznej części grafu. Rozwiń zwinięte gałęzie albo włącz ukryte statusy i warstwy. Relacje odrzucone nie należą do ścieżki.
        </p>
      ) : (
        <>
          {path.hypotheses > 0 ? (
            <p className="notice notice-inline">
              Ścieżka zawiera {path.hypotheses} {path.hypotheses === 1 ? 'krok oparty' : 'kroki oparte'} na hipotezie — nie jest ciągiem faktów. Nie istnieje
              droga wyłącznie po faktach i potwierdzeniach.
            </p>
          ) : (
            <p className="muted">Wszystkie kroki to fakty źródłowe, obliczenia albo relacje potwierdzone przez analityka.</p>
          )}
          <ol className="path-steps-list">
            {path.steps.map((step, index) => (
              <li key={step.edge.id} className={`st-${step.status}`}>
                <span className="path-mark" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <p>
                    <strong>{label(step.from)}</strong> {step.forward ? '→' : '←'} <strong>{label(step.to)}</strong>
                  </p>
                  <p>
                    {EDGE_KIND_LABEL[step.edge.kind] ?? step.edge.kind} <StatusBadge status={step.status} />
                  </p>
                  {step.edge.explanation && <p className="muted">{step.edge.explanation}</p>}
                  <EvidenceRefs items={step.edge.evidence} />
                </div>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function NodePanel({ node, edges, label, actions, collapsed, sourceCount, sourcesShown, childCount }: { node: GraphNode; edges: GraphEdge[]; label: (id: string) => string; actions: PanelActions; collapsed: boolean; sourceCount: number; sourcesShown: boolean; childCount: number }) {
  const { dossier } = useDossier();
  const status = nodeStatus(node);
  const touching = edges.filter((edge) => edge.from === node.id || edge.to === node.id);
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">{NODE_KIND_LABEL[node.kind] ?? node.kind}</p>
          <h3>{node.label}</h3>
        </div>
        <button type="button" className="icon-button" onClick={() => actions.select(null)} aria-label="Zamknij panel szczegółów">
          ×
        </button>
      </header>
      {node.sublabel && <p className="muted">{node.sublabel}</p>}
      {status && <StatusExplained status={status} />}
      {node.kind === 'operator' && (
        <p className="notice notice-inline">Węzeł oznacza przypuszczenie, że kilka kont obsługuje ten sam operator. Nie jest ustaloną osobą.</p>
      )}
      {node.score !== undefined && <OrdinalScore label="Wynik węzła" value={node.score} />}
      {node.url && (
        <p>
          <ExternalLink url={node.url}>otwórz źródło</ExternalLink> <SyntheticTag source={{ url: node.url }} />
        </p>
      )}
      <NodeDetails node={node} dossier={dossier} />
      <div className="panel-actions">
        {actions.pathToSubject && (
          <button type="button" className="button button-small" onClick={actions.pathToSubject}>
            Pokaż ścieżkę dowodową
          </button>
        )}
        <button type="button" className="button button-small" onClick={actions.pickTarget}>
          Ścieżka do innego węzła…
        </button>
        {actions.toggleCollapse && childCount > 0 && (
          <button type="button" className="button button-small" aria-pressed={collapsed} onClick={actions.toggleCollapse}>
            {collapsed ? 'Rozwiń gałąź' : 'Zwiń gałąź'}
          </button>
        )}
        {actions.toggleSources && sourceCount > 0 && (
          <button type="button" className="button button-small" aria-pressed={sourcesShown} onClick={actions.toggleSources}>
            {sourcesShown ? 'Schowaj źródła' : `Pokaż źródła (${sourceCount})`}
          </button>
        )}
      </div>
      <h4>Połączenia ({touching.length})</h4>
      <ul className="plain-list connections">
        {touching.map((edge) => (
          <li key={edge.id}>
            <button type="button" className="link-button" onClick={() => actions.select({ type: 'edge', id: edge.id })}>
              {edge.from === node.id ? '→' : '←'} <strong>{label(edge.from === node.id ? edge.to : edge.from)}</strong>
            </button>
            <span className="muted">
              {' '}
              · {EDGE_KIND_LABEL[edge.kind] ?? edge.kind}
              {edge.label && ` · ${edge.label}`}
            </span>{' '}
            <StatusBadge status={edgeStatus(edge)} />
          </li>
        ))}
      </ul>
    </>
  );
}

function EdgePanel({ edge, nodes, label, actions }: { edge: GraphEdge; nodes: GraphNode[]; label: (id: string) => string; actions: PanelActions }) {
  const { dossier } = useDossier();
  const status = edgeStatus(edge);
  const hypothesis = edge.kind === 'same_operator' ? hypothesisForEdge(edge, dossier.indicators?.commonOperator ?? []) : undefined;
  // Bez wskaźnika w teczce klucz decyzji składamy z identyfikatorów kont na końcach krawędzi.
  const profileId = (nodeId: string) => {
    const node = nodes.find((item) => item.id === nodeId);
    return dossier.profiles.find((item) => nodeId.endsWith(item.id) || (node?.url !== undefined && item.url === node.url))?.id;
  };
  const fallbackKey = edge.kind === 'same_operator' && !hypothesis && profileId(edge.from) && profileId(edge.to) ? linkKeyOf(profileId(edge.from)!, profileId(edge.to)!) : undefined;
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">Relacja · {edgeLayer(edge) === 'chain' ? 'przepływ blockchain' : 'powiązanie tożsamości'}</p>
          <h3>{EDGE_KIND_LABEL[edge.kind] ?? edge.kind}</h3>
        </div>
        <button type="button" className="icon-button" onClick={() => actions.select(null)} aria-label="Zamknij panel szczegółów">
          ×
        </button>
      </header>
      <p className="edge-ends">
        <button type="button" className="link-button" onClick={() => actions.select({ type: 'node', id: edge.from })}>
          {label(edge.from)}
        </button>{' '}
        <span aria-hidden="true">→</span>{' '}
        <button type="button" className="link-button" onClick={() => actions.select({ type: 'node', id: edge.to })}>
          {label(edge.to)}
        </button>
      </p>
      {edge.label && <p className={status === 'rejected' ? 'is-struck' : undefined}>{edge.label}</p>}
      <StatusExplained status={status} />
      <h4>Wyjaśnienie</h4>
      <p>{edge.explanation ?? hypothesis?.statement ?? 'Usługa analizy nie podała wyjaśnienia tej relacji.'}</p>
      {hypothesis ? (
        <p className="ordinal-score">
          Wskaźnik wspólnego operatora: <IndicatorScore indicator={hypothesis.indicator} />
          <span className="cell-note">{hypothesis.indicator?.scale ?? ORDINAL_NOTE}</span>
        </p>
      ) : (
        edge.weight !== undefined && <OrdinalScore label="Waga relacji" value={edge.weight} />
      )}
      <h4>Dowody ({(edge.evidence ?? []).length})</h4>
      {(edge.evidence ?? []).length > 0 ? <EvidenceRefs items={edge.evidence} /> : <p className="muted">Relacja nie ma dołączonych dowodów w tej teczce.</p>}
      {hypothesis && (
        <>
          <OperatorHypothesisDetails hypothesis={hypothesis} />
          <OperatorDecision hypothesis={hypothesis} />
        </>
      )}
      {fallbackKey && (
        <>
          <p className="muted">Teczka nie zawiera tabeli składników tej hipotezy (starsza wersja usługi analizy).</p>
          <DecisionControls target="link" decisionKey={fallbackKey} confirmLabel="Potwierdź wspólnego operatora" rejectLabel="Odrzuć hipotezę" summary="Decyzja analityka o hipotezie" open />
          <h4>Historia zmian</h4>
          <DecisionHistory keys={[fallbackKey]} empty="Brak decyzji — hipoteza pozostaje przypuszczeniem narzędzia." />
        </>
      )}
    </>
  );
}

const LAYER_OPTIONS: { id: LayerView; label: string }[] = [
  { id: 'identity', label: 'Powiązania tożsamości' },
  { id: 'chain', label: 'Przepływy blockchain' },
  { id: 'both', label: 'Obie warstwy' },
];

const EDGE_SAMPLE = 'M2,7 H34';

/** Próbka linii w legendzie i przy filtrze — ten sam styl co krawędź o danym statusie. */
function StatusSwatch({ status }: { status: ClaimStatus }) {
  return (
    <svg className={`status-swatch gedge st-${status}`} viewBox="0 0 36 14" aria-hidden="true">
      <path className="gedge-line" d={EDGE_SAMPLE} />
      {status === 'confirmed' && <path className="gedge-check" d="M14,7 l3,3 l5,-6" />}
    </svg>
  );
}

export function GraphView() {
  const { dossier } = useDossier();
  const all = dossier.graph;
  const [layer, setLayer] = useState<LayerView>('both');
  const [radial, setRadial] = useState(false);
  const [statuses, setStatuses] = useState<ReadonlySet<ClaimStatus>>(new Set(CLAIM_STATUSES));
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<GraphNodeKind>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [sourcesShown, setSourcesShown] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [pathEnds, setPathEnds] = useState<{ from: string; to: string } | null>(null);
  const [picking, setPicking] = useState(false);

  const viewed = useMemo(
    () => applyView(all.nodes, all.edges, { statuses, kinds: new Set(KIND_ORDER.filter((kind) => !hiddenKinds.has(kind))), minScore, layer }),
    [all, statuses, hiddenKinds, minScore, layer],
  );
  const graph = useMemo(() => collapseGraph(viewed.nodes, viewed.edges, { collapsed, sourcesShown }), [viewed, collapsed, sourcesShown]);
  const flow = layer === 'chain';
  const layout = useMemo(
    () => (flow ? flowLayout(graph.nodes, graph.edges) : radial ? radialLayout(graph.nodes, graph.edges) : layeredLayout(graph.nodes, graph.edges)),
    [graph, radial, flow],
  );
  const children = useMemo(() => childMap(viewed.nodes, viewed.edges), [viewed]);
  const sources = useMemo(() => sourceCounts(viewed.nodes, viewed.edges), [viewed]);
  const kindOf = useMemo(() => new Map(all.nodes.map((node) => [node.id, node.kind])), [all.nodes]);
  const branchSize = (id: string) => (children.get(id) ?? []).filter((child) => kindOf.get(child) !== 'source').length;
  const path = useMemo(() => (pathEnds ? findEvidencePath(graph.edges, pathEnds.from, pathEnds.to) : null), [graph.edges, pathEnds]);
  const pathEdges = useMemo(() => new Set(path?.steps.map((step) => step.edge.id)), [path]);
  const pathNodes = useMemo(() => new Set(path?.nodes), [path]);
  const near = useMemo(() => (active ? neighbourhood(graph.edges, active) : null), [graph.edges, active]);
  const at = (id: string): Point => layout.positions.get(id) ?? { x: 0, y: 0 };
  const curved = flow || !radial;
  const kinds = KIND_ORDER.filter((kind) => all.nodes.some((node) => node.kind === kind));
  const label = (id: string) => all.nodes.find((item) => item.id === id)?.label ?? id;
  const subject = all.nodes.find((node) => node.kind === 'subject');
  const statusCount = (status: ClaimStatus) => all.edges.filter((edge) => edgeStatus(edge) === status).length;
  const chainEdges = all.edges.filter((edge) => edgeLayer(edge) === 'chain').length;

  if (all.nodes.length <= 1) {
    return <EmptyState title="Graf jest pusty">Analiza nie znalazła profili ani adresów do połączenia z podmiotem.</EmptyState>;
  }

  function clickNode(id: string, event: MouseEvent | KeyboardEvent) {
    const origin = selection?.type === 'node' ? selection.id : null;
    if (origin && origin !== id && (picking || event.shiftKey)) {
      setPathEnds({ from: origin, to: id });
      setPicking(false);
      return;
    }
    setPicking(false);
    setSelection({ type: 'node', id });
  }

  const onKey = (run: (event: KeyboardEvent) => void) => (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      run(event);
    }
  };

  const toggleCollapse = (id: string) => setCollapsed((current) => toggled(current, id));
  const toggleSources = (id: string) => setSourcesShown((current) => toggled(current, id));
  const stop = (run: () => void) => (event: MouseEvent) => {
    event.stopPropagation();
    run();
  };

  const selectedNode = selection?.type === 'node' ? all.nodes.find((node) => node.id === selection.id) : undefined;
  const selectedEdge = selection?.type === 'edge' ? all.edges.find((edge) => edge.id === selection.id) : undefined;
  const actions: PanelActions = {
    select: setSelection,
    pickTarget: () => setPicking(true),
    clearPath: () => setPathEnds(null),
    ...(selectedNode && subject && selectedNode.id !== subject.id ? { pathToSubject: () => setPathEnds({ from: selectedNode.id, to: subject.id }) } : {}),
    ...(selectedNode && selectedNode.kind !== 'subject' ? { toggleCollapse: () => toggleCollapse(selectedNode.id) } : {}),
    ...(selectedNode ? { toggleSources: () => toggleSources(selectedNode.id) } : {}),
  };

  let panel: ReactNode = (
    <p className="muted">
      Kliknij węzeł albo relację, żeby zobaczyć wyjaśnienie, status, dowody i decyzje. Dwuklik zwija lub rozwija gałąź. Shift + klik drugiego węzła pokazuje
      ścieżkę dowodową między nimi.
    </p>
  );
  if (selectedNode) {
    panel = (
      <NodePanel
        node={selectedNode}
        edges={all.edges}
        label={label}
        actions={actions}
        collapsed={collapsed.has(selectedNode.id)}
        childCount={branchSize(selectedNode.id)}
        sourceCount={sources.get(selectedNode.id) ?? 0}
        sourcesShown={sourcesShown.has(selectedNode.id)}
      />
    );
  } else if (selectedEdge) {
    panel = <EdgePanel edge={selectedEdge} nodes={all.nodes} label={label} actions={actions} />;
  }

  return (
    <section aria-labelledby="graf-powiazan">
      <header className="section-head">
        <div>
          <h2 id="graf-powiazan">Graf śledczy</h2>
          <p className="muted">
            Widocznych {graph.nodes.length} z {all.nodes.length} węzłów i {graph.edges.length} z {all.edges.length} relacji. Styl linii oznacza status relacji —
            hipoteza (linia przerywana) nie jest ustaleniem.
          </p>
        </div>
        <div className="graph-switches">
          <div className="segmented" role="group" aria-label="Warstwa grafu">
            {LAYER_OPTIONS.map((option) => (
              <button key={option.id} type="button" aria-pressed={layer === option.id} onClick={() => setLayer(option.id)}>
                {option.label}
                {option.id === 'chain' && ` (${chainEdges})`}
              </button>
            ))}
          </div>
          {!flow && (
            <div className="segmented" role="group" aria-label="Układ grafu">
              <button type="button" aria-pressed={!radial} onClick={() => setRadial(false)}>
                Warstwowy
              </button>
              <button type="button" aria-pressed={radial} onClick={() => setRadial(true)}>
                Promienisty
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="card graph-filters">
        <fieldset className="filters">
          <legend>Status relacji</legend>
          {CLAIM_STATUSES.map((status) => (
            <label key={status} className="filter-chip" title={CLAIM_STATUS_MEANING[status]}>
              <input type="checkbox" checked={statuses.has(status)} onChange={() => setStatuses(toggled(statuses, status))} />
              <StatusSwatch status={status} />
              {CLAIM_STATUS_LABEL[status]} ({statusCount(status)})
            </label>
          ))}
        </fieldset>
        <fieldset className="filters">
          <legend>Rodzaj węzła</legend>
          {kinds
            .filter((kind) => kind !== 'subject')
            .map((kind) => (
              <label key={kind} className="filter-chip">
                <input type="checkbox" checked={!hiddenKinds.has(kind)} onChange={() => setHiddenKinds(toggled(hiddenKinds, kind))} />
                {NODE_KIND_PLURAL[kind] ?? kind}
              </label>
            ))}
        </fieldset>
        <fieldset className="filters">
          <legend className="visually-hidden">Wynik i gałęzie</legend>
          <label>
            Minimalny wynik / waga: <output>{minScore}</output>
            <input type="range" min={0} max={90} step={10} value={minScore} onChange={(event) => setMinScore(Number(event.target.value))} />
          </label>
          <button type="button" className="button button-small" onClick={() => { setCollapsed(new Set()); setSourcesShown(new Set(sources.keys())); }}>
            Rozwiń wszystko
          </button>
          <button type="button" className="button button-small" onClick={() => { setCollapsed(new Set()); setSourcesShown(new Set()); }}>
            Schowaj źródła
          </button>
        </fieldset>
        {picking && (
          <p className="notice notice-inline" role="status">
            Wskaż na grafie drugi węzeł ścieżki dowodowej.{' '}
            <button type="button" className="link-button" onClick={() => setPicking(false)}>
              Anuluj
            </button>
          </p>
        )}
      </div>

      {graph.nodes.length === 0 ? (
        <EmptyState title={flow ? 'Brak przepływów blockchain do pokazania' : 'Żaden element nie spełnia filtrów'}>
          {flow ? 'Teczka nie zawiera przelewów ani ścieżek środków spełniających filtry.' : 'Włącz więcej statusów, rodzajów węzłów albo obniż minimalny wynik.'}
        </EmptyState>
      ) : (
        <div className="graph-layout">
          <Canvas minFit={0.72} width={layout.width} height={layout.height} label={flow ? 'Przepływy blockchain: od lewej do prawej zgodnie z kierunkiem przelewów' : 'Graf śledczy podmiotu'} className={`link-graph ${picking ? 'is-picking' : ''}`}>
            {layout.columns.map((column, index) => (
              <text key={`${column.kind}-${index}`} className="graph-column" x={column.x} y={14} textAnchor="middle">
                {column.label ?? NODE_KIND_PLURAL[column.kind]}
              </text>
            ))}
            {layout.centre && layout.rings.map((ring) => <circle key={ring.kind} className="graph-ring" cx={layout.centre!.x} cy={layout.centre!.y} r={ring.radius} />)}
            {graph.edges.map((edge) => {
              const geometry = edgeGeometry(at(edge.from), at(edge.to), curved);
              const status = edgeStatus(edge);
              const dim = (near && !(edge.from === active || edge.to === active)) || (path && !pathEdges.has(edge.id));
              const chain = edgeLayer(edge) === 'chain';
              const description = `${EDGE_KIND_LABEL[edge.kind] ?? edge.kind}: ${label(edge.from)} → ${label(edge.to)}, ${CLAIM_STATUS_LABEL[status]}${edge.label ? `, ${edge.label}` : ''}`;
              const caption = status === 'rejected' ? truncate(edge.label ?? 'odrzucone', 26) : status === 'hypothesis' && (edge.kind === 'same_operator' || edge.kind === 'operates') ? 'hipoteza' : null;
              const pick = () => setSelection({ type: 'edge', id: edge.id });
              return (
                <g
                  key={edge.id}
                  data-node
                  className={`gedge gedge-${edge.kind} st-${status} ${dim ? 'is-dim' : ''} ${pathEdges.has(edge.id) ? 'is-path' : ''} ${selection?.type === 'edge' && selection.id === edge.id ? 'is-selected' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={description}
                  onClick={pick}
                  onKeyDown={onKey(pick)}
                >
                  <title>{description}</title>
                  <path className="gedge-hit" d={geometry.path} />
                  <path className="gedge-line" d={geometry.path} strokeWidth={status === 'source_fact' ? 1.4 + (edge.weight ?? 20) / 45 : undefined} />
                  {chain && <polygon className="gedge-arrow" points="-5,-4 5,0 -5,4" transform={`translate(${geometry.mid.x},${geometry.mid.y}) rotate(${geometry.angle})`} />}
                  {status === 'confirmed' && (
                    <g className="gedge-mark" transform={`translate(${geometry.mid.x},${geometry.mid.y - (chain ? 12 : 0)})`}>
                      <circle r={8} />
                      <path className="gedge-check" d="M-4,0 l3,3 l5,-6" />
                    </g>
                  )}
                  {caption && (
                    <text className={`gedge-label ${status === 'rejected' ? 'is-struck' : ''}`} x={geometry.mid.x} y={geometry.mid.y - 6} textAnchor="middle">
                      {caption}
                    </text>
                  )}
                </g>
              );
            })}
            {graph.nodes.map((node) => {
              const point = at(node.id);
              const status = nodeStatus(node);
              const level = node.score === undefined ? '' : `level-${scoreLevel(node.score, node.excluded)}`;
              const branch = node.kind === 'subject' ? 0 : branchSize(node.id);
              const isCollapsed = collapsed.has(node.id);
              const sourceCount = sources.get(node.id) ?? 0;
              const shown = sourcesShown.has(node.id);
              const caption = status === 'hypothesis' ? 'hipoteza' : status === 'confirmed' ? '✓ potwierdzone przez analityka' : status === 'rejected' ? 'odrzucone' : null;
              const description = `${NODE_KIND_LABEL[node.kind] ?? node.kind}: ${node.label}${node.sublabel ? `, ${node.sublabel}` : ''}${status ? `, ${CLAIM_STATUS_LABEL[status]}` : ''}${node.score === undefined ? '' : `, wynik ${node.score} na 100`}${node.excluded ? ', odrzucony' : ''}`;
              const dim = (near && !near.has(node.id)) || (path && !pathNodes.has(node.id));
              return (
                <g
                  key={node.id}
                  data-node
                  className={`gnode gnode-${node.kind} ${level} ${status ? `st-${status}` : ''} ${node.excluded ? 'is-excluded' : ''} ${dim ? 'is-dim' : ''} ${pathNodes.has(node.id) ? 'is-path' : ''} ${selection?.type === 'node' && selection.id === node.id ? 'is-selected' : ''}`}
                  transform={`translate(${point.x},${point.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={description}
                  onClick={(event) => clickNode(node.id, event)}
                  onDoubleClick={() => branch > 0 && toggleCollapse(node.id)}
                  onKeyDown={onKey((event) => clickNode(node.id, event))}
                  onPointerEnter={() => setActive(node.id)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(node.id)}
                  onBlur={() => setActive(null)}
                >
                  <title>{description}</title>
                  <Glyph kind={node.kind} />
                  {radial && !flow ? (
                    <>
                      <text className="gnode-label" y={30} textAnchor="middle">
                        {truncate(node.label, 16)}
                      </text>
                      {caption && (
                        <text className="gnode-caption" y={42} textAnchor="middle">
                          {caption}
                        </text>
                      )}
                    </>
                  ) : (
                    <>
                      <text className="gnode-label" x={22} y={node.sublabel || caption ? -3 : 4}>
                        {truncate(node.label, 24)}
                        {node.score !== undefined && !node.excluded && <tspan className="gnode-score"> {node.score}</tspan>}
                      </text>
                      {(caption || node.sublabel) && (
                        <text className="gnode-sub" x={22} y={12}>
                          {caption && <tspan className="gnode-caption">{caption}</tspan>}
                          {caption && node.sublabel ? ' · ' : ''}
                          {node.sublabel ? truncate(node.sublabel, caption ? 20 : 30) : ''}
                        </text>
                      )}
                    </>
                  )}
                  {branch > 0 && (
                    <g
                      className="gnode-toggle"
                      transform="translate(-27,0)"
                      role="button"
                      tabIndex={0}
                      aria-expanded={!isCollapsed}
                      aria-label={isCollapsed ? `Rozwiń gałąź: ${node.label}` : `Zwiń gałąź: ${node.label}`}
                      onClick={stop(() => toggleCollapse(node.id))}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={onKey(() => toggleCollapse(node.id))}
                    >
                      <circle r={8} />
                      <path d={isCollapsed ? 'M-2,-4 L3,0 L-2,4' : 'M-4,-2 L0,3 L4,-2'} />
                      {isCollapsed && (graph.hiddenCount.get(node.id) ?? 0) > 0 && (
                        <text className="gnode-hidden" x={-11} y={4} textAnchor="end">
                          +{graph.hiddenCount.get(node.id)}
                        </text>
                      )}
                    </g>
                  )}
                  {sourceCount > 0 && (
                    <g
                      className={`gnode-sources ${shown ? 'is-open' : ''}`}
                      transform="translate(0,-22)"
                      role="button"
                      tabIndex={0}
                      aria-expanded={shown}
                      aria-label={`${shown ? 'Schowaj' : 'Pokaż'} źródła dowodowe (${sourceCount}): ${node.label}`}
                      onClick={stop(() => toggleSources(node.id))}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={onKey(() => toggleSources(node.id))}
                    >
                      <rect x={-19} y={-7} width={38} height={14} rx={7} />
                      <text y={3.5} textAnchor="middle">
                        {shown ? '−' : '+'}
                        {sourceCount} źr.
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </Canvas>
          <aside className={`side-panel ${selectedNode || selectedEdge || pathEnds ? '' : 'side-panel-empty'}`} aria-label="Szczegóły elementu grafu">
            {pathEnds && <PathSection path={path} ends={pathEnds} label={label} onClear={() => setPathEnds(null)} />}
            {panel}
          </aside>
        </div>
      )}

      <div className="graph-legend" aria-label="Legenda grafu">
        <ul className="legend-row">
          {CLAIM_STATUSES.map((status) => (
            <li key={status} title={CLAIM_STATUS_MEANING[status]}>
              <StatusSwatch status={status} /> <span className={status === 'rejected' ? 'is-struck' : undefined}>{CLAIM_STATUS_LABEL[status]}</span>
            </li>
          ))}
          <li>
            <svg className="legend-glyph gnode gnode-operator st-hypothesis" viewBox="-20 -20 40 40" aria-hidden="true">
              <Glyph kind="operator" />
            </svg>
            obrys przerywany + podpis „hipoteza”: węzeł nie jest ustaloną tożsamością
          </li>
        </ul>
        <ul className="legend-row">
          {kinds.map((kind) => (
            <li key={kind}>
              <svg className={`legend-glyph gnode gnode-${kind}`} viewBox="-20 -20 40 40" aria-hidden="true">
                <Glyph kind={kind} />
              </svg>
              {NODE_KIND_LABEL[kind] ?? kind}
            </li>
          ))}
          <li>
            <span className="legend-arrow" aria-hidden="true">
              ➤
            </span>{' '}
            strzałka: kierunek przepływu w blockchainie
          </li>
        </ul>
      </div>
    </section>
  );
}
