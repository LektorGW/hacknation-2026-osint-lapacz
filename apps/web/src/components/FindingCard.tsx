import type { Finding } from '@olcys/core';
import { fmtPln, sum } from '../format.ts';
import { CLASS_LABEL, NETWORK_LABEL } from '../labels.ts';
import { CashOutTable, ChainProfile, FlowTimeline } from './ChainSections.tsx';
import { CopyButton } from './common.tsx';
import { isSyntheticChain } from '../mode.ts';
import { DecisionControls, useDossier } from './DossierContext.tsx';
import { addressKey, jointProbability } from '../dossier.ts';
import type { DossierFinding } from '../proof.ts';
import { countText } from '../ux.ts';
import { EvidenceList } from './EvidenceList.tsx';
import { RelatedAddresses } from './FundsOrigin.tsx';
import { ScamChip } from './ScamWarnings.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score, ScoreSteps } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';

export const findingAnchor = (address: string) => `adres-${address}`;

/** Nagłówek karty: adres, sieć, znaczniki i oba wyniki w jednolitym wyglądzie. */
function AddressHeader({ finding, index }: { finding: Finding; index: number }) {
  const { dossier } = useDossier();
  const extra = finding as DossierFinding;
  const joint = jointProbability(dossier, finding);
  const { confidence } = finding;
  return (
    <header className="fc-head">
      <div className="fc-id">
        <p className="finding-index">Adres {index + 1}</p>
        <h3 className="fc-address">
          <code className="mono address">{finding.address}</code>
          <CopyButton value={finding.address} label={`Kopiuj adres ${finding.address}`} />
        </h3>
        <div className="fc-tags">
          <span className="chip">{NETWORK_LABEL[finding.network] ?? finding.network}</span>
          {isSyntheticChain(finding.chain, finding.network) && (
            <span className="chip chip-synthetic" title="Dane blockchain tego adresu pochodzą z eksploratora piaskownicy albo sieci laboratoryjnej.">
              blockchain: dane syntetyczne
            </span>
          )}
          {finding.checksumVerified ? (
            <span className="chip chip-ok-soft">
              ✓ <Term id="suma-kontrolna">suma kontrolna</Term> poprawna
            </span>
          ) : (
            <span className="chip chip-warn-soft">
              <Term id="suma-kontrolna">suma kontrolna</Term> niesprawdzona
            </span>
          )}
          {extra.widelyCited && (
            <span className="chip chip-warn-soft">
              <Term id="adres-powszechnie-cytowany">adres powszechnie cytowany</Term> — nieprzypisany
            </span>
          )}
          {extra.chainSkipped && <span className="chip chip-inference">nie analizowano blockchainu (limit)</span>}
          <ScamChip address={finding.address} />
        </div>
      </div>
      <div className="fc-scores">
        {confidence.excluded ? (
          <Score value={confidence.score} kind="publication" excluded ledger={confidence.ledger} caption="adres odrzucony — nie wlicza się do sprawy" />
        ) : (
          <>
            {joint !== undefined && (
              <Score
                value={joint}
                kind="joint"
                caption={<Term id="osoba-adres">powiązanie z osobą ze sprawy</Term>}
                extra={
                  <p className="score-pop-sub-text">
                    Łączy pewność ustalenia osoby z Wskaźnikiem Pewności publikacji ({confidence.score}). Kroki publikacji — przy drugim wyniku.
                  </p>
                }
              />
            )}
            <Score value={confidence.score} kind="publication" ledger={confidence.ledger} caption={<Term id="wskaznik-pewnosci">publikacja adresu</Term>} />
          </>
        )}
      </div>
    </header>
  );
}

/** Jedna linia „w skrócie”: gdzie opublikowano, ile przelewów do usług, ile pieniędzy. */
function FindingSummary({ finding }: { finding: Finding }) {
  const services = [...new Set(finding.evidence.map((item) => item.service))];
  const cashOuts = finding.chain?.cashOuts ?? [];
  const pln = sum(Object.values(finding.chain?.cashOutPlnByYear ?? {}));
  const groups = finding.confidence.independentSources ?? finding.confidence.provenance?.length;
  return (
    <p className="fc-summary">
      <span>
        opublikowany w <strong>{countText(services.length, 'serwisie', 'serwisach', 'serwisach')}</strong>
        {services.length > 0 && <span className="muted">({services.slice(0, 3).join(', ')})</span>}
      </span>
      {groups !== undefined && (
        <span>
          <strong>{groups}</strong> <Term id="niezalezne-pochodzenie">{groups === 1 ? 'niezależne pochodzenie' : 'niezależne pochodzenia'}</Term>
        </span>
      )}
      {finding.chain && (
        <span>
          <strong>{countText(cashOuts.length, 'możliwa wypłata', 'możliwe wypłaty', 'możliwych wypłat')}</strong>
          {pln > 0 && <> · ok. <strong>{fmtPln(pln)}</strong></>}
        </span>
      )}
      {finding.unrelatedPublishers > 0 && (
        <span className="muted">publikuje go też {countText(finding.unrelatedPublishers, 'inna osoba', 'inne osoby', 'innych osób')}</span>
      )}
    </p>
  );
}

/** Niezależność pochodzenia śladów: grupy kopii liczone jako jedno potwierdzenie. */
function Provenance({ finding }: { finding: Finding }) {
  const { confidence } = finding;
  const groups = confidence.provenance ?? [];
  const copies = groups.filter((group) => group.evidenceIds.length > 1);
  if (copies.length === 0 && !confidence.interpretation) return null;
  const title = (id: string) => {
    const item = finding.evidence.find((entry) => entry.id === id);
    return item ? item.title || item.url : id;
  };
  return (
    <div className="provenance">
      {copies.length > 0 && (
        <>
          <p className="muted small">Kopie, przedruki i wersje archiwalne tej samej publikacji liczą się jako jedno potwierdzenie:</p>
          <ul className="plain-list provenance-groups">
            {copies.map((group, index) => (
              <li key={index}>
                <span className="chip chip-archive">jedno pochodzenie · {group.evidenceIds.length} ślady</span>
                {group.services.length > 0 && <span className="muted"> {group.services.join(', ')}</span>}
                <ul>
                  {group.evidenceIds.map((id) => (
                    <li key={id}>{title(id)}</li>
                  ))}
                </ul>
                {group.reasons.length > 0 && <p className="muted">Dlaczego razem: {group.reasons.join(' ')}</p>}
              </li>
            ))}
          </ul>
        </>
      )}
      {confidence.interpretation && <p className="muted small">{confidence.interpretation}</p>}
    </div>
  );
}

function CashOutYears({ byYear }: { byYear: Record<string, number> }) {
  const years = Object.keys(byYear).sort();
  if (years.length === 0) return null;
  return (
    <p className="year-totals">
      Szacunek wypłat:{' '}
      {years.map((year) => (
        <span key={year} className="year-total">
          {year}: <strong>{fmtPln(byYear[year] ?? 0)}</strong>
        </span>
      ))}
    </p>
  );
}

function Limitations({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <Disclosure title="Ograniczenia danych" meta={countText(items.length, 'uwaga', 'uwagi', 'uwag')}>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** Ślady z profili zaliczonych do innej osoby: pokazane, ale niewliczone do wyniku. */
function ExcludedEvidence({ finding }: { finding: DossierFinding }) {
  const { annotations = [], excludedEvidence = [] } = finding;
  if (annotations.length === 0 && excludedEvidence.length === 0) return null;
  return (
    <Disclosure
      layer={excludedEvidence.length > 0 ? 'inference' : 'calc'}
      title={excludedEvidence.length > 0 ? 'Ślady niewliczone do wyniku' : 'Adnotacje do wyniku i zakresu historii'}
      meta={excludedEvidence.length > 0 ? excludedEvidence.length : undefined}
    >
      {annotations.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {excludedEvidence.length > 0 && <EvidenceList evidence={excludedEvidence} address={finding.address} />}
    </Disclosure>
  );
}

/** Stopka karty: opcjonalna decyzja analityka. */
function DecisionFoot({ finding }: { finding: Finding }) {
  return (
    <footer className="fc-foot">
      <p className="fc-foot-label">
        Czy to adres tej osoby? <Term id="korekta-analityka">Twoja decyzja</Term> przeliczy teczkę.
      </p>
      <DecisionControls target="address" decisionKey={addressKey(finding)} confirmLabel="To adres tej osoby" rejectLabel="To nie jest adres tej osoby" summary="Potwierdź albo odrzuć (opcjonalnie)" />
    </footer>
  );
}

/** Pełna karta adresu powiązanego z podmiotem: odpowiedź u góry, szczegóły o jedno kliknięcie dalej. */
export function FindingCard({ finding, index }: { finding: Finding; index: number }) {
  const { confidence, chain } = finding;
  return (
    <article className="card finding" id={findingAnchor(finding.address)} tabIndex={-1}>
      <AddressHeader finding={finding} index={index} />
      <FindingSummary finding={finding} />
      <RelatedAddresses items={(finding as DossierFinding).relatedAddresses} />

      <div className="fc-body">
        <Disclosure layer="fact" title="Gdzie opublikowano adres" meta={countText(finding.evidence.length, 'ślad', 'ślady', 'śladów')} defaultOpen={index === 0}>
          <EvidenceList evidence={finding.evidence} address={finding.address} />
        </Disclosure>

        <Disclosure layer="calc" title="Skąd wziął się wynik — krok po kroku" meta={countText(confidence.ledger.length, 'krok', 'kroki', 'kroków')}>
          <ScoreSteps ledger={confidence.ledger} />
          <Provenance finding={finding} />
        </Disclosure>

        {confidence.nextSteps.length > 0 && (
          <Disclosure layer="inference" title="Co podniosłoby wynik" meta={countText(confidence.nextSteps.length, 'propozycja', 'propozycje', 'propozycji')}>
            <ul>
              {confidence.nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          </Disclosure>
        )}

        <ExcludedEvidence finding={finding as DossierFinding} />

        {chain ? (
          <>
            <Disclosure layer="fact" title={<><Term id="blockchain">Blockchain</Term>: profil adresu</>} meta={`${chain.profile.txCount.toLocaleString('pl-PL')} transakcji`}>
              <ChainProfile profile={chain.profile} />
            </Disclosure>
            <Disclosure layer="inference" title={<>Możliwe wypłaty na waluty tradycyjne</>} meta={countText(chain.cashOuts.length, 'operacja', 'operacje', 'operacji')}>
              <CashOutTable cashOuts={chain.cashOuts} />
              <CashOutYears byYear={chain.cashOutPlnByYear} />
            </Disclosure>
            <Disclosure layer="fact" title="Oś czasu przepływów" meta={countText(chain.transfers.length, 'przelew', 'przelewy', 'przelewów')}>
              <FlowTimeline transfers={chain.transfers} cashOuts={chain.cashOuts} />
            </Disclosure>
            <Limitations items={chain.limitations} />
          </>
        ) : (
          <p className="muted small">Brak danych z blockchaina dla tego adresu.</p>
        )}
      </div>
      <DecisionFoot finding={finding} />
    </article>
  );
}

/** Skrócona karta adresu wykluczonego: powód w jednym zdaniu, reszta po rozwinięciu. */
export function RejectedCard({ finding, index }: { finding: Finding; index: number }) {
  const { confidence, chain } = finding;
  const reasons = confidence.ledger.filter((entry) => entry.rule.startsWith('exclusion.'));
  const main = (reasons.length > 0 ? reasons : confidence.ledger)[0];
  return (
    <article className="card finding finding-rejected" id={findingAnchor(finding.address)} tabIndex={-1}>
      <AddressHeader finding={finding} index={index} />
      <p className="fc-summary">
        <span>
          <span className="status status-rejected">odrzucony</span> {main ? main.explanation : `Adres oznaczony jako wykluczony (${confidence.tier}).`}
        </span>
      </p>
      <div className="fc-body">
        {(reasons.length > 1 || confidence.ledger.length > 1) && (
          <Disclosure layer="calc" title="Powód wykluczenia — wszystkie kroki">
            <ScoreSteps ledger={reasons.length > 0 ? reasons : confidence.ledger} />
          </Disclosure>
        )}
        {chain && (
          <Disclosure layer="fact" title="Czym jest ten adres" meta={chain.profile.label ?? CLASS_LABEL[chain.profile.addressClass] ?? chain.profile.addressClass}>
            <p>
              <strong>{chain.profile.label ?? CLASS_LABEL[chain.profile.addressClass] ?? chain.profile.addressClass}</strong>
              {' — '}
              {CLASS_LABEL[chain.profile.addressClass] ?? chain.profile.addressClass}. Źródło klasyfikacji: {chain.profile.classificationSource}. Liczba
              transakcji: {chain.profile.txCount.toLocaleString('pl-PL')}.
            </p>
            {finding.unrelatedPublishers > 0 && <p className="muted">Adres publikuje także {countText(finding.unrelatedPublishers, 'inna osoba', 'inne osoby', 'innych osób')}.</p>}
          </Disclosure>
        )}
        <Disclosure layer="fact" title="Gdzie adres został opublikowany" meta={countText(finding.evidence.length, 'ślad', 'ślady', 'śladów')}>
          <EvidenceList evidence={finding.evidence} address={finding.address} />
        </Disclosure>
        <ExcludedEvidence finding={finding as DossierFinding} />
        {chain && <Limitations items={chain.limitations} />}
      </div>
      <DecisionFoot finding={finding} />
    </article>
  );
}
