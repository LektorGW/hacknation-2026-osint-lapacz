// Graf śledczy: podmiot → hipotezy operatora → persony → konta → adresy → usługi. Własny SVG,
// układ warstwowy, promienisty albo przepływowy (warstwa blockchain), statusy relacji, zwijanie gałęzi,
// filtry, ścieżka dowodowa i decyzje analityka w panelu bocznym.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react';
import type { ClaimStatus, Dossier, GraphEdge, GraphNode, GraphNodeKind } from '@olcys/core';
import { EmptyState, ExternalLink } from '../components/common.tsx';
import { Disclosure } from '../components/ui/Disclosure.tsx';
import { Score, ScoreSteps } from '../components/ui/Score.tsx';
import { Term } from '../components/ui/Term.tsx';
import { DecisionControls, DecisionHistory, useDossier } from '../components/DossierContext.tsx';
import { EvidenceRefs, OperatorDecision, OperatorHypothesisDetails, IndicatorScore, StatusBadge } from '../components/Indicators.tsx';
import { SyntheticTag } from '../components/Mode.tsx';
import { addressKey, jointProbability } from '../dossier.ts';
import { fmtAmount, fmtPln, scoreLevel, truncate } from '../format.ts';
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
} from '../labels.ts';
import { Canvas } from './Canvas.tsx';
import type { CanvasCentre } from './Canvas.tsx';
import { RELATION_TEXT } from '../identities.ts';
import type { FullDossier } from '../proof.ts';
import {
  applyView,
  childMap,
  collapseGraph,
  declutter,
  edgeLayer,
  edgeStatus,
  findEvidencePath,
  hypothesisForEdge,
  inputNodeIds,
  linkKeyOf,
  nodeStatus,
  searchNodes,
  sourceCounts,
  toggled,
  withinHops,
} from './investigation.ts';
import type { EvidencePath, LayerView } from './investigation.ts';
import { KIND_ORDER, edgeGeometry, flowLayout, layeredLayout, neighbourhood, pointOnEdge, radialLayout } from './layout.ts';
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
    const joint = jointProbability(dossier, finding);
    return (
      <>
        <p className="mono address">{finding.address}</p>
        <div className="panel-scores">
          {joint !== undefined && !finding.confidence.excluded && <Score value={joint} kind="joint" caption={<Term id="osoba-adres">powiązanie z osobą</Term>} />}
          <Score value={finding.confidence.score} kind="publication" excluded={finding.confidence.excluded} ledger={finding.confidence.ledger} caption={<Term id="wskaznik-pewnosci">publikacja adresu</Term>} />
        </div>
        <Disclosure title="Skąd wynik — krok po kroku" meta={finding.confidence.ledger.length}>
          <ScoreSteps ledger={finding.confidence.ledger} compact />
        </Disclosure>
        <p>
          <a href={tabHref('adresy')}>Pełna karta adresu →</a>
        </p>
        <DecisionControls target="address" decisionKey={addressKey(finding)} confirmLabel="To adres tej osoby" rejectLabel="To nie jest adres tej osoby" />
        <Disclosure title="Historia zmian">
          <DecisionHistory keys={[addressKey(finding)]} />
        </Disclosure>
      </>
    );
  }
  if (node.kind === 'profile') {
    const profile = dossier.profiles.find((item) => node.id.endsWith(item.id) || (node.url !== undefined && item.url === node.url));
    if (!profile) return null;
    return (
      <>
        <div className="panel-scores">
          <Score value={profile.identityScore} kind="person" reasons={profile.identityReasons} caption="pewność, że to konto osoby ze sprawy" />
        </div>
        <p>
          <span className="status status-calc">{IDENTITY_LABEL[profile.identityMatch] ?? profile.identityMatch}</span>
        </p>
        <p>
          <a href={tabHref('profile')}>Karta profilu →</a>
        </p>
        <DecisionControls target="profile" decisionKey={profile.id} confirmLabel="Potwierdź: konto podmiotu" rejectLabel="Odrzuć: to nie konto podmiotu" />
        <Disclosure title="Historia zmian">
          <DecisionHistory keys={[profile.id]} />
        </Disclosure>
      </>
    );
  }
  if (node.kind === 'source' && node.id.startsWith('reply:')) {
    return (
      <p className="reply-banner is-confirmed">
        <Term id="odpowiedz-uslugi">Dokument spoza OSINT</Term> — odpowiedź usługi wprowadzona przez analityka. Narzędzie nie weryfikuje jego autentyczności.{' '}
        <a href={tabHref('uslugi')}>Treść odpowiedzi →</a>
      </p>
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
    <div className="panel-scores">
      <Score value={value} kind="strength" caption={label} />
    </div>
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
      {node.score !== undefined && node.kind !== 'address' && node.kind !== 'profile' && <OrdinalScore label="Wynik węzła" value={node.score} />}
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
      <Disclosure title="Połączenia" meta={touching.length} defaultOpen={touching.length <= 6}>
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
      </Disclosure>
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

/** Kwota na krawędzi przepływu bez przedrostka „krok N:” — w widoku przepływów kolumny i tak są krokami. */
const flowCaption = (edge: GraphEdge) => (edge.label ? edge.label.replace(/^krok \d+:\s*/u, '').replace(/ przel\.,/u, ' przel. ·') : null);

/** Szerokość szuflady szczegółów (24rem + margines) w pikselach ekranu. */
const DRAWER_WIDTH = 400;

/** Szerokość pudełka usługi w widoku przepływów. */
const SERVICE_BOX = 196;

/** Pełny ekran: Fullscreen API, a gdy niedostępne — warstwa na całe okno (Esc zamyka). */
function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [native, setNative] = useState(false);
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    const onChange = () => setNative(document.fullscreenElement === target.current && target.current !== null);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [target]);
  useEffect(() => {
    if (!fallback) return;
    const onKey = (event: globalThis.KeyboardEvent) => event.key === 'Escape' && setFallback(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fallback]);
  const toggle = async () => {
    if (native) return void document.exitFullscreen?.();
    if (fallback) return setFallback(false);
    try {
      if (!target.current?.requestFullscreen) throw new Error('brak Fullscreen API');
      await target.current.requestFullscreen();
    } catch {
      setFallback(true);
    }
  };
  return { on: native || fallback, fallback, toggle };
}

export function GraphView() {
  const { dossier } = useDossier();
  const all = dossier.graph;
  const stage = useRef<HTMLDivElement>(null);
  const full = useFullscreen(stage);
  const [layer, setLayer] = useState<LayerView>('both');
  const [radial, setRadial] = useState(false);
  const [statuses, setStatuses] = useState<ReadonlySet<ClaimStatus>>(new Set(CLAIM_STATUSES));
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<GraphNodeKind>>(new Set());
  const [minScore, setMinScore] = useState(0);
  const [showWeak, setShowWeak] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [sourcesShown, setSourcesShown] = useState<ReadonlySet<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [pathEnds, setPathEnds] = useState<{ from: string; to: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [centre, setCentre] = useState<CanvasCentre | null>(null);

  const viewed = useMemo(() => {
    const base = applyView(all.nodes, all.edges, { statuses, kinds: new Set(KIND_ORDER.filter((kind) => !hiddenKinds.has(kind))), minScore, layer });
    return declutter(base.nodes, base.edges, { showWeak, showRejected });
  }, [all, statuses, hiddenKinds, minScore, layer, showWeak, showRejected]);
  const graph = useMemo(() => collapseGraph(viewed.nodes, viewed.edges, { collapsed, sourcesShown }), [viewed, collapsed, sourcesShown]);
  // Węzły z danymi, które wpisał analityk — wyróżnione obwódką i podpisem „wejście”.
  const inputs = useMemo(() => inputNodeIds(all.nodes, dossier.subject.identifiers), [all, dossier.subject.identifiers]);
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
  const subject = all.nodes.find((node) => node.kind === 'subject');
  const selectedId = selection?.type === 'node' ? selection.id : null;
  // Tryb skupienia: zaznaczony węzeł, jego otoczenie (2 kroki) i droga dowodowa do podmiotu.
  const focus = useMemo(() => {
    if (!selectedId || pathEnds) return null;
    const set = withinHops(graph.edges, selectedId, 2);
    if (subject && selectedId !== subject.id) for (const id of findEvidencePath(graph.edges, selectedId, subject.id)?.nodes ?? []) set.add(id);
    return set;
  }, [graph.edges, selectedId, subject, pathEnds]);
  const near = useMemo(() => (active ? neighbourhood(graph.edges, active) : null), [graph.edges, active]);
  const at = (id: string): Point => layout.positions.get(id) ?? { x: 0, y: 0 };
  const curved = flow || !radial;
  const kinds = KIND_ORDER.filter((kind) => all.nodes.some((node) => node.kind === kind));
  const label = (id: string) => all.nodes.find((item) => item.id === id)?.label ?? id;
  const statusCount = (status: ClaimStatus) => all.edges.filter((edge) => edgeStatus(edge) === status).length;
  const chainEdges = all.edges.filter((edge) => edgeLayer(edge) === 'chain').length;
  const results = useMemo(() => searchNodes(graph.nodes, query), [graph.nodes, query]);

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
    // Panel szczegółów zasłania prawą część płótna — węzeł pod nim przesuwamy w widoczne miejsce.
    const point = layout.positions.get(id);
    if (point) setCentre({ ...point, key: `${id}-${Date.now()}`, avoidRight: DRAWER_WIDTH, onlyIfHidden: true });
  }

  function find(node: GraphNode) {
    setSelection({ type: 'node', id: node.id });
    setPathEnds(null);
    const point = layout.positions.get(node.id);
    if (point) setCentre({ ...point, key: `${node.id}-${Date.now()}`, avoidRight: DRAWER_WIDTH });
    setQuery('');
  }

  function showAll() {
    setSelection(null);
    setPathEnds(null);
    setPicking(false);
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

  let panel: ReactNode = null;
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
  const panelOpen = panel !== null || pathEnds !== null;
  const dimmed = focus !== null || path !== null;
  const columns = layout.columns.map((column) => ({ x: column.x, label: column.label ?? NODE_KIND_PLURAL[column.kind] ?? column.kind }));
  const maxWeight = Math.max(1, ...graph.edges.filter((edge) => edgeLayer(edge) === 'chain').map((edge) => edge.weight ?? 0));

  return (
    <section aria-labelledby="graf-powiazan" className="graph-section">
      <header className="section-head">
        <div>
          <h2 id="graf-powiazan">Graf śledczy</h2>
          <p className="muted small">
            Widać {graph.nodes.length} z {all.nodes.length} węzłów i {graph.edges.length} z {all.edges.length} relacji. Linia przerywana to{' '}
            <Term id="hipoteza">hipoteza</Term> — nie ustalenie. Kliknij węzeł, aby skupić widok na jego otoczeniu.
          </p>
        </div>
      </header>

      <div className="graph-toolbar" role="toolbar" aria-label="Widok grafu">
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
              Kolumny
            </button>
            <button type="button" aria-pressed={radial} onClick={() => setRadial(true)}>
              Promieniście
            </button>
          </div>
        )}
        <div className="graph-search">
          <label htmlFor="znajdz-w-grafie" className="visually-hidden">
            Znajdź w grafie
          </label>
          <input
            id="znajdz-w-grafie"
            type="search"
            placeholder="Znajdź w grafie: konto, adres, usługa"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0]) {
                event.preventDefault();
                find(results[0]);
              }
            }}
            autoComplete="off"
            aria-controls="wyniki-grafu"
          />
          {results.length > 0 && (
            <ul id="wyniki-grafu" className="graph-results" role="listbox" aria-label="Wyniki wyszukiwania w grafie">
              {results.map((node) => (
                <li key={node.id}>
                  <button type="button" onClick={() => find(node)}>
                    <span className="muted small">{NODE_KIND_LABEL[node.kind] ?? node.kind}</span> {node.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {(viewed.weak > 0 || showWeak) && (
          <button type="button" className="button button-small" aria-pressed={showWeak} onClick={() => setShowWeak(!showWeak)} title="Hipotezy o wyniku lub wadze poniżej 40">
            {showWeak ? `Ukryj słabe hipotezy (${viewed.weak})` : `Pokaż słabe hipotezy (${viewed.weak})`}
          </button>
        )}
        {(viewed.rejected > 0 || showRejected) && (
          <button type="button" className="button button-small" aria-pressed={showRejected} onClick={() => setShowRejected(!showRejected)} title="Relacje odrzucone decyzją analityka albo sprzecznością">
            {showRejected ? `Ukryj odrzucone (${viewed.rejected})` : `Pokaż odrzucone (${viewed.rejected})`}
          </button>
        )}
        {dimmed && (
          <button type="button" className="button button-small button-primary" onClick={showAll}>
            Pokaż wszystko
          </button>
        )}
      </div>

      <Disclosure title="Filtry" meta="status relacji, rodzaj węzła, minimalny wynik" className="graph-filters">
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
      </Disclosure>

      {picking && (
        <p className="status-box" role="status">
          <span>Wskaż na grafie drugi węzeł ścieżki dowodowej.</span>
          <button type="button" className="button button-small" onClick={() => setPicking(false)}>
            Anuluj
          </button>
        </p>
      )}

      {graph.nodes.length === 0 ? (
        <EmptyState title={flow ? 'Brak przepływów blockchain do pokazania' : 'Żaden element nie spełnia filtrów'}>
          {flow ? 'Teczka nie zawiera przelewów ani ścieżek środków spełniających filtry.' : 'Włącz więcej statusów, rodzajów węzłów albo obniż minimalny wynik.'}
        </EmptyState>
      ) : (
        <div ref={stage} className={`graph-stage ${full.on ? 'is-full' : ''} ${full.fallback ? 'is-full-fallback' : ''} ${panelOpen ? 'has-panel' : ''}`}>
          <Canvas
            width={layout.width}
            height={layout.height}
            minFit={0.8}
            columns={radial && !flow ? undefined : columns}
            centre={centre}
            label={flow ? 'Przepływy blockchain: od lewej do prawej zgodnie z kierunkiem przelewów' : 'Graf śledczy podmiotu'}
            className={`link-graph ${flow ? 'is-flow' : ''} ${picking ? 'is-picking' : ''} ${dimmed ? 'is-focus' : ''}`}
            tools={
              <button type="button" className="icon-button canvas-fit" onClick={full.toggle} aria-pressed={full.on} title={full.on ? 'Zamknij pełny ekran (Esc)' : 'Pełny ekran'}>
                {full.on ? 'Zamknij pełny ekran' : 'Pełny ekran'}
              </button>
            }
          >
            {layout.centre && layout.rings.map((ring) => <circle key={ring.kind} className="graph-ring" cx={layout.centre!.x} cy={layout.centre!.y} r={ring.radius} />)}
            {graph.edges.map((edge) => {
              const status = edgeStatus(edge);
              const chain = edgeLayer(edge) === 'chain';
              const toService = flow && kindOf.get(edge.to) === 'service';
              const end = toService ? { x: at(edge.to).x - 16, y: at(edge.to).y } : at(edge.to);
              const geometry = edgeGeometry(at(edge.from), end, curved);
              // W przepływach strzałka i kwota stoją w 3/4 drogi — za podpisem adresu źródłowego, nie pod nim.
              const marker = flow && chain ? pointOnEdge(at(edge.from), end, curved, 0.8) : { point: geometry.mid, angle: geometry.angle };
              const inFocus = !focus || (focus.has(edge.from) && focus.has(edge.to));
              const dim = (near && !focus && !(edge.from === active || edge.to === active)) || (path && !pathEdges.has(edge.id)) || !inFocus;
              const description = `${EDGE_KIND_LABEL[edge.kind] ?? edge.kind}: ${label(edge.from)} → ${label(edge.to)}, ${CLAIM_STATUS_LABEL[status]}${edge.label ? `, ${edge.label}` : ''}`;
              const selected = selection?.type === 'edge' && selection.id === edge.id;
              const touched = active !== null && (edge.from === active || edge.to === active);
              // Podpisy krawędzi tylko na żądanie (najechanie, zaznaczenie); w widoku przepływów — zawsze kwoty.
              const caption = flow && chain ? flowCaption(edge) : selected || touched || pathEdges.has(edge.id) ? (edge.label ? truncate(edge.label, 30) : status === 'hypothesis' ? 'hipoteza' : null) : null;
              const width = flow && chain ? 1.5 + ((edge.weight ?? 0) / maxWeight) * 7 : status === 'source_fact' ? 1.4 + (edge.weight ?? 20) / 45 : undefined;
              const pick = () => setSelection({ type: 'edge', id: edge.id });
              return (
                <g
                  key={edge.id}
                  data-node
                  className={`gedge gedge-${edge.kind} st-${status} ${dim ? 'is-dim' : ''} ${pathEdges.has(edge.id) ? 'is-path' : ''} ${selected ? 'is-selected' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={description}
                  onClick={pick}
                  onKeyDown={onKey(pick)}
                >
                  <title>{description}</title>
                  <path className="gedge-hit" d={geometry.path} />
                  <path className="gedge-line" d={geometry.path} strokeWidth={width} />
                  {chain && <polygon className="gedge-arrow" points="-6,-5 6,0 -6,5" transform={`translate(${marker.point.x},${marker.point.y}) rotate(${marker.angle})`} />}
                  {status === 'confirmed' && (
                    <g className="gedge-mark" transform={`translate(${geometry.mid.x},${geometry.mid.y - (chain ? 14 : 0)})`}>
                      <circle r={8} />
                      <path className="gedge-check" d="M-4,0 l3,3 l5,-6" />
                    </g>
                  )}
                  {caption && (
                    <text
                      className={`gedge-label ${flow && chain ? 'is-amount' : ''} ${status === 'rejected' ? 'is-struck' : ''}`}
                      // W przepływach kwota stoi bliżej celu — za podpisem adresu źródłowego, nie na nim.
                      x={marker.point.x}
                      y={marker.point.y - 12}
                      textAnchor="middle"
                    >
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
              const isInput = inputs.has(node.id);
              const statusCaption = status === 'hypothesis' ? 'hipoteza' : status === 'confirmed' ? '✓ potwierdzone' : status === 'rejected' ? 'odrzucone' : null;
              const caption = isInput ? (statusCaption ? `wejście · ${statusCaption}` : 'wejście') : statusCaption;
              const description = `${isInput ? 'Wejście wyszukiwania — ' : ''}${NODE_KIND_LABEL[node.kind] ?? node.kind}: ${node.label}${node.sublabel ? `, ${node.sublabel}` : ''}${status ? `, ${CLAIM_STATUS_LABEL[status]}` : ''}${node.score === undefined ? '' : `, wynik ${node.score} na 100`}${node.excluded ? ', odrzucony' : ''}`;
              const dim = (near && !focus && !near.has(node.id)) || (path && !pathNodes.has(node.id)) || (focus !== null && !focus.has(node.id));
              const serviceBox = flow && node.kind === 'service';
              return (
                <g
                  key={node.id}
                  data-node
                  className={`gnode gnode-${node.kind} ${level} ${status ? `st-${status}` : ''} ${isInput ? 'is-input' : ''} ${node.excluded ? 'is-excluded' : ''} ${dim ? 'is-dim' : ''} ${pathNodes.has(node.id) ? 'is-path' : ''} ${selection?.type === 'node' && selection.id === node.id ? 'is-selected' : ''} ${serviceBox ? 'is-box' : ''}`}
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
                  {isInput && !serviceBox && <circle className="gnode-input-ring" r={21} />}
                  {serviceBox ? (
                    <>
                      <rect className="gnode-box" x={-16} y={-22} width={SERVICE_BOX} height={44} rx={10} />
                      <text className="gnode-label" x={-4} y={-3}>
                        {truncate(node.label, 22)}
                      </text>
                      <text className="gnode-sub" x={-4} y={13}>
                        {truncate(node.sublabel ?? 'usługa', 28)}
                      </text>
                    </>
                  ) : (
                    <Glyph kind={node.kind} />
                  )}
                  {serviceBox ? null : radial && !flow ? (
                    <>
                      <text className="gnode-label" y={32} textAnchor="middle">
                        {truncate(node.label, 16)}
                      </text>
                      {caption && (
                        <text className={isInput ? 'gnode-caption gnode-input-tag' : 'gnode-caption'} y={46} textAnchor="middle">
                          {caption}
                        </text>
                      )}
                    </>
                  ) : (
                    <>
                      {/* Tło podpisu: krawędzie przechodzące pod podpisem nie przekreślają tekstu. */}
                      <rect
                        className="gnode-label-bg"
                        x={18}
                        y={node.sublabel || caption ? -16 : -9}
                        width={
                          Math.max(
                            truncate(node.label, 24).length * 8.2 + (node.score !== undefined && !node.excluded ? 26 : 0),
                            ((caption ?? '').length + (caption && node.sublabel ? 3 : 0) + (node.sublabel ? truncate(node.sublabel, caption ? 18 : 28).length : 0)) * 6.8,
                          ) + 10
                        }
                        height={node.sublabel || caption ? 36 : 20}
                        rx={6}
                      />
                      <text className="gnode-label" x={22} y={node.sublabel || caption ? -3 : 5}>
                        {truncate(node.label, 24)}
                        {node.score !== undefined && !node.excluded && <tspan className="gnode-score"> {node.score}</tspan>}
                      </text>
                      {(caption || node.sublabel) && (
                        <text className="gnode-sub" x={22} y={14}>
                          {caption && <tspan className={isInput ? 'gnode-caption gnode-input-tag' : 'gnode-caption'}>{caption}</tspan>}
                          {caption && node.sublabel ? ' · ' : ''}
                          {node.sublabel ? truncate(node.sublabel, caption ? 18 : 28) : ''}
                        </text>
                      )}
                    </>
                  )}
                  {branch > 0 && !serviceBox && (
                    <g
                      className="gnode-toggle"
                      transform="translate(-28,0)"
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
                      transform={serviceBox ? 'translate(150,-22)' : 'translate(0,-24)'}
                      role="button"
                      tabIndex={0}
                      aria-expanded={shown}
                      aria-label={`${shown ? 'Schowaj' : 'Pokaż'} źródła dowodowe (${sourceCount}): ${node.label}`}
                      onClick={stop(() => toggleSources(node.id))}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onKeyDown={onKey(() => toggleSources(node.id))}
                    >
                      <rect x={-21} y={-8} width={42} height={16} rx={8} />
                      <text y={4} textAnchor="middle">
                        {shown ? '−' : '+'}
                        {sourceCount} źr.
                      </text>
                    </g>
                  )}
                </g>
              );
            })}
          </Canvas>
          {panelOpen && (
            <aside className="side-panel graph-drawer" aria-label="Szczegóły elementu grafu">
              {pathEnds && <PathSection path={path} ends={pathEnds} label={label} onClear={() => setPathEnds(null)} />}
              {panel}
            </aside>
          )}
        </div>
      )}

      <Disclosure title="Legenda — kształty i linie" className="graph-legend">
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
            obrys przerywany i podpis „hipoteza”: nie ustalona tożsamość
          </li>
          <li>
            <svg className="legend-glyph gnode gnode-identifier is-input" viewBox="-24 -24 48 48" aria-hidden="true">
              <circle className="gnode-input-ring" r={21} />
              <Glyph kind="identifier" />
            </svg>
            obwódka i podpis „wejście”: dana wpisana przez analityka
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
            strzałka: kierunek przepływu; grubość linii: wartość
          </li>
        </ul>
      </Disclosure>
    </section>
  );
}

