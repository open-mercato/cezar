import { ChevronDownIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import type { PlanEntry, StepState } from '@open-mercato/cezar-api-client'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { PlanList, planActiveEntry, planCounts } from './plan-dock'
import { StepDot, StepRail, activeStepIndex, railVisual } from './step-rail'

/**
 * The thin context bar above the composer: the run's workflow steps and the agent's plan, each a
 * collapsed CHIP that expands UPWARD into a popover on click. Neither eats a permanent row and
 * neither pushes the thread — the collapsed count still shows progress at a glance, and one click
 * reveals the detail right where you act on the run. Renders nothing when the run has neither.
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
    <div data-slot="thread-context-bar" className="flex flex-wrap items-center gap-2">
      {hasSteps ? <StepsChip steps={steps} /> : null}
      {hasPlan ? <PlanChip entries={plan} settled={settled} /> : null}
    </div>
  )
}

/** The shared chip chrome — a small pill that reads as a tab and opens its panel above. */
const CHIP_CLASS =
  'flex min-w-0 items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[13px] hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none'

function ContextChip({
  slot,
  label,
  children,
  panel,
}: {
  slot: string
  label: string
  children: ReactNode
  panel: ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" data-slot={slot} aria-label={label} className={CHIP_CLASS}>
          {children}
          <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-soft-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[min(28rem,90vw)]">
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
      panel={<StepRail steps={steps} />}
    >
      <span data-slot="step-dots" className="flex shrink-0 items-center gap-1">
        {steps.map((step) => (
          <StepDot key={step.id} visual={railVisual(step.status)} />
        ))}
      </span>
      <span className="min-w-0 max-w-[16ch] truncate font-medium text-foreground">{current.name}</span>
      <span className="shrink-0 text-soft-foreground tabular-nums">
        {index + 1}/{steps.length}
      </span>
    </ContextChip>
  )
}

function PlanChip({ entries, settled }: { entries: PlanEntry[]; settled: boolean }) {
  const { done, total } = planCounts(entries)
  const active = planActiveEntry(entries)
  return (
    <ContextChip
      slot="plan-chip"
      label={`Plan: ${done} of ${total} done`}
      panel={<PlanList entries={entries} settled={settled} />}
    >
      {/* The plan dock's brand-gradient edge, compressed to a dot. */}
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: 'var(--grad)' }} />
      <span className="shrink-0 font-medium text-foreground">Plan</span>
      <span data-slot="plan-count" className="shrink-0 text-soft-foreground tabular-nums">
        {done}/{total}
      </span>
      {active !== undefined && !settled ? (
        <span
          data-slot="plan-current"
          className="min-w-0 max-w-[18ch] truncate border-l border-border pl-2 text-muted-foreground"
        >
          {active.activeForm ?? active.content}
        </span>
      ) : null}
    </ContextChip>
  )
}
