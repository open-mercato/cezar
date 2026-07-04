'use client';

import { useRef, type ReactNode } from 'react';
import { cn } from './cn';
import { useScrollLock } from '@/lib/use-scroll-lock';
import { useFocusTrap } from '@/lib/use-focus-trap';

export interface ActionSheetItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  icon?: ReactNode;
}

export interface ActionSheetProps {
  open: boolean;
  onClose: () => void;
  items: ActionSheetItem[];
  title?: ReactNode;
}

/**
 * Bottom action sheet for touch (spec §3.6 / §7 / P4) — the phone replacement
 * for the 224px portaled row menus, which are fiddly anchored to a tiny kebab.
 * Backdrop on `z-backdrop`, sheet on `z-popover` (sits above drawers/modals so
 * a row menu can open over a sheet). Scroll-lock + focus-trap; each item is
 * ≥44px; safe-area bottom padding so the last item clears the home indicator.
 *
 * Built generically — adoption (issue/pr/action/skill row menus) lands later.
 */
export function ActionSheet({ open, onClose, items, title }: ActionSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  useScrollLock(open);
  useFocusTrap(open, sheetRef, { onEscape: onClose });

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-backdrop bg-black/50 transition-opacity motion-reduce:transition-none"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={sheetRef}
        role="menu"
        aria-label={typeof title === 'string' ? title : 'Actions'}
        className={cn(
          'fixed inset-x-0 bottom-0 z-popover max-h-[80dvh] overflow-y-auto rounded-t-xl border-t border-outline-variant bg-surface-container-high shadow-ambient',
          'pb-[env(safe-area-inset-bottom)]',
          'transition-transform duration-200 ease-out motion-reduce:transition-none',
          'sm:left-1/2 sm:right-auto sm:w-full sm:max-w-sm sm:-translate-x-1/2',
        )}
      >
        {title && (
          <div className="border-b border-outline-variant px-4 py-3 text-center text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
            {title}
          </div>
        )}
        <div className="py-1">
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onSelect();
              }}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors',
                'hover:bg-surface-container focus:bg-surface-container focus:outline-none',
                item.danger ? 'text-error' : 'text-on-surface',
                item.disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
              )}
            >
              {item.icon && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
