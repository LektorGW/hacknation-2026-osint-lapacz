// „Powiązane tożsamości”: inne nazwiska i konta, do których prowadzą ślady podmiotu.
import { useState } from 'react';
import { api, quickCheck } from '../api.ts';
import { fmtAmount, fmtPln, shorten, sum } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import { RELATION_LEVEL, RELATION_TEXT, basisText, explorerForTxid, identityIdentifiers, isAddressLead, sortIdentities } from '../identities.ts';
import type { IdentityEvidence, LinkedIdentity } from '../identities.ts';
import { href, navigate } from '../router.ts';
import { CopyButton, EmptyState, ExternalLink, Initial, LayerTag, ScoreBadge, ShortAddress } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { useToast } from './Toast.tsx';

function Evidence({ item }: { item: IdentityEvidence }) {
  const { dossier } = useDossier();
  if (item.kind === 'url') return <ExternalLink url={item.value} />;
  if (item.kind === 'address') return <ShortAddress value={item.value} />;
  if (item.kind === 'txid') {
    const explorer = explorerForTxid(dossier.findings, item.value);
    return explorer ? (
      <ExternalLink url={explorer}>transakcja {shorten(item.value, 8, 6)}</ExternalLink>
    ) : (
      <span className="evidence-txid">
        transakcja <code className="mono" title={item.value}>{shorten(item.value, 8, 6)}</code> <CopyButton value={item.value} label="Kopiuj identyfikator transakcji" />
      </span>
    );
  }
  return <span className="chip">{item.value}</span>;
}

function IdentityCard({ identity }: { identity: LinkedIdentity }) {
  const { decide } = useDossier();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lead = isAddressLead(identity);
  const rejected = identity.decision === 'rejected';
  const total = sum(Object.values(identity.cashOutPlnByYear));

  async function sendAll(decision: 'confirmed' | 'rejected') {
    setBusy(true);
    try {
      for (const target of identity.mergeWith) {
        await decide(target.target, target.key, decision, decision === 'confirmed' ? `Scalono z tożsamością „${identity.displayName}”` : `„${identity.displayName}” to inna osoba`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openCase() {
    setBusy(true);
    try {
      const created = lead
        ? await quickCheck(identity.addresses[0]!.address, 'crypto_address', { depth: 'standard' }, () => {})
        : await api.createCase(identity.displayName, identityIdentifiers(identity));
      toast.success(`Założono sprawę „${created.name}”.`);
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setBusy(false);
    }
  }

  return (
    <article className={`card identity level-${RELATION_LEVEL[identity.relation]} ${rejected ? 'is-rejected' : ''}`}>
      <header className="identity-head">
        <Initial name={identity.displayName} />
        <div>
          <h3>{identity.displayName}</h3>
          <p className="muted">
            {identity.fullName && identity.fullName !== identity.displayName && `${identity.fullName} · `}
            {identity.handles.length > 0 ? `konta: ${identity.handles.join(', ')}` : lead ? 'trop bez profilu — znany tylko adres' : 'bez nazw kont'}
          </p>
        </div>
        <div className="identity-relation">
          <strong>{RELATION_TEXT[identity.relation] ?? identity.relation}</strong>
          <span className="bar bar-wide">
            <span className="bar-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={identity.score} aria-label={`Siła powiązania z ${identity.displayName}`}>
              <span className="bar-fill" style={{ width: `${Math.max(0, Math.min(100, identity.score))}%` }} />
            </span>
            <span className="bar-value">{identity.score}</span>
          </span>
        </div>
      </header>
      {rejected && <p className="chip chip-warn">Analityk uznał: inna osoba — zostaje jako powiązana</p>}

      <section className="path" aria-label="Ścieżka dojścia od podmiotu do tej tożsamości">
        <h4>
          Ścieżka dojścia <LayerTag layer="inference" />
        </h4>
        <ol>
          {identity.path.map((step, index) => (
            <li key={index}>
              <span className="path-mark" aria-hidden="true">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <div className="identity-grid">
        <div>
          <h4>Przesłanki i dowody</h4>
          <ul className="identity-reasons">
            {identity.reasons.map((reason) => (
              <li key={reason.text}>
                {reason.text}
                {reason.evidence.length > 0 && (
                  <span className="identity-evidence">
                    {reason.evidence.map((item, index) => (
                      <Evidence key={`${item.kind}-${item.value}-${index}`} item={item} />
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          {identity.profiles.length > 0 && (
            <>
              <h4>Profile ({identity.profiles.length})</h4>
              <ul className="mini-list">
                {identity.profiles.map((profile) => (
                  <li key={profile.id} className="mini">
                    <Initial name={profile.service} />
                    <span className="mini-text">
                      <span className="mini-title">
                        <ExternalLink url={profile.url}>{profile.service}</ExternalLink>
                      </span>
                      <span className="mini-sub">{profile.handle ?? 'bez nazwy konta'}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Adresy ({identity.addresses.length})</h4>
          <ul className="plain-list">
            {identity.addresses.map((item) => (
              <li key={`${item.network}:${item.address}`}>
                <span className="chip chip-network">{NETWORK_SHORT[item.network as keyof typeof NETWORK_SHORT] ?? item.network}</span>
                <ShortAddress value={item.address} /> <span className="muted">— {basisText(item.basis)}</span>
              </li>
            ))}
          </ul>
          {total > 0 && (
            <p>
              <LayerTag layer="calc" /> Szacowane wypłaty tej tożsamości (liczone osobno od podmiotu):{' '}
              {Object.entries(identity.cashOutPlnByYear)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([year, value]) => `${year}: ${fmtPln(value)}`)
                .join(' · ')}
            </p>
          )}
          {identity.cashOutProof.length > 0 && (
            <ul className="plain-list identity-proofs">
              {identity.cashOutProof.map((proof) => (
                <li key={proof.id} title={proof.statement}>
                  <ScoreBadge score={proof.trailConfidence} title="Pewność ścieżki" /> {fmtAmount(proof.amount, proof.asset)}
                  {proof.valuePln != null && ` (ok. ${fmtPln(proof.valuePln)})`} → <strong>{proof.serviceName}</strong>{' '}
                  <span className="muted">
                    · {proof.hops} {proof.hops === 1 ? 'krok' : 'kroki'} · z <ShortAddress value={proof.address} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {identity.note && <p className="identity-note">{identity.note}</p>}

      <div className="actions">
        {lead ? (
          <button type="button" className="button button-primary" disabled={busy} onClick={openCase}>
            Analizuj ten adres
          </button>
        ) : (
          <>
            {identity.mergeWith.length > 0 && (
              <button type="button" className="button button-primary" disabled={busy} onClick={() => sendAll('confirmed')}>
                To ta sama osoba — scal
              </button>
            )}
            {identity.mergeWith.length > 0 && !rejected && (
              <button type="button" className="button" disabled={busy} onClick={() => sendAll('rejected')}>
                Inna osoba — zostaw jako powiązaną
              </button>
            )}
            <button type="button" className="button" disabled={busy} onClick={openCase}>
              Załóż osobną sprawę
            </button>
          </>
        )}
      </div>
    </article>
  );
}

export function IdentitiesTab() {
  const { dossier } = useDossier();
  const identities = sortIdentities(dossier.linkedIdentities ?? []);
  return (
    <section aria-labelledby="tozsamosci">
      <header className="section-head">
        <div>
          <h2 id="tozsamosci">Powiązane tożsamości ({identities.length})</h2>
          <p className="muted">
            Każdy profil podmiotu jest punktem wyjścia do dalszych ścieżek: ten sam adres, telefon lub adres wpłat giełdy pod innym nazwiskiem. To wskazania
            do weryfikacji — scalenie jest decyzją analityka.
          </p>
        </div>
      </header>
      {identities.length === 0 ? (
        <EmptyState title="Nie znaleziono powiązanych tożsamości">
          Ślady podmiotu nie prowadzą do innych nazwisk ani kont. Tryb głęboki i dodatkowe identyfikatory poszerzają poszukiwania.
        </EmptyState>
      ) : (
        identities.map((identity) => <IdentityCard key={identity.id} identity={identity} />)
      )}
    </section>
  );
}
