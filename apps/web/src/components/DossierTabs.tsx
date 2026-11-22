// Sekcje teczki: profile, adresy, przepływy, oś czasu, osoby powiązane i rejestr decyzji.
import { useMemo, useState } from 'react';
import { AddressNetworkCard } from './OrganizationCards.tsx';
import type { ProfileCard, RelatedPerson, TimelineEvent } from '@olcys/core';
import { api } from '../api.ts';
import { BarChart, SankeyChart } from '../charts/Charts.tsx';
import { timeScale } from '../charts/scales.ts';
import { cashOutFlows, cashOutRows, cashOutSeries } from '../dossier.ts';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln, shorten, sum, yearOf } from '../format.ts';
import {
  CASH_OUT_LABEL,
  IDENTITY_LABEL,
  RELATION_LABEL,
  TIMELINE_KINDS,
  TIMELINE_KIND_LABEL,
} from '../labels.ts';
import { href, navigate } from '../router.ts';
import { EmptyState, ExternalLink, Initial, LAYER_KEYS, LayerTag, ShortAddress, layerLabel, toLayer } from './common.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';
import { countText } from '../ux.ts';
import type { Layer } from './common.tsx';
import { DecisionControls, DecisionHistory, useDossier } from './DossierContext.tsx';
import { isWithdrawn } from '../decisions.ts';
import type { DecisionRecord } from '../decisions.ts';
import { SyntheticTag } from './Mode.tsx';
import { FindingCard, RejectedCard } from './FindingCard.tsx';
import { ScamBlock } from './ScamWarnings.tsx';
import { UnconfirmedAddresses } from './Explanations.tsx';
import { useToast } from './Toast.tsx';

// ---------- Profile ----------

function ProfileAttributesList({ profile }: { profile: ProfileCard }) {
  const { attributes } = profile;
  const rows: [string, string | undefined][] = [
    ['Nazwa wyświetlana', attributes.displayName],
    ['E-mail', attributes.emails?.join(', ')],
    ['Telefon', attributes.phones?.join(', ')],
    ['Lokalizacja', attributes.location],
    ['Konto założono', attributes.createdAt && fmtDate(attributes.createdAt)],
  ];
  const shown = rows.filter(([, value]) => value);
  return (
    <>
      {attributes.bio && <blockquote className="excerpt">{attributes.bio}</blockquote>}
      {shown.length > 0 && (
        <dl className="meta">
          {shown.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {(attributes.urls?.length ?? 0) > 0 && (
        <p className="profile-links">
          Odnośniki wskazane w profilu:{' '}
          {attributes.urls!.map((url) => (
            <span key={url}>
              <ExternalLink url={url} />{' '}
            </span>
          ))}
        </p>
      )}
    </>
  );
}

function ProfileItem({ profile }: { profile: ProfileCard }) {
  const { dossier } = useDossier();
  const person = dossier.persons.find((item) => item.profileIds.includes(profile.id));
  const main = person !== undefined && person === dossier.persons[0];
  return (
    <article className={`card profile-card ${profile.decision === 'rejected' ? 'is-rejected' : ''}`}>
      <header className="profile-head">
        <Initial name={profile.service} />
        <div>
          <h3>{profile.handle ?? profile.attributes.displayName ?? profile.service}</h3>
          <p className="muted">
            {profile.service} · <ExternalLink url={profile.url}>otwórz profil</ExternalLink> <SyntheticTag source={{ service: profile.service, url: profile.url }} />
          </p>
        </div>
        <span className={`chip ${main ? 'chip-ok' : ''}`}>
          {main ? 'zaliczony do osoby głównej' : person ? 'prawdopodobnie inna osoba' : 'poza ustaleniem'}
        </span>
      </header>
      <div className="profile-identity">
        <Score value={profile.identityScore} kind="person" reasons={profile.identityReasons} caption="pewność, że profil należy do osoby ze sprawy" />
        <span className="status status-calc">{IDENTITY_LABEL[profile.identityMatch] ?? profile.identityMatch}</span>
      </div>
      <Disclosure title="Co zawiera profil" meta={profile.identityReasons.length > 0 ? countText(profile.identityReasons.length, 'przesłanka', 'przesłanki', 'przesłanek') : undefined}>
        {profile.identityReasons.length > 0 && (
          <ul className="reasons">
            {profile.identityReasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <ProfileAttributesList profile={profile} />
      </Disclosure>
      <p className="profile-addresses">
        <strong>Opublikowane adresy ({profile.addresses.length}):</strong>{' '}
        {profile.addresses.length === 0
          ? 'brak'
          : profile.addresses.map((key) => (
              <span key={key} className="chip chip-mono" title={key}>
                {key.split(':')[0]} · {shorten(key.split(':').slice(1).join(':'))}
              </span>
            ))}
      </p>
      <DecisionControls target="profile" decisionKey={profile.id} confirmLabel="Potwierdź: konto podmiotu" rejectLabel="Odrzuć: to nie konto podmiotu" />
    </article>
  );
}

export function ProfilesTab() {
  const { dossier } = useDossier();
  if (dossier.profiles.length === 0) {
    return <EmptyState title="Nie znaleziono profili">Dodaj kolejny identyfikator (nick, e-mail, adres profilu) i ponów analizę.</EmptyState>;
  }
  const ordered = [...dossier.profiles].sort((a, b) => b.identityScore - a.identityScore);
  return (
    <section aria-labelledby="profile">
      <header className="section-head">
        <div>
          <h2 id="profile">Profile ({ordered.length})</h2>
          <p className="muted">Narzędzie samo łączy profile w osobę. Korekta analityka jest opcjonalna i od razu przelicza wynik.</p>
        </div>
      </header>
      <div className="card-grid">
        {ordered.map((profile) => (
          <ProfileItem key={profile.id} profile={profile} />
        ))}
      </div>
    </section>
  );
}

// ---------- Adresy ----------

export function AddressesTab() {
  const { dossier } = useDossier();
  const linked = dossier.findings.filter((finding) => !finding.confidence.excluded);
  const rejected = dossier.findings.filter((finding) => finding.confidence.excluded);
  if (dossier.findings.length === 0 && (dossier.unconfirmedAddresses ?? []).length > 0) return <UnconfirmedAddresses />;
  if (dossier.findings.length === 0) {
    return <EmptyState title="Nie znaleziono adresów">W wybranych źródłach nie ma adresów kryptowalutowych dla podanych identyfikatorów.</EmptyState>;
  }
  return (
    <>
      <UnconfirmedAddresses />
      <ScamBlock />
      <section aria-labelledby="powiazane">
        <header className="section-head">
          <div>
            <h2 id="powiazane">Adresy powiązane ({linked.length})</h2>
            <p className="muted small">
              Od najmocniej powiązanego. Każdy <Term id="adres-krypto">adres</Term> ma ocenę, gdzie go opublikowano i co pokazuje blockchain.
            </p>
          </div>
        </header>
        {linked.length === 0 && <EmptyState title="Żaden adres nie jest przypisany osobie">Znalezione adresy zostały odrzucone albo czekają na potwierdzenie (wyżej).</EmptyState>}
        {linked.map((finding, index) => (
          <FindingCard key={finding.address} finding={finding} index={index} />
        ))}
      </section>
      <AddressNetworkCard />
      {rejected.length > 0 && (
        <section aria-labelledby="odrzucone" className="rejected-section">
          <Disclosure title={<span id="odrzucone">Adresy odrzucone ({rejected.length})</span>} meta="nie wchodzą do szacunku wypłat">
            <p className="muted small">Adresy znalezione w źródłach, których nie przypisuje się osobie — np. adres giełdy albo adres publikowany przez wiele osób.</p>
            {rejected.map((finding, index) => (
              <RejectedCard key={finding.address} finding={finding} index={linked.length + index} />
            ))}
          </Disclosure>
        </section>
      )}
    </>
  );
}

// ---------- Przepływy ----------

type SortKey = 'time' | 'valuePln' | 'kind';

export function FlowsTab() {
  const { dossier } = useDossier();
  const rows = useMemo(() => cashOutRows(dossier.findings), [dossier.findings]);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: 'time', descending: true });
  if (rows.length === 0) {
    return <EmptyState title="Nie wykryto oznak wypłat na waluty tradycyjne">Szacunek powstaje z przelewów na adresy giełd, serwisów P2P, bramek i kart.</EmptyState>;
  }
  const series = cashOutSeries(rows);
  const flows = cashOutFlows(rows);
  const sorted = [...rows].sort((a, b) => {
    const order =
      sort.key === 'valuePln' ? (a.valuePln ?? -1) - (b.valuePln ?? -1) : sort.key === 'kind' ? a.kind.localeCompare(b.kind) : a.time.localeCompare(b.time);
    return sort.descending ? -order : order;
  });
  const header = (key: SortKey, label: string, numeric = false) => (
    <th scope="col" className={numeric ? 'num' : ''} aria-sort={sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
      <button type="button" className="sort-button" onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : true })}>
        {label} {sort.key === key ? (sort.descending ? '▼' : '▲') : ''}
      </button>
    </th>
  );
  const unvalued = rows.filter((row) => row.valuePln === undefined).length;

  return (
    <section aria-labelledby="przeplywy">
      <header className="section-head">
        <div>
          <h2 id="przeplywy">Przepływy i możliwe wypłaty</h2>
          <p className="muted">
            Łącznie {fmtPln(sum(rows.map((row) => row.valuePln ?? 0)))} w {rows.length} operacjach
            {unvalued > 0 && ` (${unvalued} bez wyceny — brak kursu)`}. <LayerTag layer="inference" />
          </p>
        </div>
      </header>
      <div className="two-columns">
        <div className="card">
          <h3>Wypłaty w PLN na rok podatkowy</h3>
          <BarChart title="Szacowane wypłaty w PLN na rok podatkowy w podziale na rodzaje" categories={series.years} series={series.series.map((item) => ({ key: item.kind, label: item.label, values: item.values }))} />
        </div>
        <div className="card">
          <h3>Dokąd płyną środki</h3>
          <SankeyChart title="Przepływ wartości: adresy podmiotu, kontrahenci, lata podatkowe" nodes={flows.nodes} links={flows.links} columns={['Adres podmiotu', 'Kontrahent / serwis', 'Rok podatkowy']} />
        </div>
      </div>
      <div className="card">
        <h3>Tabela wypłat</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                {header('time', 'Data')}
                {header('kind', 'Rodzaj')}
                <th scope="col">Adres podmiotu</th>
                <th scope="col">Kontrahent</th>
                <th scope="col" className="num">Kwota</th>
                {header('valuePln', 'Wartość w PLN', true)}
                <th scope="col">Weryfikacja</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((row) => (
                <tr key={`${row.txid}-${row.kind}`}>
                  <td>{fmtDateTime(row.time)}</td>
                  <td>
                    <strong>{CASH_OUT_LABEL[row.kind] ?? row.kind}</strong>
                    <span className="cell-note">{row.explanation}</span>
                  </td>
                  <td>
                    <ShortAddress value={row.address} />
                  </td>
                  <td>
                    {row.counterpartyLabel && <span className="counterparty-label">{row.counterpartyLabel} </span>}
                    <ShortAddress value={row.counterparty} />
                  </td>
                  <td className="num">{fmtAmount(row.amount, row.asset)}</td>
                  <td className="num">
                    {row.valuePln === undefined ? <span className="muted">brak kursu</span> : <strong>{fmtPln(row.valuePln)}</strong>}
                    {row.valuation && (
                      <details className="why">
                        <summary>jak wyceniono</summary>
                        <span className="cell-note">{row.valuation}</span>
                      </details>
                    )}
                  </td>
                  <td>
                    <ExternalLink url={row.explorerUrl}>eksplorator</ExternalLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

// ---------- Oś czasu ----------

function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (!next.delete(value)) next.add(value);
  return next;
}

/** Pas przeglądowy: każde zdarzenie jako kreska na wspólnej osi czasu. */
function TimelineStrip({ events }: { events: TimelineEvent[] }) {
  const width = 960;
  const x = timeScale(events.map((event) => event.time), [16, width - 16]);
  const years = [...new Set(events.map((event) => yearOf(event.time)))];
  return (
    <svg className="timeline-strip" viewBox={`0 0 ${width} 58`} role="img" aria-label={`Rozkład ${events.length} zdarzeń w czasie, lata ${years[0]}–${years.at(-1)}`}>
      <line className="chart-grid" x1={16} x2={width - 16} y1={34} y2={34} />
      {years.map((year) => (
        <text key={year} className="chart-tick" x={x(`${year}-07-01T00:00:00Z`)} y={54} textAnchor="middle">
          {year}
        </text>
      ))}
      {events.map((event, index) => (
        <line key={index} className={`strip-mark kind-${event.kind}`} x1={x(event.time)} x2={x(event.time)} y1={event.kind === 'cash_out' ? 8 : 18} y2={34}>
          <title>{`${fmtDate(event.time)} · ${event.title}`}</title>
        </line>
      ))}
    </svg>
  );
}

export function TimelineTab() {
  const { dossier } = useDossier();
  const [kinds, setKinds] = useState(new Set(TIMELINE_KINDS));
  const [layers, setLayers] = useState(new Set<Layer>(LAYER_KEYS));
  const events = dossier.timeline.filter((event) => kinds.has(event.kind) && layers.has(toLayer(event.layer)));
  const years = [...new Set(events.map((event) => yearOf(event.time)))].sort().reverse();
  if (dossier.timeline.length === 0) return <EmptyState title="Brak zdarzeń na osi czasu">Zdarzenia pochodzą z dat publikacji i z przelewów adresów powiązanych.</EmptyState>;

  return (
    <section aria-labelledby="os-czasu">
      <header className="section-head">
        <div>
          <h2 id="os-czasu">Oś czasu</h2>
          <p className="muted">
            Pokazano {events.length} z {dossier.timeline.length} zdarzeń; najnowsze u góry.
          </p>
        </div>
      </header>
      <div className="card">
        <fieldset className="filters">
          <legend>Rodzaj zdarzenia</legend>
          {TIMELINE_KINDS.filter((kind) => dossier.timeline.some((event) => event.kind === kind)).map((kind) => (
            <label key={kind} className={`filter-chip kind-${kind}`}>
              <input type="checkbox" checked={kinds.has(kind)} onChange={() => setKinds(toggle(kinds, kind))} />
              {TIMELINE_KIND_LABEL[kind]}
            </label>
          ))}
        </fieldset>
        <fieldset className="filters">
          <legend>Warstwa informacji</legend>
          {LAYER_KEYS.map((layer) => (
            <label key={layer} className="filter-chip">
              <input type="checkbox" checked={layers.has(layer)} onChange={() => setLayers(toggle(layers, layer))} />
              {layerLabel(layer)}
            </label>
          ))}
        </fieldset>
        {events.length > 0 && <TimelineStrip events={events} />}
      </div>
      {events.length === 0 && <EmptyState title="Żadne zdarzenie nie spełnia filtrów">Zaznacz więcej rodzajów zdarzeń lub warstw.</EmptyState>}
      {years.map((year) => {
        const inYear = events.filter((event) => yearOf(event.time) === year).reverse();
        const value = sum(inYear.map((event) => event.valuePln ?? 0));
        return (
          <section key={year} className="card timeline-year" aria-label={`Rok ${year}`}>
            <h3>
              {year} <span className="muted">· {inYear.length} zdarzeń{value > 0 && ` · możliwe wypłaty ${fmtPln(value)}`}</span>
            </h3>
            <ol className="events">
              {inYear.map((event, index) => (
                <li key={index} className={`event kind-${event.kind}`}>
                  <time dateTime={event.time}>{fmtDateTime(event.time)}</time>
                  <div>
                    <p className="event-title">
                      <span className="event-kind">{TIMELINE_KIND_LABEL[event.kind] ?? event.kind}</span> {event.title}
                      {event.valuePln !== undefined && <strong> · {fmtPln(event.valuePln)}</strong>}
                    </p>
                    <p className="event-meta">
                      <LayerTag layer={toLayer(event.layer)} />
                      {event.detail && <span className="muted">{event.detail}</span>}
                      {event.address && <ShortAddress value={event.address} />}
                      {event.url && <ExternalLink url={event.url}>źródło</ExternalLink>}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
}

// ---------- Osoby powiązane ----------

function PersonItem({ person }: { person: RelatedPerson & { caseId?: string } }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function openCase() {
    setBusy(true);
    try {
      const created = await api.createCase(person.handle, [
        { type: 'nick', value: person.handle },
        ...person.profileUrls.map((value) => ({ type: 'profile_url' as const, value })),
      ]);
      toast.success(`Założono sprawę „${created.name}”.`);
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  }

  return (
    <article className="card person-card">
      <header className="profile-head">
        <Initial name={person.handle} />
        <div>
          <h3>{person.handle}</h3>
          <p className="muted">{person.services.join(', ')}</p>
        </div>
        <div className="service-strength">
          <Score value={person.strength} kind="strength" caption="siła powiązania" />
        </div>
      </header>
      <ul className="plain-list">
        {person.relations.map((relation) => (
          <li key={relation.description}>
            <span className="chip">{RELATION_LABEL[relation.kind] ?? relation.kind}</span> {relation.description}{' '}
            <span className="muted">(przez: {relation.via.length > 30 ? shorten(relation.via) : relation.via})</span>
          </li>
        ))}
      </ul>
      <p>
        {person.profileUrls.map((url) => (
          <span key={url}>
            <ExternalLink url={url} />{' '}
          </span>
        ))}
      </p>
      {person.caseId ? (
        <a className="button" href={href.case(person.caseId)}>
          Otwórz sprawę tej osoby
        </a>
      ) : (
        <button type="button" className="button" onClick={openCase} disabled={busy}>
          {busy ? 'Zakładanie…' : 'Załóż sprawę dla tej osoby'}
        </button>
      )}
    </article>
  );
}

export function PeopleTab() {
  const { dossier } = useDossier();
  const people = [...dossier.relatedPersons].sort((a, b) => b.strength - a.strength);
  return (
    <section aria-labelledby="osoby">
      <header className="section-head">
        <div>
          <h2 id="osoby">Osoby powiązane ({people.length})</h2>
          <p className="muted">
            <LayerTag layer="inference" /> Powiązane osoby są wskazówką do weryfikacji, nigdy ustaleniem.
          </p>
        </div>
      </header>
      {people.length === 0 ? (
        <EmptyState title="Nie wykryto osób powiązanych">Powiązania powstają ze wspólnych adresów, bezpośrednich przelewów, wspólnych kontrahentów i cech profili.</EmptyState>
      ) : (
        <div className="card-grid">
          {people.map((person) => (
            <PersonItem key={person.id} person={person} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- Rejestr decyzji ----------

export function DecisionsTab() {
  const { dossier, tabHref } = useDossier();
  const all = dossier.decisions as DecisionRecord[];
  const withdrawn = all.filter(isWithdrawn).length;
  return (
    <section aria-labelledby="decyzje">
      <header className="section-head">
        <div>
          <h2 id="decyzje">Rejestr decyzji analityka ({all.length - withdrawn})</h2>
          <p className="muted">
            Historia zmian: każda decyzja zostaje w rejestrze z czasem, autorem i notatką. Wycofanie przywraca wynik automatyczny, a wycofana decyzja
            pozostaje widoczna{withdrawn > 0 && ` (wycofane: ${withdrawn})`}.
          </p>
        </div>
        <a className="button button-quiet" href={tabHref('do-potwierdzenia')}>
          Co czeka na decyzję →
        </a>
      </header>
      {all.length === 0 ? (
        <EmptyState title="Brak decyzji — wynik jest w całości automatyczny">
          Korekty są opcjonalne. Można je wprowadzić na kartach profili i adresów, w panelu grafu, przy hipotezach wspólnego operatora (sekcja
          „Wskaźniki”) albo w sekcji „Ślady prawdopodobnie należące do innej osoby”.
        </EmptyState>
      ) : (
        <div className="card">
          <h3>Historia zmian</h3>
          <DecisionHistory />
        </div>
      )}
    </section>
  );
}
