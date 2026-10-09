import { ExportRows } from './export-rows'
import { useContext } from 'react'
import { DashboardReconciledContext } from './state'
import { useDashboardTruth } from '@/api/dashboard-truth'
import { Link } from 'react-router'
import type { DashboardTaskRow, DashboardCoverage } from '@open-mercato/cezar-api-client'
import { StatusDot } from '@/components/status-dot'
import { ReferenceChip } from '@/components/reference-chip'
import { deriveAttention, isNeedsYouStatus } from '@/lib/attention'
import { taskReferences } from '@/lib/tasks-table'
import { shortAge } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { DisclosureChevron, disclosureSummary } from './presentation'
export const taskKey = (row: DashboardTaskRow) => `${row.projectId}:${row.id}`
export function TaskRow({
  row,
  removed = false,
  queue = false,
  checking = false,
  checkFailed = false,
  kicker,
}: {
  /** A one-line label above the title, inside the row (the feed's "Latest result: …"). */
  kicker?: string
  checking?: boolean
  checkFailed?: boolean
  row: DashboardTaskRow
  removed?: boolean
  queue?: boolean
}) {
  const reconciled = useContext(DashboardReconciledContext) && !checking && !checkFailed
  const truth = useDashboardTruth(row)
  removed = removed || truth === null || (queue && truth?.archived === true)
  if (truth) row = { ...row, status: truth.status, awaitingAnswerSince: truth.awaitingAnswerSince }
  const attention = deriveAttention(row)
  const obsolete = queue && !isNeedsYouStatus(row)
  const inactive = removed || obsolete || !reconciled
  return (
    <div
      data-dashboard-row={taskKey(row)}
      className="min-w-0 border-b border-border/70 px-5 py-3 transition-colors last:border-0 hover:bg-muted/50"
    >
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
      {kicker && (
        <p className="mb-0.5 pl-[15px] text-xs text-soft-foreground">
          {kicker}
        </p>
      )}
      <div className="flex items-start gap-2">
        <StatusDot tone={attention.tone} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <Link
            tabIndex={inactive ? -1 : undefined}
            aria-disabled={inactive || undefined}
            onClick={(e) => {
              if (inactive) e.preventDefault()
            }}
            to={`/p/${encodeURIComponent(row.projectId)}/tasks/${encodeURIComponent(row.id)}`}
            className="block break-words text-sm font-medium leading-relaxed underline-offset-4 hover:underline no-hover:min-h-11"
          >
            {row.titleSummary || row.title}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="font-mono text-[11px] text-soft-foreground">{row.projectId}</span>
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
                  className="no-hover:min-h-11"
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
    <div className="rounded-lg bg-pending/12 px-3 py-2.5 text-[13px]" role="status">
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
      <details className="mt-1.5">
        <summary className={`${disclosureSummary} py-1 no-hover:min-h-11`}>
          <DisclosureChevron />
          View unavailable {unavailable.length === 1 ? 'project' : 'projects'}
        </summary>
        {unavailable.map((p) => (
          <p key={p.projectId} className="pl-5 text-muted-foreground">
            {p.projectId}: {p.reason ?? p.state}
            {p.omittedRuns > 0 ? ` · ${p.omittedRuns} omitted tasks` : ''}
          </p>
        ))}
      </details>
      <Button variant="outline" size="sm" onClick={retry} className="mt-2">
        Retry
      </Button>
    </div>
  )
}
