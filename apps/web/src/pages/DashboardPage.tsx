// Pulpit: jedno pole „Kogo sprawdzić?” i historia spraw (z możliwością monitorowania sprawy).
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { IdentifierType } from '@olcys/core';
import { DEFAULT_DEPTH, api, errorMessage, isDemo, quickCheck } from '../api.ts';
import type { CaseSummary, Overview } from '../api.ts';
import { AnalysisProgress, ModeSwitch, PeriodFields } from '../components/Progress.tsx';
import { cleanPeriod } from '../proof.ts';
import type { Depth, RunProgress } from '../proof.ts';
import { EmptyState, ErrorBox, Skeleton } from '../components/common.tsx';
import { useToast } from '../components/Toast.tsx';
import { Score } from '../components/ui/Score.tsx';
import { Term } from '../components/ui/Term.tsx';
import { Tour } from '../components/ui/Tour.tsx';
import { fmtDate, fmtPln } from '../format.ts';
import { detectIdentifierType } from '../identify.ts';
import { IDENTIFIER_LABEL, IDENTIFIER_TYPES } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { DEFAULT_WATCH_MINUTES, HISTORY_SORT_LABEL, intervalLabel, nextSort, sortHistory } from '../stats.ts';
import type { CaseStat, HistorySortKey, SortDirection } from '../stats.ts';
import { useAsync } from '../useAsync.ts';

const EXAMPLES = ['tomwzor', 'tomasz.wzorcowy@poczta.example', 'Tomasz Wzorcowy', 'KryptoGielda', 'bc1qadres0badany3x7k9m2p4q6r8s0t2v4w6y8z0a2c'];

function QuickCheck() {
  const fieldId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [override, setOverride] = useState<IdentifierType>();
  const [pending, setPending] = useState<string>();
  const [depth, setDepth] = useState<Depth>(DEFAULT_DEPTH);
  const [range, setRange] = useState({ from: '', to: '' });
  const [progress, setProgress] = useState<RunProgress>();
  const [error, setError] = useState<string>();
  const type = override ?? detectIdentifierType(value);
  const typed = value.trim() !== '';

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
    const { period, error: periodError } = cleanPeriod(range.from, range.to);
    if (periodError) {
      setError(periodError);
      return;
    }
    setError(undefined);
    setPending(trimmed);
    setProgress(undefined);
    try {
      const created = await quickCheck(trimmed, type, { depth, period }, setProgress);
      navigate(href.case(created.id));
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(undefined);
    }
  }

  if (pending) return <AnalysisProgress title={`Szukam powiązań: „${pending}”…`} progress={progress} depth={depth} />;

  return (
    <form className="card quick" onSubmit={submit} noValidate data-tour="search">
      <label htmlFor={fieldId} className="quick-label">
        Kogo sprawdzić?
      </label>
      <p className="muted">
        Jeden <Term id="identyfikator">identyfikator</Term> wystarczy — program sam znajdzie profile i adresy krypto, oceni powiązanie z osobą i wskaże giełdy,
        do których trafiły pieniądze.
      </p>
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
          aria-describedby={typed ? `${fieldId}-type` : undefined}
        />
        <button type="submit" className="button button-primary button-large">
          Ustal
        </button>
      </div>
      {typed && (
        <p className="quick-type" id={`${fieldId}-type`}>
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
        </p>
      )}
      <div className="quick-options">
        <ModeSwitch depth={depth} onChange={setDepth} />
        <PeriodFields from={range.from} to={range.to} onChange={setRange} />
      </div>
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

/** Pole „Monitoruj”: zaznaczenie włącza automatyczne ponawianie analizy sprawy (domyślnie co 6 godzin). */
function WatchToggle({ item }: { item: CaseSummary }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState(item.schedule?.everyMinutes);
  useEffect(() => setMinutes(item.schedule?.everyMinutes), [item.schedule?.everyMinutes]);
  const watched = minutes !== undefined;

  async function toggle(next: boolean) {
    const every = item.schedule?.everyMinutes ?? DEFAULT_WATCH_MINUTES;
    setBusy(true);
    setMinutes(next ? every : undefined);
    try {
      const updated = await api.setWatch(item.id, next ? { everyMinutes: every } : null);
      setMinutes(updated.schedule?.everyMinutes);
      toast.success(
        next ? `Sprawa „${item.name}” jest monitorowana — analiza ${intervalLabel(every)}. Zmiany zobaczysz w zakładce Monitoring.` : `Wyłączono monitorowanie sprawy „${item.name}”.`,
      );
    } catch (error) {
      setMinutes(next ? undefined : every);
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <label className={`watch-toggle ${watched ? 'is-on' : ''}`} title={minutes !== undefined ? `Analiza ponawiana ${intervalLabel(minutes)}` : 'Ponawiaj analizę tej sprawy automatycznie'}>
      <input type="checkbox" checked={watched} disabled={busy} onChange={(event) => toggle(event.target.checked)} />
      <span className="visually-hidden">Monitoruj sprawę „{item.name}”</span>
    </label>
  );
}

/** Nagłówek kolumny z sortowaniem: kliknięcie zmienia kolumnę albo kierunek. */
function SortHeader({ column, sort, onSort, term, numeric }: { column: HistorySortKey; sort: { key: HistorySortKey; direction: SortDirection }; onSort: (key: HistorySortKey) => void; term?: 'priorytet-sprawy' | 'wskaznik-pewnosci'; numeric?: boolean }) {
  const active = sort.key === column;
  return (
    <th scope="col" className={numeric ? 'num' : undefined} aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <span className="sort-head">
        <button type="button" className={`sort-button ${active ? 'is-active' : ''}`} onClick={() => onSort(column)}>
          {HISTORY_SORT_LABEL[column]}
          <span className="sort-arrow" aria-hidden="true">
            {active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}
          </span>
        </button>
        {term && <Term id={term} icon />}
      </span>
    </th>
  );
}

function CaseHistory({ cases, overview }: { cases: CaseSummary[]; overview: Overview }) {
  const [sort, setSort] = useState<{ key: HistorySortKey; direction: SortDirection }>({ key: 'created', direction: 'desc' });
  if (cases.length === 0) {
    return <EmptyState title="Nie ma jeszcze żadnej sprawy">Wpisz identyfikator osoby w polu „Kogo sprawdzić?” — sprawa powstanie automatycznie.</EmptyState>;
  }
  // Pełna lista z usługi; starsza wersja podaje tylko 10 najważniejszych spraw.
  const stats: Pick<CaseStat, 'caseId' | 'priority' | 'topScore' | 'cashOutPlnTotal' | 'services'>[] = overview.caseStats ?? overview.topCases;
  const rows = sortHistory(
    cases.map((item) => ({ ...item, stat: stats.find((entry) => entry.caseId === item.id) })),
    sort.key,
    sort.direction,
  );
  const withServices = rows.some(({ stat }) => (stat?.services?.length ?? 0) > 0);
  const onSort = (key: HistorySortKey) => setSort(nextSort(sort, key));
  return (
    <div className="table-scroll">
      <table className="table history-table">
        <thead>
          <tr>
            <th scope="col">Sprawa</th>
            <th scope="col">
              <span className="sort-head">
                Monitoruj <Term id="monitorowanie-sprawy" icon />
              </span>
            </th>
            <SortHeader column="priority" sort={sort} onSort={onSort} term="priorytet-sprawy" />
            <SortHeader column="strength" sort={sort} onSort={onSort} term="wskaznik-pewnosci" numeric />
            <SortHeader column="payouts" sort={sort} onSort={onSort} numeric />
            {withServices && <th scope="col">Powiązane giełdy</th>}
            <th scope="col" className="num">Analizy</th>
            <SortHeader column="created" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {rows.map((item) => {
            const { stat } = item;
            return (
              <tr key={item.id}>
                <th scope="row">
                  <a href={href.case(item.id)}>{item.name}</a>
                </th>
                <td className="watch-cell">
                  <WatchToggle item={item} />
                </td>
                <td>{stat ? <Score value={stat.priority} kind="priority" size="sm" plain /> : <span className="muted">brak analizy</span>}</td>
                <td className="num">{stat ? <Score value={stat.topScore} kind="publication" size="sm" plain /> : '—'}</td>
                <td className="num">{stat && stat.cashOutPlnTotal > 0 ? fmtPln(stat.cashOutPlnTotal) : '—'}</td>
                {withServices && (
                  <td className="services-cell">
                    {stat?.services?.slice(0, 2).map((name) => (
                      <span key={name} className="chip">
                        {name}
                      </span>
                    ))}
                    {(stat?.services?.length ?? 0) > 2 && (
                      <span className="muted" title={stat!.services!.slice(2).join(', ')}>
                        {' '}
                        +{stat!.services!.length - 2}
                      </span>
                    )}
                  </td>
                )}
                <td className="num">{item.runs.length}</td>
                <td>{fmtDate(item.createdAt)}</td>
              </tr>
            );
          })}
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

  return (
    <div className="page">
      <h1 className="visually-hidden">Pulpit</h1>
      <QuickCheck />
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={2} />}
      {loaded.data && (
        <section className="card" aria-labelledby="historia-spraw" data-tour="cases">
          <header className="section-head">
            <div>
              <h2 id="historia-spraw">Historia spraw</h2>
              <p className="muted small">Najnowsze na górze — kliknij nagłówek kolumny, aby posortować inaczej. „Monitoruj” ponawia analizę sprawy automatycznie.</p>
            </div>
            <a className="button button-quiet" href={href.stats()}>
              Statystyki →
            </a>
          </header>
          {loaded.data.overview.approximate && (
            <p className="notice" role="note">
              Zestawienie uproszczone: ta wersja usługi analizy nie udostępnia przeglądu, więc priorytet przyjęto równy najwyższemu Wskaźnikowi Pewności.
            </p>
          )}
          <CaseHistory cases={loaded.data.cases} overview={loaded.data.overview} />
        </section>
      )}
      <Tour chapter="dashboard" ready={loaded.data !== undefined} />
    </div>
  );
}
