// Powiązania podmiotu z giełdami, portfelami i innymi usługami: żetony w nagłówku i pełne karty usług.
import type { ServiceLink } from '@olcys/core';
import { api, serviceRequestUrl } from '../api.ts';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln, fmtPlnCompact } from '../format.ts';
import { BASIS_LABEL, NETWORK_LABEL, SERVICE_KIND_LABEL } from '../labels.ts';
import { useAsync } from '../useAsync.ts';
import { Bar, CopyButton, EmptyState, ExternalLink, Initial, LayerSection, LayerTag, ShortAddress } from './common.tsx';
import { useDossier } from './DossierContext.tsx';

export const serviceAnchor = (id: string) => `usluga-${id}`;

const amountLabel = (link: ServiceLink) =>
  link.outPln !== undefined || link.inPln !== undefined
    ? fmtPlnCompact((link.outPln ?? 0) + (link.inPln ?? 0))
    : link.transfers.length > 0
      ? `${link.transfers.length} przel.`
      : 'wzmianka';

/** Rząd żetonów usług — powiązania z giełdami widoczne w pierwszej sekundzie. */
export function ServiceChips() {
  const { dossier, tabHref } = useDossier();
  if (dossier.serviceLinks.length === 0) return <p className="muted">Nie stwierdzono powiązań z giełdami ani portfelami.</p>;
  return (
    <ul className="service-chips">
      {dossier.serviceLinks.map((link) => (
        <li key={link.id}>
          <a
            className={`service-chip kind-${link.kind} ${link.inferredOnly ? 'is-inferred' : ''}`}
            href={tabHref('uslugi')}
            title={`${SERVICE_KIND_LABEL[link.kind]} · siła powiązania ${link.strength}/100${link.inferredOnly ? ' · wyłącznie wnioskowanie' : ''}`}
          >
            <Initial name={link.name} tone={`kind-${link.kind}`} />
            <span className="service-chip-name">{link.name}</span>
            <span className="service-chip-amount">{amountLabel(link)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Sumy przelewów w walutach krypto dla jednego kierunku — gdy brak wyceny w PLN. */
function cryptoSums(link: ServiceLink, direction: 'in' | 'out'): string {
  const sums = new Map<string, number>();
  for (const item of link.transfers) {
    if (item.direction === direction) sums.set(item.asset, (sums.get(item.asset) ?? 0) + item.amount);
  }
  return [...sums].map(([asset, amount]) => fmtAmount(amount, asset)).join(', ') || 'brak przelewów';
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <span className="cell-note">{note}</span>}
      </dd>
    </div>
  );
}

function Transfers({ link }: { link: ServiceLink }) {
  const inferred = link.transfers.some((item) => item.viaAddress);
  return (
    <details className="fold">
      <summary>Przelewy ({link.transfers.length})</summary>
      <div className="table-scroll">
        <table className="table table-dense">
          <thead>
            <tr>
              <th scope="col">Data</th>
              <th scope="col">Kierunek</th>
              <th scope="col" className="num">Kwota</th>
              <th scope="col" className="num">Wycena PLN</th>
              <th scope="col">Adres podmiotu</th>
              <th scope="col">Adres usługi</th>
              {inferred && <th scope="col">Adres pośredni (wnioskowanie)</th>}
              <th scope="col">Weryfikacja</th>
            </tr>
          </thead>
          <tbody>
            {link.transfers.map((item) => (
              <tr key={`${item.txid}-${item.direction}`}>
                <td>{fmtDateTime(item.time)}</td>
                <td>{item.direction === 'out' ? '→ do usługi' : '← z usługi'}</td>
                <td className="num">{fmtAmount(item.amount, item.asset)}</td>
                <td className="num">{item.valuePln === undefined ? <span className="muted">brak kursu</span> : fmtPln(item.valuePln)}</td>
                <td>
                  <ShortAddress value={item.subjectAddress} />
                </td>
                <td>
                  <ShortAddress value={item.serviceAddress} />
                </td>
                {inferred && <td>{item.viaAddress ? <ShortAddress value={item.viaAddress} /> : '—'}</td>}
                <td>
                  <ExternalLink url={item.explorerUrl}>eksplorator</ExternalLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="layer-notes">
        <LayerTag layer="fact" /> przelewy z blockchaina · <LayerTag layer="calc" /> wycena w PLN
        {inferred && (
          <>
            {' '}
            · <LayerTag layer="inference" /> przypisanie adresu pośredniego do usługi
          </>
        )}
      </p>
    </details>
  );
}

function RequestHints({ link }: { link: ServiceLink }) {
  const { dossier } = useDossier();
  const available = useAsync(() => api.hasServiceRequest(dossier.runId, link.id), `${dossier.runId}|${link.id}`);
  if (link.requestHints.length === 0) return null;
  return (
    <section className="request">
      <header>
        <h4>O co zapytać tę usługę</h4>
        <div className="actions">
          <CopyButton value={link.requestHints.join('\n')} label={`Kopiuj wszystkie punkty zapytania do ${link.name}`} text="Kopiuj wszystko" />
          {available.data && (
            <a className="button button-small" href={serviceRequestUrl(dossier.runId, link.id)} target="_blank" rel="noopener noreferrer">
              Materiał do zapytania
            </a>
          )}
        </div>
      </header>
      <ul>
        {link.requestHints.map((hint) => (
          <li key={hint}>
            <span>{hint}</span>
            <CopyButton value={hint} label="Kopiuj ten punkt zapytania" />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Karta usługi: podstawa powiązania, kwoty, przelewy, wzmianki i gotowe punkty zapytania. */
export function ServiceCard({ link, compact = false }: { link: ServiceLink; compact?: boolean }) {
  const period = link.firstSeen ? `${fmtDate(link.firstSeen)} – ${fmtDate(link.lastSeen)}` : 'brak przelewów';
  return (
    <article className={`service-card ${compact ? 'is-compact' : 'card'}`} id={compact ? undefined : serviceAnchor(link.id)} tabIndex={-1}>
      <header className="service-head">
        <Initial name={link.name} tone={`kind-${link.kind}`} />
        <div className="service-title">
          <h3>{link.name}</h3>
          <p className="muted">
            {SERVICE_KIND_LABEL[link.kind] ?? link.kind}
            {link.networks.length > 0 && ` · ${link.networks.map((network) => NETWORK_LABEL[network] ?? network).join(', ')}`}
          </p>
        </div>
        <div className="service-strength">
          <span className="muted">siła powiązania</span>
          <Bar value={link.strength} label={`Siła powiązania z ${link.name}`} wide />
        </div>
      </header>

      <p className="basis">
        {link.basis.map((basis) => (
          <span key={basis} className={`chip ${basis === 'deposit_address' ? 'chip-inference' : basis.startsWith('transfer') ? 'chip-fact' : ''}`}>
            {BASIS_LABEL[basis] ?? basis}
          </span>
        ))}
        {link.inferredOnly && <LayerTag layer="inference" />}
      </p>

      <dl className="meta service-stats">
        <Stat label="Okres" value={period} />
        <Stat
          label="Do usługi"
          value={link.outPln === undefined ? cryptoSums(link, 'out') : fmtPln(link.outPln)}
          note={link.transfersOut === 0 ? undefined : `${link.transfersOut} przel.${link.outPln === undefined ? ' · bez wyceny w PLN' : ' · szacunek'}`}
        />
        <Stat
          label="Z usługi"
          value={link.inPln === undefined ? cryptoSums(link, 'in') : fmtPln(link.inPln)}
          note={link.transfersIn === 0 ? undefined : `${link.transfersIn} przel.${link.inPln === undefined ? ' · bez wyceny w PLN' : ' · szacunek'}`}
        />
      </dl>

      <ul className="reasons">
        {link.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>

      <RequestHints link={link} />

      {link.mentions.length > 0 && (
        <LayerSection layer="fact" title={`Wzmianki i konta w publicznych treściach (${link.mentions.length})`}>
          <ul className="plain-list">
            {link.mentions.map((mention) => (
              <li key={`${mention.url}-${mention.excerpt}`}>
                <blockquote className="excerpt">{mention.excerpt}</blockquote>
                <ExternalLink url={mention.url} />
              </li>
            ))}
          </ul>
        </LayerSection>
      )}

      {link.transfers.length > 0 && <Transfers link={link} />}
    </article>
  );
}

export function ServiceList() {
  const { dossier } = useDossier();
  const links = [...dossier.serviceLinks].sort((a, b) => b.strength - a.strength);
  if (links.length === 0) {
    return (
      <EmptyState title="Nie stwierdzono powiązań z giełdami ani portfelami">
        Powiązania powstają z przelewów między adresami podmiotu a adresami usług oraz ze wzmianek w profilach. Dodaj kolejne
        identyfikatory i ponów analizę.
      </EmptyState>
    );
  }
  return (
    <div className="service-list">
      {links.map((link) => (
        <ServiceCard key={link.id} link={link} />
      ))}
    </div>
  );
}
