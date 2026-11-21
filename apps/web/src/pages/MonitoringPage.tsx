// Monitoring: monitorowane sprawy (automatyczne ponawianie analizy i zmiany od poprzedniej) oraz,
// jako sekcja dodatkowa, cykliczny przegląd publicznych źródeł z listą źródeł i strumieniem trafień.
import { useEffect, useMemo, useState } from 'react';
import type { MonitorSourceStatus, MonitorStatus, ScoredSignal, WatchHit } from '@olcys/core';
import { api, trackRun } from '../api.ts';
import type { CashOutChange, MonitorSettings, WatchedCase } from '../api.ts';
import type { CorpusStats, Depth, RunProgress } from '../proof.ts';
import { paginate } from '../proof.ts';
import { DiffView } from '../components/DiffView.tsx';
import { AnalysisProgress } from '../components/Progress.tsx';
import { Disclosure } from '../components/ui/Disclosure.tsx';
import { DEFAULT_WATCH_MINUTES, changeSummary, intervalLabel } from '../stats.ts';
import { DEFAULT_HIT_FILTER, LIMIT_RANGE, POLISH_NEXUS_THRESHOLD, countDismissed, filterHits, hitBasisLabel, lastRunRows, parseLimit, sortHits } from '../monitor.ts';
import type { HitFilter, MonitorHit, MonitorStatusView } from '../monitor.ts';
import type { TextInsight } from '@olcys/core';
import { Bar, Crumbs, EmptyState, ErrorBox, ExternalLink, LayerTag, ScoreBadge, ShortAddress, Skeleton } from '../components/common.tsx';
import { useToast } from '../components/Toast.tsx';
import { KnownFromCases } from '../components/common.tsx';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln } from '../format.ts';
import { NETWORK_LABEL, NETWORK_SHORT, STATUS_LABEL } from '../labels.ts';
import { href, navigate } from '../router.ts';
import { useAsync } from '../useAsync.ts';

const OWNERSHIP: Record<TextInsight['ownership'], string> = {
  own_address: 'autor podaje własny adres',
  third_party_address: 'adres należy do kogoś innego',
  warning_about_address: 'ostrzeżenie o cudzym adresie',
  quoted: 'adres tylko zacytowany',
  unclear: 'nie da się rozstrzygnąć',
};

const STATUS_NAME: Record<WatchHit['status'], string> = { new: 'nowe', analyzed: 'przeanalizowane', dismissed: 'odrzucone' };
const LANGUAGE: Record<string, string> = { pl: 'polski', en: 'angielski', de: 'niemiecki', ru: 'rosyjski', uk: 'ukraiński', und: 'nierozpoznany' };

/** Pole limitu na przebieg: zapis po opuszczeniu pola, wartość przycinana do zakresu przyjmowanego przez usługę. */
function LimitField({ label, title, value, range, onSave }: { label: string; title: string; value: number; range: { min: number; max: number }; onSave: (value: number) => void }) {
  return (
    <label title={title}>
      {label}
      <input
        type="number"
        min={range.min}
        max={range.max}
        step={1}
        defaultValue={value}
        onBlur={(event) => {
          const parsed = parseLimit(event.target.value, range);
          if (parsed === undefined) event.target.value = String(value);
          else if (parsed !== value) onSave(parsed);
          else event.target.value = String(value);
        }}
      />
    </label>
  );
}

function StatusBar({
  status,
  onChange,
  onRun,
  onRecheck,
  busy,
  rechecking,
}: {
  status: MonitorStatusView;
  onChange: (settings: MonitorSettings) => void;
  onRun: () => void;
  onRecheck: () => void;
  busy: boolean;
  rechecking: boolean;
}) {
  const [threshold, setThreshold] = useState(status.autoAnalyzeThreshold);
  const working = busy || status.running;
  return (
    <section className="card monitor-bar" aria-label="Stan monitoringu">
      <label className="switch">
        <input type="checkbox" checked={status.enabled} onChange={(event) => onChange({ enabled: event.target.checked })} />
        Monitoring {status.enabled ? 'włączony' : 'wyłączony'}
      </label>
      <label>
        Przegląd co
        <input
          type="number"
          min={5}
          max={1440}
          step={5}
          defaultValue={status.everyMinutes}
          onBlur={(event) => {
            const value = Math.max(5, Number(event.target.value) || status.everyMinutes);
            if (value !== status.everyMinutes) onChange({ everyMinutes: value });
          }}
        />
        min
      </label>
      <label title="Suma ocen „Związek z Polską” i „Sygnały do sprawdzenia” (0–200), od której autor jest analizowany automatycznie">
        Próg automatycznej analizy: <output>{threshold}</output>
        <input
          type="range"
          min={0}
          max={200}
          step={10}
          value={threshold}
          onChange={(event) => setThreshold(Number(event.target.value))}
          onPointerUp={() => threshold !== status.autoAnalyzeThreshold && onChange({ autoAnalyzeThreshold: threshold })}
          onKeyUp={() => threshold !== status.autoAnalyzeThreshold && onChange({ autoAnalyzeThreshold: threshold })}
        />
      </label>
      {typeof status.maxAutoAnalyses === 'number' && (
        <LimitField
          label="Limit analiz autorów na przebieg"
          title={`Ilu autorów najwyżej analizować automatycznie w jednym przebiegu (${LIMIT_RANGE.maxAutoAnalyses.min}–${LIMIT_RANGE.maxAutoAnalyses.max}); 0 wyłącza automatyczną analizę`}
          value={status.maxAutoAnalyses}
          range={LIMIT_RANGE.maxAutoAnalyses}
          onSave={(value) => onChange({ maxAutoAnalyses: value })}
        />
      )}
      {typeof status.maxAiPublications === 'number' && (
        <LimitField
          label="Limit publikacji czytanych przez model"
          title={`Ile publikacji najwyżej czyta model językowy w jednym przebiegu (${LIMIT_RANGE.maxAiPublications.min}–${LIMIT_RANGE.maxAiPublications.max}); 0 wyłącza odczyt przez model`}
          value={status.maxAiPublications}
          range={LIMIT_RANGE.maxAiPublications}
          onSave={(value) => onChange({ maxAiPublications: value })}
        />
      )}
      <button type="button" className="button button-primary" onClick={onRun} disabled={working || rechecking}>
        {working ? 'Przegląd w toku…' : 'Przejrzyj teraz'}
      </button>
      <button
        type="button"
        className="button"
        onClick={onRecheck}
        disabled={working || rechecking}
        title="Zapisane trafienia są oceniane bieżącymi regułami; te, które nie spełniają już kryteriów, zostają oznaczone jako odrzucone z podanym powodem"
      >
        {rechecking ? 'Przeliczanie…' : 'Przelicz zapisane trafienia nowymi regułami'}
      </button>
      <dl>
        <div>
          <dt>Ostatni przebieg</dt>
          <dd>{fmtDateTime(status.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Następny przebieg</dt>
          <dd>{status.enabled ? fmtDateTime(status.nextRunAt) : 'wstrzymany'}</dd>
        </div>
        <div>
          <dt>Publikacje / trafienia</dt>
          <dd>
            {status.totals.documentsSeen.toLocaleString('pl-PL')} / {status.totals.hits}
          </dd>
        </div>
        <div>
          <dt>Nowe / przeanalizowane</dt>
          <dd>
            {status.totals.newHits} / {status.totals.analyzed}
          </dd>
        </div>
        {typeof status.totals.dismissed === 'number' && (
          <div>
            <dt>Odrzucone</dt>
            <dd>{status.totals.dismissed}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** Rozbicie ostatniego przebiegu: ile publikacji przeszło przez kolejne etapy i dlaczego części nie analizowano. */
function LastRun({ status }: { status: MonitorStatusView }) {
  const run = status.totals.lastRun;
  const rows = lastRunRows(run);
  if (rows.length === 0) return null;
  return (
    <section className="card last-run" aria-labelledby="ostatni-przebieg">
      <h2 id="ostatni-przebieg">
        Ostatni przebieg <span className="muted">· {fmtDateTime(run?.at ?? status.lastRunAt)}</span>
      </h2>
      <dl className="meta">
        {rows.map((row) => (
          <div key={row.label} title={row.hint}>
            <dt>{row.label}</dt>
            <dd>{row.value.toLocaleString('pl-PL')}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Sources({ sources, onToggle }: { sources: MonitorSourceStatus[]; onToggle: (source: MonitorSourceStatus) => void }) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const [page, setPage] = useState(1);
  const matching = sources.filter((source) => `${source.service} ${source.label}`.toLowerCase().includes(needle));
  // Długą listę (setki źródeł) pokazujemy po 50 pozycji.
  const paged = paginate(matching, page, 50);
  const shown = paged.items;
  const services = [...new Set(shown.map((source) => source.service))];
  const pager = paged.pages > 1 && (
    <p className="pager">
      <button type="button" className="button button-small" disabled={paged.page <= 1} onClick={() => setPage(paged.page - 1)}>
        ← Poprzednie
      </button>
      <span>
        strona {paged.page} z {paged.pages} · {matching.length} źródeł
      </span>
      <button type="button" className="button button-small" disabled={paged.page >= paged.pages} onClick={() => setPage(paged.page + 1)}>
        Następne →
      </button>
    </p>
  );
  const failing = sources.filter((source) => source.lastError).length;
  return (
    <details className="card">
      <summary>
        <strong>Źródła ({sources.filter((source) => source.enabled).length} włączonych z {sources.length})</strong>
        {failing > 0 && <span className="chip chip-warn"> błędy: {failing}</span>}
      </summary>
      <label className="inline-field source-filter">
        Filtr źródeł
        <input type="text" value={filter} onChange={(event) => {
            setFilter(event.target.value);
            setPage(1);
          }} placeholder="serwis lub nazwa" />
      </label>
      {pager}
      {services.map((service) => (
        <section key={service} className="source-group">
          <h3>{service}</h3>
          <div className="table-scroll">
            <table className="table table-dense">
              <thead>
                <tr>
                  <th scope="col">Włączone</th>
                  <th scope="col">Źródło</th>
                  <th scope="col" className="num">Publikacje</th>
                  <th scope="col" className="num">Trafienia</th>
                  <th scope="col">Ostatni przebieg</th>
                </tr>
              </thead>
              <tbody>
                {shown
                  .filter((source) => source.service === service)
                  .map((source) => (
                    <tr key={source.connectorId}>
                      <td>
                        <input type="checkbox" checked={source.enabled} onChange={() => onToggle(source)} aria-label={`Źródło ${source.label}`} />
                      </td>
                      <th scope="row">
                        {source.label}
                        {source.lastError && <span className="source-error">Błąd: {source.lastError}</span>}
                      </th>
                      <td className="num">{source.documentsSeen.toLocaleString('pl-PL')}</td>
                      <td className="num">{source.hits}</td>
                      <td>{fmtDateTime(source.lastRunAt)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </details>
  );
}

/** Liczby opisujące rejestr źródeł; gdy usługa ich nie podaje, liczymy odrębne serwisy z listy. */
type RegistryCounts = { sites?: number; communities?: number; distinctSites?: number; distinctCommunities?: number };

function Registry({ status, corpus }: { status: MonitorStatus; corpus: CorpusStats | null }) {
  const counts = status as MonitorStatus & RegistryCounts & { registry?: RegistryCounts };
  const sites = counts.registry?.sites ?? counts.registry?.distinctSites ?? counts.sites ?? counts.distinctSites ?? new Set(status.sources.map((source) => source.service)).size;
  const communities = counts.registry?.communities ?? counts.registry?.distinctCommunities ?? counts.communities ?? counts.distinctCommunities ?? status.sources.length;
  return (
    <div className="tiles">
      <div className="stat">
        <span className="stat-value">{sites}</span>
        <span className="stat-label">odrębne strony i serwisy w rejestrze źródeł</span>
      </div>
      <div className="stat">
        <span className="stat-value">{communities}</span>
        <span className="stat-label">działy, kanały i społeczności · włączone: {status.sources.filter((source) => source.enabled).length}</span>
      </div>
      {corpus && (
        <div className="stat">
          <span className="stat-value">{corpus.documents.toLocaleString('pl-PL')}</span>
          <span className="stat-label">
            Własny indeks publikacji · adresy: {corpus.addresses.toLocaleString('pl-PL')} · serwisy: {corpus.services} · przechowywanie {corpus.retentionDays} dni
          </span>
        </div>
      )}
    </div>
  );
}

function Signal({ title, signal }: { title: string; signal: ScoredSignal }) {
  return (
    <div className="signal">
      <strong>{title}</strong>
      <Bar value={signal.score} label={title} />
      <details className="why">
        <summary>przesłanki ({signal.reasons.length})</summary>
        <ul>
          {signal.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** Cytat jako zwykły tekst, z wyróżnionymi adresami. */
function Excerpt({ text, addresses }: { text: string; addresses: string[] }) {
  let parts: (string | { address: string })[] = [text];
  for (const address of addresses) {
    parts = parts.flatMap((part) =>
      typeof part === 'string' ? part.split(address).flatMap((piece, index) => (index === 0 ? [piece] : [{ address }, piece])) : [part],
    );
  }
  return (
    <blockquote className="excerpt">
      {parts.map((part, index) => (typeof part === 'string' ? <span key={index}>{part}</span> : <mark key={index}>{part.address}</mark>))}
    </blockquote>
  );
}

function HitCard({ hit, onChanged }: { hit: MonitorHit; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const extra = hit;
  const translation = extra.translationPl ?? extra.insight?.translationPl;
  const basis = hitBasisLabel(hit.basis);
  const dismissed = hit.status === 'dismissed';
  // Odrzucone trafienie często powtarza powód trafienia w powodzie odrzucenia — nie pokazujemy go dwa razy.
  const reason = hit.hitReason && !(dismissed && hit.dismissReason?.includes(hit.hitReason)) ? hit.hitReason : undefined;

  async function act(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      toast.success(message);
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function openCase() {
    setBusy(true);
    try {
      const created = await api.createCaseFromHit(hit.id);
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  }

  return (
    <article className={`card hit status-${hit.status}`}>
      <header>
        <span className="muted">
          {hit.service} · {hit.author ?? 'autor nieznany'} · {fmtDateTime(hit.publishedAt ?? hit.detectedAt)}
        </span>
        <span className={`chip ${dismissed ? 'chip-warn' : ''}`}>{STATUS_NAME[hit.status] ?? hit.status}</span>
        <h3>
          <ExternalLink url={hit.url}>{hit.title}</ExternalLink>
        </h3>
      </header>
      {(basis || reason) && (
        <p className="hit-basis">
          {basis && (
            <span className="chip chip-fact" title="Która część definicji trafienia jest spełniona">
              podstawa: {basis}
            </span>
          )}
          {reason && <span>{reason}</span>}
        </p>
      )}
      {dismissed && (
        <p className="hit-dismissed">
          <strong>Powód odrzucenia:</strong> {hit.dismissReason ?? 'nie podano (odrzucone ręcznie albo przez starszą wersję usługi)'}
        </p>
      )}
      <Excerpt text={hit.excerpt ?? ''} addresses={(hit.addresses ?? []).map((item) => item.address)} />
      {translation && (
        <details className="why">
          <summary>Tłumaczenie na polski</summary>
          <p>{translation}</p>
        </details>
      )}
      {extra.insight && (
        <p className="insight">
          <strong>Sugestia modelu</strong> <LayerTag layer="inference" /> czyj jest adres: {OWNERSHIP[extra.insight.ownership] ?? extra.insight.ownership}
          {extra.insight.quote && ` — „${extra.insight.quote}”`} <span className="muted">({extra.insight.model})</span>
        </p>
      )}
      <KnownFromCases items={hit.knownFromCases} />
      <p>
        <span className="chip">język: {LANGUAGE[hit.language] ?? hit.language}</span>
        {(hit.addresses ?? []).map((item) => (
          <span key={item.address} className="chip chip-mono" title={`${NETWORK_LABEL[item.network] ?? item.network}: ${item.address}`}>
            {NETWORK_SHORT[item.network] ?? item.network} · <ShortAddress value={item.address} />
          </span>
        ))}
      </p>
      <div className="signals">
        <Signal title="Związek z Polską" signal={hit.polishNexus} />
        <Signal title="Sygnały do sprawdzenia" signal={hit.suspicion} />
      </div>
      {hit.lead && (
        <div className="hit-lead">
          <LayerTag layer="calc" /> Analiza autora: priorytet <strong>{hit.lead.priority}/100</strong>, najwyższy Wskaźnik Pewności{' '}
          <ScoreBadge score={hit.lead.topScore} />
          {Object.keys(hit.lead.cashOutPlnByYear).length > 0 && (
            <>
              , szacowane wypłaty:{' '}
              {Object.entries(hit.lead.cashOutPlnByYear)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([year, value]) => `${year}: ${fmtPln(value)}`)
                .join(' · ')}
            </>
          )}
        </div>
      )}
      {hit.autoAnalysis && !hit.lead && <p className="muted hit-auto">{hit.autoAnalysis}</p>}
      <div className="actions">
        {hit.caseId ? (
          <a className="button button-small button-primary" href={href.case(hit.caseId)}>
            Otwórz teczkę
          </a>
        ) : hit.lead ? (
          <button type="button" className="button button-small button-primary" onClick={openCase} disabled={busy}>
            Otwórz teczkę
          </button>
        ) : (
          <button type="button" className="button button-small" onClick={() => act(() => api.analyzeHit(hit.id), 'Przeanalizowano autora publikacji.')} disabled={busy}>
            {busy ? 'Analiza…' : 'Analizuj autora'}
          </button>
        )}
        {hit.status !== 'dismissed' && (
          <button type="button" className="button button-small" onClick={() => act(() => api.dismissHit(hit.id), 'Trafienie odrzucone.')} disabled={busy}>
            Odrzuć
          </button>
        )}
      </div>
    </article>
  );
}

function Hits({ hits, onChanged }: { hits: MonitorHit[]; onChanged: () => void }) {
  const [filter, setFilter] = useState<HitFilter>(DEFAULT_HIT_FILTER);
  const [byDate, setByDate] = useState(false);
  const { status, minPolish, minSuspicion, network, service } = filter;
  const set = (change: Partial<HitFilter>) => setFilter((current) => ({ ...current, ...change }));
  const setStatus = (value: HitFilter['status']) => set({ status: value });
  const setMinPolish = (value: number) => set({ minPolish: value });
  const setMinSuspicion = (value: number) => set({ minSuspicion: value });
  const setNetwork = (value: string) => set({ network: value });
  const setService = (value: string) => set({ service: value });
  const services = useMemo(() => [...new Set(hits.map((hit) => hit.service))].sort(), [hits]);
  const networks = useMemo(() => [...new Set(hits.flatMap((hit) => (hit.addresses ?? []).map((item) => item.network)))].sort(), [hits]);
  const dismissedCount = useMemo(() => countDismissed(hits), [hits]);
  const shown = sortHits(filterHits(hits, filter), byDate ? 'date' : 'total');

  return (
    <section aria-labelledby="trafienia">
      <header className="section-head">
        <h2 id="trafienia">
          Trafienia ({shown.length} z {hits.length})
        </h2>
        <div className="segmented" role="group" aria-label="Sortowanie trafień">
          <button type="button" aria-pressed={!byDate} onClick={() => setByDate(false)} title="Suma ocen „Związek z Polską” i „Sygnały do sprawdzenia” (0–200)">
            Od najwyższej sumy ocen
          </button>
          <button type="button" aria-pressed={byDate} onClick={() => setByDate(true)}>
            Wg daty
          </button>
        </div>
      </header>
      <fieldset className="filters card">
        <legend className="visually-hidden">Filtry trafień</legend>
        <label>
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}>
            <option value="all">{filter.showDismissed ? 'wszystkie' : 'nowe i przeanalizowane'}</option>
            <option value="new">nowe</option>
            <option value="analyzed">przeanalizowane</option>
            <option value="dismissed">tylko odrzucone</option>
          </select>
        </label>
        <label className="filter-check" title="Odrzucone trafienia są domyślnie ukryte; po włączeniu widać je razem z powodem odrzucenia">
          <input type="checkbox" checked={filter.showDismissed || status === 'dismissed'} disabled={status !== 'all'} onChange={(event) => set({ showDismissed: event.target.checked })} />
          pokaż odrzucone ({dismissedCount})
        </label>
        <label className="filter-check" title={`Ocena „Związek z Polską” co najmniej ${POLISH_NEXUS_THRESHOLD} na 100`}>
          <input type="checkbox" checked={filter.polishOnly} onChange={(event) => set({ polishOnly: event.target.checked })} />
          tylko ze związkiem z Polską
        </label>
        <label>
          Związek z Polską od <output>{minPolish}</output>
          <input type="range" min={0} max={100} step={10} value={minPolish} onChange={(event) => setMinPolish(Number(event.target.value))} />
        </label>
        <label>
          Sygnały od <output>{minSuspicion}</output>
          <input type="range" min={0} max={100} step={10} value={minSuspicion} onChange={(event) => setMinSuspicion(Number(event.target.value))} />
        </label>
        <label>
          Sieć
          <select value={network} onChange={(event) => setNetwork(event.target.value)}>
            <option value="all">wszystkie</option>
            {networks.map((item) => (
              <option key={item} value={item}>
                {NETWORK_LABEL[item] ?? item}
              </option>
            ))}
          </select>
        </label>
        <label>
          Serwis
          <select value={service} onChange={(event) => setService(event.target.value)}>
            <option value="all">wszystkie</option>
            {services.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </fieldset>
      {shown.length === 0 ? (
        <EmptyState title="Brak trafień spełniających filtry">Poluzuj filtry albo uruchom przegląd przyciskiem „Przejrzyj teraz”.</EmptyState>
      ) : (
        <div className="hit-grid">
          {shown.map((hit) => (
            <HitCard key={hit.id} hit={hit} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Nowe przelewy do giełd i usług od poprzedniej analizy. */
function NewCashOuts({ items }: { items: CashOutChange[] }) {
  return (
    <section className="diff-block">
      <h4>Nowe przelewy do usług ({items.length})</h4>
      {items.length === 0 ? (
        <p className="muted">Brak nowych przelewów do giełd ani usług.</p>
      ) : (
        <ul className="plain-list">
          {items.map((item) => (
            <li key={`${item.address}-${item.txid}-${item.counterparty}`} className="cashout-change">
              <strong>{item.counterpartyLabel ?? 'usługa bez nazwy'}</strong> · {fmtDateTime(item.time)} · {fmtAmount(item.amount, item.asset)}
              {item.valuePln !== undefined && <> · ok. {fmtPln(item.valuePln)}</>}
              <span className="muted small">
                {' '}
                z adresu <ShortAddress value={item.address} />
                {item.explorerUrl && (
                  <>
                    {' · '}
                    <ExternalLink url={item.explorerUrl}>transakcja</ExternalLink>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Jedna monitorowana sprawa: harmonogram, ostatnia analiza, zmiany i „Odśwież teraz”. */
function WatchedCaseCard({ item, intervals, onChanged }: { item: WatchedCase; intervals: number[]; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RunProgress>();
  const [refreshing, setRefreshing] = useState(false);
  const summary = item.changes ? changeSummary(item.changes) : [];
  const running = refreshing || item.running;
  const options = [...new Set([...intervals, item.everyMinutes])].sort((a, b) => a - b);

  async function update(settings: { everyMinutes: number; depth?: Depth } | null, message: string) {
    setBusy(true);
    try {
      await api.setWatch(item.caseId, settings);
      toast.success(message);
      onChanged();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setRefreshing(true);
    setProgress(undefined);
    try {
      const handle = await api.refreshWatched(item.caseId);
      onChanged();
      if (handle.status === 'running') await trackRun(handle.id, setProgress);
      toast.success(`Odświeżono sprawę „${item.name}”.`);
    } catch (error) {
      toast.error(error);
    } finally {
      setRefreshing(false);
      onChanged();
    }
  }

  return (
    <article className="card watch-card">
      <header className="watch-card-head">
        <div>
          <h3>
            <a href={href.case(item.caseId)}>{item.name}</a>
          </h3>
          <p className="muted small">
            monitorowana od {fmtDate(item.since)} · tryb {item.depth === 'deep' ? 'głęboki' : 'szybki'}
          </p>
        </div>
        <div className="watch-card-actions">
          <button type="button" className="button button-primary button-small" onClick={refresh} disabled={running || busy}>
            {running ? 'Analiza w toku…' : 'Odśwież teraz'}
          </button>
          <button type="button" className="button button-small button-quiet" onClick={() => update(null, `Wyłączono monitorowanie sprawy „${item.name}”.`)} disabled={busy}>
            Przestań monitorować
          </button>
        </div>
      </header>
      <dl className="watch-meta">
        <div>
          <dt>Ostatnia analiza</dt>
          <dd>
            {item.lastRun ? (
              <>
                {fmtDateTime(item.lastRun.startedAt)}
                {item.lastRun.status !== 'completed' && <span className="muted"> · {STATUS_LABEL[item.lastRun.status] ?? item.lastRun.status}</span>}
              </>
            ) : (
              'jeszcze nie było'
            )}
          </dd>
        </div>
        <div>
          <dt>Następna analiza</dt>
          <dd>{fmtDateTime(item.nextRunAt)}</dd>
        </div>
        <div>
          <dt>Najmocniejsze powiązanie</dt>
          <dd>{item.lastRun?.status === 'completed' ? <ScoreBadge score={item.lastRun.topScore} title="Wskaźnik Pewności" /> : '—'}</dd>
        </div>
        <div>
          <dt>
            <label htmlFor={`co-${item.caseId}`}>Analiza</label>
          </dt>
          <dd>
            <select
              id={`co-${item.caseId}`}
              value={item.everyMinutes}
              disabled={busy}
              onChange={(event) => {
                const everyMinutes = Number(event.target.value);
                update({ everyMinutes, depth: item.depth }, `Sprawa „${item.name}” będzie analizowana ${intervalLabel(everyMinutes)}.`);
              }}
            >
              {options.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {intervalLabel(minutes)}
                </option>
              ))}
            </select>
          </dd>
        </div>
      </dl>
      {item.lastError && (
        <p className="status-box status-box-warn" role="alert">
          Ostatnia próba uruchomienia analizy nie powiodła się: {item.lastError}
        </p>
      )}
      {running && progress && <AnalysisProgress title={`Szukam powiązań: „${item.name}”…`} progress={progress} depth={item.depth} />}
      {item.changes && item.compared ? (
        <Disclosure
          title={summary.length > 0 ? `Co się zmieniło: ${summary.join(' · ')}` : 'Co się zmieniło: bez zmian'}
          meta={`${fmtDateTime(item.compared.from.startedAt)} → ${fmtDateTime(item.compared.to.startedAt)}`}
          className={summary.length > 0 ? 'watch-changes has-changes' : 'watch-changes'}
        >
          <DiffView diff={item.changes.diff} />
          <NewCashOuts items={item.changes.newCashOuts} />
          <p className="muted small">
            Porównanie dwóch ostatnich zakończonych analiz. Pełna historia: <a href={href.case(item.caseId, 'analizy')}>Historia analiz w teczce</a>.
          </p>
        </Disclosure>
      ) : (
        <p className="muted small">Zmiany pojawią się po kolejnej analizie — porównujemy zawsze dwie ostatnie.</p>
      )}
    </article>
  );
}

function WatchedCases() {
  const loaded = useAsync(() => api.listWatched(), 'watch');
  const data = loaded.data;
  const anyRunning = data?.items.some((item) => item.running) ?? false;

  // Gdy któraś analiza trwa, lista odświeża się sama.
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setTimeout(loaded.reload, 5000);
    return () => clearTimeout(timer);
  }, [anyRunning, data, loaded.reload]);

  return (
    <section aria-labelledby="monitorowane-sprawy">
      <header className="section-head">
        <div>
          <h2 id="monitorowane-sprawy">Monitorowane sprawy</h2>
          <p className="muted small">
            Zaznaczone polem „Monitoruj” w historii spraw na <a href={href.dashboard()}>pulpicie</a>. Program sam ponawia ich analizę i pokazuje, co się zmieniło.
          </p>
        </div>
      </header>
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!data && loaded.loading && !loaded.error && <Skeleton blocks={2} />}
      {data === null && (
        <p className="notice" role="note">
          Monitorowanie spraw wymaga nowszej wersji usługi analizy — będzie dostępne po jej ponownym uruchomieniu.
        </p>
      )}
      {data && data.items.length === 0 && (
        <EmptyState title="Nie monitorujesz jeszcze żadnej sprawy" action={<a className="button" href={href.dashboard()}>Przejdź do historii spraw</a>}>
          Zaznacz „Monitoruj” przy sprawie na pulpicie — analiza będzie ponawiana automatycznie (domyślnie {intervalLabel(DEFAULT_WATCH_MINUTES)}, w trybie głębokim).
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <div className="watch-list">
          {data.items.map((item) => (
            <WatchedCaseCard key={item.caseId} item={item} intervals={data.intervals} onChanged={loaded.reload} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Przegląd źródeł: monitoring publikacji z adresami (dawny główny widok). Wczytywany dopiero po rozwinięciu. */
function SourceSweepSection() {
  const [open, setOpen] = useState(false);
  return (
    <details className="disclosure source-sweep" onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="disclosure-chevron" aria-hidden="true" />
        <span className="disclosure-title">Przegląd źródeł — nowe publikacje z adresami krypto</span>
        <span className="disclosure-meta">cykliczny przegląd forów i serwisów, niezależny od spraw</span>
      </summary>
      <div className="disclosure-body">{open && <SourceSweep />}</div>
    </details>
  );
}

export function MonitoringPage() {
  return (
    <div className="page">
      <Crumbs items={[{ label: 'Pulpit', href: href.dashboard() }, { label: 'Monitoring' }]} />
      <h1>Monitoring</h1>
      <WatchedCases />
      <SourceSweepSection />
    </div>
  );
}

function SourceSweep() {
  const toast = useToast();
  const [running, setRunning] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const loaded = useAsync(async () => {
    // 500 to najwyższy limit usługi — odrzucone trafienia nie mogą wypierać z listy czynnych.
    const [status, hits, corpus] = await Promise.all([api.getMonitor(), api.listHits(500), api.getCorpusStats().catch(() => null)]);
    return { status: status as MonitorStatusView, hits: hits as MonitorHit[], corpus };
  }, 'monitor');

  async function recheck() {
    setRechecking(true);
    try {
      const result = await api.recheckMonitor();
      toast.success(`Przeliczono trafienia: sprawdzone — ${result.checked}, pozostawione — ${result.kept}, odrzucone — ${result.dismissed}.`);
      loaded.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setRechecking(false);
    }
  }

  async function change(settings: MonitorSettings) {
    try {
      await api.updateMonitor(settings);
      toast.success('Zapisano ustawienia monitoringu.');
      loaded.reload();
    } catch (error) {
      toast.error(error);
    }
  }

  async function run() {
    setRunning(true);
    try {
      const result = await api.runMonitor();
      toast.success(`Przegląd zakończony: nowe trafienia — ${result.newHits}.`);
      loaded.reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="source-sweep-body">
      <p className="notice" role="note">
        <LayerTag layer="inference" /> Przeglądane są wyłącznie publiczne strony dostępne bez logowania. Trafienia to wskazania do weryfikacji, a nie
        zarzuty: „Sygnały do sprawdzenia” opisują cechy publikacji, nie ocenę osoby.
      </p>
      {loaded.error && <ErrorBox message={loaded.error} onRetry={loaded.reload} />}
      {!loaded.data && loaded.loading && <Skeleton blocks={3} />}
      {loaded.data && (
        <>
          <Registry status={loaded.data.status} corpus={loaded.data.corpus} />
          <StatusBar
            key={`${loaded.data.status.autoAnalyzeThreshold}-${loaded.data.status.maxAutoAnalyses}-${loaded.data.status.maxAiPublications}`}
            status={loaded.data.status}
            onChange={change}
            onRun={run}
            onRecheck={recheck}
            busy={running}
            rechecking={rechecking}
          />
          <LastRun status={loaded.data.status} />
          <Sources
            sources={loaded.data.status.sources}
            onToggle={(source) => change({ sources: { [source.connectorId]: !source.enabled } })}
          />
          <Hits hits={loaded.data.hits} onChanged={loaded.reload} />
        </>
      )}
    </div>
  );
}
