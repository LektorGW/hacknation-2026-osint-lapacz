// Drobne elementy wspólne dla wszystkich ekranów.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { safeHttpUrl, scoreLevel, shorten } from '../format.ts';

// ---------- Trzy warstwy informacji ----------

export type Layer = 'fact' | 'calc' | 'inference';

const LAYERS: Record<Layer, { label: string; description: string }> = {
  fact: {
    label: 'Fakt źródłowy',
    description: 'Treść lub dane pobrane wprost ze źródła publicznego albo z blockchaina; można je sprawdzić pod podanym adresem.',
  },
  calc: {
    label: 'Wynik obliczeń',
    description: 'Liczba wyliczona przez narzędzie według jawnych reguł; każdy krok jest pokazany.',
  },
  inference: {
    label: 'Wniosek do weryfikacji',
    description: 'Interpretacja narzędzia. Nie jest dowodem — wymaga potwierdzenia przez analityka.',
  },
};

export function LayerTag({ layer }: { layer: Layer }) {
  return <span className={`layer-tag layer-${layer}`}>{LAYERS[layer].label}</span>;
}

export function LayerLegend() {
  return (
    <section className="legend" aria-label="Legenda warstw informacji">
      <h2 className="legend-title">Jak czytać ten ekran</h2>
      <dl className="legend-list">
        {(Object.keys(LAYERS) as Layer[]).map((layer) => (
          <div key={layer} className="legend-item">
            <dt>
              <LayerTag layer={layer} />
            </dt>
            <dd>{LAYERS[layer].description}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Fragment karty oznaczony warstwą: kolorowa krawędź, nagłówek i etykieta. */
export function LayerSection({ layer, title, children }: { layer: Layer; title: string; children: ReactNode }) {
  return (
    <section className={`layer-section layer-${layer}`}>
      <header className="layer-section-head">
        <h4>{title}</h4>
        <LayerTag layer={layer} />
      </header>
      {children}
    </section>
  );
}

// ---------- Odnośniki i kopiowanie ----------

/** Odnośnik zewnętrzny tylko dla http/https; inne adresy pokazujemy jako zwykły tekst. */
export function ExternalLink({ url, children }: { url: string; children?: ReactNode }) {
  const safe = safeHttpUrl(url);
  if (!safe) return <span className="unsafe-url">{children ?? url}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children ?? url}
      <span className="visually-hidden"> (otwiera się w nowej karcie)</span>
    </a>
  );
}

export function CopyButton({ value, label }: { value: string; label: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  }

  return (
    <button type="button" className="button button-small" onClick={copy} aria-label={label}>
      <span aria-live="polite">
        {state === 'copied' ? 'Skopiowano' : state === 'failed' ? 'Nie udało się skopiować' : 'Kopiuj'}
      </span>
    </button>
  );
}

/** Adres w skróconej postaci; pełna wartość w podpowiedzi i dla czytników ekranu. */
export function ShortAddress({ value }: { value: string }) {
  return (
    <code className="mono" title={value}>
      <span aria-hidden="true">{shorten(value)}</span>
      <span className="visually-hidden">{value}</span>
    </code>
  );
}

// ---------- Stany ładowania i błędów ----------

export function Loading({ label = 'Wczytywanie…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <p>
        <strong>Nie udało się wykonać operacji.</strong> {message}
      </p>
      {onRetry && (
        <button type="button" className="button" onClick={onRetry}>
          Spróbuj ponownie
        </button>
      )}
    </div>
  );
}

// ---------- Wskaźnik Pewności ----------

export function ScoreBadge({ score, excluded = false }: { score: number; excluded?: boolean }) {
  return <span className={`score-badge level-${scoreLevel(score, excluded)}`}>{score}%</span>;
}

export function ScoreMeter({ score, tier, excluded }: { score: number; tier: string; excluded: boolean }) {
  return (
    <div className={`score-meter level-${scoreLevel(score, excluded)}`}>
      <div className="score-value">
        <span className="score-number">{score}%</span>
        <span className="score-caption">Wskaźnik Pewności</span>
      </div>
      <div className="score-detail">
        <div
          className="score-track"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={score}
          aria-label="Wskaźnik Pewności"
        >
          <div className="score-fill" style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
        </div>
        <p className="score-tier">
          Poziom: <strong>{tier}</strong>
        </p>
      </div>
    </div>
  );
}
