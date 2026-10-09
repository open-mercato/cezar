import { ArrowUpRightIcon, Clock3Icon, GitForkIcon, TicketIcon, ZapIcon } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { nextOccurrence, type AutomationListEntry, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { dayTime, statusLabel, statusTone, triggerLabel, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { RowActions } from './row-actions'
import type { AutomationActions } from './use-automations'

/**
 * The Automations table (spec 2026-09-14-automations-redesign § UI/UX 1): a row per definition,
 * the row itself the way into the editor. Six columns — name, trigger, next run, last result,
 * the enabled switch, the actions menu; what it runs as and the week's run count (and cost, when
 * the server reports one) sit on the name's quiet second line instead of columns of their own.
 */

const TH = 'h-10 text-xs font-medium text-muted-foreground'
const DASH = <span className="text-muted-foreground">—</span>

export function AutomationsTable({
  data,
  actions,
  now = Date.now(),
}: {
  data: AutomationsResponse
  actions: AutomationActions
  now?: number
}) {
  const showCost = AUTOMATION_COST_VISIBLE && (data.stats.costUsd !== undefined || data.automations.some((automation) => automation.costUsd7d !== undefined))
  return (
    <div data-slot="automations-table" className="min-w-0 overflow-hidden rounded-xl border bg-card shadow-xs">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className={cn(TH, 'pl-4')}>Automation</TableHead>
            <TableHead className={cn(TH, 'max-md:hidden')}>Trigger</TableHead>
            <TableHead className={TH}>Next run</TableHead>
            <TableHead className={cn(TH, 'max-sm:hidden')}>Last result</TableHead>
            <TableHead className={TH}>Enabled</TableHead>
            <TableHead className={cn(TH, 'w-12 pr-3')}>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.automations.map((automation) => (
            <AutomationRow
              key={automation.id}
              automation={automation}
              actions={actions}
              timeZone={data.timeZone}
              available={data.available}
              showCost={showCost}
              now={now}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function AutomationRow({
  automation,
  actions,
  timeZone,
  available,
  showCost,
  now,
}: {
  automation: AutomationListEntry
  actions: AutomationActions
  timeZone: string
  /** The forge's availability — a GitHub row is "paused by capability" without it. */
  available: boolean
  showCost: boolean
  now: number
}) {
  const navigate = useNavigate()
  const github = automation.kind === 'github'
  const capabilityPaused = github && !available
  const dispatch = automation.task.dispatch
  const trigger = triggerLabel(automation)
  const runAs = [automation.task.workflow, automation.task.runner].filter(Boolean)
  const stop = (event: SyntheticEvent) => event.stopPropagation()
  const KindIcon = github ? GithubIcon : automation.kind === 'tracker' ? TicketIcon : Clock3Icon
  const details = [
    ...runAs,
    `${automation.runs7d} ${automation.runs7d === 1 ? 'run' : 'runs'} this week`,
    ...(showCost && automation.costUsd7d !== undefined ? [usd(automation.costUsd7d)] : []),
  ]

  return (
    <TableRow
      data-slot="automation-row"
      data-automation={automation.id}
      data-enabled={automation.enabled ? 'true' : 'false'}
      className="cursor-pointer hover:bg-muted/50"
      onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
    >
      <TableCell className="max-w-0 min-w-[220px] py-2.5 pl-4">
        <div className={cn('flex min-w-0 items-start gap-3', !automation.enabled && 'opacity-60')}>
          <KindIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[13.5px] font-medium text-foreground">{automation.name}</span>
              {dispatch ? (
                <Badge
                  variant="secondary"
                  data-slot="dispatch-badge"
                  title={`dispatch · up to ${dispatch.maxSubtasks ?? 1} subtasks`}
                  className="gap-0.5 px-1.5 py-0 font-normal tabular-nums"
                >
                  <GitForkIcon aria-hidden="true" />×{dispatch.maxSubtasks ?? 1}
                </Badge>
              ) : null}
              {automation.task.autonomous ? (
                <span title="autonomous" data-slot="autonomous-mark" className="inline-flex shrink-0">
                  <ZapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                </span>
              ) : null}
            </div>
            <div data-slot="automation-details" className="truncate text-xs text-muted-foreground tabular-nums">
              {details.join(' · ')}
            </div>
          </div>
        </div>
      </TableCell>
      <TableCell className="max-w-[280px] truncate text-[13px] text-muted-foreground max-md:hidden" title={trigger}>
        {trigger}
      </TableCell>
      <TableCell
        data-slot="next-run"
        className={cn('text-[13px] whitespace-nowrap tabular-nums', automation.enabled ? 'text-foreground' : 'text-muted-foreground')}
      >
        {nextRunText(automation, timeZone, now)}
      </TableCell>
      <TableCell className="max-sm:hidden">
        {automation.lastRun ? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <Badge asChild variant="outline" className="gap-1.5 font-normal">
              <Link
                to={`/tasks/${encodeURIComponent(automation.lastRun.runId)}`}
                data-slot="task-link"
                title="Open the task"
                onClick={stop}
              >
                <StatusDot tone={statusTone(automation.lastRun.status)} />
                {statusLabel(automation.lastRun.status)}
                <ArrowUpRightIcon aria-hidden="true" className="text-muted-foreground" />
              </Link>
            </Badge>
            <span className="text-xs text-muted-foreground tabular-nums">{shortAge(automation.lastRun.ts, now)}</span>
          </span>
        ) : (
          DASH
        )}
      </TableCell>
      <TableCell onClick={stop}>
        <span className="inline-flex items-center gap-2">
          <Switch
            checked={automation.enabled}
            disabled={actions.busy}
            aria-label={automation.enabled ? `Pause ${automation.name}` : `Enable ${automation.name}`}
            title={automation.enabled ? 'Pause' : 'Enable'}
            onCheckedChange={() => void actions.toggleEnabled(automation)}
          />
          {capabilityPaused ? (
            <span data-slot="capability-paused" className="text-xs whitespace-nowrap text-muted-foreground max-xl:hidden">
              paused by capability
            </span>
          ) : null}
        </span>
      </TableCell>
      <TableCell className="pr-3 text-right">
        <RowActions automation={automation} actions={actions} />
      </TableCell>
    </TableRow>
  )
}

/** `continuous` for a poll; the next instant (server-reported, else computed) for a schedule; `—` paused. */
function nextRunText(automation: AutomationListEntry, timeZone: string, now: number): string {
  if (!automation.enabled) return '—'
  if (automation.kind !== 'schedule') return 'Continuous'
  if (automation.nextRunAt) return dayTime(automation.nextRunAt, timeZone) || '—'
  const next = automation.schedule ? nextOccurrence(automation.schedule, now, timeZone) : null
  return next === null ? '—' : dayTime(next, timeZone) || '—'
}
