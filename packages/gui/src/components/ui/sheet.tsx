'use client';

import { useRef, type ReactNode } from 'react';
import { cn } from './cn';
import { CloseIcon } from '@/components/icons';
import { useScrollLock } from '@/lib/use-scroll-lock';
import { useFocusTrap } from '@/lib/use-focus-trap';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** `right` = side drawer on desktop / full-screen on phone; `bottom` = bottom sheet. Default `right`. */
  side?: 'right' | 'bottom';
  title?: ReactNode;
  children: ReactNode;
  /** Extra classes on the scrollable body wrapper. */
  className?: string;
  /** Desktop side-drawer width when `side='right'`. Default `lg:w-[420px]`. */
  widthClass?: string;
}

/**
 * Responsive overlay primitive (spec §3.5 / §7). Backdrop on `z-backdrop`,
 * panel on `z-overlay`. Locks background scroll and traps focus while open.
 *
 * Phone:
 *   - `side='right'`  → full-screen panel (full width + height).
 *   - `side='bottom'` → bottom sheet, `max-h-[90dvh]`, rounded top.
 * Desktop (`lg:`):
 *   - `side='right'`  → side drawer pinned right at `widthClass` (default 420px).
 *   - `side='bottom'` → stays a bottom sheet (centered max-width).
 *
 * Slide transition honors `prefers-reduced-motion` via `motion-reduce:`.
 * The close button is ≥44px. Body is `overflow-y-auto`.
 *
 * Swipe-down-to-dismiss on the bottom sheet is NOT implemented (deferred — the
 * cheap-only carve-out in the spec; a pointer-drag gesture with velocity
 * thresholds is more than "cheap"). Backdrop tap + Esc + close button cover
 * dismissal for v1.
 */
export function Sheet({
  open,
  onClose,
  side = 'right',
  title,
  children,
  className,
  widthClass = 'lg:w-[420px]',
}: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useScrollLock(open);
  useFocusTrap(open, panelRef, { onEscape: onClose });

  if (!open) return null;

  const isBottom = side === 'bottom';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-backdrop bg-black/50 transition-opacity motion-reduce:transition-none"
        onClick={onClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cn(
          'fixed z-overlay flex flex-col bg-surface-container-high shadow-ambient',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          isBottom
            ? cn(
                // Bottom sheet (phone + desktop): pinned to the bottom edge.
                'inset-x-0 bottom-0 max-h-[90dvh] rounded-t-xl border-t border-outline-variant',
                // Center + cap width on larger screens.
                'sm:left-1/2 sm:right-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2',
              )
            : cn(
                // Right drawer: full-screen on phone, pinned side panel at `lg`.
                'inset-0 w-full border-outline-variant',
                'lg:inset-y-0 lg:left-auto lg:right-0 lg:border-l',
                widthClass,
              ),
        )}
      >
        {(title || true) && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-outline-variant px-4 py-3">
            <div className="min-w-0 flex-1 text-sm font-semibold text-on-surface">{title}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="-mr-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface lg:h-9 lg:w-9"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className={cn('flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]', className)}>
          {children}
        </div>
      </div>
    </>
  );
}
