// <Term>: pojęcie podkreślone kropkami; najechanie, fokus albo dotknięcie pokazuje krótką definicję ze słownika.
import { useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GLOSSARY } from '../../glossary.ts';
import type { GlossaryId } from '../../glossary.ts';
import { Floating } from './Floating.tsx';

export const GLOSSARY_EVENT = 'olcys:slownik';

/** Otwiera szufladę „Słownik pojęć”, opcjonalnie na wskazanym haśle. */
export function openGlossary(id?: GlossaryId): void {
  window.dispatchEvent(new CustomEvent(GLOSSARY_EVENT, { detail: id }));
}

interface TermProps {
  id: GlossaryId;
  /** Tekst widoczny w zdaniu; domyślnie nazwa hasła. */
  children?: ReactNode;
  /** Wariant „ikona”: tylko znak „?” obok tekstu, np. w nagłówku tabeli. */
  icon?: boolean;
}

export function Term({ id, children, icon = false }: TermProps) {
  const entry = GLOSSARY[id];
  const popoverId = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const close = useCallback(() => setOpen(false), []);

  const later = (value: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(value), delay);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={icon ? 'term term-icon' : 'term'}
        aria-expanded={open}
        aria-describedby={open ? popoverId : undefined}
        aria-label={icon ? `Co to znaczy: ${entry.term}` : undefined}
        onClick={(event) => {
          // W <summary> kliknięcie nie może zwijać sekcji.
          event.preventDefault();
          event.stopPropagation();
          clearTimeout(timer.current);
          setOpen((value) => !value);
        }}
        onPointerEnter={(event) => event.pointerType === 'mouse' && later(true, 250)}
        onPointerLeave={(event) => event.pointerType === 'mouse' && later(false, 200)}
        onFocus={(event) => event.target.matches(':focus-visible') && setOpen(true)}
        onBlur={() => later(false, 150)}
      >
        {icon ? (
          <>
            {children}
            <span className="term-mark" aria-hidden="true">
              ?
            </span>
          </>
        ) : (
          (children ?? entry.term)
        )}
      </button>
      <Floating
        anchor={anchor}
        open={open}
        onClose={close}
        id={popoverId}
        className="term-pop"
        onPointerEnter={() => clearTimeout(timer.current)}
        onPointerLeave={() => later(false, 200)}
      >
        <p className="term-pop-title">{entry.term}</p>
        <p>{entry.short}</p>
        {entry.why && (
          <p className="term-pop-why">
            <strong>Dlaczego to ważne:</strong> {entry.why}
          </p>
        )}
        <button
          type="button"
          className="link-button term-pop-more"
          tabIndex={-1}
          onClick={() => {
            setOpen(false);
            openGlossary(id);
          }}
        >
          Wszystkie pojęcia w słowniku
        </button>
      </Floating>
    </>
  );
}
