// „Odpowiedź usługi”: dokument spoza OSINT wprowadzany przez analityka przy karcie usługi.
// Zamyka łańcuch osoba → adres → usługa: usługa potwierdza właściciela konta i wypłatę na rachunek.
// Formularz ma szybką ścieżkę (wklejony JSON) i — w trybach SANDBOX oraz DEMO — przykładową odpowiedź syntetyczną.
import { useId, useState } from 'react';
import type { ServiceLink } from '@olcys/core';
import { api, errorMessage } from '../api.ts';
import { fmtDate, fmtDateTime } from '../format.ts';
import { NETWORK_LABEL } from '../labels.ts';
import { CUSTOMER_IDENTIFIER_KINDS, IDENTITY_OUTCOME_LABEL, bodyFromForm, emptyReplyForm, formFromSample, formHints, parseReplyJson } from '../service-reply.ts';
import type { CustomerIdentifierKind, ReplyForm, ServiceReplyView } from '../service-reply.ts';
import { ExternalDocTag, ShortAddress } from './common.tsx';
import { useDossier } from './DossierContext.tsx';
import { useMode } from './Mode.tsx';
import { useToast } from './Toast.tsx';

const today = () => new Date().toISOString().slice(0, 10);
const fiat = (amount: number, currency: string) => `${amount.toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Jedna zapisana odpowiedź: źródło, zamaskowane dane klienta, dopasowanie i skutki dla ustaleń. */
function ReplyCard({ reply }: { reply: ServiceReplyView }) {
  const { summary, reload } = useDossier();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const customer = reply.payload.customer;
  const payouts = reply.payload.fiatPayouts;

  async function withdraw() {
    setBusy(true);
    try {
      await api.withdrawServiceReply(summary.id, reply.id);
      toast.success('Wycofano odpowiedź usługi — zostaje w rejestrze, wynik przeliczono bez niej.');
      reload();
    } catch (error) {
      toast.error(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`reply-card ${reply.withdrawn ? 'is-withdrawn' : ''} ${reply.contradiction ? 'is-contradiction' : ''}`}>
      <header>
        <ExternalDocTag />
        {reply.payload.syntetyczne && (
          <span className="chip chip-synthetic" title="Odpowiedź wygenerowana przez piaskownicę albo z danych demo — osoby, numery i kwoty są fikcyjne.">
            dane syntetyczne
          </span>
        )}
        <h5>
          {reply.serviceName} · sygn. {reply.reference}
        </h5>
        {reply.withdrawn ? (
          <span className="chip chip-warn">wycofana</span>
        ) : reply.match.matched ? (
          <span className="chip chip-ok">dopasowana do danych sprawy</span>
        ) : (
          <span className="chip">nie dopasowano do danych sprawy</span>
        )}
      </header>
      <p className="muted">
        Otrzymana {fmtDate(reply.receivedAt)} · wprowadzona {fmtDateTime(reply.recordedAt)} przez: {reply.recordedBy}
        {reply.payload.documentHash && (
          <>
            {' '}
            · SHA-256 dokumentu: <code className="mono" title={reply.payload.documentHash}>{reply.payload.documentHash.slice(0, 16)}…</code>
          </>
        )}
        {!reply.serviceKnown && ' · usługa spoza usług powiązanych w sprawie (zapis wymuszony)'}
      </p>

      {reply.withdrawn ? (
        <p className="history-withdrawn">
          Wycofano {fmtDateTime(reply.withdrawnAt)}
          {reply.withdrawnBy ? ` · ${reply.withdrawnBy}` : ''} — odpowiedź nie wpływa już na wynik; zostaje w rejestrze do audytu.
        </p>
      ) : (
        <>
          {reply.contradiction && <p className="reply-contradiction">{reply.contradiction}</p>}
          {customer && (
            <dl>
              {customer.fullName && (
                <>
                  <dt>Klient według usługi</dt>
                  <dd>{customer.fullName}</dd>
                </>
              )}
              {customer.identifierMasked && (
                <>
                  <dt>{customer.identifierKind ?? 'identyfikator'} (zamaskowany)</dt>
                  <dd>
                    <code className="mono">{customer.identifierMasked}</code>
                  </dd>
                </>
              )}
              {customer.accountId && (
                <>
                  <dt>Konto w usłudze</dt>
                  <dd>
                    <code className="mono">{customer.accountId}</code>
                  </dd>
                </>
              )}
              {(customer.emails?.length ?? 0) > 0 && (
                <>
                  <dt>E-mail</dt>
                  <dd>{customer.emails!.join(', ')}</dd>
                </>
              )}
              {(customer.phones?.length ?? 0) > 0 && (
                <>
                  <dt>Telefon</dt>
                  <dd>{customer.phones!.join(', ')}</dd>
                </>
              )}
              {customer.registeredAt && (
                <>
                  <dt>Konto założone</dt>
                  <dd>{fmtDate(customer.registeredAt)}</dd>
                </>
              )}
            </dl>
          )}
          <p>
            <strong>Dopasowanie:</strong> {reply.match.text}
          </p>
          {reply.match.matched && (
            <>
              <p>
                <strong>Skutki dla ustaleń</strong>
              </p>
              <ul>
                <li>
                  Ustalenie osoby — {IDENTITY_OUTCOME_LABEL[reply.identity.outcome]}. {reply.identity.text}
                  {reply.identity.basis.length > 0 && <span className="muted"> {reply.identity.basis.join(' ')}</span>}
                </li>
                <li>Wskaźnik C (wyjście do walut tradycyjnych) — {reply.fiatExit.text}</li>
              </ul>
              <details className="fold">
                <summary>
                  Transakcje objęte odpowiedzią i wypłaty ({reply.match.addresses.reduce((count, item) => count + item.txids.length, 0)} / {payouts.length})
                </summary>
                <ul className="plain-list">
                  {reply.match.addresses.map((item) => (
                    <li key={item.key}>
                      <ShortAddress value={item.address} /> <span className="muted">({NETWORK_LABEL[item.network as keyof typeof NETWORK_LABEL] ?? item.network})</span>:{' '}
                      {item.txids.map((txid) => (
                        <code key={txid} className="mono" title={txid}>
                          {txid.slice(0, 12)}…{' '}
                        </code>
                      ))}
                      {item.excluded && <span className="chip">adres wykluczony — bez wpływu</span>}
                    </li>
                  ))}
                </ul>
                {payouts.length > 0 && (
                  <div className="table-scroll">
                    <table className="table table-dense">
                      <thead>
                        <tr>
                          <th scope="col">Wypłata na rachunek (według usługi)</th>
                          <th scope="col" className="num">Kwota</th>
                          <th scope="col">Rachunek (zamaskowany)</th>
                          <th scope="col">Powiązana wpłata</th>
                        </tr>
                      </thead>
                      <tbody>
                        {payouts.map((payout, index) => (
                          <tr key={`${payout.time}-${index}`}>
                            <td>{fmtDateTime(payout.time)}</td>
                            <td className="num">{fiat(payout.amount, payout.currency)}</td>
                            <td>{payout.bankAccountMasked ? <code className="mono">{payout.bankAccountMasked}</code> : '—'}</td>
                            <td>{payout.relatedTxid ? <code className="mono" title={payout.relatedTxid}>{payout.relatedTxid.slice(0, 12)}…</code> : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </details>
            </>
          )}
          {reply.payload.note && <p className="muted">Notatka: {reply.payload.note}</p>}
          <div className="actions">
            <button type="button" className="button button-small" disabled={busy} onClick={withdraw}>
              Wycofaj
            </button>
            <span className="muted">Wycofanie przywraca wynik sprzed odpowiedzi; wpis zostaje w rejestrze.</span>
          </div>
        </>
      )}
    </article>
  );
}

/** Formularz „Wczytaj odpowiedź usługi” dla jednej usługi. */
function ReplyFormPanel({ link }: { link: ServiceLink }) {
  const { summary, reload } = useDossier();
  const { info } = useMode();
  const toast = useToast();
  const uid = useId();
  const [form, setForm] = useState<ReplyForm>(() => emptyReplyForm(today()));
  const [json, setJson] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof ReplyForm>(field: K, value: ReplyForm[K]) => setForm((current) => ({ ...current, [field]: value }));
  // Przykładowa odpowiedź istnieje tylko dla danych syntetycznych: piaskownicy (przez usługę analizy) i wbudowanego demo.
  const canSample = (info.mode === 'sandbox' || info.mode === 'demo') && link.transfers.length > 0;

  async function sample(variant?: 'inna-osoba') {
    setBusy(true);
    setErrors([]);
    try {
      const fetched = await api.getServiceReplySample(summary.id, link.id, variant);
      setForm(formFromSample(fetched, today()));
      setJson(JSON.stringify(fetched.payload, null, 2));
      toast.success('Wczytano przykładową odpowiedź (dane syntetyczne) do formularza — sprawdź i zapisz.');
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setBusy(false);
    }
  }

  function fillFromJson() {
    const parsed = parseReplyJson(json);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setForm((current) => {
      const next = formFromSample(parsed.value, today());
      // Sygnatura i data wpisane ręcznie zostają, jeśli JSON ich nie zawiera.
      return { ...next, reference: next.reference || current.reference, receivedAt: parsed.value.receivedAt ? next.receivedAt : current.receivedAt };
    });
  }

  async function save() {
    const built = bodyFromForm(form, link);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    setErrors([]);
    try {
      await api.addServiceReply(summary.id, built.value);
      toast.success('Zapisano odpowiedź usługi — teczka została przeliczona.');
      setForm(emptyReplyForm(today()));
      setJson('');
      reload();
    } catch (error) {
      setErrors([errorMessage(error)]);
    } finally {
      setBusy(false);
    }
  }

  const hints = formHints(form);
  return (
    <details className="reply-form">
      <summary>Wczytaj odpowiedź usługi</summary>
      <p className="replies-intro">
        Wpisz to, co usługa {link.name} potwierdziła w odpowiedzi na zapytanie uprawnionego organu. Identyfikator klienta i numer rachunku
        są zapisywane wyłącznie w postaci zamaskowanej; treść dokumentu nie jest zapisywana — zostaje tylko jej skrót SHA-256.
      </p>

      {canSample && (
        <div className="actions">
          <button type="button" className="button button-small" disabled={busy} onClick={() => sample()}>
            Pobierz przykładową odpowiedź z piaskownicy
          </button>
          <button type="button" className="button button-small" disabled={busy} onClick={() => sample('inna-osoba')}>
            Wariant: konto należy do innej osoby
          </button>
          <span className="muted">dane syntetyczne — do demonstracji</span>
        </div>
      )}

      <fieldset>
        <legend>Szybka ścieżka: wklej JSON</legend>
        <label htmlFor={`${uid}-json`} className="visually-hidden">
          JSON odpowiedzi usługi
        </label>
        <textarea
          id={`${uid}-json`}
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder={'{ "matches": [{ "txids": ["…"] }], "customer": { "fullName": "…" }, "fiatPayouts": [{ "time": "2025-03-15", "amount": 1000, "currency": "PLN" }] }'}
          spellCheck={false}
        />
        <div className="actions">
          <button type="button" className="button button-small" disabled={busy || !json.trim()} onClick={fillFromJson}>
            Sprawdź JSON i wypełnij formularz
          </button>
        </div>
      </fieldset>

      <div className="reply-grid">
        <label>
          Sygnatura / numer sprawy
          <input type="text" value={form.reference} onChange={(event) => set('reference', event.target.value)} autoComplete="off" />
        </label>
        <label>
          Data otrzymania
          <input type="date" value={form.receivedAt} max={today()} onChange={(event) => set('receivedAt', event.target.value)} />
        </label>
        <label>
          Klient: imię i nazwisko
          <input type="text" value={form.fullName} onChange={(event) => set('fullName', event.target.value)} autoComplete="off" />
        </label>
        <label>
          Rodzaj identyfikatora
          <select value={form.identifierKind} onChange={(event) => set('identifierKind', event.target.value as CustomerIdentifierKind)}>
            {CUSTOMER_IDENTIFIER_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <label>
          Identyfikator klienta <span className="hint">zostanie zamaskowany (ostatnie 4 znaki)</span>
          <input type="text" value={form.identifier} onChange={(event) => set('identifier', event.target.value)} autoComplete="off" />
        </label>
        <label>
          Identyfikator konta w usłudze
          <input type="text" value={form.accountId} onChange={(event) => set('accountId', event.target.value)} autoComplete="off" />
        </label>
        <label>
          E-mail klienta <span className="hint">kilka — po przecinku</span>
          <input type="text" value={form.emails} onChange={(event) => set('emails', event.target.value)} autoComplete="off" />
        </label>
        <label>
          Telefon klienta <span className="hint">kilka — po przecinku</span>
          <input type="text" value={form.phones} onChange={(event) => set('phones', event.target.value)} autoComplete="off" />
        </label>
        <label>
          Konto założone
          <input type="date" value={form.registeredAt} max={today()} onChange={(event) => set('registeredAt', event.target.value)} />
        </label>
        <label>
          Sieć dopasowań
          <select value={form.network} onChange={(event) => set('network', event.target.value)}>
            <option value="">dowolna</option>
            {link.networks.map((network) => (
              <option key={network} value={network}>
                {NETWORK_LABEL[network] ?? network}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="reply-wide">
        <label>
          Adresy wpłat / adresy usługi potwierdzone jako należące do konta klienta <span className="hint">po jednym w wierszu</span>
          <textarea value={form.depositAddresses} onChange={(event) => set('depositAddresses', event.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="reply-wide">
        <label>
          Transakcje potwierdzone przez usługę (txid) <span className="hint">po jednej w wierszu</span>
          <textarea value={form.txids} onChange={(event) => set('txids', event.target.value)} spellCheck={false} />
        </label>
      </div>
      <div className="reply-wide">
        <label>
          Wypłaty na rachunek bankowy <span className="hint">po jednej w wierszu: data; kwota; waluta; rachunek; powiązana transakcja</span>
          <textarea value={form.payouts} onChange={(event) => set('payouts', event.target.value)} placeholder="2025-03-15; 131500; PLN; PL61 1090 …; txid" spellCheck={false} />
        </label>
      </div>
      <div className="reply-wide">
        <label>
          Notatka
          <input type="text" value={form.note} onChange={(event) => set('note', event.target.value)} autoComplete="off" />
        </label>
      </div>
      <div className="reply-wide">
        <label>
          Treść dokumentu (opcjonalnie) <span className="hint">posłuży tylko do policzenia skrótu SHA-256 — nie jest zapisywana</span>
          <textarea value={form.documentText} onChange={(event) => set('documentText', event.target.value)} spellCheck={false} />
        </label>
      </div>
      <p>
        <label>
          <input type="checkbox" checked={form.force} onChange={(event) => set('force', event.target.checked)} /> Zapisz także wtedy, gdy usługa nie zostanie rozpoznana
          wśród usług powiązanych w sprawie
        </label>
      </p>

      {hints.length > 0 && (
        <ul className="reply-hints">
          {hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
      {errors.length > 0 && (
        <ul className="reply-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      <div className="actions">
        <button type="button" className="button" disabled={busy} onClick={save}>
          Zapisz odpowiedź usługi
        </button>
        {form.synthetic && <span className="chip chip-synthetic">dane syntetyczne</span>}
      </div>
    </details>
  );
}

/** Sekcja karty usługi: zapisane odpowiedzi (z wycofanymi) oraz formularz nowej. */
export function ServiceReplyPanel({ link }: { link: ServiceLink }) {
  const { dossier } = useDossier();
  // Starsza usługa analizy nie ma rejestru odpowiedzi — sekcji nie pokazujemy.
  if (dossier.serviceReplies === undefined) return null;
  const replies = dossier.serviceReplies.filter((reply) => reply.serviceId === link.id);
  // Kontrakty i same wzmianki nie są adresatami zapytań; formularz ma sens przy usłudze z przelewami albo zapisanej odpowiedzi.
  if (replies.length === 0 && link.requestHints.length === 0) return null;
  return (
    <section className="replies" aria-label={`Odpowiedzi usługi ${link.name}`}>
      <header>
        <h4>Odpowiedź usługi ({replies.filter((reply) => !reply.withdrawn).length})</h4>
        <ExternalDocTag />
      </header>
      <p className="replies-intro">
        Blockchain nie pokazuje, kto jest klientem usługi ani czy wypłacono pieniądze na rachunek — potwierdza to wyłącznie usługa. Odpowiedź wprowadza
        analityk; narzędzie nie znalazło jej w źródłach publicznych i nie weryfikuje jej autentyczności.
      </p>
      {replies.map((reply) => (
        <ReplyCard key={reply.id} reply={reply} />
      ))}
      <ReplyFormPanel link={link} />
    </section>
  );
}

/** Odpowiedzi zapisane dla usług, których nie ma wśród usług powiązanych w sprawie (zapis wymuszony przez analityka). */
export function OrphanReplies() {
  const { dossier } = useDossier();
  const known = new Set(dossier.serviceLinks.map((link) => link.id));
  const replies = (dossier.serviceReplies ?? []).filter((reply) => !known.has(reply.serviceId));
  if (replies.length === 0) return null;
  return (
    <section className="replies card" aria-label="Odpowiedzi usług spoza listy powiązań">
      <header>
        <h4>Odpowiedzi usług spoza listy powiązań ({replies.length})</h4>
        <ExternalDocTag />
      </header>
      <p className="replies-intro">Odpowiedzi zapisane mimo braku powiązania usługi ze sprawą. Niedopasowane do danych sprawy niczego nie zmieniają.</p>
      {replies.map((reply) => (
        <ReplyCard key={reply.id} reply={reply} />
      ))}
    </section>
  );
}
