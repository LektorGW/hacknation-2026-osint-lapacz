// Statystyki: skuteczność ustaleń (średnia pewność, trafienia), zestawienie liczb i wypłaty na lata podatkowe.
import { api } from '../api.ts';
import type { Overview } from '../api.ts';
import { BarChart } from '../charts/Charts.tsx';
import { Crumbs, EmptyState, ErrorBox, LayerTag, Skeleton } from '../components/common.tsx';
import { Term } from '../components/ui/Term.tsx';
import type { GlossaryId } from '../glossary.ts';
import { fmtDateTime, fmtPln, sum } from '../format.ts';
import type { CorpusStats } from '../proof.ts';
import { href } from '../router.ts';
import { HIT_THRESHOLD, fmtStat } from '../stats.ts';
import type { StatsSummary } from '../stats.ts';
import { countText } from '../ux.ts';
import { useAsync } from '../useAsync.ts';

interface Metric {
  term: GlossaryId;
  label: string;
  value: string;
  /** Podstawa wyliczenia, np. „3 z 5 przeanalizowanych spraw”. */
  basis: string;
}

function metrics(stats: StatsSummary): Metric[] {
  const analysed = countText(stats.analysedCases, 'przeanalizowana sprawa', 'przeanalizowane sprawy', 'przeanalizowanych spraw');
  return [
    {
      term: 'srednia-pewnosc',
      label: 'średnia pewność',
      value: fmtStat(stats.averageConfidence),
      basis: `najwyższy Wskaźnik Pewności w sprawie, średnio · ${analysed}`,
    },
    {
      term: 'srednia-trafien',
      label: 'średnia liczba trafień na sprawę',
      value: fmtStat(stats.averageHits),
      basis: `${countText(stats.totalHits, 'trafienie', 'trafienia', 'trafień')} · ${analysed}`,
    },
    {
      term: 'skutecznosc',
      label: 'skuteczność',
      value: fmtStat(stats.effectiveness, '%'),
      basis: `${stats.casesWithHits} z ${countText(stats.analysedCases, 'przeanalizowanej sprawy', 'przeanalizowanych spraw', 'przeanalizowanych spraw')} ma trafienie`,
    },
    {
      term: 'odsetek-spraw-z-trafieniami',
      label: 'spraw z trafieniami',
      value: fmtStat(stats.casesWithHitsShare, '%'),
      basis: `${stats.casesWithHits} z ${countText(stats.totalCases, 'sprawy', 'spraw', 'spraw')} (także bez analizy)`,
    },
  ];
}

function Effectiveness({ stats }: { stats: StatsSummary }) {
  return (
    <section className="card stats-effect" aria-labelledby="skutecznosc">
      <header className="section-head">
        <h2 id="skutecznosc">Skuteczność ustaleń</h2>
        <span className="threshold-chip" title="Próg trafienia">
          <Term id="trafienie">trafienie</Term> = Wskaźnik Pewności ≥ {stats.hitThreshold ?? HIT_THRESHOLD}
        </span>
      </header>
      <p className="muted small">
        Liczone z ostatniej zakończonej analizy każdej sprawy, po Twoich korektach. Adres odrzucony nie jest trafieniem; próg {stats.hitThreshold ?? HIT_THRESHOLD} to poziom
        „prawdopodobne”.
      </p>
      <div className="tiles metric-tiles">
        {metrics(stats).map((metric) => (
          <div key={metric.term} className="stat metric">
            <span className="stat-value">{metric.value}</span>
            <span className="stat-label">
              <Term id={metric.term}>{metric.label}</Term>
            </span>
            <span className="metric-basis">{metric.basis}</span>
            <LayerTag layer="calc" />
          </div>
        ))}
      </div>
    </section>
  );
}

function Totals({ overview, corpus }: { overview: Overview; corpus: CorpusStats | null }) {
  const total = sum(Object.values(overview.cashOutPlnByYear));
  const tiles: [string, string, 'fact' | 'calc' | 'inference'][] = [
    [String(overview.cases), 'sprawy', 'fact'],
    [String(overview.runs), 'wykonane analizy', 'fact'],
    [String(overview.linkedAddresses), 'adresy powiązane z podmiotami', 'inference'],
    [total > 0 ? fmtPln(total) : '—', 'szacowane wypłaty na waluty tradycyjne', 'inference'],
  ];
  return (
    <section aria-labelledby="zestawienie">
      <h2 id="zestawienie" className="visually-hidden">
        Zestawienie
      </h2>
      <div className="tiles">
        {tiles.map(([value, label, layer]) => (
          <div key={label} className="stat">
            <span className="stat-value">{value}</span>
            <span className="stat-label">{label}</span>
            <LayerTag layer={layer} />
          </div>
        ))}
        {corpus && (
          <a className="stat stat-link" href={href.monitor()}>
            <span className="stat-value">{corpus.documents.toLocaleString('pl-PL')}</span>
            <span className="stat-label">
              Własny indeks publikacji · adresy: {corpus.addresses.toLocaleString('pl-PL')} · serwisy: {corpus.services}
            </span>
            <span className="muted">
              przechowywanie {corpus.retentionDays} dni{corpus.newestFetchedAt ? ` · najnowsza: ${fmtDateTime(corpus.newestFetchedAt)}` : ''}
            </span>
          </a>
        )}
        {overview.monitor && (
          <a className="stat stat-link" href={href.monitor()}>
            <span className="stat-value">{overview.monitor.newHits}</span>
            <span className="stat-label">Przegląd źródeł: nowe wskazania {overview.monitor.enabled ? '' : '(wyłączony)'}</span>
            <span className="muted">ostatni przebieg: {fmtDateTime(overview.monitor.lastRunAt)}</span>
          </a>
        )}
      </div>
    </section>
  );
}

export function StatsPage() {
  const loaded = useAsync(async () => {
    const [overview, corpus] = await Promise.all([api.getOverview(), api.getCorpusStats().catch(() => null)]);
    return { overview, corpus };
  }, 'stats');
  const overview = loaded.data?.overview;
  const years = Object.keys(overview?.cashOutPlnByYear ?? {}).sort();

  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Statystyki' }]} />
      <h1>Statystyki</h1>
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={3} />}
      {overview && (
        <>
          {overview.stats ? (
            <Effectiveness stats={overview.stats} />
          ) : (
            <p className="notice" role="note">
              Wskaźniki skuteczności (średnia pewność, trafienia) poda nowsza wersja usługi analizy — pojawią się po jej ponownym uruchomieniu.
            </p>
          )}
          <Totals overview={overview} corpus={loaded.data!.corpus} />
          {overview.approximate && (
            <p className="notice" role="note">
              Zestawienie uproszczone: ta wersja usługi analizy nie udostępnia przeglądu, więc liczby policzono z listy spraw.
            </p>
          )}
          <section className="card" aria-labelledby="wyplaty-lata">
            <h2 id="wyplaty-lata">Szacowane wypłaty na lata podatkowe</h2>
            {years.length === 0 ? (
              <EmptyState title="Brak danych o wypłatach">Wykres pojawi się po pierwszej analizie z oznakami wypłat.</EmptyState>
            ) : (
              <BarChart
                title="Szacowane wypłaty w PLN na lata podatkowe, wszystkie sprawy"
                categories={years}
                series={[{ key: 'total', label: 'Wypłaty', values: years.map((year) => overview.cashOutPlnByYear[year] ?? 0) }]}
              />
            )}
            <p className="muted">
              <LayerTag layer="inference" /> Szacunek z przelewów na adresy giełd i serwisów — wymaga potwierdzenia.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
