import { ChevronDownIcon, CircleCheckIcon, CircleIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react'
import type { StepState, StepStatus } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
    <div data-slot="step-rail" className="flex min-w-0 flex-col gap-1.5">
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
          <span className="ml-auto shrink-0 pl-2 text-xs text-soft-foreground tabular-nums">
            {step.kind} · {index + 1}/{steps.length}
          </span>
        </div>
      ))}
      <div data-slot="step-progress" className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function RailIcon({ visual }: { visual: RailVisual }) {
  const base = 'size-3.5 shrink-0'
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
      className={cn('h-1 w-2.5 rounded-full', tone, visual === 'pending' && 'opacity-35', visual === 'active' && 'animate-pulse motion-reduce:animate-none')}
    />
  )
}

/**
 * The step rail as it sits in the run header: a slim one-line stepper — a segment per step, the
 * current step's name and its position — that opens the full `StepRail` in a popover. The header
 * stays shallow and the thread gets the vertical room; the detail is one click away.
 */
export function WorkflowSteps({
  runId,
  steps,
  className,
}: {
  runId: string
  steps: StepState[]
  className?: string
}) {
  if (steps.length === 0) return null
  const index = activeStepIndex(steps)
  const current = steps[index]!
  const pct = railProgress(steps) * 100
  // A segment per step reads at a glance up to a point; past it, one bar says the same thing.
  const segmented = steps.length <= 12
  return (
    <Popover>
      <PopoverTrigger
        data-slot="workflow-steps"
        data-run-id={runId}
        aria-label={`Workflow: ${current.name}, step ${index + 1} of ${steps.length}`}
        className={cn(
          'group flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 data-[state=open]:bg-muted',
          className,
        )}
      >
        {segmented ? (
          <span data-slot="step-dots" className="flex shrink-0 items-center gap-0.5">
            {steps.map((step) => (
              <StepDot key={step.id} visual={railVisual(step.status)} />
            ))}
          </span>
        ) : (
          <span data-slot="step-summary-progress" className="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
            <span className="block h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
          </span>
        )}
        <span data-slot="step-name" className="min-w-0 truncate font-medium text-foreground">{current.name}</span>
        <span className="shrink-0 text-xs tabular-nums">
          {index + 1} of {steps.length}
        </span>
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-180"
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(26rem,calc(100vw-2rem))] p-4">
        <p className="mb-3 text-[13px] font-semibold text-foreground">Workflow steps</p>
        <StepRail steps={steps} />
      </PopoverContent>
    </Popover>
  )
}
