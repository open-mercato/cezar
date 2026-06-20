'use client';

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './ui/cn';

// 14rem in our default Tailwind config — matches `w-56` on the panel.
const MENU_WIDTH = 224;
const VIEWPORT_MARGIN = 8;

export interface RowMenuPortalProps {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  /** Receives the rendered popover node so the parent can call `.contains()` for click-outside. */
  popoverRef: RefObject<HTMLDivElement | null>;
  /** Close handler — invoked when the viewport scrolls or resizes. */
  onClose: () => void;
  id?: string;
  ariaLabel?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  className?: string;
  children: React.ReactNode;
}

/**
 * Portaled, fixed-position dropdown anchored under a row-level kebab trigger.
 * Used by /actions, /issues, and /prs row menus so the popover escapes the
 * surrounding table's `overflow-hidden` / `overflow-x-auto` chrome — without
 * the portal, the menu gets clipped to the table boundary.
 *
 * Positioning: right-aligned with the trigger; flips above if there isn't
 * enough room below; clamped 8px inside the viewport on both axes.
 */
export function RowMenuPortal({
  open,
  triggerRef,
  popoverRef,
  onClose,
  id,
  ariaLabel,
  onKeyDown,
  className,
  children,
}: RowMenuPortalProps) {
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // useLayoutEffect so we measure synchronously before paint and don't flash
  // the menu at (0,0) before it settles.
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const estimatedHeight = 8 * 36; // rough cap — actual menu shrinks/grows; only matters for the flip decision
    const wantsAbove =
      rect.bottom + estimatedHeight + VIEWPORT_MARGIN > window.innerHeight &&
      rect.top > estimatedHeight;
    const top = wantsAbove ? rect.top - estimatedHeight - 4 : rect.bottom + 4;
    const rawLeft = rect.right - MENU_WIDTH;
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rawLeft),
      window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN,
    );
    setCoords({ top: Math.max(VIEWPORT_MARGIN, top), left });
  }, [open, triggerRef]);

  // Close on viewport changes — re-positioning while scrolling would feel
  // jittery, so we just dismiss instead.
  useEffect(() => {
    if (!open) return;
    function bail() {
      onClose();
    }
    window.addEventListener('scroll', bail, true);
    window.addEventListener('resize', bail);
    return () => {
      window.removeEventListener('scroll', bail, true);
      window.removeEventListener('resize', bail);
    };
  }, [open, onClose]);

  if (!open || !mounted || !coords) return null;

  return createPortal(
    <div
      ref={popoverRef as React.RefObject<HTMLDivElement>}
      id={id}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      style={{ position: 'fixed', top: coords.top, left: coords.left, width: MENU_WIDTH }}
      className={cn(
        'z-50 origin-top-right rounded-md border border-outline-variant bg-surface-container-high py-1 shadow-ambient',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
