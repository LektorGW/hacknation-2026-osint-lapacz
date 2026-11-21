// Uruchamianie analizy, historia analiz z porównaniem i dopisywanie odkrytych identyfikatorów.
import { useEffect, useState } from 'react';
import type { Dossier, RunDiff } from '@olcys/core';
import { DEFAULT_DEPTH, api, errorMessage, runAnalysis } from '../api.ts';
import type { Depth, RunProgress } from '../proof.ts';
import { AnalysisProgress, ModeSwitch, PeriodFields } from './Progress.tsx';
import { cleanPeriod } from '../proof.ts';
import type { CaseSummary, ConnectorInfo } from '../api.ts';
import { fmtDateTime } from '../format.ts';
import { IDENTIFIER_LABEL, STATUS_LABEL } from '../labels.ts';
import { href } from '../router.ts';
import { useAsync } from '../useAsync.ts';
import { EmptyState, ErrorBox, Loading, ScoreBadge } from './common.tsx';
import { DiffView } from './DiffView.tsx';
import { useToast } from './Toast.tsx';

/** Wybór źródeł (parametry wyszukiwania) i uruchomienie analizy. */
export function RunLauncher({ caseId, onDone, title = 'Ponowna analiza' }: { caseId: string; onDone: () => void; title?: string }) {
  const connectors = useAsync(() => api.listConnectors(), 'connectors');
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const [range, setRange] = useState({ from: '', to: '' });
  const [progress, setProgress] = useState<RunProgress>();

  useEffect(() => {
    if (connectors.data) setSelected(new Set(connectors.data.filter((item) => item.enabledByDefault).map((item) => item.id)));
  }, [connectors.data]);

  function toggle(connector: ConnectorInfo) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(connector.id)) next.add(connector.id);
      return next;
    });
  }

  async function start() {
    setRunning(true);
    try {
      setProgress(undefined);
      const { period, error } = cleanPeriod(range.from, range.to);
      if (error) throw new Error(error);
      await runAnalysis(caseId, [...selected], { depth, period }, setProgress);
      toast.success('Analiza zakończona — teczka została odświeżona.');
      onDone();
    } catch (failure) {
      toast.error(failure);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card" aria-labelledby="zrodla">
      <h3 id="zrodla">{title}</h3>
      {connectors.loading && <Loading label="Wczytywanie listy źródeł…" />}
      {connectors.error && <ErrorBox message={connectors.error} onRetry={connectors.reload} />}
      {connectors.data && (
        <fieldset className="connectors" disabled={running}>
          <legend className="visually-hidden">Źródła do przeszukania</legend>
          {connectors.data.map((connector) => (
            <label key={connector.id} className="connector">
              <input type="checkbox" checked={selected.has(connector.id)} onChange={() => toggle(connector)} />
              <span>
                <strong>{connector.label}</strong> <span className="muted">({connector.service})</span>
                <span className="connector-description">{connector.description}</span>
                <span className="connector-accepts">
                  Szuka po: {connector.accepts.map((type) => (IDENTIFIER_LABEL[type] ?? type).toLowerCase()).join(', ')}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <ModeSwitch depth={depth} onChange={setDepth} disabled={running} />
      <PeriodFields from={range.from} to={range.to} onChange={setRange} disabled={running} />
      <div className="actions">
        <button type="button" className="button button-primary" onClick={start} disabled={running || !connectors.data || selected.size === 0}>
          {running ? 'Analiza w toku…' : 'Uruchom analizę'}
        </button>
        {connectors.data && selected.size === 0 && <span className="muted">Zaznacz co najmniej jedno źródło.</span>}
      </div>
      {running && <AnalysisProgress title="Analiza w toku" progress={progress} depth={depth} />}
    </section>
  );
}

/** Identyfikatory odkryte w toku analizy, których nie ma jeszcze w sprawie. */
function DiscoveredIdentifiers({ dossier, onDone }: { dossier: Dossier; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const discovered = dossier.subject.identifiers.filter((item) => item.origin === 'discovered');
  if (discovered.length === 0) return null;

  async function add() {
    setBusy(true);
    try {
      await api.addIdentifiers(dossier.caseId, discovered.map((item) => item.identifier));
      toast.success(`Dopisano ${discovered.length} identyfikatorów do sprawy. Uruchom analizę, żeby je przeszukać.`);
      onDone();
    } catch (failure) {
      toast.error(failure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="odkryte">
      <h3 id="odkryte">Identyfikatory odkryte w źródłach ({discovered.length})</h3>
      <ul className="plain-list">
        {discovered.map(({ identifier }) => (
          <li key={`${identifier.type}-${identifier.value}`}>
            <span className="chip">{IDENTIFIER_LABEL[identifier.type] ?? identifier.type}</span> <strong>{identifier.value}</strong>
          </li>
        ))}
      </ul>
      <button type="button" className="button" onClick={add} disabled={busy}>
        {busy ? 'Dopisywanie…' : 'Dopisz odkryte identyfikatory do sprawy'}
      </button>
    </section>
  );
}

/** Historia analiz z wyborem dwóch pozycji do porównania. */
function RunHistory({ summary }: { summary: CaseSummary }) {
  const { runs } = summary;
  const [from, setFrom] = useState(runs.at(-2)?.id);
  const [to, setTo] = useState(runs.at(-1)?.id);
  const [diff, setDiff] = useState<RunDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function compare() {
    if (!from || !to) return;
    setLoading(true);
    setError(undefined);
    setDiff(undefined);
    try {
      setDiff(await api.getDiff(summary.id, from, to));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  if (runs.length === 0) return <EmptyState title="Nie wykonano jeszcze żadnej analizy" />;
  const canCompare = runs.length >= 2;

  return (
    <>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              {canCompare && <th scope="col">Wcześniejsza</th>}
              {canCompare && <th scope="col">Późniejsza</th>}
              <th scope="col">Rozpoczęto</th>
              <th scope="col">Stan</th>
              <th scope="col" className="num">Adresy</th>
              <th scope="col" className="num">Najwyższy wynik</th>
              <th scope="col">Teczka</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const when = fmtDateTime(run.startedAt);
              return (
                <tr key={run.id}>
                  {canCompare && (
                    <td>
                      <input type="radio" name="diff-from" checked={from === run.id} onChange={() => setFrom(run.id)} aria-label={`Analiza z ${when} jako wcześniejsza`} />
                    </td>
                  )}
                  {canCompare && (
                    <td>
                      <input type="radio" name="diff-to" checked={to === run.id} onChange={() => setTo(run.id)} aria-label={`Analiza z ${when} jako późniejsza`} />
                    </td>
                  )}
                  <td>{when}</td>
                  <td>{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className="num">{run.findingCount}</td>
                  <td className="num">
                    <ScoreBadge score={run.topScore} />
                  </td>
                  <td>
                    <a href={href.run(run.id)}>Otwórz stan z tej analizy</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {canCompare ? (
        <div className="actions">
          <button type="button" className="button" onClick={compare} disabled={loading || !from || !to || from === to}>
            {loading ? 'Porównywanie…' : 'Porównaj zaznaczone analizy'}
          </button>
          {from === to && <span className="muted">Wybierz dwie różne analizy.</span>}
        </div>
      ) : (
        <p className="muted">Porównanie będzie dostępne po wykonaniu drugiej analizy.</p>
      )}
      {error && <ErrorBox message={error} />}
      <div aria-live="polite">
        {diff && (
          <section aria-labelledby="porownanie">
            <h3 id="porownanie">Porównanie analiz</h3>
            <DiffView diff={diff} />
          </section>
        )}
      </div>
    </>
  );
}

export function RunsTab({ summary, dossier, onChanged }: { summary: CaseSummary; dossier: Dossier; onChanged: () => void }) {
  return (
    <section aria-labelledby="analizy">
      <header className="section-head">
        <h2 id="analizy">Historia analiz</h2>
      </header>
      <div className="card">
        <RunHistory summary={summary} />
      </div>
      <div className="two-columns">
        <DiscoveredIdentifiers dossier={dossier} onDone={onChanged} />
        <RunLauncher caseId={summary.id} onDone={onChanged} />
      </div>
    </section>
  );
}
