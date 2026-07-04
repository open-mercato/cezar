'use client';

import { useId, useRef, type ReactNode } from 'react';
import { cn } from './cn';
import { useScrollLock } from '@/lib/use-scroll-lock';
import { useFocusTrap } from '@/lib/use-focus-trap';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Heading rendered in the title bar; also labels the dialog. */
  title?: ReactNode;
  /** Optional sub-text under the title. */
  description?: ReactNode;
  children: ReactNode;
  /** Footer actions. On phone they stack full-width (`flex-col-reverse`), inline + right-aligned on `sm+`. */
  footer?: ReactNode;
  /** `md` → max-w-md, `lg` → max-w-lg. Default `md`. */
  size?: 'md' | 'lg';
  /** Extra classes on the dialog panel. */
  className?: string;
}

/**
 * Unified centered modal primitive (spec §3.5 / §7), modeled on the four
 * existing run-* modals. Scroll-lock + focus-trap + Esc + backdrop-click close.
 * Body scrolls inside `max-h-[85dvh]`; footer buttons go full-width stacked on
 * phone. The four legacy modals adopt this in Phase 3 — this file does not
 * modify them.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  className,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useScrollLock(open);
  useFocusTrap(open, dialogRef, { onEscape: onClose });

  if (!open) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-overlay flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={cn(
          'flex max-h-[85dvh] w-full flex-col rounded-lg border border-outline-variant bg-surface-container-high shadow-ambient',
          size === 'lg' ? 'max-w-lg' : 'max-w-md',
          className,
        )}
      >
        {(title || description) && (
          <div className="shrink-0 px-5 pt-5">
            {title && (
              <h2 id={titleId} className="text-base font-semibold text-on-surface">
                {title}
              </h2>
            )}
            {description && <p className="mt-1 text-xs text-on-surface-variant">{description}</p>}
          </div>
        )}

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 flex-col-reverse gap-2 px-5 pb-5 pt-1 sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
