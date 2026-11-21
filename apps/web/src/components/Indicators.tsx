// „Wskaźniki”: trzy osobne wskaźniki śledcze — A. konto → portfel, B. wspólny operator,
// C. wyjście do walut tradycyjnych — każdy z jawną tabelą składników.
import type { ReactNode } from 'react';
import type { AccountWalletLink, CashOutAssessment, ClaimStatus, EvidenceRef, Indicator, OperatorHypothesis, ScoreComponent } from '@olcys/core';
import { fmtAmount, fmtPln, scoreLevel, shorten } from '../format.ts';
import { explorerForTxid } from '../identities.ts';
import {
  CASH_OUT_LIMITATION,
  CASH_OUT_STAGES,
  CASH_OUT_STAGE_TEXT,
  CLAIM_STATUS_LABEL,
  CLAIM_STATUS_MEANING,
  CLASS_LABEL,
  HYPOTHESIS_STATUS_LABEL,
  INDEPENDENCE_LABEL,
  NETWORK_SHORT,
  ORDINAL_NOTE,
} from '../labels.ts';
import type { FullDossier } from '../proof.ts';
import { CopyButton, EmptyState, ExternalLink, ShortAddress } from './common.tsx';
import { DecisionControls, DecisionHistory, useDossier } from './DossierContext.tsx';
import { SyntheticTag } from './Mode.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';

/** Odnośnik do eksploratora dla transakcji — tylko gdy teczka go podaje. */
export function txExplorer(dossier: FullDossier, txid: string): string | undefined {
  const direct = explorerForTxid(dossier.findings ?? [], txid);
  if (direct) return direct;
  for (const link of dossier.serviceLinks ?? []) {
    const hit = link.transfers?.find((item) => item.txid === txid);
    if (hit?.explorerUrl) return hit.explorerUrl;
  }
  for (const finding of dossier.findings ?? []) {
    const cashOut = finding.chain?.cashOuts?.find((item) => item.txid === txid);
    if (cashOut?.explorerUrl) return cashOut.explorerUrl;
    for (const trail of finding.chain?.trails ?? []) {
      const hop = trail.hops.find((item) => item.txid === txid);
      if (hop?.explorerUrl) return hop.explorerUrl;
    }
  }
  for (const proof of dossier.cashOutProof ?? []) {
    const hop = proof.trail?.hops?.find((item) => item.txid === txid);
    if (hop?.explorerUrl) return hop.explorerUrl;
  }
  return undefined;
}

/** Jeden dowód: adres URL otwiera się w nowej karcie, transakcja prowadzi do eksploratora, reszta to tekst. */
export function EvidenceRefItem({ item }: { item: EvidenceRef }) {
  const { dossier } = useDossier();
  switch (item.kind) {
    case 'url':
      return (
        <>
          <ExternalLink url={item.value} /> <SyntheticTag source={{ url: item.value }} />
        </>
      );
    case 'txid': {
      const explorer = txExplorer(dossier, item.value);
      return explorer ? (
        <ExternalLink url={explorer}>transakcja {shorten(item.value, 8, 6)}</ExternalLink>
      ) : (
        <span className="evidence-txid">
          transakcja <code className="mono" title={item.value}>{shorten(item.value, 8, 6)}</code> <CopyButton value={item.value} label="Kopiuj identyfikator transakcji" />
        </span>
      );
    }
    case 'address':
      return (
        <span>
          adres <ShortAddress value={item.value} />
        </span>
      );
    case 'evidence_id': {
      const evidence = (dossier.findings ?? []).flatMap((finding) => finding.evidence ?? []).find((entry) => entry.id === item.value);
      return evidence ? (
        <>
          <ExternalLink url={evidence.url}>{evidence.title || evidence.url}</ExternalLink>{' '}
          <SyntheticTag source={{ connectorId: evidence.connectorId, service: evidence.service, url: evidence.url }} />
        </>
      ) : (
        <span>
          ślad <code className="mono">{shorten(item.value, 10, 6)}</code>
        </span>
      );
    }
    case 'decision': {
      // Dowodem może być odpowiedź usługi (dokument spoza OSINT), a nie decyzja analityka o adresie.
      const reply = item.value.startsWith('reply:') ? (dossier.serviceReplies ?? []).find((entry) => `reply:${entry.id}` === item.value) : undefined;
      if (reply) {
        return (
          <span className="chip chip-external" title="Dokument spoza OSINT wprowadzony przez analityka — narzędzie nie weryfikuje jego autentyczności.">
            odpowiedź usługi {reply.serviceName}, sygn. {reply.reference} (dokument spoza OSINT)
          </span>
        );
      }
      return <span className="chip">{item.value.startsWith('reply:') ? 'odpowiedź usługi (dokument spoza OSINT)' : `decyzja analityka: ${shorten(item.value, 14, 6)}`}</span>;
    }
    default:
      return <span className="chip">{item.value}</span>;
  }
}

export function EvidenceRefs({ items }: { items: EvidenceRef[] | undefined }) {
  if (!items || items.length === 0) return <span className="muted">—</span>;
  return (
    <ul className="evidence-refs">
      {items.map((item, index) => (
        <li key={`${item.kind}-${item.value}-${index}`}>
          <EvidenceRefItem item={item} />
        </li>
      ))}
    </ul>
  );
}

export function StatusBadge({ status, label }: { status: string | undefined; label?: string }) {
  const known = (status ?? 'hypothesis') as ClaimStatus;
  // Stany pośrednie hipotezy (zgrupowana automatycznie, zablokowana) wyglądają jak hipoteza — nie jak ustalenie.
  const tone = known in CLAIM_STATUS_LABEL ? known : 'hypothesis';
  return (
    <span className={`status-badge st-${tone}`} title={CLAIM_STATUS_MEANING[tone]}>
      {tone === 'confirmed' && <span aria-hidden="true">✓ </span>}
      {label ?? HYPOTHESIS_STATUS_LABEL[status ?? ''] ?? CLAIM_STATUS_LABEL[tone]}
    </span>
  );
}

/** Liczba wskaźnika z poziomem słownym; podpowiedź przypomina, że to nie jest prawdopodobieństwo. */
export function IndicatorScore({ indicator }: { indicator: Indicator | undefined }) {
  if (!indicator) return <span className="muted">brak wskaźnika</span>;
  // Jednolity wygląd wyniku; poziom z usługi analizy trafia do wyjaśnienia pod przyciskiem „i”.
  return (
    <span className="indicator-score" data-level={scoreLevel(indicator.score)}>
      <Score
        value={indicator.score}
        kind="strength"
        size="sm"
        reasons={(indicator.components ?? []).filter((item) => item.applied !== 0).map((item) => `${item.applied > 0 ? '+' : '−'}${Math.abs(item.applied)} · ${item.explanation}`)}
        extra={indicator.scale ? <p className="score-pop-sub-text">{indicator.scale}</p> : undefined}
      />
    </span>
  );
}

function ComponentRows({ components }: { components: ScoreComponent[] }) {
  return (
    <>
      {components.map((item, index) => (
        <tr key={`${item.rule}-${index}`} className={item.direction === 'contradicts' ? 'is-contra' : item.applied === 0 ? 'is-unapplied' : ''}>
          <td>
            <code className="mono rule-id">{item.rule}</code>
            {item.direction === 'contradicts' && <span className="chip chip-warn">kontrdowód{item.blocking ? ' blokujący' : ''}</span>}
          </td>
          <td className="num">{item.weight > 0 ? `+${item.weight}` : item.weight}</td>
          <td className="num">
            <strong>{item.applied > 0 ? `+${item.applied}` : item.applied}</strong>
          </td>
          <td>{item.source}</td>
          <td>
            <EvidenceRefs items={item.evidence} />
          </td>
          <td>{item.explanation}</td>
          <td>
            {INDEPENDENCE_LABEL[item.independence] ?? item.independence}
            {item.independenceNote && <span className="cell-note">{item.independenceNote}</span>}
          </td>
          <td>
            {(item.limitations ?? []).length === 0 ? (
              <span className="muted">—</span>
            ) : (
              <ul className="plain-list tight">
                {item.limitations.map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

/** Tabela składników wskaźnika: przesłanki potwierdzające i — osobno wyróżnione — kontrdowody. */
export function ComponentTable({ indicator }: { indicator: Indicator | undefined }) {
  const components = indicator?.components ?? [];
  if (components.length === 0) return <p className="muted">Wskaźnik nie ma zapisanych składników.</p>;
  const supports = components.filter((item) => item.direction !== 'contradicts');
  const contradicts = components.filter((item) => item.direction === 'contradicts');
  return (
    <div className="table-scroll">
      <table className="table component-table">
        <thead>
          <tr>
            <th scope="col">Reguła</th>
            <th scope="col" className="num">Waga</th>
            <th scope="col" className="num">Doliczono</th>
            <th scope="col">Źródło</th>
            <th scope="col">Dowód</th>
            <th scope="col">Wyjaśnienie</th>
            <th scope="col">Niezależność</th>
            <th scope="col">Ograniczenia</th>
          </tr>
        </thead>
        <tbody>
          <tr className="component-group">
            <th scope="rowgroup" colSpan={8}>
              Przesłanki potwierdzające ({supports.length})
            </th>
          </tr>
          <ComponentRows components={supports} />
          <tr className="component-group component-group-contra">
            <th scope="rowgroup" colSpan={8}>
              Kontrdowody ({contradicts.length}){contradicts.length === 0 && ' — nie znaleziono przesłanek przeczących'}
            </th>
          </tr>
          <ComponentRows components={contradicts} />
        </tbody>
      </table>
    </div>
  );
}

function IndicatorLimitations({ indicator, extra = [] }: { indicator: Indicator | undefined; extra?: string[] }) {
  const items = [...new Set([...(indicator?.limitations ?? []), ...extra])];
  if (items.length === 0) return null;
  return (
    <aside className="limitations">
      <h4>Ograniczenia wskaźnika</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </aside>
  );
}

function Item({ title, indicator, status, statusLabel, children, details }: { title: ReactNode; indicator: Indicator | undefined; status: string | undefined; statusLabel?: string; children?: ReactNode; details: ReactNode }) {
  return (
    <li className={`indicator-item st-${status ?? 'hypothesis'}`}>
      <header className="indicator-head">
        <div className="indicator-title">{title}</div>
        <IndicatorScore indicator={indicator} />
        <StatusBadge status={status} label={statusLabel} />
      </header>
      {children}
      <Disclosure title="Składniki wskaźnika — przesłanki i kontrdowody" meta={indicator?.components?.length ?? 0}>
        {details}
      </Disclosure>
    </li>
  );
}

function AccountWalletItem({ link }: { link: AccountWalletLink }) {
  return (
    <Item
      indicator={link.indicator}
      status={link.status}
      title={
        <>
          <strong>
            {link.service}
            {link.handle ? ` · ${link.handle}` : ''}
          </strong>{' '}
          <span aria-hidden="true">→</span>{' '}
          <span className="chip chip-network">{NETWORK_SHORT[link.network as keyof typeof NETWORK_SHORT] ?? link.network}</span>
          <ShortAddress value={link.address} />
        </>
      }
      details={
        <>
          <ComponentTable indicator={link.indicator} />
          <IndicatorLimitations indicator={link.indicator} />
        </>
      }
    >
      <p className="indicator-meta">
        <ExternalLink url={link.accountUrl}>konto w serwisie</ExternalLink> <SyntheticTag source={{ service: link.service, url: link.accountUrl, network: link.network }} />
        <span className="muted"> · klasa adresu: {CLASS_LABEL[link.addressClass as keyof typeof CLASS_LABEL] ?? link.addressClass}</span>
      </p>
      {link.notPrivateWallet && (
        <p className="notice notice-inline">
          Publikacja adresu jest odnotowana, ale to <strong>nie jest portfel prywatny konta</strong> (giełda, kontrakt, zbiórka, mikser albo instytucja).
        </p>
      )}
    </Item>
  );
}

export function OperatorHypothesisDetails({ hypothesis }: { hypothesis: OperatorHypothesis }) {
  return (
    <>
      {hypothesis.statement && <p className="indicator-statement">{hypothesis.statement}</p>}
      {(hypothesis.path ?? []).length > 0 && (
        <>
          <h4>Jak narzędzie doszło od jednego konta do drugiego</h4>
          <ol className="plain-list path-steps">
            {hypothesis.path.map((step, index) => (
              <li key={index}>
                {index + 1}. {step}
              </li>
            ))}
          </ol>
        </>
      )}
      <h4>Składniki: przesłanki i kontrdowody</h4>
      <ComponentTable indicator={hypothesis.indicator} />
      <IndicatorLimitations indicator={hypothesis.indicator} />
    </>
  );
}

/** Decyzja analityka o hipotezie wspólnego operatora (cel `link`, klucz = identyfikator hipotezy). */
export function OperatorDecision({ hypothesis }: { hypothesis: OperatorHypothesis }) {
  return (
    <>
      <DecisionControls target="link" decisionKey={hypothesis.id} confirmLabel="Potwierdź wspólnego operatora" rejectLabel="Odrzuć hipotezę" summary="Decyzja analityka o hipotezie" open />
      <h4>Historia zmian</h4>
      <DecisionHistory keys={[hypothesis.id]} empty="Brak decyzji — hipoteza pozostaje przypuszczeniem narzędzia." />
    </>
  );
}

function OperatorItem({ hypothesis }: { hypothesis: OperatorHypothesis }) {
  const [a, b] = hypothesis.accountLabels ?? hypothesis.accounts;
  const [personaA, personaB] = hypothesis.personas ?? [];
  return (
    <Item
      indicator={hypothesis.indicator}
      status={hypothesis.status}
      title={
        <>
          <strong>{a}</strong> <span aria-hidden="true">↔</span> <strong>{b}</strong>
          {(personaA || personaB) && (
            <span className="muted">
              {' '}
              · deklarowane persony: {personaA ?? '—'} / {personaB ?? '—'}
            </span>
          )}
        </>
      }
      details={<OperatorHypothesisDetails hypothesis={hypothesis} />}
    >
      {hypothesis.status === 'blocked' && <p className="notice notice-inline">Kontrdowód twardy blokuje automatyczne połączenie kont — wskaźnik jest ograniczony.</p>}
      {hypothesis.status === 'auto_grouped' && (
        <p className="notice notice-inline">Konta zaliczono do jednego kandydata na podstawie reguł. To nadal wnioskowanie narzędzia, nie ustalenie.</p>
      )}
      <OperatorDecision hypothesis={hypothesis} />
    </Item>
  );
}

function BlockedMerges() {
  const { dossier } = useDossier();
  const label = (id: string) => {
    const profile = dossier.profiles.find((item) => item.id === id);
    return profile ? `${profile.service} · ${profile.handle ?? profile.attributes?.displayName ?? profile.url}` : id;
  };
  const seen = new Set<string>();
  const merges = (dossier.persons ?? [])
    .flatMap((person) => person.blockedMerges ?? [])
    .filter((merge) => {
      const key = [...merge.profileIds].sort().join('<->');
      return seen.has(key) ? false : Boolean(seen.add(key));
    });
  if (merges.length === 0) return null;
  return (
    <section className="blocked-merges" aria-label="Połączenia kont, których nie wykonano">
      <h4>Połączenia, których nie wykonano ({merges.length})</h4>
      <ul className="plain-list">
        {merges.map((merge) => (
          <li key={merge.profileIds.join('<->')}>
            <strong>Nie połączono:</strong> {label(merge.profileIds[0])} <span aria-hidden="true">↔</span> {label(merge.profileIds[1])}{' '}
            <span className="muted">(waga wiązania {merge.weight})</span> — {merge.reason}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Drabina dowodowa wyjścia do fiat: cztery szczeble, osiągnięty wyróżniony. */
export function CashOutLadder({ stage }: { stage: CashOutAssessment['stage'] }) {
  const reached = CASH_OUT_STAGES.indexOf(stage);
  return (
    <ol className="ladder ladder-stepper" aria-label={`Drabina dowodowa wyjścia do walut tradycyjnych — osiągnięty szczebel ${reached + 1} z ${CASH_OUT_STAGES.length}`}>
      {CASH_OUT_STAGES.map((id, index) => (
        <li key={id} className={index < reached ? 'is-passed' : index === reached ? 'is-reached' : 'is-open'} aria-current={index === reached ? 'step' : undefined}>
          <span className="ladder-step" aria-hidden="true">
            {index + 1}
          </span>
          <span className="ladder-text">
            <strong>{CASH_OUT_STAGE_TEXT[id].label}</strong>
            <span className="cell-note">{CASH_OUT_STAGE_TEXT[id].meaning}</span>
            <span className="ladder-state">{index < reached ? 'spełniony' : index === reached ? 'osiągnięty szczebel' : 'nieosiągnięty'}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function CashOutItem({ item }: { item: CashOutAssessment }) {
  return (
    <Item
      indicator={item.indicator}
      status={item.status}
      title={
        <>
          <span className="chip chip-network">{NETWORK_SHORT[item.network as keyof typeof NETWORK_SHORT] ?? item.network}</span>
          <ShortAddress value={item.address} /> <span aria-hidden="true">→</span> <strong>{item.serviceName ?? 'adres bez etykiety usługi'}</strong>
          {item.amount !== undefined && item.asset && <span className="muted"> · {fmtAmount(item.amount, item.asset)}</span>}
          {item.valuePln != null && <span className="muted"> · ok. {fmtPln(item.valuePln)}</span>}
        </>
      }
      details={
        <>
          <ComponentTable indicator={item.indicator} />
          <IndicatorLimitations indicator={item.indicator} />
        </>
      }
    >
      {item.statement && <p className="indicator-statement">{item.statement}</p>}
      <CashOutLadder stage={item.stage} />
      {(item.txids ?? []).length > 0 && (
        <div className="indicator-meta">
          Transakcje: <EvidenceRefs items={item.txids.map((value) => ({ kind: 'txid' as const, value }))} />
        </div>
      )}
    </Item>
  );
}

const byScore = <T extends { indicator?: Indicator }>(items: T[] | undefined): T[] => [...(items ?? [])].sort((a, b) => (b.indicator?.score ?? 0) - (a.indicator?.score ?? 0));

export function IndicatorsTab() {
  const { dossier } = useDossier();
  const indicators = dossier.indicators;
  const accountWallet = byScore(indicators?.accountWallet);
  const commonOperator = byScore(indicators?.commonOperator);
  const cashOut = byScore(indicators?.cashOut);
  const scale = accountWallet[0]?.indicator?.scale ?? commonOperator[0]?.indicator?.scale ?? cashOut[0]?.indicator?.scale ?? ORDINAL_NOTE;
  const interpretation = dossier.findings.find((finding) => finding.confidence?.interpretation)?.confidence.interpretation;
  const hasBlocked = (dossier.persons ?? []).some((person) => (person.blockedMerges ?? []).length > 0);

  return (
    <section aria-labelledby="wskazniki">
      <header className="section-head">
        <div>
          <h2 id="wskazniki">Wskaźniki</h2>
          <p className="muted">Trzy osobne wskaźniki — nie sumuje się ich ani nie mnoży. Każdy ma jawną tabelę składników, którą można odtworzyć i zakwestionować.</p>
        </div>
      </header>
      <p className="notice notice-quiet scale-note" role="note">
        <strong>Jak czytać liczby.</strong> {scale}
        {interpretation && interpretation !== scale && <> {interpretation}</>}
      </p>

      {!indicators && !hasBlocked && (
        <EmptyState title="Ta teczka nie zawiera wskaźników">
          Wskaźniki A/B/C dodaje nowsza wersja usługi analizy. Ponów analizę, żeby je wyliczyć; do tego czasu obowiązuje Wskaźnik Pewności na kartach adresów.
        </EmptyState>
      )}

      {(indicators || hasBlocked) && (
        <>
          <article className="card indicator-card" aria-labelledby="wskaznik-a">
            <h3 id="wskaznik-a">
              <span className="indicator-letter">A</span> Konto → <Term id="adres-krypto">portfel</Term> ({accountWallet.length})
            </h3>
            <p className="muted">Na ile konkretne konto publicznie deklaruje związek z adresem. Nie mówi, kto obsługuje konto.</p>
            {accountWallet.length === 0 ? <p className="muted">Brak pozycji.</p> : <ul className="indicator-list">{accountWallet.map((link) => <AccountWalletItem key={link.id} link={link} />)}</ul>}
          </article>

          <article className="card indicator-card" aria-labelledby="wskaznik-b">
            <h3 id="wskaznik-b">
              <span className="indicator-letter">B</span> <Term id="hipoteza-operatora">Wspólny operator</Term> ({commonOperator.length})
            </h3>
            <p className="muted">
              Na ile dwa konkretne konta może obsługiwać ten sam operator. To hipoteza narzędzia — staje się ustaleniem wyłącznie decyzją analityka albo
              dowodem kryptograficznym.
            </p>
            {commonOperator.length === 0 ? <p className="muted">Brak hipotez wspólnego operatora.</p> : <ul className="indicator-list">{commonOperator.map((item) => <OperatorItem key={item.id} hypothesis={item} />)}</ul>}
            <BlockedMerges />
          </article>

          <article className="card indicator-card" aria-labelledby="wskaznik-c">
            <h3 id="wskaznik-c">
              <span className="indicator-letter">C</span> <Term id="spieniezenie">Wyjście do walut tradycyjnych</Term> ({cashOut.length})
            </h3>
            <p className="muted">
              Na ile dane wskazują wymianę kryptowalut na waluty tradycyjne — według czteroszczeblowej <Term id="szczebel-drabiny">drabiny dowodowej</Term>.
            </p>
            <p className="notice notice-inline" role="note">
              <strong>Stałe ograniczenie.</strong> {CASH_OUT_LIMITATION}
            </p>
            {cashOut.length === 0 ? <p className="muted">Brak pozycji.</p> : <ul className="indicator-list">{cashOut.map((item) => <CashOutItem key={item.id} item={item} />)}</ul>}
          </article>
        </>
      )}
    </section>
  );
}
