// „Rozwiń” w grafie śledczym: wybór grup relacji z kosztem, postęp, wynik i powody zatrzymania;
// historia rozwinięć z wycofaniem; wyszukiwanie ścieżki między dowolnymi węzłami i do wpisu listy sankcyjnej.
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../api.ts';
import { Disclosure } from '../components/ui/Disclosure.tsx';
import { Hint } from '../components/ui/Hint.tsx';
import { Term } from '../components/ui/Term.tsx';
import { fmtDateTime } from '../format.ts';
import { NODE_KIND_LABEL } from '../labels.ts';
import { RELATION_GROUP_LABEL, depthSummary, expansionSummary, sanctionedNodes } from './network.ts';
import type { ExpansionRecord, NetworkNode, NetworkPlan, NetworkView, RelationGroup } from './network.ts';
import './network.css';

/** Sieć sprawy z usługi; `null`, gdy usługa jej nie udostępnia albo sprawa nie ma analizy. */
export function useNetwork(caseId: string, enabled: boolean) {
  const [network, setNetwork] = useState<NetworkView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setNetwork(await api.getNetwork(caseId));
      setError(null);
    } catch (problem) {
      setError(errorMessage(problem));
    }
  }, [caseId, enabled]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { network, error, reload };
}

const LEVEL_CLASS: Record<string, string> = { documented: 'chip-ok', distant: 'chip-calc', circumstantial: 'chip-warn', none: 'chip-warn' };

interface ExpandPanelProps {
  node: NetworkNode;
  caseId: string;
  network: NetworkView | null;
  label: (id: string) => string;
  onExpanded: (record: ExpansionRecord) => void;
  onPath: (from: string, to: string) => void;
  subjectId?: string;
}

/** Sekcja „Rozwiń” w panelu bocznym węzła. */
export function ExpandPanel({ node, caseId, network, label, onExpanded, onPath, subjectId }: ExpandPanelProps) {
  const [plan, setPlan] = useState<NetworkPlan | null | undefined>(undefined);
  const [chosen, setChosen] = useState<ReadonlySet<RelationGroup>>(new Set());
  const [depth, setDepth] = useState(1);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ record: ExpansionRecord; added: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inNetwork = network?.graph.nodes.some((item) => item.id === node.id) ?? false;

  useEffect(() => {
    let cancelled = false;
    setPlan(undefined);
    setResult(null);
    setError(null);
    if (!inNetwork) return;
    api
      .getNetworkPlan(caseId, node.id)
      .then((value) => {
        if (cancelled) return;
        setPlan(value);
        // Domyślnie zaznaczone grupy dostępne i jeszcze niewykonane.
        setChosen(new Set((value?.groups ?? []).filter((group) => group.available && !group.done).map((group) => group.id)));
      })
      .catch((problem) => !cancelled && setError(errorMessage(problem)));
    return () => {
      cancelled = true;
    };
  }, [caseId, node.id, inNetwork, network?.expansions.length]);

  if (!network || !inNetwork) return null;
  const sanctioned = node.meta?.sanctioned;
  const cost = (plan?.groups ?? []).filter((group) => chosen.has(group.id)).reduce((total, group) => total + group.cost, 0);
  const limit = plan?.limits?.defaultBudget ?? 20;

  async function expand() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.expandNetwork(caseId, { nodeId: node.id, relations: [...chosen], depth });
      setResult({ record: response.expansion, added: response.added.nodes });
      onExpanded(response.expansion);
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="expand-panel" aria-label="Rozwijanie sieci">
      {node.link && (
        <div className={`network-link level-${node.link.level}`}>
          <p>
            <span className={`chip ${LEVEL_CLASS[node.link.level] ?? 'chip-warn'}`}>{node.link.label}</span>
          </p>
          <p className="muted small">
            Powiązanie z podmiotem: {node.link.summary}
            {node.link.hypotheses > 0 && ` · kroków-hipotez: ${node.link.hypotheses}`} · siła ścieżki {Math.round(node.link.strength * 100)}/100.{' '}
            <Term id="hipoteza">Hipoteza</Term> na ścieżce osłabia ją i nie pozwala opisać bytu jako powiązanego z podmiotem.
          </p>
          {subjectId && (
            <button type="button" className="button button-small" onClick={() => onPath(node.id, subjectId)}>
              Pokaż ścieżkę do podmiotu
            </button>
          )}
        </div>
      )}
      {sanctioned && (
        <p className={`notice notice-inline sanctions-banner ${sanctioned.synthetic ? 'is-synthetic' : ''}`}>
          Wpis na liście: <strong>{sanctioned.list}</strong> ({sanctioned.entryId}).{' '}
          {sanctioned.synthetic ? 'LISTA SYNTETYCZNA — dane zmyślone na potrzeby demonstracji. ' : 'Potwierdź w aktualnej wersji listy. '}
          Trafienie jest faktem wyłącznie dla tego bytu — nie dla osób i kont na ścieżce do podmiotu.
        </p>
      )}
      <h4>Rozwiń</h4>
      {plan === undefined && !error && <p className="muted small">Sprawdzanie dostępnych dróg rozwinięcia…</p>}
      {plan === null && <p className="muted small">Usługa analizy nie udostępnia rozwijania dla tego węzła.</p>}
      {plan && !plan.expandable && <p className="muted small">{plan.reason}</p>}
      {plan?.expandable && (
        <>
          <fieldset className="expand-groups">
            <legend className="visually-hidden">Grupy relacji do rozwinięcia</legend>
            {plan.groups.map((group) => (
              <label key={group.id} className={`filter-chip ${group.available ? '' : 'is-disabled'}`} title={group.available ? undefined : 'Droga niedostępna w tej konfiguracji — szczegóły poniżej.'}>
                <input
                  type="checkbox"
                  disabled={!group.available || busy}
                  checked={chosen.has(group.id)}
                  onChange={() => {
                    const next = new Set(chosen);
                    if (!next.delete(group.id)) next.add(group.id);
                    setChosen(next);
                  }}
                />
                {RELATION_GROUP_LABEL[group.id] ?? group.label}
                <span className="muted small">{group.done ? ' · wykonano' : group.cost > 0 ? ` · ~${group.cost} zapyt.` : ' · bez zapytań'}</span>
              </label>
            ))}
          </fieldset>
          <div className="expand-actions">
            <label>
              Głębokość{' '}
              <select value={depth} disabled={busy} onChange={(event) => setDepth(Number(event.target.value))}>
                {[1, 2, 3].map((value) => (
                  <option key={value} value={value}>
                    {value === 1 ? '1 krok' : `${value} kroki`}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="button button-small button-primary" disabled={busy || chosen.size === 0} onClick={expand}>
              {busy ? 'Rozwijanie…' : 'Rozwiń'}
            </button>
            <span className="muted small">
              szacunek: {cost === 0 ? 'bez zapytań do źródeł' : `ok. ${cost} zapytań`} {depth > 1 ? '(dla 1. kroku; dalsze kroki w limicie budżetu)' : ''} · budżet {limit}
            </span>
          </div>
          {busy && (
            <p className="status-box" role="status">
              <span className="spinner" aria-hidden="true" /> Rozwijanie „{node.label}”: pytam źródła wybrane w analizie sprawy, w granicach budżetu…
            </p>
          )}
          {plan.items.some((item) => !item.available) && (
            <Disclosure title="Drogi niedostępne" meta={plan.items.filter((item) => !item.available).length}>
              <ul className="plain-list">
                {plan.items
                  .filter((item) => !item.available)
                  .map((item) => (
                    <li key={item.expander}>
                      <strong>{item.label}</strong> — {item.reason}
                    </li>
                  ))}
              </ul>
            </Disclosure>
          )}
          {plan.items.length > 0 && (
            <Disclosure title="Co i na jakiej podstawie" meta={plan.items.length}>
              <ul className="plain-list expand-basis">
                {plan.items.map((item) => (
                  <li key={item.expander}>
                    <strong>{item.label}</strong>
                    <span className="muted small"> · {RELATION_GROUP_LABEL[item.group]}</span>
                    <br />
                    <span className="small">{item.reads}</span>
                    <br />
                    <span className="muted small">
                      Źródło: {item.provider}. Podstawa: {item.legalBasis}.
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </>
      )}
      {error && <p className="notice notice-inline">{error}</p>}
      {result && (
        <div className="expand-result" role="status">
          <p>
            <strong>
              Dodano {result.added} {result.added === 1 ? 'węzeł' : 'węzłów'} i {result.record.results.edges.length} relacji
            </strong>{' '}
            · zapytań {result.record.budget.used}/{result.record.budget.limit}. Nowe węzły mają znaczek „nowe”.
          </p>
          {result.record.stops.length > 0 && (
            <Disclosure title="Powody zatrzymania" meta={result.record.stops.length}>
              <ul className="plain-list">
                {result.record.stops.map((stop, index) => (
                  <li key={index}>{stop.detail}</li>
                ))}
              </ul>
            </Disclosure>
          )}
          {result.record.sourceErrors.length > 0 && (
            <p className="notice notice-inline">
              Nie odpowiedziały: {result.record.sourceErrors.map((item) => `${item.source} (${item.message})`).join('; ')} — wynik w tej części jest niepełny.
            </p>
          )}
          <p className="muted small">Wynik zapisano w historii rozwinięć sprawy ({label(result.record.nodeId)}); można go wycofać.</p>
        </div>
      )}
    </section>
  );
}

interface NetworkToolsProps {
  caseId: string;
  network: NetworkView;
  nodes: NetworkNode[];
  label: (id: string) => string;
  subjectId?: string;
  onPath: (from: string, to: string) => void;
  /** Ścieżka o największej sile od podmiotu do wpisu listy sankcyjnej. */
  onRiskPath?: (from: string, to: string) => void;
  onChanged: () => void;
  hidden: boolean;
  onToggleHidden: () => void;
}

/** Pasek sieci pod filtrami: liczniki kroków, przełącznik rozwinięć, wyszukiwanie ścieżek, historia z wycofaniem. */
export function NetworkTools({ caseId, network, nodes, label, subjectId, onPath, onRiskPath, onChanged, hidden, onToggleHidden }: NetworkToolsProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState(subjectId ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expanded = network.graph.nodes.filter((node) => node.expansionId).length;
  const sanctioned = sanctionedNodes(network.graph.nodes);
  const sorted = [...nodes].sort((a, b) => a.label.localeCompare(b.label, 'pl'));
  const active = network.expansions.filter((record) => !record.withdrawnAt).length;

  async function withdraw(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api.withdrawExpansion(caseId, id);
      onChanged();
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="network-tools">
      {network.expansions.length === 0 && (
        <Hint id="rozwijanie-sieci" title="Rozwijanie sieci">
          Kliknij dowolny węzeł (konto, e-mail, adres, organizację, publikację) i w panelu bocznym wybierz „Rozwiń”. Każdy krok jest zapisany w historii, ma
          dowody i podstawę prawną, a ścieżka do podmiotu pokazuje najsłabsze ogniwo. {network.demo ? 'W trybie demonstracyjnym dane rozwinięć są zmyślone.' : ''}
        </Hint>
      )}
      <p className="muted small network-counts">
        Sieć: {depthSummary(network.depthCounts)}
        {expanded > 0 && (
          <>
            {' '}
            <button type="button" className="button button-small" aria-pressed={hidden} onClick={onToggleHidden}>
              {hidden ? `Pokaż węzły z rozwinięć (${expanded})` : `Ukryj węzły z rozwinięć (${expanded})`}
            </button>
          </>
        )}
        {sanctioned.length > 0 && subjectId && (
          <>
            {' '}
            {sanctioned.slice(0, 3).map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="button button-small button-danger"
                title={`Najmocniejsza ścieżka od podmiotu do wpisu „${entry.label}”; każdy krok ze swoim statusem.`}
                onClick={() => (onRiskPath ?? onPath)(subjectId, entry.id)}
              >
                Ścieżka do podmiotu z listy sankcyjnej{sanctioned.length > 1 ? `: ${entry.label}` : ''}
              </button>
            ))}
          </>
        )}
      </p>
      <Disclosure title="Szukaj ścieżki" meta="między dowolnymi dwoma węzłami" className="path-search">
        <div className="path-search-form">
          <label>
            Od{' '}
            <select value={from} onChange={(event) => setFrom(event.target.value)}>
              <option value="">— wybierz węzeł —</option>
              {sorted.map((node) => (
                <option key={node.id} value={node.id}>
                  {NODE_KIND_LABEL[node.kind] ?? node.kind}: {node.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Do{' '}
            <select value={to} onChange={(event) => setTo(event.target.value)}>
              <option value="">— wybierz węzeł —</option>
              {sorted.map((node) => (
                <option key={node.id} value={node.id}>
                  {NODE_KIND_LABEL[node.kind] ?? node.kind}: {node.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button button-small" disabled={!from || !to || from === to} onClick={() => onPath(from, to)}>
            Pokaż ścieżkę
          </button>
        </div>
        <p className="muted small">Najpierw szukana jest droga po samych faktach; hipotezy wchodzą do ścieżki dopiero, gdy innej drogi nie ma.</p>
      </Disclosure>
      <Disclosure title="Historia rozwinięć" meta={network.expansions.length === 0 ? 'brak' : `${active} obowiązujących z ${network.expansions.length}`} className="expansion-history">
        {network.expansions.length === 0 ? (
          <p className="muted">Nie rozwijano jeszcze sieci tej sprawy.</p>
        ) : (
          <ol className="history">
            {[...network.expansions].reverse().map((record) => (
              <li key={record.id} className={`history-item ${record.withdrawnAt ? 'is-withdrawn' : ''}`}>
                <p className="history-main">{expansionSummary(record, label)}</p>
                <p className="muted small">
                  {record.requestedBy} · {fmtDateTime(record.startedAt)}
                  {record.sourceErrors.length > 0 && ` · błędy źródeł: ${record.sourceErrors.length}`}
                </p>
                {record.stops.length > 0 && (
                  <Disclosure title="Powody zatrzymania i uwagi" meta={record.stops.length}>
                    <ul className="plain-list">
                      {record.stops.map((stop, index) => (
                        <li key={index}>{stop.detail}</li>
                      ))}
                    </ul>
                  </Disclosure>
                )}
                {record.withdrawnAt ? (
                  <p className="history-withdrawn">
                    Wycofano {fmtDateTime(record.withdrawnAt)}
                    {record.withdrawnBy ? ` · ${record.withdrawnBy}` : ''} — wynik nie jest już częścią sieci (wpis zostaje w audycie).
                  </p>
                ) : (
                  <button type="button" className="button button-small" disabled={busy === record.id} onClick={() => withdraw(record.id)}>
                    Wycofaj rozwinięcie
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        {error && <p className="notice notice-inline">{error}</p>}
      </Disclosure>
    </div>
  );
}
