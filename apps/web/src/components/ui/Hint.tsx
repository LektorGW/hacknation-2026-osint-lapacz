// <Hint>: krótka, życzliwa wskazówka „jak czytać ten ekran”. Ukrycie zapamiętuje przeglądarka.
// Klasy CSS mają przedrostek `tip-` — `.hint` jest używana przez inne moduły jako drobny podpis.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HINT_PREFIX, clearFlags, readFlag, writeFlag } from '../../ux.ts';

export const HINTS_RESET_EVENT = 'olcys:wskazowki';

/** Przywraca wszystkie ukryte wskazówki (menu pomocy). */
export function resetHints(): void {
  clearFlags(HINT_PREFIX);
  window.dispatchEvent(new Event(HINTS_RESET_EVENT));
}

interface HintProps {
  /** Stały identyfikator — klucz zapamiętanego ukrycia. */
  id: string;
  title?: string;
  children: ReactNode;
}

export function Hint({ id, title = 'Wskazówka', children }: HintProps) {
  const key = `${HINT_PREFIX}${id}`;
  const [hidden, setHidden] = useState(() => readFlag(key));

  useEffect(() => {
    const onReset = () => setHidden(false);
    window.addEventListener(HINTS_RESET_EVENT, onReset);
    return () => window.removeEventListener(HINTS_RESET_EVENT, onReset);
  }, []);

  if (hidden) return null;
  return (
    <aside className="tip no-print" aria-label={title}>
      <svg className="tip-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3Z" />
      </svg>
      <div className="tip-body">
        <p className="tip-title">{title}</p>
        <div className="tip-text">{children}</div>
      </div>
      <button
        type="button"
        className="tip-close"
        aria-label="Ukryj wskazówkę"
        title="Ukryj wskazówkę (można ją przywrócić w menu Pomoc)"
        onClick={() => {
          writeFlag(key, true);
          setHidden(true);
        }}
      >
        <span aria-hidden="true">×</span>
      </button>
    </aside>
  );
}
