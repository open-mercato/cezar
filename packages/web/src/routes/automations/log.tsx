import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, ArrowUpRightIcon, PencilIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { getAutomationLog, retryAutomationReceipt } from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { Pill } from '@/components/pill'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { toast } from '@/components/ui/toaster'
import { logTime, resultTone, statusTone, usd, AUTOMATION_COST_VISIBLE } from '@/lib/automation-format'
import { Link, useNavigate } from '@/lib/project-router'
import {
  queryScope,
  type AutomationEvent,
  type AutomationListEntry,
  type AutomationLogRecord,
  type AutomationLogResult,
  type AutomationLogRun,
} from '@open-mercato/cezar-api-client'

import { PageState } from './automations-route'

/**
 * `/automations/:id/log` — one automation's execution log (spec 2026-09-14-automations-redesign
 * § UI/UX 5, kit `AutomationLogView`). Newest first, the server's 100-row cap; every stamp is in
 * the SERVER's zone, the one the schedule fires in. A launched row links to its task and, when
 * the run dispatched children, lists them indented under it with each child's cost beside it.
 *
 * The result/event filters narrow the loaded rows client-side: the query key stays one per
 * automation, so a filter flip never costs a request and the `automation-change` invalidation
 * has exactly one entry to refresh.
 */
export function AutomationLog({ automationId, automation, timeZone, onBack }: {
  automationId: string
  automation?: AutomationListEntry
  timeZone?: string
  onBack: () => void
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const scope = queryScope()
  const queryKey = useMemo(() => [scope, 'automation-log', automationId] as const, [scope, automationId])
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAutomationLog(automationId, { signal }),
  })
  const [result, setResult] = useState<AutomationLogResult | 'all'>('all')
  const [event, setEvent] = useState<AutomationEvent | 'all'>('all')

  // A fire, a retry or a pause from anywhere (the scheduler, the CLI, another tab) lands as a
  // workspace event; the log is authoritative on disk, so refetch rather than patch.
  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { automationId?: unknown }
    if (changed.automationId === automationId) void queryClient.invalidateQueries({ queryKey })
  }), [automationId, queryClient, queryKey])

  const retry = useMutation({
    mutationFn: (receiptId: string) => retryAutomationReceipt(receiptId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
    onError: (error) => toast(error instanceof Error ? error.message : String(error), { tone: 'danger' }),
  })

  const zone = timeZone ?? 'UTC'
  const records = query.data?.records.filter((record) =>
    (result === 'all' || record.result === result) && (event === 'all' || record.event === event))

  return (
    <div data-route="automations" data-slot="automation-log" className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5">
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={onBack}>
          <ArrowLeftIcon className="size-[15px]" />
        </Button>
        <h1 className="m-0 text-base font-semibold">{automation ? automation.name : 'Automation'}</h1>
        <span className="text-[13px] text-muted-foreground">· execution log</span>
        <div className="flex flex-1 items-center justify-end gap-2">
          <Select value={result} onValueChange={(next) => setResult(next as AutomationLogResult | 'all')}>
            <SelectTrigger size="sm" aria-label="Filter by result" className="text-[12.5px]">
              <SelectValue placeholder="All results" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All results</SelectItem>
              {RESULTS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={event} onValueChange={(next) => setEvent(next as AutomationEvent | 'all')}>
            <SelectTrigger size="sm" aria-label="Filter by event" className="text-[12.5px]">
              <SelectValue placeholder="All events" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {EVENTS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={() => navigate(`/automations/${encodeURIComponent(automationId)}`)}>
          <PencilIcon className="size-[13px]" />
          Edit
        </Button>
      </header>

      <div className="flex justify-center p-5">
        {query.isError ? (
          <div className="w-full max-w-[820px]"><PageState text={query.error instanceof Error ? query.error.message : String(query.error)} /></div>
        ) : records === undefined ? (
          <div className="w-full max-w-[820px]"><PageState text="Loading execution log…" /></div>
        ) : records.length === 0 ? (
          <div className="w-full max-w-[820px]"><PageState text="No checks have run yet." /></div>
        ) : (
          <Card flush className="w-full max-w-[820px]">
            {records.map((record, index) => (
              <LogRow
                key={record.seq}
                record={record}
                run={record.runId === undefined ? undefined : query.data?.runs[record.runId]}
                last={index === records.length - 1}
                timeZone={zone}
                retrying={retry.isPending && retry.variables === record.receiptId}
                onRetry={(receiptId) => retry.mutate(receiptId)}
              />
            ))}
          </Card>
        )}
      </div>
    </div>
  )
}

/** Every result the log can hold, in the contract's order — the filter's menu. */
const RESULTS: readonly AutomationLogResult[] = [
  'launched', 'no-match', 'duplicate', 'rate-limited', 'error', 'baseline', 'preview',
  'manual', 'catch-up', 'skipped', 'failed',
]

/** The four bounded polls a GitHub automation can watch. */
const EVENTS: readonly AutomationEvent[] = [
  'pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled',
]

/** The receipt of a `failed` row that never got a run: the launch itself threw, and the server's
 *  retry route accepts exactly that receipt (`launch-error`, no `runId`). Undefined otherwise. */
function launchErrorReceipt(record: AutomationLogRecord): string | undefined {
  return record.result === 'failed' && record.runId === undefined ? record.receiptId : undefined
}

/** One log row — kit values 1:1: grid `90px 110px 1fr auto auto`, `12px 16px`, 13px, gaps 8/12. */
function LogRow({ record, run, last, timeZone, retrying, onRetry }: {
  record: AutomationLogRecord
  run: AutomationLogRun | undefined
  last: boolean
  timeZone: string
  retrying: boolean
  onRetry: (receiptId: string) => void
}) {
  const tone = resultTone(record.result)
  const children = run?.children ?? []
  const retryable = launchErrorReceipt(record)
  return (
    <div
      data-slot="log-row"
      data-result={record.result}
      className={`grid ${AUTOMATION_COST_VISIBLE ? 'grid-cols-[90px_110px_1fr_auto_auto]' : 'grid-cols-[90px_110px_1fr_auto]'} items-center gap-x-3 gap-y-2 px-4 py-3 text-[13px] ${last ? '' : 'border-b border-border'}`}
    >
      <span className="font-mono text-xs font-medium text-muted-foreground tabular-nums">{logTime(record.ts, timeZone)}</span>
      <Pill dot={tone} className="w-fit">{record.result}</Pill>
      <span className={`overflow-hidden text-ellipsis whitespace-nowrap ${tone === 'danger' ? 'text-danger' : 'text-muted-foreground'}`} title={record.reason}>
        {record.reason ?? ''}
      </span>
      {AUTOMATION_COST_VISIBLE ? <span className="font-mono text-xs text-soft-foreground">{run?.costUsd === undefined ? '—' : usd(run.costUsd)}</span> : null}
      {record.runId !== undefined ? (
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/tasks/${encodeURIComponent(record.runId)}`}>
            Open task
            <ArrowUpRightIcon className="size-3" />
          </Link>
        </Button>
      ) : retryable !== undefined ? (
        <Button variant="ghost" size="sm" disabled={retrying} onClick={() => onRetry(retryable)}>
          <RotateCcwIcon className="size-3" />
          Retry task
        </Button>
      ) : (
        <span />
      )}
      {children.length > 0 ? (
        <div className="col-span-full flex flex-col gap-1 pl-3.5">
          {children.map((child) => (
            <div key={child.runId} data-slot="log-child" className={`grid ${AUTOMATION_COST_VISIBLE ? 'grid-cols-[14px_70px_1fr_auto_auto]' : 'grid-cols-[14px_70px_1fr_auto]'} items-center gap-2.5 text-[12.5px]`}>
              <span className="font-mono text-[11px] text-soft-foreground">└</span>
              <span className="w-fit rounded-full bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">{child.kind ?? 'implement'}</span>
              <span className="flex min-w-0 items-center gap-2">
                <StatusDot tone={statusTone(child.status)} />
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{child.title}</span>
              </span>
              {AUTOMATION_COST_VISIBLE ? <span className="font-mono text-[11.5px] text-soft-foreground">{child.costUsd === undefined ? '—' : usd(child.costUsd)}</span> : null}
              <Button variant="ghost" size="sm" className="h-6" asChild>
                <Link to={`/tasks/${encodeURIComponent(child.runId)}`}>
                  Open
                  <ArrowUpRightIcon className="size-[11px]" />
                </Link>
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
