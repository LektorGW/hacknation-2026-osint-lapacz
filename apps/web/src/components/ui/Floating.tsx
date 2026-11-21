// Warstwa pływająca (podpowiedź, wyjaśnienie wyniku) przypięta do elementu-kotwicy.
// Renderowana w portalu — nie przycinają jej kontenery z `overflow`. Pozycja liczona tak,
// by zawsze mieściła się w oknie: domyślnie pod kotwicą, nad nią, gdy brakuje miejsca.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const MARGIN = 8;

interface Position {
  top: number;
  left: number;
  side: 'top' | 'bottom';
  arrow: number;
}

function place(anchor: DOMRect, floating: DOMRect): Position {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const below = height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const side = floating.height <= below || below >= above ? 'bottom' : 'top';
  let top = side === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - floating.height;
  top = Math.max(MARGIN, Math.min(top, height - floating.height - MARGIN));
  const centre = anchor.left + anchor.width / 2;
  const left = Math.max(MARGIN, Math.min(centre - floating.width / 2, width - floating.width - MARGIN));
  const arrow = Math.max(12, Math.min(centre - left, floating.width - 12));
  return { top, left, side, arrow };
}

interface FloatingProps {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  id: string;
  role?: 'tooltip' | 'dialog';
  label?: string;
  className?: string;
  children: ReactNode;
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
}

export function Floating({ anchor, open, onClose, id, role = 'tooltip', label, className = '', children, onPointerEnter, onPointerLeave }: FloatingProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Position>();

  const update = useCallback(() => {
    const anchorElement = anchor.current;
    const floating = ref.current;
    if (!anchorElement || !floating) return;
    setPosition(place(anchorElement.getBoundingClientRect(), floating.getBoundingClientRect()));
  }, [anchor]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(undefined);
      return;
    }
    update();
  }, [open, update]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open, update, onClose, anchor]);

  if (!open) return null;
  // Wewnątrz otwartego okna modalnego portal musi trafić do okna — inaczej warstwa znalazłaby się pod nim.
  const host = anchor.current?.closest('dialog[open]') ?? document.body;
  const style: CSSProperties = position
    ? ({ top: position.top, left: position.left, '--arrow-x': `${position.arrow}px` } as CSSProperties)
    : { top: 0, left: 0, visibility: 'hidden' };
  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={label}
      className={`floating ${className}`}
      data-side={position?.side ?? 'bottom'}
      style={style}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      {children}
    </div>,
    host,
  );
}
