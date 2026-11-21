// „Dowód spieniężenia”: udokumentowane ścieżki środków od adresu osoby do giełdy lub usługi.
import { api, serviceRequestUrl } from '../api.ts';
import { cashOutRows } from '../dossier.ts';
import { fmtAmount, fmtDateTime, fmtPln, scoreLevel, shorten, sum } from '../format.ts';
import { CASH_OUT_LABEL, CLASS_LABEL, NETWORK_SHORT } from '../labels.ts';
import { buildChain, proofSummary, splitProofs } from '../proof.ts';
import { Explanations } from './Explanations.tsx';
import type { CashOutProof, ChainNode } from '../proof.ts';
import { useAsync } from '../useAsync.ts';
import { CopyButton, EmptyState, ExternalLink, Gauge, LayerTag, ShortAddress, toLayer } from './common.tsx';
import { useDossier } from './DossierContext.tsx';

const BASIS_TEXT: Record<CashOutProof['addressBasis'], string> = {
  confirmed: 'adres potwierdzony przez analityka',
  published: 'adres opublikowany przez osobę',
  analyst: 'adres podany przez analityka',
  cluster: 'adres z klastra portfela',
};

const ROLE_TEXT: Record<ChainNode['role'], string> = {
  source: 'adres osoby',
  intermediate: 'adres przelotowy',
  service: 'adres usługi',
};

function Node({ node }: { node: ChainNode }) {
  return (
    <li className={`chain-node role-${node.role}`}>
      <span className="chain-role">{ROLE_TEXT[node.role]}</span>
      <code className="mono" title={node.address}>
        {shorten(node.address, 7, 5)}
      </code>
      {node.label && <span className="chain-label">{node.label}</span>}
    </li>
  );
}

/** Łańcuch kroków jako pozioma ścieżka: adres osoby → … → usługa. */
function Chain({ proof }: { proof: CashOutProof }) {
  const chain = buildChain(proof.trail);
  return (
    <ol className="chain" aria-label="Ścieżka środków krok po kroku">
      <Node node={chain.source} />
      {chain.steps.flatMap((step, index) => [
        <li key={`step-${index}`} className={`chain-step ${step.inferred ? 'is-inferred' : ''}`} title={step.reason}>
          <span className="chain-amount">{fmtAmount(step.amount, step.asset)}</span>
          <span className="chain-arrow" aria-hidden="true" />
          <span className="chain-meta">
            {fmtDateTime(step.time)} · <ExternalLink url={step.explorerUrl}>eksplorator</ExternalLink>
          </span>
          {step.inferred && <span className="chain-inferred">krok wnioskowany</span>}
        </li>,
        <Node key={`node-${index}`} node={step.to} />,
      ])}
    </ol>
  );
}

function Steps({ proof }: { proof: CashOutProof }) {
  return (
    <details className="fold">
      <summary>Tabela kroków ({proof.trail.hops.length})</summary>
      <div className="table-scroll">
        <table className="table table-dense">
          <thead>
            <tr>
              <th scope="col">Krok</th>
              <th scope="col">Data</th>
              <th scope="col">Z adresu</th>
              <th scope="col">Na adres</th>
              <th scope="col" className="num">Kwota</th>
              <th scope="col">Etykieta adresu docelowego</th>
              <th scope="col">Podstawa kroku</th>
              <th scope="col">Weryfikacja</th>
            </tr>
          </thead>
          <tbody>
            {proof.trail.hops.map((hop, index) => (
              <tr key={`${hop.txid}-${index}`}>
                <td className="num">{index + 1}</td>
                <td>{fmtDateTime(hop.time)}</td>
                <td>
                  <ShortAddress value={hop.from} />
                </td>
                <td>
                  <ShortAddress value={hop.to} />
                </td>
                <td className="num">{fmtAmount(hop.amount, hop.asset)}</td>
                <td>
                  {hop.toLabel ?? '—'}
                  {hop.toClass && <span className="cell-note">{CLASS_LABEL[hop.toClass] ?? hop.toClass}</span>}
                </td>
                <td>
                  <LayerTag layer={hop.inferred ? 'inference' : 'fact'} />
                  {hop.reason && <span className="cell-note">{hop.reason}</span>}
                </td>
                <td>
                  <ExternalLink url={hop.explorerUrl}>eksplorator</ExternalLink>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ProofCard({ proof }: { proof: CashOutProof }) {
  const { dossier } = useDossier();
  const service = dossier.serviceLinks.find((link) => link.name === proof.serviceName);
  const available = useAsync(async () => (service ? api.hasServiceRequest(dossier.runId, service.id) : false), `${dossier.runId}|${service?.id ?? ''}`);
  const { trail } = proof;
  return (
    <article className={`card proof level-${scoreLevel(proof.combinedConfidence)}`}>
      <div className="proof-head">
        <Gauge value={proof.combinedConfidence} label="łączna pewność ustalenia" size={104} />
        <div>
          <p className="proof-statement">{proof.statement}</p>
          <p className="proof-meta">
            <LayerTag layer={toLayer(proof.layer)} />
            <span className="chip">poziom: {proof.tier}</span>
            <span className="chip chip-network">{NETWORK_SHORT[proof.network] ?? proof.network}</span>
            <span className="chip">{CASH_OUT_LABEL[trail.serviceKind] ?? trail.serviceKind}</span>
            <span className="chip">{BASIS_TEXT[proof.addressBasis]}</span>
          </p>
          <p className="proof-formula">
            osoba–adres <strong>{proof.personAddressProbability}%</strong> × ścieżka <strong>{proof.trailConfidence}%</strong> ={' '}
            <strong>{proof.combinedConfidence}%</strong>
            {proof.ownerUnconfirmed && proof.confidenceIfConfirmed !== undefined && (
              <span className="chip chip-inference"> po potwierdzeniu własności adresu: {proof.confidenceIfConfirmed}%</span>
            )}
            {proof.person && (
              <span className="muted">
                {' '}
                · osoba: {proof.person.fullName ?? 'nie ustalono'} ({proof.person.probability}%)
              </span>
            )}
          </p>
        </div>
      </div>

      <Chain proof={proof} />

      {proof.cluster && (
        <p className="proof-cluster">
          <LayerTag layer="inference" /> Adres początkowy należy do tego samego portfela co <ShortAddress value={proof.cluster.seed} />: {proof.cluster.reason}
        </p>
      )}

      <div className="proof-grid">
        <div>
          <h4>Skąd te liczby</h4>
          <ul className="reasons">
            {proof.components.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p>
            <LayerTag layer="calc" /> Wycena:{' '}
            {trail.valuePln == null ? <span className="muted">brak kursu — kwota tylko w walucie krypto</span> : <strong>{fmtPln(trail.valuePln)}</strong>}
            {trail.valuation && <span className="cell-note">{trail.valuation}</span>}
          </p>
        </div>
        {trail.openQuestions.length > 0 && (
          <section className="request">
            <header>
              <h4>Co potwierdzi giełda lub usługa</h4>
              <div className="actions">
                <CopyButton value={trail.openQuestions.join('\n')} label={`Kopiuj pytania do ${proof.serviceName}`} text="Kopiuj wszystko" />
                {service && available.data && (
                  <a className="button button-small" href={serviceRequestUrl(dossier.runId, service.id)} target="_blank" rel="noopener noreferrer">
                    Materiał do zapytania
                  </a>
                )}
              </div>
            </header>
            <ul>
              {trail.openQuestions.map((question) => (
                <li key={question}>
                  <span>{question}</span>
                  <CopyButton value={question} label="Kopiuj to pytanie" />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <Steps proof={proof} />
    </article>
  );
}

/** Bez udokumentowanej ścieżki pokazujemy dotychczasowe wskaźniki wypłat. */
function IndicatorsOnly() {
  const { dossier, tabHref } = useDossier();
  const rows = cashOutRows(dossier.findings);
  if (rows.length === 0) {
    return (
      <EmptyState title="Brak udokumentowanej ścieżki spieniężenia">
        Analiza nie znalazła przelewów z adresów osoby do giełd ani usług wymiany. Spróbuj trybu głębokiego albo dodaj kolejne identyfikatory.
      </EmptyState>
    );
  }
  return (
    <div className="card">
      <p className="notice" role="note">
        Nie ma udokumentowanej ścieżki krok po kroku. Poniżej wskaźniki możliwych wypłat z danych blockchain — słabsza podstawa, wymagająca weryfikacji.
      </p>
      <ul className="plain-list">
        {rows.map((row) => (
          <li key={`${row.txid}-${row.kind}`}>
            <strong>{CASH_OUT_LABEL[row.kind] ?? row.kind}</strong>: {fmtAmount(row.amount, row.asset)}
            {row.valuePln !== undefined && ` (ok. ${fmtPln(row.valuePln)})`} · {fmtDateTime(row.time)} · {row.counterpartyLabel ?? shorten(row.counterparty)}
          </li>
        ))}
      </ul>
      <p>
        Łącznie {fmtPln(sum(rows.map((row) => row.valuePln ?? 0)))}. <a href={tabHref('przeplywy')}>Szczegóły w sekcji „Przepływy”</a>.
      </p>
    </div>
  );
}

/** Najwyżej tyle ustaleń widać od razu; reszta pod rozwinięciem. */
const VISIBLE = 4;

export function ProofTab() {
  const { dossier, tabHref } = useDossier();
  const { firm, conditional } = splitProofs(dossier.cashOutProof ?? []);
  const proofs = firm;
  const summary = proofSummary(proofs);
  const explained = (dossier.explanations ?? []).length > 0;
  return (
    <section aria-labelledby="dowod">
      <header className="section-head">
        <div>
          <h2 id="dowod">Dowód spieniężenia</h2>
          <p className="muted">
            Ustalenie dotyczy przekazania środków do usługi, w której krypto można zamienić na waluty tradycyjne. Samą sprzedaż potwierdza dopiero giełda lub usługa.
          </p>
        </div>
      </header>
      {proofs.length === 0 && conditional.length === 0 && (explained ? <Explanations /> : <IndicatorsOnly />)}
      {conditional.length > 0 && (
        <section className="conditional" aria-labelledby="warunkowe">
          <h3 id="warunkowe">Warunkowe — po potwierdzeniu własności adresu ({conditional.length})</h3>
          <p className="muted">
            Ścieżka środków jest udokumentowana, ale adres nie jest przypisany osobie. <a href={tabHref('adresy')}>Potwierdź albo odrzuć adres</a>.
          </p>
          {conditional.map((proof) => (
            <ProofCard key={proof.id} proof={proof} />
          ))}
        </section>
      )}
      {proofs.length > 0 && (
        <>
          <div className="tiles">
            <div className="stat">
              <span className="stat-value">{fmtPln(summary.totalPln)}</span>
              <span className="stat-label">
                łączna szacunkowa wartość udokumentowanych przekazań{summary.unvalued > 0 && ` (${summary.unvalued} bez wyceny)`}
              </span>
              <LayerTag layer="calc" />
            </div>
            <div className="stat">
              <span className="stat-value">{summary.services.length}</span>
              <span className="stat-label">usługi: {summary.services.join(', ')}</span>
              <LayerTag layer="fact" />
            </div>
            <div className="stat">
              <span className="stat-value">{summary.topConfidence}%</span>
              <span className="stat-label">najwyższa łączna pewność ustalenia · ustaleń: {proofs.length}</span>
              <LayerTag layer="calc" />
            </div>
          </div>
          {proofs.slice(0, VISIBLE).map((proof) => (
            <ProofCard key={proof.id} proof={proof} />
          ))}
          {proofs.length > VISIBLE && (
            <details className="fold">
              <summary>Pozostałe ustalenia ({proofs.length - VISIBLE})</summary>
              {proofs.slice(VISIBLE).map((proof) => (
                <ProofCard key={proof.id} proof={proof} />
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
