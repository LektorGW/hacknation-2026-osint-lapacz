// Powiadomienia po akcjach: stały region w górnej warstwie, bez przejmowania fokusu.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from '../api.ts';

type ToastKind = 'success' | 'error';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface Notifier {
  success(message: string): void;
  error(failure: unknown): void;
}

const ToastContext = createContext<Notifier>({ success: () => {}, error: () => {} });

export const useToast = () => useContext(ToastContext);

/** Czas, po którym potwierdzenie znika samo; błędy zostają do zamknięcia. */
const SUCCESS_MS = 6000;

type Announcer = { ariaNotify?: (message: string) => void };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [announcement, setAnnouncement] = useState('');
  const region = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((current) => current.filter((item) => item.id !== id)), []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { id, kind, message }]);
      const announcer = document as Announcer;
      if (announcer.ariaNotify) announcer.ariaNotify(message);
      else setAnnouncement(message);
      if (kind === 'success') {
        const close = () => {
          // Nie zamykamy powiadomienia, w którym jest fokus.
          if (region.current?.querySelector(`[data-toast="${id}"]`)?.contains(document.activeElement)) {
            setTimeout(close, 2000);
          } else {
            dismiss(id);
          }
        };
        setTimeout(close, SUCCESS_MS);
      }
    },
    [dismiss],
  );

  // Region jest popoverem „manual”: trafia do górnej warstwy i nie zamyka się po kliknięciu obok.
  useEffect(() => {
    const element = region.current;
    if (!element || typeof element.showPopover !== 'function') return;
    const open = element.matches(':popover-open');
    if (items.length > 0 && !open) element.showPopover();
    if (items.length === 0 && open) element.hidePopover();
  }, [items.length]);

  const notifier = useMemo<Notifier>(
    () => ({
      success: (message) => push('success', message),
      error: (failure) => push('error', errorMessage(failure)),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={notifier}>
      {children}
      <div ref={region} className="toasts" role="region" aria-label="Powiadomienia" popover="manual">
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`} data-toast={item.id}>
            <span className="toast-icon" aria-hidden="true">
              {item.kind === 'success' ? '✓' : '!'}
            </span>
            <p>{item.message}</p>
            <button type="button" className="icon-button" onClick={() => dismiss(item.id)} aria-label="Zamknij powiadomienie">
              ×
            </button>
          </div>
        ))}
      </div>
      <p className="visually-hidden">Komunikaty dla czytnika ekranu</p>
      <div className="visually-hidden" aria-live="polite">
        {announcement}
      </div>
    </ToastContext.Provider>
  );
}
