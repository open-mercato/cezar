'use client';

import { useCallback, useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { Modal } from '@/components/ui/modal';
import { enqueueActionRun } from '@/app/actions/[name]/run-now-action';
import { listActionsForIssueTarget, type IssueTargetAction } from './issues-page-actions';

export interface RunActionForIssueModalProps {
  issueNumber: number;
  issueTitle: string;
  onClose: () => void;
}

/**
 * The mirror image of `components/run-now-modal.tsx`: the issue is fixed
 * (the row you opened the kebab on), and the user picks which `target='issue'`
 * action to run against it. On success, navigates to /cockpit/[runId].
 */
export function RunActionForIssueModal({
  issueNumber,
  issueTitle,
  onClose,
}: RunActionForIssueModalProps) {
  const router = useRouter();
  const [actions, setActions] = useState<IssueTargetAction[]>([]);
  const [actionsLoading, setActionsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Don't allow dismiss (Esc / backdrop) while a run is being queued.
  const handleClose = useCallback(() => {
    if (pending) return;
    onClose();
  }, [pending, onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await listActionsForIssueTarget();
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
      const r = await enqueueActionRun(selectedId, issueNumber);
      if (!r.ok || !r.workflowRunId) {
        setError(r.error ?? 'Could not queue action');
        return;
      }
      onClose();
      router.push(`/cockpit/${r.workflowRunId}`);
    });
  }

  const selected = actions.find((a) => a.id === selectedId);

  return (
    <Modal
      open
      onClose={handleClose}
      title={
        <>
          Run action on <span className="font-mono">#{issueNumber}</span>
        </>
      }
      description={
        <>
          Queues the chosen action against{' '}
          <span className="font-medium text-on-surface">
            {issueTitle || `issue #${issueNumber}`}
          </span>
          , applying any effects for real. Runs in the background — you&apos;ll land on its run
          page.
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
            disabled={pending || actionsLoading || actions.length === 0}
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
        <label className="block">
          <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
            Action
          </span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            disabled={actionsLoading || pending}
            className="mt-1 h-9 w-full rounded-md border border-outline-variant bg-surface px-2 text-base text-on-surface focus:border-primary focus:outline-none lg:text-sm"
          >
            {actionsLoading && <option>Loading actions…</option>}
            {!actionsLoading && actions.length === 0 && (
              <option value="">No enabled issue-target actions</option>
            )}
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
    </Modal>
  );
}
