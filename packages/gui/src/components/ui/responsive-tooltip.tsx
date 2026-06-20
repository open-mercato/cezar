'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn';

const OPEN_DELAY_MS = 80;
const CLOSE_DELAY_MS = 120;
const TOOLTIP_MARGIN = 6;
const VIEWPORT_PAD = 8;

export interface ResponsiveTooltipProps {
  /** Tooltip body. */
  content: ReactNode;
  /** The trigger element(s). */
  children: ReactNode;
  /** Classes on the inline trigger wrapper. */
  className?: string;
}

/**
 * Hover-or-tap tooltip (spec §3.4 / §7). Replaces `title=` attributes and the
 * hover-only RunStatusDots/latency tooltips.
 *
 *  - `(pointer: fine)`   → hover-to-show, with the same open/close grace timing
 *    as run-status-dots so the pointer can travel into the tooltip.
 *  - `(pointer: coarse)` → tap-to-toggle; dismisses on outside tap or scroll.
 *
 * The popover is portaled to `document.body` on `z-tooltip`, clamped on-screen,
 * and width-capped at `max-w-[min(320px,calc(100vw-16px))]` so it never
 * overflows a phone viewport.
 */
export function ResponsiveTooltip({ content, children, className }: ResponsiveTooltipProps) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coarse, setCoarse] = useState(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const clearTimers = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  };

  // Hover (pointer:fine) grace timing.
  const onHover = (hovering: boolean) => {
    if (coarse) return;
    clearTimers();
    if (hovering) showTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
    else hideTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  };

  // Esc closes immediately (both variants).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Tap variant: dismiss on outside tap / scroll.
  useEffect(() => {
    if (!open || !coarse) return;
    function onDown(e: Event) {
      const t = e.target as Node | null;
      if (t && anchorRef.current?.contains(t)) return;
      setOpen(false);
    }
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', () => setOpen(false), true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', () => setOpen(false), true);
    };
  }, [open, coarse]);

  useEffect(() => clearTimers, []);

  return (
    <span
      ref={anchorRef}
      className={cn('inline-flex', className)}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => !coarse && setOpen(true)}
      onBlur={() => !coarse && setOpen(false)}
      onClick={(e) => {
        if (!coarse) return;
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      {children}
      {open && (
        <TooltipPortal
          anchorRef={anchorRef}
          onEnter={() => onHover(true)}
          onLeave={() => onHover(false)}
        >
          {content}
        </TooltipPortal>
      )}
    </span>
  );
}

function TooltipPortal({
  anchorRef,
  onEnter,
  onLeave,
  children,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onEnter: () => void;
  onLeave: () => void;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  useLayoutEffect(() => {
    if (!mounted) return;
    const anchor = anchorRef.current;
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const a = anchor.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const spaceBelow = window.innerHeight - a.bottom;
    const wantsAbove = spaceBelow < p.height + TOOLTIP_MARGIN + VIEWPORT_PAD;
    const top = wantsAbove
      ? Math.max(VIEWPORT_PAD, a.top - p.height - TOOLTIP_MARGIN)
      : a.bottom + TOOLTIP_MARGIN;
    const rawLeft = a.left + a.width / 2 - p.width / 2;
    const left = Math.min(
      Math.max(VIEWPORT_PAD, rawLeft),
      window.innerWidth - p.width - VIEWPORT_PAD,
    );
    setCoords({ top, left });
  }, [anchorRef, mounted]);

  if (!mounted) return null;
  return createPortal(
    <div
      ref={popRef}
      role="tooltip"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      style={{
        position: 'fixed',
        top: coords?.top ?? -9999,
        left: coords?.left ?? -9999,
        opacity: coords ? 1 : 0,
      }}
      className="z-tooltip max-w-[min(320px,calc(100vw-16px))] overflow-hidden rounded-md border border-outline-variant bg-surface-container-high px-3 py-2 text-xs text-on-surface shadow-ambient"
    >
      {children}
    </div>,
    document.body,
  );
}
