// „Do potwierdzenia”: jedna kolejka wszystkich rozstrzygnięć czekających na analityka.
// Karty od najważniejszej (pieniądze, osoba, adresy…), trzy przyciski i skróty klawiszowe P / O / S, J / K.
// Decyzje idą tym samym API co karty teczki (cel + klucz) i każdą można cofnąć.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { fmtDateTime, fmtPln } from '../format.ts';
import { DECISION_LABEL } from '../labels.ts';
import { REVIEW_KIND_LABEL, REVIEW_KIND_ORDER, collectReview, countByKind, decisionNote, isReviewOnly } from '../review.ts';
import type { DecidedEntry, ReviewItem, ReviewKind } from '../review.ts';
import { tabLabel } from '../router.ts';
import { countText } from '../ux.ts';
import { useDossier } from './DossierContext.tsx';
import { useToast } from './Toast.tsx';
import { Disclosure } from './ui/Disclosure.tsx';
import { Score } from './ui/Score.tsx';
import '../review.css';

/** Czas animacji wyjścia karty — zgodny z `review.css`. */
const LEAVE_MS = 260;

type Choice = 'confirmed' | 'rejected';

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function Evidence({ item }: { item: ReviewItem }) {
  if (item.evidence.length === 0) return null;
  return (
    <ul className="review-evidence" aria-label="Najważniejsze ślady">
      {item.evidence.map((entry) => (
        <li key={entry.url ?? entry.label}>
          {entry.url ? (
            <a className="chip review-evidence-chip" href={entry.url} target="_blank" rel="noopener noreferrer">
              {entry.label} <span aria-hidden="true">↗</span>
              <span className="visually-hidden"> (otwiera się w nowej karcie)</span>
            </a>
          ) : (
            <span className="chip review-evidence-chip">{entry.label}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

interface CardProps {
  item: ReviewItem;
  active: boolean;
  leaving: boolean;
  skipped: boolean;
  busy: boolean;
  readOnly: string | null;
  note: string;
  onNote(value: string): void;
  onDecide(choice: Choice): void;
  onSkip(): void;
  onFocus(): void;
}

function ReviewCard({ item, active, leaving, skipped, busy, readOnly, note, onNote, onDecide, onSkip, onFocus }: CardProps) {
  const { tabHref } = useDossier();
  const titleId = useId();
  const noteId = useId();
  const reviewOnly = isReviewOnly(item);
  const needsNote = item.noteRequired === true && note.trim() === '';
  const blocked = busy || leaving || readOnly !== null;
  return (
    <li className={`review-item ${leaving ? 'is-leaving' : ''}`}>
      <article
        className={`card review-card kind-${item.kind} ${active ? 'is-active' : ''} ${skipped ? 'is-skipped' : ''}`}
        aria-labelledby={titleId}
        aria-current={active ? 'true' : undefined}
        data-review-id={item.id}
        onFocusCapture={onFocus}
        onMouseDown={onFocus}
      >
        <div className="review-card-top">
          <span className="review-kind">{REVIEW_KIND_LABEL[item.kind]}</span>
          {item.valuePln !== undefined && item.valuePln > 0 && <span className="chip review-value tabular">{fmtPln(item.valuePln)}</span>}
          {skipped && <span className="chip">pominięte</span>}
          {reviewOnly && <span className="chip chip-inference">do sprawdzenia</span>}
        </div>
        <div className="review-card-main">
          <h3 id={titleId} className="review-title">
            {item.title}
          </h3>
          {item.score && <Score value={item.score.value} kind={item.score.kind} reasons={item.score.reasons} caption={item.score.caption} />}
        </div>
        <p className="review-why">
          <strong>Dlaczego to ważne:</strong> {item.why}
        </p>
        <Evidence item={item} />
        <dl className="review-effects">
          {reviewOnly ? (
            <div>
              <dt>Co zrobić</dt>
              <dd>{item.confirmEffect}</dd>
            </div>
          ) : (
            <>
              <div>
                <dt>Potwierdź</dt>
                <dd>{item.confirmEffect}</dd>
              </div>
              <div>
                <dt>Odrzuć</dt>
                <dd>{item.rejectEffect}</dd>
              </div>
            </>
          )}
        </dl>
        {!reviewOnly && (
          <details className="review-note" open={item.noteRequired || note !== '' || undefined}>
            <summary>{item.noteRequired ? 'Podstawa potwierdzenia (wymagana)' : 'Dodaj notatkę (opcjonalnie)'}</summary>
            <label htmlFor={noteId} className="visually-hidden">
              {item.noteRequired ? 'Podstawa potwierdzenia, np. numer pisma usługi' : 'Notatka do decyzji'}
            </label>
            <input
              id={noteId}
              type="text"
              value={note}
              onChange={(event) => onNote(event.target.value)}
              placeholder={item.noteRequired ? 'np. pismo giełdy z 12.11.2026, sygn. …' : item.confirmNote}
              autoComplete="off"
              disabled={blocked}
            />
          </details>
        )}
        <div className="review-actions">
          {reviewOnly ? (
            <a className="button button-primary" href={tabHref(item.tab)}>
              Otwórz w sekcji „{tabLabel(item.tab)}”
            </a>
          ) : (
            <>
              <button
                type="button"
                className="button button-primary"
                disabled={blocked || needsNote}
                title={needsNote ? 'Najpierw wpisz podstawę potwierdzenia' : 'Skrót: P'}
                onClick={() => onDecide('confirmed')}
              >
                Potwierdź <kbd aria-hidden="true">P</kbd>
              </button>
              <button type="button" className="button" disabled={blocked} title="Skrót: O" onClick={() => onDecide('rejected')}>
                Odrzuć <kbd aria-hidden="true">O</kbd>
              </button>
            </>
          )}
          <button type="button" className="button button-quiet" disabled={leaving} title="Przenosi kartę na koniec kolejki — skrót: S" onClick={onSkip}>
            Pomiń <kbd aria-hidden="true">S</kbd>
          </button>
          {!reviewOnly && (
            <a className="review-more" href={tabHref(item.tab)}>
              Szczegóły: {tabLabel(item.tab)} →
            </a>
          )}
        </div>
        {readOnly && !reviewOnly && <p className="muted small">{readOnly}</p>}
      </article>
    </li>
  );
}

/** Licznik „N do potwierdzenia” (nagłówek teczki, lista spraw) — odnośnik prosto do kolejki; przy zerze nic nie pokazuje. */
export function PendingChip({ count, href, small = false }: { count: number | undefined; href: string; small?: boolean }) {
  if (!count) return null;
  return (
    <a className={`review-chip ${small ? 'review-chip-small' : ''}`} href={href} title="Otwórz kolejkę „Do potwierdzenia”">
      {count} do potwierdzenia
    </a>
  );
}

function DecidedList({ entries }: { entries: DecidedEntry[] }) {
  const { undo, tabHref } = useDossier();
  const [busy, setBusy] = useState<string | null>(null);
  if (entries.length === 0) return null;
  async function withdraw(id: string) {
    setBusy(id);
    try {
      await undo(id);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Disclosure title="Zdecydowane" meta={entries.length} className="review-decided">
      <ul className="review-decided-list">
        {entries.map((entry) => (
          <li key={entry.decisionId}>
            <span className={`chip ${entry.decision === 'confirmed' ? 'chip-ok' : 'chip-warn'}`}>{DECISION_LABEL[entry.decision] ?? entry.decision}</span>
            <span className="review-decided-label">
              <a href={tabHref(entry.tab)}>{entry.label}</a>
              <span className="muted small">
                {' '}
                · {fmtDateTime(entry.decidedAt)}
                {entry.note && ` — „${entry.note}”`}
              </span>
            </span>
            <button type="button" className="button button-small" disabled={busy === entry.decisionId} onClick={() => withdraw(entry.decisionId)}>
              Cofnij
            </button>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

export function ReviewQueue() {
  const { dossier, summary, simplified, reload, tabHref } = useDossier();
  const toast = useToast();
  const queue = useMemo(() => collectReview(dossier), [dossier]);
  const [filter, setFilter] = useState<ReviewKind | 'all'>('all');
  const [skipped, setSkipped] = useState<string[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [leaving, setLeaving] = useState<string[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Nowa teczka (po przeliczeniu) już nie zawiera rozstrzygniętych pozycji — ukrywanie lokalne nie jest potrzebne.
  useEffect(() => {
    setHidden([]);
    setLeaving([]);
  }, [dossier]);

  const readOnly = simplified
    ? 'Ta wersja usługi analizy nie zapisuje decyzji — kolejka jest tylko do odczytu.'
    : summary.status && summary.status !== 'open'
      ? 'Sprawa jest zamknięta — decyzje są zablokowane (najpierw przywróć sprawę).'
      : null;

  const counts = countByKind(queue.pending);
  const visible = queue.pending
    .filter((item) => !hidden.includes(item.id))
    .filter((item) => filter === 'all' || item.kind === filter)
    .map((item, order) => ({ item, order }))
    // Pominięte idą na koniec — w kolejności pomijania.
    .sort((a, b) => skipped.indexOf(a.item.id) - skipped.indexOf(b.item.id) || a.order - b.order)
    .map(({ item }) => item);
  const activeIndex = Math.max(0, visible.findIndex((item) => item.id === activeId));
  const active = visible[activeIndex];

  async function decide(item: ReviewItem, choice: Choice) {
    if (readOnly || busy || isReviewOnly(item)) return;
    const typed = notes[item.id] ?? '';
    if (choice === 'confirmed' && item.noteRequired && !typed.trim()) {
      toast.error(new Error('Wpisz podstawę potwierdzenia — np. numer pisma usługi.'));
      return;
    }
    const calls = choice === 'confirmed' ? item.confirm : item.reject;
    setBusy(item.id);
    try {
      for (const call of calls) {
        await api.addDecision(summary.id, { target: call.target, key: call.key, decision: choice, note: decisionNote(item, choice, typed) });
      }
    } catch (error) {
      toast.error(error);
      setBusy(null);
      // Część decyzji mogła się zapisać — teczka pokaże stan faktyczny.
      reload();
      return;
    }
    setBusy(null);
    setLeaving((current) => [...current, item.id]);
    toast.success(`${choice === 'confirmed' ? 'Potwierdzono' : 'Odrzucono'} — teczka zostanie przeliczona. Decyzję można cofnąć niżej, w „Zdecydowane”.`);
    window.setTimeout(
      () => {
        setHidden((current) => [...current, item.id]);
        reload();
      },
      reducedMotion() ? 0 : LEAVE_MS,
    );
  }

  function skip(item: ReviewItem) {
    setSkipped((current) => [...current.filter((id) => id !== item.id), item.id]);
    // Następna karta zajmuje miejsce pominiętej.
    const next = visible[activeIndex + 1] ?? visible[0];
    if (next && next.id !== item.id) setActiveId(next.id);
  }

  function move(step: number) {
    if (visible.length === 0) return;
    const next = visible[(activeIndex + step + visible.length) % visible.length]!;
    setActiveId(next.id);
    const card = listRef.current?.querySelector<HTMLElement>(`[data-review-id="${CSS.escape(next.id)}"]`);
    card?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  // Skróty klawiszowe: P potwierdź, O odrzuć, S pomiń, J / K następna / poprzednia karta.
  const handler = useRef<(event: KeyboardEvent) => void>(() => {});
  handler.current = (event: KeyboardEvent) => {
    if (!active) return;
    const key = event.key.toLowerCase();
    if (key === 'p') decide(active, 'confirmed');
    else if (key === 'o') decide(active, 'rejected');
    else if (key === 's') skip(active);
    else if (key === 'j') move(1);
    else if (key === 'k') move(-1);
    else return;
    event.preventDefault();
  };
  useEffect(() => {
    let previous = '';
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const last = previous;
      previous = event.key;
      // „g” rozpoczyna skrót nawigacji aplikacji (np. „g p” — pulpit): następnej litery nie przechwytujemy.
      if (last === 'g' || event.ctrlKey || event.metaKey || event.altKey || target?.closest('input, textarea, select, [contenteditable], dialog')) return;
      handler.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const kinds = REVIEW_KIND_ORDER.filter((kind) => (counts[kind] ?? 0) > 0);
  const total = queue.pending.filter((item) => !hidden.includes(item.id)).length;

  return (
    <section className="review" aria-labelledby="do-potwierdzenia-tytul">
      <header className="review-head">
        <div>
          <h2 id="do-potwierdzenia-tytul">
            Do potwierdzenia <span className={`review-count ${total === 0 ? 'is-zero' : ''}`}>{total}</span>
          </h2>
          <p className="muted">
            Wszystko, co czeka na Twoją decyzję, w jednym miejscu — od najważniejszego: pieniądze, osoba, adresy, tożsamości. Każdą decyzję można
            cofnąć w <a href={tabHref('decyzje')}>Rejestrze decyzji</a>.
          </p>
        </div>
        {total > 0 && (
          <p className="review-keys no-print" aria-label="Skróty klawiszowe">
            <kbd>P</kbd> potwierdź <kbd>O</kbd> odrzuć <kbd>S</kbd> pomiń <kbd>J</kbd>/<kbd>K</kbd> następna / poprzednia
          </p>
        )}
      </header>

      {kinds.length > 1 && (
        <div className="review-filters" role="group" aria-label="Pokaż rodzaj">
          <button type="button" className="review-filter" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Wszystkie <span className="review-filter-count">{total}</span>
          </button>
          {kinds.map((kind) => (
            <button key={kind} type="button" className="review-filter" aria-pressed={filter === kind} onClick={() => setFilter(filter === kind ? 'all' : kind)}>
              {REVIEW_KIND_LABEL[kind]} <span className="review-filter-count">{counts[kind]}</span>
            </button>
          ))}
        </div>
      )}

      {readOnly && <p className="notice notice-quiet" role="note">{readOnly}</p>}

      {visible.length === 0 ? (
        <div className="review-empty" role="status">
          <p className="review-empty-title">{total === 0 ? 'Nic nie czeka na decyzję' : 'W tym filtrze nic nie zostało'}</p>
          <p className="muted">
            {total === 0
              ? 'Wszystkie hipotezy w tej teczce są rozstrzygnięte albo mają wynik, który nie wymaga Twojego zdania. Nowe pozycje pojawią się po kolejnej analizie.'
              : `Pozostałe pozycje (${countText(total, 'pozycja', 'pozycje', 'pozycji')}) są w innych rodzajach.`}
          </p>
          {total > 0 && (
            <button type="button" className="button" onClick={() => setFilter('all')}>
              Pokaż wszystkie
            </button>
          )}
        </div>
      ) : (
        <ol className="review-list" ref={listRef} aria-label="Pozycje do potwierdzenia">
          {visible.map((item) => (
            <ReviewCard
              key={item.id}
              item={item}
              active={item.id === active?.id}
              leaving={leaving.includes(item.id)}
              skipped={skipped.includes(item.id)}
              busy={busy === item.id}
              readOnly={readOnly}
              note={notes[item.id] ?? ''}
              onNote={(value) => setNotes((current) => ({ ...current, [item.id]: value }))}
              onDecide={(choice) => decide(item, choice)}
              onSkip={() => skip(item)}
              onFocus={() => setActiveId(item.id)}
            />
          ))}
        </ol>
      )}

      <DecidedList entries={queue.decided} />
    </section>
  );
}
