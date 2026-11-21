// Postęp analizy na żywo: etapy, pasek z liczników źródeł oraz liczba dokumentów i adresów.
import { useId } from 'react';
import { progressView } from '../proof.ts';
import type { Depth, RunProgress } from '../proof.ts';

export const DEEP_LABEL = 'Tryb głęboki (przeszukaj ~400 forów i serwisów, 1–4 min)';

export function DepthSwitch({ depth, onChange, disabled }: { depth: Depth; onChange: (depth: Depth) => void; disabled?: boolean }) {
  return (
    <label className="depth-switch">
      <input type="checkbox" checked={depth === 'deep'} disabled={disabled} onChange={(event) => onChange(event.target.checked ? 'deep' : 'standard')} />
      {DEEP_LABEL}
    </label>
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
      <p className="muted">
        {(current.depth ?? depth) === 'deep' ? 'Tryb głęboki: szeroki przegląd forów i serwisów, zwykle 1–4 minuty.' : 'Tryb standardowy: zwykle do kilkudziesięciu sekund.'}
      </p>
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
