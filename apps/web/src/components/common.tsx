// Drobne elementy wspólne dla wszystkich ekranów.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { clamp, safeHttpUrl, scoreLevel, shorten } from '../format.ts';

// ---------- Trzy warstwy informacji ----------

export type Layer = 'fact' | 'calc' | 'inference';

/** Kontrakt API nazywa warstwę obliczeń `calculation`; w interfejsie używamy krótszej nazwy. */
export const toLayer = (layer: 'fact' | 'calculation' | 'inference'): Layer => (layer === 'calculation' ? 'calc' : layer);

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

export const LAYER_KEYS = Object.keys(LAYERS) as Layer[];
export const layerLabel = (layer: Layer) => LAYERS[layer].label;

export function LayerTag({ layer }: { layer: Layer }) {
  return (
    <span className={`layer-tag layer-${layer}`} title={LAYERS[layer].description}>
      {LAYERS[layer].label}
    </span>
  );
}

export function LayerLegend() {
  return (
    <details className="legend">
      <summary>Jak czytać oznaczenia warstw informacji</summary>
      <dl className="legend-list">
        {LAYER_KEYS.map((layer) => (
          <div key={layer} className="legend-item">
            <dt>
              <LayerTag layer={layer} />
            </dt>
            <dd>{LAYERS[layer].description}</dd>
          </div>
        ))}
      </dl>
    </details>
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

export function CopyButton({ value, label, text = 'Kopiuj' }: { value: string; label: string; text?: string }) {
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
        {state === 'copied' ? 'Skopiowano' : state === 'failed' ? 'Nie udało się skopiować' : text}
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

// ---------- Stany ładowania, błędów i pustych list ----------

export function Loading({ label = 'Wczytywanie…' }: { label?: string }) {
  return (
    <p className="loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

/** Szkielet treści na czas wczytywania. */
export function Skeleton({ blocks = 3 }: { blocks?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Wczytywanie">
      {Array.from({ length: blocks }, (_, index) => (
        <div key={index} className="skeleton-block" />
      ))}
    </div>
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

/** Pusty stan z podpowiedzią, co zrobić dalej. */
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-hint">{children}</div>}
    </div>
  );
}

// ---------- Wskaźniki ----------

export function ScoreBadge({ score, excluded = false, title }: { score: number; excluded?: boolean; title?: string }) {
  return (
    <span className={`score-badge level-${scoreLevel(score, excluded)}`} title={title}>
      {score}%
    </span>
  );
}

/** Poziomy pasek 0–100 z wartością; kolor wg poziomu wyniku. */
export function Bar({ value, label, wide = false }: { value: number; label: string; wide?: boolean }) {
  return (
    <span className={`bar level-${scoreLevel(value)} ${wide ? 'bar-wide' : ''}`}>
      <span className="bar-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <span className="bar-fill" style={{ width: `${clamp(value, 0, 100)}%` }} />
      </span>
      <span className="bar-value">{value}</span>
    </span>
  );
}

/** Duży wskaźnik pierścieniowy 0–100. */
export function Gauge({ value, label, unit = '%', size = 112 }: { value: number; label: string; unit?: string; size?: number }) {
  const radius = 46;
  const length = 2 * Math.PI * radius;
  return (
    <div className={`gauge level-${scoreLevel(value)}`} style={{ width: size }}>
      <svg viewBox="0 0 112 112" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-label={label}>
        <circle className="gauge-track" cx="56" cy="56" r={radius} />
        <circle
          className="gauge-fill"
          cx="56"
          cy="56"
          r={radius}
          strokeDasharray={`${(clamp(value, 0, 100) / 100) * length} ${length}`}
          transform="rotate(-90 56 56)"
        />
        <text className="gauge-value" x="56" y="56" textAnchor="middle" dominantBaseline="central">
          {value}
          <tspan className="gauge-unit">{unit}</tspan>
        </text>
      </svg>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

export function ScoreMeter({ score, tier, excluded }: { score: number; tier: string; excluded: boolean }) {
  return (
    <div className={`score-meter level-${scoreLevel(score, excluded)}`}>
      <div className="score-value">
        <span className="score-number">{score}%</span>
        <span className="score-caption">Wskaźnik Pewności publikacji</span>
      </div>
      <div className="score-detail">
        <div className="score-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label="Wskaźnik Pewności">
          <div className="score-fill" style={{ width: `${clamp(score, 0, 100)}%` }} />
        </div>
        <p className="score-tier">
          Poziom: <strong>{tier}</strong>
        </p>
      </div>
    </div>
  );
}

const JOINT_HINT = 'Prawdopodobieństwo, że adres należy do osoby ze sprawy — łączy pewność ustalenia osoby z pewnością publikacji.';
const SCORE_HINT = 'Wskaźnik Pewności publikacji — na ile adres jest powiązany z autorem publikacji, w której go znaleziono.';

/** Dwa wyniki adresu obok siebie: łączny (osoba–adres) i Wskaźnik Pewności publikacji. */
export function DualScore({ joint, score, excluded = false }: { joint?: number; score: number; excluded?: boolean }) {
  return (
    <span className="dual-score">
      <span className="dual-item" title={JOINT_HINT}>
        <span className="dual-label">osoba–adres</span>
        {joint === undefined ? <span className="muted">—</span> : <ScoreBadge score={joint} />}
      </span>
      <span className="dual-item" title={SCORE_HINT}>
        <span className="dual-label">publikacja</span>
        <ScoreBadge score={score} excluded={excluded} />
      </span>
    </span>
  );
}

/** Znaczek z inicjałem — zastępuje logo usługi lub awatar profilu. */
export function Initial({ name, tone = '' }: { name: string; tone?: string }) {
  return (
    <span className={`initial ${tone}`} aria-hidden="true">
      {(name.trim()[0] ?? '?').toUpperCase()}
    </span>
  );
}

export function Crumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="breadcrumb" aria-label="Okruszki">
      <ol>
        {items.map((item, index) => (
          <li key={index} aria-current={index === items.length - 1 ? 'page' : undefined}>
            {item.href ? <a href={item.href}>{item.label}</a> : item.label}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** Znacznik: adres z publikacji jest już znany z innej sprawy. */
export function KnownFromCases({ items }: { items?: { address: string; caseId: string; caseName: string }[] }) {
  if (!items || items.length === 0) return null;
  return (
    <span className="known-cases">
      {items.map((item) => (
        <a key={`${item.caseId}-${item.address}`} className="chip chip-fact" href={`#/sprawa/${encodeURIComponent(item.caseId)}`} title={item.address}>
          adres znany ze sprawy „{item.caseName}”
        </a>
      ))}
    </span>
  );
}
