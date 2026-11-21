// Kontekst teczki: dane, odświeżanie i opcjonalne korekty analityka dostępne w każdej sekcji.
import { createContext, useContext, useId, useState } from 'react';
import type { Decision } from '@olcys/core';
import type { CaseSummary, DecisionTarget } from '../api.ts';
import type { FullDossier } from '../proof.ts';
import { DECISION_LABEL } from '../labels.ts';
import type { DossierTab } from '../router.ts';
import { fmtDateTime } from '../format.ts';

export interface DossierContextValue {
  dossier: FullDossier;
  summary: CaseSummary;
  simplified: boolean;
  /** Odnośnik do sekcji teczki. */
  tabHref(tab: DossierTab): string;
  decide(target: DecisionTarget, key: string, decision: Decision, note?: string): Promise<void>;
  undo(decisionId: string): Promise<void>;
  reload(): void;
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
}

/** Opcjonalna korekta analityka: potwierdzenie albo odrzucenie z notatką; istniejącą decyzję można cofnąć. */
export function DecisionControls({ target, decisionKey, confirmLabel, rejectLabel }: DecisionControlsProps) {
  const { dossier, decide, undo } = useDossier();
  const noteId = useId();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const current = dossier.decisions.filter((item) => (item.target as DecisionTarget) === target && item.key === decisionKey).at(-1);

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
          Cofnij decyzję
        </button>
      </div>
    );
  }

  return (
    <details className="decision">
      <summary>Korekta analityka (opcjonalnie)</summary>
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
