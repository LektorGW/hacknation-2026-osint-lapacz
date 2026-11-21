// Przełącznik motywu: domyślnie motyw systemowy, nadpisanie zapisane w `localStorage`
// i odzwierciedlone w `<meta name="color-scheme">`, z którego korzysta CSS.
import { useSyncExternalStore } from 'react';

type Scheme = 'light' | 'dark';

const KEY = 'color-scheme';
const CHANGED = 'olcys:scheme';
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
const meta = () => document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
const systemScheme = (): Scheme => (systemQuery.matches ? 'dark' : 'light');

function renderedScheme(): Scheme {
  const content = meta()?.content;
  return content === 'light' || content === 'dark' ? content : systemScheme();
}

function apply(value: string | null) {
  const element = meta();
  if (element) element.content = value === 'light' || value === 'dark' ? value : 'light dark';
  window.dispatchEvent(new Event(CHANGED));
}

/** Przełącza na motyw przeciwny do widocznego; powrót do zgodnego z systemem usuwa nadpisanie. */
export function toggleScheme(): void {
  const target: Scheme = renderedScheme() === 'dark' ? 'light' : 'dark';
  const stored = target === systemScheme() ? null : target;
  try {
    if (stored) localStorage.setItem(KEY, stored);
    else localStorage.removeItem(KEY);
  } catch {
    // Brak dostępu do pamięci przeglądarki: motyw działa do zamknięcia karty.
  }
  apply(stored);
}

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) apply(event.newValue);
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener('storage', onStorage);
  systemQuery.addEventListener('change', onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener('storage', onStorage);
    systemQuery.removeEventListener('change', onChange);
  };
}

export const useScheme = (): Scheme => useSyncExternalStore(subscribe, renderedScheme);
