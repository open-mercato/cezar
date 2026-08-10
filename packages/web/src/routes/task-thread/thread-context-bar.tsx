import { CircleCheckBigIcon, ListTodoIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { PlanEntry, StepState } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { PlanList, planCounts } from './plan-dock'
import { StepRail, activeStepIndex } from './step-rail'

/**
 * The run's workflow steps and the agent's plan, as TABS glued to the composer's top-right edge
 * (#header-density). Each is collapsed to an icon + count and expands UPWARD into a popover on
 * click — an overlay that never pushes the thread or composer. The tabs overlap like folder tabs
 * and share the composer's surface so they read as part of it. Renders nothing without either.
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
    // -mb-px drops the tabs' open bottoms onto the composer's top border so they merge into it;
    // z-10 keeps them above it; -ml-2 on all but the first makes the tabs overlap.
    <div
      data-slot="thread-context-bar"
      className="relative z-10 -mb-px flex justify-end pr-3 [&>*:not(:first-child)]:-ml-2"
    >
      {hasSteps ? <StepsChip steps={steps} /> : null}
      {hasPlan ? <PlanChip entries={plan} settled={settled} /> : null}
    </div>
  )
}

/** A tab: rounded top, open bottom (border-b-0) and the composer's own `bg-card`, so it looks cut
 *  from the same surface. Hover/open lifts it above its neighbour. */
const TAB_CLASS =
  'relative flex min-w-0 items-center gap-1.5 rounded-t-lg border border-border border-b-0 bg-card px-3 py-1.5 text-[13px] text-muted-foreground hover:z-20 hover:bg-muted hover:text-foreground data-[state=open]:z-20 data-[state=open]:bg-muted focus-visible:z-20 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

function ContextChip({
  slot,
  label,
  icon,
  children,
  panel,
}: {
  slot: string
  label: string
  icon: ReactNode
  children: ReactNode
  panel: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-slot={slot} aria-label={label} className={TAB_CLASS}>
          {icon}
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} className="w-[min(28rem,90vw)]">
        {panel}
      </PopoverContent>
    </Popover>
  )
}

function StepsChip({ steps }: { steps: StepState[] }) {
  const index = activeStepIndex(steps)
  const current = steps[index]!
  return (
    <ContextChip
      slot="steps-chip"
      label={`Workflow steps: ${current.name}, step ${index + 1} of ${steps.length}`}
      icon={<CircleCheckBigIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />}
      panel={<StepRail steps={steps} />}
    >
      <span className="min-w-0 max-w-[14ch] truncate font-medium text-foreground">{current.name}</span>
      <span className="shrink-0 text-soft-foreground tabular-nums">
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
      icon={<ListTodoIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />}
      panel={<PlanList entries={entries} settled={settled} />}
    >
      <span className="shrink-0 font-medium text-foreground">Plan</span>
      <span data-slot="plan-count" className="shrink-0 text-soft-foreground tabular-nums">
        {done}/{total}
      </span>
    </ContextChip>
  )
}
