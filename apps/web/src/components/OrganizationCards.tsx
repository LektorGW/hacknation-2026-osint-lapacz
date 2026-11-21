// Organizacja (beneficjent zbiórki), osoby w rolach z rejestrów publicznych i siatka adresu.
// Zasada: osoba w roli to osoba odpowiedzialna za organizację, nie właściciel adresu; wpłacający nie są osobami.
import { useDossier } from './DossierContext.tsx';
import { ExternalLink, ShortAddress } from './common.tsx';
import { StatusBadge } from './Indicators.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';
import { fmtAmount, fmtPlnCompact } from '../format.ts';
import { rolesByOrganization, shareText } from '../organizations.ts';
import type { AddressNetwork, DossierOrganization } from '../organizations.ts';

function OrganizationBlock({ org }: { org: DossierOrganization }) {
  return (
    <article className="card organization-card" aria-label={`Organizacja ${org.name}`}>
      <header className="section-head">
        <div>
          <p className="eyebrow">
            Organizacja · <Term id="beneficjent">{org.role}</Term>
          </p>
          <h3>
            {org.name}
            {org.domain ? <span className="muted"> ({org.domain})</span> : null} <StatusBadge status="hypothesis" />
          </h3>
        </div>
        <Score value={org.indicator} kind="strength" caption={<Term id="beneficjent">wskaźnik beneficjenta</Term>} reasons={org.components.map((item) => `${item.delta > 0 ? '+' : ''}${item.delta} ${item.rule}: ${item.explanation}`)} />
      </header>
      <p>{org.statement}</p>
      {org.officialSite && (
        <p className="small">
          Strona organizacji: <ExternalLink url={org.officialSite.url}>{org.officialSite.url}</ExternalLink> — {org.officialSite.note}
        </p>
      )}
      <Disclosure title="Skąd wskaźnik — reguły" meta={org.components.length}>
        <ul className="plain-list">
          {org.components.map((item) => (
            <li key={item.rule}>
              <strong>
                {item.delta > 0 ? '+' : ''}
                {item.delta}
              </strong>{' '}
              <code>{item.rule}</code> — {item.explanation}
            </li>
          ))}
        </ul>
      </Disclosure>
      <Disclosure title="Publikacje wskazujące organizację" meta={org.evidence.length}>
        <ul className="plain-list">
          {org.evidence.map((item) => (
            <li key={item.url}>
              <ExternalLink url={item.url}>{item.author ? `${item.author} · ${item.service}` : item.service}</ExternalLink>
              <br />
              <span className="muted small">„{item.quote.slice(0, 220)}”</span>
            </li>
          ))}
        </ul>
      </Disclosure>
      <ul className="muted small">
        {org.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </article>
  );
}

/** Treść kafla „Kto to prawdopodobnie jest”, gdy nie wskazano osoby, ale wskazano organizację. */
export function OrganizationTile({ org }: { org: DossierOrganization }) {
  return (
    <>
      <p className="answer-value">Organizacja: {org.name}</p>
      <span className="status status-inference">
        {org.role === 'beneficjent zbiórki' ? 'adres zbiórki' : 'adres płatności'} · <Term id="hipoteza">hipoteza</Term>
        {org.officialSite?.publishesAddress ? ' · potwierdzone na stronie organizacji' : ''}
      </span>
      <Score value={org.indicator} kind="strength" reasons={org.components.map((item) => `${item.delta > 0 ? '+' : ''}${item.delta}: ${item.explanation}`)} caption={<Term id="beneficjent">beneficjent</Term>} />
      <p className="muted small">Organizacja, nie osoba — Wskaźnik Pewności dla osoby 0% (znany adres zbiórki).</p>
    </>
  );
}

/** Karta „Organizacje i osoby odpowiedzialne” — sekcja „Osoba i konta”. */
export function OrganizationsCard() {
  const { dossier } = useDossier();
  const organizations = dossier.organizations ?? [];
  const network = dossier.organizationNetwork;
  if (organizations.length === 0 && !network?.organizations.length) return null;
  return (
    <section className="card organizations" aria-labelledby="organizacje-tytul">
      <h2 id="organizacje-tytul">Organizacje i osoby odpowiedzialne</h2>
      <p className="muted small">
        Organizacja wskazana przez treść wokół adresu to hipoteza. Osoby poniżej pełnią role według rejestrów publicznych — są{' '}
        <Term id="osoba-w-roli">osobami odpowiedzialnymi za organizację</Term>, a nie właścicielami adresu.
      </p>
      {organizations.map((org) => (
        <OrganizationBlock key={org.name} org={org} />
      ))}
      {network && network.organizations.length > 0 && (
        <>
          <h3>Rejestry publiczne</h3>
          {rolesByOrganization(network).map(({ organization, persons }) => (
            <article key={organization.id} className="card org-registry">
              <h4>
                {organization.name} <StatusBadge status={organization.match === 'name_only' ? 'hypothesis' : 'source_fact'} />
              </h4>
              <p className="muted small">{organization.matchNote}</p>
              {persons.length > 0 ? (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Osoba</th>
                      <th>Rola</th>
                      <th>Okres</th>
                      <th>Źródło</th>
                    </tr>
                  </thead>
                  <tbody>
                    {persons.map((person) => (
                      <tr key={person.id}>
                        <td>
                          {person.name}
                          {person.masked && <span className="muted small"> (zamaskowane przez rejestr)</span>}
                          {person.publicProfiles?.map((profile) => (
                            <div key={profile.url} className="small">
                              profil publiczny osoby: <ExternalLink url={profile.url}>{profile.service}</ExternalLink>
                            </div>
                          ))}
                        </td>
                        <td>{person.role}</td>
                        <td>{[person.from, person.to].filter(Boolean).join(' – ') || '—'}</td>
                        <td>
                          <ExternalLink url={person.source.url}>{person.source.registry}</ExternalLink>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">Rejestr nie podaje osób w rolach dla tego podmiotu.</p>
              )}
              {organization.weakCandidates?.map((item) => (
                <p key={item.url} className="muted small">
                  Wpis zgodny tylko nazwą (niescalony): <ExternalLink url={item.url}>{`${item.registry}: ${item.name} (${item.identifier})`}</ExternalLink> — {item.note}
                </p>
              ))}
            </article>
          ))}
          {network.relations.length > 0 && (
            <Disclosure title="Relacje między organizacjami" meta={network.relations.length}>
              <ul className="plain-list">
                {network.relations.map((relation, index) => (
                  <li key={index}>
                    {relation.explanation} <StatusBadge status={relation.status} />
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
          <Disclosure title="Granice rozszerzania i uwagi" meta={network.stops.length}>
            <ul className="plain-list small">
              {[...network.stops.map((stop) => stop.detail), ...network.notes].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Disclosure>
        </>
      )}
    </section>
  );
}

function NetworkBlock({ network }: { network: AddressNetwork }) {
  const points = [...network.incoming.inquiryPoints, ...network.outgoing.inquiryPoints];
  return (
    <article className="card address-network" aria-label={`Siatka adresu ${network.address}`}>
      <h3>
        <ShortAddress value={network.address} />
      </h3>
      <dl className="facts">
        <div>
          <dt>Wpływy</dt>
          <dd>
            {network.incoming.transfers} od {network.incoming.counterparties} nadawców · {fmtAmount(network.incoming.amount, network.asset)} · z usług {shareText(network.incoming.serviceShare)}
          </dd>
        </div>
        <div>
          <dt>Wypływy</dt>
          <dd>
            {network.outgoing.transfers} do {network.outgoing.counterparties} odbiorców · {fmtAmount(network.outgoing.amount, network.asset)} · do usług {shareText(network.outgoing.serviceShare)}
          </dd>
        </div>
        <div>
          <dt>Ten sam portfel</dt>
          <dd>
            {network.cluster.sameWallet} adresów (heurystyka){network.cluster.coDepositors > 0 ? ` · współwpłacający ${network.cluster.coDepositors}` : ''}
          </dd>
        </div>
      </dl>
      {points.length > 0 && (
        <>
          <h4>Punkty zapytania</h4>
          <ul className="plain-list">
            {points.map((point) => (
              <li key={`${point.direction}-${point.service}`}>
                {point.note}
                {point.valuePln !== undefined && point.direction === 'in' ? ` (${fmtPlnCompact(point.valuePln)})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      <Disclosure title="Najwięksi nadawcy (adresy, nie osoby)" meta={network.incoming.top.length}>
        <table className="table">
          <thead>
            <tr>
              <th>Adres</th>
              <th>Przelewy</th>
              <th>Kwota</th>
              <th>Usługa</th>
            </tr>
          </thead>
          <tbody>
            {network.incoming.top.map((item) => (
              <tr key={item.address}>
                <td>
                  <ShortAddress value={item.address} />
                </td>
                <td>{item.transfers}</td>
                <td>{fmtAmount(item.amount, item.asset)}</td>
                <td>{item.service ?? (item.checkedInPublications ? 'bez etykiety · sprawdzony w publikacjach' : 'bez etykiety')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>
      <ul className="muted small">
        {network.statements.slice(-2).map((line) => (
          <li key={line}>{line}</li>
        ))}
        <li>{network.privacyNote}</li>
      </ul>
    </article>
  );
}

/** Karta „Siatka adresu” — sekcja „Adresy”. */
export function AddressNetworkCard() {
  const { dossier } = useDossier();
  const networks = dossier.addressNetwork ?? [];
  if (networks.length === 0) return null;
  return (
    <section className="card address-networks" aria-labelledby="siatka-tytul">
      <h2 id="siatka-tytul">
        <Term id="siatka-adresu">Siatka adresu</Term>
      </h2>
      <p className="muted small">Kto wpłacał i dokąd wypływały środki — zbiorczo, z pobranej historii blockchain. Wpłacający to darczyńcy lub klienci, nie konta właściciela.</p>
      {networks.map((network) => (
        <NetworkBlock key={network.address} network={network} />
      ))}
    </section>
  );
}
