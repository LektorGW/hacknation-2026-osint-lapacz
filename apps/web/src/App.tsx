import { isDemo } from './api.ts';
import { CasePage } from './pages/CasePage.tsx';
import { CasesPage } from './pages/CasesPage.tsx';
import { RulesPage } from './pages/RulesPage.tsx';
import { RunPage } from './pages/RunPage.tsx';
import { href, parseRoute, useHash } from './router.ts';
import type { Route } from './router.ts';

function Page({ route }: { route: Route }) {
  switch (route.page) {
    case 'case':
      return <CasePage key={route.caseId} caseId={route.caseId} />;
    case 'run':
      return <RunPage key={route.runId} runId={route.runId} />;
    case 'rules':
      return <RulesPage />;
    default:
      return <CasesPage />;
  }
}

export function App() {
  const route = parseRoute(useHash());
  const onRules = route.page === 'rules';

  return (
    <>
      <a className="skip-link" href="#tresc" onClick={(event) => {
        // Kotwica nie może zmienić `location.hash`, bo to on steruje routingiem.
        event.preventDefault();
        document.getElementById('tresc')?.focus();
      }}>
        Przejdź do treści
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href={href.cases()}>
            <span className="brand-short">OŁCyŚ</span>
            <span className="brand-long">OSINTowy Łapacz Cyfrowych Śladów</span>
          </a>
          <nav aria-label="Główna nawigacja">
            <a href={href.cases()} aria-current={onRules ? undefined : 'page'}>
              Sprawy
            </a>
            <a href={href.rules()} aria-current={onRules ? 'page' : undefined}>
              Zasady punktacji
            </a>
          </nav>
        </div>
      </header>
      {isDemo && (
        <p className="demo-banner" role="note">
          Tryb demo — dane w całości fikcyjne, bez połączenia z usługą analizy.
        </p>
      )}
      <main id="tresc" tabIndex={-1}>
        <Page route={route} />
      </main>
      <footer className="app-footer">
        Narzędzie wspiera analityka. Wynik jest wskazówką wymagającą weryfikacji, a nie rozstrzygnięciem.
      </footer>
    </>
  );
}
