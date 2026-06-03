'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { WorkspaceRole } from '@/lib/supabase/types';
import {
  deleteFlow,
  listFlows,
  runFlowOnIssue,
  setFlowPaused,
  upsertFlow,
  type FlowStep,
  type FlowSummary,
  type FlowTrigger,
} from './actions';
import { FlowCard, type SkillOption } from './flow-card';
import { FLOW_TEMPLATES, type FlowTemplate } from './templates';

interface Props {
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  initialFlows: FlowSummary[];
  availableSkills: SkillOption[];
}

/**
 * The /workflows page. Matches the design in the screenshot, extended with:
 *   1. skill descriptions inline next to the picker
 *   2. auto-trigger panel (issue.opened, issue.labeled)
 *   3. template variable autocomplete + static lint on args templates
 *   4. per-step preview ("what will the agent see?") via server action
 *   5. inline last-run output snippet
 *
 * Save batches all dirty flows + the pending-new flow in one click.
 */
export function WorkflowsClient({ workspaceName, workspaceRole, initialFlows, availableSkills }: Props) {
  const router = useRouter();
  const [flows, setFlows] = useState<FlowSummary[]>(initialFlows);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [pendingNew, setPendingNew] = useState<FlowSummary | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const canWrite = workspaceRole !== 'viewer';

  useEffect(() => {
    if (dirty.size > 0 || pendingNew) return;
    const tick = () => {
      // Don't burn Supabase request budget polling a background tab.
      if (document.visibilityState !== 'visible') return;
      listFlows().then(setFlows);
    };
    const i = window.setInterval(tick, 15000);
    return () => window.clearInterval(i);
  }, [dirty.size, pendingNew]);

  const markDirty = (id: string) => setDirty((prev) => new Set(prev).add(id));

  const updateFlow = (id: string, patch: (f: FlowSummary) => FlowSummary) => {
    if (id === pendingNew?.id) {
      setPendingNew((cur) => (cur ? patch(cur) : cur));
      return;
    }
    setFlows((cur) => cur.map((f) => (f.id === id ? patch(f) : f)));
    markDirty(id);
  };

  const newFlowFromTemplate = (template: FlowTemplate) => {
    const tempId = `__new__${Date.now()}`;
    const built = template.build();
    setPendingNew({
      id: tempId,
      name: built.name,
      steps: built.steps,
      triggers: built.triggers,
      paused: false,
      updatedAt: new Date().toISOString(),
      recentRuns: [],
      stats: { totalLast7d: 0, succeededLast7d: 0, avgTokens: 0 },
    });
  };

  const deleteOne = async (id: string) => {
    if (id === pendingNew?.id) {
      setPendingNew(null);
      return;
    }
    if (!confirm('Delete this flow?')) return;
    const result = await deleteFlow(id);
    if (!result.ok) {
      alert(`Delete failed: ${result.error}`);
      return;
    }
    setFlows((cur) => cur.filter((f) => f.id !== id));
    setDirty((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    });
  };

  const saveAll = async () => {
    setSaveError(null);
    setSavingState('saving');
    const ops: Array<Promise<{ ok: boolean; error?: string }>> = [];

    if (pendingNew) {
      ops.push(
        upsertFlow({
          name: pendingNew.name,
          steps: pendingNew.steps,
          triggers: pendingNew.triggers,
          paused: pendingNew.paused,
        }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error })),
      );
    }
    for (const id of dirty) {
      const flow = flows.find((f) => f.id === id);
      if (!flow) continue;
      ops.push(
        upsertFlow({
          id: flow.id,
          name: flow.name,
          steps: flow.steps,
          triggers: flow.triggers,
          paused: flow.paused,
        }).then((r) => (r.ok ? { ok: true } : { ok: false, error: r.error })),
      );
    }

    const results = await Promise.all(ops);
    const firstErr = results.find((r) => !r.ok);
    if (firstErr) {
      setSaveError(firstErr.error ?? 'save failed');
      setSavingState('error');
      return;
    }
    const next = await listFlows();
    setFlows(next);
    setDirty(new Set());
    setPendingNew(null);
    setSavingState('saved');
    window.setTimeout(() => setSavingState('idle'), 2000);
  };

  const allFlows: FlowSummary[] = pendingNew ? [...flows, pendingNew] : flows;
  const isDirty = dirty.size > 0 || pendingNew !== null;

  return (
    <div className="px-8 py-6">
      <header className="mb-6 border-b border-border pb-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Chain named skill steps. Args can use{' '}
              <code>{'{{input}}'}</code>,{' '}
              <code>{'{{previousTaskId}}'}</code>,{' '}
              <code>{'{{previousOutput}}'}</code>,{' '}
              <code>{'{{previousPullRequestUrl}}'}</code>,{' '}
              <code>{'{{previousPullRequestNumber}}'}</code>, and{' '}
              <code>{'{{existingCezarPr}}'}</code>.
              <span className="ml-2 text-fg-muted/60">— workspace: <span className="text-fg">{workspaceName}</span></span>
            </p>
          </div>
          {canWrite && <NewFlowMenu onPick={newFlowFromTemplate} />}
        </div>
      </header>

      {allFlows.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-bg-subtle p-8 text-center text-sm text-fg-muted">
          No flows yet. {canWrite ? 'Click "+ Flow" to create one.' : ''}
        </div>
      )}

      <div className="space-y-4">
        {allFlows.map((flow) => (
          <FlowCard
            key={flow.id}
            flow={flow}
            canWrite={canWrite}
            availableSkills={availableSkills}
            onNameChange={(name) => updateFlow(flow.id, (f) => ({ ...f, name }))}
            onStepChange={(idx, patch) =>
              updateFlow(flow.id, (f) => ({
                ...f,
                steps: f.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
              }))
            }
            onAddStep={() =>
              updateFlow(flow.id, (f) => ({
                ...f,
                steps: [...f.steps, { skill: '', argsTemplate: '{{input}}' }],
              }))
            }
            onRemoveStep={(idx) =>
              updateFlow(flow.id, (f) => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) }))
            }
            onMoveStepDown={(idx) =>
              updateFlow(flow.id, (f) => {
                if (idx >= f.steps.length - 1) return f;
                const next = [...f.steps];
                [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                return { ...f, steps: next };
              })
            }
            onTriggersChange={(triggers: FlowTrigger[]) =>
              updateFlow(flow.id, (f) => ({ ...f, triggers }))
            }
            onPausedChange={async (paused) => {
              // Pause is a server-side toggle even for clean (non-dirty)
              // rows — we want it to take effect immediately, not wait
              // for the "Save workflows" click.
              if (flow.id.startsWith('__new__')) {
                updateFlow(flow.id, (f) => ({ ...f, paused }));
                return;
              }
              setFlows((cur) => cur.map((f) => (f.id === flow.id ? { ...f, paused } : f)));
              const result = await setFlowPaused(flow.id, paused);
              if (!result.ok) {
                alert(`Pause failed: ${result.error}`);
                // revert
                const next = await listFlows();
                setFlows(next);
              }
            }}
            onDelete={() => deleteOne(flow.id)}
            onRun={async (issue) => {
              if (flow.id.startsWith('__new__')) {
                alert('Save the flow before running it.');
                return;
              }
              const result = await runFlowOnIssue({ flowId: flow.id, issueNumber: issue });
              if (!result.ok) {
                alert(`Run failed: ${result.error}`);
                return;
              }
              const next = await listFlows();
              setFlows(next);
            }}
            onOpenRun={() => flow.lastRun && router.push(`/cockpit/${flow.lastRun.id}`)}
          />
        ))}
      </div>

      {canWrite && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={saveAll}
            disabled={!isDirty || savingState === 'saving'}
            className="inline-flex items-center gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-sm font-medium text-fg hover:bg-accent/25 disabled:opacity-50"
          >
            <SaveIcon />
            {savingState === 'saving' ? 'Saving…' : 'Save workflows'}
          </button>
          <span className="text-xs text-fg-muted">
            {savingState === 'saved' && 'Saved'}
            {savingState === 'error' && saveError && <span className="text-rose-400">{saveError}</span>}
            {savingState === 'idle' && (isDirty ? 'Unsaved changes' : 'Saved')}
          </span>
        </div>
      )}
    </div>
  );
}

function NewFlowMenu({ onPick }: { onPick: (t: FlowTemplate) => void }) {
  const [open, setOpen] = useState(false);
  // Close when clicking outside or hitting escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-newflow-menu]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" data-newflow-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        className="rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-sm font-medium text-fg hover:bg-accent/20"
      >
        + Flow ▾
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-80 rounded-md border border-border bg-bg-elevated shadow-xl">
          <div className="border-b border-border px-3 py-2 text-[11px] uppercase tracking-wide text-fg-muted">
            Start from a template
          </div>
          {FLOW_TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                onPick(t);
                setOpen(false);
              }}
              className="block w-full border-b border-border/50 px-3 py-2 text-left last:border-b-0 hover:bg-bg-subtle"
            >
              <div className="text-sm font-medium text-fg">{t.label}</div>
              <div className="text-[11px] text-fg-muted leading-snug">{t.description}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SaveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  );
}
