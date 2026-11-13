import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, Clock3Icon, GitForkIcon, GripVerticalIcon, ZapIcon } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { AutomationListEntry, AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { dayTime, triggerLabel, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { RowActions } from './row-actions'
import { nextAutomationRun } from './automation-order'
import { automationState, runAttention } from './automation-state'
import type { AutomationActions } from './use-automations'

/**
 * The Automations table (spec 2026-09-14-automations-redesign § UI/UX 1): nine columns, a row
 * per definition, the row itself the way into the editor. Costs are a column only when the
 * server reports them at all; the "Runs as", "Runs 7d" and "Cost 7d" columns give way under
 * 1280px (`.cz-auto-wide`) so the table keeps its shape on a laptop.
 *
 * Status colour comes from `automation-state.ts` (the automation's own state, and a run's via
 * the attention function); nothing here names a tone. Dates, counts and sentences are plain
 * text — mono is for code (redesign 2026-11).
 */

const TH = 'h-[38px] border-b border-border px-[10px] text-left eyebrow whitespace-nowrap text-soft-foreground'
const TD = 'h-12 border-b border-border px-[10px] text-ui leading-none whitespace-nowrap'
const WIDE = 'cz-auto-wide max-[1280px]:hidden'
const DASH = <span className="text-label text-soft-foreground">—</span>

type Reorder = { enabled: boolean; onMove: (from: number, to: number) => void }

export function AutomationsTable({
  data,
  actions,
  now = Date.now(),
  automations = data.automations,
  reorder,
}: {
  data: AutomationsResponse
  actions: AutomationActions
  now?: number
  automations?: readonly AutomationListEntry[]
  reorder?: Reorder
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const showCost = AUTOMATION_COST_VISIBLE && (data.stats.costUsd !== undefined || data.automations.some((automation) => automation.costUsd7d !== undefined))
  const describe = (id: string | number) => {
    const index = automations.findIndex((entry) => entry.id === id)
    const entry = automations[index]
    return entry ? `${entry.name}, position ${index + 1} of ${automations.length}` : 'automation'
  }
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={{ announcements: {
      onDragStart: ({ active }) => `Picked up ${describe(active.id)}.`,
      onDragOver: ({ active, over }) => over ? `${describe(active.id)} moved to ${describe(over.id)}.` : 'No drop position.',
      onDragEnd: ({ active, over }) => over ? `${describe(active.id)} dropped at ${describe(over.id)}.` : 'Order unchanged.',
      onDragCancel: () => 'Reordering cancelled. The order is unchanged.',
    } }} onDragEnd={({ active, over }) => {
      if (!reorder?.enabled || over === null) return
      const from = automations.findIndex((entry) => entry.id === active.id)
      const to = automations.findIndex((entry) => entry.id === over.id)
      if (from >= 0 && to >= 0 && from !== to) reorder.onMove(from, to)
    }}>
      <Card flush data-slot="automations-table" className="min-w-0 overflow-x-auto">
        <table className="w-full border-collapse [&_tbody_tr:last-child>td]:border-b-0">
          <thead>
            <tr>
              {reorder ? <th className={TH}>Order</th> : null}
              <th className={cn(TH, 'pl-4')}>State</th>
              <th className={TH}>Automation</th>
              <th className={TH}>Trigger</th>
              <th className={cn(TH, WIDE)}>Runs as</th>
              <th className={TH}>Next run</th>
              <th className={TH}>Last run</th>
              <th className={cn(TH, WIDE, 'text-right')}>Runs 7d</th>
              {showCost ? <th className={cn(TH, WIDE, 'text-right')}>Cost 7d</th> : null}
              <th className={cn(TH, 'pr-4')} />
            </tr>
          </thead>
          <tbody>
            <SortableContext items={automations.map((entry) => entry.id)} strategy={verticalListSortingStrategy}>
              {automations.map((automation, position) => (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  actions={actions}
                  timeZone={data.timeZone}
                  available={data.available}
                  showCost={showCost}
                  now={now}
                  position={position}
                  total={automations.length}
                  {...(reorder ? { reorder } : {})}
                />
              ))}
            </SortableContext>
          </tbody>
        </table>
      </Card>
    </DndContext>
  )
}

function AutomationRow({
  automation,
  actions,
  timeZone,
  available,
  showCost,
  now,
  position,
  total,
  reorder,
}: {
  automation: AutomationListEntry
  actions: AutomationActions
  timeZone: string
  /** The forge's availability — a GitHub row is "paused by capability" without it. */
  available: boolean
  showCost: boolean
  now: number
  position: number
  total: number
  reorder?: Reorder
}) {
  const navigate = useNavigate()
  const sortable = useSortable({ id: automation.id, disabled: !reorder?.enabled })
  const github = automation.kind === 'github'
  const state = automationState(automation, available)
  const dispatch = automation.task.dispatch
  const trigger = triggerLabel(automation)
  const runAs = [automation.task.workflow, automation.task.runner].filter(Boolean)
  const lastRun = automation.lastRun ? runAttention(automation.lastRun.status) : undefined
  const stop = (event: SyntheticEvent) => event.stopPropagation()

  return (
    <tr
      ref={sortable.setNodeRef}
      style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition }}
      data-slot="automation-row"
      data-automation={automation.id}
      data-enabled={automation.enabled ? 'true' : 'false'}
      className={cn('group/row cursor-pointer hover:bg-muted', !automation.enabled && 'opacity-60')}
      onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
    >
      {reorder ? (
        <td className={cn(TD, 'w-px')} onClick={stop}>
          <span className="inline-flex items-center gap-0.5">
            <Button
              variant="ghost" size="icon-sm" className="touch-none cursor-grab"
              ref={sortable.setActivatorNodeRef}
              {...sortable.attributes} {...sortable.listeners}
              aria-label={`Reorder ${automation.name}`}
              disabled={!reorder.enabled}
            ><GripVerticalIcon className="size-3.5" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Move ${automation.name} up`}
              disabled={!reorder.enabled || position === 0} onClick={() => reorder.onMove(position, position - 1)}
            ><ArrowUpIcon className="size-3.5" /></Button>
            <Button variant="ghost" size="icon-sm" aria-label={`Move ${automation.name} down`}
              disabled={!reorder.enabled || position === total - 1} onClick={() => reorder.onMove(position, position + 1)}
            ><ArrowDownIcon className="size-3.5" /></Button>
          </span>
        </td>
      ) : null}
      <td className={cn(TD, 'pl-4')}>
        <Pill dot={state.tone} pulse={state.pulse}>{state.label}</Pill>
      </td>
      <td className={cn(TD, 'max-w-0 min-w-[200px]')}>
        <span className="flex min-w-0 items-center gap-2">
          {github ? <GithubIcon className="size-3.5 shrink-0 text-soft-foreground" /> : automation.kind === 'tracker' ? <ZapIcon className="size-3.5 shrink-0 text-soft-foreground" /> : <Clock3Icon className="size-3.5 shrink-0 text-soft-foreground" />}
          <span className="overflow-hidden text-ui font-medium text-ellipsis whitespace-nowrap">{automation.name}</span>
          {dispatch ? (
            <IconTooltip label={`Dispatch · up to ${dispatch.maxSubtasks ?? 1} subtasks`}>
              <span
                data-slot="dispatch-badge"
                aria-label={`dispatch · up to ${dispatch.maxSubtasks ?? 1} subtasks`}
                className="inline-flex shrink-0 items-center gap-[3px] rounded-full bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground"
              >
                <GitForkIcon className="size-2.5" />×{dispatch.maxSubtasks ?? 1}
              </span>
            </IconTooltip>
          ) : null}
          {automation.kind === 'tracker' && automation.trackerTrigger && !automation.trackerTrigger.access ? (
            // Pre-mediation tracker automations stop polling until their access is reviewed —
            // a person is needed, so it wears the grammar's blue.
            <IconTooltip label="Tracker access changed — open this automation and review its access">
              <span
                data-slot="needs-review-badge"
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-1.5 py-px text-micro font-medium text-muted-foreground"
              >
                <StatusDot tone="info" />
                Needs review
              </span>
            </IconTooltip>
          ) : null}
        </span>
      </td>
      <td data-slot="trigger" className={cn(TD, 'max-w-[320px] overflow-hidden text-label text-ellipsis text-muted-foreground')} title={trigger}>
        {trigger}
      </td>
      <td className={cn(TD, WIDE, 'text-label text-muted-foreground')}>
        {runAs.length ? (
          <span className="inline-flex items-center gap-1.5">
            {runAs.map((part, index) => (
              <span key={part} className="contents">
                {index > 0 ? <span className="text-soft-foreground">·</span> : null}
                {part}
              </span>
            ))}
            {automation.task.autonomous ? (
              <>
                <span className="text-soft-foreground">·</span>
                <IconTooltip label="Autonomous">
                  <span aria-label="autonomous" data-slot="autonomous-mark" className="inline-flex">
                    <ZapIcon aria-hidden="true" className="size-[11px] text-soft-foreground" />
                  </span>
                </IconTooltip>
              </>
            ) : null}
          </span>
        ) : (
          DASH
        )}
      </td>
      <td
        data-slot="next-run"
        className={cn(TD, 'tabular-nums', automation.enabled ? 'text-foreground' : 'text-soft-foreground')}
      >
        {nextRunText(automation, timeZone, now)}
      </td>
      <td className={TD}>
        {automation.lastRun && lastRun ? (
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={lastRun.tone} pulse={lastRun.pulse} />
            <span className="text-label text-muted-foreground">{lastRun.label}</span>
            <span className="text-label text-soft-foreground">{shortAge(automation.lastRun.ts, now)}</span>
            <Link
              to={`/tasks/${encodeURIComponent(automation.lastRun.runId)}`}
              data-slot="task-link"
              onClick={stop}
              className="inline-flex items-center gap-0.5 rounded-full border border-violet/40 px-1.5 py-px text-micro font-semibold text-violet"
            >
              task
              <ArrowUpRightIcon className="size-[9px]" />
            </Link>
          </span>
        ) : (
          DASH
        )}
      </td>
      <td className={cn(TD, WIDE, 'text-right text-label text-muted-foreground tabular-nums')}>{automation.runs7d}</td>
      {showCost ? (
        <td className={cn(TD, WIDE, 'text-right text-label text-muted-foreground tabular-nums')}>
          {automation.costUsd7d !== undefined ? usd(automation.costUsd7d) : DASH}
        </td>
      ) : null}
      {/* Row icons on hover, focus or an open menu (the tasks table's grammar); always on a
          device that cannot hover. */}
      <td className={cn(TD, 'pr-3 text-right', 'opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-within/row:opacity-100 has-[[data-state=open]]:opacity-100 no-hover:opacity-100')}>
        <RowActions automation={automation} actions={actions} />
      </td>
    </tr>
  )
}

/** `continuous` for a poll; the next instant (server-reported, else computed) for a schedule; `—` paused. */
function nextRunText(automation: AutomationListEntry, timeZone: string, now: number): string {
  if (!automation.enabled) return '—'
  if (automation.kind !== 'schedule') return 'continuous'
  const next = nextAutomationRun(automation, timeZone, now)
  return next === null ? '—' : dayTime(next, timeZone) || '—'
}
