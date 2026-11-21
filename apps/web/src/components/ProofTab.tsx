// „Dowód spieniężenia”: udokumentowane ścieżki środków od adresu osoby do giełdy lub usługi.
// Przekazania z tego samego adresu do tej samej usługi tworzą jedną kartę z jednym wyjaśnieniem.
import { api, serviceRequestUrl } from '../api.ts';
import { cashOutRows } from '../dossier.ts';
import { fmtAmount, fmtDate, fmtDateTime, fmtPln, fmtPlnCompact, shorten, sum } from '../format.ts';
import { CASH_OUT_LABEL, CLASS_LABEL, NETWORK_SHORT } from '../labels.ts';
import { buildChain, proofSummary, splitProofs } from '../proof.ts';
import { countText, groupProofs, plainComponent } from '../ux.ts';
import type { ProofGroup } from '../ux.ts';
import { Explanations } from './Explanations.tsx';
import { MixerBlock } from './MixerExposure.tsx';
import type { CashOutProof, ChainNode } from '../proof.ts';
import { useAsync } from '../useAsync.ts';
import { CopyButton, EmptyState, ExternalLink, LayerTag, ShortAddress } from './common.tsx';
import { ExternalDocTag } from './ServiceReplies.tsx';
import { useDossier } from './DossierContext.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';

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

function StepsTable({ proof }: { proof: CashOutProof }) {
  return (
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
  );
}

/** Jedno przekazanie na liście w karcie: linia z datą, kwotą i pewnością; ścieżka i wycena po rozwinięciu. */
function TransferItem({ proof, open }: { proof: CashOutProof; open: boolean }) {
  const { trail } = proof;
  const last = trail.hops.at(-1);
  return (
    <li className="pt-item">
      <Disclosure
        defaultOpen={open}
        title={
          <span className="pt-line">
            <span className="pt-date">{last ? fmtDate(last.time) : '—'}</span>
            <span className="pt-amount tabular">{fmtAmount(trail.amount, trail.asset)}</span>
            <span className="pt-pln tabular">{trail.valuePln == null ? 'bez wyceny' : `ok. ${fmtPln(trail.valuePln)}`}</span>
            <span className="pt-hops muted">{countText(trail.hops.length, 'krok', 'kroki', 'kroków')}</span>
          </span>
        }
        meta={<Score value={proof.combinedConfidence} kind="proof" size="sm" plain />}
      >
        <Chain proof={proof} />
        {proof.ownerUnconfirmed && proof.confidenceIfConfirmed !== undefined && (
          <p className="status status-inference">po potwierdzeniu własności adresu: {proof.confidenceIfConfirmed}</p>
        )}
        <Disclosure title="Jak wyceniono" meta={trail.valuePln == null ? 'brak kursu' : fmtPln(trail.valuePln)}>
          {trail.valuation ? <p className="muted small prose">{trail.valuation}</p> : <p className="muted small">Brak kursu z dnia transakcji — kwota tylko w walucie krypto.</p>}
        </Disclosure>
        <Disclosure title="Tabela kroków" meta={countText(trail.hops.length, 'krok', 'kroki', 'kroków')}>
          <StepsTable proof={proof} />
        </Disclosure>
      </Disclosure>
    </li>
  );
}

/** Wynik łączny pokazany jako dwa czynniki i wynik — bez notacji wzorów. */
function WhyScore({ proof }: { proof: CashOutProof }) {
  const reasons = proof.components.map(plainComponent).filter(Boolean);
  return (
    <div className="pt-why">
      <div className="pt-factors" aria-label="Z czego składa się łączna pewność">
        <Score value={proof.personAddressProbability} kind="joint" caption={<Term id="osoba-adres">adres należy do osoby</Term>} />
        <span className="pt-op" aria-hidden="true">
          ×
        </span>
        <Score value={proof.trailConfidence} kind="trail" reasons={proof.trail.reasons} caption={<Term id="pewnosc-sciezki">środki dotarły do usługi</Term>} />
        <span className="pt-op" aria-hidden="true">
          =
        </span>
        <Score value={proof.combinedConfidence} kind="proof" reasons={reasons} caption={<Term id="laczna-pewnosc">łączna pewność</Term>} />
      </div>
      {reasons.length > 0 && (
        <Disclosure title="Skąd te liczby" meta={countText(reasons.length, 'przesłanka', 'przesłanki', 'przesłanek')}>
          <ul className="reasons">
            {reasons.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {proof.person && (
            <p className="muted small">
              Osoba: {proof.person.fullName ?? 'nie ustalono'} · pewność ustalenia osoby {proof.person.probability}.
            </p>
          )}
        </Disclosure>
      )}
    </div>
  );
}

/** Pytania do usługi jako lista kontrolna z kopiowaniem. */
function Questions({ group }: { group: ProofGroup<CashOutProof> }) {
  const { dossier } = useDossier();
  const service = dossier.serviceLinks.find((link) => link.name === group.serviceName);
  const available = useAsync(async () => (service ? api.hasServiceRequest(dossier.runId, service.id) : false), `${dossier.runId}|${service?.id ?? ''}`);
  const questions = [...new Set(group.items.flatMap((proof) => proof.trail.openQuestions))];
  if (questions.length === 0) return null;
  return (
    <section className="pt-questions" aria-label={`Co potwierdzi ${group.serviceName}`}>
      <header>
        <h4>Co potwierdzi giełda lub usługa</h4>
        <div className="actions">
          <CopyButton value={questions.join('\n')} label={`Kopiuj pytania do ${group.serviceName}`} text="Kopiuj wszystkie" />
          {service && available.data && (
            <a className="button button-small button-primary" href={serviceRequestUrl(dossier.runId, service.id)} target="_blank" rel="noopener noreferrer">
              Materiał do zapytania
            </a>
          )}
        </div>
      </header>
      <ol className="checklist">
        {questions.map((question) => (
          <li key={question}>
            <span className="checklist-box" aria-hidden="true" />
            <span className="checklist-text">{question}</span>
            <CopyButton value={question} label="Kopiuj to pytanie" />
          </li>
        ))}
      </ol>
    </section>
  );
}

function ProofGroupCard({ group }: { group: ProofGroup<CashOutProof> }) {
  const { best, items } = group;
  const replies = [...new Map(items.flatMap((proof) => (proof.serviceReply ? [[proof.serviceReply.note, proof.serviceReply] as const] : []))).values()];
  const cluster = items.find((proof) => proof.cluster)?.cluster;
  return (
    <article className="card proof-group">
      <header className="pg-head">
        <div className="pg-title">
          <p className="eyebrow">{CASH_OUT_LABEL[best.trail.serviceKind] ?? best.trail.serviceKind}</p>
          <h3>
            {countText(items.length, 'przekazanie', 'przekazania', 'przekazań')} do usługi {group.serviceName}
          </h3>
          <p className="pg-sub">
            {group.totalPln > 0 && (
              <>
                łącznie <strong className="tabular">ok. {fmtPlnCompact(group.totalPln)}</strong>
              </>
            )}
            {group.unvalued > 0 && <span className="muted"> · bez wyceny: {group.unvalued}</span>}
            {group.years && <> · {group.years}</>}
            {' · z adresu '}
            <ShortAddress value={group.address} />
          </p>
          <p className="pg-tags">
            <span className="chip chip-network">{NETWORK_SHORT[best.network] ?? best.network}</span>
            <span className="chip">{BASIS_TEXT[best.addressBasis]}</span>
            <LayerTag layer={best.layer === 'calculation' ? 'calc' : 'inference'} />
          </p>
        </div>
        <Score value={best.combinedConfidence} kind="proof" size="lg" caption={items.length > 1 ? 'najmocniejsze przekazanie' : 'łączna pewność ustalenia'} reasons={best.components.map(plainComponent).filter(Boolean)} />
      </header>

      {replies.map((reply) => (
        <p key={reply.note} className={`reply-banner ${reply.outcome === 'other_person' ? 'is-contradiction' : reply.outcome === 'confirmed' ? 'is-confirmed' : ''}`} role="note">
          <ExternalDocTag short />{' '}
          <strong>
            {reply.outcome === 'confirmed' ? 'Usługa potwierdziła właściciela konta.' : reply.outcome === 'other_person' ? 'Usługa wskazała inną osobę — sprzeczność do rozstrzygnięcia.' : 'Usługa odpowiedziała, właściciel niezweryfikowany.'}
          </strong>{' '}
          {reply.note}
        </p>
      ))}

      <WhyScore proof={best} />

      {cluster && (
        <p className="proof-cluster">
          <LayerTag layer="inference" /> Adres początkowy należy do tego samego <Term id="klaster-portfela">portfela</Term> co <ShortAddress value={cluster.seed} />: {cluster.reason}
        </p>
      )}

      <h4 className="pt-list-title">{items.length > 1 ? 'Przekazania' : 'Przekazanie'}</h4>
      <ul className="pt-list">
        {items.map((proof, index) => (
          <TransferItem key={proof.id} proof={proof} open={items.length === 1 && index === 0} />
        ))}
      </ul>

      <Questions group={group} />
    </article>
  );
}

/** Bez udokumentowanej ścieżki pokazujemy dotychczasowe wskaźniki wypłat. */
function IndicatorsOnly() {
  const { dossier, tabHref } = useDossier();
  const rows = cashOutRows(dossier.findings);
  if (rows.length === 0) {
    return (
      <EmptyState title="Brak udokumentowanej ścieżki spieniężenia" action={<a className="button" href={tabHref('analizy')}>Ponów analizę w trybie głębokim</a>}>
        Analiza nie znalazła przelewów z adresów osoby do giełd ani usług wymiany. Spróbuj trybu głębokiego albo dodaj kolejne identyfikatory.
      </EmptyState>
    );
  }
  return (
    <div className="card">
      <p className="notice notice-quiet" role="note">
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

/** Najwyżej tyle kart widać od razu; reszta pod rozwinięciem. */
const VISIBLE = 4;

export function ProofTab() {
  const { dossier, tabHref } = useDossier();
  const { firm, conditional } = splitProofs(dossier.cashOutProof ?? []);
  const summary = proofSummary(firm);
  const groups = groupProofs(firm);
  const conditionalGroups = groupProofs(conditional);
  const explained = (dossier.explanations ?? []).length > 0;
  return (
    <section aria-labelledby="dowod">
      <header className="section-head">
        <div>
          <h2 id="dowod">
            <Term id="dowod-spienienia">Dowód spieniężenia</Term>
          </h2>
          <p className="muted small prose">
            Droga środków od adresu osoby do usługi, w której krypto można zamienić na złotówki. Samą sprzedaż i wypłatę potwierdza dopiero giełda lub usługa.
          </p>
        </div>
      </header>
      <MixerBlock />
      {firm.length === 0 && conditional.length === 0 && (explained ? <Explanations /> : <IndicatorsOnly />)}
      {firm.length > 0 && (
        <>
          <div className="tiles">
            <div className="stat">
              <span className="stat-value">{fmtPln(summary.totalPln)}</span>
              <span className="stat-label">
                łączna szacunkowa wartość przekazań{summary.unvalued > 0 && ` (${summary.unvalued} bez wyceny)`}
              </span>
              <LayerTag layer="calc" />
            </div>
            <div className="stat">
              <span className="stat-value">{summary.services.length}</span>
              <span className="stat-label">{summary.services.join(', ')}</span>
              <LayerTag layer="fact" />
            </div>
            <div className="stat">
              <span className="stat-value">{firm.length}</span>
              <span className="stat-label">{countText(firm.length, 'udokumentowane przekazanie', 'udokumentowane przekazania', 'udokumentowanych przekazań')}</span>
              <LayerTag layer="calc" />
            </div>
          </div>
          {groups.slice(0, VISIBLE).map((group) => (
            <ProofGroupCard key={group.key} group={group} />
          ))}
          {groups.length > VISIBLE && (
            <Disclosure title="Pozostałe usługi i adresy" meta={groups.length - VISIBLE}>
              {groups.slice(VISIBLE).map((group) => (
                <ProofGroupCard key={group.key} group={group} />
              ))}
            </Disclosure>
          )}
        </>
      )}
      {conditional.length > 0 && (
        <section className="conditional" aria-labelledby="warunkowe">
          <h3 id="warunkowe">Warunkowe — po potwierdzeniu własności adresu ({conditional.length})</h3>
          <p className="muted small">
            Ścieżka środków jest udokumentowana, ale adres nie jest przypisany osobie. <a href={tabHref('adresy')}>Potwierdź albo odrzuć adres</a>.
          </p>
          {conditionalGroups.map((group) => (
            <ProofGroupCard key={group.key} group={group} />
          ))}
        </section>
      )}
    </section>
  );
}
