// Monitoring: cykliczny przegląd publicznych źródeł, lista źródeł i strumień trafień.
import { useMemo, useState } from 'react';
import type { MonitorSourceStatus, MonitorStatus, ScoredSignal, WatchHit } from '@olcys/core';
import { api } from '../api.ts';
import type { MonitorSettings } from '../api.ts';
import { Bar, Crumbs, EmptyState, ErrorBox, ExternalLink, LayerTag, ScoreBadge, ShortAddress, Skeleton } from '../components/common.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime, fmtPln } from '../format.ts';
import { NETWORK_LABEL, NETWORK_SHORT } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

const STATUS_NAME: Record<WatchHit['status'], string> = { new: 'nowe', analyzed: 'przeanalizowane', dismissed: 'odrzucone' };
const LANGUAGE: Record<string, string> = { pl: 'polski', en: 'angielski', de: 'niemiecki', ru: 'rosyjski', uk: 'ukraiński', und: 'nierozpoznany' };

function StatusBar({ status, onChange, onRun, busy }: { status: MonitorStatus; onChange: (settings: MonitorSettings) => void; onRun: () => void; busy: boolean }) {
  const [threshold, setThreshold] = useState(status.autoAnalyzeThreshold);
  const working = busy || status.running;
  return (
    <section className="card monitor-bar" aria-label="Stan monitoringu">
      <label className="switch">
        <input type="checkbox" checked={status.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
        Monitoring {status.enabled ? 'włączony' : 'wyłączony'}
      </label>
      <label>
        Przegląd co
        <input
          type="number"
          min={5}
          max={1440}
          step={5}
          defaultValue={status.everyMinutes}
          onBlur={(event) => {
            const value = Math.max(5, Number(event.target.value) || status.everyMinutes);
            if (value !== status.everyMinutes) onChange({ everyMinutes: value });
          }}
        />
        min
      </label>
      <label title="Suma ocen „Związek z Polską” i „Sygnały do sprawdzenia” (0–200), od której autor jest analizowany automatycznie">
        Próg automatycznej analizy: <output>{threshold}</output>
        <input
          type="range"
          min={0}
          max={200}
          step={10}
          value={threshold}
          onChange={(event) => setThreshold(Number(event.target.value))}
          onPointerUp={() => threshold !== status.autoAnalyzeThreshold && onChange({ autoAnalyzeThreshold: threshold })}
          onKeyUp={() => threshold !== status.autoAnalyzeThreshold && onChange({ autoAnalyzeThreshold: threshold })}
        />
      </label>
      <button type="button" className="button button-primary" onClick={onRun} disabled={working}>
        {working ? 'Przegląd w toku…' : 'Przejrzyj teraz'}
      </button>
      <dl>
        <div>
          <dt>Ostatni przebieg</dt>
          <dd>{fmtDateTime(status.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Następny przebieg</dt>
          <dd>{status.enabled ? fmtDateTime(status.nextRunAt) : 'wstrzymany'}</dd>
        </div>
        <div>
          <dt>Publikacje / trafienia</dt>
          <dd>
            {status.totals.documentsSeen.toLocaleString('pl-PL')} / {status.totals.hits}
          </dd>
        </div>
        <div>
          <dt>Nowe / przeanalizowane</dt>
          <dd>
            {status.totals.newHits} / {status.totals.analyzed}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Sources({ sources, onToggle }: { sources: MonitorSourceStatus[]; onToggle: (source: MonitorSourceStatus) => void }) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = sources.filter((source) => `${source.service} ${source.label}`.toLowerCase().includes(needle));
  const services = [...new Set(shown.map((source) => source.service))];
  const failing = sources.filter((source) => source.lastError).length;
  return (
    <details className="card">
      <summary>
        <strong>Źródła ({sources.filter((source) => source.enabled).length} włączonych z {sources.length})</strong>
        {failing > 0 && <span className="chip chip-warn"> błędy: {failing}</span>}
      </summary>
      <label className="inline-field source-filter">
        Filtr źródeł
        <input type="text" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="serwis lub nazwa" />
      </label>
      {services.map((service) => (
        <section key={service} className="source-group">
          <h3>{service}</h3>
          <div className="table-scroll">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th scope="col">Włączone</th>
                  <th scope="col">Źródło</th>
                  <th scope="col" className="num">Publikacje</th>
                  <th scope="col" className="num">Trafienia</th>
                  <th scope="col">Ostatni przebieg</th>
                </tr>
              </thead>
              <tbody>
                {shown
                  .filter((source) => source.service === service)
                  .map((source) => (
                    <tr key={source.connectorId}>
                      <td>
                        <input type="checkbox" checked={source.enabled} onChange={() => onToggle(source)} aria-label={`Źródło ${source.label}`} />
                      </td>
                      <th scope="row">
                        {source.label}
                        {source.lastError && <span className="source-error">Błąd: {source.lastError}</span>}
                      </th>
                      <td className="num">{source.documentsSeen.toLocaleString('pl-PL')}</td>
                      <td className="num">{source.hits}</td>
                      <td>{fmtDateTime(source.lastRunAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </details>
  );
}

function Signal({ title, signal }: { title: string; signal: ScoredSignal }) {
  return (
    <div className="signal">
      <strong>{title}</strong>
      <Bar value={signal.score} label={title} />
      <details className="why">
        <summary>przesłanki ({signal.reasons.length})</summary>
        <ul>
          {signal.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Cytat jako zwykły tekst, z wyróżnionymi adresami. */
function Excerpt({ text, addresses }: { text: string; addresses: string[] }) {
  let parts: (string | { address: string })[] = [text];
  for (const address of addresses) {
    parts = parts.flatMap((part) =>
      typeof part === 'string' ? part.split(address).flatMap((piece, index) => (index === 0 ? [piece] : [{ address }, piece])) : [part],
    );
  }
  return (
    <blockquote className="excerpt">
      {parts.map((part, index) => (typeof part === 'string' ? <span key={index}>{part}</span> : <mark key={index}>{part.address}</mark>))}
    </blockquote>
  );
}

function HitCard({ hit, onChanged }: { hit: WatchHit; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function openCase() {
    setBusy(true);
    try {
      const created = await api.createCaseFromHit(hit.id);
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  }

  return (
    <article className={`card hit status-${hit.status}`}>
      <header>
        <span className="muted">
          {hit.service} · {hit.author ?? 'autor nieznany'} · {fmtDateTime(hit.publishedAt ?? hit.detectedAt)}
        </span>
        <span className="chip">{STATUS_NAME[hit.status]}</span>
        <h3>
          <ExternalLink url={hit.url}>{hit.title}</ExternalLink>
        </h3>
      </header>
      <Excerpt text={hit.excerpt} addresses={hit.addresses.map((item) => item.address)} />
      <p>
        <span className="chip">język: {LANGUAGE[hit.language] ?? hit.language}</span>
        {hit.addresses.map((item) => (
          <span key={item.address} className="chip chip-mono" title={`${NETWORK_LABEL[item.network] ?? item.network}: ${item.address}`}>
            {NETWORK_SHORT[item.network] ?? item.network} · <ShortAddress value={item.address} />
          </span>
        ))}
      </p>
      <div className="signals">
        <Signal title="Związek z Polską" signal={hit.polishNexus} />
        <Signal title="Sygnały do sprawdzenia" signal={hit.suspicion} />
      </div>
      {hit.lead && (
        <div className="hit-lead">
          <LayerTag layer="calc" /> Analiza autora: priorytet <strong>{hit.lead.priority}/100</strong>, najwyższy Wskaźnik Pewności{' '}
          <ScoreBadge score={hit.lead.topScore} />
          {Object.keys(hit.lead.cashOutPlnByYear).length > 0 && (
            <>
              , szacowane wypłaty:{' '}
              {Object.entries(hit.lead.cashOutPlnByYear)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([year, value]) => `${year}: ${fmtPln(value)}`)
                .join(' · ')}
            </>
          )}
        </div>
      )}
      <div className="actions">
        {hit.caseId ? (
          <a className="button button-small button-primary" href={href.case(hit.caseId)}>
            Otwórz teczkę
          </a>
        ) : hit.lead ? (
          <button type="button" className="button button-small button-primary" onClick={openCase} disabled={busy}>
            Otwórz teczkę
          </button>
        ) : (
          <button type="button" className="button button-small" onClick={() => act(() => api.analyzeHit(hit.id), 'Przeanalizowano autora publikacji.')} disabled={busy}>
            {busy ? 'Analiza…' : 'Analizuj autora'}
          </button>
        )}
        {hit.status !== 'dismissed' && (
          <button type="button" className="button button-small" onClick={() => act(() => api.dismissHit(hit.id), 'Trafienie odrzucone.')} disabled={busy}>
            Odrzuć
          </button>
        )}
      </div>
    </article>
  );
}

function Hits({ hits, onChanged }: { hits: WatchHit[]; onChanged: () => void }) {
  const [status, setStatus] = useState<WatchHit['status'] | 'all'>('all');
  const [minPolish, setMinPolish] = useState(0);
  const [minSuspicion, setMinSuspicion] = useState(0);
  const [network, setNetwork] = useState('all');
  const [service, setService] = useState('all');
  const [byDate, setByDate] = useState(false);
  const services = useMemo(() => [...new Set(hits.map((hit) => hit.service))].sort(), [hits]);
  const networks = useMemo(() => [...new Set(hits.flatMap((hit) => hit.addresses.map((item) => item.network)))].sort(), [hits]);
  const total = (hit: WatchHit) => hit.polishNexus.score + hit.suspicion.score;
  const when = (hit: WatchHit) => hit.publishedAt ?? hit.detectedAt;
  const shown = hits
    .filter(
      (hit) =>
        (status === 'all' ? hit.status !== 'dismissed' : hit.status === status) &&
        hit.polishNexus.score >= minPolish &&
        hit.suspicion.score >= minSuspicion &&
        (network === 'all' || hit.addresses.some((item) => item.network === network)) &&
        (service === 'all' || hit.service === service),
    )
    .sort((a, b) => (byDate ? when(b).localeCompare(when(a)) : total(b) - total(a) || when(b).localeCompare(when(a))));

  return (
    <section aria-labelledby="trafienia">
      <header className="section-head">
        <h2 id="trafienia">
          Trafienia ({shown.length} z {hits.length})
        </h2>
        <div className="segmented" role="group" aria-label="Sortowanie trafień">
          <button type="button" aria-pressed={!byDate} onClick={() => setByDate(false)}>
            Wg sumy ocen
          </button>
          <button type="button" aria-pressed={byDate} onClick={() => setByDate(true)}>
            Wg daty
          </button>
        </div>
      </header>
      <fieldset className="filters card">
        <legend className="visually-hidden">Filtry trafień</legend>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">nowe i przeanalizowane</option>
            <option value="new">nowe</option>
            <option value="analyzed">przeanalizowane</option>
            <option value="dismissed">odrzucone</option>
          </select>
        </label>
        <label>
          Związek z Polską od <output>{minPolish}</output>
          <input type="range" min={0} max={100} step={10} value={minPolish} onChange={(event) => setMinPolish(Number(event.target.value))} />
        </label>
        <label>
          Sygnały od <output>{minSuspicion}</output>
          <input type="range" min={0} max={100} step={10} value={minSuspicion} onChange={(event) => setMinSuspicion(Number(event.target.value))} />
        </label>
        <label>
          Sieć
          <select value={network} onChange={(event) => setNetwork(event.target.value)}>
            <option value="all">wszystkie</option>
            {networks.map((item) => (
              <option key={item} value={item}>
                {NETWORK_LABEL[item] ?? item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Serwis
          <select value={service} onChange={(event) => setService(event.target.value)}>
            <option value="all">wszystkie</option>
            {services.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {shown.length === 0 ? (
        <EmptyState title="Brak trafień spełniających filtry">Poluzuj filtry albo uruchom przegląd przyciskiem „Przejrzyj teraz”.</EmptyState>
      ) : (
        <div className="hit-grid">
          {shown.map((hit) => (
            <HitCard key={hit.id} hit={hit} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

export function MonitoringPage() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const loaded = useAsync(async () => {
    const [status, hits] = await Promise.all([api.getMonitor(), api.listHits(200)]);
    return { status, hits };
  }, 'monitor');

  async function change(settings: MonitorSettings) {
    try {
      await api.updateMonitor(settings);
      toast.success('Zapisano ustawienia monitoringu.');
      loaded.reload();
    } catch (error) {
      toast.error(error);
    }
  }

  async function run() {
    setRunning(true);
    try {
      const result = await api.runMonitor();
      toast.success(`Przegląd zakończony: nowe trafienia — ${result.newHits}.`);
      loaded.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Monitoring' }]} />
      <h1>Monitoring źródeł</h1>
      <p className="notice" role="note">
        <LayerTag layer="inference" /> Przeglądane są wyłącznie publiczne strony dostępne bez logowania. Trafienia to wskazania do weryfikacji, a nie
        zarzuty: „Sygnały do sprawdzenia” opisują cechy publikacji, nie ocenę osoby.
      </p>
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={3} />}
      {loaded.data && (
        <>
          <StatusBar key={loaded.data.status.autoAnalyzeThreshold} status={loaded.data.status} onChange={change} onRun={run} busy={running} />
          <Sources
            sources={loaded.data.status.sources}
            onToggle={(source) => change({ sources: { [source.connectorId]: !source.enabled } })}
          />
          <Hits hits={loaded.data.hits} onChanged={loaded.reload} />
        </>
      )}
    </div>
  );
}
