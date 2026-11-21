// Teczka podmiotu: ustalenie osoby, powiązania z giełdami i portfelami oraz sekcje szczegółowe.
import { useEffect, useMemo, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Dossier } from '@olcys/core';
import { api, isDemo, loadDossier, reportHtmlUrl, reportJsonUrl } from '../api.ts';
import type { CaseSummary } from '../api.ts';
import { Crumbs, ErrorBox, ExternalLink, LayerLegend, Skeleton } from '../components/common.tsx';
import { Determination, OtherCandidates } from '../components/Determination.tsx';
import { DossierContext } from '../components/DossierContext.tsx';
import type { DossierContextValue } from '../components/DossierContext.tsx';
import { AddressesTab, DecisionsTab, FlowsTab, PeopleTab, ProfilesTab, TimelineTab } from '../components/DossierTabs.tsx';
import { RunLauncher, RunsTab } from '../components/Runs.tsx';
import { ProofTab } from '../components/ProofTab.tsx';
import { ServiceList } from '../components/ServiceCards.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime } from '../format.ts';
import { GraphView } from '../graph/GraphView.tsx';
import { UniverseView } from '../graph/UniverseView.tsx';
import { LinkMap } from '../components/LinkMap.tsx';
import { IDENTIFIER_LABEL } from '../labels.ts';
import { DOSSIER_TABS, href, navigate } from '../router.ts';
import type { DossierTab } from '../router.ts';
import { useAsync } from '../useAsync.ts';

type Source = { caseId: string } | { runId: string };

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Sprawa bez zakończonej analizy: identyfikatory i wybór źródeł. */
function StartScreen({ summary, onDone }: { summary: CaseSummary; onDone: () => void }) {
  return (
    <>
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: summary.name }]} />
      <h1>{summary.name}</h1>
      <p className="muted">Sprawa utworzona {fmtDateTime(summary.createdAt)}. Nie ma jeszcze zakończonej analizy — wybierz źródła i uruchom ją.</p>
      <div className="two-columns">
        <section className="card" aria-labelledby="identyfikatory">
          <h3 id="identyfikatory">Identyfikatory podmiotu</h3>
          <dl className="identifier-list">
            {summary.query.identifiers.map((identifier, index) => (
              <div key={index}>
                <dt>{IDENTIFIER_LABEL[identifier.type] ?? identifier.type}</dt>
                <dd>{identifier.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <RunLauncher caseId={summary.id} onDone={onDone} title="Pierwsza analiza — źródła" />
      </div>
    </>
  );
}

/** Pola ścieżki dojścia dodawane przez usługę analizy do identyfikatorów (poza kontraktem). */
/** API podaje `via` jako identyfikator, przez który dotarto do tej pozycji. */
type IdentifierPath = { step?: number; via?: string | { value: string }; followed?: boolean };

function Identifiers({ dossier }: { dossier: Dossier }) {
  const path = (item: IdentifierPath) =>
    item.step === undefined ? '' : `odkryty w kroku ${item.step}${item.via ? ` przez „${typeof item.via === 'string' ? item.via : item.via.value}”` : ''}${item.followed === false ? ' · nieprzeszukany' : ''}`;
  return (
    <ul className="identifier-chips" aria-label="Identyfikatory podmiotu">
      {dossier.subject.identifiers.map(({ identifier, origin, sourceUrl, ...rest }) => (
        <li key={`${identifier.type}-${identifier.value}`} className={`identifier-chip origin-${origin}`}>
          <span className="identifier-origin" title={origin === 'analyst' ? 'Podany przez analityka' : 'Odkryty w źródłach'}>
            <span aria-hidden="true">{origin === 'analyst' ? '✎' : '⌕'}</span>
            <span className="visually-hidden">{origin === 'analyst' ? 'podany przez analityka' : 'odkryty w źródłach'}:</span>
          </span>
          <span className="identifier-type">{IDENTIFIER_LABEL[identifier.type] ?? identifier.type}</span>
          <strong>{identifier.value}</strong>
          {origin === 'discovered' && path(rest) && <span className="identifier-type">{path(rest)}</span>}
          {sourceUrl && <ExternalLink url={sourceUrl}>źródło</ExternalLink>}
        </li>
      ))}
    </ul>
  );
}

/** Mapa powiązań w układzie kolumnowym; widok hubów usług dostępny pod przełącznikiem. */
function LinksOverview({ summary, dossier }: { summary: CaseSummary; dossier: Dossier }) {
  const [hubs, setHubs] = useState(false);
  const query = {
    identifiers: dossier.subject.identifiers.filter((item) => item.origin === 'analyst').map((item) => item.identifier),
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Mapa powiązań</h2>
        <button type="button" className="button" aria-pressed={hubs} onClick={() => setHubs(!hubs)}>
          {hubs ? 'Pokaż mapę kolumnową' : 'Pokaż widok usług'}
        </button>
      </div>
      {hubs ? (
        <UniverseView />
      ) : (
        <LinkMap
          subjectName={dossier.subject.name}
          query={query.identifiers.length > 0 ? query : summary.query}
          findings={dossier.findings}
          onSelectAddress={() => {
            location.hash = `#/sprawa/${summary.id}/adresy`;
          }}
        />
      )}
    </section>
  );
}

function TabContent({ tab, summary, dossier, onChanged }: { tab: DossierTab; summary: CaseSummary; dossier: Dossier; onChanged: () => void }) {
  switch (tab) {
    case 'graf':
      return <GraphView />;
    case 'profile':
      return <ProfilesTab />;
    case 'adresy':
      return <AddressesTab />;
    case 'przeplywy':
      return <FlowsTab />;
    case 'os-czasu':
      return <TimelineTab />;
    case 'osoby':
      return <PeopleTab />;
    case 'decyzje':
      return <DecisionsTab />;
    case 'analizy':
      return <RunsTab summary={summary} dossier={dossier} onChanged={onChanged} />;
    case 'dowod':
      return <ProofTab />;
    default:
      return (
        <>
          <LinksOverview summary={summary} dossier={dossier} />
          <h2>Karty usług</h2>
          <ServiceList />
        </>
      );
  }
}

export function DossierPage({ source, tab }: { source: Source; tab: DossierTab }) {
  const key = 'runId' in source ? `run:${source.runId}` : `case:${source.caseId}`;
  const loaded = useAsync(() => loadDossier(source), key);
  const toast = useToast();
  const [printAll, setPrintAll] = useState(false);
  const tabHref = (target: DossierTab) => ('runId' in source ? href.run(source.runId, target) : href.case(source.caseId, target));

  // Cyfry 1–9 przełączają sekcje teczki.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, [contenteditable]')) return;
      const picked = DOSSIER_TABS[Number(event.key) - 1];
      if (picked) navigate(tabHref(picked.id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const data = loaded.data;
  const context = useMemo<DossierContextValue | null>(() => {
    if (!data || !('dossier' in data)) return null;
    const caseId = data.summary.id;
    return {
      ...data,
      tabHref,
      reload: loaded.reload,
      decide: async (target, decisionKey, decision, note) => {
        try {
          await api.addDecision(caseId, { target, key: decisionKey, decision, note });
          toast.success('Zapisano decyzję — teczka została przeliczona.');
          loaded.reload();
        } catch (error) {
          toast.error(error);
        }
      },
      undo: async (decisionId) => {
        try {
          await api.removeDecision(caseId, decisionId);
          toast.success('Cofnięto decyzję — przywrócono wynik automatyczny.');
          loaded.reload();
        } catch (error) {
          toast.error(error);
        }
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, key]);

  if (!data) {
    return (
      <div className="page">
        {loaded.error ? <ErrorBox message={loaded.error} onRetry={loaded.reload} /> : <Skeleton blocks={4} />}
      </div>
    );
  }
  if (!context) {
    return (
      <div className="page">
        <StartScreen summary={data.summary} onDone={loaded.reload} />
      </div>
    );
  }

  const { dossier, summary, simplified } = context;
  const latestRunId = summary.runs.filter((run) => run.status === 'completed').at(-1)?.id;
  const historic = 'runId' in source && latestRunId !== undefined && latestRunId !== dossier.runId;

  function print() {
    // Raport zawiera wszystkie sekcje, nie tylko otwartą zakładkę.
    flushSync(() => setPrintAll(true));
    window.print();
    setPrintAll(false);
  }

  return (
    <DossierContext.Provider value={context}>
      <div className={`page dossier ${loaded.loading ? 'is-refreshing' : ''}`}>
        <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: summary.name, href: href.case(summary.id) }, { label: DOSSIER_TABS.find((item) => item.id === tab)!.label }]} />
        <header className="page-head">
          <div>
            <p className="eyebrow">Teczka podmiotu</p>
            <h1>{summary.name}</h1>
            <p className="muted">
              Stan na {fmtDateTime(dossier.generatedAt)} · adresy powiązane: {dossier.totals.linkedAddresses}, odrzucone: {dossier.totals.excludedAddresses}
            </p>
          </div>
          <div className="actions no-print">
            {isDemo || simplified ? (
              <>
                <button type="button" className="button" onClick={print}>
                  Raport do druku
                </button>
                <button type="button" className="button" onClick={() => downloadJson(`teczka-${dossier.caseId}.json`, dossier)}>
                  Pakiet JSON
                </button>
              </>
            ) : (
              <>
                <a className="button" href={reportHtmlUrl(dossier.runId)} target="_blank" rel="noopener noreferrer">
                  Raport do druku
                </a>
                <a className="button" href={reportJsonUrl(dossier.runId)} download={`analiza-${dossier.runId}.json`}>
                  Pakiet JSON
                </a>
              </>
            )}
          </div>
        </header>

        {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
        {dossier.partial && (
          <p className="notice notice-strong" role="alert">
            <strong>Wynik częściowy.</strong> Analizę przerwał limit czasu — część źródeł lub adresów nie została sprawdzona. Ponów analizę (sekcja „Historia
            analiz”), najlepiej w trybie głębokim.
          </p>
        )}
        {simplified && (
          <p className="notice" role="note">
            Teczka uproszczona: ta wersja usługi analizy nie udostępnia teczki, więc złożono ją w interfejsie z samej analizy. Decyzje analityka,
            osoby powiązane i pełne ustalenie osoby są niedostępne.
          </p>
        )}
        {historic && (
          <p className="notice" role="note">
            Oglądasz stan z wcześniejszej analizy. <a href={href.case(summary.id)}>Przejdź do bieżącej teczki</a>.
          </p>
        )}

        <Determination />
        <Identifiers dossier={dossier} />
        <OtherCandidates />

        <nav className="tabs no-print" aria-label="Sekcje teczki">
          {DOSSIER_TABS.map((item, index) => (
            <a key={item.id} href={tabHref(item.id)} aria-current={item.id === tab ? 'page' : undefined} title={`Skrót: ${index + 1}`}>
              {item.label}
            </a>
          ))}
        </nav>

        {printAll ? (
          DOSSIER_TABS.filter((item) => item.id !== 'graf').map((item) => (
            <div key={item.id} className="print-section">
              <TabContent tab={item.id} summary={summary} dossier={dossier} onChanged={loaded.reload} />
            </div>
          ))
        ) : (
          <div className="tab-panel">
            <TabContent tab={tab} summary={summary} dossier={dossier} onChanged={loaded.reload} />
          </div>
        )}
        <LayerLegend />
      </div>
    </DossierContext.Provider>
  );
}
