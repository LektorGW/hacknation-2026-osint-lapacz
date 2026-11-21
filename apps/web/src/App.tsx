import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { ModeBadge, ModeProvider } from './components/Mode.tsx';
import { useAsync } from './useAsync.ts';
import { ToastProvider } from './components/Toast.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { DossierPage } from './pages/DossierPage.tsx';
import { MonitoringPage } from './pages/MonitoringPage.tsx';
import { RulesPage } from './pages/RulesPage.tsx';
import { StatsPage } from './pages/StatsPage.tsx';
import { SweepPage } from './pages/SweepPage.tsx';
import { href, navigate, parseRoute, useHash } from './router.ts';
import type { Route } from './router.ts';
import { toggleScheme, useScheme } from './theme.ts';
import { TOUR_EVENT, resetTour } from './tour.ts';
import { usePrintExpand } from './components/ui/Disclosure.tsx';
import { GlossaryDrawer } from './components/ui/GlossaryDrawer.tsx';
import { resetHints } from './components/ui/Hint.tsx';
import { openGlossary } from './components/ui/Term.tsx';

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'case':
      return <DossierPage key={route.caseId} source={{ caseId: route.caseId }} tab={route.tab} />;
    case 'run':
      return <DossierPage key={route.runId} source={{ runId: route.runId }} tab={route.tab} />;
    case 'sweep':
      return <SweepPage sweepId={route.sweepId} />;
    case 'stats':
      return <StatsPage />;
    case 'monitor':
      return <MonitoringPage />;
    case 'rules':
      return <RulesPage />;
    default:
      return <DashboardPage />;
  }
}

const SHORTCUTS: [string, string][] = [
  ['?', 'ta pomoc'],
  ['/', 'pole „Kogo sprawdzić?” na pulpicie'],
  ['g, potem p', 'pulpit'],
  ['g, potem s', 'statystyki'],
  ['g, potem t', 'typowanie'],
  ['g, potem m', 'monitoring'],
  ['g, potem z', 'zasady punktacji'],
  ['1–6', 'kolejne sekcje otwartej teczki'],
  ['m', 'przełączenie motywu jasny / ciemny'],
  ['strzałki, + − 0', 'przesuwanie, powiększenie i dopasowanie grafu (gdy graf ma fokus)'],
  ['Enter / spacja', 'szczegóły węzła lub krawędzi grafu'],
  ['Shift + klik / dwuklik', 'graf: ścieżka dowodowa do drugiego węzła / zwinięcie gałęzi'],
];

function focusSearch() {
  navigate(href.dashboard());
  // Pole istnieje dopiero po przejściu na pulpit.
  setTimeout(() => window.dispatchEvent(new Event('olcys:focus-search')), 50);
}

const NAV: { label: string; target: string; pages: Route['page'][]; icon: string }[] = [
  { label: 'Pulpit', target: href.dashboard(), pages: ['dashboard', 'case', 'run'], icon: 'M3 11 12 3l9 8v9h-6v-6H9v6H3z' },
  { label: 'Statystyki', target: href.stats(), pages: ['stats'], icon: 'M5 20V11M12 20V5M19 20v-7M3 20h18' },
  { label: 'Typowanie', target: href.sweep(), pages: ['sweep'], icon: 'M4 5h16M7 12h10M10 19h4' },
  { label: 'Monitoring', target: href.monitor(), pages: ['monitor'], icon: 'M3 12h4l3-8 4 16 3-8h4' },
];

export function App() {
  const route = parseRoute(useHash());
  const scheme = useScheme();
  const help = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const ai = useAsync(() => api.getAi().catch(() => null), 'ai');
  const screen = `${route.page}:${'caseId' in route ? route.caseId : 'runId' in route ? route.runId : ''}`;
  usePrintExpand();

  // Nowy ekran zaczyna się od góry; przełączanie sekcji teczki nie zmienia przewinięcia.
  useEffect(() => {
    window.scrollTo(0, 0);
    setMenuOpen(false);
  }, [screen]);

  useEffect(() => {
    let prefix = false;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.ctrlKey || event.metaKey || event.altKey || target.closest('input, textarea, select, [contenteditable], dialog')) return;
      if (prefix) {
        prefix = false;
        const go = { p: href.dashboard(), s: href.stats(), t: href.sweep(), m: href.monitor(), z: href.rules() }[event.key];
        if (go) navigate(go);
        return;
      }
      if (event.key === '?') help.current?.showModal();
      else if (event.key === '/') {
        event.preventDefault();
        focusSearch();
      } else if (event.key === 'g') prefix = true;
      else if (event.key === 'm') toggleScheme();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <ModeProvider>
    <ToastProvider>
      <a
        className="skip-link"
        href="#tresc"
        onClick={(event) => {
          // Kotwica nie może zmienić `location.hash`, bo to on steruje routingiem.
          event.preventDefault();
          document.getElementById('tresc')?.focus();
        }}
      >
        Przejdź do treści
      </a>
      <div className="shell">
        <header className={`sidebar ${menuOpen ? 'is-open' : ''}`} onKeyDown={(event) => event.key === 'Escape' && setMenuOpen(false)}>
          <a className="brand" href={href.dashboard()}>
            <span className="brand-short">OŁCyŚ</span>
            <span className="brand-long">OSINTowy Łapacz Cyfrowych Śladów</span>
          </a>
          <button type="button" className="menu-button" aria-expanded={menuOpen} aria-controls="menu-glowne" onClick={() => setMenuOpen(!menuOpen)}>
            <span aria-hidden="true">{menuOpen ? '✕' : '☰'}</span> Menu
          </button>
          <nav id="menu-glowne" aria-label="Główna nawigacja" onClick={() => setMenuOpen(false)}>
            {NAV.map((item) => (
              <a key={item.label} href={item.target} aria-current={item.pages.includes(route.page) ? 'page' : undefined}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={item.icon} />
                </svg>
                {item.label}
              </a>
            ))}
          </nav>
          <div className="sidebar-foot">
            {ai.data && (
              <a className="ai-badge" href={href.rules()} title={ai.data.description}>
                Model językowy: <strong>{ai.data.enabled ? (ai.data.model ?? 'włączony') : 'wyłączony'}</strong>
              </a>
            )}
            <button type="button" className="sidebar-button" onClick={toggleScheme}>
              {scheme === 'dark' ? '☀ Motyw jasny' : '☾ Motyw ciemny'}
            </button>
            <a className="sidebar-button" href={href.rules()} aria-current={route.page === 'rules' ? 'page' : undefined} onClick={() => setMenuOpen(false)}>
              § Zasady punktacji
            </a>
            <button type="button" className="sidebar-button" onClick={() => openGlossary()}>
              ≡ Słownik pojęć
            </button>
            <button type="button" className="sidebar-button" data-tour="help" onClick={() => help.current?.showModal()}>
              ? Pomoc i skróty
            </button>
          </div>
        </header>
        <div className="content">
          <ModeBadge />
          <main id="tresc" tabIndex={-1}>
            <Page route={route} />
          </main>
          <footer className="app-footer">
            Narzędzie wspiera analityka. Wynik jest wskazówką wymagającą weryfikacji, a nie rozstrzygnięciem. Wyłącznie źródła publiczne.
          </footer>
        </div>
      </div>

      <dialog ref={help} className="help" aria-labelledby="pomoc-tytul" {...{ closedby: 'any' }}>
        <h2 id="pomoc-tytul">Pomoc</h2>
        <p className="help-intro">Program działa w czterech krokach:</p>
        <ol className="help-steps">
          <li>
            Wpisujesz jedną znaną daną o osobie w polu „Kogo sprawdzić?” — nick, e-mail, imię i nazwisko albo adres krypto.
          </li>
          <li>Program szuka w źródłach publicznych adresów kryptowalutowych, które ta osoba opublikowała.</li>
          <li>Ocenia, jak mocno każdy adres łączy się z osobą, i sprawdza w blockchainie, dokąd płynęły środki.</li>
          <li>Teczka pokazuje, która giełda przyjęła pieniądze — z gotowym materiałem do zapytania. Twoje korekty są opcjonalne.</li>
        </ol>
        <div className="help-actions">
          <button type="button" className="button button-primary" onClick={() => openGlossary()}>
            Słownik pojęć
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              help.current?.close();
              resetTour();
              window.dispatchEvent(new Event(TOUR_EVENT));
            }}
          >
            Uruchom przewodnik od nowa
          </button>
          <button type="button" className="button" onClick={resetHints}>
            Przywróć ukryte wskazówki
          </button>
        </div>
        <details>
          <summary>Skróty klawiaturowe</summary>
          <dl className="shortcuts">
            {SHORTCUTS.map(([keys, description]) => (
              <div key={keys}>
                <dt>
                  <kbd>{keys}</kbd>
                </dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
        </details>
        <form method="dialog">
          <button className="button" autoFocus>
            Zamknij
          </button>
        </form>
      </dialog>
      <GlossaryDrawer />
    </ToastProvider>
    </ModeProvider>
  );
}
