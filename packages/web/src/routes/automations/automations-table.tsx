import { ArrowUpRightIcon, Clock3Icon, GitForkIcon, ZapIcon } from 'lucide-react'
import type { SyntheticEvent } from 'react'
import { nextOccurrence, type AutomationListEntry, type AutomationsResponse } from '@open-mercato/cezar-api-client'

import { GithubIcon } from '@/components/icons'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { Card } from '@/components/ui/card'
import { dayTime, statusLabel, statusTone, triggerLabel, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'
import { Link, useNavigate } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { RowActions } from './row-actions'
import type { AutomationActions } from './use-automations'

/**
 * The Automations table (spec 2026-09-14-automations-redesign § UI/UX 1): nine columns, a row
 * per definition, the row itself the way into the editor. Costs are a column only when the
 * server reports them at all; the "Runs as", "Runs 7d" and "Cost 7d" columns give way under
 * 1280px (`.cz-auto-wide`) so the table keeps its shape on a laptop.
 */

const TH = 'h-[38px] border-b border-border px-[10px] text-left text-[11px] leading-none font-semibold tracking-[.05em] whitespace-nowrap text-soft-foreground uppercase'
const TD = 'h-12 border-b border-border px-[10px] text-[13px] leading-none whitespace-nowrap'
const WIDE = 'cz-auto-wide max-[1280px]:hidden'
const DASH = <span className="text-xs text-soft-foreground">—</span>

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
    <Card flush data-slot="automations-table" className="min-w-0 overflow-x-auto">
      <table className="w-full border-collapse [&_tbody_tr:last-child>td]:border-b-0">
        <thead>
          <tr>
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
        </tbody>
      </table>
    </Card>
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

  return (
    <tr
      data-slot="automation-row"
      data-automation={automation.id}
      data-enabled={automation.enabled ? 'true' : 'false'}
      className={cn('cursor-pointer hover:bg-muted', !automation.enabled && 'opacity-60')}
      onClick={() => navigate(`/automations/${encodeURIComponent(automation.id)}`)}
    >
      <td className={cn(TD, 'pl-4')}>
        {capabilityPaused ? (
          <Pill dot="neutral">paused by capability</Pill>
        ) : (
          <Pill dot={automation.enabled ? 'success' : 'neutral'} pulse={automation.enabled && github}>
            {automation.enabled ? 'enabled' : 'paused'}
          </Pill>
        )}
      </td>
      <td className={cn(TD, 'max-w-0 min-w-[200px]')}>
        <span className="flex min-w-0 items-center gap-2">
          {github ? <GithubIcon className="size-3.5 shrink-0 text-soft-foreground" /> : <Clock3Icon className="size-3.5 shrink-0 text-soft-foreground" />}
          <span className="overflow-hidden text-[13px] font-medium text-ellipsis whitespace-nowrap">{automation.name}</span>
          {dispatch ? (
            <span
              data-slot="dispatch-badge"
              title={`dispatch · up to ${dispatch.maxSubtasks ?? 1} subtasks`}
              className="inline-flex shrink-0 items-center gap-[3px] rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground"
            >
              <GitForkIcon className="size-2.5" />×{dispatch.maxSubtasks ?? 1}
            </span>
          ) : null}
        </span>
      </td>
      <td className={cn(TD, 'max-w-[260px] overflow-hidden font-mono text-xs text-ellipsis text-muted-foreground')} title={trigger}>
        {trigger}
      </td>
      <td className={cn(TD, WIDE, 'text-xs text-muted-foreground')}>
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
                <span title="autonomous" data-slot="autonomous-mark" className="inline-flex">
                  <ZapIcon aria-hidden="true" className="size-[11px] text-soft-foreground" />
                </span>
              </>
            ) : null}
          </span>
        ) : (
          DASH
        )}
      </td>
      <td
        data-slot="next-run"
        className={cn(TD, 'font-mono text-xs tabular-nums', automation.enabled ? 'text-foreground' : 'text-soft-foreground')}
      >
        {nextRunText(automation, timeZone, now)}
      </td>
      <td className={TD}>
        {automation.lastRun ? (
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={statusTone(automation.lastRun.status)} />
            <span className="text-[12.5px] text-muted-foreground">{statusLabel(automation.lastRun.status)}</span>
            <span className="text-[11.5px] text-soft-foreground">{shortAge(automation.lastRun.ts, now)}</span>
            <Link
              to={`/tasks/${encodeURIComponent(automation.lastRun.runId)}`}
              data-slot="task-link"
              onClick={stop}
              className="inline-flex items-center gap-0.5 rounded-full border border-violet/40 px-1.5 py-px font-mono text-[10.5px] font-semibold text-violet"
            >
              task
              <ArrowUpRightIcon className="size-[9px]" />
            </Link>
          </span>
        ) : (
          DASH
        )}
      </td>
      <td className={cn(TD, WIDE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}>{automation.runs7d}</td>
      {showCost ? (
        <td className={cn(TD, WIDE, 'text-right font-mono text-xs text-muted-foreground tabular-nums')}>
          {automation.costUsd7d !== undefined ? usd(automation.costUsd7d) : DASH}
        </td>
      ) : null}
      <td className={cn(TD, 'pr-3 text-right')}>
        <RowActions automation={automation} actions={actions} />
      </td>
    </tr>
  )
}

/** `continuous` for a poll; the next instant (server-reported, else computed) for a schedule; `—` paused. */
function nextRunText(automation: AutomationListEntry, timeZone: string, now: number): string {
  if (!automation.enabled) return '—'
  if (automation.kind === 'github') return 'continuous'
  if (automation.nextRunAt) return dayTime(automation.nextRunAt, timeZone) || '—'
  const next = automation.schedule ? nextOccurrence(automation.schedule, now, timeZone) : null
  return next === null ? '—' : dayTime(next, timeZone) || '—'
}
