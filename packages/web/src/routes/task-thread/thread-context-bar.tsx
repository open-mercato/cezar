import type { ReactNode } from 'react'

import type { PlanEntry, StepState } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

import { PlanList, planCounts } from './plan-dock'
import { StepRail, activeStepIndex, railBarTone, type RailBarTone } from './step-rail'

/**
 * The run's workflow steps and the agent's plan, as two chips that slide UNDER the composer's top
 * edge — the input overlaps their lower half, so only the labelled top shows, like index tabs
 * tucked behind a card. Separated from each other (no overlap), not fused to the input, and
 * labelled by a status-colored top edge rather than an icon. Each expands into a popover on click —
 * an overlay that never pushes the thread. Renders nothing without either.
 */
export function ThreadContextBar({
  steps,
  plan,
  settled = false,
}: {
  steps: StepState[]
  plan: PlanEntry[] | undefined
  settled?: boolean
}) {
  const hasSteps = steps.length > 0
  const hasPlan = plan !== undefined && plan.length > 0
  if (!hasSteps && !hasPlan) return null
  return (
    // -mb-2 pulls the composer up over the chips' lower half so they read as tucked UNDER it.
    // Kept STATIC (no relative/z): a positioned tab bar would paint ABOVE the static composer and
    // defeat the tuck — as a plain later sibling the composer's opaque top wins. gap-2 keeps the
    // two chips apart, not overlapping each other.
    <div data-slot="thread-context-bar" className="-mb-2 flex justify-end gap-2 pr-2">
      {hasSteps ? <StepsChip steps={steps} /> : null}
      {hasPlan ? <PlanChip entries={plan} settled={settled} /> : null}
    </div>
  )
}

/** A chip rounded only at the top with an open bottom (border-b-0): its lower half slides behind
 *  the composer's opaque top edge, so it reads as tucked under. The status color rides the top
 *  edge (see the accent maps below); pb-2 is the slice that disappears under the input. */
const TAB_CLASS =
  'flex min-w-0 items-center gap-1.5 rounded-t-lg border border-border border-b-0 bg-card px-2.5 pt-2 pb-2 hover:bg-muted data-[state=open]:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

/** A status-colored top edge is what tells the two tabs apart at a glance: Verify carries the
 *  workflow's live tone (green done / amber running / danger failed), Plan carries the accent. */
const STEPS_ACCENT: Record<RailBarTone, string> = {
  active: 'border-t-2 border-t-pending',
  done: 'border-t-2 border-t-success',
  failed: 'border-t-2 border-t-danger',
}

/** Uppercase but a notch smaller than the body — a quiet tab label, not a shout. */
const TAB_LABEL = 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.04em] text-foreground'
const TAB_COUNT = 'shrink-0 text-[10px] tabular-nums text-soft-foreground'

function ContextChip({
  slot,
  label,
  accentClass,
  children,
  panel,
}: {
  slot: string
  label: string
  accentClass: string
  children: ReactNode
  panel: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot={slot}
          aria-label={label}
          className={cn(TAB_CLASS, accentClass)}
        >
          {children}
        </button>
      </PopoverTrigger>
      {/* Fit the content, don't reserve a fixed column: `w-max` collapses the row's `ml-auto`
          gap and a tighter pad drops the empty margins. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-max min-w-[11rem] max-w-[min(26rem,90vw)] p-3"
      >
        {panel}
      </PopoverContent>
    </Popover>
  )
}

function StepsChip({ steps }: { steps: StepState[] }) {
  const index = activeStepIndex(steps)
  const current = steps[index]!
  const tone = railBarTone(steps)
  return (
    <ContextChip
      slot="steps-chip"
      label={`Workflow steps: ${current.name}, step ${index + 1} of ${steps.length}`}
      accentClass={STEPS_ACCENT[tone]}
      panel={<StepRail steps={steps} />}
    >
      <span className={cn(TAB_LABEL, 'min-w-0 max-w-[12ch] truncate')}>{current.name}</span>
      <span className={TAB_COUNT}>
        {index + 1}/{steps.length}
      </span>
    </ContextChip>
  )
}

function PlanChip({ entries, settled }: { entries: PlanEntry[]; settled: boolean }) {
  const { done, total } = planCounts(entries)
  return (
    <ContextChip
      slot="plan-chip"
      label={`Plan: ${done} of ${total} done`}
      // Plan owns the accent (violet) — distinct from Verify's status tone, so a glance separates them.
      accentClass="border-t-2 border-t-violet"
      panel={<PlanList entries={entries} settled={settled} />}
    >
      <span className={TAB_LABEL}>Plan</span>
      <span data-slot="plan-count" className={TAB_COUNT}>
        {done}/{total}
      </span>
    </ContextChip>
  )
}
