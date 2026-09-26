import { ExportRows } from './export-rows'
import { useContext } from 'react'
import { DashboardReconciledContext } from './state'
import { useDashboardTruth } from '@/api/dashboard-truth'
import { Link } from 'react-router'
import type { DashboardTaskRow, DashboardCoverage } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { ReferenceChip } from '@/components/reference-chip'
import { deriveAttention } from '@/lib/attention'
import { taskReferences } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'
import { Button } from '@/components/ui/button'
export const taskKey = (row: DashboardTaskRow) => `${row.projectId}:${row.id}`
export function TaskRow({
  row,
  removed = false,
  queue = false,
  checking = false,
  checkFailed = false,
}: {
  checking?: boolean
  checkFailed?: boolean
  row: DashboardTaskRow
  removed?: boolean
  queue?: boolean
}) {
  const reconciled = useContext(DashboardReconciledContext) && !checking && !checkFailed
  const truth = useDashboardTruth(row)
  removed = removed || truth === null || (queue && truth?.archived === true)
  if (truth) row = { ...row, status: truth.status }
  const attention = deriveAttention(row)
  const obsolete = queue && !['waiting', 'review'].includes(row.status)
  const inactive = removed || obsolete || !reconciled
  return (
    <div data-dashboard-row={taskKey(row)} className="min-w-0 border-b px-4 py-3 last:border-0">
      <ExportRows
        rows={[
          {
            section: 'task',
            entity: taskKey(row),
            metric: 'title',
            value: row.titleSummary || row.title,
          },
          {
            section: 'task',
            entity: taskKey(row),
            metric: 'status',
            value: inactive ? 'Not currently actionable' : row.status,
          },
          { section: 'task', entity: taskKey(row), metric: 'createdAt', value: row.createdAt },
        ]}
      />
      <div className="flex items-start gap-2">
        <StatusDot tone={attention.tone} className="mt-2" />
        <div className="min-w-0 flex-1">
          <Link
            tabIndex={inactive ? -1 : undefined}
            aria-disabled={inactive || undefined}
            onClick={(e) => {
              if (inactive) e.preventDefault()
            }}
            to={`/p/${encodeURIComponent(row.projectId)}/tasks/${encodeURIComponent(row.id)}`}
            className="block min-h-11 break-words text-sm font-medium leading-relaxed hover:underline"
          >
            {row.titleSummary || row.title}
          </Link>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{row.projectId}</span>
            <span>
              {checkFailed
                ? 'Could not check current state'
                : !reconciled
                  ? 'Checking current state…'
                  : removed
                    ? queue && truth !== null
                      ? 'No longer needs you'
                      : 'Task removed'
                    : obsolete
                      ? 'No longer needs you'
                      : attention.label}
            </span>
            <span>{shortAge(row.createdAt)}</span>
            {row.dispatch && <span>Subtask</span>}
            {!inactive &&
              taskReferences(row).map((ref) => (
                <ReferenceChip
                  key={`${ref.kind}:${ref.number}`}
                  reference={ref}
                  taskTitle={row.title}
                  projectId={row.projectId}
                  className="min-h-11"
                />
              ))}
          </div>
        </div>
      </div>
    </div>
  )
}
export function Coverage({
  coverage,
  count,
  retry,
}: {
  coverage: DashboardCoverage
  count?: number
  retry: () => void
}) {
  const unavailable = coverage.projects.filter((p) => p.state !== 'complete')
  if (!unavailable.length) return null
  return (
    <div className="rounded-md border border-pending/40 bg-muted/40 p-3 text-sm" role="status">
      <p>
        {count !== undefined
          ? `${count} tasks need you in the available data. Complete coverage: ${coverage.projects.length - unavailable.length} of ${coverage.projects.length} projects. `
          : ''}
        {unavailable.length === 1
          ? unavailable[0]!.state === 'unavailable'
            ? 'One project is unavailable.'
            : 'One project has incomplete coverage.'
          : `${unavailable.length} projects have incomplete coverage.`}
      </p>
      <details className="mt-2">
        <summary className="min-h-11 cursor-pointer py-2">
          View unavailable {unavailable.length === 1 ? 'project' : 'projects'}
        </summary>
        {unavailable.map((p) => (
          <p key={p.projectId}>
            {p.projectId}: {p.reason ?? p.state}
            {p.omittedRuns > 0 ? ` · ${p.omittedRuns} omitted tasks` : ''}
          </p>
        ))}
      </details>
      <Button variant="outline" onClick={retry} className="min-h-11">
        Retry
      </Button>
    </div>
  )
}
