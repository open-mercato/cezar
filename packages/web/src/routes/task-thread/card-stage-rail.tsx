import type { ApiRun, CardStageStatus } from '@open-mercato/cezar-api-client'
import { ChevronDownIcon } from 'lucide-react'
import { useMemo, useState } from 'react'

import { stageNamesOf, useFrameworks } from '@/api/frameworks'
import { StatusDot } from '@/components/status-dot'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { AttentionTone } from '@/lib/attention'
import { cardHeaderLabel, cardStageGroups, type CardRun, type StageNames } from '@/lib/cards'
import { StepRail } from './step-rail'

/**
 * The task view of a framework card (spec 2026-11-15-framework-board): the rail shows one dot per
 * framework stage, not the 20-odd compiled nodes (`stage.enter`, gates, loops) — those stay in the
 * expanded detail, as sub-steps of their stage.
 */

export function useCardNames(run: CardRun): { names: StageNames; frameworkName: string } {
  const frameworks = useFrameworks()
  const names = useMemo(() => stageNamesOf(frameworks.data, run.card.framework), [frameworks.data, run.card.framework])
  const frameworkName = frameworks.data?.frameworks.find((f) => f.id === run.card.framework)?.name ?? run.card.framework
  return { names, frameworkName }
}

/** The header's facts line for a card: `◆ <framework> · <Stage> · n/N`. */
export function CardMetaLabel({ run }: { run: CardRun }) {
  const { names, frameworkName } = useCardNames(run)
  return (
    <span data-slot="card-meta" className="text-violet">
      {cardHeaderLabel(run, frameworkName, names)}
    </span>
  )
}

const STAGE_TONE: Record<CardStageStatus, { tone: AttentionTone; pulse: boolean; label: string }> = {
  done: { tone: 'success', pulse: false, label: 'done' },
  running: { tone: 'violet', pulse: true, label: 'running' },
  waiting: { tone: 'pending', pulse: false, label: 'waiting for you' },
  failed: { tone: 'danger', pulse: false, label: 'failed' },
  skipped: { tone: 'neutral', pulse: false, label: 'skipped' },
  stale: { tone: 'pending', pulse: false, label: 'stale' },
  pending: { tone: 'neutral', pulse: false, label: 'pending' },
}

const openByRun = new Map<string, boolean>()

export function CardStageRail({ run }: { run: CardRun & ApiRun }) {
  const { names } = useCardNames(run)
  const groups = useMemo(() => cardStageGroups(run, names), [run, names])
  const [open, setOpen] = useState(() => openByRun.get(run.id) ?? false)
  const index = Math.max(0, run.card.stageOrder.indexOf(run.card.stage))
  const current = groups[index]
  if (!current) return null
  const toggle = (next: boolean) => {
    openByRun.set(run.id, next)
    setOpen(next)
  }
  const done = groups.filter((g) => g.status === 'done' || g.status === 'skipped').length
  const pct = groups.length ? (done / groups.length) * 100 : 0
  return (
    <Collapsible data-slot="card-stage-rail" open={open} onOpenChange={toggle} className="min-w-0">
      <CollapsibleTrigger
        aria-label={`Stages: ${current.name}, stage ${index + 1} of ${groups.length}`}
        className="group -my-2 flex min-h-11 w-full items-center gap-2 text-left text-label text-muted-foreground hover:text-foreground md:my-0 md:min-h-[30px] md:gap-2.5"
      >
        <span data-slot="stage-dots" className="flex shrink-0 items-center gap-1">
          {groups.map((g) => {
            const t = STAGE_TONE[g.status] ?? STAGE_TONE.pending
            return <StatusDot key={g.id} aria-hidden data-slot="stage-dot" data-stage={g.id} data-status={g.status} tone={t.tone} pulse={t.pulse} className="size-1.5" />
          })}
        </span>
        <span className="min-w-0 max-w-[45%] shrink truncate font-semibold text-foreground">{current.name}</span>
        <span className="shrink-0 text-soft-foreground tabular-nums">
          stage {index + 1} of {groups.length}
        </span>
        <span className="h-0.5 min-w-[36px] flex-1 overflow-hidden rounded-full bg-muted">
          <span className="block h-full rounded-full bg-violet" style={{ width: `${pct}%` }} />
        </span>
        <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-soft-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol data-slot="card-stage-list" className="flex flex-col gap-2 pt-2">
          {groups.map((g, i) => {
            const t = STAGE_TONE[g.status] ?? STAGE_TONE.pending
            return (
              <li key={g.id} data-slot="card-stage-row" data-stage={g.id}>
                <div className="flex items-center gap-2 text-ui">
                  <StatusDot aria-hidden tone={t.tone} pulse={t.pulse} />
                  <span className="font-medium text-foreground">{g.name}</span>
                  <span className="ml-auto text-meta text-soft-foreground tabular-nums">
                    {t.label} · {i + 1}/{groups.length}
                  </span>
                </div>
                {g.steps.length ? (
                  <div data-slot="card-stage-substeps" className="mt-1 border-l border-border pl-4">
                    <StepRail steps={g.steps as ApiRun['steps']} />
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}
