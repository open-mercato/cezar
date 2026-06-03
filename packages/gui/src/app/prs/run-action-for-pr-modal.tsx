'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { runActionNow } from '@/app/actions/[name]/run-now-action';
import {
  listActionsForPrTarget,
  type PrTargetAction,
} from './prs-page-actions';

export interface RunActionForPrModalProps {
  prNumber: number;
  prTitle: string;
  onClose: () => void;
}

/**
 * Mirror of `run-action-for-issue-modal.tsx`: the PR is fixed, the user picks
 * which `target='pr'` action to run against it. On success, navigates to
 * /cockpit/[runId].
 */
export function RunActionForPrModal({ prNumber, prTitle, onClose }: RunActionForPrModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [actions, setActions] = useState<PrTargetAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  pendingRef.current = pending;

  useEffect(() => {
    lastFocused.current = document.activeElement as HTMLElement | null;
    const node = dialogRef.current;
    const focusables = node?.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    focusables?.[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (pendingRef.current) return;
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(
        node?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      lastFocused.current?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listActionsForPrTarget();
      if (cancelled) return;
      setActions(rows);
      setActionsLoading(false);
      if (rows.length > 0) setSelectedId(rows[0].id);
    })().catch(() => setActionsLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  function handleRun() {
    setError(null);
    if (!selectedId) {
      setError('Pick an action');
      return;
    }
    startTransition(async () => {
      const r = await runActionNow(selectedId, prNumber);
      if (!r.ok || !r.workflowRunId) {
        setError(r.error ?? 'Run failed');
        return;
      }
      onClose();
      router.push(`/cockpit/${r.workflowRunId}`);
    });
  }

  const selected = actions.find((a) => a.id === selectedId);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (pending) return;
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-action-for-pr-title"
        className="w-full max-w-md rounded-lg border border-outline-variant bg-surface-container-high p-5 shadow-ambient"
      >
        <h2 id="run-action-for-pr-title" className="text-base font-semibold text-on-surface">
          Run action on <span className="font-mono">PR #{prNumber}</span>
        </h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Runs the chosen action against <span className="font-medium text-on-surface">{prTitle || `PR #${prNumber}`}</span>{' '}
          immediately, applying any effects for real.
        </p>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
              Action
            </span>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={actionsLoading || pending}
              className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
            >
              {actionsLoading && <option>Loading actions…</option>}
              {!actionsLoading && actions.length === 0 && <option value="">No enabled PR-target actions</option>}
              {actions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.kind === 'user' ? ' (user)' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected?.description && (
            <p className="text-xs text-on-surface-variant">{selected.description}</p>
          )}
          {error && (
            <p className="rounded-md border border-error/30 bg-error-container/30 px-3 py-2 text-sm text-error">
              {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="h-9 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface transition-colors hover:border-primary disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleRun}
            disabled={pending || actionsLoading || actions.length === 0}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:opacity-50',
            )}
          >
            {pending && (
              <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border-2 border-primary-on/40 border-t-primary-on"
              />
            )}
            {pending ? 'Running…' : 'Run now'}
          </button>
        </div>
      </div>
    </div>
  );
}
