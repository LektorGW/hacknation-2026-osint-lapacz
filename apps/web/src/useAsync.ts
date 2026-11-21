import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage } from './api.ts';

interface AsyncState<T> {
  data?: T;
  error?: string;
  loading: boolean;
}

/**
 * Pobiera dane przy montowaniu i przy zmianie `key`; `reload` ponawia pobranie,
 * zostawiając dotychczasowe dane na ekranie do czasu nadejścia nowych.
 */
export function useAsync<T>(load: () => Promise<T>, key: string): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  const [attempt, setAttempt] = useState(0);
  const loadedKey = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const sameKey = loadedKey.current === key;
    setState((current) => (sameKey ? { ...current, error: undefined, loading: true } : { loading: true }));
    load().then(
      (data) => {
        if (!active) return;
        loadedKey.current = key;
        setState({ data, loading: false });
      },
      (error: unknown) => {
        if (active) setState((current) => ({ data: sameKey ? current.data : undefined, error: errorMessage(error), loading: false }));
      },
    );
    return () => {
      active = false;
    };
    // `load` zależy wyłącznie od `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  return { ...state, reload };
}
