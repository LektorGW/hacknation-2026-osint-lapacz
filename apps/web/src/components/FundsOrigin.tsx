// „Zajęcie środków przez organ” i „Pochodzenie środków” oraz lista adresów powiązanych w blockchainie.
import { fmtAmount, fmtDateTime, fmtPln, shorten } from '../format.ts';
import { fmtShare, hopsText, relatedKindLabel, relatedSummary, sortRelated, splitLinks } from '../funds.ts';
import type { FundingSource, RelatedAddress, Seizure } from '../funds.ts';
import { explorerForTxid } from '../identities.ts';
import { CLASS_LABEL, NETWORK_SHORT } from '../labels.ts';
import { Bar, CopyButton, ExternalLink, LayerTag, ShortAddress } from './common.tsx';
import { useDossier } from './DossierContext.tsx';

export const SEIZURES_ANCHOR = 'zajecie-srodkow';
export const FUNDING_ANCHOR = 'pochodzenie-srodkow';

const networkShort = (network: string) => (NETWORK_SHORT as Record<string, string>)[network] ?? network;
const classLabel = (addressClass: string) => (CLASS_LABEL as Record<string, string>)[addressClass] ?? addressClass;

/** Zdanie ze źródłem etykiety: adresy stron jako odnośniki, reszta zwykłym tekstem. */
function SourceText({ text }: { text: string }) {
  return (
    <span className="source-text">
      {splitLinks(text).map((part, index) => ('url' in part ? <ExternalLink key={index} url={part.url} /> : <span key={index}>{part.text}</span>))}
    </span>
  );
}

/** Transakcja jako odnośnik do eksploratora, jeśli jest w danych teczki; inaczej skrót z kopiowaniem. */
function Txid({ txid }: { txid: string }) {
  const { dossier } = useDossier();
  const explorer = explorerForTxid(dossier.findings, txid);
  return explorer ? (
    <ExternalLink url={explorer}>transakcja {shorten(txid, 8, 6)}</ExternalLink>
  ) : (
    <span className="evidence-txid">
      transakcja <code className="mono" title={txid}>{shorten(txid, 8, 6)}</code> <CopyButton value={txid} label="Kopiuj identyfikator transakcji" />
    </span>
  );
}

function SeizureItem({ item }: { item: Seizure }) {
  return (
    <article className="seizure">
      <p className="seizure-amount">
        <strong>{fmtAmount(item.amount, item.asset)}</strong>
        {item.valuePln != null && <span> · ok. {fmtPln(item.valuePln)}</span>}
        <span className="muted"> · {fmtDateTime(item.time)}</span>
      </p>
      <dl className="meta">
        <div>
          <dt>Z adresu podmiotu</dt>
          <dd>
            <span className="chip chip-network">{networkShort(item.network)}</span> <ShortAddress value={item.subjectAddress} />
          </dd>
        </div>
        <div>
          <dt>Na adres</dt>
          <dd>
            <ShortAddress value={item.counterparty} /> <CopyButton value={item.counterparty} label={`Kopiuj adres ${item.counterparty}`} />
          </dd>
        </div>
        <div>
          <dt>Transakcja</dt>
          <dd>
            <ExternalLink url={item.explorerUrl}>eksplorator</ExternalLink> <code className="mono" title={item.txid}>{shorten(item.txid, 8, 6)}</code>
          </dd>
        </div>
        <div>
          <dt>Wartość w zł</dt>
          <dd>{item.valuePln != null ? fmtPln(item.valuePln) : 'brak wyceny — brak kursu'}</dd>
        </div>
      </dl>
      <p>
        <strong>Publiczna etykieta adresu:</strong> {item.counterpartyLabel || 'brak opisu'}
      </p>
      {item.labelSource && (
        <p className="seizure-source">
          <strong>Źródło etykiety:</strong> <SourceText text={item.labelSource} />
        </p>
      )}
      {(item.valuation || item.explanation) && (
        <details className="why">
          <summary>Wycena i uzasadnienie</summary>
          {item.valuation && <p>{item.valuation}</p>}
          {item.explanation && (
            <p>
              <SourceText text={item.explanation} />
            </p>
          )}
        </details>
      )}
    </article>
  );
}

/** Zajęcie środków: przelew na adres publicznie opisany jako adres organu państwa. */
export function Seizures() {
  const { dossier } = useDossier();
  const items = dossier.seizures ?? [];
  if (items.length === 0) return null;
  return (
    <section className="card seizures" id={SEIZURES_ANCHOR} aria-labelledby="zajecie-naglowek">
      <h2 id="zajecie-naglowek">
        Zajęcie środków przez organ{items.length > 1 && ` (${items.length})`} <LayerTag layer="inference" />
      </h2>
      <p className="seizure-caveat" role="note">
        To ustalenie wynika z <strong>publicznej etykiety adresu</strong>, a nie z dokumentów postępowania — sprawdź źródło etykiety. Zajęcie{' '}
        <strong>nie jest spieniężeniem</strong>: tych kwot nie wlicza się do wypłat ani do przychodu.
      </p>
      {items.map((item) => (
        <SeizureItem key={`${item.txid}-${item.counterparty}`} item={item} />
      ))}
    </section>
  );
}

function FundingRow({ item, many }: { item: FundingSource; many: boolean }) {
  return (
    <tr>
      <th scope="row">
        <ShortAddress value={item.address} /> <CopyButton value={item.address} label={`Kopiuj adres ${item.address}`} />
        {many && (
          <span className="cell-note">
            na adres podmiotu {networkShort(item.network)} <ShortAddress value={item.subjectAddress} />
          </span>
        )}
      </th>
      <td>
        {item.label ? <strong>{item.label}</strong> : <span className="muted">bez publicznej etykiety</span>}
        {(item.label || item.addressClass !== 'unknown' || item.category) && (
          <span className="cell-note">
            {classLabel(item.addressClass)}
            {item.category && ` · ${item.category}`}
          </span>
        )}
        {item.labelSource && (
          <span className="cell-note">
            źródło etykiety: <SourceText text={item.labelSource} />
          </span>
        )}
      </td>
      <td className="num">{fmtAmount(item.amount, item.asset)}</td>
      <td className="num">{fmtShare(item.share, item.amount)}</td>
      <td className="funding-hops">
        {hopsText(item.hops)}
        {item.via && (
          <span className="cell-note">
            przez <ShortAddress value={item.via} />
          </span>
        )}
      </td>
      <td className="funding-reason">
        {item.reason}
        {(item.txids ?? []).length > 0 && (
          <span className="cell-note funding-txids">
            {item.txids.map((txid) => (
              <Txid key={txid} txid={txid} />
            ))}
          </span>
        )}
      </td>
    </tr>
  );
}

/** Pochodzenie środków: skąd przyszły wpływy na adresy podmiotu. */
export function FundingSources() {
  const { dossier } = useDossier();
  const items = dossier.fundingSources ?? [];
  if (items.length === 0) return null;
  const many = new Set(items.map((item) => item.subjectAddress)).size > 1;
  return (
    <section className="card funding" id={FUNDING_ANCHOR} aria-labelledby="pochodzenie-naglowek">
      <h2 id="pochodzenie-naglowek">
        Pochodzenie środków ({items.length}) <LayerTag layer="inference" />
      </h2>
      <p className="muted">
        Adresy, z których środki trafiły na adres podmiotu — bezpośrednio albo przez adres pośredni. Udział liczony względem wpływów adresu podmiotu.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Adres źródłowy</th>
              <th scope="col">Etykieta</th>
              <th scope="col" className="num">Kwota</th>
              <th scope="col" className="num">Udział</th>
              <th scope="col">Kroki</th>
              <th scope="col">Uzasadnienie</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => (
              <FundingRow key={`${item.subjectAddress}-${item.address}-${index}`} item={item} many={many} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Zwijana lista przy adresie podmiotu: inne adresy, które łączy z nim sam blockchain. */
export function RelatedAddresses({ items }: { items?: RelatedAddress[] | null }) {
  if (!items || items.length === 0) return null;
  const sorted = sortRelated(items);
  return (
    <details className="fold related-addresses">
      <summary>
        Inne adresy powiązane w blockchainie ({items.length}) <LayerTag layer="inference" />
      </summary>
      <p className="muted">{relatedSummary(items)}. To wskazania z danych blockchain, nie ustalenie własności.</p>
      <ul className="plain-list related-list">
        {sorted.map((item, index) => (
          <li key={`${item.address}-${item.kind}-${index}`}>
            <div className="related-head">
              <code className="mono address">{item.address}</code>
              <CopyButton value={item.address} label={`Kopiuj adres ${item.address}`} />
              <span className="chip">{relatedKindLabel(item.kind)}</span>
              {typeof item.strength === 'number' && <Bar value={item.strength} label={`Siła powiązania z ${item.address}`} />}
            </div>
            {item.reason && <p className="related-reason">{item.reason}</p>}
            {(item.txids ?? []).length > 0 && (
              <p className="related-txids">
                {item.txids.map((txid) => (
                  <Txid key={txid} txid={txid} />
                ))}
              </p>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
