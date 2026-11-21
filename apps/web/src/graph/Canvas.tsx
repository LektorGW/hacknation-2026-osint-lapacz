// Płótno grafu: przybliżanie (kółko myszy, przyciski, klawiatura) i przesuwanie (przeciąganie, strzałki).
// Nagłówki kolumn stoją nad grafem (zawsze widoczne), przyciski powiększenia — w rogu.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';
import { clamp } from '../format.ts';

interface View {
  k: number;
  x: number;
  y: number;
}

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 3;

/** Punkt do pokazania: `avoidRight` — pas z prawej zasłonięty panelem; `onlyIfHidden` — przesuń tylko, gdy punkt jest niewidoczny. */
export interface CanvasCentre {
  x: number;
  y: number;
  key: string;
  avoidRight?: number;
  onlyIfHidden?: boolean;
}

interface CanvasProps {
  width: number;
  height: number;
  label: string;
  className?: string;
  children: ReactNode;
  /** Elementy SVG rysowane pod treścią, w układzie ekranu (np. tło). */
  defs?: ReactNode;
  /**
   * Najmniejsze powiększenie przy dopasowaniu: szerszy graf zaczyna od lewej krawędzi i jest czytelny,
   * zamiast kurczyć się do nieczytelnej miniatury — resztę widać po przesunięciu.
   */
  minFit?: number;
  /** Nagłówki kolumn (współrzędne grafu) — rysowane nad płótnem, przesuwają się tylko w poziomie. */
  columns?: { x: number; label: string }[];
  /** Punkt grafu do wyśrodkowania (np. wynik wyszukiwania); zmiana `key` wyśrodkowuje ponownie. */
  centre?: CanvasCentre | null;
  /** Dodatkowe przyciski w pasku narzędzi płótna. */
  tools?: ReactNode;
}

export function Canvas({ width, height, label, className = '', children, defs, minFit = 0.8, columns, centre, tools }: CanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const top = columns && columns.length > 0 ? 34 : 0;

  const fit = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const { clientWidth } = element;
    const clientHeight = element.clientHeight - top;
    const k = clamp(Math.min(clientWidth / width, clientHeight / height), minFit, 1.25);
    // Za szeroka treść zaczyna od lewej krawędzi (tam jest podmiot); za wysoka — od środka wysokości,
    // bo kolumny są wyśrodkowane w pionie i tam leżą połączenia z podmiotem. Mieszcząca się jest wyśrodkowana.
    const placeX = (space: number, size: number) => (size <= space ? (space - size) / 2 : 8);
    setView({ k, x: placeX(clientWidth, width * k), y: top + (clientHeight - height * k) / 2 });
  }, [width, height, minFit, top]);

  useEffect(() => {
    fit();
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

  // Wyśrodkowanie wskazanego punktu (wyszukiwanie „Znajdź w grafie”).
  useEffect(() => {
    const element = container.current;
    if (!centre || !element) return;
    setView((current) => {
      // Na wąskim ekranie panel jest pod spodem — nie zasłania prawej części płótna.
      const avoid = element.clientWidth > 720 ? Math.min(centre.avoidRight ?? 0, element.clientWidth / 2) : 0;
      const visibleWidth = element.clientWidth - avoid;
      if (centre.onlyIfHidden) {
        const sx = current.x + centre.x * current.k;
        const sy = current.y + centre.y * current.k;
        if (sx > 40 && sx < visibleWidth - 40 && sy > top + 30 && sy < element.clientHeight - 30) return current;
      }
      const k = centre.onlyIfHidden ? current.k : Math.max(current.k, 1);
      return { k, x: visibleWidth / 2 - centre.x * k, y: (element.clientHeight + top) / 2 - centre.y * k };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [centre?.key]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    setView((current) => {
      const element = container.current;
      const px = cx ?? (element?.clientWidth ?? 0) / 2;
      const py = cy ?? (element?.clientHeight ?? 0) / 2;
      const k = clamp(current.k * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = k / current.k;
      return { k, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }, []);

  // Kółko myszy wymaga nasłuchu niepasywnego, żeby strona nie przewijała się pod grafem.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as Element).closest('[data-node], button, input')) return;
    drag.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const last = drag.current;
    if (!last) return;
    const dx = event.clientX - last.x;
    const dy = event.clientY - last.y;
    drag.current = { x: event.clientX, y: event.clientY };
    setView((current) => ({ ...current, x: current.x + dx, y: current.y + dy }));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.target as Element).closest('input')) return;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [48, 0],
      ArrowRight: [-48, 0],
      ArrowUp: [0, 48],
      ArrowDown: [0, -48],
    };
    const move = pan[event.key];
    if (move) setView((current) => ({ ...current, x: current.x + move[0], y: current.y + move[1] }));
    else if (event.key === '+' || event.key === '=') zoomAt(1.25);
    else if (event.key === '-') zoomAt(0.8);
    else if (event.key === '0') fit();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <div
      ref={container}
      className={`canvas ${className}`}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Strzałki przesuwają widok, plus i minus zmieniają powiększenie, zero dopasowuje.`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
    >
      <svg className="canvas-svg" role="presentation">
        {defs}
        <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>{children}</g>
      </svg>
      {columns && columns.length > 0 && (
        <div className="canvas-columns" aria-hidden="true">
          {columns.map((column, index) => (
            <span key={`${column.label}-${index}`} style={{ left: view.x + column.x * view.k }}>
              {column.label}
            </span>
          ))}
        </div>
      )}
      <div className="canvas-tools">
        {tools}
        <button type="button" className="icon-button" onClick={() => zoomAt(1.25)} aria-label="Przybliż" title="Przybliż (+)">
          +
        </button>
        <button type="button" className="icon-button" onClick={() => zoomAt(0.8)} aria-label="Oddal" title="Oddal (−)">
          −
        </button>
        <button type="button" className="icon-button canvas-fit" onClick={fit} title="Dopasuj (0)">
          Dopasuj
        </button>
        <span className="canvas-zoom" aria-hidden="true">
          {Math.round(view.k * 100)}%
        </span>
      </div>
    </div>
  );
}
