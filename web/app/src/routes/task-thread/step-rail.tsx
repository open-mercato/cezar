import {
  ChevronDownIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  LoaderCircleIcon,
} from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import type { StepState, StepStatus } from '@/api/types'
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

export function StepRail({
  steps,
  defaultExpanded = true,
}: {
  steps: StepState[]
  /** Short, live workflows may start open. Long or closed runs should keep the transcript
   *  primary and expose their full execution history on demand. */
  defaultExpanded?: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const listId = useId()
  useEffect(() => {
    // A short workflow may have started open. Once its run closes, reclaim the transcript
    // space automatically; a later manual expansion remains open because this dependency
    // changes only at that live → closed boundary.
    if (!defaultExpanded) setExpanded(false)
  }, [defaultExpanded])
  if (steps.length === 0) return null
  const pct = railProgress(steps) * 100
  const activeIndex = steps.findIndex((step) =>
    ['running', 'waiting', 'review'].includes(step.status),
  )
  let failedIndex = -1
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (['failed', 'cancelled'].includes(steps[index]!.status)) {
      failedIndex = index
      break
    }
  }
  const focusIndex = activeIndex >= 0 ? activeIndex : failedIndex
  const focus = focusIndex >= 0 ? steps[focusIndex] : undefined
  const done = steps.filter((step) =>
    ['done', 'failed', 'cancelled', 'skipped'].includes(step.status),
  ).length
  const summaryVisual =
    focus === undefined
      ? done === steps.length
        ? 'done'
        : 'pending'
      : railVisual(focus.status)
  const summary =
    focus !== undefined
      ? focus.status === 'failed'
        ? `${focus.name} failed`
        : focus.status === 'cancelled'
          ? `${focus.name} cancelled`
          : focus.name
      : done === steps.length
        ? 'Workflow steps complete'
        : 'Workflow progress'
  const summaryMeta =
    focusIndex >= 0 ? `Step ${focusIndex + 1} of ${steps.length}` : `${done} of ${steps.length} finished`

  return (
    <section
      data-slot="step-rail"
      data-state={expanded ? 'open' : 'collapsed'}
      className="flex min-w-0 flex-col gap-1"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-7 min-w-0 items-center gap-2 rounded-md text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <RailIcon visual={summaryVisual} announce={false} />
        <span data-slot="step-summary" className="min-w-0 truncate font-medium text-foreground">
          {summary}
        </span>
        <span
          data-slot="step-summary-position"
          className="shrink-0 text-soft-foreground tabular-nums"
        >
          · {summaryMeta}
        </span>
        <span className="ml-auto shrink-0 text-soft-foreground">
          {expanded ? 'Hide steps' : 'Show steps'}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            'size-3.5 shrink-0 text-soft-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      <div data-slot="step-progress" className="h-0.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-pending" style={{ width: `${pct}%` }} />
      </div>

      {expanded ? (
        <div id={listId} className="mt-1 max-h-96 overflow-y-auto overscroll-contain pr-1">
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
                <span
                  data-slot="step-iterations"
                  className="shrink-0 text-xs text-soft-foreground tabular-nums"
                >
                  ×{step.iterations}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 pl-2 text-[11.5px] text-soft-foreground tabular-nums">
                {step.kind} · step {index + 1} of {steps.length}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  )
}

function RailIcon({ visual, announce = true }: { visual: RailVisual; announce?: boolean }) {
  const base = 'size-[13px] shrink-0'
  switch (visual) {
    case 'done':
      return <CircleCheckIcon aria-hidden className={cn(base, 'text-success')} />
    case 'active':
      return (
        <LoaderCircleIcon
          role={announce ? 'status' : undefined}
          aria-label={announce ? 'Step running' : undefined}
          aria-hidden={announce ? undefined : true}
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
