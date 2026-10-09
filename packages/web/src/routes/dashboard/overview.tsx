import { useSheetState, useSheetPosition, newSheetSelection, useSheetTrigger } from './sheet-state'
import { useDashboardTruth } from '@/api/dashboard-truth'
import { InfoHint, MetricContent, metricSurface, metricTones, Notice, ReportNote, tableBody, tableCell, tableHead, tableHeader, tableHeaderRow, tableRow, WidgetEmpty, WidgetSkeleton, widgetHeader, widgetHeading, widgetMeta } from './presentation'
import { formatHours as hours } from './format'
import { CircleHelp, Activity, CheckCheck, CircleAlert, ChevronRight, FolderOpen, Inbox } from 'lucide-react'
import { useDashboardLive } from '@/api/dashboard-live'
import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { DashboardOverview, DashboardOverviewGroup } from '@open-mercato/cezar-api-client'
import { useDashboardOverview } from '@/api/dashboard-overview'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { useProjects } from '@/api/queries'
import { shortAge } from '@/lib/format'
import { deriveAttention, isNeedsYouStatus } from '@/lib/attention'
import { StatusDot } from '@/components/status-dot'
import { Coverage } from './rows'
import { ExportRows } from './export-rows'
import { OutcomeInsights } from './insights'
import { useDashboardFilter } from './url-filter'

const labels = {
  running: 'Running now',
  'needs-you': 'Needs you',
  completed: 'Completed',
  failed: 'Failed outcomes',
}
const metricIcons = {
  'needs-you': CircleHelp,
  running: Activity,
  completed: CheckCheck,
  failed: CircleAlert,
}
const metricDefinitions =
  'Outcomes use finish dates, including archived tasks. Scheduled retries are excluded from failed outcomes. Period includes today at your current fixed UTC offset.'
const portfolioDefinition =
  'Current workload and outcomes for the selected period. Sorted by tasks needing you, then running tasks. Counts include subtasks.'
type Selection = {
  identity: number
  snapshot: DashboardOverview
  group: DashboardOverviewGroup
  projectId?: string
}

export function Overview({
  active,
  children,
  onCurrent,
}: {
  active: boolean
  onCurrent?: (group: 'running' | 'needs-you', target: HTMLElement) => void
  children: (modules: { overview?: ReactNode; portfolio?: ReactNode }) => ReactNode
}) {
  // The period control lives in the page header (index.tsx); both read the same URL key.
  const [period] = useDashboardFilter('period', ['7d', '30d'] as const, '7d')
  const trigger = useSheetTrigger('outcome', '[data-outcome-trigger]')
  const projects = useProjects().data?.projects
  const projectName = (id: string) => projects?.find((p) => p.id === id)?.name ?? id
  const query = useDashboardOverview({ period }, active)
  const [selection, setSelection] = useSheetState<Selection | null>('outcome:selection', null)
  const sheetPosition = useSheetPosition(`outcome:${selection?.identity ?? 'closed'}`)
  const live = useDashboardLive()
  // Leaving the view unmounts the Sheet below without closing it; clear the
  // selection so returning to Overview never reopens it against a stale snapshot.
  useEffect(() => {
    if (!active) setSelection(null)
  }, [active])
  // A sheet opened for one period must not survive a switch to the other.
  const shownPeriod = useRef(period)
  useEffect(() => {
    if (shownPeriod.current === period) return
    shownPeriod.current = period
    setSelection(null)
  }, [period])
  if (!active) return children({})
  const data = query.data
  const open = (group: DashboardOverviewGroup, projectId?: string) => {
    trigger.capture()
    if (data) setSelection({ identity: newSheetSelection(), snapshot: data, group, projectId })
  }
  const complete = data?.coverage.projects.every((p) => p.state === 'complete')
  const days = period === '7d' ? 7 : 30
  const hint = (group: keyof typeof labels) =>
    group === 'needs-you'
      ? data?.metrics.needsYou
        ? 'Waiting on your input or review'
        : complete && live.connected && !query.isError
          ? 'All caught up'
          : 'None found in available data'
      : group === 'running'
        ? 'Right now'
        : `Last ${days} days`
  const overview = (
    <div
      className="@container space-y-6"
      data-export-context={`Outcomes period: Last ${days} days`}
    >
      <h2 className="report-only sr-only">Workspace overview</h2>
      {query.isPending && (
        <div role="status" className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-4">
          <span className="sr-only">Loading overview…</span>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-xl border bg-card p-5 shadow-xs" aria-hidden="true">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="mt-3 h-8 w-14" />
              <Skeleton className="mt-3 h-3 w-28" />
            </div>
          ))}
        </div>
      )}
      {query.isError && (
        <Notice
          action={
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              Retry overview
            </Button>
          }
        >
          {data ? 'Showing previous results. ' : ''}Could not refresh overview.
        </Notice>
      )}
      {data && (
        <>
          <ReportNote>
            {data.metrics.needsYou
              ? `${data.metrics.needsYou} tasks require your input or review.`
              : complete && live.connected && !query.isError
                ? 'No tasks currently require your input or review.'
                : 'No waiting tasks found in the available data.'}{' '}
            {data.metrics.failed} failed {data.metrics.failed === 1 ? 'outcome' : 'outcomes'} in
            this period. Includes subtasks; completed does not mean accepted or deployed.
          </ReportNote>
          <Coverage coverage={data.coverage} retry={() => void query.refetch()} />
          <div className="grid grid-cols-1 gap-4 @md:grid-cols-2 @4xl:grid-cols-4">
            {(['needs-you', 'running', 'completed', 'failed'] as const).map((group) => {
              const value = data.metrics[group === 'needs-you' ? 'needsYou' : group]
              const Icon = metricIcons[group]
              const tone =
                value === 0
                  ? 'neutral'
                  : group === 'needs-you'
                    ? 'violet'
                    : group === 'failed'
                      ? 'danger'
                      : 'neutral'
              return (
                <Button
                  key={group}
                  type="button"
                  variant="outline"
                  data-outcome-trigger
                  data-export-keep
                  className={cn(
                    'h-auto items-stretch justify-start gap-0 border-border font-normal whitespace-normal active:translate-y-0',
                    metricSurface,
                    metricTones[tone],
                    'cursor-pointer hover:shadow-sm',
                    tone === 'neutral'
                      ? 'hover:border-foreground/15 hover:bg-card'
                      : tone === 'violet'
                        ? 'hover:bg-violet/[0.07]'
                        : 'hover:bg-danger/[0.06]',
                  )}
                  onClick={(event) => {
                    if (onCurrent && (group === 'running' || group === 'needs-you'))
                      onCurrent(group, event.currentTarget)
                    else open(group)
                  }}
                  aria-label={`${labels[group]}: ${value}`}
                >
                  <MetricContent
                    label={labels[group]}
                    value={
                      <span
                        className={
                          tone === 'violet' ? 'text-violet' : tone === 'danger' ? 'text-danger' : ''
                        }
                      >
                        {value}
                      </span>
                    }
                    icon={
                      <Icon
                        className={cn(
                          'size-4',
                          tone === 'violet' && 'text-violet',
                          tone === 'danger' && 'text-danger',
                        )}
                      />
                    }
                  >
                    <span className="flex items-center justify-between gap-2">
                      {hint(group)}
                      <span
                        data-export-exclude
                        className="flex items-center gap-0.5 font-medium text-foreground opacity-0 transition-opacity group-hover/metric:opacity-100 group-focus-visible/metric:opacity-100 no-hover:opacity-100 motion-reduce:transition-none"
                      >
                        View tasks
                        <ChevronRight className="size-3.5" aria-hidden="true" />
                      </span>
                    </span>
                  </MetricContent>
                </Button>
              )
            })}
          </div>
          <OutcomeInsights period={period} active={active} />
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <div className="flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
              <p>
                Median cycle time{' '}
                <strong className="font-semibold text-foreground tabular-nums">
                  {hours(data.metrics.medianCycleHours)}
                </strong>{' '}
                · {data.metrics.timedTasks}/{data.metrics.completed} completed tasks have valid
                timings.
              </p>
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0 text-[13px]"
                onClick={() => open('completed')}
              >
                Inspect completed tasks
              </Button>
              <InfoHint label="How these metrics work">{metricDefinitions}</InfoHint>
            </div>
            <p className="text-xs text-soft-foreground">
              <time dateTime={data.asOf} title={new Date(data.asOf).toLocaleString()}>
                Updated {shortAge(data.asOf)} ago
              </time>
            </p>
          </div>
          <ReportNote>{metricDefinitions}</ReportNote>
          <ExportRows
            rows={Object.entries(data.metrics).map(([metric, value]) => ({
              section: 'overview',
              metric,
              value,
              unit: metric === 'medianCycleHours' ? 'hours' : 'tasks',
              asOf: data.asOf,
              note:
                metric === 'running' || metric === 'needsYou'
                  ? 'Current non-archived state'
                  : `Finished since ${data.windowStart}`,
            }))}
          />
        </>
      )}
    </div>
  )
  const portfolio = data && (
    <div>
      <Card
        className="gap-0 py-0"
        data-export-context={`Outcomes: Last ${days} calendar days; workload: current state`}
      >
        <div className={widgetHeader}>
          <div className="flex items-center gap-1">
            <h2 className={widgetHeading}>Projects</h2>
            <InfoHint label="About the projects table">{portfolioDefinition}</InfoHint>
          </div>
          <span className={widgetMeta}>Outcomes from the last {days} days</span>
        </div>
        <ReportNote>{portfolioDefinition}</ReportNote>
        <div
          className="overflow-x-auto px-2 pt-2 pb-2"
          role="region"
          aria-label="Project outcomes"
          tabIndex={0}
        >
          <Table className="text-left">
            <TableHeader className={tableHeader}>
              <TableRow className={tableHeaderRow}>
                {['Project', 'Needs you', 'Running', 'Completed', 'Failed', 'Median cycle'].map(
                  (label) => (
                    <TableHead
                      key={label}
                      className={`${tableHead} ${label === 'Project' ? '' : 'text-right'}`}
                    >
                      {label}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody className={tableBody}>
              {data.projects.map((project) => {
                const source = data.coverage.projects.find(
                  (p) => p.projectId === project.projectId,
                )
                return (
                  <TableRow key={project.projectId} className={tableRow}>
                    <TableCell className={`${tableCell} px-3 py-2`}>
                      <Link
                        className="font-medium underline-offset-4 hover:underline"
                        to={`/p/${encodeURIComponent(project.projectId)}/tasks`}
                      >
                        {projectName(project.projectId)}
                      </Link>
                      {source?.state !== 'complete' && (
                        <span className="block text-xs text-pending-strong">
                          Incomplete data
                        </span>
                      )}
                    </TableCell>
                    {(['needs-you', 'running', 'completed', 'failed'] as const).map((group) => {
                      const value = project[group === 'needs-you' ? 'needsYou' : group]
                      return (
                        <TableCell key={group} className={`${tableCell} px-1 py-1 text-right`}>
                          <Button
                            data-export-keep
                            variant="ghost"
                            size="sm"
                            className={cn(
                              'min-w-9 justify-end px-2 font-normal tabular-nums no-hover:min-h-11',
                              source?.state === 'unavailable' || value === 0
                                ? 'text-soft-foreground'
                                : group === 'needs-you'
                                  ? 'font-medium text-violet'
                                  : group === 'failed'
                                    ? 'text-danger'
                                    : '',
                            )}
                            aria-label={`${projectName(project.projectId)}: ${labels[group]}: ${source?.state === 'unavailable' ? 'Unavailable' : value}`}
                            disabled={source?.state === 'unavailable'}
                            onClick={() => open(group, project.projectId)}
                          >
                            {source?.state === 'unavailable' ? 'Unavailable' : value}
                          </Button>
                        </TableCell>
                      )
                    })}
                    <TableCell className={`${tableCell} px-3 py-2 text-right tabular-nums`}>
                      {hours(project.medianCycleHours)}
                      <span className="block text-xs text-soft-foreground">
                        {project.timedTasks}/{project.completed} timed
                      </span>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
          {!data.projects.length && (
            <WidgetEmpty icon={FolderOpen} title="No projects to compare yet." />
          )}
        </div>
        <ExportRows
          rows={data.projects.flatMap(({ projectId, ...metrics }) =>
            Object.entries(metrics).map(([metric, value]) => ({
              section: 'portfolio',
              entity: projectId,
              metric,
              value:
                data.coverage.projects.find((p) => p.projectId === projectId)?.state ===
                'unavailable'
                  ? null
                  : value,
              unit: metric === 'medianCycleHours' ? 'hours' : 'tasks',
              asOf: data.asOf,
              note: `Outcomes since ${data.windowStart}; running and needsYou are current state`,
            })),
          )}
        />
      </Card>
    </div>
  )
  return (
    <>
      {children({ overview, portfolio })}
      <Sheet
        open={!!selection}
        onOpenChange={(value) => {
          if (!value) setSelection(null)
        }}
      >
        <SheetContent
          {...sheetPosition}
          className="w-full overflow-y-auto sm:max-w-xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            trigger.restore()
          }}
        >
          <SheetHeader>
            <SheetTitle>
              {selection ? labels[selection.group] : 'Tasks'}
              {selection?.projectId ? ` · ${selection.projectId}` : ''}
            </SheetTitle>
            <SheetDescription>
              Tasks behind the selected metric. Includes subtasks. Snapshot keeps counts and
              rows consistent.
            </SheetDescription>
          </SheetHeader>
          {selection && (
            <OutcomeTasks
              key={selection.identity}
              selection={selection}
              projectName={projectName}
              refresh={() => {
                setSelection(null)
                void query.refetch()
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}
function OutcomeTasks({
  selection,
  refresh,
  projectName,
}: {
  selection: Selection
  refresh: () => void
  projectName: (id: string) => string
}) {
  const [offset, setOffset] = useSheetState(`outcome:${selection.identity}:offset`, 0)
  const query = useDashboardOverview({
    period: selection.snapshot.period,
    snapshotId: selection.snapshot.snapshotId,
    group: selection.group,
    projectId: selection.projectId,
    offset,
  })
  const summary = useRef<HTMLParagraphElement>(null)
  const pageToFocus = useRef<number | null>(null)
  useEffect(() => {
    if (query.data && pageToFocus.current === offset) {
      summary.current?.focus()
      pageToFocus.current = null
    }
  }, [query.data, offset])
  const goToPage = (next: number) => {
    pageToFocus.current = next
    setOffset(next)
  }
  return (
    <div className="space-y-3 px-4 pb-4" data-sheet-loading={query.isFetching}>
      {query.isPending && <WidgetSkeleton label="Loading tasks…" rows={4} />}
      {query.isError && (
        <Notice
          action={
            <Button variant="outline" size="sm" onClick={refresh}>
              Refresh overview
            </Button>
          }
        >
          This snapshot may have expired or become unavailable.
        </Notice>
      )}
      {query.data && (
        <>
          <p ref={summary} tabIndex={-1} className="text-xs text-muted-foreground outline-none">
            {query.data.page.total} tasks · Snapshot from{' '}
            <time dateTime={query.data.asOf} title={new Date(query.data.asOf).toLocaleString()}>
              {shortAge(query.data.asOf)} ago
            </time>
          </p>
          <div>
            {query.data.page.rows.map((row) => (
              <OutcomeTask key={`${row.projectId}:${row.id}`} row={row} group={selection.group} projectName={projectName} />
            ))}
          </div>
          {!query.data.page.rows.length && <WidgetEmpty icon={Inbox} title="No tasks in this group." />}
        </>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!offset || query.isFetching}
          onClick={() => goToPage(Math.max(0, offset - 20))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!query.data || query.data.page.nextOffset === null || query.isFetching}
          onClick={() => goToPage(query.data!.page.nextOffset!)}
        >
          Next
        </Button>
      </div>
    </div>
  )
}

function OutcomeTask({
  row,
  group,
  projectName,
}: {
  row: DashboardOverview['page']['rows'][number]
  group: DashboardOverviewGroup
  projectName: (id: string) => string
}) {
  const truth = useDashboardTruth(row)
  const current = group === 'running' || group === 'needs-you'
  // Outcomes retain their historical status; operational groups must stop
  // offering stale actions as soon as a live transition arrives.
  if (current && truth) row = { ...row, ...truth }
  const removed = truth === null
  const obsolete = current && (row.archived || (group === 'running'
    ? row.status !== 'running'
    : !isNeedsYouStatus(row)))
  const inactive = removed || obsolete
  const attention = deriveAttention(row)
  const label = current && removed
    ? 'Task removed'
    : obsolete
      ? group === 'running' ? 'No longer running' : 'No longer needs you'
      : attention.label
  return (
    <div className="border-b border-border/70 py-3 last:border-0">
      <Link
        aria-disabled={inactive || undefined}
        tabIndex={inactive ? -1 : undefined}
        onClick={(event) => {
          if (inactive) event.preventDefault()
        }}
        className="block text-sm font-medium underline-offset-4 hover:underline no-hover:min-h-11"
        to={`/p/${encodeURIComponent(row.projectId)}/tasks/${encodeURIComponent(row.id)}`}
      >
        {row.titleSummary || row.title}
      </Link>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <StatusDot tone={attention.tone} className="mr-1" /> {projectName(row.projectId)} ·{' '}
        {label} · {row.archived ? 'Archived · ' : ''}
        <time
          dateTime={row.finishedAt ?? row.createdAt}
          title={new Date(row.finishedAt ?? row.createdAt).toLocaleString()}
        >
          {row.finishedAt ? 'Finished' : 'Created'}{' '}
          {shortAge(row.finishedAt ?? row.createdAt)} ago
        </time>
      </p>
    </div>
  )
}
