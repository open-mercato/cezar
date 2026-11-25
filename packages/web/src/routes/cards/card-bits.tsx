import { LayoutGridIcon, ListIcon } from 'lucide-react'
import * as React from 'react'
import { useSearchParams } from 'react-router'

import { Segmented } from '@/components/segmented'
import {
  CARD_STATE_LABEL,
  cardHeadline,
  cardNotStarted,
  cardStageLabel,
  cardState,
  displayStageStatus,
  needsYou,
  stageName,
  stripTone,
  type CardRun,
  type StageNames,
  type StripTone,
} from '@/lib/cards'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

/** Board legend tones (mockup 1): done / running / waiting for you (amber) / failed. */
const STRIP_CLASS: Record<StripTone, string> = {
  done: 'bg-success',
  running: 'bg-violet motion-safe:animate-pulse',
  waiting: 'bg-pending',
  failed: 'bg-danger',
  pending: 'bg-muted-foreground/25',
  skipped: 'bg-muted-foreground/10',
}

/** One segment per stage of the card's own framework, in its order. */
export function StageStrip({ run, names, className }: { run: CardRun; names?: StageNames; className?: string }) {
  const order = run.card.stageOrder
  const label = order.map((id) => `${stageName(names, id)}: ${displayStageStatus(run, id) ?? 'pending'}`).join(', ')
  return (
    <span data-slot="stage-strip" role="img" aria-label={`Stages — ${label}`} className={cn('flex h-1.5 w-full gap-0.5', className)}>
      {order.map((id) => {
        const tone = stripTone(displayStageStatus(run, id))
        return <span key={id} data-stage={id} data-tone={tone} className={cn('h-full flex-1 rounded-full', STRIP_CLASS[tone])} />
      })}
    </span>
  )
}

const STATE_CLASS = {
  approve: 'bg-pending/15 text-pending-strong',
  'your-turn': 'bg-info/15 text-info',
  question: 'bg-info/15 text-info',
  failed: 'bg-danger/15 text-danger',
  blocked: 'bg-pending/15 text-pending-strong',
} as const

/** The state pill (⏸ approve, 💬 your turn, ✕ failed…), or nothing for a card that is just working. */
export function CardStateBadge({ run, className }: { run: CardRun; className?: string }) {
  const state = cardState(run)
  if (!state) return null
  return (
    <span data-slot="card-state" data-state={state} className={cn('shrink-0 rounded-full px-1.5 py-px text-micro font-medium whitespace-nowrap', STATE_CLASS[state], className)}>
      {CARD_STATE_LABEL[state]}
    </span>
  )
}

/**
 * A board tile's content (mockup 1): title and issue ref, the stage strip, and the one most
 * important line. The desktop kanban and the phone board both draw it; `phone` clamps the title
 * to two lines and adds the state pill.
 */
export function CardTileBody({ run, names, note, phone = false }: { run: CardRun; names?: StageNames; note?: string; phone?: boolean }) {
  const waiting = needsYou(run)
  return (
    <>
      <div className="flex items-start gap-1.5">
        <span className={cn('min-w-0 flex-1 text-ui leading-snug font-medium [overflow-wrap:anywhere] text-foreground', phone && 'line-clamp-2')}>{run.card.title}</span>
        {run.card.issue ? <span className="shrink-0 font-mono text-micro text-muted-foreground">{run.card.issue.ref}</span> : null}
      </div>
      <StageStrip run={run} names={names} className="mt-2" />
      <div className="mt-1.5 flex items-center gap-1.5 text-meta">
        <span data-slot="card-headline" className={cn('min-w-0 truncate', waiting ? 'text-pending-strong' : run.status === 'failed' ? 'text-danger' : 'text-muted-foreground')}>
          {cardHeadline(run, names)}
        </span>
        {note ? <span className="ml-auto shrink-0 text-micro text-soft-foreground">{note}</span> : null}
        {phone ? <CardStateBadge run={run} className={note ? undefined : 'ml-auto'} /> : null}
      </div>
    </>
  )
}

/** Framework id → its stage names, for rows deep in the table (the route fills it from `/frameworks`). */
export const CardStageNamesContext = React.createContext<ReadonlyMap<string, StageNames> | undefined>(undefined)

/** The list row's card marks (mockup 0): ◆, the stage chip `Spec review · 3/8`, and the state. */
export function CardRowBadge({ run, names: given }: { run: CardRun; names?: StageNames }) {
  const byFramework = React.useContext(CardStageNamesContext)
  const names = given ?? byFramework?.get(run.card.framework)
  const state = cardState(run)
  return (
    <span data-slot="card-badge" className="inline-flex shrink-0 items-center gap-1.5">
      <Link
        to={`/cards/${run.id}`}
        aria-label={`Open card ${run.card.title}`}
        title="Framework card"
        className="text-violet hover:text-foreground"
      >
        ◆
      </Link>
      <span data-slot="card-stage" className="rounded-full bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground">
        {cardNotStarted(run) ? (run.card.held ? 'Backlog' : 'Ready') : cardStageLabel(run, names)}
      </span>
      {state ? (
        <span data-slot="card-state" data-state={state} className={cn('rounded-full px-1.5 py-px text-micro font-medium', STATE_CLASS[state])}>
          {CARD_STATE_LABEL[state]}
        </span>
      ) : null}
    </span>
  )
}

export type TasksLayout = 'list' | 'board'

/** `?view=board` (spec § Tasks view: List and Board are two views of the same route). */
export function useTasksLayout(): [TasksLayout, (layout: TasksLayout) => void] {
  const [params, setParams] = useSearchParams()
  const layout: TasksLayout = params.get('view') === 'board' ? 'board' : 'list'
  const set = React.useCallback(
    (next: TasksLayout) =>
      setParams(
        (current) => {
          const out = new URLSearchParams(current)
          if (next === 'board') out.set('view', 'board')
          else out.delete('view')
          return out
        },
        { replace: true },
      ),
    [setParams],
  )
  return [layout, set]
}

export function TasksLayoutToggle({ layout, onChange }: { layout: TasksLayout; onChange: (layout: TasksLayout) => void }) {
  return (
    <Segmented
      slot="tasks-layout"
      label="Tasks layout"
      value={layout}
      onChange={onChange}
      options={[
        { value: 'list', label: <span className="inline-flex items-center gap-1"><ListIcon className="size-3.5" aria-hidden="true" />List</span> },
        { value: 'board', label: <span className="inline-flex items-center gap-1"><LayoutGridIcon className="size-3.5" aria-hidden="true" />Board</span> },
      ]}
    />
  )
}
