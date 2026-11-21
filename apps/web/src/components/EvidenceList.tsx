import { useState } from 'react';
import type { TextInsight } from '@olcys/core';
import type { EvidenceWithInsight } from '../proof.ts';
import { useDossier } from './DossierContext.tsx';
import { fmtDateTime, shorten } from '../format.ts';
import { CATEGORY_LABEL, IDENTIFIER_LABEL, IDENTITY_LABEL } from '../labels.ts';
import { ExternalLink, LayerTag } from './common.tsx';
import { SyntheticTag } from './Mode.tsx';
import { currentDecision } from '../decisions.ts';
import type { DecisionRecord } from '../decisions.ts';

/** Cytat ze źródła jako zwykły tekst, z wyróżnionym adresem. */
function Excerpt({ text, address }: { text: string; address: string }) {
  const parts = text.split(address);
  return (
    <blockquote className="excerpt">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 && <mark>{address}</mark>}
          {part}
        </span>
      ))}
    </blockquote>
  );
}

function ContentHash({ hash }: { hash: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <span className="hash">
      <code className="mono">{expanded ? hash : shorten(hash, 12, 8)}</code>{' '}
      <button
        type="button"
        className="link-button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'zwiń' : 'pokaż cały'}
      </button>
    </span>
  );
}

const OWNERSHIP_LABEL: Record<TextInsight['ownership'], string> = {
  own_address: 'autor podaje własny adres',
  third_party_address: 'adres należy do kogoś innego',
  warning_about_address: 'ostrzeżenie o cudzym adresie',
  quoted: 'adres tylko zacytowany',
  unclear: 'nie da się rozstrzygnąć',
};

const OFFER_SIDE: Record<NonNullable<TextInsight['offer']>['side'], string> = {
  sell: 'sprzedaż',
  buy: 'kupno',
  exchange: 'wymiana',
  accepts_payment: 'przyjmowanie płatności',
};

/** Odczyty, po których ślad nie jest wliczany do wyniku. */
const EXCLUDING: TextInsight['ownership'][] = ['third_party_address', 'warning_about_address', 'quoted'];

/** Odczyt treści przez model językowy — zawsze sugestia, którą analityk może cofnąć. */
function Insight({ evidenceId, insight }: { evidenceId: string; insight: TextInsight }) {
  const { dossier, decide, undo } = useDossier();
  const override = currentDecision(dossier.decisions as DecisionRecord[], 'evidence', evidenceId);
  const { offer } = insight;
  return (
    <aside className="insight">
      <p className="insight-head">
        <strong>Sugestia modelu</strong> <LayerTag layer="inference" />
        <span className="muted">
          {insight.model} · wersja polecenia {insight.promptVersion}
        </span>
      </p>
      <p>
        Czyj jest adres: <strong>{OWNERSHIP_LABEL[insight.ownership] ?? insight.ownership}</strong>
        {insight.quote && <> — na podstawie fragmentu „{insight.quote}”</>}
      </p>
      {offer && (
        <p>
          Oferta: {OFFER_SIDE[offer.side] ?? offer.side}
          {offer.amount !== undefined && ` ${offer.amount.toLocaleString('pl-PL')}`}
          {offer.asset && ` ${offer.asset}`}
          {offer.currency && ` za ${offer.currency}`}
          {offer.paymentMethods.length > 0 && ` · płatność: ${offer.paymentMethods.join(', ')}`}
          {offer.location && ` · ${offer.location}`}
        </p>
      )}
      {insight.translationPl && (
        <details className="why">
          <summary>Tłumaczenie na polski (język źródła: {insight.language})</summary>
          <p>{insight.translationPl}</p>
        </details>
      )}
      {EXCLUDING.includes(insight.ownership) &&
        (override ? (
          <p>
            Wpływ modelu cofnięty decyzją analityka.{' '}
            <button type="button" className="button button-small" onClick={() => undo(override.id)}>
              Przywróć odczyt modelu
            </button>
          </p>
        ) : (
          <p>
            Z powodu tego odczytu ślad nie jest wliczany do wyniku.{' '}
            <button type="button" className="button button-small" onClick={() => decide('evidence', evidenceId, 'confirmed', 'Cofnięto wpływ modelu')}>
              Cofnij wpływ modelu
            </button>
          </p>
        ))}
    </aside>
  );
}

function EvidenceItem({ item, address }: { item: EvidenceWithInsight; address: string }) {
  return (
    <li className="evidence">
      <p className="evidence-title">
        <ExternalLink url={item.url}>{item.title || item.url}</ExternalLink>
        <SyntheticTag source={{ connectorId: item.connectorId, service: item.service, url: item.url }} />
        {item.archivedAt && (
          <span className="chip chip-archive">wersja archiwalna z {fmtDateTime(item.archivedAt)}</span>
        )}
      </p>
      <Excerpt text={item.excerpt} address={address} />
      {item.insight && <Insight evidenceId={item.id} insight={item.insight} />}
      <dl className="meta">
        <div>
          <dt>Usługa</dt>
          <dd>{item.service}</dd>
        </div>
        <div>
          <dt>Autor</dt>
          <dd>{item.author ?? 'nie podano'}</dd>
        </div>
        <div>
          <dt>Opublikowano</dt>
          <dd>{item.publishedAt ? fmtDateTime(item.publishedAt) : 'źródło nie podaje'}</dd>
        </div>
        <div>
          <dt>Pozyskano</dt>
          <dd>{fmtDateTime(item.capturedAt)}</dd>
        </div>
        <div>
          <dt>Rodzaj źródła</dt>
          <dd>{CATEGORY_LABEL[item.category] ?? item.category}</dd>
        </div>
        <div>
          <dt>Odnaleziono przez</dt>
          <dd>
            {IDENTIFIER_LABEL[item.matchedIdentifier.type] ?? item.matchedIdentifier.type}:{' '}
            {item.matchedIdentifier.value}
          </dd>
        </div>
        <div className="meta-wide">
          <dt>Czy to profil badanego podmiotu</dt>
          <dd>
            {IDENTITY_LABEL[item.identityMatch] ?? item.identityMatch}
            {item.identityReasons?.length ? ` — ${item.identityReasons.join(' ')}` : ''}
          </dd>
        </div>
        <div className="meta-wide">
          <dt>SHA-256 treści</dt>
          <dd>
            <ContentHash hash={item.contentHash} />
          </dd>
        </div>
      </dl>
    </li>
  );
}

export function EvidenceList({ evidence, address }: { evidence: EvidenceWithInsight[]; address: string }) {
  if (evidence.length === 0) return <p className="muted">Brak zapisanych śladów.</p>;
  return (
    <ol className="evidence-list">
      {evidence.map((item) => (
        <EvidenceItem key={item.id} item={item} address={address} />
      ))}
    </ol>
  );
}
