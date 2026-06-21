'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { WorkspaceRole } from '@/lib/supabase/types';
import {
  deleteFlow,
  getFlow,
  listFlows,
  runFlowOnIssue,
  setFlowPaused,
  upsertFlow,
  type FlowSummary,
  type FlowTrigger,
} from '../actions';
import { FlowCard, type SkillOption } from '../flow-card';
import { PageContainer } from '@/components/ui/page-container';

interface Props {
  workspaceRole: WorkspaceRole;
  initialFlow: FlowSummary;
  availableSkills: SkillOption[];
}

/**
 * Per-workflow detail / edit page. Owns a single flow's state, dirty tracking,
 * and save — the cockpit-style batch editor split out into one workflow per page.
 */
export function WorkflowEditor({ workspaceRole, initialFlow, availableSkills }: Props) {
  const router = useRouter();
  const [flow, setFlow] = useState<FlowSummary>(initialFlow);
  const [dirty, setDirty] = useState(false);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const canWrite = workspaceRole !== 'viewer';

  const update = (patch: (f: FlowSummary) => FlowSummary) => {
    setFlow((cur) => patch(cur));
    setDirty(true);
  };

  const save = async () => {
    setSaveError(null);
    setSavingState('saving');
    const r = await upsertFlow({
      id: flow.id,
      name: flow.name,
      steps: flow.steps,
      triggers: flow.triggers,
      paused: flow.paused,
    });
    if (!r.ok) {
      setSaveError(r.error);
      setSavingState('error');
      return;
    }
    const fresh = await getFlow(flow.id);
    if (fresh) setFlow(fresh);
    setDirty(false);
    setSavingState('saved');
    window.setTimeout(() => setSavingState('idle'), 2000);
  };

  return (
    <PageContainer max="max-w-[920px]">
      <div className="mb-4">
        <Link
          href="/workflows"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm text-fg-muted hover:text-fg lg:min-h-0"
        >
          <span aria-hidden>←</span> Workflows
        </Link>
      </div>

      <FlowCard
        flow={flow}
        canWrite={canWrite}
        availableSkills={availableSkills}
        onNameChange={(name) => update((f) => ({ ...f, name }))}
        onStepChange={(idx, patch) =>
          update((f) => ({
            ...f,
            steps: f.steps.map((s, i) => (i === idx ? { ...s, ...patch } : s)),
          }))
        }
        onAddStep={() =>
          update((f) => ({ ...f, steps: [...f.steps, { skill: '', argsTemplate: '{{input}}' }] }))
        }
        onRemoveStep={(idx) =>
          update((f) => ({ ...f, steps: f.steps.filter((_, i) => i !== idx) }))
        }
        onMoveStepUp={(idx) =>
          update((f) => {
            if (idx <= 0) return f;
            const next = [...f.steps];
            [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
            return { ...f, steps: next };
          })
        }
        onMoveStepDown={(idx) =>
          update((f) => {
            if (idx >= f.steps.length - 1) return f;
            const next = [...f.steps];
            [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
            return { ...f, steps: next };
          })
        }
        onTriggersChange={(triggers: FlowTrigger[]) => update((f) => ({ ...f, triggers }))}
        onPausedChange={async (paused) => {
          setFlow((cur) => ({ ...cur, paused }));
          const result = await setFlowPaused(flow.id, paused);
          if (!result.ok) {
            alert(`Pause failed: ${result.error}`);
            const next = await listFlows();
            const fresh = next.find((f) => f.id === flow.id);
            if (fresh) setFlow(fresh);
          }
        }}
        onDelete={async () => {
          if (!confirm('Delete this workflow?')) return;
          const result = await deleteFlow(flow.id);
          if (!result.ok) {
            alert(`Delete failed: ${result.error}`);
            return;
          }
          router.push('/workflows');
        }}
        onRun={async (issue) => {
          const result = await runFlowOnIssue({ flowId: flow.id, issueNumber: issue });
          if (!result.ok) {
            alert(`Run failed: ${result.error}`);
            return;
          }
          const fresh = await getFlow(flow.id);
          if (fresh) setFlow(fresh);
        }}
        onOpenRun={() => flow.lastRun && router.push(`/cockpit/${flow.lastRun.id}`)}
      />

      {canWrite && (
        <div className="mt-6 flex items-center gap-3">
          <button
            onClick={save}
            disabled={!dirty || savingState === 'saving'}
            className="inline-flex items-center gap-2 rounded-md border border-accent/50 bg-accent/15 px-3 py-1.5 text-sm font-medium text-fg hover:bg-accent/25 disabled:opacity-50"
          >
            <SaveIcon />
            {savingState === 'saving' ? 'Saving…' : 'Save workflow'}
          </button>
          <span className="text-xs text-fg-muted">
            {savingState === 'saved' && 'Saved'}
            {savingState === 'error' && saveError && (
              <span className="text-rose-400">{saveError}</span>
            )}
            {savingState === 'idle' && (dirty ? 'Unsaved changes' : 'Saved')}
          </span>
        </div>
      )}
    </PageContainer>
  );
}

function SaveIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  );
}
