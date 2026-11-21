// Wskaźnik D — sygnały możliwej niezgłoszonej działalności gospodarczej: karta obok A/B/C w „Wskaźnikach”
// (dwie ścieżki: działalność możliwie niezgłoszona i podmiot zarejestrowany) oraz zwięzła linia w podsumowaniu sprawy.
import type { BusinessActivityAssessment, BusinessRegistryCheck, Indicator } from '@olcys/core';
import { fmtPln } from '../format.ts';
import { ExternalLink } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { ComponentTable, IndicatorScore, StatusBadge } from './Indicators.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Term } from './ui/Term.tsx';

/** Od tego wyniku linia wskaźnika D trafia do podsumowania sprawy („istotne przesłanki”). */
export const BUSINESS_HERO_MIN = 60;

const CHECK_LABEL: Record<BusinessRegistryCheck['status'], string> = {
  found: 'wpis znaleziony',
  not_found: 'brak wpisu',
  not_checked: 'nie sprawdzano',
  unavailable: 'źródło nie odpowiedziało',
};

const businessOf = (indicators: unknown): BusinessActivityAssessment | undefined => (indicators as { businessActivity?: BusinessActivityAssessment } | undefined)?.businessActivity;

function Limitations({ indicator }: { indicator: Indicator }) {
  if ((indicator.limitations ?? []).length === 0) return null;
  return (
    <aside className="limitations">
      <h4>Ograniczenia</h4>
      <ul>
        {indicator.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </aside>
  );
}

function VerifyList({ items, title }: { items: string[]; title: string }) {
  if (items.length === 0) return null;
  return (
    <Disclosure title={title} meta={items.length} defaultOpen>
      <ul className="plain-list">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="muted small">Zalecenia sprawdzeń po stronie KAS — nie twierdzenia o statusie podatkowym.</p>
    </Disclosure>
  );
}

function Turnover({ assessment }: { assessment: BusinessActivityAssessment }) {
  const years = assessment.turnover ?? [];
  if (years.length === 0) return <p className="muted small">Brak wpływów od kontrahentów spoza usług na adresy podmiotu.</p>;
  return (
    <div className="table-scroll">
      <table className="table">
        <caption className="muted small">
          <Term id="obrot-a-dochod">Obrót (wpływy), nie dochód</Term> — według roku podatkowego
        </caption>
        <thead>
          <tr>
            <th scope="col">Rok</th>
            <th scope="col" className="num">Wpływy</th>
            <th scope="col" className="num">Wpłacający</th>
            <th scope="col" className="num">Obrót (PLN)</th>
            <th scope="col" className="num">Wycenione</th>
          </tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year.year}>
              <td>{year.year}</td>
              <td className="num">{year.inflows}</td>
              <td className="num">{year.payers}</td>
              <td className="num">{year.valued > 0 ? `ok. ${fmtPln(year.valuePln)}` : '—'}</td>
              <td className="num">
                {year.valued}/{year.inflows}
                {year.sampleRated > 0 && <span className="cell-note">kurs przykładowy</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RegistryChecks({ checks }: { checks: BusinessRegistryCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="plain-list tight">
      {checks.map((check) => (
        <li key={check.connectorId}>
          <span className={`chip ${check.status === 'found' ? 'chip-warn' : ''}`}>{CHECK_LABEL[check.status] ?? check.status}</span> <strong>{check.registry}</strong>
          {check.queries.length > 0 && <span className="muted"> · szukano: {check.queries.join(', ')}</span>}
          {check.records.map((record) => (
            <span key={record.url}>
              {' '}
              · <ExternalLink url={record.url}>{record.name}</ExternalLink>
              {record.nameOnly && <span className="muted"> (tylko nazwa)</span>}
            </span>
          ))}
          <span className="cell-note">{check.note}</span>
        </li>
      ))}
    </ul>
  );
}

function NetworkEntries({ assessment }: { assessment: BusinessActivityAssessment }) {
  const network = assessment.network ?? [];
  if (network.length === 0) return null;
  return (
    <div className="business-network">
      <p>
        <strong>
          W siatce: {network.length} {network.length === 1 ? 'podmiot' : 'podmiotów'} z sygnałami działalności
        </strong>{' '}
        <span className="muted small">— powiązanie w siatce nie przenosi sygnałów na podmiot sprawy</span>
      </p>
      <ul className="plain-list tight">
        {network.map((item) => (
          <li key={item.nodeId}>
            <strong>{item.label}</strong> <span className="muted">· wskaźnik D {item.score} · {item.level}</span>
            <span className="cell-note">
              {item.path ? (
                <>
                  {item.path.labels.join(' → ')} — {item.path.summary}
                  {item.path.weakest && ` (najsłabsze ogniwo: ${item.path.weakest.label}, siła ${item.path.weakest.strength})`}
                </>
              ) : (
                'brak ścieżki do podmiotu'
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RegisteredTrack({ assessment }: { assessment: BusinessActivityAssessment }) {
  const track = assessment.registered;
  if (!track) return null;
  return (
    <section className="business-track" aria-label="Ścieżka: podmiot zarejestrowany">
      <header className="indicator-head">
        <div className="indicator-title">
          <strong>Podmiot zarejestrowany</strong> <span className="muted">— weryfikacja zgodności obrotu i ryzyko prania pieniędzy</span>
        </div>
        <IndicatorScore indicator={track.indicator} />
        <StatusBadge status="hypothesis" label="sygnał do weryfikacji" />
      </header>
      <p className="indicator-statement">{track.statement}</p>
      <ul className="plain-list tight">
        {track.entities.map((entity) => (
          <li key={entity.id}>
            <strong>{entity.name}</strong>
            <span className="muted">
              {entity.nip && ` · NIP ${entity.nip}`}
              {entity.krs && ` · KRS ${entity.krs}`}
              {entity.vatStatus && ` · VAT: ${entity.vatStatus}`}
              {entity.registrationDate && ` · rejestracja ${entity.registrationDate}`}
              {entity.removalDate && ` · wykreślenie ${entity.removalDate}`}
              {entity.pkd.length > 0 && ` · PKD ${entity.pkd.slice(0, 3).map((item) => item.code).join(', ')}`}
            </span>
          </li>
        ))}
      </ul>
      <Disclosure title="Składniki — sygnały do weryfikacji" meta={track.indicator.components.length}>
        <ComponentTable indicator={track.indicator} />
        <Limitations indicator={track.indicator} />
      </Disclosure>
      <VerifyList items={track.whatToVerify} title="Co sprawdzić (podmiot zarejestrowany)" />
    </section>
  );
}

/** Karta wskaźnika D w zakładce „Wskaźniki”. */
export function BusinessActivityCard() {
  const { dossier } = useDossier();
  const assessment = businessOf(dossier.indicators);
  return (
    <article className="card indicator-card" aria-labelledby="wskaznik-d" id="wskaznik-d-karta">
      <h3 id="wskaznik-d">
        <span className="indicator-letter">D</span> <Term id="dzialalnosc-sygnaly">Sygnały działalności gospodarczej</Term>
      </h3>
      <p className="muted">
        Czy osoba może prowadzić działalność, która nie jest zgłoszona — powtarzalne oferty, wielu wpłacających, regularne wpływy. To hipoteza: status podatkowy znają
        wyłącznie systemy KAS.
      </p>
      {!assessment ? (
        <p className="muted">Brak oceny — analiza sprzed wskaźnika D. Ponów analizę, żeby go wyliczyć.</p>
      ) : (
        <ul className="indicator-list">
          <li className="indicator-item st-hypothesis">
            <header className="indicator-head">
              <div className="indicator-title">
                <strong>Działalność możliwie niezgłoszona</strong> <span className="muted">· {assessment.subject.label}</span>
              </div>
              <IndicatorScore indicator={assessment.indicator} />
              <StatusBadge status="hypothesis" />
            </header>
            <p className="indicator-statement">{assessment.statement}</p>
            <Turnover assessment={assessment} />
            <Disclosure title="Rejestry publiczne — co sprawdzono" meta={(assessment.registryCheck ?? []).filter((check) => check.status === 'found' || check.status === 'not_found').length}>
              <RegistryChecks checks={assessment.registryCheck ?? []} />
            </Disclosure>
            <Disclosure title="Składniki wskaźnika — przesłanki i kontrdowody" meta={assessment.indicator.components.length}>
              <ComponentTable indicator={assessment.indicator} />
              <Limitations indicator={assessment.indicator} />
            </Disclosure>
            <NetworkEntries assessment={assessment} />
            <VerifyList items={assessment.whatToVerify ?? []} title="Co sprawdzić po stronie KAS" />
          </li>
          {assessment.registered && (
            <li className="indicator-item st-hypothesis">
              <RegisteredTrack assessment={assessment} />
            </li>
          )}
        </ul>
      )}
    </article>
  );
}

/** Zwięzła linia w podsumowaniu sprawy — tylko od „istotnych przesłanek”. */
export function BusinessHeroLine() {
  const { dossier, tabHref } = useDossier();
  const assessment = businessOf(dossier.indicators);
  if (!assessment) return null;
  const lines = [
    assessment.indicator.score >= BUSINESS_HERO_MIN ? { label: 'Sygnały działalności gospodarczej', indicator: assessment.indicator } : undefined,
    assessment.registered && assessment.registered.indicator.score >= BUSINESS_HERO_MIN ? { label: 'Podmiot zarejestrowany — sygnały do weryfikacji obrotu', indicator: assessment.registered.indicator } : undefined,
  ].filter((item): item is { label: string; indicator: Indicator } => item !== undefined);
  const network = assessment.network ?? [];
  if (lines.length === 0) return null;
  return (
    <p className="business-hero-line muted small">
      {lines.map((line, index) => (
        <span key={line.label}>
          {index > 0 && ' · '}
          <a href={`${tabHref('wskazniki')}`}>
            {line.label}: <strong>{line.indicator.score}</strong> · {line.indicator.level}
          </a>{' '}
          <span className="muted">(hipoteza)</span>
        </span>
      ))}
      {network.length > 0 && (
        <span>
          {lines.length > 0 && ' · '}W siatce: {network.length} {network.length === 1 ? 'podmiot' : 'podmiotów'} z sygnałami działalności
        </span>
      )}
    </p>
  );
}
