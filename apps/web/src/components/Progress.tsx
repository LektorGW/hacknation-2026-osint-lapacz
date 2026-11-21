// Wybór trybu i okresu analizy oraz postęp analizy na żywo: etapy, pasek z liczników źródeł, liczba dokumentów i adresów.
import { useId } from 'react';
import type { Period } from '../proof.ts';
import { progressView } from '../proof.ts';
import type { Depth, RunProgress } from '../proof.ts';
import { Term } from './ui/Term.tsx';

/** Tryby analizy w kolejności wyboru; głęboki jest domyślny, szybki — jedno kliknięcie dalej. */
export const MODES: { value: Depth; label: string; duration: string; detail: string }[] = [
  { value: 'standard', label: 'Szybki', duration: 'kilka–kilkanaście sekund', detail: 'podstawowe źródła' },
  { value: 'deep', label: 'Głęboki', duration: '1–4 minuty', detail: 'szeroki przegląd forów i serwisów' },
];

/** Opis trybu pod tytułem ekranu postępu. */
export const modeNote = (depth: Depth) =>
  depth === 'deep' ? 'Tryb głęboki: szeroki przegląd forów i serwisów — zwykle 1–4 minuty.' : 'Tryb szybki: podstawowe źródła — zwykle kilka–kilkanaście sekund.';

/** Przełącznik „Tryb: Szybki / Głęboki” — dwa przyciski wyboru z przewidywanym czasem pod każdym. */
export function ModeSwitch({ depth, onChange, disabled }: { depth: Depth; onChange: (depth: Depth) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset className="mode-switch" disabled={disabled} data-tour="mode">
      <legend>
        <Term id={depth === 'deep' ? 'tryb-gleboki' : 'tryb-szybki'}>Tryb</Term>
      </legend>
      <div className="mode-options">
        {MODES.map((mode) => (
          <label key={mode.value} className={`mode-option ${depth === mode.value ? 'is-checked' : ''}`}>
            <input type="radio" name={name} value={mode.value} checked={depth === mode.value} onChange={() => onChange(mode.value)} />
            <span className="mode-option-label">
              {mode.label}
              {mode.value === 'deep' && <span className="mode-default">domyślny</span>}
            </span>
            <span className="mode-option-note">
              {mode.duration}
              <span className="mode-option-detail">, {mode.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Okres analizy: dwa pola dat; puste oznaczają całą dostępną historię. */
export function PeriodFields({ from, to, onChange, disabled }: { from: string; to: string; onChange: (period: Required<Period>) => void; disabled?: boolean }) {
  return (
    <fieldset className="period" disabled={disabled}>
      <legend>
        Okres analizy
      </legend>
      <label>
        od
        <input type="date" value={from} max={to || undefined} onChange={(event) => onChange({ from: event.target.value, to })} />
      </label>
      <label>
        do
        <input type="date" value={to} min={from || undefined} onChange={(event) => onChange({ from, to: event.target.value })} />
      </label>
    </fieldset>
  );
}

const WAITING: RunProgress = { status: 'running', stage: 'search', connectorsDone: 0, connectorsTotal: 0, documents: 0, addresses: 0 };

/** Ekran postępu; przed pierwszą odpowiedzią usługi pokazuje etap wyszukiwania bez liczników. */
export function AnalysisProgress({ title, progress, depth }: { title: string; progress?: RunProgress; depth: Depth }) {
  const labelId = useId();
  const current = progress ?? WAITING;
  const view = progressView(current);
  return (
    <section className="card progress" role="status" aria-live="polite" aria-labelledby={labelId}>
      <h2 id={labelId}>{title}</h2>
      <p className="muted">{modeNote(current.depth ?? depth)}</p>
      <div className="progress-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={view.percent} aria-label="Postęp analizy">
        <span style={{ width: `${view.percent}%` }} />
      </div>
      <dl className="progress-counts">
        <div>
          <dt>Źródła</dt>
          <dd>{current.connectorsTotal > 0 ? `${current.connectorsDone} / ${current.connectorsTotal}` : '—'}</dd>
        </div>
        <div>
          <dt>Znalezione dokumenty</dt>
          <dd>{current.documents}</dd>
        </div>
        <div>
          <dt>Znalezione adresy</dt>
          <dd>{current.addresses}</dd>
        </div>
      </dl>
      <ol className="progress-steps">
        {view.steps.map((step, index) => (
          <li key={step.label} className={step.state === 'done' ? 'is-done' : step.state === 'active' ? 'is-active' : ''}>
            <span className="progress-mark" aria-hidden="true">
              {step.state === 'done' ? '✓' : index + 1}
            </span>
            <span>
              {step.label}
              {step.state === 'active' && <span className="visually-hidden"> — w toku</span>}
              {step.detail && <span className="muted"> · {step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className="muted">Po zakończeniu teczka otworzy się automatycznie.</p>
    </section>
  );
}
