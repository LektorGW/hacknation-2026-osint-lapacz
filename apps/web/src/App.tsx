import { useEffect, useRef, useState } from 'react';
import { api, isDemo } from './api.ts';
import { useAsync } from './useAsync.ts';
import { ToastProvider } from './components/Toast.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { DossierPage } from './pages/DossierPage.tsx';
import { MonitoringPage } from './pages/MonitoringPage.tsx';
import { RulesPage } from './pages/RulesPage.tsx';
import { SweepPage } from './pages/SweepPage.tsx';
import { href, navigate, parseRoute, useHash } from './router.ts';
import type { Route } from './router.ts';
import { toggleScheme, useScheme } from './theme.ts';

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'case':
      return <DossierPage key={route.caseId} source={{ caseId: route.caseId }} tab={route.tab} />;
    case 'run':
      return <DossierPage key={route.runId} source={{ runId: route.runId }} tab={route.tab} />;
    case 'sweep':
      return <SweepPage sweepId={route.sweepId} />;
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
  ['g, potem t', 'typowanie'],
  ['g, potem m', 'monitoring'],
  ['g, potem z', 'zasady punktacji'],
  ['1–9', 'kolejne sekcje otwartej teczki'],
  ['m', 'przełączenie motywu jasny / ciemny'],
  ['strzałki, + − 0', 'przesuwanie, powiększenie i dopasowanie grafu (gdy graf ma fokus)'],
  ['Enter / spacja', 'szczegóły węzła lub krawędzi grafu'],
];

function focusSearch() {
  navigate(href.dashboard());
  // Pole istnieje dopiero po przejściu na pulpit.
  setTimeout(() => window.dispatchEvent(new Event('olcys:focus-search')), 50);
}

const NAV: { label: string; target: string; pages: Route['page'][]; icon: string }[] = [
  { label: 'Pulpit', target: href.dashboard(), pages: ['dashboard', 'case', 'run'], icon: 'M3 11 12 3l9 8v9h-6v-6H9v6H3z' },
  { label: 'Typowanie', target: href.sweep(), pages: ['sweep'], icon: 'M4 5h16M7 12h10M10 19h4' },
  { label: 'Monitoring', target: href.monitor(), pages: ['monitor'], icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { label: 'Zasady punktacji', target: href.rules(), pages: ['rules'], icon: 'M5 4h14v16H5zM9 9h6M9 13h6M9 17h3' },
];

export function App() {
  const route = parseRoute(useHash());
  const scheme = useScheme();
  const help = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const ai = useAsync(() => api.getAi().catch(() => null), 'ai');
  const screen = `${route.page}:${'caseId' in route ? route.caseId : 'runId' in route ? route.runId : ''}`;

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
        const go = { p: href.dashboard(), t: href.sweep(), m: href.monitor(), z: href.rules() }[event.key];
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
            {isDemo && (
              <p className="demo-badge" role="note">
                Tryb demo — dane w całości fikcyjne
              </p>
            )}
            <button type="button" className="sidebar-button" onClick={toggleScheme}>
              {scheme === 'dark' ? '☀ Motyw jasny' : '☾ Motyw ciemny'}
            </button>
            <button type="button" className="sidebar-button" onClick={() => help.current?.showModal()}>
              ? Pomoc i skróty
            </button>
          </div>
        </header>
        <div className="content">
          <main id="tresc" tabIndex={-1}>
            <Page route={route} />
          </main>
          <footer className="app-footer">
            Narzędzie wspiera analityka. Wynik jest wskazówką wymagającą weryfikacji, a nie rozstrzygnięciem. Wyłącznie źródła publiczne.
          </footer>
        </div>
      </div>

      <dialog ref={help} className="help" aria-labelledby="pomoc-tytul" {...{ closedby: 'any' }}>
        <h2 id="pomoc-tytul">Pomoc i skróty klawiaturowe</h2>
        <p>
          Wpisz jeden identyfikator w polu „Kogo sprawdzić?”. Teczka pokazuje ustalenie osoby z prawdopodobieństwem, powiązania z giełdami i portfelami
          oraz gotowe punkty zapytania do usług. Korekty analityka są opcjonalne.
        </p>
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
        <form method="dialog">
          <button className="button button-primary" autoFocus>
            Zamknij
          </button>
        </form>
      </dialog>
    </ToastProvider>
  );
}
