import { ChevronDownIcon, CircleCheckIcon, CircleIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'

import type { StepState, StepStatus } from '@open-mercato/cezar-api-client'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'

/**
 * The WORKFLOW step rail (spec §"Task thread" — steps ≠ plan: these are the run's own
 * `RunRecord.steps`, not the agent's todo checklist). Mercato startup-checklist style
 * (mockup `.step-rail`): one row per step — emerald check / amber spinner / faint circle /
 * danger X — over a thin amber progress bar. Check-step OUTPUT renders in the thread as
 * command cards (`thread-state.ts` `check-output`); this rail is only the state summary.
 */

/** The four rail glyphs. Pure so the status → glyph table is testable without rendering. */
export type RailVisual = 'done' | 'active' | 'pending' | 'failed'

export function railVisual(status: StepStatus): RailVisual {
  switch (status) {
    case 'done':
      return 'done'
    case 'running':
    case 'waiting': // the agent paused mid-step — the step is still the live one
    case 'review': // parked at the review gate — same: in flight until accepted
      return 'active'
    case 'failed':
    case 'cancelled':
      return 'failed'
    case 'pending':
    case 'skipped': // never ran — an empty circle is the honest glyph
      return 'pending'
  }
}

/** Mercato's bar formula, `(done + 0.5·running) / total`, generalized over the real status
 *  set: any TERMINAL step counts 1 (the bar measures progress through the workflow, not
 *  success), any ACTIVE one ½, pending 0. */
export function railProgress(steps: ReadonlyArray<Pick<StepState, 'status'>>): number {
  if (steps.length === 0) return 0
  const TERMINAL: ReadonlySet<StepStatus> = new Set(['done', 'failed', 'cancelled', 'skipped'])
  const ACTIVE: ReadonlySet<StepStatus> = new Set(['running', 'waiting', 'review'])
  let score = 0
  for (const step of steps) {
    if (TERMINAL.has(step.status)) score += 1
    else if (ACTIVE.has(step.status)) score += 0.5
  }
  return score / steps.length
}

export function StepRail({ steps }: { steps: StepState[] }) {
  if (steps.length === 0) return null
  const pct = railProgress(steps) * 100
  return (
    <div data-slot="step-rail" className="flex min-w-0 flex-col gap-1">
      {steps.map((step, index) => (
        <div
          key={step.id}
          data-slot="step-row"
          data-visual={railVisual(step.status)}
          className="flex min-h-[22px] min-w-0 items-center gap-2 text-[13px] text-muted-foreground"
        >
          <RailIcon visual={railVisual(step.status)} />
          <span className="min-w-0 truncate font-medium text-foreground">{step.name}</span>
          {step.iterations > 1 ? (
            <span data-slot="step-iterations" className="shrink-0 text-xs text-soft-foreground tabular-nums">
              ×{step.iterations}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 pl-2 text-[11.5px] text-soft-foreground tabular-nums">
            {step.kind} · step {index + 1} of {steps.length}
          </span>
        </div>
      ))}
      <div data-slot="step-progress" className="mt-1 h-0.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RailIcon({ visual }: { visual: RailVisual }) {
  const base = 'size-[13px] shrink-0'
  switch (visual) {
    case 'done':
      return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
    case 'active':
      return (
        <LoaderCircleIcon
          role="status"
          aria-label="Step running"
          // stroke-pending, not text-*: amber is a dot & spinner color only (guardian rule).
          className={cn(base, 'animate-spin stroke-pending motion-reduce:animate-none')}
        />
      )
    case 'failed':
      return <CircleXIcon aria-hidden className={cn(base, 'text-danger')} />
    case 'pending':
      return <CircleIcon aria-hidden className={cn(base, 'text-soft-foreground')} />
  }
}

/** The step the summary line speaks for: the first ACTIVE step (running/waiting/review); else the
 *  next step still to run (first pending), so a not-yet-started or between-steps run reads honestly;
 *  else the last step, so a finished workflow reads "step N of N". */
export function activeStepIndex(steps: ReadonlyArray<Pick<StepState, 'status'>>): number {
  const active = steps.findIndex((step) => railVisual(step.status) === 'active')
  if (active >= 0) return active
  const pending = steps.findIndex((step) => railVisual(step.status) === 'pending')
  if (pending >= 0) return pending
  // `steps.length - 1` would hand an empty list back a -1 that indexes nothing; 0 keeps every
  // caller's `steps[index]` honest (undefined for an empty list, never a silent wrong element).
  return Math.max(0, steps.length - 1)
}

/** One status dot in the collapsed summary — the rail's four glyphs compressed to a color.
 *  Amber (`bg-pending`) stays a dot-only color per the guardian rule. */
function StepDot({ visual }: { visual: RailVisual }) {
  const tone =
    visual === 'done'
      ? 'bg-success'
      : visual === 'failed'
        ? 'bg-danger'
        : visual === 'active'
          ? 'bg-pending'
          : 'bg-soft-foreground'
  return (
    <span
      aria-hidden
      data-slot="step-dot"
      data-visual={visual}
      className={cn('size-1.5 rounded-full', tone, visual === 'active' && 'animate-pulse motion-reduce:animate-none')}
    />
  )
}

/** Expand memory per run id — the same module-level map the Agents dock keeps (`openByRun` in
 *  agents-dock.tsx), for the same reason: `RunHeader` is rendered separately by each of the four
 *  task routes, so without it a Session → Changes → Commits hop would throw the reader's explicit
 *  expand away every time. Session-lifetime only; no server persistence invented for it. */
const openByRun = new Map<string, boolean>()

/**
 * The step rail as it sits in the run header: a ONE-LINE summary by default — a dot per step,
 * the current step's name, its position, and the progress bar — so the header stays shallow and
 * the thread gets the vertical room. Clicking it expands the full `StepRail`.
 * Collapsed by default because the summary already answers "where is this run?" at a glance;
 * an explicit expand is remembered for that run across tab switches.
 */
export function WorkflowSteps({ runId, steps }: { runId: string; steps: StepState[] }) {
  const [open, setOpen] = useState(() => openByRun.get(runId) ?? false)
  if (steps.length === 0) return null
  const toggle = (next: boolean) => {
    openByRun.set(runId, next)
    setOpen(next)
  }
  const index = activeStepIndex(steps)
  const current = steps[index]!
  const pct = railProgress(steps) * 100
  return (
    <Collapsible data-slot="workflow-steps" open={open} onOpenChange={toggle} className="min-w-0">
      <CollapsibleTrigger
        aria-label={`Workflow: ${current.name}, step ${index + 1} of ${steps.length}`}
        className="group flex min-h-7 w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground md:min-h-[30px] md:gap-2.5"
      >
        <span data-slot="step-dots" className="flex shrink-0 items-center gap-1">
          {steps.map((step) => (
            <StepDot key={step.id} visual={railVisual(step.status)} />
          ))}
        </span>
        <span className="min-w-0 max-w-[45%] shrink truncate font-semibold text-foreground">{current.name}</span>
        <span className="shrink-0 text-soft-foreground tabular-nums">
          step {index + 1} of {steps.length}
        </span>
        <span data-slot="step-summary-progress" className="h-0.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pt-2">
          <StepRail steps={steps} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
