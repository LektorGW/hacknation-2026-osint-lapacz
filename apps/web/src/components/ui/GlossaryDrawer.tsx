// Szuflada „Słownik pojęć”: wszystkie hasła w grupach, z wyszukiwaniem. Otwierana z menu pomocy i z podpowiedzi <Term>.
import { useEffect, useId, useRef, useState } from 'react';
import { GLOSSARY, GLOSSARY_GROUPS, searchGlossary } from '../../glossary.ts';
import type { GlossaryId } from '../../glossary.ts';
import { GLOSSARY_EVENT } from './Term.tsx';

export function GlossaryDrawer() {
  const dialog = useRef<HTMLDialogElement>(null);
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [focus, setFocus] = useState<GlossaryId>();

  useEffect(() => {
    const onOpen = (event: Event) => {
      const id = (event as CustomEvent<GlossaryId | undefined>).detail;
      setQuery('');
      setFocus(id);
      // Pomoc jest oknem modalnym — szuflada otwiera się zamiast niej, nie pod nią.
      document.querySelectorAll<HTMLDialogElement>('dialog.help[open]').forEach((element) => element.close());
      if (!dialog.current?.open) dialog.current?.showModal();
    };
    window.addEventListener(GLOSSARY_EVENT, onOpen);
    return () => window.removeEventListener(GLOSSARY_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!focus) return;
    const element = document.getElementById(`haslo-${focus}`);
    element?.scrollIntoView({ block: 'center' });
  }, [focus]);

  const ids = new Set(searchGlossary(query));

  return (
    <dialog ref={dialog} className="drawer" aria-labelledby="slownik-tytul" {...{ closedby: 'any' }} onClose={() => setFocus(undefined)}>
      <header className="drawer-head">
        <div>
          <h2 id="slownik-tytul">Słownik pojęć</h2>
          <p className="muted">Krótko i bez żargonu: co znaczą słowa, które widzisz w teczce.</p>
        </div>
        <form method="dialog">
          <button className="icon-button" aria-label="Zamknij słownik">
            <span aria-hidden="true">×</span>
          </button>
        </form>
      </header>
      <label htmlFor={searchId} className="visually-hidden">
        Szukaj pojęcia
      </label>
      <input
        id={searchId}
        type="search"
        className="drawer-search"
        placeholder="Szukaj, np. giełda, adres wpłat, skrót"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoComplete="off"
        // Atrybut HTML `autofocus`: okno modalne samo ustawia fokus w polu wyszukiwania przy otwarciu.
        ref={(element) => element?.setAttribute('autofocus', '')}
      />
      <div className="drawer-body">
        {ids.size === 0 && <p className="muted">Nie znaleziono pojęcia „{query}”. Spróbuj innego słowa.</p>}
        {GLOSSARY_GROUPS.map((group) => {
          const items = (Object.keys(GLOSSARY) as GlossaryId[]).filter((id) => GLOSSARY[id].group === group.id && ids.has(id));
          if (items.length === 0) return null;
          return (
            <section key={group.id} className="glossary-group" aria-labelledby={`grupa-${group.id}`}>
              <h3 id={`grupa-${group.id}`}>{group.label}</h3>
              <dl>
                {items.map((id) => (
                  <div key={id} id={`haslo-${id}`} className={`glossary-item ${focus === id ? 'is-focus' : ''}`}>
                    <dt>{GLOSSARY[id].term}</dt>
                    <dd>
                      {GLOSSARY[id].short}
                      {GLOSSARY[id].why && <span className="glossary-why">{GLOSSARY[id].why}</span>}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
    </dialog>
  );
}
