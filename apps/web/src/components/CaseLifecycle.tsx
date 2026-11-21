// Cykl życia sprawy w nagłówku teczki: znaczek stanu, zamknięcie z powodem, przywrócenie,
// archiwum do pobrania i usunięcie — z potwierdzeniem nazwą sprawy i sprawdzeniem powiązań z innymi sprawami.
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { ApiError, api, errorMessage } from '../api.ts';
import type { CaseLink, CaseLinks, CaseStatus, CaseSummary } from '../api.ts';
import { fmtDateTime } from '../format.ts';
import { href, navigate } from '../router.ts';
import { useToast } from './Toast.tsx';
import '../lifecycle.css';

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = { open: 'otwarta', closed: 'zamknięta', archived: 'zarchiwizowana' };

const statusOf = (summary: Pick<CaseSummary, 'status'>): CaseStatus => summary.status ?? 'open';

export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  return (
    <span className={`case-status case-status-${status}`} title={status === 'open' ? 'Sprawa otwarta' : `Sprawa ${CASE_STATUS_LABEL[status]} — tylko do odczytu`}>
      {status === 'open' ? 'Otwarta' : status === 'closed' ? 'Zamknięta' : 'Zarchiwizowana'}
    </span>
  );
}

/** Informacja nad teczką zamkniętej sprawy: kiedy, dlaczego i co dalej. */
export function ClosedNotice({ summary }: { summary: CaseSummary }) {
  const status = statusOf(summary);
  if (status === 'open') return null;
  return (
    <div className="notice case-closed-notice" role="note">
      <p>
        <strong>Sprawa {CASE_STATUS_LABEL[status]}</strong>
        {summary.closedAt && <> {fmtDateTime(summary.closedAt)}</>}
        {summary.closedReason && <> — powód: {summary.closedReason}</>}. Teczka jest tylko do odczytu: nie można uruchamiać analiz, zapisywać decyzji ani rozwijać sieci.
        Aby wprowadzić zmiany, użyj „Przywróć”.
      </p>
      {summary.archiveSha256 && (
        <p className="small muted">
          Archiwum z {fmtDateTime(summary.archivedAt)} · SHA-256 <code className="case-hash">{summary.archiveSha256}</code>
        </p>
      )}
    </div>
  );
}

function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Lista powiązanych spraw z powodami (używana przy odmowie usunięcia). */
export function LinkList({ links }: { links: CaseLink[] }) {
  return (
    <ul className="case-links">
      {links.map((link) => (
        <li key={link.caseId} className={link.blocking ? 'is-blocking' : undefined}>
          <a href={href.case(link.caseId)}>{link.caseName}</a> <span className="muted small">({CASE_STATUS_LABEL[link.status]}{link.blocking ? ', blokuje usunięcie' : ''})</span>
          <ul>
            {link.reasons.map((reason) => (
              <li key={reason.kind}>
                {reason.label}
                {reason.values.length > 0 && (
                  <>
                    : <span className="case-link-values">{reason.values.join(', ')}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

function useDialog(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

function CloseDialog({ summary, onClose, onDone }: { summary: CaseSummary; onClose: () => void; onDone: () => void }) {
  const ref = useDialog(true);
  const id = useId();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Podaj powód zamknięcia — zostanie zapisany przy sprawie.');
      return;
    }
    setBusy(true);
    try {
      await api.closeCase(summary.id, reason.trim());
      toast.success(`Zamknięto sprawę „${summary.name}” — jest teraz tylko do odczytu.`);
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="help case-dialog" aria-labelledby={`${id}-tytul`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-tytul`}>Zamknij sprawę</h2>
        <p>
          Zamknięta sprawa jest tylko do odczytu: nie można uruchamiać analiz, zapisywać decyzji ani rozwijać sieci. Obserwacja sprawy („Monitoruj”) zostanie
          wyłączona. Sprawę można później przywrócić.
        </p>
        <label htmlFor={`${id}-powod`}>Powód zamknięcia</label>
        <textarea id={`${id}-powod`} rows={3} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="np. postępowanie zakończone, materiał przekazany" autoFocus />
        {error && <p className="case-dialog-error" role="alert">{error}</p>}
        <div className="case-dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            Anuluj
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Zamykanie…' : 'Zamknij sprawę'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function DeleteDialog({ summary, onClose }: { summary: CaseSummary; onClose: () => void }) {
  const ref = useDialog(true);
  const id = useId();
  const toast = useToast();
  const [check, setCheck] = useState<CaseLinks>();
  const [checkError, setCheckError] = useState<string>();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [blockedBy, setBlockedBy] = useState<CaseLink[]>();

  useEffect(() => {
    api.getCaseLinks(summary.id).then(setCheck, (failure) => setCheckError(errorMessage(failure)));
  }, [summary.id]);

  const blocking = blockedBy ?? check?.links.filter((link) => link.blocking) ?? [];
  const matches = confirm.trim() === summary.name.trim();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!matches) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteCase(summary.id, confirm);
      toast.success(`Usunięto sprawę „${summary.name}”. W bazie został tylko ślad usunięcia (bez danych osobowych) i wpis w dzienniku audytu.`);
      onClose();
      navigate(href.dashboard());
    } catch (failure) {
      const links = failure instanceof ApiError ? (failure.body as { links?: CaseLink[] } | undefined)?.links : undefined;
      if (links) setBlockedBy(links.filter((link) => link.blocking));
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="help case-dialog" aria-labelledby={`${id}-tytul`} onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id={`${id}-tytul`}>Usuń sprawę „{summary.name}”</h2>
        {!check && !checkError && <p className="muted">Sprawdzanie powiązań z innymi sprawami…</p>}
        {checkError && <p className="case-dialog-error" role="alert">{checkError}</p>}
        {blocking.length > 0 ? (
          <div className="status-box status-box-warn" role="alert">
            <p>
              <strong>Nie można usunąć — sprawa jest powiązana z:</strong>
            </p>
            <LinkList links={blocking} />
            <p className="small">Usunięcie zniszczyłoby materiał, na który powołuje się otwarta sprawa. Zamknij lub rozstrzygnij powiązane sprawy i spróbuj ponownie.</p>
          </div>
        ) : (
          check && (
            <>
              <div className="status-box status-box-warn">
                <p>
                  <strong>Usunięcie jest nieodwracalne.</strong> Znikną wszystkie analizy, kopie treści źródeł, decyzje, odpowiedzi usług i rozwinięcia sieci tej
                  sprawy. W bazie zostanie tylko ślad usunięcia (identyfikator, czas, skrót archiwum, liczby — bez danych osobowych) i wpis w dzienniku audytu.
                </p>
                {summary.archiveSha256 ? (
                  <p className="small">
                    Pobrane archiwum (z {fmtDateTime(summary.archivedAt)}, SHA-256 <code className="case-hash">{summary.archiveSha256.slice(0, 16)}…</code>) zachowuje
                    kopię materiału — sprawdź, że je masz.
                  </p>
                ) : (
                  <p className="small">Sprawa nie ma archiwum. Jeśli materiał może być potrzebny, najpierw użyj „Archiwizuj i pobierz”.</p>
                )}
              </div>
              {check.links.length > 0 && (
                <details>
                  <summary>Powiązania z zamkniętymi sprawami ({check.links.length}) — nie blokują usunięcia</summary>
                  <LinkList links={check.links} />
                </details>
              )}
              <label htmlFor={`${id}-nazwa`}>
                Aby potwierdzić, wpisz nazwę sprawy: <strong>{summary.name}</strong>
              </label>
              <input id={`${id}-nazwa`} type="text" value={confirm} onChange={(event) => setConfirm(event.target.value)} autoComplete="off" spellCheck={false} autoFocus />
            </>
          )
        )}
        {error && blocking.length === 0 && <p className="case-dialog-error" role="alert">{error}</p>}
        <div className="case-dialog-actions">
          <button type="button" className="button" onClick={onClose} disabled={busy}>
            {blocking.length > 0 ? 'Zamknij' : 'Anuluj'}
          </button>
          {blocking.length === 0 && check && (
            <button type="submit" className="button button-danger" disabled={busy || !matches}>
              {busy ? 'Usuwanie…' : 'Usuń nieodwracalnie'}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}

/** Przyciski cyklu życia w nagłówku teczki. `onChanged` odświeża teczkę po zmianie stanu. */
export function CaseLifecycleActions({ summary, onChanged }: { summary: CaseSummary; onChanged: () => void }) {
  const toast = useToast();
  const status = statusOf(summary);
  const [dialog, setDialog] = useState<'close' | 'delete'>();
  const [busy, setBusy] = useState<'reopen' | 'archive'>();

  async function reopen() {
    setBusy('reopen');
    try {
      await api.reopenCase(summary.id);
      toast.success(`Przywrócono sprawę „${summary.name}” — można znów wprowadzać zmiany.`);
      onChanged();
    } catch (failure) {
      toast.error(failure);
    } finally {
      setBusy(undefined);
    }
  }

  async function archive() {
    setBusy('archive');
    try {
      const result = await api.archiveCase(summary.id);
      saveBlob(result.blob, result.fileName);
      toast.success(`Pobrano archiwum sprawy${result.sha256 ? ` (SHA-256 ${result.sha256.slice(0, 16)}…)` : ''}. W bazie zapisano tylko jego skrót.`);
      onChanged();
    } catch (failure) {
      toast.error(failure);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <>
      <CaseStatusBadge status={status} />
      {status === 'open' ? (
        <button type="button" className="button button-quiet" onClick={() => setDialog('close')}>
          Zamknij sprawę
        </button>
      ) : (
        <>
          <button type="button" className="button button-quiet" onClick={reopen} disabled={busy !== undefined}>
            {busy === 'reopen' ? 'Przywracanie…' : 'Przywróć'}
          </button>
          <button type="button" className="button" onClick={archive} disabled={busy !== undefined}>
            {busy === 'archive' ? 'Tworzenie archiwum…' : 'Archiwizuj i pobierz'}
          </button>
          <button type="button" className="button button-danger" onClick={() => setDialog('delete')} disabled={busy !== undefined}>
            Usuń sprawę
          </button>
        </>
      )}
      {dialog === 'close' && (
        <CloseDialog
          summary={summary}
          onClose={() => setDialog(undefined)}
          onDone={() => {
            setDialog(undefined);
            onChanged();
          }}
        />
      )}
      {dialog === 'delete' && <DeleteDialog summary={summary} onClose={() => setDialog(undefined)} />}
    </>
  );
}
