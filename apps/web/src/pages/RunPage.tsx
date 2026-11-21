import type { AnalysisRun, Finding } from '@olcys/core';
import { api, isDemo, reportHtmlUrl, reportJsonUrl } from '../api.ts';
import type { Replacement } from '../api.ts';
import { ErrorBox, LayerLegend, LayerTag, Loading } from '../components/common.tsx';
import { ReplacementList } from '../components/DiffView.tsx';
import { FindingCard, RejectedCard, findingAnchor } from '../components/FindingCard.tsx';
import { LinkMap } from '../components/LinkMap.tsx';
import { fmtDateTime, fmtPln } from '../format.ts';
import { STATUS_LABEL } from '../labels.ts';
import { href } from '../router.ts';
import { useAsync } from '../useAsync.ts';

interface RunView {
  run: AnalysisRun;
  replacements: Replacement[];
  caseName: string;
}

async function loadRun(runId: string): Promise<RunView> {
  const run = await api.getRun(runId);
  // Podmiany i nazwa sprawy są dodatkiem — ich brak nie może zablokować wyniku.
  const [replacements, caseName] = await Promise.all([
    api.getReplacements(runId).catch(() => []),
    api.getCase(run.caseId).then((item) => item.name, () => 'Sprawa'),
  ]);
  return { run, replacements, caseName };
}

/** Suma szacunków wypłat w PLN po latach, wyłącznie dla adresów nieodrzuconych. */
function cashOutByYear(findings: Finding[]): [string, number][] {
  const totals = new Map<string, number>();
  for (const finding of findings) {
    for (const [year, value] of Object.entries(finding.chain?.cashOutPlnByYear ?? {})) {
      totals.set(year, (totals.get(year) ?? 0) + value);
    }
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b));
}

function scrollToAddress(address: string) {
  const card = document.getElementById(findingAnchor(address));
  if (!card) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  card.focus({ preventScroll: true });
}

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** W trybie demo nie ma tras raportu: drukujemy bieżący widok i zapisujemy dane lokalnie. */
function ReportActions({ view }: { view: RunView }) {
  const { run } = view;
  if (isDemo) {
    return (
      <div className="actions no-print">
        <button type="button" className="button" onClick={() => window.print()}>
          Raport do druku
        </button>
        <button
          type="button"
          className="button"
          onClick={() => downloadJson(`analiza-${run.id}.json`, { run, replacements: view.replacements })}
        >
          Pobierz pakiet JSON
        </button>
      </div>
    );
  }
  return (
    <div className="actions no-print">
      <a className="button" href={reportHtmlUrl(run.id)} target="_blank" rel="noopener noreferrer">
        Raport do druku
      </a>
      <a className="button" href={reportJsonUrl(run.id)} download={`analiza-${run.id}.json`}>
        Pobierz pakiet JSON
      </a>
    </div>
  );
}

function Summary({ linked, rejected }: { linked: Finding[]; rejected: Finding[] }) {
  const topScore = Math.max(0, ...linked.map((finding) => finding.confidence.score));
  const years = cashOutByYear(linked);
  return (
    <section className="summary" aria-label="Podsumowanie analizy">
      <div className="stat">
        <span className="stat-value">{linked.length}</span>
        <span className="stat-label">adresy powiązane</span>
        <LayerTag layer="inference" />
      </div>
      <div className="stat">
        <span className="stat-value">{rejected.length}</span>
        <span className="stat-label">adresy odrzucone</span>
        <LayerTag layer="calc" />
      </div>
      <div className="stat">
        <span className="stat-value">{linked.length > 0 ? `${topScore}%` : '—'}</span>
        <span className="stat-label">najwyższy Wskaźnik Pewności</span>
        <LayerTag layer="calc" />
      </div>
      <div className="stat stat-wide">
        {years.length === 0 ? (
          <span className="stat-empty">Nie wykryto oznak wypłat na waluty tradycyjne.</span>
        ) : (
          <dl className="stat-years">
            {years.map(([year, value]) => (
              <div key={year}>
                <dt>rok podatkowy {year}</dt>
                <dd>{fmtPln(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        <span className="stat-label">
          Możliwe wypłaty na waluty tradycyjne (adresy powiązane): szacunek — wniosek do weryfikacji
        </span>
        <LayerTag layer="inference" />
      </div>
    </section>
  );
}

function RunLog({ run }: { run: AnalysisRun }) {
  return (
    <details className="card log">
      <summary>Dziennik analizy ({run.log.length} wpisów)</summary>
      <p className="muted">Użyte źródła: {run.connectors.join(', ') || 'brak'}.</p>
      <ol className="log-list">
        {run.log.map((entry, index) => (
          <li key={index}>
            <time dateTime={entry.time}>{fmtDateTime(entry.time)}</time>
            <span>{entry.message}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

function RunResult({ view }: { view: RunView }) {
  const { run, replacements, caseName } = view;
  const linked = run.findings.filter((finding) => !finding.confidence.excluded);
  const rejected = run.findings.filter((finding) => finding.confidence.excluded);

  return (
    <>
      <p className="breadcrumb">
        <a href={href.cases()}>Sprawy</a> / <a href={href.case(run.caseId)}>{caseName}</a> / <span>Wynik analizy</span>
      </p>
      <div className="page-head">
        <div>
          <h1>Wynik analizy</h1>
          <p className="muted">
            {caseName} · rozpoczęto {fmtDateTime(run.startedAt)}
            {run.finishedAt && ` · zakończono ${fmtDateTime(run.finishedAt)}`} · stan:{' '}
            {STATUS_LABEL[run.status] ?? run.status}
          </p>
        </div>
        <ReportActions view={view} />
      </div>

      {run.status === 'failed' && (
        <ErrorBox message="Analiza zakończyła się błędem — wyniki mogą być niepełne. Szczegóły w dzienniku analizy." />
      )}

      <LayerLegend />
      <Summary linked={linked} rejected={rejected} />

      {replacements.length > 0 && (
        <section className="card card-alert" aria-labelledby="podmiany">
          <h2 id="podmiany">
            Podmiany adresów ({replacements.length}) <LayerTag layer="fact" />
          </h2>
          <p>W tym samym miejscu publikacji adres został zastąpiony innym względem wcześniejszej analizy.</p>
          <ReplacementList items={replacements} />
        </section>
      )}

      {run.findings.length === 0 ? (
        <section className="card">
          <h2>Nie znaleziono adresów</h2>
          <p>W wybranych źródłach nie znaleziono adresów kryptowalutowych dla podanych identyfikatorów.</p>
        </section>
      ) : (
        <section className="card" aria-labelledby="mapa">
          <h2 id="mapa">Mapa powiązań</h2>
          <LinkMap subjectName={caseName} query={run.query} findings={run.findings} onSelectAddress={scrollToAddress} />
        </section>
      )}

      {linked.length > 0 && (
        <section aria-labelledby="powiazane">
          <h2 id="powiazane">Adresy powiązane ({linked.length})</h2>
          {linked.map((finding, index) => (
            <FindingCard key={finding.address} finding={finding} index={index} />
          ))}
        </section>
      )}

      {rejected.length > 0 && (
        <section aria-labelledby="odrzucone">
          <h2 id="odrzucone">Adresy odrzucone ({rejected.length})</h2>
          <p className="muted">
            Adresy znalezione w źródłach, których nie przypisuje się podmiotowi. Nie wchodzą do szacunku wypłat.
          </p>
          {rejected.map((finding, index) => (
            <RejectedCard key={finding.address} finding={finding} index={linked.length + index} />
          ))}
        </section>
      )}

      <RunLog run={run} />
    </>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const view = useAsync(() => loadRun(runId), runId);
  return (
    <div className="page">
      {view.loading && <Loading label="Wczytywanie wyniku analizy…" />}
      {view.error && <ErrorBox message={view.error} onRetry={view.reload} />}
      {view.data && <RunResult view={view.data} />}
    </div>
  );
}
