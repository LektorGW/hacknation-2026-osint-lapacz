// Miksery i CoinJoin: baner w podsumowaniu sprawy i blok „Miksery” w sekcji Pieniądze.
// Ton spokojny: narzędzie stwierdza tylko, że środki przeszły przez mikser i dalszej drogi nie widać.
import type { Network } from '@olcys/core';
import { fmtAmount, fmtDateTime, fmtPln, shorten } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import { MIXER_STATUS_TEXT, SWIRL_PATH, mixerBanner, mixerExposureOf } from '../mixers.ts';
import type { MixerTransfer } from '../mixers.ts';
import { ExternalLink } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Term } from './ui/Term.tsx';

export const MIXER_ANCHOR = 'miksery';

/** Znak miksera (spirala) w tekście — dziedziczy kolor. */
export function SwirlIcon() {
  return (
    <svg className="swirl-icon" viewBox="-13 -13 26 26" width="1em" height="1em" aria-hidden="true" focusable="false">
      <path d={SWIRL_PATH} />
    </svg>
  );
}

/** Baner pod kafelkami podsumowania — tylko gdy jest ekspozycja. */
export function MixerBanner() {
  const { dossier, tabHref } = useDossier();
  const exposure = mixerExposureOf(dossier);
  if (!exposure) return null;
  const banner = mixerBanner(exposure);
  return (
    <div className={`mixer-banner is-${banner.tone}`} role="note" aria-label="Miksery i CoinJoin">
      <span className="mixer-banner-icon" aria-hidden="true">
        <SwirlIcon />
      </span>
      <p className="mixer-banner-text">
        <strong>{banner.text}</strong>
        <span className="mixer-banner-note">
          {' '}
          {banner.note} <Term id={exposure.coinjoins.length > 0 && exposure.level === 'possible' ? 'coinjoin' : 'mikser'}>{exposure.coinjoins.length > 0 && exposure.level === 'possible' ? 'Co to CoinJoin?' : 'Co to mikser?'}</Term>
        </span>
      </p>
      <a className="mixer-banner-link" href={tabHref('dowod')}>
        Szczegóły <span aria-hidden="true">→</span>
      </a>
    </div>
  );
}

function TransferRows({ items }: { items: MixerTransfer[] }) {
  return (
    <>
      {items.map((item) => (
        <tr key={`${item.direction}-${item.txid}-${item.mixerAddress}`}>
          <td>{fmtDateTime(item.time)}</td>
          <td>{item.direction === 'to_mixer' ? 'do miksera' : 'z miksera'}</td>
          <td className="mono" title={item.address}>
            {NETWORK_SHORT[item.network as Network] ?? item.network} {shorten(item.address, 6, 4)}
          </td>
          <td>
            <strong>{item.mixerName}</strong>
            <span className="cell-note">{item.mixerLabel}</span>
            <span className="cell-note" title={item.labelSource}>
              {MIXER_STATUS_TEXT[item.status] ?? item.status}
            </span>
          </td>
          <td className="num tabular">{fmtAmount(item.amount, item.asset)}</td>
          <td className="num tabular" title={item.rateNote}>
            {item.valuePln !== undefined ? fmtPln(item.valuePln) : <span className="muted">brak kursu</span>}
          </td>
          <td className="mono">
            <ExternalLink url={item.explorerUrl}>{shorten(item.txid, 8, 6)}</ExternalLink>
          </td>
        </tr>
      ))}
    </>
  );
}

/** Blok „Miksery” w sekcji Pieniądze: przekazania do i z miksera, hipotezy CoinJoin, listy sankcyjne, ograniczenia. */
export function MixerBlock() {
  const { dossier } = useDossier();
  const exposure = mixerExposureOf(dossier);
  if (!exposure) return null;
  const banner = mixerBanner(exposure);
  const transfers = [...exposure.outgoing, ...exposure.incoming].sort((a, b) => a.time.localeCompare(b.time));
  const indirect = exposure.traceStops.filter((item) => !item.coinjoin && !item.direct);
  return (
    <section id={MIXER_ANCHOR} className={`card mixer-block is-${banner.tone}`} aria-labelledby="miksery-tytul">
      <header className="section-head">
        <div>
          <h3 id="miksery-tytul">
            <Term id="mikser">Miksery</Term> i <Term id="coinjoin">CoinJoin</Term>
          </h3>
          <p className="prose">{exposure.statement}</p>
        </div>
        <span className={`status ${exposure.level === 'confirmed' ? 'status-fact' : 'status-inference'}`}>
          {exposure.level === 'confirmed' ? 'oznaczony mikser' : 'hipoteza — heurystyka'}
        </span>
      </header>
      {transfers.length > 0 && (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Kierunek</th>
                <th scope="col">Adres sprawy</th>
                <th scope="col">Mikser</th>
                <th scope="col" className="num">
                  Kwota
                </th>
                <th scope="col" className="num">
                  <Term id="wycena">Szacunek PLN</Term>
                </th>
                <th scope="col">Transakcja</th>
              </tr>
            </thead>
            <tbody>
              <TransferRows items={transfers} />
            </tbody>
          </table>
        </div>
      )}
      {exposure.sanctions.length > 0 && (
        <ul className="plain-list mixer-sanctions">
          {exposure.sanctions.map((item) => (
            <li key={`${item.mixerAddress}-${item.entryId}`}>
              <span className="status status-fact">lista sankcyjna</span> Adres miksera <span className="mono">{shorten(item.mixerAddress, 8, 6)}</span> figuruje na liście {item.list} (wpis {item.entryId}: „{item.entryName}”, migawka z{' '}
              {item.retrievedAt.slice(0, 10)}) — fakt o liście.
            </li>
          ))}
        </ul>
      )}
      {exposure.coinjoins.length + indirect.length > 0 && (
        <div className="mixer-hypotheses">
          <h4>
            Hipotezy <span className="status status-inference">do weryfikacji</span>
          </h4>
          <ul className="plain-list">
            {exposure.coinjoins.map((item) => (
              <li key={`cj-${item.txid}`}>
                {item.explanation}{' '}
                {item.explorerUrl && <ExternalLink url={item.explorerUrl}>transakcja {shorten(item.txid, 8, 6)}</ExternalLink>}
              </li>
            ))}
            {indirect.map((item) => (
              <li key={`stop-${item.txid}-${item.mixerAddress}`}>
                Śledzenie środków z adresu {shorten(item.address, 6, 4)} urwało się na mikserze „{item.mixerLabel}” za adresem pośrednim (wnioskowanie), transakcja <span className="mono">{shorten(item.txid, 8, 6)}</span>.
              </li>
            ))}
          </ul>
        </div>
      )}
      <Disclosure title="Ograniczenia" meta={exposure.limitations.length}>
        <ul className="plain-list">
          {exposure.limitations.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
      </Disclosure>
    </section>
  );
}
