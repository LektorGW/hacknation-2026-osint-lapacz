// Przewodnik pierwszego uruchomienia: lekki „reflektor” na kolejnych elementach ekranu.
// Nie blokuje aplikacji (warstwa przepuszcza kliknięcia), Esc i „Pomiń” kończą, ruch wyłączony przy prefers-reduced-motion.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { TOUR_EVENT, availableSteps, isTourDone, markTourDone } from '../../tour.ts';
import type { TourChapter, TourStep } from '../../tour.ts';

const find = (target: string) => document.querySelector<HTMLElement>(`[data-tour="${target}"]`);
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 6;
const CARD_WIDTH = 340;

function cardStyle(box: Box): CSSProperties {
  const width = Math.min(CARD_WIDTH, window.innerWidth - 16);
  const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
  const below = box.top + box.height + 12;
  // Karta pod elementem; gdy element sięga dołu ekranu — nad nim albo w jego górnej części.
  if (below + 190 < window.innerHeight) return { top: below, left, width };
  const above = box.top - 12 - 190;
  if (above >= 8) return { top: above, left, width };
  // Wysoki element: karta w jego dolnym prawym rogu, w granicach okna.
  return { top: Math.max(8, Math.min(box.top + box.height - 200, window.innerHeight - 210)), left: Math.max(8, Math.min(box.left + box.width - width - 12, window.innerWidth - width - 8)), width };
}

export function Tour({ chapter, ready = true }: { chapter: TourChapter; ready?: boolean }) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box>();
  const card = useRef<HTMLDivElement>(null);
  const step = steps[index];

  const start = useCallback(() => {
    const found = availableSteps(chapter, (target) => find(target) !== null);
    if (found.length === 0) return;
    setSteps(found);
    setIndex(0);
  }, [chapter]);

  const finish = useCallback(() => {
    markTourDone(chapter);
    setSteps([]);
    setBox(undefined);
  }, [chapter]);

  // Pierwsze uruchomienie: po wczytaniu treści ekranu.
  useEffect(() => {
    if (!ready || isTourDone(chapter)) return;
    const timer = setTimeout(start, 700);
    return () => clearTimeout(timer);
  }, [ready, chapter, start]);

  // Ponowne uruchomienie z menu pomocy.
  useEffect(() => {
    window.addEventListener(TOUR_EVENT, start);
    return () => window.removeEventListener(TOUR_EVENT, start);
  }, [start]);

  const measure = useCallback(() => {
    if (!step) return;
    const element = find(step.target);
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setBox({ top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: Math.min(rect.height, window.innerHeight * 0.7) + PAD * 2 });
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    const element = find(step.target);
    if (!element) {
      // Element zniknął (np. zmiana sekcji) — przechodzimy dalej.
      if (index < steps.length - 1) setIndex(index + 1);
      else finish();
      return;
    }
    // Wysoki element: pokazujemy jego początek, niski — na środku ekranu.
    const tall = element.getBoundingClientRect().height > window.innerHeight * 0.6;
    element.scrollIntoView({ block: tall ? 'start' : 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    measure();
    const timer = setTimeout(measure, reducedMotion() ? 0 : 400);
    return () => clearTimeout(timer);
  }, [step, index, steps.length, finish, measure]);

  const shown = box !== undefined;
  useEffect(() => {
    if (shown) card.current?.focus({ preventScroll: true });
  }, [shown, index]);

  useEffect(() => {
    if (!step) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish();
    };
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      window.removeEventListener('keydown', onKey);
    };
  }, [step, measure, finish]);

  if (!step || !box) return null;
  const last = index === steps.length - 1;
  return (
    <div className="tour no-print">
      <div className="tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} aria-hidden="true" />
      <div ref={card} className="tour-card" role="dialog" aria-modal="false" aria-labelledby="przewodnik-tytul" tabIndex={-1} style={cardStyle(box)}>
        <p className="tour-count">
          Przewodnik · krok {index + 1} z {steps.length}
        </p>
        <h2 id="przewodnik-tytul">{step.title}</h2>
        <p>{step.text}</p>
        <div className="tour-actions">
          <button type="button" className="link-button" onClick={finish}>
            Pomiń przewodnik
          </button>
          <span className="tour-nav">
            {index > 0 && (
              <button type="button" className="button button-small" onClick={() => setIndex(index - 1)}>
                Wstecz
              </button>
            )}
            <button type="button" className="button button-primary button-small" onClick={() => (last ? finish() : setIndex(index + 1))}>
              {last ? 'Zaczynam' : 'Dalej'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
