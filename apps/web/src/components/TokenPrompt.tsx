// Okno logowania tokenem API: pojawia się, gdy usługa odpowie 401 (włączony OLCYS_API_TOKEN).
import { useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AUTH_EVENT, getToken, setToken } from '../auth.ts';
import '../lifecycle.css';

export function TokenPrompt() {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [value, setValue] = useState('');
  const [retry, setRetry] = useState(false);

  useEffect(() => {
    const open = () => {
      const dialog = ref.current;
      if (!dialog || dialog.open) return;
      // Token był już podany, a usługa i tak odmówiła — token jest nieaktualny.
      setRetry(getToken() !== null);
      dialog.showModal();
    };
    window.addEventListener(AUTH_EVENT, open);
    return () => window.removeEventListener(AUTH_EVENT, open);
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!value.trim()) return;
    setToken(value.trim());
    ref.current?.close();
    location.reload();
  }

  return (
    <dialog ref={ref} className="help case-dialog" aria-labelledby={`${id}-tytul`}>
      <form onSubmit={submit}>
        <h2 id={`${id}-tytul`}>Wymagane uwierzytelnienie</h2>
        <p>
          Usługa analizy wymaga tokenu API (OLCYS_API_TOKEN). Token zostaje tylko w tej karcie przeglądarki i znika po jej zamknięciu.
        </p>
        {retry && <p className="case-dialog-error">Podany wcześniej token został odrzucony — wpisz aktualny.</p>}
        <label htmlFor={`${id}-token`}>Token API</label>
        <input id={`${id}-token`} type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="current-password" autoFocus />
        <div className="case-dialog-actions">
          <button type="submit" className="button button-primary">
            Zaloguj
          </button>
        </div>
      </form>
    </dialog>
  );
}
