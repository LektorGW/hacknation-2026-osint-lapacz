// „Powiązane tożsamości”: inne nazwiska i konta, do których prowadzą ślady podmiotu.
import { useState } from 'react';
import { api, quickCheck } from '../api.ts';
import { fmtAmount, fmtPln, sum } from '../format.ts';
import { NETWORK_SHORT } from '../labels.ts';
import { RELATION_LEVEL, RELATION_TEXT, basisText, identityAccounts, identityIdentifiers, identityStatus, isAddressLead, parseIdentityId, sortIdentities } from '../identities.ts';
import type { IdentityEvidence, LinkedIdentity } from '../identities.ts';
import { href, navigate } from '../router.ts';
import { EmptyState, ExternalLink, Initial, LayerTag, ScoreBadge, ShortAddress } from './common.tsx';
import { EvidenceRefItem, StatusBadge } from './Indicators.tsx';
import { SyntheticTag } from './Mode.tsx';
import { useDossier } from './DossierContext.tsx';
import { Score } from './ui/Score.tsx';
import { Term } from './ui/Term.tsx';
import { useToast } from './Toast.tsx';

const IDENTITY_STATUS_LABEL = { hypothesis: 'hipoteza', confirmed: 'potwierdzona', rejected: 'odrzucona' } as const;

function Evidence({ item }: { item: IdentityEvidence }) {
  return <EvidenceRefItem item={item} />;
}

function IdentityCard({ identity }: { identity: LinkedIdentity }) {
  const { decide } = useDossier();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const lead = isAddressLead(identity);
  const status = identityStatus(identity);
  const rejected = status === 'rejected';
  const accounts = identityAccounts(identity);
  const origin = parseIdentityId(identity.id);
  const total = sum(Object.values(identity.cashOutPlnByYear));

  async function sendAll(decision: 'confirmed' | 'rejected') {
    setBusy(true);
    try {
      for (const target of identity.mergeWith) {
        await decide(target.target, target.key, decision, decision === 'confirmed' ? `Potwierdzono wspólnego operatora z „${identity.displayName}”` : `Odrzucono hipotezę wspólnego operatora z „${identity.displayName}”`);
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
            {accounts.length > 0
              ? `konta: ${accounts.map((account) => account.replace('|', ' · ')).join(', ')}`
              : identity.handles.length > 0
                ? `konta: ${identity.handles.join(', ')}${origin.service ? ` (${origin.service})` : ''}`
                : lead
                  ? 'trop bez profilu — znany tylko adres'
                  : 'bez nazw kont'}
          </p>
        </div>
        <div className="identity-relation">
          <StatusBadge status={status} label={IDENTITY_STATUS_LABEL[status]} />
          <strong>{RELATION_TEXT[identity.relation] ?? identity.relation}</strong>
          <Score value={identity.score} kind="strength" reasons={identity.path} caption="siła powiązania" />
        </div>
      </header>
      {rejected && <p className="status status-rejected">Hipoteza odrzucona przez analityka — tożsamość zostaje jako powiązana</p>}
      {status === 'confirmed' && <p className="status status-ok">✓ Wspólny operator potwierdzony decyzją analityka</p>}
      {status === 'hypothesis' && (
        <p className="identity-hypothesis">
          <span className="status status-inference">
            <Term id="hipoteza-operatora">hipoteza</Term>
          </span>{' '}
          przypuszczenie narzędzia, a nie ustalenie — wymaga Twojej decyzji.
        </p>
      )}

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
                        <ExternalLink url={profile.url}>{profile.service}</ExternalLink> <SyntheticTag source={{ service: profile.service, url: profile.url }} />
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
                Potwierdź wspólnego operatora — scal
              </button>
            )}
            {identity.mergeWith.length > 0 && !rejected && (
              <button type="button" className="button" disabled={busy} onClick={() => sendAll('rejected')}>
                Odrzuć hipotezę — zostaw jako powiązaną
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
  const weakHidden = typeof dossier.weakLeadsHidden === 'number' ? dossier.weakLeadsHidden : 0;
  return (
    <section aria-labelledby="tozsamosci">
      <header className="section-head">
        <div>
          <h2 id="tozsamosci">
            <Term id="tozsamosc-powiazana">Powiązane tożsamości</Term> ({identities.length})
          </h2>
          <p className="muted">
            Każde konto podmiotu jest punktem wyjścia do dalszych ścieżek: ten sam adres, telefon lub adres wpłat giełdy pod inną nazwą. Każde powiązanie
            to hipoteza wspólnego operatora — potwierdzenie albo odrzucenie jest decyzją analityka.
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
      {weakHidden > 0 && (
        <p className="muted weak-leads" title="Tropy zbyt słabe, żeby pokazywać je jako powiązane tożsamości">
          słabe tropy niewykazane: {weakHidden}
        </p>
      )}
    </section>
  );
}
