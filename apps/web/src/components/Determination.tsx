// „Ustalenie”: główny kandydat na rzeczywistą osobę oraz ślady należące prawdopodobnie do innych osób.
import type { Dossier, PersonCandidate, ProfileCard } from '@olcys/core';
import { addressKey, jointProbability } from '../dossier.ts';
import { IDENTIFIER_LABEL } from '../labels.ts';
import { mentionServices } from '../funds.ts';
import { proofSummary } from '../proof.ts';
import { identityHeadline, likelySameTotal } from '../identities.ts';
import { fmtPln, shorten, sum } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import type { ServiceReplyRef } from '../service-reply.ts';
import { Initial, LayerTag, ScoreBadge, toLayer } from './common.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';
import { ExternalDocTag } from './ServiceReplies.tsx';
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

/** Odpowiedź usługi, która potwierdziła kandydata (pole lokalne teczki, poza kontraktem core). */
const replyRef = (person: PersonCandidate | undefined): ServiceReplyRef | undefined => (person as (PersonCandidate & { confirmedByReply?: ServiceReplyRef }) | undefined)?.confirmedByReply;
const contradictionsOf = (person: PersonCandidate): string[] => (person as PersonCandidate & { replyContradictions?: string[] }).replyContradictions ?? [];

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
  const { totals } = dossier;
  const strongest = proofSummary(dossier.cashOutProof ?? []).strongest;
  const mentions = (dossier.mentions ?? []).filter((item) => item.documents > 0 || item.note);
  const headline = identityHeadline(dossier.linkedIdentities ?? []);
  const withLikelySame = likelySameTotal(totals);
  const total = (totals as { cashOutPlnTotal?: number }).cashOutPlnTotal ?? sum(Object.values(totals.cashOutPlnByYear));

  return (
    <section className="determination card" aria-labelledby="ustalenie">
      <header className="determination-head">
        <h2 id="ustalenie">Ustalenie osoby</h2>
        {replyRef(person) ? (
          <span className="status status-external">potwierdzone odpowiedzią usługi</span>
        ) : person?.status === 'confirmed' ? (
          <span className="status status-ok">potwierdzone przez analityka</span>
        ) : (
          <span className="status status-inference">
            <Term id="hipoteza">hipoteza</Term> — wynik automatycznego łączenia profili
          </span>
        )}
      </header>

      {person && replyRef(person) && (
        <p className="reply-banner is-confirmed" role="note">
          <ExternalDocTag short /> <strong>Tożsamość potwierdzona odpowiedzią usługi {replyRef(person)!.serviceName}</strong> (sygn. {replyRef(person)!.reference}).
          To <Term id="odpowiedz-uslugi">dokument spoza OSINT</Term> wprowadzony przez analityka — narzędzie nie weryfikuje jego autentyczności.{' '}
          <a href={tabHref('uslugi')}>Treść odpowiedzi →</a>
        </p>
      )}
      {person &&
        contradictionsOf(person).map((text) => (
          <p key={text} className="reply-banner is-contradiction" role="alert">
            <ExternalDocTag short /> <strong>Według odpowiedzi usługi konto należy do innej osoby.</strong> {text} <a href={tabHref('uslugi')}>Treść odpowiedzi →</a>
          </p>
        ))}
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
              <div>
                <p className="person-name">{person.fullName ?? 'Imię i nazwisko: nie ustalono — źródła nie ujawniają'}</p>
                <Score
                  value={person.probability}
                  kind="person"
                  size="lg"
                  reasons={person.reasons.filter((reason) => !contradictionsOf(person).includes(reason))}
                  caption={<Term id="pewnosc-osoby">pewność, że to osoba ze sprawy</Term>}
                />
                {person.nameVariants.length > 0 && (
                  <p className="muted person-variants">występuje też jako: {person.nameVariants.join(', ')}</p>
                )}
                <Disclosure title="Dlaczego ta osoba" meta={person.reasons.length}>
                  <ul className="reasons">
                    {person.reasons.filter((reason) => !contradictionsOf(person).includes(reason)).map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </Disclosure>
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
                    <Score value={finding ? (jointProbability(dossier, finding) ?? item.probability) : item.probability} kind="joint" size="sm" ledger={finding?.confidence.ledger} excluded={finding?.confidence.excluded} />
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
            <div>
              <p className="total-value tabular">{total > 0 ? fmtPln(total) : 'brak oznak wypłat'}</p>
              <p className="muted">
                szacowane wypłaty na waluty tradycyjne (<Term id="wycena">szacunek</Term>)
              </p>
              {withLikelySame !== undefined && (
                <p
                  className="total-combined"
                  title="Suma wypłat podmiotu powiększona o wypłaty tożsamości z mocną hipotezą wspólnego operatora. Nie jest ustaleniem — liczby łączą się dopiero po scaleniu przez analityka."
                >
                  <strong>{fmtPln(withLikelySame)}</strong> łącznie z tożsamościami z <Term id="hipoteza-operatora">hipotezą wspólnego operatora</Term>
                </p>
              )}
              <Score value={totals.priority} kind="priority" reasons={totals.priorityReasons} caption="priorytet sprawy" />
            </div>
          </div>
        </div>
      </div>

      {mentions.length > 0 && (
        <Disclosure title="Wzmianki innych osób (niewliczone do wyniku)" meta={mentions.length} className="mentions">
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
        </Disclosure>
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
