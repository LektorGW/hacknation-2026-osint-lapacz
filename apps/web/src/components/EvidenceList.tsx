import { useState } from 'react';
import type { StoredEvidence } from '@olcys/core';
import { fmtDateTime, shorten } from '../format.ts';
import { CATEGORY_LABEL, IDENTIFIER_LABEL, IDENTITY_LABEL } from '../labels.ts';
import { ExternalLink } from './common.tsx';

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

function EvidenceItem({ item, address }: { item: StoredEvidence; address: string }) {
  return (
    <li className="evidence">
      <p className="evidence-title">
        <ExternalLink url={item.url}>{item.title || item.url}</ExternalLink>
        {item.archivedAt && (
          <span className="chip chip-archive">wersja archiwalna z {fmtDateTime(item.archivedAt)}</span>
        )}
      </p>
      <Excerpt text={item.excerpt} address={address} />
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

export function EvidenceList({ evidence, address }: { evidence: StoredEvidence[]; address: string }) {
  if (evidence.length === 0) return <p className="muted">Brak zapisanych śladów.</p>;
  return (
    <ol className="evidence-list">
      {evidence.map((item) => (
        <EvidenceItem key={item.id} item={item} address={address} />
      ))}
    </ol>
  );
}
