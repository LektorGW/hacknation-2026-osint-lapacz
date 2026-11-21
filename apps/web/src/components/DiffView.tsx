import type { RunDiff } from '@olcys/core';
import type { Replacement } from '../api.ts';
import { ExternalLink, ScoreBadge } from './common.tsx';

function AddressList({ title, addresses, empty }: { title: string; addresses: string[]; empty: string }) {
  return (
    <section className="diff-block">
      <h4>
        {title} ({addresses.length})
      </h4>
      {addresses.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <ul className="plain-list">
          {addresses.map((address) => (
            <li key={address}>
              <code className="mono address">{address}</code>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Lista podmian adresu w tym samym miejscu publikacji. */
export function ReplacementList({ items }: { items: Replacement[] }) {
  return (
    <ul className="plain-list replacements">
      {items.map((item) => (
        <li key={`${item.url}-${item.from}-${item.to}`}>
          <p>
            W miejscu publikacji <ExternalLink url={item.url} /> adres został zmieniony:
          </p>
          <p className="replacement-pair">
            <code className="mono address address-rejected">{item.from}</code>
            <span aria-label="zastąpiony przez">→</span>
            <code className="mono address">{item.to}</code>
          </p>
        </li>
      ))}
    </ul>
  );
}

export function DiffView({ diff }: { diff: RunDiff }) {
  return (
    <div className="diff">
      <div className="diff-grid">
        <AddressList title="Adresy dodane" addresses={diff.addedAddresses} empty="Brak nowych adresów." />
        <AddressList title="Adresy usunięte" addresses={diff.removedAddresses} empty="Żaden adres nie zniknął." />
      </div>

      <section className="diff-block">
        <h4>Zmiany wyniku ({diff.scoreChanges.length})</h4>
        {diff.scoreChanges.length === 0 ? (
          <p className="muted">Wyniki wspólnych adresów nie zmieniły się.</p>
        ) : (
          <ul className="plain-list">
            {diff.scoreChanges.map((change) => (
              <li key={change.address} className="score-change">
                <code className="mono address">{change.address}</code>
                <span>
                  <ScoreBadge score={change.from} /> → <ScoreBadge score={change.to} />{' '}
                  <span className="muted">
                    ({change.to > change.from ? '+' : '−'}
                    {Math.abs(change.to - change.from)} p.p.)
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="diff-block">
        <h4>Podmiany adresów ({diff.replacedAddresses.length})</h4>
        {diff.replacedAddresses.length === 0 ? (
          <p className="muted">Nie wykryto podmian adresu w tym samym miejscu publikacji.</p>
        ) : (
          <ReplacementList items={diff.replacedAddresses} />
        )}
      </section>
    </div>
  );
}
