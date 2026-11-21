import { useEffect, useState } from 'react';
import type { RunDiff } from '@olcys/core';
import { api, errorMessage } from '../api.ts';
import type { CaseSummary, ConnectorInfo, RunSummary } from '../api.ts';
import { ErrorBox, Loading, ScoreBadge } from '../components/common.tsx';
import { DiffView } from '../components/DiffView.tsx';
import { fmtDateTime } from '../format.ts';
import { IDENTIFIER_LABEL, STATUS_LABEL } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

function Identifiers({ item }: { item: CaseSummary }) {
  return (
    <section className="card" aria-labelledby="identyfikatory">
      <h2 id="identyfikatory">Identyfikatory podmiotu</h2>
      <dl className="identifier-list">
        {item.query.identifiers.map((identifier, index) => (
          <div key={`${identifier.type}-${identifier.value}-${index}`}>
            <dt>{IDENTIFIER_LABEL[identifier.type] ?? identifier.type}</dt>
            <dd>{identifier.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Wybór źródeł (parametry wyszukiwania) i uruchomienie analizy. */
function RunLauncher({ caseId }: { caseId: string }) {
  const connectors = useAsync(() => api.listConnectors(), 'connectors');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (connectors.data) {
      setSelected(new Set(connectors.data.filter((item) => item.enabledByDefault).map((item) => item.id)));
    }
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
    setError(undefined);
    try {
      const run = await api.startRun(caseId, [...selected]);
      navigate(href.run(run.id));
    } catch (failure) {
      setError(errorMessage(failure));
      setRunning(false);
    }
  }

  return (
    <section className="card" aria-labelledby="zrodla">
      <h2 id="zrodla">Parametry wyszukiwania — źródła</h2>
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
      {error && <ErrorBox message={error} />}
      <div className="actions">
        <button
          type="button"
          className="button button-primary"
          onClick={start}
          disabled={running || !connectors.data || selected.size === 0}
        >
          {running ? 'Analiza w toku…' : 'Uruchom analizę'}
        </button>
        {running && <Loading label="Przeszukiwanie źródeł i danych blockchain. To może potrwać do kilkudziesięciu sekund." />}
        {connectors.data && selected.size === 0 && <span className="muted">Zaznacz co najmniej jedno źródło.</span>}
      </div>
    </section>
  );
}

/** Historia analiz z wyborem dwóch pozycji do porównania. */
function RunHistory({ caseId, runs }: { caseId: string; runs: RunSummary[] }) {
  const [from, setFrom] = useState(runs[runs.length - 2]?.id);
  const [to, setTo] = useState(runs[runs.length - 1]?.id);
  const [diff, setDiff] = useState<RunDiff>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function compare() {
    if (!from || !to) return;
    setLoading(true);
    setError(undefined);
    setDiff(undefined);
    try {
      setDiff(await api.getDiff(caseId, from, to));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }

  if (runs.length === 0) {
    return <p className="muted">Nie wykonano jeszcze żadnej analizy.</p>;
  }
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
              <th scope="col">Wynik</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const when = fmtDateTime(run.startedAt);
              return (
                <tr key={run.id}>
                  {canCompare && (
                    <td>
                      <input
                        type="radio"
                        name="diff-from"
                        checked={from === run.id}
                        onChange={() => setFrom(run.id)}
                        aria-label={`Analiza z ${when} jako wcześniejsza`}
                      />
                    </td>
                  )}
                  {canCompare && (
                    <td>
                      <input
                        type="radio"
                        name="diff-to"
                        checked={to === run.id}
                        onChange={() => setTo(run.id)}
                        aria-label={`Analiza z ${when} jako późniejsza`}
                      />
                    </td>
                  )}
                  <td>{when}</td>
                  <td>{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className="num">{run.findingCount}</td>
                  <td className="num">
                    <ScoreBadge score={run.topScore} />
                  </td>
                  <td>
                    <a href={href.run(run.id)}>Otwórz wynik</a>
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

export function CasePage({ caseId }: { caseId: string }) {
  const current = useAsync(() => api.getCase(caseId), caseId);

  return (
    <div className="page">
      <p className="breadcrumb">
        <a href={href.cases()}>Sprawy</a> / <span>{current.data?.name ?? 'Sprawa'}</span>
      </p>
      {current.loading && <Loading />}
      {current.error && <ErrorBox message={current.error} onRetry={current.reload} />}
      {current.data && (
        <>
          <h1>{current.data.name}</h1>
          <p className="muted">Utworzono {fmtDateTime(current.data.createdAt)}</p>
          <div className="two-columns">
            <Identifiers item={current.data} />
            <RunLauncher caseId={caseId} />
          </div>
          <section className="card" aria-labelledby="historia">
            <h2 id="historia">Historia analiz</h2>
            <RunHistory caseId={caseId} runs={current.data.runs} />
          </section>
        </>
      )}
    </div>
  );
}
