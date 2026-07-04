'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { cancelLabelAnalysis, clearWorkspaceLabels, startLabelAnalysis } from './labels-actions';
import { acceptLabelAnalysis } from '../workspaces/actions';
import { LabelListEditor } from '@/components/labels/label-editor';
import type {
  LabelAnalysisDraft,
  LabelAnalysisInputsSummary,
  LabelAnalysisResult,
  LabelAnalysisStatus,
  WorkspaceLabelScope,
  WorkspaceLabelSource,
} from '@/lib/supabase/types';

interface AnalysisRow {
  id: string;
  status: LabelAnalysisStatus;
  started_at: string | null;
  finished_at: string | null;
  result: LabelAnalysisResult | null;
  error: string | null;
  inputs_summary: LabelAnalysisInputsSummary | null;
  created_at: string;
  updated_at: string;
}

export interface AcceptedLabelRow {
  id: string;
  name: string;
  scope: WorkspaceLabelScope;
  color: string | null;
  description: string | null;
  when_to_add: string | null;
  when_to_remove: string | null;
  add_meaning: string | null;
  remove_meaning: string | null;
  exists_on_github: boolean;
  source: WorkspaceLabelSource;
}

interface StatusResponse {
  analysis: AnalysisRow | null;
  acceptedLabelCount: number;
}

export interface LabelsSectionProps {
  initial: StatusResponse;
  acceptedLabels: AcceptedLabelRow[];
  readOnly: boolean;
}

const TERMINAL: LabelAnalysisStatus[] = ['completed', 'accepted', 'failed', 'cancelled'];

export function LabelsSection({ initial, acceptedLabels, readOnly }: LabelsSectionProps) {
  const [state, setState] = useState<StatusResponse>(initial);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // ── poll status while a run is in flight ──────────────────────────
  useEffect(() => {
    const status = state.analysis?.status;
    if (!status) return;
    if (TERMINAL.includes(status)) return;

    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/labels/status', { cache: 'no-store' });
        if (!res.ok) return;
        const next = (await res.json()) as StatusResponse;
        if (!cancelled) setState(next);
      } catch {
        /* ignore */
      }
    };
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [state.analysis?.status]);

  // Build the editable draft. When the analysis is in `completed` state we
  // use its raw result; once it's `accepted`, we render whatever is currently
  // in workspace_labels so edits round-trip through the editor.
  const editorDraft = useMemo<LabelAnalysisResult | null>(() => {
    if (!state.analysis) return null;
    if (state.analysis.status === 'completed' && state.analysis.result) {
      return state.analysis.result;
    }
    if (state.analysis.status === 'accepted') {
      return acceptedToDraft(acceptedLabels);
    }
    return null;
  }, [state.analysis, acceptedLabels]);

  const [draft, setDraft] = useState<LabelAnalysisResult | null>(editorDraft);
  // Per-list validity, reported by the LabelListEditor's inline validation.
  // Save stays disabled while either list has a blank/duplicate name.
  const [issueLabelsValid, setIssueLabelsValid] = useState<boolean>(true);
  const [prLabelsValid, setPrLabelsValid] = useState<boolean>(true);
  // Re-sync the editor's draft when the upstream snapshot changes (e.g. when
  // polling transitions from running → completed).
  useEffect(() => {
    setDraft(editorDraft);
  }, [editorDraft]);

  const startAnalysis = (): void => {
    setActionError(null);
    startTransition(async () => {
      const res = await startLabelAnalysis();
      if (!res.ok) {
        setActionError(res.error ?? 'Failed to start analysis');
        return;
      }
      const refetched = await fetch('/api/labels/status', { cache: 'no-store' });
      if (refetched.ok) setState((await refetched.json()) as StatusResponse);
    });
  };

  const reinitFromScratch = (): void => {
    if (!confirm('Wipe the accepted label catalog and run a fresh analysis from scratch?')) return;
    setActionError(null);
    startTransition(async () => {
      const wipe = await clearWorkspaceLabels();
      if (!wipe.ok) {
        setActionError(wipe.error ?? 'Failed to clear catalog');
        return;
      }
      const started = await startLabelAnalysis();
      if (!started.ok) {
        setActionError(started.error ?? 'Failed to start analysis');
        return;
      }
      const refetched = await fetch('/api/labels/status', { cache: 'no-store' });
      if (refetched.ok) setState((await refetched.json()) as StatusResponse);
    });
  };

  const cancelInflight = (): void => {
    setActionError(null);
    startTransition(async () => {
      const res = await cancelLabelAnalysis();
      if (!res.ok) {
        setActionError(res.error ?? 'Failed to cancel');
        return;
      }
      const refetched = await fetch('/api/labels/status', { cache: 'no-store' });
      if (refetched.ok) setState((await refetched.json()) as StatusResponse);
    });
  };

  const cancelAndRetry = (): void => {
    setActionError(null);
    startTransition(async () => {
      const cancel = await cancelLabelAnalysis();
      if (!cancel.ok) {
        setActionError(cancel.error ?? 'Failed to cancel');
        return;
      }
      const started = await startLabelAnalysis();
      if (!started.ok) {
        setActionError(started.error ?? 'Failed to start analysis');
        return;
      }
      const refetched = await fetch('/api/labels/status', { cache: 'no-store' });
      if (refetched.ok) setState((await refetched.json()) as StatusResponse);
    });
  };

  const saveDraft = (): void => {
    if (!state.analysis || !draft) return;
    setActionError(null);
    startTransition(async () => {
      const res = await acceptLabelAnalysis(state.analysis!.id, draft);
      if (!res.ok) {
        setActionError(res.error ?? 'Failed to save');
        return;
      }
      const refetched = await fetch('/api/labels/status', { cache: 'no-store' });
      if (refetched.ok) setState((await refetched.json()) as StatusResponse);
      // Force a hard reload so the server-side acceptedLabels prop refreshes
      // — otherwise the editor would keep showing the in-memory draft as
      // truth even though the catalog on disk changed.
      window.location.reload();
    });
  };

  const a = state.analysis;
  const inflight = a?.status === 'queued' || a?.status === 'running';

  return (
    <div className="space-y-5">
      <p className="text-sm text-on-surface-variant">
        Pulls every label in the repo, scans the codebase for label guides, walks the last 100
        issues and PRs (timeline events + comments), and asks Claude to synthesize a labeling guide
        — a list of issue and PR labels, each with a description, when to add, when to remove, and
        what add/remove signifies. You review and accept the draft before it becomes the workspace
        catalog.
      </p>

      {/* ── primary action row ── */}
      <div className="flex flex-wrap items-center gap-3">
        {!a && (
          <button
            type="button"
            onClick={startAnalysis}
            disabled={readOnly || pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? 'Starting…' : 'Initialize labels'}
          </button>
        )}
        {a && (a.status === 'failed' || a.status === 'cancelled') && (
          <button
            type="button"
            onClick={startAnalysis}
            disabled={readOnly || pending}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {pending ? 'Starting…' : 'Retry analysis'}
          </button>
        )}
        {a && a.status === 'accepted' && (
          <button
            type="button"
            onClick={reinitFromScratch}
            disabled={readOnly || pending}
            className="rounded-md border border-outline-variant px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
          >
            Reinitialize from scratch
          </button>
        )}
        {readOnly && (
          <p className="text-xs text-on-surface-variant">Admin role required to edit labels.</p>
        )}
      </div>

      {actionError && (
        <p className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
          {actionError}
        </p>
      )}

      {/* ── latest run status ── */}
      {a && (
        <div className="rounded-md border border-outline-variant/60 bg-surface-container/40 p-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={a.status} />
            <span className="text-on-surface-variant">
              started {fmtRelative(new Date(a.created_at))}
            </span>
            {a.finished_at && (
              <span className="text-on-surface-variant">
                · finished {fmtRelative(new Date(a.finished_at))}
              </span>
            )}
          </div>
          {a.inputs_summary && (
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-on-surface-variant sm:grid-cols-2">
              <dt>GitHub labels</dt>
              <dd className="text-on-surface">{a.inputs_summary.github_labels}</dd>
              <dt>Issues scanned</dt>
              <dd className="text-on-surface">{a.inputs_summary.issues_scanned}</dd>
              <dt>PRs scanned</dt>
              <dd className="text-on-surface">{a.inputs_summary.prs_scanned}</dd>
              <dt>Codebase guides</dt>
              <dd className="text-on-surface">
                {a.inputs_summary.codebase_files.length === 0
                  ? '(none found)'
                  : a.inputs_summary.codebase_files.join(', ')}
              </dd>
            </dl>
          )}
          {a.status === 'failed' && a.error && (
            <p className="mt-3 rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error">
              {a.error}
            </p>
          )}
          {a.status === 'accepted' && (
            <p className="mt-3 text-sm text-on-surface">
              Accepted catalog: <span className="font-medium">{state.acceptedLabelCount}</span>{' '}
              labels.
            </p>
          )}
        </div>
      )}

      {inflight && a && (
        <InflightBanner
          analysis={a}
          pending={pending}
          readOnly={readOnly}
          onCancel={cancelInflight}
          onRetry={cancelAndRetry}
        />
      )}

      {/* ── review / edit / accept ── */}
      {draft && a && (a.status === 'completed' || a.status === 'accepted') && (
        <div className="space-y-4">
          {a.status === 'completed' && a.result?.notes && (
            <p className="rounded-md border border-outline-variant/60 bg-surface-container/40 px-4 py-2 text-xs text-on-surface-variant">
              <span className="font-medium text-on-surface">Notes from analysis:</span>{' '}
              {a.result.notes}
            </p>
          )}
          <LabelListEditor
            title="Issue labels"
            subtitle="Applied to GitHub issues."
            drafts={draft.issue_labels}
            onChange={(issue_labels) => setDraft({ ...draft, issue_labels })}
            onValidityChange={setIssueLabelsValid}
          />
          <LabelListEditor
            title="PR labels"
            subtitle="Applied to pull requests."
            drafts={draft.pr_labels}
            onChange={(pr_labels) => setDraft({ ...draft, pr_labels })}
            onValidityChange={setPrLabelsValid}
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={saveDraft}
              disabled={readOnly || pending || !issueLabelsValid || !prLabelsValid}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {pending
                ? 'Saving…'
                : a.status === 'completed'
                  ? 'Accept and save catalog'
                  : 'Save changes'}
            </button>
            {a.status === 'completed' && (
              <p className="text-xs text-on-surface-variant">
                You can also leave this draft as-is; it stays available until you re-run analysis.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function acceptedToDraft(rows: AcceptedLabelRow[]): LabelAnalysisResult {
  const toDraft = (r: AcceptedLabelRow): LabelAnalysisDraft => ({
    name: r.name,
    color: r.color,
    description: r.description ?? '',
    when_to_add: r.when_to_add ?? '',
    when_to_remove: r.when_to_remove ?? '',
    add_meaning: r.add_meaning ?? '',
    remove_meaning: r.remove_meaning ?? '',
    exists_on_github: r.exists_on_github,
  });
  const issue_labels: LabelAnalysisDraft[] = [];
  const pr_labels: LabelAnalysisDraft[] = [];
  for (const r of rows) {
    if (r.scope === 'issue' || r.scope === 'both') issue_labels.push(toDraft(r));
    if (r.scope === 'pr' || r.scope === 'both') pr_labels.push(toDraft(r));
  }
  return { issue_labels, pr_labels };
}

function InflightBanner({
  analysis,
  pending,
  readOnly,
  onCancel,
  onRetry,
}: {
  analysis: AnalysisRow;
  pending: boolean;
  readOnly: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  // Anchor "how long has this been queued" on the analysis row's
  // created_at (the moment the user clicked Initialize). A typical run
  // takes 2-5 minutes; past ~6 we treat it as stale and surface the
  // retry copy more prominently so the user isn't left hanging.
  const ageMs = Date.now() - new Date(analysis.created_at).getTime();
  const stale = ageMs > 6 * 60_000;

  return (
    <div className="space-y-3 rounded-md border border-outline-variant/60 bg-surface-container/40 p-4">
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-r-transparent"
          aria-label="Loading"
        />
        <p className="text-sm text-on-surface-variant">
          {stale
            ? 'Analysis is taking longer than expected. The dispatcher may not be running, or the job is stuck.'
            : 'Analysis running. Polling every few seconds — feel free to leave this page and come back.'}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onRetry}
          disabled={readOnly || pending}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            stale
              ? 'bg-primary text-on-primary hover:bg-primary/90'
              : 'border border-outline-variant text-on-surface-variant hover:bg-surface-container'
          }`}
        >
          {pending ? 'Working…' : 'Cancel & retry'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={readOnly || pending}
          className="rounded-md border border-outline-variant px-3 py-1.5 text-xs text-on-surface-variant hover:bg-surface-container disabled:opacity-50"
        >
          Cancel
        </button>
        {stale && (
          <p className="text-xs text-on-surface-variant">
            Verify the cron is running (the dev server auto-ticks{' '}
            <span className="font-mono">/api/cron/dispatch</span> every 60s).
          </p>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: LabelAnalysisStatus }) {
  const tone =
    status === 'completed' || status === 'accepted'
      ? 'border-primary/40 bg-primary/10 text-primary'
      : status === 'failed' || status === 'cancelled'
        ? 'border-error/40 bg-error/10 text-error'
        : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={`inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[10.5px] font-semibold uppercase tracking-[0.05em] ${tone}`}
    >
      {status}
    </span>
  );
}

function fmtRelative(d: Date): string {
  const diff = Date.now() - d.getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}
