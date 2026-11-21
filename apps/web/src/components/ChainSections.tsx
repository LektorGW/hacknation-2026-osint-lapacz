// Dane blockchain adresu: profil, wskaźniki wypłat, oś czasu przepływów.
import type { AddressProfile, CashOutIndicator, Transfer } from '@olcys/core';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln } from '../format.ts';
import { CASH_OUT_LABEL, CLASS_LABEL } from '../labels.ts';
import { ExternalLink, ShortAddress } from './common.tsx';

export function ChainProfile({ profile }: { profile: AddressProfile }) {
  const amount = (value: number) => fmtAmount(value, profile.nativeAsset);
  return (
    <dl className="meta">
      <div>
        <dt>Klasa adresu</dt>
        <dd>
          {CLASS_LABEL[profile.addressClass] ?? profile.addressClass}
          {profile.isContract && ' (kontrakt)'}
        </dd>
      </div>
      <div>
        <dt>Etykieta publiczna</dt>
        <dd>{profile.label ?? 'brak'}</dd>
      </div>
      <div>
        <dt>Źródło klasyfikacji</dt>
        <dd>{profile.classificationSource}</dd>
      </div>
      <div>
        <dt>Liczba transakcji</dt>
        <dd>{profile.txCount.toLocaleString('pl-PL')}</dd>
      </div>
      <div>
        <dt>Okres aktywności</dt>
        <dd>
          {profile.firstSeen || profile.lastSeen
            ? `${fmtDate(profile.firstSeen)} – ${fmtDate(profile.lastSeen)}`
            : 'brak danych'}
        </dd>
      </div>
      <div>
        <dt>Otrzymano łącznie</dt>
        <dd>{amount(profile.totalReceived)}</dd>
      </div>
      <div>
        <dt>Wysłano łącznie</dt>
        <dd>{amount(profile.totalSent)}</dd>
      </div>
      <div>
        <dt>Saldo</dt>
        <dd>{amount(profile.balance)}</dd>
      </div>
    </dl>
  );
}

function Counterparty({ address, label }: { address: string; label?: string }) {
  return (
    <>
      {label && <span className="counterparty-label">{label} </span>}
      <ShortAddress value={address} />
    </>
  );
}

export function CashOutTable({ cashOuts }: { cashOuts: CashOutIndicator[] }) {
  if (cashOuts.length === 0) {
    return <p className="muted">Nie wykryto oznak wypłaty na waluty tradycyjne.</p>;
  }
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Rodzaj</th>
            <th scope="col" className="num">Kwota</th>
            <th scope="col">Kontrahent</th>
            <th scope="col" className="num">Wartość w PLN</th>
            <th scope="col">Weryfikacja</th>
          </tr>
        </thead>
        <tbody>
          {cashOuts.map((item) => (
            <tr key={`${item.txid}-${item.kind}`}>
              <td>{fmtDateTime(item.time)}</td>
              <td>
                <strong>{CASH_OUT_LABEL[item.kind] ?? item.kind}</strong>
                <span className="cell-note">{item.explanation}</span>
              </td>
              <td className="num">{fmtAmount(item.amount, item.asset)}</td>
              <td>
                <Counterparty address={item.counterparty} label={item.counterpartyLabel} />
              </td>
              <td className="num">
                {item.valuePln === undefined ? (
                  <span className="muted">brak kursu</span>
                ) : (
                  <strong>{fmtPln(item.valuePln)}</strong>
                )}
                {item.valuation && <span className="cell-note">{item.valuation}</span>}
              </td>
              <td>
                <ExternalLink url={item.explorerUrl}>transakcja w eksploratorze</ExternalLink>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Przepływy w kolejności chronologicznej; transakcje uznane za wskaźnik wypłaty są oznaczone. */
export function FlowTimeline({ transfers, cashOuts }: { transfers: Transfer[]; cashOuts: CashOutIndicator[] }) {
  if (transfers.length === 0) return <p className="muted">Brak pobranych przepływów.</p>;
  const cashOutKinds = new Map(cashOuts.map((item) => [item.txid, item.kind]));
  const ordered = [...transfers].sort((a, b) => a.time.localeCompare(b.time));
  return (
    <ol className="timeline">
      {ordered.map((item) => {
        const cashOut = cashOutKinds.get(item.txid);
        return (
          <li key={`${item.txid}-${item.direction}-${item.counterparty}`} className={`timeline-item flow-${item.direction}`}>
            <time dateTime={item.time}>{fmtDateTime(item.time)}</time>
            <div className="timeline-body">
              <p>
                <span className="flow-direction">{item.direction === 'in' ? '← Wpływ' : '→ Wypływ'}</span>{' '}
                <strong>{fmtAmount(item.amount, item.asset)}</strong> {item.direction === 'in' ? 'od' : 'do'}{' '}
                <Counterparty address={item.counterparty} label={item.counterpartyLabel} />{' '}
                <span className="muted">({CLASS_LABEL[item.counterpartyClass] ?? item.counterpartyClass})</span>
              </p>
              <p className="timeline-links">
                {cashOut && (
                  <span className="chip chip-inference">wskaźnik wypłaty: {(CASH_OUT_LABEL[cashOut] ?? cashOut).toLowerCase()}</span>
                )}
                <ExternalLink url={item.explorerUrl}>eksplorator</ExternalLink>
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
