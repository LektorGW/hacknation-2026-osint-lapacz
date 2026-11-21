// <Disclosure>: zwijana sekcja „o jedno kliknięcie dalej”. Na wydruku wszystkie sekcje się rozwijają.
import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { Layer } from '../common.tsx';

interface DisclosureProps {
  title: ReactNode;
  /** Krótka informacja po prawej stronie nagłówka, np. liczba elementów. */
  meta?: ReactNode;
  /** Warstwa informacji — kolorowy znacznik przy nagłówku. */
  layer?: Layer;
  defaultOpen?: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Disclosure({ title, meta, layer, defaultOpen = false, id, className = '', children }: DisclosureProps) {
  return (
    <details className={`disclosure ${layer ? `layer-${layer}` : ''} ${className}`} open={defaultOpen || undefined} id={id}>
      <summary>
        <span className="disclosure-chevron" aria-hidden="true" />
        <span className="disclosure-title">{title}</span>
        {meta !== undefined && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

/** Rozwija zwinięte sekcje na czas drukowania i przywraca je potem. Montowane raz w aplikacji. */
export function usePrintExpand(): void {
  useEffect(() => {
    let opened: HTMLDetailsElement[] = [];
    const before = () => {
      opened = [...document.querySelectorAll<HTMLDetailsElement>('details.disclosure:not([open]), details.why:not([open])')];
      for (const element of opened) element.open = true;
    };
    const after = () => {
      for (const element of opened) element.open = false;
      opened = [];
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => {
      window.removeEventListener('beforeprint', before);
      window.removeEventListener('afterprint', after);
    };
  }, []);
}
