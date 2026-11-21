// <Score>: jeden wygląd każdego wyniku 0–100 — liczba, krótki pasek, poziom słowami i przycisk „i”
// z wyjaśnieniem krok po kroku. Uwaga o wskaźniku porządkowym jest tylko w wyjaśnieniu.
import { useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LedgerEntry } from '@olcys/core';
import { clamp, scoreLevel } from '../../format.ts';
import { GLOSSARY } from '../../glossary.ts';
import { ORDINAL_NOTE, ruleLabel } from '../../labels.ts';
import { SCORE_KIND, tierWords } from '../../ux.ts';
import type { ScoreKind } from '../../ux.ts';
import { Floating } from './Floating.tsx';

const signed = (delta: number) => (delta > 0 ? `+${delta}` : delta < 0 ? `−${Math.abs(delta)}` : '0');

/** Krótka nazwa kroku: bez przedrostków „Baza:”, „Premia:” — znak liczby mówi sam za siebie. */
function stepName(rule: string): string {
  const label = ruleLabel(rule);
  return label.replace(/^(Baza|Premia|Kara|Korekta tożsamości|Wykluczenie): /, '');
}

/** Pionowa lista kroków obliczenia: „+85 własny profil”, „−10 zgodny tylko nick” i stan po każdym kroku. */
export function ScoreSteps({ ledger, compact = false }: { ledger: LedgerEntry[]; compact?: boolean }) {
  if (ledger.length === 0) return <p className="muted">Brak kroków — nie znaleziono przesłanek do oceny.</p>;
  return (
    <ol className={`ledger-steps ${compact ? 'ledger-steps-compact' : ''}`}>
      {ledger.map((entry, index) => (
        <li key={`${entry.rule}-${index}`} className={`step ${entry.delta < 0 ? 'is-minus' : entry.delta > 0 ? 'is-plus' : ''}`}>
          <span className="step-delta">{signed(entry.delta)}</span>
          <div className="step-body">
            <p className="step-name">{stepName(entry.rule)}</p>
            {!compact && entry.explanation && <p className="step-why">{entry.explanation}</p>}
          </div>
          <span className="step-running" title="Wynik po tym kroku">
            {entry.running}
          </span>
        </li>
      ))}
    </ol>
  );
}

interface ScoreProps {
  value: number;
  kind: ScoreKind;
  excluded?: boolean;
  /** Kroki obliczenia (księga reguł) — pokazane w wyjaśnieniu. */
  ledger?: LedgerEntry[];
  /** Przesłanki słowne, gdy wynik nie ma księgi (np. ustalenie osoby, priorytet). */
  reasons?: string[];
  /** Własny podpis zamiast nazwy rodzaju wyniku. */
  caption?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Bez przycisku wyjaśnienia (np. w gęstej tabeli). */
  plain?: boolean;
  /** Dodatkowa treść na końcu wyjaśnienia. */
  extra?: ReactNode;
}

export function Score({ value, kind, excluded = false, ledger, reasons, caption, size = 'md', plain = false, extra }: ScoreProps) {
  const info = SCORE_KIND[kind];
  const level = scoreLevel(value, excluded);
  const words = tierWords(kind, value, excluded);
  const popoverId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <span className={`score score-${size} level-${level}`} data-tour="score">
      <span className="score-line">
        <span className="score-num">{value}</span>
        <span className="score-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={`${info.label}: ${value} na 100, ${words}`}>
          <span className="score-bar-fill" style={{ width: `${clamp(value, 0, 100)}%` }} />
        </span>
        <span className="score-words">{words}</span>
        {!plain && (
          <button
            ref={anchor}
            type="button"
            className="score-info"
            aria-expanded={open}
            aria-controls={open ? popoverId : undefined}
            aria-label={`Skąd ten wynik? ${info.label}`}
            title="Skąd ten wynik?"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen((current) => !current);
            }}
          >
            i
          </button>
        )}
      </span>
      {caption !== null && size !== 'sm' && <span className="score-caption">{caption ?? info.label}</span>}
      {!plain && (
        <Floating anchor={anchor} open={open} onClose={close} id={popoverId} role="dialog" label={`Skąd ten wynik: ${info.label}`} className="score-pop">
          <p className="term-pop-title">
            {info.label}: {value} — {words}
          </p>
          <p>{GLOSSARY[info.glossary].short}</p>
          {ledger && ledger.length > 0 && (
            <>
              <p className="score-pop-sub">Jak powstał wynik — krok po kroku</p>
              <div className="steps-clamped">
                <ScoreSteps ledger={ledger} />
              </div>
            </>
          )}
          {reasons && reasons.length > 0 && (
            <>
              <p className="score-pop-sub">Przesłanki</p>
              <ul className="score-pop-reasons">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </>
          )}
          {extra}
          <p className="score-pop-note">{ORDINAL_NOTE}</p>
        </Floating>
      )}
    </span>
  );
}
