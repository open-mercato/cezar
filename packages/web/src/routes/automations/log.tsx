import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon, ArrowUpRightIcon, PencilIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { getAutomationLog, retryAutomationReceipt } from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { Page, PageBody, PageHeader, PageToolbar } from '@/components/page'
import { StatusDot } from '@/components/status-dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
    <Page data-route="automations" data-slot="automation-log">
      <PageHeader
        eyebrow={
          <Button variant="ghost" size="xs" className="-ml-2 font-normal" aria-label="Back" onClick={onBack}>
            <ArrowLeftIcon aria-hidden="true" />
            Automations
          </Button>
        }
        title={automation ? automation.name : 'Automation'}
        description="Execution log — the newest 100 checks, in the scheduler's time zone."
        actions={
          <Button variant="outline" onClick={() => navigate(`/automations/${encodeURIComponent(automationId)}`)}>
            <PencilIcon aria-hidden="true" />
            Edit
          </Button>
        }
      />
      <PageToolbar>
        <Select value={result} onValueChange={(next) => setResult(next as AutomationLogResult | 'all')}>
          <SelectTrigger size="sm" aria-label="Filter by result">
            <SelectValue placeholder="All results" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All results</SelectItem>
            {RESULTS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={event} onValueChange={(next) => setEvent(next as AutomationEvent | 'all')}>
          <SelectTrigger size="sm" aria-label="Filter by event">
            <SelectValue placeholder="All events" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {EVENTS.map((value) => <SelectItem key={value} value={value}>{value}</SelectItem>)}
          </SelectContent>
        </Select>
        {records && query.data ? (
          <span className="ml-auto text-[13px] text-muted-foreground tabular-nums">
            {records.length === query.data.records.length ? `${records.length} entries` : `${records.length} of ${query.data.records.length}`}
          </span>
        ) : null}
      </PageToolbar>

      <PageBody>
        {query.isError ? (
          <PageState text={query.error instanceof Error ? query.error.message : String(query.error)} />
        ) : records === undefined ? (
          <PageState text="Loading execution log…" loading />
        ) : records.length === 0 ? (
          <PageState text="No checks have run yet." />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-10 w-32 pl-4 text-xs font-medium text-muted-foreground">When</TableHead>
                  <TableHead className="h-10 w-36 text-xs font-medium text-muted-foreground">Result</TableHead>
                  <TableHead className="h-10 text-xs font-medium text-muted-foreground">Details</TableHead>
                  {AUTOMATION_COST_VISIBLE ? <TableHead className="h-10 text-right text-xs font-medium text-muted-foreground">Cost</TableHead> : null}
                  <TableHead className="h-10 w-32 pr-3"><span className="sr-only">Actions</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <LogRow
                    key={record.seq}
                    record={record}
                    run={record.runId === undefined ? undefined : query.data?.runs[record.runId]}
                    timeZone={zone}
                    retrying={retry.isPending && retry.variables === record.receiptId}
                    onRetry={(receiptId) => retry.mutate(receiptId)}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </PageBody>
    </Page>
  )
}

/** Every result the log can hold, in the contract's order — the filter's menu. */
const RESULTS: readonly AutomationLogResult[] = [
  'launched', 'no-match', 'duplicate', 'rate-limited', 'error', 'baseline', 'preview',
  'manual', 'catch-up', 'skipped', 'failed',
]

/** The seven bounded polls a GitHub automation can watch. */
const EVENTS: readonly AutomationEvent[] = [
  'pull_request.opened', 'issue.opened', 'issue.labeled', 'issue.unlabeled',
  'pull_request.reviewed', 'pull_request.review_requested', 'pull_request.rereview_requested',
]

/** The receipt of a `failed` row that never got a run: the launch itself threw, and the server's
 *  retry route accepts exactly that receipt (`launch-error`, no `runId`). Undefined otherwise. */
function launchErrorReceipt(record: AutomationLogRecord): string | undefined {
  return record.result === 'failed' && record.runId === undefined ? record.receiptId : undefined
}

/** One log entry: a table row, plus one indented row per dispatched child task. */
function LogRow({ record, run, timeZone, retrying, onRetry }: {
  record: AutomationLogRecord
  run: AutomationLogRun | undefined
  timeZone: string
  retrying: boolean
  onRetry: (receiptId: string) => void
}) {
  const tone = resultTone(record.result)
  const children = run?.children ?? []
  const retryable = launchErrorReceipt(record)
  return (
    <>
      <TableRow data-slot="log-row" data-result={record.result} className={`h-11 hover:bg-muted/50 ${children.length > 0 ? 'border-b-0' : ''}`}>
        <TableCell className="pl-4 text-[13px] whitespace-nowrap text-muted-foreground tabular-nums">{logTime(record.ts, timeZone)}</TableCell>
        <TableCell>
          <Badge variant="outline" className="gap-1.5 font-normal">
            <StatusDot tone={tone} />
            {record.result}
          </Badge>
        </TableCell>
        <TableCell className={`max-w-0 truncate text-[13px] ${tone === 'danger' ? 'text-danger' : 'text-muted-foreground'}`} title={record.reason}>
          {record.reason ?? ''}
        </TableCell>
        {AUTOMATION_COST_VISIBLE ? <TableCell className="text-right text-[13px] text-muted-foreground tabular-nums">{run?.costUsd === undefined ? '—' : usd(run.costUsd)}</TableCell> : null}
        <TableCell className="pr-3 text-right">
          {record.runId !== undefined ? (
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/tasks/${encodeURIComponent(record.runId)}`}>
                Open task
                <ArrowUpRightIcon aria-hidden="true" />
              </Link>
            </Button>
          ) : retryable !== undefined ? (
            <Button variant="ghost" size="sm" disabled={retrying} onClick={() => onRetry(retryable)}>
              <RotateCcwIcon aria-hidden="true" />
              Retry task
            </Button>
          ) : null}
        </TableCell>
      </TableRow>
      {children.map((child, index) => (
        <TableRow key={child.runId} data-slot="log-child" className={`h-10 hover:bg-muted/50 ${index < children.length - 1 ? 'border-b-0' : ''}`}>
          <TableCell />
          <TableCell>
            <Badge variant="secondary" className="font-normal">{child.kind ?? 'implement'}</Badge>
          </TableCell>
          <TableCell className="max-w-0">
            <span className="flex min-w-0 items-center gap-2 text-[13px]">
              <StatusDot tone={statusTone(child.status)} />
              <span className="truncate">{child.title}</span>
            </span>
          </TableCell>
          {AUTOMATION_COST_VISIBLE ? <TableCell className="text-right text-[13px] text-muted-foreground tabular-nums">{child.costUsd === undefined ? '—' : usd(child.costUsd)}</TableCell> : null}
          <TableCell className="pr-3 text-right">
            <Button variant="ghost" size="sm" asChild>
              <Link to={`/tasks/${encodeURIComponent(child.runId)}`}>
                Open
                <ArrowUpRightIcon aria-hidden="true" />
              </Link>
            </Button>
          </TableCell>
        </TableRow>
      ))}
    </>
  )
}
