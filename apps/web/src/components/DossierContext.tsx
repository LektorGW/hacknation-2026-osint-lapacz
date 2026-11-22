// Kontekst teczki: dane, odświeżanie i opcjonalne korekty analityka dostępne w każdej sekcji.
import { createContext, useContext, useId, useState } from 'react';
import type { Decision } from '@olcys/core';
import type { CaseSummary, DecisionTarget } from '../api.ts';
import type { FullDossier } from '../proof.ts';
import { DECISION_LABEL } from '../labels.ts';
import type { DossierTab } from '../router.ts';
import { fmtDateTime } from '../format.ts';
import { DECISION_TARGET_LABEL, currentDecision, decisionAuthor, decisionHistory, isWithdrawn } from '../decisions.ts';
import type { DecisionRecord } from '../decisions.ts';
import type { Warning } from '../warnings.ts';

export interface DossierContextValue {
  dossier: FullDossier;
  summary: CaseSummary;
  simplified: boolean;
  /** Odnośnik do sekcji teczki. */
  tabHref(tab: DossierTab): string;
  decide(target: DecisionTarget, key: string, decision: Decision, note?: string): Promise<void>;
  undo(decisionId: string): Promise<void>;
  reload(): void;
  /** Alerty ryzyka policzone raz na stronie teczki (z obiegami środków z sieci sprawy); brak — liczone z samej teczki. */
  warnings?: Warning[];
}

export const DossierContext = createContext<DossierContextValue | null>(null);

export function useDossier(): DossierContextValue {
  const value = useContext(DossierContext);
  if (!value) throw new Error('Brak kontekstu teczki.');
  return value;
}

interface DecisionControlsProps {
  target: DecisionTarget;
  decisionKey: string;
  confirmLabel: string;
  rejectLabel: string;
  /** Formularz od razu rozwinięty (panel grafu, karta hipotezy). */
  open?: boolean;
  summary?: string;
}

/** Opcjonalna korekta analityka: potwierdzenie albo odrzucenie z notatką; istniejącą decyzję można cofnąć. */
export function DecisionControls({ target, decisionKey, confirmLabel, rejectLabel, open = false, summary = 'Korekta analityka (opcjonalnie)' }: DecisionControlsProps) {
  const { dossier, decide, undo } = useDossier();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // Decyzja wycofana zostaje w rejestrze, ale nie obowiązuje — formularz wraca do stanu wyjściowego.
  const current = currentDecision(dossier.decisions as DecisionRecord[], target, decisionKey);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      setNote('');
    } finally {
      setBusy(false);
    }
  }

  if (current) {
    return (
      <div className={`decision decision-${current.decision}`}>
        <p>
          <strong>Korekta analityka: {DECISION_LABEL[current.decision]}</strong> · {fmtDateTime(current.decidedAt)}
          {current.note && <span className="decision-note"> — „{current.note}”</span>}
        </p>
        <button type="button" className="button button-small" disabled={busy} onClick={() => run(() => undo(current.id))}>
          Wycofaj decyzję
        </button>
      </div>
    );
  }

  return (
    <details className="decision" open={open || undefined}>
      <summary>{summary}</summary>
      <div className="decision-form">
        <label htmlFor={noteId} className="visually-hidden">
          Notatka do decyzji (opcjonalnie)
        </label>
        <input
          id={noteId}
          type="text"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="Notatka (opcjonalnie)"
          autoComplete="off"
        />
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => run(() => decide(target, decisionKey, 'confirmed', note.trim() || undefined))}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => run(() => decide(target, decisionKey, 'rejected', note.trim() || undefined))}
        >
          {rejectLabel}
        </button>
      </div>
    </details>
  );
}

/**
 * „Historia zmian”: decyzje analityka wraz z wycofanymi — kto, kiedy, z jaką notatką.
 * `keys` zawęża listę do wskazanych obiektów (panel grafu); bez nich pokazuje cały rejestr sprawy.
 */
export function DecisionHistory({ keys, empty = 'Brak decyzji dla tego elementu.' }: { keys?: string[]; empty?: string }) {
  const { dossier, undo } = useDossier();
  const [busy, setBusy] = useState<string | null>(null);
  const items = decisionHistory(dossier.decisions as DecisionRecord[], keys);
  if (items.length === 0) return <p className="muted">{empty}</p>;

  async function withdraw(id: string) {
    setBusy(id);
    try {
      await undo(id);
    } finally {
      setBusy(null);
    }
  }

  return (
    <ol className="history">
      {items.map((item) => (
        <li key={item.id} className={`history-item ${isWithdrawn(item) ? 'is-withdrawn' : ''}`}>
          <p className="history-main">
            <span className={`chip ${item.decision === 'confirmed' ? 'chip-ok' : 'chip-warn'}`}>{DECISION_LABEL[item.decision] ?? item.decision}</span>
            <span className="history-target">{DECISION_TARGET_LABEL[item.target as string] ?? item.target}</span>
            <code className="mono history-key">{item.key}</code>
          </p>
          <p className="muted">
            {decisionAuthor(item)} · {fmtDateTime(item.decidedAt)}
            {item.note && <span className="decision-note"> — „{item.note}”</span>}
          </p>
          {isWithdrawn(item) ? (
            <p className="history-withdrawn">
              Wycofano {fmtDateTime(item.withdrawnAt ?? undefined)}
              {item.withdrawnBy ? ` · ${item.withdrawnBy}` : ''} — decyzja nie wpływa już na wynik.
            </p>
          ) : (
            <button type="button" className="button button-small" disabled={busy === item.id} onClick={() => withdraw(item.id)}>
              Wycofaj
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
