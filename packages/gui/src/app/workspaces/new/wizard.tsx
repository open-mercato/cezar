'use client';

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  acceptLabelAnalysis,
  createWorkspace,
  startLabelAnalysisForWorkspace,
  type CreateWorkspaceState,
} from '../actions';
import { LabelListEditor } from '@/components/labels/label-editor';
import type {
  LabelAnalysisInputsSummary,
  LabelAnalysisResult,
  LabelAnalysisStatus,
} from '@/lib/supabase/types';

type WizardStep = 'create' | 'analyze' | 'review';

interface AnalysisSnapshot {
  id: string;
  status: LabelAnalysisStatus;
  result: LabelAnalysisResult | null;
  error: string | null;
  inputs_summary: LabelAnalysisInputsSummary | null;
}

interface StatusResponse {
  analysis: AnalysisSnapshot | null;
  acceptedLabelCount: number;
}

const TERMINAL: LabelAnalysisStatus[] = ['completed', 'accepted', 'failed', 'cancelled'];

const VALID_STEPS: WizardStep[] = ['create', 'analyze', 'review'];

export function WorkspaceWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Hydrate navigation state from the URL so a refresh resumes the in-flight
  // wizard instead of dropping the user back on the create form (where the
  // already-committed workspace would fail re-submit with a 23505). The URL is
  // the source of truth for step/workspace/analysis; resubmitting an existing
  // workspace is therefore never required to get back to the analysis.
  const urlStepRaw = searchParams.get('step');
  const urlStep: WizardStep = VALID_STEPS.includes(urlStepRaw as WizardStep)
    ? (urlStepRaw as WizardStep)
    : 'create';
  const urlWorkspaceId = searchParams.get('workspace');
  const urlAnalysisId = searchParams.get('analysis');

  // Only honour analyze/review if we actually have the workspace id to resume.
  const initialStep: WizardStep = urlStep !== 'create' && urlWorkspaceId ? urlStep : 'create';

  const [step, setStep] = useState<WizardStep>(initialStep);
  const [workspaceId, setWorkspaceId] = useState<string | null>(
    initialStep !== 'create' ? urlWorkspaceId : null,
  );
  const [analysis, setAnalysis] = useState<AnalysisSnapshot | null>(null);
  const [draft, setDraft] = useState<LabelAnalysisResult | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  // Push the current navigation state into the URL (replace, so the browser
  // back button doesn't walk every wizard transition).
  const syncUrl = useCallback(
    (next: { step: WizardStep; workspaceId?: string | null; analysisId?: string | null }): void => {
      const params = new URLSearchParams();
      if (next.step !== 'create') params.set('step', next.step);
      if (next.workspaceId) params.set('workspace', next.workspaceId);
      if (next.analysisId) params.set('analysis', next.analysisId);
      const query = params.toString();
      router.replace(query ? `/workspaces/new?${query}` : '/workspaces/new');
    },
    [router],
  );

  // If we land directly on the review step from a refresh, the snapshot lives
  // only in the DB — pull it back so StepReview has something to render.
  useEffect(() => {
    if (step !== 'review' || analysis || !urlAnalysisId) return;
    let cancelled = false;
    (async (): Promise<void> => {
      try {
        const res = await fetch('/api/labels/status', { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as StatusResponse;
        if (cancelled || !body.analysis || body.analysis.id !== urlAnalysisId) return;
        if (body.analysis.status !== 'completed' && body.analysis.status !== 'accepted') {
          // Not actually reviewable yet — fall back to the polling step.
          setStep('analyze');
          syncUrl({ step: 'analyze', workspaceId: urlWorkspaceId, analysisId: urlAnalysisId });
          return;
        }
        if (!body.analysis.result) return;
        setAnalysis(body.analysis);
        setDraft(body.analysis.result);
      } catch {
        /* leave the user on the review step with the inline error surface */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, analysis, urlAnalysisId, urlWorkspaceId, syncUrl]);

  return (
    <div className="mx-auto max-w-[920px] px-8 py-6">
      <header className="mb-6 border-b border-outline-variant pb-5">
        <h1 className="font-display text-[28px] font-semibold tracking-tight text-on-surface">Create Workspace</h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          One workspace = one GitHub repository. After creation we&apos;ll analyse your label usage so
          Cezar knows when to add and remove each label.
        </p>
      </header>

      <StepIndicator current={step} />

      {stepError && (
        <div className="mb-4 rounded-md border border-error/40 bg-error/10 px-4 py-2 text-sm text-error">
          {stepError}
        </div>
      )}

      {step === 'create' && (
        <StepCreate
          onCreated={(id) => {
            setWorkspaceId(id);
            setStep('analyze');
            syncUrl({ step: 'analyze', workspaceId: id });
          }}
        />
      )}
      {step === 'analyze' && workspaceId && (
        <StepAnalyze
          workspaceId={workspaceId}
          onStarted={(analysisId) => syncUrl({ step: 'analyze', workspaceId, analysisId })}
          onCompleted={(snap) => {
            setAnalysis(snap);
            setDraft(snap.result);
            setStep('review');
            syncUrl({ step: 'review', workspaceId, analysisId: snap.id });
          }}
          onSkip={() => router.push('/dashboard')}
          onError={(msg) => setStepError(msg)}
        />
      )}
      {step === 'review' && analysis && draft && (
        <StepReview
          analysis={analysis}
          draft={draft}
          onDraftChange={setDraft}
          onAccepted={() => router.push('/dashboard')}
          onSkip={() => router.push('/dashboard')}
          onError={(msg) => setStepError(msg)}
        />
      )}
      {step === 'review' && !(analysis && draft) && (
        <div className="flex items-center gap-3 text-sm text-on-surface-variant">
          <Spinner /> Restoring your draft…
        </div>
      )}
    </div>
  );
}

// ─── Step 1: create workspace ───────────────────────────────────────────

function StepCreate({ onCreated }: { onCreated: (id: string) => void }) {
  const [state, formAction, pending] = useActionState<CreateWorkspaceState, FormData>(
    createWorkspace,
    {},
  );

  useEffect(() => {
    if (state.workspaceId) onCreated(state.workspaceId);
  }, [state.workspaceId, onCreated]);

  return (
    <form action={formAction} className="max-w-md space-y-5">
      {state.error && (
        <div className="rounded-md border border-error/40 bg-error/10 px-4 py-2 text-sm text-error">{state.error}</div>
      )}
      <Field label="Workspace name" name="name" placeholder="Open Mercato" />
      <Field label="Repository owner" name="repo_owner" placeholder="comerito" />
      <Field label="Repository name" name="repo_name" placeholder="open-mercato" />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create workspace'}
      </button>
    </form>
  );
}

function Field({ label, name, placeholder }: { label: string; name: string; placeholder: string }) {
  return (
    <div>
      <label htmlFor={name} className="mb-1 block text-xs font-medium text-on-surface-variant">{label}</label>
      <input
        id={name}
        name={name}
        type="text"
        placeholder={placeholder}
        required
        className="w-full rounded-md border border-outline-variant bg-bg px-3 py-2 text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
      />
    </div>
  );
}

// ─── Step 2: analyse labels ─────────────────────────────────────────────

function StepAnalyze({
  workspaceId,
  onStarted,
  onCompleted,
  onSkip,
  onError,
}: {
  workspaceId: string;
  onStarted: (analysisId: string) => void;
  onCompleted: (snap: AnalysisSnapshot) => void;
  onSkip: () => void;
  onError: (msg: string) => void;
}) {
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AnalysisSnapshot | null>(null);
  const [starting, setStarting] = useState<boolean>(false);
  const startedFor = useRef<string | null>(null);

  // Kick off the analysis once per workspace. Guarded by a ref so the URL-sync
  // callbacks (whose identity changes on every router.replace) can't re-trigger
  // it; the server action dedupes anyway, but this avoids redundant calls.
  useEffect(() => {
    if (startedFor.current === workspaceId) return;
    startedFor.current = workspaceId;
    let cancelled = false;
    setStarting(true);
    (async (): Promise<void> => {
      const res = await startLabelAnalysisForWorkspace(workspaceId);
      if (cancelled) return;
      setStarting(false);
      if (!res.ok || !res.analysisId) {
        startedFor.current = null;
        onError(res.error ?? 'Failed to start analysis');
        return;
      }
      setAnalysisId(res.analysisId);
      onStarted(res.analysisId);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, onStarted, onError]);

  // Poll status. The status route reads from the active workspace cookie,
  // which `createWorkspace` set on step 1, so this works without an explicit
  // workspaceId param.
  useEffect(() => {
    if (!analysisId) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await fetch('/api/labels/status', { cache: 'no-store' });
        if (!res.ok) return;
        const next = (await res.json()) as StatusResponse;
        if (cancelled || !next.analysis) return;
        if (next.analysis.id !== analysisId) return;
        setSnapshot(next.analysis);
        if (next.analysis.status === 'completed') {
          onCompleted(next.analysis);
        } else if (next.analysis.status === 'failed') {
          onError(next.analysis.error ?? 'Analysis failed');
        }
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [analysisId, onCompleted, onError]);

  const status = snapshot?.status ?? (starting ? 'starting' : 'queued');
  const isTerminal = snapshot?.status && TERMINAL.includes(snapshot.status);

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-on-surface-variant">
        Cezar is pulling every label, scanning your codebase, walking the last 100 issues and PRs
        (timeline events + comments), and asking Claude to draft a labeling guide. This usually takes
        2–5 minutes for a typical repo.
      </p>

      <div className="rounded-md border border-outline-variant bg-surface-container-low p-5">
        <div className="flex items-center gap-3">
          {!isTerminal && <Spinner />}
          <div>
            <p className="text-sm font-medium text-on-surface">Status: <span className="font-mono">{status}</span></p>
            {snapshot?.inputs_summary && (
              <p className="text-xs text-on-surface-variant">
                {snapshot.inputs_summary.github_labels} labels · {snapshot.inputs_summary.issues_scanned} issues ·{' '}
                {snapshot.inputs_summary.prs_scanned} PRs ·{' '}
                {snapshot.inputs_summary.codebase_files.length === 0
                  ? 'no codebase guides'
                  : `${snapshot.inputs_summary.codebase_files.length} codebase guide${snapshot.inputs_summary.codebase_files.length === 1 ? '' : 's'}`}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md border border-outline-variant px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container"
        >
          Skip for now
        </button>
        <p className="self-center text-xs text-on-surface-variant">
          You can review and accept the draft later from <span className="font-mono">Settings → Labels</span>.
        </p>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary border-r-transparent"
      aria-label="Loading"
    />
  );
}

// ─── Step 3: review & accept ────────────────────────────────────────────

function StepReview({
  analysis,
  draft,
  onDraftChange,
  onAccepted,
  onSkip,
  onError,
}: {
  analysis: AnalysisSnapshot;
  draft: LabelAnalysisResult;
  onDraftChange: (d: LabelAnalysisResult) => void;
  onAccepted: () => void;
  onSkip: () => void;
  onError: (msg: string) => void;
}) {
  const [pending, startTransition] = useTransition();

  const accept = (): void => {
    startTransition(async () => {
      const res = await acceptLabelAnalysis(analysis.id, draft);
      if (!res.ok) {
        onError(res.error ?? 'Failed to accept');
        return;
      }
      onAccepted();
    });
  };

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-outline-variant/60 bg-surface-container/40 px-5 py-4 text-sm text-on-surface-variant">
        Claude proposed {draft.issue_labels.length} issue label{draft.issue_labels.length === 1 ? '' : 's'} and{' '}
        {draft.pr_labels.length} PR label{draft.pr_labels.length === 1 ? '' : 's'}. Edit anything that doesn&apos;t
        match your team&apos;s practice, then accept to save the catalog.
        {analysis.result?.notes && (
          <p className="mt-2 text-xs text-on-surface-variant">
            <span className="font-medium text-on-surface">Notes:</span> {analysis.result.notes}
          </p>
        )}
      </div>

      <LabelListEditor
        title="Issue labels"
        subtitle="Applied to GitHub issues."
        drafts={draft.issue_labels}
        onChange={(issue_labels) => onDraftChange({ ...draft, issue_labels })}
      />

      <LabelListEditor
        title="PR labels"
        subtitle="Applied to pull requests."
        drafts={draft.pr_labels}
        onChange={(pr_labels) => onDraftChange({ ...draft, pr_labels })}
      />

      <div className="flex items-center gap-3 border-t border-outline-variant pt-4">
        <button
          type="button"
          onClick={accept}
          disabled={pending}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Accept and finish'}
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="rounded-md border border-outline-variant px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

// ─── Step indicator ─────────────────────────────────────────────────────

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: Array<{ id: WizardStep; label: string }> = [
    { id: 'create', label: '1. Workspace' },
    { id: 'analyze', label: '2. Analyse labels' },
    { id: 'review', label: '3. Review' },
  ];
  return (
    <ol className="mb-6 flex items-center gap-2 text-xs">
      {steps.map((s, i) => (
        <li key={s.id} className="flex items-center gap-2">
          <span
            className={
              s.id === current
                ? 'rounded-md bg-primary/10 px-2 py-1 font-medium text-primary'
                : 'rounded-md px-2 py-1 text-on-surface-variant'
            }
          >
            {s.label}
          </span>
          {i < steps.length - 1 && <span className="text-outline">→</span>}
        </li>
      ))}
    </ol>
  );
}
