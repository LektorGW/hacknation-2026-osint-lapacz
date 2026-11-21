// „Ustalenie”: główny kandydat na rzeczywistą osobę oraz ślady należące prawdopodobnie do innych osób.
import type { Dossier, PersonCandidate, ProfileCard } from '@olcys/core';
import { addressKey, jointProbability } from '../dossier.ts';
import { IDENTIFIER_LABEL } from '../labels.ts';
import { mentionServices } from '../funds.ts';
import { proofSummary } from '../proof.ts';
import { identityHeadline, likelySameTotal } from '../identities.ts';
import { fmtPln, shorten, sum } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import { DualScore, Gauge, Initial, LayerTag, ScoreBadge, toLayer } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { ServiceChips } from './ServiceCards.tsx';
import { AddressSummary, isAddressCase } from './AddressSummary.tsx';
import { UnconfirmedAddresses } from './Explanations.tsx';

const ATTRIBUTE_LABEL: Record<PersonCandidate['attributes'][number]['kind'], string> = {
  email: 'E-mail',
  phone: 'Telefon',
  location: 'Lokalizacja',
  website: 'Strona',
  handle: 'Nick',
  organization: 'Organizacja',
  registry_entry: 'Wpis w rejestrze',
};

function profilesOf(dossier: Dossier, person: PersonCandidate): ProfileCard[] {
  return person.profileIds.flatMap((id) => dossier.profiles.find((profile) => profile.id === id) ?? []);
}

function ProfileMini({ profile }: { profile: ProfileCard }) {
  return (
    <li className="mini" title={`${profile.service}${profile.handle ? ` · ${profile.handle}` : ''} — pewność tożsamości profilu ${profile.identityScore}%`}>
      <Initial name={profile.service} />
      <span className="mini-text">
        <span className="mini-title">{profile.service}</span>
        <span className="mini-sub">{profile.handle ?? 'bez nazwy konta'}</span>
      </span>
      <ScoreBadge score={profile.identityScore} />
    </li>
  );
}

function Attributes({ person }: { person: PersonCandidate }) {
  if (person.attributes.length === 0) return <p className="muted">Źródła nie ujawniają cech tej osoby.</p>;
  return (
    <dl className="attributes">
      {person.attributes.map((attribute) => (
        <div key={`${attribute.kind}-${attribute.value}`}>
          <dt>{ATTRIBUTE_LABEL[attribute.kind] ?? attribute.kind}</dt>
          <dd>
            <span className="attribute-value">{attribute.value}</span>
            <span className="attribute-sources" title={attribute.sources.join(', ')}>
              {attribute.sources.length} {attribute.sources.length === 1 ? 'źródło' : 'źródła'}: {attribute.sources.join(', ')}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Karta głównego kandydata — całe ustalenie widoczne bez przewijania. */
export function Determination() {
  const { dossier } = useDossier();
  return isAddressCase(dossier) ? <AddressSummary /> : <PersonDetermination />;
}

function PersonDetermination() {
  const { dossier, tabHref } = useDossier();
  const person = dossier.persons[0];
  const { totals, keyFindings } = dossier;
  const strongest = proofSummary(dossier.cashOutProof ?? []).strongest;
  const mentions = (dossier.mentions ?? []).filter((item) => item.documents > 0 || item.note);
  const headline = identityHeadline(dossier.linkedIdentities ?? []);
  const withLikelySame = likelySameTotal(totals);
  const total = (totals as { cashOutPlnTotal?: number }).cashOutPlnTotal ?? sum(Object.values(totals.cashOutPlnByYear));

  return (
    <section className="determination card" aria-labelledby="ustalenie">
      <header className="determination-head">
        <h2 id="ustalenie">Ustalenie</h2>
        <LayerTag layer="inference" />
        <span className="muted">wynik automatycznego łączenia profili — bez udziału analityka</span>
      </header>

      {dossier.summary && (
        <p className="ai-summary">
          {dossier.summary.text}
          <span className="muted">
            Streszczenie wygenerowane przez model z ustaleń poniżej · {dossier.summary.model} · wersja polecenia {dossier.summary.promptVersion}
          </span>
        </p>
      )}
      {headline.length > 0 && (
        <p className="identities-short">
          <LayerTag layer="inference" /> <strong>Możliwe inne tożsamości:</strong> {headline.join('; ')}. <a href={tabHref('tozsamosci')}>Ścieżki dojścia i dowody</a>
        </p>
      )}
      {strongest && (
        <p className="strongest-proof">
          <LayerTag layer={toLayer(strongest.layer)} /> <strong>Najmocniejszy dowód spieniężenia:</strong> {strongest.statement}{' '}
          <a href={tabHref('dowod')}>Ścieżka krok po kroku</a>
        </p>
      )}

      <UnconfirmedAddresses compact />

      <div className="determination-grid">
        <div className="determination-person">
          {person ? (
            <>
              <Gauge value={person.probability} label="prawdopodobieństwo, że to osoba, której dotyczy sprawa" size={132} />
              <div>
                <p className="person-name">{person.fullName ?? 'Imię i nazwisko: nie ustalono — źródła nie ujawniają'}</p>
                {person.nameVariants.length > 0 && (
                  <p className="muted person-variants">występuje też jako: {person.nameVariants.join(', ')}</p>
                )}
                <ul className="reasons">
                  {person.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </>
          ) : (
            <p className="person-name">Nie ustalono osoby — w źródłach nie znaleziono profili ani adresów.</p>
          )}
        </div>

        {person && (
          <div className="determination-facts">
            <h3>Cechy ustalone ze źródeł</h3>
            <Attributes person={person} />
            <h3>Profile zaliczone do osoby ({person.profileIds.length})</h3>
            <ul className="mini-list">
              {profilesOf(dossier, person).map((profile) => (
                <ProfileMini key={profile.id} profile={profile} />
              ))}
            </ul>
          </div>
        )}

        <div className="determination-money">
          <h3>Adresy przypisane osobie ({person?.addresses.length ?? 0})</h3>
          {person && person.addresses.length > 0 ? (
            <ul className="address-list">
              {person.addresses.map((item) => {
                const finding = dossier.findings.find((candidate) => addressKey(candidate) === item.key);
                return (
                  <li key={item.key}>
                    <span className="chip chip-network">{finding ? NETWORK_SHORT[finding.network] : item.key.split(':')[0]}</span>
                    <code className="mono" title={finding?.address}>
                      {shorten(finding?.address ?? item.key.split(':').slice(1).join(':'), 7, 5)}
                    </code>
                    <DualScore joint={finding ? (jointProbability(dossier, finding) ?? item.probability) : item.probability} score={finding?.confidence.score ?? 0} excluded={finding?.confidence.excluded} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="muted">Brak adresów przypisanych osobie.</p>
          )}
          <h3>Giełdy i portfele</h3>
          <ServiceChips />
          <div className="determination-totals">
            <Gauge value={totals.priority} label="priorytet sprawy" unit="" size={84} />
            <div>
              <p className="total-value">{total > 0 ? fmtPln(total) : 'brak oznak wypłat'}</p>
              <p className="muted">szacowane wypłaty na waluty tradycyjne</p>
              {withLikelySame !== undefined && (
                <p
                  className="total-combined"
                  title="Suma wypłat podmiotu powiększona o wypłaty tożsamości z mocną hipotezą wspólnego operatora. Nie jest ustaleniem — liczby łączą się dopiero po scaleniu przez analityka."
                >
                  <strong>{fmtPln(withLikelySame)}</strong> łącznie z tożsamościami z hipotezą wspólnego operatora
                </p>
              )}
              <details className="why">
                <summary>Skąd priorytet {totals.priority}/100</summary>
                <ul>
                  {totals.priorityReasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </details>
            </div>
          </div>
        </div>
      </div>

      {mentions.length > 0 && (
        <div className="key-findings">
          <h3>Wzmianki innych osób (niewliczone)</h3>
          <ul className="plain-list">
            {mentions.map((item, index) => {
              const services = mentionServices(item.services);
              return (
                <li key={`${item.identifier.type}-${item.identifier.value}-${index}`}>
                  <strong>{item.identifier.value}</strong> <span className="muted">({IDENTIFIER_LABEL[item.identifier.type] ?? item.identifier.type})</span>: {item.documents}{' '}
                  dokumentów, {item.authors} autorów
                  {services.names.length > 0 ? ` · ${services.names.join(', ')}` : services.count > 0 ? ` · serwisy: ${services.count}` : ''} — inni piszą o tym
                  identyfikatorze; treści nie podnoszą wyniku.
                  {item.note && <span className="mention-note">Adnotacja: {item.note}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {keyFindings.length > 0 && (
        <div className="key-findings">
          <h3>Kluczowe ustalenia</h3>
          <ol>
            {keyFindings.map((item) => (
              <li key={item.text} className={`key-finding layer-${toLayer(item.layer)}`}>
                <LayerTag layer={toLayer(item.layer)} />
                <span>{item.text}</span>
              </li>
            ))}
          </ol>
          <p className="muted">
            Szczegóły: <a href={tabHref('profile')}>profile</a>, <a href={tabHref('adresy')}>adresy</a>,{' '}
            <a href={tabHref('przeplywy')}>przepływy</a>.
          </p>
        </div>
      )}
    </section>
  );
}

/** Kandydaci inni niż główny: ślady, które narzędzie rozdzieliło jako należące do innej osoby. */
export function OtherCandidates() {
  const { dossier, decide } = useDossier();
  const others = dossier.persons.slice(1);
  if (others.length === 0) return null;

  const decideAll = async (person: PersonCandidate, decision: 'confirmed' | 'rejected') => {
    for (const profile of profilesOf(dossier, person)) {
      await decide('profile', profile.id, decision, decision === 'confirmed' ? 'Ta sama osoba' : 'Inna osoba');
    }
  };

  return (
    <details className="card others">
      <summary>
        Ślady prawdopodobnie należące do innej osoby ({others.length}) <LayerTag layer="inference" />
      </summary>
      <div className="others-grid">
        {others.map((person) => (
          <article key={person.id} className="other">
            <header>
              <ScoreBadge score={person.probability} title="Prawdopodobieństwo, że to osoba, której dotyczy sprawa" />
              <h3>{person.fullName ?? person.nameVariants[0] ?? 'Osoba nieustalona'}</h3>
            </header>
            <ul className="reasons">
              {person.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <ul className="mini-list">
              {profilesOf(dossier, person).map((profile) => (
                <ProfileMini key={profile.id} profile={profile} />
              ))}
            </ul>
            {person.addresses.length > 0 && (
              <p className="muted">
                Adresy niewliczone do osoby głównej:{' '}
                {person.addresses.map((item) => shorten(item.key.split(':').slice(1).join(':'))).join(', ')}
              </p>
            )}
            <div className="actions">
              <button type="button" className="button button-small" onClick={() => decideAll(person, 'confirmed')}>
                Potwierdź: to ślady podmiotu
              </button>
              <button type="button" className="button button-small" onClick={() => decideAll(person, 'rejected')}>
                Rozdziel (usuń ślady ze sprawy)
              </button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}
