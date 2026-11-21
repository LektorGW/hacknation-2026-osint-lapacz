// Typowanie: przegląd źródeł bez wskazania osoby i ranking wytypowanych podmiotów.
import { useEffect, useState } from 'react';
import type { Lead, Sweep } from '@olcys/core';
import { api } from '../api.ts';
import { Bar, Crumbs, EmptyState, ErrorBox, LayerTag, Loading, ScoreBadge, ShortAddress, Skeleton } from '../components/common.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime, fmtPln } from '../format.ts';
import { NETWORK_SHORT, STATUS_LABEL } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

function Launcher({ onDone }: { onDone: (sweep: Sweep) => void }) {
  const connectors = useAsync(() => api.listConnectors(), 'connectors');
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(20);
  const [running, setRunning] = useState(false);
  // Jeśli usługa oznacza łączniki zdolne do przeglądu, pokazujemy tylko je.
  const marked = connectors.data?.some((item) => item.discovers !== undefined);
  const usable = (connectors.data ?? []).filter((item) => !marked || item.discovers);

  useEffect(() => {
    if (connectors.data) setSelected(new Set(usable.filter((item) => item.enabledByDefault).map((item) => item.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectors.data]);

  async function start() {
    setRunning(true);
    try {
      const sweep = await api.startSweep([...selected], limit);
      toast.success(`Przegląd zakończony: wytypowano ${sweep.leads.length} podmiotów.`);
      onDone(sweep);
    } catch (error) {
      toast.error(error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <section className="card" aria-labelledby="nowy-przeglad">
      <h2 id="nowy-przeglad">Nowy przegląd źródeł</h2>
      <p className="muted">Narzędzie pobiera świeże publiczne publikacje z adresami, grupuje je po autorach i szereguje według priorytetu.</p>
      {connectors.loading && <Loading label="Wczytywanie listy źródeł…" />}
      {connectors.error && <ErrorBox message={connectors.error} onRetry={connectors.reload} />}
      {connectors.data && (
        <fieldset className="connectors" disabled={running}>
          <legend className="visually-hidden">Źródła do przeglądu</legend>
          {usable.map((connector) => (
            <label key={connector.id} className="connector">
              <input
                type="checkbox"
                checked={selected.has(connector.id)}
                onChange={() =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (!next.delete(connector.id)) next.add(connector.id);
                    return next;
                  })
                }
              />
              <span>
                <strong>{connector.label}</strong> <span className="muted">({connector.service})</span>
                <span className="connector-description">{connector.description}</span>
              </span>
            </label>
          ))}
          {!marked && <p className="hint">Przegląd wykonają tylko te źródła, które potrafią same wskazać świeże publikacje.</p>}
        </fieldset>
      )}
      <div className="actions">
        <label className="inline-field">
          Limit wskazań
          <input type="number" min={1} max={200} value={limit} onChange={(event) => setLimit(Math.max(1, Number(event.target.value) || 1))} />
        </label>
        <button type="button" className="button button-primary" onClick={start} disabled={running || selected.size === 0}>
          {running ? 'Przegląd w toku…' : 'Uruchom przegląd'}
        </button>
        {running && <Loading label="Przeglądanie źródeł i wycena przepływów…" />}
      </div>
    </section>
  );
}

function LeadRow({ lead, sweepId, rank }: { lead: Lead; sweepId: string; rank: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function openCase() {
    setBusy(true);
    try {
      const created = await api.createCaseFromLead(sweepId, lead.id);
      toast.success(`Założono sprawę „${created.name}”.`);
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  }

  return (
    <tr>
      <td className="num">{rank}</td>
      <th scope="row">
        {lead.handle}
        <span className="cell-note">{lead.services.join(', ')}</span>
      </th>
      <td>
        <Bar value={lead.priority} label={`Priorytet wskazania ${lead.handle}`} />
        <details className="why">
          <summary>powody</summary>
          <ul>
            {lead.priorityReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </details>
      </td>
      <td>
        <ul className="plain-list">
          {lead.addresses.map((item) => (
            <li key={item.address}>
              <span className="chip chip-network">{NETWORK_SHORT[item.network] ?? item.network}</span> <ShortAddress value={item.address} />{' '}
              <ScoreBadge score={item.score} title="Wskaźnik Pewności publikacji" />
            </li>
          ))}
        </ul>
      </td>
      <td className="num">
        {Object.keys(lead.cashOutPlnByYear).length === 0 ? (
          <span className="muted">brak oznak</span>
        ) : (
          Object.entries(lead.cashOutPlnByYear)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([year, value]) => (
              <span key={year} className="year-line">
                {year}: <strong>{fmtPln(value)}</strong>
              </span>
            ))
        )}
      </td>
      <td>
        {lead.caseId ? (
          <a className="button button-small" href={href.case(lead.caseId)}>
            Otwórz sprawę
          </a>
        ) : (
          <button type="button" className="button button-small button-primary" onClick={openCase} disabled={busy}>
            {busy ? 'Zakładanie…' : 'Załóż sprawę'}
          </button>
        )}
      </td>
    </tr>
  );
}

function SweepResult({ sweep }: { sweep: Sweep }) {
  const leads = [...sweep.leads].sort((a, b) => b.priority - a.priority);
  return (
    <section className="card" aria-labelledby="ranking">
      <h2 id="ranking">Ranking wskazań ({leads.length})</h2>
      <p className="muted">
        Przegląd z {fmtDateTime(sweep.startedAt)} · stan: {STATUS_LABEL[sweep.status] ?? sweep.status} · przejrzane publikacje: {sweep.documentsScanned} · źródła:{' '}
        {sweep.connectors.join(', ')}
      </p>
      {leads.length === 0 ? (
        <EmptyState title="Przegląd nie wytypował żadnego podmiotu">Wybierz więcej źródeł albo zwiększ limit wskazań.</EmptyState>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col" className="num">Lp.</th>
                <th scope="col">Podmiot (nazwa konta)</th>
                <th scope="col">Priorytet</th>
                <th scope="col">Adresy i Wskaźnik Pewności</th>
                <th scope="col" className="num">Szacowane wypłaty</th>
                <th scope="col">Sprawa</th>
              </tr>
            </thead>
            <tbody>
              {leads.map((lead, index) => (
                <LeadRow key={lead.id} lead={lead} sweepId={sweep.id} rank={index + 1} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sweep.log.length > 0 && (
        <details className="fold">
          <summary>Dziennik przeglądu ({sweep.log.length})</summary>
          <ol className="log-list">
            {sweep.log.map((entry, index) => (
              <li key={index}>
                <time dateTime={entry.time}>{fmtDateTime(entry.time)}</time>
                <span>{entry.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

export function SweepPage({ sweepId }: { sweepId?: string }) {
  const loaded = useAsync(async () => {
    const sweeps = await api.listSweeps();
    const currentId = sweepId ?? sweeps[0]?.id;
    return { sweeps, current: currentId ? await api.getSweep(currentId) : undefined };
  }, `sweep:${sweepId ?? ''}`);

  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Typowanie' }]} />
      <h1>Typowanie podmiotów</h1>
      <p className="notice" role="note">
        <LayerTag layer="inference" /> Ranking to wskazania do weryfikacji, a nie ustalenia. Podmiot trafia na listę wyłącznie na podstawie publicznych
        publikacji z adresem; dopiero sprawa i analiza pozwalają ocenić powiązanie.
      </p>
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={3} />}
      {(loaded.data || loaded.error) && (
        <Launcher
          onDone={(sweep) => {
            navigate(href.sweep(sweep.id));
            loaded.reload();
          }}
        />
      )}
      {loaded.data?.current && <SweepResult sweep={loaded.data.current} />}
      {loaded.data && !loaded.data.current && <EmptyState title="Nie wykonano jeszcze przeglądu źródeł">Wybierz źródła powyżej i uruchom pierwszy przegląd.</EmptyState>}
      {loaded.data && loaded.data.sweeps.length > 0 && (
        <section className="card" aria-labelledby="wczesniejsze">
          <h2 id="wczesniejsze">Wcześniejsze przeglądy</h2>
          <ul className="plain-list">
            {loaded.data.sweeps.map((sweep) => (
              <li key={sweep.id}>
                <a href={href.sweep(sweep.id)} aria-current={sweep.id === loaded.data!.current?.id ? 'true' : undefined}>
                  {fmtDateTime(sweep.startedAt)}
                </a>{' '}
                <span className="muted">
                  · wskazania: {sweep.leads.length} · publikacje: {sweep.documentsScanned} · {STATUS_LABEL[sweep.status] ?? sweep.status}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
