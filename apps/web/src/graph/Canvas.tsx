// Płótno grafu: przybliżanie (kółko myszy, przyciski, klawiatura) i przesuwanie (przeciąganie, strzałki).
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

interface CanvasProps {
  width: number;
  height: number;
  label: string;
  className?: string;
  children: ReactNode;
  /** Elementy SVG rysowane pod treścią, w układzie ekranu (np. tło). */
  defs?: ReactNode;
  /** Najmniejsze powiększenie przy dopasowaniu: szerszy graf zaczyna od lewej krawędzi i jest czytelny, zamiast kurczyć się do nieczytelnej miniatury. */
  minFit?: number;
}

export function Canvas({ width, height, label, className = '', children, defs, minFit = MIN_ZOOM }: CanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);

  const fit = useCallback(() => {
    const element = container.current;
    if (!element) return;
    const { clientWidth, clientHeight } = element;
    const k = clamp(Math.min(clientWidth / width, clientHeight / height), minFit, 1.25);
    // Treść, która się nie mieści, zaczyna od lewego górnego rogu; mieszcząca się jest wyśrodkowana.
    const place = (space: number, size: number) => (size <= space ? (space - size) / 2 : 8);
    setView({ k, x: place(clientWidth, width * k), y: place(clientHeight, height * k) });
  }, [width, height, minFit]);

  useEffect(() => {
    fit();
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);

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
    if (event.button !== 0 || (event.target as Element).closest('[data-node], button')) return;
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
      <div className="canvas-tools">
        <button type="button" className="icon-button" onClick={() => zoomAt(1.25)} aria-label="Przybliż">
          +
        </button>
        <button type="button" className="icon-button" onClick={() => zoomAt(0.8)} aria-label="Oddal">
          −
        </button>
        <button type="button" className="icon-button canvas-fit" onClick={fit}>
          Dopasuj
        </button>
      </div>
    </div>
  );
}
