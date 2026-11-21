import type { Finding, LedgerEntry } from '@olcys/core';
import { fmtDelta, fmtPln } from '../format.ts';
import { CLASS_LABEL, NETWORK_LABEL, ruleLabel } from '../labels.ts';
import { CashOutTable, ChainProfile, FlowTimeline } from './ChainSections.tsx';
import { CopyButton, DualScore, LayerSection, ScoreMeter } from './common.tsx';
import { DecisionControls, useDossier } from './DossierContext.tsx';
import { addressKey, jointProbability } from '../dossier.ts';
import type { DossierFinding } from '../proof.ts';
import { EvidenceList } from './EvidenceList.tsx';

export const findingAnchor = (address: string) => `adres-${address}`;

function AddressHeader({ finding, index }: { finding: Finding; index: number }) {
  const { dossier } = useDossier();
  return (
    <header className="finding-head">
      <h3>
        <span className="finding-index">Adres {index + 1}</span>
        <code className={`mono address ${finding.confidence.excluded ? 'address-rejected' : ''}`}>{finding.address}</code>
      </h3>
      <div className="finding-chips">
        <CopyButton value={finding.address} label={`Kopiuj adres ${finding.address}`} />
        <span className="chip">{NETWORK_LABEL[finding.network] ?? finding.network}</span>
        {finding.checksumVerified ? (
          <span className="chip chip-ok">✓ suma kontrolna zweryfikowana</span>
        ) : (
          <span className="chip chip-warn">suma kontrolna niezweryfikowana</span>
        )}
        {(finding as DossierFinding).widelyCited && <span className="chip chip-warn">adres powszechnie cytowany — nieprzypisany</span>}
        {(finding as DossierFinding).chainSkipped && <span className="chip chip-inference">nie analizowano łańcucha (limit)</span>}
        <DualScore joint={jointProbability(dossier, finding)} score={finding.confidence.score} excluded={finding.confidence.excluded} />
      </div>
      <DecisionControls target="address" decisionKey={addressKey(finding)} confirmLabel="To adres tej osoby" rejectLabel="To nie jest adres tej osoby" />
    </header>
  );
}

/** Księga reguł: każdy krok obliczenia wyniku z wartością narastającą. */
function Ledger({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return <p className="muted">Brak kroków — nie znaleziono śladów do wyceny.</p>;
  return (
    <ol className="ledger">
      {entries.map((entry, index) => (
        <li key={`${entry.rule}-${index}`} className="ledger-step">
          <span className={`ledger-delta ${entry.delta < 0 ? 'negative' : entry.delta > 0 ? 'positive' : ''}`}>
            {fmtDelta(entry.delta)}
          </span>
          <div className="ledger-body">
            <p className="ledger-rule">
              {ruleLabel(entry.rule)} <code className="mono rule-id">{entry.rule}</code>
            </p>
            <p>{entry.explanation}</p>
          </div>
          <span className="ledger-running">
            <span className="ledger-running-label">po kroku</span> {entry.running}%
          </span>
        </li>
      ))}
    </ol>
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
    <aside className="limitations">
      <h4>Ograniczenia danych</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </aside>
  );
}

/** Ślady z profili zaliczonych do innej osoby: pokazane, ale niewliczone do wyniku. */
function ExcludedEvidence({ finding }: { finding: DossierFinding }) {
  const { annotations = [], excludedEvidence = [] } = finding;
  if (annotations.length === 0 && excludedEvidence.length === 0) return null;
  return (
    <LayerSection layer={excludedEvidence.length > 0 ? 'inference' : 'calc'} title={excludedEvidence.length > 0 ? `Ślady niewliczone do wyniku (${excludedEvidence.length})` : 'Adnotacje do wyniku i zakresu historii'}>
      {annotations.map((note) => (
        <p key={note}>{note}</p>
      ))}
      {excludedEvidence.length > 0 && <EvidenceList evidence={excludedEvidence} address={finding.address} />}
    </LayerSection>
  );
}

/** Pełna karta adresu powiązanego z podmiotem. */
export function FindingCard({ finding, index }: { finding: Finding; index: number }) {
  const { confidence, chain } = finding;
  return (
    <article className="card finding" id={findingAnchor(finding.address)} tabIndex={-1}>
      <AddressHeader finding={finding} index={index} />

      <LayerSection layer="inference" title="Ocena powiązania z podmiotem">
        <ScoreMeter score={confidence.score} tier={confidence.tier} excluded={confidence.excluded} />
        {finding.unrelatedPublishers > 0 && (
          <p className="muted">Ten sam adres publikuje także {finding.unrelatedPublishers} innych, niepowiązanych tożsamości.</p>
        )}
      </LayerSection>

      <LayerSection layer="calc" title="Księga reguł — skąd wziął się wynik">
        <Ledger entries={confidence.ledger} />
      </LayerSection>

      {confidence.nextSteps.length > 0 && (
        <section className="next-steps">
          <h4>Co podniosłoby wynik</h4>
          <ul>
            {confidence.nextSteps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </section>
      )}

      <LayerSection layer="fact" title={`Ślady w źródłach publicznych (${finding.evidence.length})`}>
        <EvidenceList evidence={finding.evidence} address={finding.address} />
      </LayerSection>

      <ExcludedEvidence finding={finding} />

      {chain ? (
        <>
          <LayerSection layer="fact" title="Profil adresu w blockchainie">
            <ChainProfile profile={chain.profile} />
          </LayerSection>
          <LayerSection layer="inference" title="Wskaźniki wypłat na waluty tradycyjne">
            <CashOutTable cashOuts={chain.cashOuts} />
            <CashOutYears byYear={chain.cashOutPlnByYear} />
          </LayerSection>
          <LayerSection layer="fact" title="Oś czasu przepływów">
            <FlowTimeline transfers={chain.transfers} cashOuts={chain.cashOuts} />
          </LayerSection>
          <Limitations items={chain.limitations} />
        </>
      ) : (
        <p className="muted">Brak danych blockchain dla tego adresu.</p>
      )}
    </article>
  );
}

/** Skrócona karta adresu wykluczonego: powód i miejsce publikacji, bez przypisania do podmiotu. */
export function RejectedCard({ finding, index }: { finding: Finding; index: number }) {
  const { confidence, chain } = finding;
  const reasons = confidence.ledger.filter((entry) => entry.rule.startsWith('exclusion.'));
  return (
    <article className="card finding finding-rejected" id={findingAnchor(finding.address)} tabIndex={-1}>
      <AddressHeader finding={finding} index={index} />

      <LayerSection layer="calc" title="Powód wykluczenia">
        {(reasons.length > 0 ? reasons : confidence.ledger).map((entry, position) => (
          <p key={`${entry.rule}-${position}`}>
            {entry.explanation} <code className="mono rule-id">{entry.rule}</code>
          </p>
        ))}
        {confidence.ledger.length === 0 && <p>Adres oznaczony jako wykluczony ({confidence.tier}).</p>}
      </LayerSection>

      {chain && (
        <LayerSection layer="fact" title="Klasyfikacja adresu">
          <p>
            <strong>{chain.profile.label ?? CLASS_LABEL[chain.profile.addressClass] ?? chain.profile.addressClass}</strong>
            {' — '}
            {CLASS_LABEL[chain.profile.addressClass] ?? chain.profile.addressClass}. Źródło klasyfikacji:{' '}
            {chain.profile.classificationSource}. Liczba transakcji: {chain.profile.txCount.toLocaleString('pl-PL')}.
          </p>
          {finding.unrelatedPublishers > 0 && (
            <p className="muted">Adres publikuje także {finding.unrelatedPublishers} innych, niepowiązanych tożsamości.</p>
          )}
        </LayerSection>
      )}

      <LayerSection layer="fact" title={`Gdzie adres został opublikowany (${finding.evidence.length})`}>
        <EvidenceList evidence={finding.evidence} address={finding.address} />
      </LayerSection>

      <ExcludedEvidence finding={finding} />

      {chain && <Limitations items={chain.limitations} />}
    </article>
  );
}
