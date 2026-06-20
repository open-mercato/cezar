'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { WorkspaceRole } from '@/lib/supabase/types';
import { deleteFlow, listFlows, setFlowPaused, upsertFlow, type FlowSummary } from './actions';
import { FLOW_TEMPLATES, type FlowTemplate } from './templates';
import {
  PauseToggle,
  StatusBadge,
  describeTriggers,
  formatTokens,
  historyDotClass,
} from './flow-card';
import { PageContainer } from '@/components/ui/page-container';
import { Sheet } from '@/components/ui/sheet';
import { cn } from '@/components/ui/cn';
import { useIsMobile } from '@/lib/use-is-mobile';

interface Props {
  workspaceName: string;
  workspaceRole: WorkspaceRole;
  initialFlows: FlowSummary[];
}

/**
 * The /workflows index — a list of defined workflows. Each card links to its
 * own detail/edit page (`/workflows/[id]`). Creating from a template persists
 * immediately and navigates to the new workflow's page.
 */
export function WorkflowsList({ workspaceName, workspaceRole, initialFlows }: Props) {
  const router = useRouter();
  const [flows, setFlows] = useState<FlowSummary[]>(initialFlows);
  const [creating, setCreating] = useState(false);
  const canWrite = workspaceRole !== 'viewer';

  // Light background refresh so run dots / stats stay current.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      listFlows().then(setFlows);
    };
    const i = window.setInterval(tick, 15000);
    return () => window.clearInterval(i);
  }, []);

  const createFromTemplate = async (template: FlowTemplate) => {
    if (creating) return;
    setCreating(true);
    const built = template.build();
    const result = await upsertFlow({
      name: built.name,
      steps: built.steps,
      triggers: built.triggers,
    });
    if (!result.ok) {
      setCreating(false);
      alert(`Create failed: ${result.error}`);
      return;
    }
    router.push(`/workflows/${result.id}`);
  };

  const togglePause = async (flow: FlowSummary, paused: boolean) => {
    setFlows((cur) => cur.map((f) => (f.id === flow.id ? { ...f, paused } : f)));
    const result = await setFlowPaused(flow.id, paused);
    if (!result.ok) {
      alert(`Pause failed: ${result.error}`);
      setFlows(await listFlows());
    }
  };

  const remove = async (flow: FlowSummary) => {
    if (!confirm(`Delete workflow "${flow.name}"?`)) return;
    const result = await deleteFlow(flow.id);
    if (!result.ok) {
      alert(`Delete failed: ${result.error}`);
      return;
    }
    setFlows((cur) => cur.filter((f) => f.id !== flow.id));
  };

  return (
    <PageContainer>
      <header className="mb-6 border-b border-border pb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Workflows</h1>
            <p className="mt-1 max-w-2xl text-sm text-fg-muted">
              Chain named skill steps into reusable workflows. Open one to edit its steps, triggers,
              and run it.
              <span className="ml-1 text-fg-muted/60">
                — workspace: <span className="text-fg">{workspaceName}</span>
              </span>
            </p>
          </div>
          {canWrite && <NewFlowMenu onPick={createFromTemplate} busy={creating} />}
        </div>
      </header>

      {flows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-bg-subtle p-8 text-center text-sm text-fg-muted">
          No workflows yet. {canWrite ? 'Click "+ Flow" to create one from a template.' : ''}
        </div>
      ) : (
        <ul className="space-y-3">
          {flows.map((flow) => (
            <WorkflowListItem
              key={flow.id}
              flow={flow}
              canWrite={canWrite}
              onTogglePause={(p) => togglePause(flow, p)}
              onDelete={() => remove(flow)}
            />
          ))}
        </ul>
      )}
    </PageContainer>
  );
}

function WorkflowListItem({
  flow,
  canWrite,
  onTogglePause,
  onDelete,
}: {
  flow: FlowSummary;
  canWrite: boolean;
  onTogglePause: (paused: boolean) => void;
  onDelete: () => void;
}) {
  const stepCount = flow.steps.length;
  const triggerText = flow.triggers.length === 0 ? 'Manual only' : describeTriggers(flow.triggers);

  return (
    <li
      className={cn(
        'rounded-lg border bg-bg-elevated p-4',
        flow.paused ? 'border-border/60' : 'border-border',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Link href={`/workflows/${flow.id}`} className="group min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-fg group-hover:text-accent">
              {flow.name}
            </span>
            <span
              className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                flow.paused
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-emerald-500/15 text-emerald-400',
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  flow.paused ? 'bg-amber-400' : 'bg-emerald-400',
                )}
              />
              {flow.paused ? 'Paused' : 'Active'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-fg-muted">
            <span>
              {stepCount} step{stepCount === 1 ? '' : 's'}
            </span>
            <span className="text-fg-muted/40">·</span>
            <span className="truncate">{triggerText}</span>
          </div>
        </Link>

        {canWrite && (
          <div className="flex shrink-0 items-center gap-1.5">
            <PauseToggle paused={flow.paused} onChange={onTogglePause} />
            <button
              onClick={onDelete}
              aria-label="Delete workflow"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border bg-bg-subtle text-rose-400 hover:bg-rose-500/10"
            >
              <TrashIcon />
            </button>
          </div>
        )}
      </div>

      {/* Stats + recent-run strip. */}
      {(flow.recentRuns.length > 0 || flow.stats.totalLast7d > 0 || flow.lastRun) && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
          {flow.stats.totalLast7d > 0 && (
            <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted">
              ✓{' '}
              <span className="text-fg">
                {flow.stats.succeededLast7d}/{flow.stats.totalLast7d}
              </span>{' '}
              <span className="text-fg-muted/60">(7d)</span>
            </span>
          )}
          {flow.stats.avgTokens > 0 && (
            <span className="rounded bg-bg-subtle px-1.5 py-0.5 text-[11px] text-fg-muted">
              ~<span className="text-fg">{formatTokens(flow.stats.avgTokens)}</span> tokens/run
            </span>
          )}
          {flow.recentRuns.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="text-[10px] uppercase tracking-wide text-fg-muted/60">recent</span>
              {flow.recentRuns.map((r) => (
                <a
                  key={r.id}
                  href={`/cockpit/${r.id}`}
                  title={`${r.status}${r.issueNumber != null ? ` · #${r.issueNumber}` : ''} · ${new Date(r.startedAt).toLocaleString()}`}
                  className={`inline-block h-3 w-3 rounded-sm ${historyDotClass(r.status)}`}
                />
              ))}
            </span>
          )}
          {flow.lastRun && (
            <span className="ml-auto flex items-center gap-1.5 text-[11px] text-fg-muted">
              <StatusBadge status={flow.lastRun.status} />
              {flow.lastRun.issueNumber != null && <span>#{flow.lastRun.issueNumber}</span>}
              <span>{new Date(flow.lastRun.startedAt).toLocaleDateString()}</span>
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function NewFlowMenu({ onPick, busy }: { onPick: (t: FlowTemplate) => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (!open || isMobile) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-newflow-menu]')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isMobile]);

  const pick = (t: FlowTemplate) => {
    setOpen(false);
    onPick(t);
  };

  return (
    <div className="relative" data-newflow-menu>
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent/10 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-accent/20 disabled:opacity-50"
      >
        <span className="text-base leading-none">+</span> {busy ? 'Creating…' : 'Flow'}
        {!busy && (
          <span aria-hidden className="text-fg-muted">
            ▾
          </span>
        )}
      </button>

      {open && !isMobile && (
        <div className="absolute left-0 top-full z-popover mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-bg-elevated shadow-ambient">
          <div className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Start from a template
          </div>
          <div className="p-1">
            {FLOW_TEMPLATES.map((t) => (
              <TemplateRow key={t.id} template={t} onPick={pick} />
            ))}
          </div>
        </div>
      )}

      <Sheet
        open={open && isMobile}
        onClose={() => setOpen(false)}
        side="bottom"
        title="Start from a template"
      >
        <div className="px-2 py-2">
          {FLOW_TEMPLATES.map((t) => (
            <TemplateRow key={t.id} template={t} onPick={pick} large />
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function TemplateRow({
  template,
  onPick,
  large,
}: {
  template: FlowTemplate;
  onPick: (t: FlowTemplate) => void;
  large?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(template)}
      className={cn(
        'flex w-full items-start gap-3 rounded-md text-left transition-colors hover:bg-bg-subtle',
        large ? 'min-h-12 px-3 py-3' : 'px-2.5 py-2',
      )}
    >
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-accent/40 bg-accent/10 text-accent">
        <PlayIcon />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{template.label}</span>
        <span className="block text-[11px] leading-snug text-fg-muted">{template.description}</span>
      </span>
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

function TrashIcon() {
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
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  );
}
