// „Alerty ryzyka”: osobny widok teczki (sekcja „Więcej”) — alerty pogrupowane po poziomie, każdy w jednej linii
// z rozwijanym dopowiedzeniem i odnośnikiem do szczegółów. W podsumowaniu sprawy tylko jeden globalny wskaźnik ryzyka.
// Szczegółowe bloki (Miksery, Oszustwo, Zajęcie środków…) zostają w swoich sekcjach — alerty do nich prowadzą.
import { SEVERITY_META, collectWarnings, groupWarnings, riskSummary } from '../warnings.ts';
import type { Warning } from '../warnings.ts';
import { useDossier } from './DossierContext.tsx';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Przewija do bloku ze szczegółami; po zmianie sekcji czeka, aż blok się pojawi (najdłużej ok. 2 s). */
function scrollToAnchor(anchor: string, delay: number) {
  let tries = 0;
  const attempt = () => {
    const element = document.getElementById(anchor);
    if (element) {
      element.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      return;
    }
    if (++tries < 20) window.setTimeout(attempt, 100);
  };
  window.setTimeout(attempt, delay);
}

/** Alerty teczki — policzone raz na stronie teczki (z obiegami środków z sieci sprawy); awaryjnie z samej teczki. */
export function useCaseWarnings(): Warning[] {
  const { dossier, warnings } = useDossier();
  return warnings ?? collectWarnings(dossier);
}

/** Globalny wskaźnik ryzyka w nagłówku podsumowania: najpoważniejszy poziom i liczba alertów, odnośnik do widoku alertów. */
export function RiskIndicator() {
  const { tabHref } = useDossier();
  const risk = riskSummary(useCaseWarnings());
  if (risk.level === 'brak') {
    return (
      <a className="risk-chip is-none" href={tabHref('alerty')} title="W danych sprawy nie ma alertów ryzyka">
        {risk.text}
      </a>
    );
  }
  return (
    <a className={`risk-chip sev-${risk.level}`} href={tabHref('alerty')} title="Otwórz alerty ryzyka">
      <span className="risk-chip-icon" aria-hidden="true">
        {SEVERITY_META[risk.level].icon}
      </span>
      {risk.text} <span aria-hidden="true">→</span>
    </a>
  );
}

function AlertRow({ item }: { item: Warning }) {
  const { tabHref } = useDossier();
  const meta = SEVERITY_META[item.severity];
  const anchor = item.link.anchor;
  return (
    <li className={`alert-row sev-${item.severity}`}>
      <details className="alert-details">
        <summary className="alert-summary">
          <span className="alert-icon" aria-hidden="true">
            {meta.icon}
          </span>
          <span className="alert-title">
            <span className="visually-hidden">{meta.label}: </span>
            {item.title}
          </span>
          <span className="alert-category">{item.category}</span>
          <span className={`status ${item.status === 'fakt' ? 'status-fact' : 'status-inference'}`}>{item.status}</span>
        </summary>
        <p className="alert-detail">{item.detail}</p>
      </details>
      <a
        className="alert-link"
        href={tabHref(item.link.tab)}
        onClick={() => {
          if (anchor) scrollToAnchor(anchor, 200);
        }}
      >
        szczegóły <span aria-hidden="true">→</span>
      </a>
    </li>
  );
}

/** Widok „Alerty ryzyka”. */
export function AlertsTab() {
  const warnings = useCaseWarnings();
  const risk = riskSummary(warnings);
  return (
    <section className="alerts" aria-labelledby="alerty-tytul">
      <header className="section-head">
        <div>
          <h2 id="alerty-tytul">
            Alerty ryzyka <span className={`alerts-count ${risk.level === 'brak' ? 'is-none' : `sev-${risk.level}`}`}>{warnings.length}</span>
          </h2>
          <p className="muted small">
            Od najpoważniejszych. Każdy alert mówi, czy to fakt (np. wpis na liście, etykieta adresu), czy hipoteza do weryfikacji. Kliknij linię, aby
            rozwinąć dopowiedzenie; „szczegóły” prowadzą do sekcji z dowodami.
          </p>
        </div>
      </header>
      {warnings.length === 0 ? (
        <p className="alerts-empty muted" role="status">
          Brak alertów w danych sprawy.
        </p>
      ) : (
        groupWarnings(warnings).map((group) => (
          <section key={group.severity} className={`alerts-group sev-${group.severity}`} aria-labelledby={`alerty-${group.severity}`}>
            <h3 id={`alerty-${group.severity}`} className="alerts-group-title">
              <span aria-hidden="true">{SEVERITY_META[group.severity].icon}</span> {SEVERITY_META[group.severity].label}{' '}
              <span className="muted">({group.items.length})</span>
            </h3>
            <ul className="alerts-list">
              {group.items.map((item) => (
                <AlertRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        ))
      )}
    </section>
  );
}
