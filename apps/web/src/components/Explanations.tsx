// „Czego brakuje i co można zrobić” oraz adresy czekające na potwierdzenie własności.
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { IdentifierType } from '@olcys/core';
import { api, quickCheck, runAnalysis } from '../api.ts';
import { fmtAmount, fmtPln } from '../format.ts';
import { detectIdentifierType, normalizeIdentifier } from '../identify.ts';
import { IDENTIFIER_LABEL, IDENTIFIER_TYPES, NETWORK_LABEL, NETWORK_SHORT } from '../labels.ts';
import { suggestionAction } from '../proof.ts';
import type { Depth, Explanation, RunProgress, UnconfirmedAddress } from '../proof.ts';
import { href, navigate } from '../router.ts';
import { ExternalLink, LayerTag, ScoreBadge, ShortAddress } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { AnalysisProgress } from './Progress.tsx';
import { useToast } from './Toast.tsx';

export const UNCONFIRMED_ANCHOR = 'adresy-do-potwierdzenia';

const KIND_TITLE: Record<Explanation['kind'], string> = {
  service_name: 'To nazwa giełdy lub usługi, nie osoby',
  no_addresses: 'Nie znaleziono adresów kryptowalutowych',
  only_unconfirmed: 'Znalezione adresy nie są potwierdzone',
  widely_cited: 'Adres jest powszechnie cytowany',
  chain_skipped: 'Nie przeanalizowano blockchainu',
  partial: 'Wynik częściowy',
  no_cash_out: 'Brak udokumentowanego spieniężenia',
};

/** Ponowna analiza sprawy (opcjonalnie po dopisaniu identyfikatora) z ekranem postępu. */
function useRerun() {
  const { summary, reload } = useDossier();
  const toast = useToast();
  const [depth, setDepth] = useState<Depth>();
  const [progress, setProgress] = useState<RunProgress>();

  async function rerun(mode: Depth, before?: () => Promise<unknown>) {
    setDepth(mode);
    setProgress(undefined);
    try {
      await before?.();
      await runAnalysis(summary.id, undefined, { depth: mode }, setProgress);
      toast.success('Analiza zakończona — teczka została odświeżona.');
      reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setDepth(undefined);
    }
  }
  return { depth, progress, rerun };
}

function AddIdentifier({ onSubmit, disabled }: { onSubmit: (type: IdentifierType, value: string) => void; disabled: boolean }) {
  const fieldId = useId();
  const [value, setValue] = useState('');
  const [override, setOverride] = useState<IdentifierType>();
  const type = override ?? detectIdentifierType(value);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) onSubmit(type, value);
  }

  return (
    <form className="add-identifier" onSubmit={submit}>
      <label htmlFor={fieldId}>Dodaj identyfikator osoby i ponów analizę</label>
      <div className="add-identifier-row">
        <input
          id={fieldId}
          type="text"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setOverride(undefined);
          }}
          placeholder="nick, e-mail, imię i nazwisko, adres profilu albo adres krypto"
          autoComplete="off"
          spellCheck={false}
        />
        <select value={type} onChange={(event) => setOverride(event.target.value as IdentifierType)} aria-label="Typ identyfikatora">
          {IDENTIFIER_TYPES.map((item) => (
            <option key={item} value={item}>
              {IDENTIFIER_LABEL[item]}
            </option>
          ))}
        </select>
        <button type="submit" className="button button-primary" disabled={disabled || !value.trim()}>
          Dodaj i analizuj
        </button>
      </div>
    </form>
  );
}

/** Blok wyjaśnień: dlaczego czegoś nie ma i co analityk może zrobić od ręki. */
export function Explanations() {
  const { dossier, summary, tabHref } = useDossier();
  const toast = useToast();
  const { depth, progress, rerun } = useRerun();
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState<string>();
  const explanations = dossier.explanations ?? [];
  if (explanations.length === 0) return null;
  const busy = depth !== undefined;
  const hasUnconfirmed = (dossier.unconfirmedAddresses ?? []).length > 0;

  async function analyseAddress(address: string) {
    setOpening(address);
    try {
      const created = await quickCheck(address, 'crypto_address', { depth: 'standard' }, () => {});
      navigate(href.case(created.id));
    } catch (error) {
      toast.error(error);
      setOpening(undefined);
    }
  }

  const addAndRerun = (type: IdentifierType, value: string) =>
    rerun('standard', () => api.addIdentifiers(summary.id, [normalizeIdentifier(type, value)]));

  return (
    <section className="card explanations" aria-labelledby="czego-brakuje">
      <h2 id="czego-brakuje">Czego brakuje i co można zrobić</h2>
      {explanations.map((item) => (
        <article key={`${item.kind}-${item.text}`} className="explanation">
          <h3>{KIND_TITLE[item.kind] ?? item.kind}</h3>
          <p>{item.text}</p>
          {item.suggestions.length > 0 && (
            <ul className="suggestions">
              {item.suggestions.map((suggestion) => {
                const action = suggestionAction(suggestion);
                return (
                  <li key={suggestion}>
                    <span>{suggestion}</span>
                    {action === 'add_identifier' && (
                      <button type="button" className="button button-small" aria-expanded={adding} onClick={() => setAdding(!adding)}>
                        Dodaj identyfikator
                      </button>
                    )}
                    {action === 'deep' && (
                      <button type="button" className="button button-small" disabled={busy} onClick={() => rerun('deep')}>
                        Uruchom tryb głęboki
                      </button>
                    )}
                    {action === 'confirm' && (
                      <a className="button button-small" href={hasUnconfirmed ? `${tabHref('adresy')}` : tabHref('profile')}>
                        {hasUnconfirmed ? 'Potwierdź adres' : 'Potwierdź profil'}
                      </a>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {(item.addresses ?? []).length > 0 && (
            <>
              <h4>Publicznie oznaczone adresy tej usługi</h4>
              <ul className="service-addresses">
                {item.addresses!.map((entry) => (
                  <li key={`${entry.network}:${entry.address}`}>
                    <span className="chip chip-network">{NETWORK_SHORT[entry.network as keyof typeof NETWORK_SHORT] ?? entry.network}</span>
                    <ShortAddress value={entry.address} />
                    <span className="muted">{entry.label}</span>
                    <button type="button" className="button button-small" disabled={opening !== undefined} onClick={() => analyseAddress(entry.address)}>
                      {opening === entry.address ? 'Analiza…' : 'Analizuj ten adres'}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>
      ))}
      {(adding || explanations.some((item) => item.kind === 'no_addresses')) && <AddIdentifier onSubmit={addAndRerun} disabled={busy} />}
      {depth && <AnalysisProgress title="Analiza w toku" progress={progress} depth={depth} />}
    </section>
  );
}

function UnconfirmedItem({ item }: { item: UnconfirmedAddress }) {
  const { decide } = useDossier();
  const [busy, setBusy] = useState(false);

  // Potwierdzenie wysyła wszystkie decyzje wskazane przez usługę; odrzucenie dotyczy samego adresu.
  async function send(decision: 'confirmed' | 'rejected') {
    setBusy(true);
    try {
      const targets = decision === 'confirmed' && item.confirmWith.length > 0 ? item.confirmWith : [{ target: 'address' as const, key: `${item.network}:${item.address}` }];
      for (const target of targets) await decide(target.target, target.key, decision, decision === 'confirmed' ? 'Potwierdzono własność adresu' : 'To nie jest adres tej osoby');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="unconfirmed">
      <header>
        <span className="chip chip-network">{NETWORK_SHORT[item.network] ?? item.network}</span>
        <code className="mono address">{item.address}</code>
        <span title="Prawdopodobieństwo, że adres należy do osoby ze sprawy">
          <ScoreBadge score={item.personAddressProbability} />
        </span>
      </header>
      <p className="muted">
        {NETWORK_LABEL[item.network] ?? item.network} · źródła:{' '}
        {item.sources.map((source) => (
          <span key={source.url}>
            <ExternalLink url={source.url}>{source.service}</ExternalLink>
            {source.author && ` (${source.author})`}{' '}
          </span>
        ))}
      </p>
      <ul className="reasons">
        {item.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {item.chain ? (
        <dl className="meta">
          <div>
            <dt>Przelewy</dt>
            <dd>{item.chain.transfers}</dd>
          </div>
          <div>
            <dt>Otrzymano / wysłano</dt>
            <dd>
              {fmtAmount(item.chain.totalReceived, item.chain.asset)} / {fmtAmount(item.chain.totalSent, item.chain.asset)}
            </dd>
          </div>
          <div>
            <dt>Rozpoznane usługi</dt>
            <dd>{item.chain.services.join(', ') || 'brak'}</dd>
          </div>
          <div>
            <dt>Ścieżki do usług / szacunek</dt>
            <dd>
              {item.chain.trails} · {item.chain.cashOutPlnTotal > 0 ? fmtPln(item.chain.cashOutPlnTotal) : 'bez wyceny'}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="muted">Nie analizowano blockchainu dla tego adresu.</p>
      )}
      <div className="actions">
        <button type="button" className="button button-primary" disabled={busy} onClick={() => send('confirmed')}>
          To adres tej osoby
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => send('rejected')}>
          To nie jej adres
        </button>
      </div>
    </article>
  );
}

/** Adresy znalezione, ale nieprzypisane osobie — jedna decyzja analityka przelicza teczkę. */
export function UnconfirmedAddresses({ compact = false }: { compact?: boolean }) {
  const { dossier, tabHref } = useDossier();
  const items = dossier.unconfirmedAddresses ?? [];
  if (items.length === 0) return null;
  if (compact) {
    return (
      <p className="unconfirmed-short">
        <LayerTag layer="inference" /> <strong>Adresy do potwierdzenia: {items.length}</strong> — {items.map((item) => `${NETWORK_SHORT[item.network] ?? item.network} ${item.address.slice(0, 8)}…`).join(', ')}.{' '}
        <a href={tabHref('adresy')}>Potwierdź albo odrzuć</a>
      </p>
    );
  }
  return (
    <section className="card unconfirmed-section" id={UNCONFIRMED_ANCHOR} aria-labelledby="do-potwierdzenia">
      <h2 id="do-potwierdzenia">
        Adresy do potwierdzenia ({items.length}) <LayerTag layer="inference" />
      </h2>
      <p className="muted">Znalezione w źródłach, ale nieprzypisane osobie. Potwierdzenie od razu przelicza teczkę i dowody spieniężenia.</p>
      {items.map((item) => (
        <UnconfirmedItem key={`${item.network}:${item.address}`} item={item} />
      ))}
    </section>
  );
}
