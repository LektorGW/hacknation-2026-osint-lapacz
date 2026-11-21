// Teczka podmiotu: ustalenie osoby, powiązania z giełdami i portfelami oraz sekcje szczegółowe.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { Dossier } from '@olcys/core';
import { api, isDemo, loadDossier, runPeriod, reportHtmlUrl, reportJsonUrl } from '../api.ts';
import type { CaseSummary } from '../api.ts';
import { Crumbs, ErrorBox, ExternalLink, LayerLegend, Skeleton } from '../components/common.tsx';
import { Determination, OtherCandidates } from '../components/Determination.tsx';
import { DossierContext } from '../components/DossierContext.tsx';
import type { DossierContextValue } from '../components/DossierContext.tsx';
import { AddressesTab, DecisionsTab, FlowsTab, PeopleTab, ProfilesTab, TimelineTab } from '../components/DossierTabs.tsx';
import { RunLauncher, RunsTab } from '../components/Runs.tsx';
import { ProofTab } from '../components/ProofTab.tsx';
import { IdentitiesTab } from '../components/IdentitiesTab.tsx';
import { OrganizationsCard } from '../components/OrganizationCards.tsx';
import { IndicatorsTab } from '../components/Indicators.tsx';
import { DemoWatermark } from '../components/Mode.tsx';
import { RELATION_TEXT, identityStatus, linkLabel } from '../identities.ts';
import { Explanations } from '../components/Explanations.tsx';
import { FundingSources, Seizures } from '../components/FundsOrigin.tsx';
import { periodLabel } from '../proof.ts';
import type { FullDossier } from '../proof.ts';
import { ServiceList } from '../components/ServiceCards.tsx';
import { useToast } from '../components/Toast.tsx';
import { fmtDateTime } from '../format.ts';
import { GraphView } from '../graph/GraphView.tsx';
import { UniverseView } from '../graph/UniverseView.tsx';
import { LinkMap } from '../components/LinkMap.tsx';
import { IDENTIFIER_LABEL } from '../labels.ts';
import { DOSSIER_SECTIONS, DOSSIER_TABS, href, navigate, sectionOf, tabLabel } from '../router.ts';
import type { DossierTab } from '../router.ts';
import { useAsync } from '../useAsync.ts';
import { ExportPanel } from '../components/ExportPanel.tsx';
import { CaseLifecycleActions, ClosedNotice } from '../components/CaseLifecycle.tsx';
import { SearchInputChip } from '../components/SearchInput.tsx';
import { Floating } from '../components/ui/Floating.tsx';
import { Hint } from '../components/ui/Hint.tsx';
import { Term } from '../components/ui/Term.tsx';
import { Tour } from '../components/ui/Tour.tsx';
import { CaseHero, KeyFindings, SummaryHint } from './dossier/CaseSummary.tsx';

type Source = { caseId: string } | { runId: string };

/** Pierwsze pole pakietu JSON pobranego w trybie demo — plik nie może uchodzić za wynik analizy. */
const DEMO_NOTICE = 'DEMO — dane przykładowe wbudowane w interfejs; nie pochodzą ze źródeł publicznych ani z blockchaina.';

function downloadJson(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** Okres wskazany przy uruchomieniu analizy — zapisany w samej analizie, nie w teczce. */
function RunPeriod({ runId }: { runId: string }) {
  const period = useAsync(() => runPeriod(runId), `period:${runId}`);
  const label = periodLabel(period.data);
  return label ? <strong className="period-note"> · analizowany okres: {label}</strong> : null;
}

/** Sprawa bez zakończonej analizy: identyfikatory i wybór źródeł. */
function StartScreen({ summary, onDone }: { summary: CaseSummary; onDone: () => void }) {
  return (
    <>
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: summary.name }]} />
      <header className="page-head dossier-head">
        <h1>{summary.name}</h1>
        {(summary.status !== undefined || isDemo) && (
          <div className="actions no-print">
            <CaseLifecycleActions summary={summary} onChanged={onDone} />
          </div>
        )}
      </header>
      <ClosedNotice summary={summary} />
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
function LinksOverview({ summary, dossier }: { summary: CaseSummary; dossier: FullDossier }) {
  const [hubs, setHubs] = useState(false);
  const [fitted, setFitted] = useState(false);
  const query = {
    identifiers: dossier.subject.identifiers.filter((item) => item.origin === 'analyst').map((item) => item.identifier),
  };
  return (
    <section className="card">
      <div className="section-head">
        <h2>Mapa powiązań</h2>
        {!hubs && (
          <button type="button" className="button map-fit" aria-pressed={fitted} onClick={() => setFitted(!fitted)}>
            {fitted ? 'Powiększ mapę' : 'Dopasuj do ekranu'}
          </button>
        )}
        <button type="button" className="button" aria-pressed={hubs} onClick={() => setHubs(!hubs)}>
          {hubs ? 'Pokaż mapę kolumnową' : 'Pokaż widok usług'}
        </button>
      </div>
      {hubs ? (
        <UniverseView />
      ) : (
        <div className={fitted ? 'map-fitted' : undefined}>
        <LinkMap
          subjectName={dossier.subject.name}
          query={query.identifiers.length > 0 ? query : summary.query}
          findings={dossier.findings}
          identities={(dossier.linkedIdentities ?? [])
            .filter((identity) => identityStatus(identity) !== 'rejected')
            .map((identity) => ({
              id: identity.id,
              name: identity.displayName,
              relation: RELATION_TEXT[identity.relation] ?? identity.relation,
              addresses: identity.addresses.map((item) => item.address),
              label: linkLabel(identity),
            }))}
          onSelectAddress={() => {
            location.hash = `#/sprawa/${summary.id}/adresy`;
          }}
        />
        </div>
      )}
    </section>
  );
}

/** Przycisk „Eksport danych” w nagłówku teczki: panel plików CSV/JSON w warstwie pływającej. */
function ExportMenu({ caseId, demoDossier }: { caseId: string; demoDossier?: unknown }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button ref={anchor} type="button" className="button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
        Eksport danych <span aria-hidden="true">▾</span>
      </button>
      <Floating anchor={anchor} open={open} onClose={close} id="eksport-danych" role="dialog" label="Eksport danych" className="export-pop">
        <ExportPanel caseId={caseId} demoDossier={demoDossier} />
      </Floating>
    </>
  );
}

/** „Podsumowanie”: odpowiedź w skrócie, ustalenia w grupach i to, czego brakuje. */
function SummarySection({ empty }: { empty: boolean }) {
  return (
    <>
      <SummaryHint />
      {!empty && <CaseHero />}
      <KeyFindings />
      <Explanations />
      <Seizures />
      <FundingSources />
    </>
  );
}

/** „Ustalenie osoby”: pełna karta kandydata, identyfikatory i ślady innych osób. */
function PersonSection({ dossier, empty }: { dossier: Dossier; empty: boolean }) {
  return (
    <>
      {!empty && (
        <div className="determination-wrap">
          <Determination />
        </div>
      )}
      <section className="card identifiers-card" aria-labelledby="identyfikatory-tytul">
        <h2 id="identyfikatory-tytul">
          <Term id="identyfikator">Identyfikatory</Term> w sprawie
        </h2>
        <p className="muted small">
          <span aria-hidden="true">✎</span> podany przez analityka · <span aria-hidden="true">⌕</span> odkryty w źródłach
        </p>
        <Identifiers dossier={dossier} />
      </section>
      <OrganizationsCard />
      {!empty && <OtherCandidates />}
    </>
  );
}

const SECTION_HINT: Partial<Record<string, { id: string; text: string }>> = {
  adresy: {
    id: 'sekcja-adresy',
    text: 'Każda karta to jeden adres. Na górze: jak mocno łączy się z osobą i gdzie go opublikowano. Ślady w źródłach i dane z blockchaina rozwiniesz kliknięciem.',
  },
  pieniadze: {
    id: 'sekcja-pieniadze',
    text: 'Dowód spieniężenia pokazuje drogę środków od adresu osoby do giełdy. Giełdy i portfele to gotowy materiał do zapytania; przepływy — wszystkie przelewy w tabeli.',
  },
  osoba: {
    id: 'sekcja-osoba',
    text: 'Program sam łączy profile w osobę. Jeśli coś się nie zgadza, popraw to przyciskiem na karcie profilu — teczka przeliczy się od razu.',
  },
  graf: {
    id: 'sekcja-graf',
    text: 'Kliknij węzeł: widok skupi się na jego otoczeniu, a z prawej otworzą się szczegóły. „Pełny ekran” daje więcej miejsca, wyszukiwarka znajdzie konto, adres albo usługę.',
  },
};

function TabContent({ tab, summary, dossier, onChanged, empty }: { tab: DossierTab; summary: CaseSummary; dossier: Dossier; onChanged: () => void; empty: boolean }) {
  switch (tab) {
    case 'podsumowanie':
      return <SummarySection empty={empty} />;
    case 'osoba':
      return <PersonSection dossier={dossier} empty={empty} />;
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
    case 'tozsamosci':
      return <IdentitiesTab />;
    case 'wskazniki':
      return <IndicatorsTab />;
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

  // Cyfry 1–6 przełączają sekcje teczki.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, [contenteditable], dialog')) return;
      const picked = DOSSIER_SECTIONS[Number(event.key) - 1];
      if (picked) navigate(tabHref(picked.tabs[0]!));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Zmiana sekcji przez odnośnik w treści (np. „Co dalej?”): nawigacja sekcji wraca do widoku.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const nav = document.querySelector<HTMLElement>('.sections');
    if (nav && nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [tab]);

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
          toast.success('Wycofano decyzję — pozostaje w historii zmian, wynik przeliczono bez niej.');
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
  const empty = dossier.persons.length === 0 && dossier.findings.length === 0 && (dossier.explanations ?? []).length > 0;
  const historic = 'runId' in source && latestRunId !== undefined && latestRunId !== dossier.runId;

  function print() {
    // Raport zawiera wszystkie sekcje, nie tylko otwartą zakładkę.
    flushSync(() => setPrintAll(true));
    window.print();
    setPrintAll(false);
  }

  const section = sectionOf(tab);
  const sectionHint = SECTION_HINT[section.id];
  const linkedCount = dossier.findings.filter((finding) => !finding.confidence.excluded).length;
  const counts: Partial<Record<DossierTab, number>> = {
    adresy: linkedCount + (dossier.unconfirmedAddresses ?? []).length,
    tozsamosci: (dossier.linkedIdentities ?? []).length,
    dowod: (dossier.cashOutProof ?? []).length,
    profile: dossier.profiles.length,
  };
  const sectionCount = (tabs: readonly DossierTab[]) => (tabs.length === 1 ? counts[tabs[0]!] : undefined);

  return (
    <DossierContext.Provider value={context}>
      <div className={`page dossier ${loaded.loading ? 'is-refreshing' : ''}`}>
        <Crumbs
          items={[
            { label: 'Pulpit', href: href.dashboard() },
            { label: summary.name, href: href.case(summary.id) },
            ...(tab === 'podsumowanie' ? [] : [{ label: section.label, href: tabHref(section.tabs[0]!) }]),
            ...(section.tabs.length > 1 ? [{ label: tabLabel(tab) }] : []),
          ]}
        />
        <header className="page-head dossier-head">
          <div>
            <p className="eyebrow">
              <Term id="teczka">Teczka sprawy</Term>
            </p>
            <h1>{summary.name}</h1>
            <SearchInputChip dossier={dossier} />
            <p className="muted dossier-meta">
              Stan na {fmtDateTime(dossier.generatedAt)}
              <RunPeriod runId={dossier.runId} />
            </p>
          </div>
          <div className="actions no-print">
            {isDemo || simplified ? (
              <>
                <button type="button" className="button" onClick={print}>
                  Raport do druku
                </button>
                <button type="button" className="button button-quiet" onClick={() => downloadJson(`teczka-${isDemo ? 'DEMO-' : ''}${dossier.caseId}.json`, isDemo ? { uwaga: DEMO_NOTICE, ...dossier } : dossier)}>
                  Pakiet JSON
                </button>
              </>
            ) : (
              <>
                <a className="button" href={reportHtmlUrl(dossier.runId)} target="_blank" rel="noopener noreferrer">
                  Raport do druku
                </a>
                <a className="button button-quiet" href={reportJsonUrl(dossier.runId)} download={`analiza-${dossier.runId}.json`}>
                  Pakiet JSON
                </a>
              </>
            )}
            <ExportMenu caseId={summary.id} demoDossier={isDemo ? dossier : undefined} />
            {/* Cykl życia sprawy — tylko gdy usługa podaje stan sprawy (starsza wersja go nie zna). */}
            {(summary.status !== undefined || isDemo) && <CaseLifecycleActions summary={summary} onChanged={loaded.reload} />}
          </div>
        </header>

        <DemoWatermark />
        <ClosedNotice summary={summary} />
        {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
        {dossier.partial && (
          <div className="status-box status-box-warn" role="alert">
            <p>
              <strong>
                <Term id="wynik-czesciowy">Wynik częściowy</Term>
              </strong>{' '}
              — analizę przerwał limit czasu, więc część źródeł lub adresów nie została sprawdzona. To, co widać, jest poprawne, ale może być niepełne.
            </p>
            <a className="button button-small" href={tabHref('analizy')}>
              Ponów analizę
            </a>
          </div>
        )}
        {simplified && (
          <p className="notice notice-quiet" role="note">
            Teczka uproszczona: ta wersja usługi analizy nie udostępnia teczki, więc złożono ją w interfejsie z samej analizy. Decyzje analityka,
            osoby powiązane i pełne ustalenie osoby są niedostępne.
          </p>
        )}
        {historic && (
          <p className="notice notice-quiet" role="note">
            Oglądasz stan z wcześniejszej analizy. <a href={href.case(summary.id)}>Przejdź do bieżącej teczki</a>.
          </p>
        )}

        <nav className="sections no-print" aria-label="Sekcje teczki" data-tour="sections">
          <ul className="sections-main">
            {DOSSIER_SECTIONS.map((item, index) => {
              const count = sectionCount(item.tabs);
              return (
                <li key={item.id}>
                  <a
                    href={tabHref(item.tabs[0]!)}
                    aria-current={item.id === section.id ? 'page' : undefined}
                    title={`${item.description} · skrót klawiszowy: ${index + 1}`}
                  >
                    {item.label}
                    {count !== undefined && count > 0 && <span className="sections-count">{count}</span>}
                  </a>
                </li>
              );
            })}
          </ul>
          {section.tabs.length > 1 && (
            <ul className="sections-sub" aria-label={`Widoki sekcji „${section.label}”`}>
              {section.tabs.map((item) => (
                <li key={item}>
                  <a href={tabHref(item)} aria-current={item === tab ? 'page' : undefined}>
                    {tabLabel(item)}
                    {counts[item] !== undefined && counts[item]! > 0 && <span className="sections-count">{counts[item]}</span>}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </nav>

        {printAll ? (
          DOSSIER_TABS.filter((item) => item.id !== 'graf').map((item) => (
            <div key={item.id} className="print-section">
              <TabContent tab={item.id} summary={summary} dossier={dossier} onChanged={loaded.reload} empty={empty} />
            </div>
          ))
        ) : (
          <div className="tab-panel" key={tab}>
            {sectionHint && (
              <Hint id={sectionHint.id} title="Jak czytać tę sekcję">
                {sectionHint.text}
              </Hint>
            )}
            <TabContent tab={tab} summary={summary} dossier={dossier} onChanged={loaded.reload} empty={empty} />
          </div>
        )}
        <LayerLegend />
      </div>
      <Tour chapter="dossier" ready={tab === 'podsumowanie'} />
    </DossierContext.Provider>
  );
}
