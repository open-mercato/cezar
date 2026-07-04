'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { MoreVerticalIcon } from '@/components/icons';
import { RowMenuPortal } from '@/components/row-menu-portal';
import { ActionSheet, type ActionSheetItem } from '@/components/ui/action-sheet';
import {
  clearAutoTriage,
  deleteAction,
  duplicateAction,
  overrideBuiltInAction,
  resetBuiltInToDefault,
  setActionEnabled,
  setAutoTriage,
} from '@/app/actions/[name]/action-mutations';
import { RunNowModal } from './run-now-modal';

export interface ActionRowMenuProps {
  id: string;
  name: string;
  kind: 'built-in' | 'user';
  target: 'issue' | 'pr';
  enabled: boolean;
  isAutoTriage: boolean;
  hasUserOverride: boolean;
  readOnly?: boolean;
  /** Optimistic status flip parent callback — keeps the row's pill in sync. */
  onEnabledChange?: (enabled: boolean) => void;
}

interface MenuItem {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  variant?: 'primary' | 'destructive';
  disabled?: boolean;
  group: number;
}

export function ActionRowMenu({
  id,
  name,
  kind,
  target,
  enabled,
  isAutoTriage,
  hasUserOverride,
  readOnly = false,
  onEnabledChange,
}: ActionRowMenuProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [runNowOpen, setRunNowOpen] = useState(false);
  const [pending, startTransition] = useTransition();
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

  // ── close-on-outside-click / Esc ─────────────────────────────────────────
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

  // ── server-action wrappers ───────────────────────────────────────────────
  const doToggle = useCallback(() => {
    const next = !enabled;
    onEnabledChange?.(next);
    startTransition(async () => {
      const r = await setActionEnabled(name, next);
      if (!r.ok) {
        onEnabledChange?.(enabled);
        alert(r.error ?? 'Could not toggle this action');
      }
      router.refresh();
    });
  }, [enabled, name, onEnabledChange, router]);

  const doSetAutoTriage = useCallback(() => {
    startTransition(async () => {
      const r = await setAutoTriage(id);
      if (!r.ok) alert(r.error ?? 'Could not set auto-triage');
      router.refresh();
    });
  }, [id, router]);

  const doClearAutoTriage = useCallback(() => {
    startTransition(async () => {
      const r = await clearAutoTriage();
      if (!r.ok) alert(r.error ?? 'Could not clear auto-triage');
      router.refresh();
    });
  }, [router]);

  const doOverride = useCallback(() => {
    startTransition(async () => {
      const r = await overrideBuiltInAction(name);
      if (!r.ok) {
        alert(r.error ?? 'Could not override this built-in');
        return;
      }
      router.push(`/actions/${encodeURIComponent(r.slug ?? name)}`);
    });
  }, [name, router]);

  const doReset = useCallback(() => {
    if (
      !window.confirm(`Reset "${name}" to the built-in default? Your customisations will be lost.`)
    )
      return;
    startTransition(async () => {
      const r = await resetBuiltInToDefault(name);
      if (!r.ok) alert(r.error ?? 'Could not reset');
      router.refresh();
    });
  }, [name, router]);

  const doDuplicate = useCallback(() => {
    startTransition(async () => {
      const r = await duplicateAction(name);
      if (!r.ok || !r.newName) {
        alert(r.error ?? 'Could not duplicate');
        return;
      }
      router.push(`/actions/${encodeURIComponent(r.newName)}`);
    });
  }, [name, router]);

  const doCopyName = useCallback(() => {
    void navigator.clipboard.writeText(name).then(
      () => undefined,
      () => alert('Could not copy to clipboard'),
    );
  }, [name]);

  const doDelete = useCallback(() => {
    if (!window.confirm(`Delete the user action "${name}"? This cannot be undone.`)) return;
    startTransition(async () => {
      const r = await deleteAction(name);
      if (!r.ok) alert(r.error ?? 'Could not delete');
      router.refresh();
    });
  }, [name, router]);

  // ── menu shape ───────────────────────────────────────────────────────────
  const items: MenuItem[] = [
    { id: 'open', label: 'Open details', href: `/actions/${encodeURIComponent(name)}`, group: 1 },
    {
      id: 'run',
      label: 'Run now…',
      onSelect: () => setRunNowOpen(true),
      disabled: readOnly,
      group: 1,
    },
    {
      id: 'toggle',
      label: enabled ? 'Disable' : 'Enable',
      onSelect: doToggle,
      disabled: readOnly,
      group: 1,
    },
  ];

  if (target === 'issue') {
    if (isAutoTriage) {
      items.push({
        id: 'unset-auto-triage',
        label: 'Unset auto-triage',
        onSelect: doClearAutoTriage,
        disabled: readOnly,
        group: 2,
      });
    } else {
      items.push({
        id: 'set-auto-triage',
        label: 'Set as auto-triage',
        onSelect: doSetAutoTriage,
        disabled: readOnly,
        group: 2,
      });
    }
  }

  if (kind === 'built-in') {
    if (hasUserOverride) {
      items.push({
        id: 'reset',
        label: 'Reset to default',
        onSelect: doReset,
        disabled: readOnly,
        group: 3,
      });
    } else {
      items.push({
        id: 'override',
        label: 'Override (copy & edit)',
        onSelect: doOverride,
        disabled: readOnly,
        group: 3,
      });
    }
  }

  items.push({
    id: 'duplicate',
    label: 'Duplicate',
    onSelect: doDuplicate,
    disabled: readOnly,
    group: 4,
  });
  items.push({ id: 'copy-name', label: 'Copy name', onSelect: doCopyName, group: 5 });
  items.push({
    id: 'delete',
    label: 'Delete',
    onSelect: doDelete,
    disabled: readOnly || kind !== 'user',
    variant: 'destructive',
    group: 6,
  });

  // ── render ───────────────────────────────────────────────────────────────
  function handleItemClick(item: MenuItem) {
    if (item.disabled) return;
    setOpen(false);
    if (item.href) {
      router.push(item.href);
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
        danger: item.variant === 'destructive',
        onSelect: () => {
          if (item.href) {
            router.push(item.href);
            return;
          }
          item.onSelect?.();
        },
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, pending, router],
  );

  function menuButtons(): HTMLButtonElement[] {
    return Array.from(
      popoverRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not([aria-disabled="true"])',
      ) ?? [],
    );
  }

  function handleTriggerKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const toLast = e.key === 'ArrowUp';
      setOpen(true);
      // Defer focus until after the popover renders. ArrowDown/Enter/Space land
      // on the first item; ArrowUp opens to the last (ARIA APG menu pattern).
      requestAnimationFrame(() => {
        const buttons = menuButtons();
        (toLast ? buttons[buttons.length - 1] : buttons[0])?.focus();
      });
    }
  }

  function handleMenuKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Tab') {
      // Tab moves focus out of the menu — close it (ARIA APG menu pattern).
      setOpen(false);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const buttons = menuButtons();
    if (buttons.length === 0) return;
    const active = document.activeElement as HTMLButtonElement | null;
    const idx = active ? buttons.indexOf(active) : -1;
    let next: HTMLButtonElement;
    if (e.key === 'Home') next = buttons[0];
    else if (e.key === 'End') next = buttons[buttons.length - 1];
    else if (e.key === 'ArrowDown') next = buttons[(idx + 1) % buttons.length];
    else next = buttons[(idx - 1 + buttons.length) % buttons.length];
    next.focus();
  }

  // Group dividers: render an <hr> when consecutive items have different `group`.
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
          item.variant === 'destructive'
            ? 'text-error hover:bg-error-container/30'
            : 'text-on-surface hover:bg-surface-container',
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
        aria-controls={open ? menuId : undefined}
        aria-label={`${name} actions`}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={handleTriggerKey}
        className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-on-surface-variant hover:bg-surface-container hover:text-on-surface lg:h-7 lg:w-7 lg:min-h-0 lg:min-w-0"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>
      {coarse ? (
        <ActionSheet open={open} onClose={() => setOpen(false)} items={sheetItems} title={name} />
      ) : (
        <RowMenuPortal
          open={open}
          triggerRef={triggerRef}
          popoverRef={popoverRef}
          onClose={() => setOpen(false)}
          id={menuId}
          ariaLabel={`${name} actions menu`}
          onKeyDown={handleMenuKey}
        >
          {rendered}
        </RowMenuPortal>
      )}
      {runNowOpen && (
        <RunNowModal
          actionId={id}
          actionName={name}
          target={target}
          onClose={() => setRunNowOpen(false)}
        />
      )}
    </>
  );
}
