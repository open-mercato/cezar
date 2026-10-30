import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PlayIcon, ScrollTextIcon } from 'lucide-react'
import { useEffect, useMemo } from 'react'

import { queryScope, type ApiRun, type AutomationLogRecord } from '@open-mercato/cezar-api-client'
import { getAutomationLog } from '@/api/client'
import { onWorkspaceEvent } from '@/api/global-events'
import { useRuns } from '@/api/queries'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { AUTOMATION_COST_VISIBLE, statusLabel, statusTone, usd } from '@/lib/automation-format'
import { shortAge } from '@/lib/format'
import { Link } from '@/lib/project-router'

/** The detail rail's last five launched tasks (#1623); checks and children stay in View log. */
export function RecentRunsCard({ automationId, onRunNow, onLog, busy = false, now }: {
  automationId: string
  onRunNow?: () => void
  onLog?: () => void
  busy?: boolean
  now?: number
}) {
  const queryClient = useQueryClient()
  const scope = queryScope()
  const queryKey = useMemo(() => [scope, 'automation-log', automationId] as const, [scope, automationId])
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => getAutomationLog(automationId, { signal }),
  })
  const records = useMemo(() => recentLaunches(query.data?.records ?? []), [query.data?.records])
  const selectRuns = useMemo(() => {
    const ids = new Set(records.map((record) => record.runId))
    return (runs: ApiRun[]) => runs.filter((run) => ids.has(run.id)).map(({ id, title, status, costUsd }) => ({ id, title, status, costUsd }))
  }, [records])
  // The shell already reads this cache; select only displayed metadata to avoid token repaints.
  const liveRuns = useRuns(selectRuns)

  useEffect(() => onWorkspaceEvent((name, payload) => {
    if (name !== 'automation-change') return
    const changed = payload as { automationId?: unknown; project?: unknown } | null
    if (changed?.automationId === automationId && (scope === 'default' || changed.project === undefined || changed.project === scope)) {
      void queryClient.invalidateQueries({ queryKey })
    }
  }), [automationId, scope, queryClient, queryKey])

  return (
    <Card flush data-slot="recent-runs-card" className="min-w-0 px-3.5 py-3">
      <h2 className="m-0 mb-2 text-[11px] font-semibold tracking-[.05em] uppercase text-soft-foreground">Recent runs</h2>
      {query.isPending ? <p role="status" className="m-0 text-xs text-muted-foreground">Loading recent runs…</p> : null}
      {query.isError ? (
        <div role="alert" className="text-xs text-muted-foreground">
          <p className="m-0">{query.data ? 'Could not refresh recent runs.' : 'Could not load recent runs.'}</p>
          <Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Retry</Button>
        </div>
      ) : null}
      {query.data && records.length === 0 ? <p className="m-0 text-xs text-muted-foreground">No runs launched yet.</p> : null}
      {records.length > 0 ? (
        <ul aria-label="Recent runs" className="m-0 list-none divide-y divide-border p-0">
          {records.map((record) => {
            const run = liveRuns.data?.find((item) => item.id === record.runId) ?? query.data?.runs[record.runId]
            const title = run?.title || `Task ${record.runId.slice(0, 8)}`
            return (
              <li key={record.runId} className="min-w-0 py-2 first:pt-0 last:pb-0">
                <Link to={`/tasks/${encodeURIComponent(record.runId)}`} title={title} className="block truncate rounded-sm text-[13px] font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2">
                  {title}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-muted-foreground">
                  <StatusDot aria-hidden="true" tone={run ? statusTone(run.status) : 'neutral'} />
                  <span>{run ? statusLabel(run.status) : 'Status unavailable'}</span>
                  <time dateTime={record.ts} title={record.ts}>{shortAge(record.ts, now)}</time>
                  {AUTOMATION_COST_VISIBLE && run?.costUsd !== undefined ? <span className="ml-auto font-mono">{usd(run.costUsd)}</span> : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : null}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {onRunNow ? <Button variant="outline" size="sm" disabled={busy} onClick={onRunNow}><PlayIcon aria-hidden="true" className="size-3" />Run now</Button> : null}
        {onLog ? <Button variant="ghost" size="sm" onClick={onLog}><ScrollTextIcon aria-hidden="true" className="size-3" />View log</Button> : null}
      </div>
    </Card>
  )
}

function recentLaunches(records: AutomationLogRecord[]): Array<AutomationLogRecord & { runId: string }> {
  const seen = new Set<string>()
  return [...records].sort((a, b) => b.seq - a.seq).filter((record): record is AutomationLogRecord & { runId: string } => {
    if (!record.runId || seen.has(record.runId)) return false
    seen.add(record.runId)
    return true
  }).slice(0, 5)
}
