'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { Modal } from '@/components/ui/modal';
import {
  listRecentIssuesForRunNow,
  enqueueActionRun,
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
  const selectRef = useRef<HTMLSelectElement>(null);
  const [issues, setIssues] = useState<RunNowIssue[]>([]);
  const [issuesLoading, setIssuesLoading] = useState(target === 'issue');
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [manualNumber, setManualNumber] = useState('');
  const [useManual, setUseManual] = useState(target === 'pr');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

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
      const r = await enqueueActionRun(actionId, number);
      if (!r.ok || !r.workflowRunId) {
        setError(r.error ?? 'Could not queue action');
        return;
      }
      onClose();
      router.push(`/cockpit/${r.workflowRunId}`);
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={
        <>
          Run action — <span className="font-mono">{actionName}</span>
        </>
      }
      description={
        <>
          Queues this action against the chosen {target === 'pr' ? 'PR' : 'issue'}, applying any
          effects for real. Runs in the background — you&apos;ll land on its run page.
        </>
      }
      footer={
        <>
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
              'inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:opacity-50',
            )}
          >
            {pending && (
              <span
                aria-hidden
                className="h-3 w-3 animate-spin rounded-full border-2 border-primary-on/40 border-t-primary-on"
              />
            )}
            {pending ? 'Queuing…' : 'Run now'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
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
              className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none lg:text-sm"
            >
              {issuesLoading && <option>Loading recent issues…</option>}
              {!issuesLoading && issues.length === 0 && (
                <option value="">No issues in cache</option>
              )}
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
              className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base text-on-surface placeholder:text-on-surface-variant focus:border-primary focus:outline-none lg:text-sm"
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
    </Modal>
  );
}
