'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { cn } from '@/components/ui/cn';
import { MoreVerticalIcon } from '@/components/icons';
import { RowMenuPortal } from '@/components/row-menu-portal';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import { RunActionForPrModal } from './run-action-for-pr-modal';

export interface PrRowMenuProps {
  prNumber: number;
  prTitle: string;
  prUrl: string;
  readOnly?: boolean;
}

interface MenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  group: number;
}

export function PrRowMenu({ prNumber, prTitle, prUrl, readOnly = false }: PrRowMenuProps) {
  const [open, setOpen] = useState(false);
  const [runActionOpen, setRunActionOpen] = useState(false);
  const [pending] = useTransition();
  const [coarse, setCoarse] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Coarse pointer (touch) → open a bottom ActionSheet instead of the 224px
  // portal popover anchored to a tiny kebab.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(pointer: coarse)');
    const update = () => setCoarse(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    if (!open || coarse) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, coarse]);

  const doCopyNumber = useCallback(() => {
    void navigator.clipboard.writeText(`#${prNumber}`).then(
      () => undefined,
      () => alert('Could not copy to clipboard'),
    );
  }, [prNumber]);

  const items: MenuItem[] = [
    {
      id: 'run-action',
      label: 'Run action…',
      onSelect: () => setRunActionOpen(true),
      disabled: readOnly,
      group: 1,
    },
    {
      id: 'open',
      label: 'Open on GitHub',
      href: prUrl,
      group: 2,
    },
    {
      id: 'copy',
      label: 'Copy PR number',
      onSelect: doCopyNumber,
      group: 2,
    },
  ];

  function handleItemClick(item: MenuItem) {
    if (item.disabled) return;
    setOpen(false);
    if (item.href) {
      window.open(item.href, '_blank', 'noopener,noreferrer');
      return;
    }
    item.onSelect?.();
  }

  // Same items, mapped to the touch ActionSheet's shape. The sheet closes
  // itself before invoking onSelect, so each handler just runs its action.
  const sheetItems = useMemo<ActionSheetItem[]>(
    () =>
      items.map((item) => ({
        label: item.label,
        disabled: item.disabled || pending,
        onSelect: () => {
          if (item.href) {
            window.open(item.href, '_blank', 'noopener,noreferrer');
            return;
          }
          item.onSelect?.();
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, pending],
  );

  function handleTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen(true);
      requestAnimationFrame(() => {
        popoverRef.current
          ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([aria-disabled="true"])')
          ?.focus();
      });
    }
  }

  function handleMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const idx = active ? buttons.indexOf(active) : -1;
    const next =
      e.key === 'ArrowDown'
        ? buttons[(idx + 1) % buttons.length]
        : buttons[(idx - 1 + buttons.length) % buttons.length];
    next.focus();
  }

  const rendered: React.ReactNode[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (i > 0 && items[i - 1].group !== item.group) {
      rendered.push(
        <div key={`sep-${i}`} className="my-1 h-px bg-outline-variant/60" aria-hidden />,
      );
    }
    rendered.push(
      <button
        key={item.id}
        type="button"
        role="menuitem"
        aria-disabled={item.disabled ? 'true' : undefined}
        disabled={item.disabled || pending}
        onClick={() => handleItemClick(item)}
        className={cn(
          'block w-full px-3 py-2 text-left text-sm transition-colors',
          'focus:outline-none focus:bg-surface-container',
          'text-on-surface hover:bg-surface-container',
          (item.disabled || pending) && 'cursor-not-allowed opacity-40 hover:bg-transparent',
        )}
      >
        {item.label}
      </button>,
    );
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={`PR #${prNumber} actions`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKey}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface lg:h-7 lg:w-7 lg:min-h-0 lg:min-w-0"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>
      {coarse ? (
        <ActionSheet
          open={open}
          onClose={() => setOpen(false)}
          items={sheetItems}
          title={`PR #${prNumber}`}
        />
      ) : (
        <RowMenuPortal
          open={open}
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          onClose={() => setOpen(false)}
          id={menuId}
          ariaLabel={`PR #${prNumber} actions menu`}
          onKeyDown={handleMenuKey}
        >
          {rendered}
        </RowMenuPortal>
      )}
      {runActionOpen && (
        <RunActionForPrModal
          prNumber={prNumber}
          prTitle={prTitle}
          onClose={() => setRunActionOpen(false)}
        />
      )}
    </>
  );
}
