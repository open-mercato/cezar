'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import {
  listRecentIssuesForRunNow,
  runActionNow,
  type RunNowIssue,
} from '@/app/actions/[name]/run-now-action';

export interface RunNowModalProps {
  actionId: string;
  actionName: string;
  target: 'issue' | 'pr';
  onClose: () => void;
}

export function RunNowModal({ actionId, actionName, target, onClose }: RunNowModalProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);
  const [issues, setIssues] = useState<RunNowIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(target === 'issue');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [manualNumber, setManualNumber] = useState('');
  const [useManual, setUseManual] = useState(target === 'pr');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Focus trap + Esc to close.
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

  // Load top-20 recent issues for issue-targeted actions.
  useEffect(() => {
    if (target !== 'issue') return;
    let cancelled = false;
    (async () => {
      const rows = await listRecentIssuesForRunNow();
      if (cancelled) return;
      setIssues(rows);
      setIssuesLoading(false);
      if (rows.length > 0) {
        setSelectedNumber(rows[0].number);
      } else {
        setUseManual(true);
      }
    })().catch(() => setIssuesLoading(false));
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Once the issue list finishes loading and the select becomes enabled,
  // move focus to it so keyboard users land on the intended "pick from list" control.
  useEffect(() => {
    if (target !== 'issue' || useManual || issuesLoading) return;
    selectRef.current?.focus();
  }, [target, useManual, issuesLoading]);

  function resolveNumber(): number | null {
    if (useManual) {
      const n = Number.parseInt(manualNumber.trim(), 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    }
    return selectedNumber;
  }

  function handleRun() {
    setError(null);
    const number = resolveNumber();
    if (number === null) {
      setError(target === 'issue' ? 'Pick an issue or enter a number' : 'Enter a PR number');
      return;
    }
    startTransition(async () => {
      const r = await runActionNow(actionId, number);
      if (!r.ok || !r.workflowRunId) {
        setError(r.error ?? 'Run failed');
        return;
      }
      onClose();
      router.push(`/cockpit/${r.workflowRunId}`);
    });
  }

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-now-title"
        className="w-full max-w-md rounded-lg border border-outline-variant bg-surface-container-high p-5 shadow-ambient"
      >
        <h2 id="run-now-title" className="text-base font-semibold text-on-surface">
          Run action — <span className="font-mono">{actionName}</span>
        </h2>
        <p className="mt-1 text-xs text-on-surface-variant">
          Runs this action against the chosen {target === 'pr' ? 'PR' : 'issue'} immediately, applying any effects for real.
        </p>

        <div className="mt-4 space-y-3">
          {target === 'issue' && !useManual && (
            <label className="block">
              <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
                Issue
              </span>
              <select
                ref={selectRef}
                value={selectedNumber ?? ''}
                onChange={(e) => setSelectedNumber(Number(e.target.value))}
                disabled={issuesLoading || pending}
                className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-sm text-on-surface focus:border-primary focus:outline-none"
              >
                {issuesLoading && <option>Loading recent issues…</option>}
                {!issuesLoading && issues.length === 0 && <option value="">No issues in cache</option>}
                {issues.map((i) => (
                  <option key={i.number} value={i.number}>
                    #{i.number} — {i.title || '(no title)'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(useManual || target === 'pr') && (
            <label className="block">
              <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
                {target === 'pr' ? 'PR number' : 'Issue number'}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                value={manualNumber}
                onChange={(e) => setManualNumber(e.target.value)}
                placeholder="e.g. 42"
                disabled={pending}
                className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none"
              />
            </label>
          )}
          {target === 'issue' && (
            <button
              type="button"
              onClick={() => setUseManual((v) => !v)}
              className="text-xs text-on-surface-variant underline-offset-2 hover:text-on-surface hover:underline"
            >
              {useManual ? 'Pick from recent issues instead' : 'Enter a number manually'}
            </button>
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
            disabled={pending}
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
