// Karta „Analiza adresu”: sprawa założona dla samego adresu, bez ustalania osoby.
import { fmtAmount, fmtDate, fmtPln, sum } from '../format.ts';
import { CLASS_LABEL, NETWORK_LABEL } from '../labels.ts';
import { mentionServices } from '../funds.ts';
import { proofSummary } from '../proof.ts';
import type { FullDossier } from '../proof.ts';
import { CopyButton, Gauge, LayerTag, toLayer } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { ServiceChips } from './ServiceCards.tsx';

/** Sprawa dotyczy samego adresu, gdy nie ustalono osoby, a analityk podał adres krypto. */
export function isAddressCase(dossier: FullDossier): boolean {
  return dossier.persons.length === 0 && dossier.subject.identifiers.some((item) => item.origin === 'analyst' && item.identifier.type === 'crypto_address');
}

export function AddressSummary() {
  const { dossier, tabHref } = useDossier();
  const given = dossier.subject.identifiers.find((item) => item.identifier.type === 'crypto_address')!.identifier.value;
  const finding = dossier.findings.find((item) => item.address.toLowerCase() === given.toLowerCase()) ?? dossier.findings[0];
  const profile = finding?.chain?.profile;
  const { totals, keyFindings } = dossier;
  const strongest = proofSummary(dossier.cashOutProof ?? []).strongest;
  const mentions = (dossier.mentions ?? []).filter((item) => item.documents > 0 || item.note);
  const total = (totals as { cashOutPlnTotal?: number }).cashOutPlnTotal ?? sum(Object.values(totals.cashOutPlnByYear));

  return (
    <section className="determination card" aria-labelledby="ustalenie">
      <header className="determination-head">
        <h2 id="ustalenie">Analiza adresu</h2>
        <LayerTag layer="fact" />
        <span className="muted">sprawa dotyczy samego adresu — właściciela nie ustalano</span>
      </header>

      {strongest && (
        <p className="strongest-proof">
          <LayerTag layer={toLayer(strongest.layer)} /> <strong>Najmocniejszy dowód spieniężenia:</strong> {strongest.statement}{' '}
          <a href={tabHref('dowod')}>Ścieżka krok po kroku</a>
        </p>
      )}

      <div className="determination-grid address-mode">
        <div>
          <p className="person-name address-name">{finding?.address ?? given}</p>
          <p>
            <CopyButton value={finding?.address ?? given} label="Kopiuj badany adres" />
          </p>
          <dl className="attributes">
            <div>
              <dt>Sieć</dt>
              <dd>{finding ? (NETWORK_LABEL[finding.network] ?? finding.network) : 'nie rozpoznano'}</dd>
            </div>
            <div>
              <dt>Klasa</dt>
              <dd>
                {profile ? (CLASS_LABEL[profile.addressClass] ?? profile.addressClass) : 'brak danych blockchain'}
                {profile?.label && <span className="attribute-sources">etykieta: {profile.label}</span>}
              </dd>
            </div>
            {profile && (
              <>
                <div>
                  <dt>Otrzymano</dt>
                  <dd>{fmtAmount(profile.totalReceived, profile.nativeAsset)}</dd>
                </div>
                <div>
                  <dt>Wysłano</dt>
                  <dd>{fmtAmount(profile.totalSent, profile.nativeAsset)}</dd>
                </div>
                <div>
                  <dt>Aktywność</dt>
                  <dd>
                    {profile.txCount} transakcji{profile.firstSeen && ` · ${fmtDate(profile.firstSeen)} – ${fmtDate(profile.lastSeen)}`}
                  </dd>
                </div>
              </>
            )}
          </dl>
        </div>

        <div>
          <h3>Wzmianki w publicznych źródłach</h3>
          {mentions.length === 0 ? (
            <p className="muted">Nie znaleziono publikacji cytujących ten adres.</p>
          ) : (
            <ul className="plain-list">
              {mentions.map((item, index) => {
                const services = mentionServices(item.services);
                return (
                  <li key={`${item.identifier.value}-${index}`}>
                    {item.authors > 0 ? (
                      <>
                        Cytowany przez co najmniej <strong>{item.authors}</strong> autorów w <strong>{services.count || 1}</strong> serwisach ({item.documents}{' '}
                        dokumentów{services.names.length > 0 && `: ${services.names.join(', ')}`}) — właściciela nie wskazano.
                      </>
                    ) : (
                      <>
                        Występuje w <strong>{item.documents}</strong> dokumentach{services.names.length > 0 && ` (${services.names.join(', ')})`} — właściciela nie wskazano.
                      </>
                    )}
                    {item.note && <span className="mention-note">Adnotacja: {item.note}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <h3>Giełdy i portfele</h3>
          <ServiceChips />
        </div>

        <div>
          <div className="determination-totals address-totals">
            <Gauge value={totals.priority} label="priorytet adresu" unit="" size={84} />
            <div>
              <p className="total-value">{total > 0 ? fmtPln(total) : 'brak oznak wypłat'}</p>
              <p className="muted">szacowane przekazania do giełd i usług</p>
              <details className="why">
                <summary>Skąd priorytet {totals.priority}/100 (dotyczy adresu, nie osoby)</summary>
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
        </div>
      )}
    </section>
  );
}
