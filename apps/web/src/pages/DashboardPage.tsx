// Pulpit: jedno pole „Kogo sprawdzić?”, zestawienie liczb i lista spraw wg priorytetu.
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { IdentifierType } from '@olcys/core';
import { api, errorMessage, isDemo, quickCheck } from '../api.ts';
import type { CaseSummary, Overview } from '../api.ts';
import { BarChart } from '../charts/Charts.tsx';
import { Bar, EmptyState, ErrorBox, LayerTag, ScoreBadge, Skeleton } from '../components/common.tsx';
import { fmtDate, fmtDateTime, fmtPln, sum } from '../format.ts';
import { detectIdentifierType } from '../identify.ts';
import { IDENTIFIER_LABEL, IDENTIFIER_TYPES } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

const STAGES = [
  'Wyszukiwanie profili w publicznych źródłach',
  'Łączenie profili w jedną osobę',
  'Wyodrębnianie adresów kryptowalutowych',
  'Pobieranie danych blockchain i wycena',
  'Ustalanie powiązań z giełdami i portfelami',
];

/** Ekran postępu: etapy przesuwają się w stałym rytmie, ostatni trwa do zakończenia analizy. */
function Progress({ value }: { value: string }) {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setStage((current) => Math.min(current + 1, STAGES.length - 1)), 850);
    return () => clearInterval(timer);
  }, []);
  return (
    <section className="card progress" role="status" aria-live="polite">
      <h2>Ustalam, kim jest „{value}”…</h2>
      <ol className="progress-steps">
        {STAGES.map((label, index) => (
          <li key={label} className={index < stage ? 'is-done' : index === stage ? 'is-active' : ''}>
            <span className="progress-mark" aria-hidden="true">
              {index < stage ? '✓' : index + 1}
            </span>
            {label}
            {index === stage && <span className="visually-hidden"> — w toku</span>}
          </li>
        ))}
      </ol>
      <p className="muted">Po zakończeniu teczka otworzy się automatycznie.</p>
    </section>
  );
}

const EXAMPLES = ['tomwzor', 'tomasz.wzorcowy@poczta.example', 'Tomasz Wzorcowy'];

function QuickCheck() {
  const fieldId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [override, setOverride] = useState<IdentifierType>();
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<string>();
  const type = override ?? detectIdentifierType(value);

  // Skrót „/” ustawia fokus w polu wyszukiwania.
  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener('olcys:focus-search', focus);
    return () => window.removeEventListener('olcys:focus-search', focus);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Wpisz identyfikator osoby: nick, e-mail, imię i nazwisko, adres profilu, adres krypto albo nazwę ENS.');
      return;
    }
    setError(undefined);
    setPending(trimmed);
    try {
      const created = await quickCheck(trimmed, type);
      navigate(href.case(created.id));
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(undefined);
    }
  }

  if (pending) return <Progress value={pending} />;

  return (
    <form className="card quick" onSubmit={submit} noValidate>
      <label htmlFor={fieldId} className="quick-label">
        Kogo sprawdzić?
      </label>
      <p className="muted">Jeden identyfikator wystarczy — narzędzie samo znajdzie profile, ustali osobę z prawdopodobieństwem i wskaże giełdy.</p>
      <div className="quick-row">
        <input
          id={fieldId}
          ref={input}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setOverride(undefined);
          }}
          placeholder="nick, e-mail, imię i nazwisko, adres profilu, adres krypto lub nazwa ENS"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${fieldId}-type`}
        />
        <button type="submit" className="button button-primary button-large">
          Ustal
        </button>
      </div>
      <p className="quick-type" id={`${fieldId}-type`}>
        {value.trim() ? (
          <label>
            Rozpoznano jako:{' '}
            <select value={type} onChange={(event) => setOverride(event.target.value as IdentifierType)}>
              {IDENTIFIER_TYPES.map((item) => (
                <option key={item} value={item}>
                  {IDENTIFIER_LABEL[item]}
                </option>
              ))}
            </select>{' '}
            <span className="muted">(można poprawić)</span>
          </label>
        ) : (
          <span className="muted">Typ identyfikatora zostanie rozpoznany automatycznie.</span>
        )}
      </p>
      {isDemo && (
        <p className="quick-examples">
          Przykłady w trybie demo:{' '}
          {EXAMPLES.map((example) => (
            <button key={example} type="button" className="link-button" onClick={() => setValue(example)}>
              {example}
            </button>
          ))}
        </p>
      )}
      {error && <ErrorBox message={error} />}
    </form>
  );
}

function Tiles({ overview }: { overview: Overview }) {
  const total = sum(Object.values(overview.cashOutPlnByYear));
  const tiles: [string, string, 'fact' | 'calc' | 'inference'][] = [
    [String(overview.cases), 'sprawy', 'fact'],
    [String(overview.runs), 'wykonane analizy', 'fact'],
    [String(overview.linkedAddresses), 'adresy powiązane z podmiotami', 'inference'],
    [total > 0 ? fmtPln(total) : '—', 'szacowane wypłaty na waluty tradycyjne', 'inference'],
  ];
  return (
    <div className="tiles">
      {tiles.map(([value, label, layer]) => (
        <div key={label} className="stat">
          <span className="stat-value">{value}</span>
          <span className="stat-label">{label}</span>
          <LayerTag layer={layer} />
        </div>
      ))}
      {overview.monitor && (
        <a className="stat stat-link" href={href.monitor()}>
          <span className="stat-value">{overview.monitor.newHits}</span>
          <span className="stat-label">Monitoring: nowe trafienia {overview.monitor.enabled ? '' : '(wyłączony)'}</span>
          <span className="muted">ostatni przebieg: {fmtDateTime(overview.monitor.lastRunAt)}</span>
        </a>
      )}
    </div>
  );
}

function CaseTable({ cases, overview }: { cases: CaseSummary[]; overview: Overview }) {
  if (cases.length === 0) {
    return <EmptyState title="Nie ma jeszcze żadnej sprawy">Wpisz identyfikator osoby w polu „Kogo sprawdzić?” — sprawa powstanie automatycznie.</EmptyState>;
  }
  const ranked = cases
    .map((item) => ({ item, top: overview.topCases.find((entry) => entry.caseId === item.id) }))
    .sort((a, b) => (b.top?.priority ?? -1) - (a.top?.priority ?? -1));
  const withServices = ranked.some(({ top }) => top?.services !== undefined);
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Sprawa</th>
            <th scope="col">Priorytet</th>
            <th scope="col" className="num">Najwyższy Wskaźnik Pewności</th>
            <th scope="col" className="num">Szacowane wypłaty</th>
            {withServices && <th scope="col">Powiązane giełdy</th>}
            <th scope="col" className="num">Analizy</th>
            <th scope="col">Utworzono</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map(({ item, top }) => (
            <tr key={item.id}>
              <th scope="row">
                <a href={href.case(item.id)}>{item.name}</a>
              </th>
              <td>{top ? <Bar value={top.priority} label={`Priorytet sprawy ${item.name}`} /> : <span className="muted">brak analizy</span>}</td>
              <td className="num">{top ? <ScoreBadge score={top.topScore} /> : '—'}</td>
              <td className="num">{top && top.cashOutPlnTotal > 0 ? fmtPln(top.cashOutPlnTotal) : '—'}</td>
              {withServices && (
                <td>
                  {top?.services?.slice(0, 4).map((name) => (
                    <span key={name} className="chip">
                      {name}
                    </span>
                  ))}
                  {(top?.services?.length ?? 0) > 4 && <span className="muted"> +{top!.services!.length - 4}</span>}
                </td>
              )}
              <td className="num">{item.runs.length}</td>
              <td>{fmtDate(item.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const loaded = useAsync(async () => {
    const [cases, overview] = await Promise.all([api.listCases(), api.getOverview()]);
    return { cases, overview };
  }, 'dashboard');
  const years = Object.keys(loaded.data?.overview.cashOutPlnByYear ?? {}).sort();

  return (
    <div className="page">
      <h1 className="visually-hidden">Pulpit</h1>
      <QuickCheck />
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={3} />}
      {loaded.data && (
        <>
          <Tiles overview={loaded.data.overview} />
          {loaded.data.overview.approximate && (
            <p className="notice" role="note">
              Zestawienie uproszczone: ta wersja usługi analizy nie udostępnia przeglądu, więc priorytet przyjęto równy najwyższemu Wskaźnikowi Pewności.
            </p>
          )}
          <div className="dashboard-grid">
            <section className="card" aria-labelledby="lista-spraw">
              <h2 id="lista-spraw">Sprawy według priorytetu</h2>
              <CaseTable cases={loaded.data.cases} overview={loaded.data.overview} />
            </section>
            <section className="card" aria-labelledby="wyplaty-lata">
              <h2 id="wyplaty-lata">Szacowane wypłaty na lata podatkowe</h2>
              {years.length === 0 ? (
                <EmptyState title="Brak danych o wypłatach">Wykres pojawi się po pierwszej analizie z oznakami wypłat.</EmptyState>
              ) : (
                <BarChart
                  title="Szacowane wypłaty w PLN na lata podatkowe, wszystkie sprawy"
                  categories={years}
                  series={[{ key: 'total', label: 'Wypłaty', values: years.map((year) => loaded.data!.overview.cashOutPlnByYear[year] ?? 0) }]}
                />
              )}
              <p className="muted">
                <LayerTag layer="inference" /> Szacunek z przelewów na adresy giełd i serwisów — wymaga potwierdzenia.
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
