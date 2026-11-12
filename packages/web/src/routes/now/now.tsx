import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, ArrowRightIcon, ListChecksIcon, PlusIcon, SearchIcon } from 'lucide-react'
import * as React from 'react'

import { archiveFinished, continueRun } from '@/api/client'
import { queryKeys, useHealth, useReferenceProjectId, useRepo, useRuns } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { FirstRun } from '@/components/first-run'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { Button } from '@/components/ui/button'
import { toast } from '@/components/ui/toaster'
import { LiveNowProvider, RelativeAge } from '@/lib/live-now'
import { Link, useActiveProjectId, useNavigate } from '@/lib/project-router'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { formatCost, scheduledResume, taskReference, taskReferences, workflowLabel } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import { useExistingProviderAvailability } from '@/routes/task-thread/active-provider'
import { resumeAfterIdleTeardown } from '@/routes/task-thread/ask-answer'
import { runActionFlags } from '@/routes/task-thread/run-actions'

import {
  FINISHED_TODAY_CAP,
  NEEDS_YOU_ACTION_LABEL,
  finishedTodayRows,
  needsYouRows,
  runningRows,
  todayLabel,
  type NeedsYouRow,
  type RunningRow,
} from './now-model'

const NO_RUNS: RunRecord[] = []
const AGE_TICK_MS = 30_000

/**
 * The project home — "Now" (spec: attention-first cockpit (2026-11-11), Proposal 2): a triage
 * board, not a table. Three sections over the runs index — what needs a person, what is running,
 * what finished today — each row naming why it is there and the one action that resolves it. The
 * full table keeps everything else at `/tasks`.
 *
 * Presentational: the sections come from `now-model.ts`, the data from the route below.
 */
export function NowView({
  runs,
  projectName,
  now,
  onArchiveFinished,
  onRetry,
  firstRun,
}: {
  /** Undefined while `/api/runs` has not answered: the header renders, the body waits. */
  runs: RunRecord[] | undefined
  projectName?: string
  /** First-run onboarding (spec 2026-10-26-first-run-onboarding) — the home still owns it, so
   *  it replaces the plain "No tasks yet" when the route supplies it. */
  firstRun?: React.ReactNode
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  onArchiveFinished: () => void
  /** Reopen a failed run's last session — the thread footer's own Continue. */
  onRetry: (run: RunRecord) => Promise<unknown>
}) {
  const clock = useNow(AGE_TICK_MS, now === undefined)
  const at = now ?? clock
  const all = runs ?? NO_RUNS
  const needsYou = React.useMemo(() => needsYouRows(all), [all])
  const running = React.useMemo(() => runningRows(all), [all])
  const finished = React.useMemo(() => finishedTodayRows(all, at), [all, at])
  const positions = React.useMemo(() => queuePositions(all), [all])
  const hasTasks = React.useMemo(() => all.some((run) => !run.archived), [all])
  const navigate = useNavigate()
  const [query, setQuery] = React.useState('')

  return (
    <LiveNowProvider intervalMs={AGE_TICK_MS} now={now}>
      <div data-route="now" className="flex min-h-full flex-col">
        <header className="sticky top-0 z-10 hidden h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-5 md:flex">
          <h1 className="text-base font-semibold">Now</h1>
          <span data-slot="now-date" className="text-label text-soft-foreground">
            {projectName ? `${projectName} · ` : ''}
            {todayLabel(at)}
          </span>
          <div className="flex-1" />
          {/* The search lives on the table: this box hands the query over to `/tasks?q=`. */}
          <form
            role="search"
            className="relative w-60"
            onSubmit={(event) => {
              event.preventDefault()
              const needle = query.trim()
              navigate(needle ? `/tasks?q=${encodeURIComponent(needle)}` : '/tasks')
            }}
          >
            <SearchIcon
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-soft-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks…"
              aria-label="Search tasks"
              className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-8 text-ui text-foreground outline-none placeholder:text-soft-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </form>
          <Button asChild variant="ghost" size="sm">
            <Link to="/tasks" data-slot="all-tasks">
              All tasks
              <ArrowRightIcon className="size-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </header>

        <div className="flex flex-1 flex-col gap-6 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {runs === undefined ? null : !hasTasks ? (
            (firstRun ?? <NoTasks />)
          ) : (
            <>
              <Section slot="needs-you" title="Needs you" count={needsYou.length} empty="Nothing needs you right now.">
                {needsYou.map((row) => (
                  <NeedsYouRowView key={row.run.id} row={row} onRetry={onRetry} />
                ))}
              </Section>
              <Section slot="running" title="Running" count={running.length} empty="Nothing is running.">
                {running.map((row) => (
                  <RunningRowView key={row.run.id} row={row} queuePosition={positions.get(row.run.id)} />
                ))}
              </Section>
              <Section
                slot="finished-today"
                title="Finished today"
                count={finished.length}
                empty="Nothing finished today."
                actions={
                  finished.length > 0 ? (
                    <Button type="button" variant="ghost" size="sm" data-slot="archive-finished" onClick={onArchiveFinished}>
                      <ArchiveIcon className="size-3.5" aria-hidden="true" />
                      Archive all finished
                    </Button>
                  ) : null
                }
              >
                {finished.slice(0, FINISHED_TODAY_CAP).map((run) => (
                  <FinishedRowView key={run.id} run={run} />
                ))}
                {finished.length > FINISHED_TODAY_CAP ? (
                  <Link
                    to="/tasks"
                    data-slot="show-more"
                    className="inline-flex h-8 items-center px-2 text-label text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Show {finished.length - FINISHED_TODAY_CAP} more
                  </Link>
                ) : null}
              </Section>
            </>
          )}
        </div>

        {/* The mobile New-task FAB — the desktop CTA lives in the sidebar. */}
        <Link
          to="/new"
          data-slot="new-task-fab"
          aria-label="New task"
          className="fixed right-4 bottom-[calc(16px+var(--phone-bar,0px)+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-modal md:hidden"
        >
          <PlusIcon className="size-[22px]" aria-hidden="true" />
        </Link>
      </div>
    </LiveNowProvider>
  )
}

function Section({
  slot,
  title,
  count,
  empty,
  actions,
  children,
}: {
  slot: string
  title: string
  count: number
  empty: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section data-slot={`now-${slot}`} data-count={count} aria-labelledby={`now-${slot}-heading`} className="flex flex-col">
      <div className="mb-2 flex items-center gap-2">
        <h2 id={`now-${slot}-heading`} className="eyebrow flex items-center gap-2 text-soft-foreground">
          {title}
          <span className="rounded-full bg-muted px-1.5 font-mono text-micro font-medium tracking-normal text-foreground tabular-nums normal-case">
            {count}
          </span>
        </h2>
        <div className="flex-1" />
        {actions}
      </div>
      {count === 0 ? (
        <p data-slot="now-empty" className="px-1 py-2 text-label text-soft-foreground">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">{children}</div>
      )}
    </section>
  )
}

/** A project with no tasks at all — the hero moment, with the twinkle backdrop. */
function NoTasks() {
  return (
    <div data-slot="now-no-tasks" className="flex flex-1 flex-col">
      <CenteredState
        heading="h2"
        icon={<ListChecksIcon />}
        tone="primary"
        backdrop
        title="No tasks yet"
        subtitle="Describe a task to get started."
        actions={
          <Button asChild>
            <Link to="/new">
              <PlusIcon aria-hidden="true" />
              New task
            </Link>
          </Button>
        }
      />
    </div>
  )
}

const ROW_CLASS =
  'grid grid-cols-[10px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-[10px] border border-border bg-card px-3.5 py-3 md:grid-cols-[16px_minmax(0,1fr)_auto_auto] md:items-center md:gap-x-3.5'

function NeedsYouRowView({ row, onRetry }: { row: NeedsYouRow; onRetry: (run: RunRecord) => Promise<unknown> }) {
  const { run } = row
  const reference = taskReference(run)
  const cost = formatCost(run.costUsd)
  const to = `/tasks/${run.id}`
  return (
    <article
      data-slot="now-row"
      data-run-id={run.id}
      data-reason={row.reason}
      className={cn(ROW_CLASS, row.reason === 'failed' ? 'border-danger/45' : 'border-info/50')}
    >
      <StatusDot tone={row.tone} pulse={row.pulse} className="mt-1.5 md:mt-0" aria-label={row.label} />
      <div className="min-w-0">
        <Link to={to} className="block truncate text-ui font-medium text-foreground">
          {runTitle(run)}
        </Link>
        <div data-slot="now-why" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
          <span>
            {row.label} · <RelativeAge at={row.since} />
          </span>
          {row.detail ? <span className="min-w-0 truncate">{row.detail}</span> : null}
          {run.diffStat ? (
            <span className="font-mono text-meta">
              {run.diffStat.files} {run.diffStat.files === 1 ? 'file' : 'files'} <DiffStatLabel stat={run.diffStat} className="text-meta" />
            </span>
          ) : null}
          {reference ? <TaskReferenceChip run={run} reference={reference} className="h-5" /> : null}
        </div>
      </div>
      <span
        data-slot="now-cost"
        className="col-start-2 font-mono text-meta text-muted-foreground tabular-nums md:col-start-auto"
      >
        {cost || '—'}
      </span>
      <div className="col-start-2 flex md:col-start-auto">
        <RowAction row={row} onRetry={onRetry} />
      </div>
    </article>
  )
}

/** The ONE action per reason — a link where the resolution is a screen, a button where it is a call. */
function RowAction({ row, onRetry }: { row: NeedsYouRow; onRetry: (run: RunRecord) => Promise<unknown> }) {
  const { run, action } = row
  const label = NEEDS_YOU_ACTION_LABEL[action]
  if (action === 'retry') return <RetryButton run={run} onRetry={onRetry} />
  const to =
    action === 'review' ? `/tasks/${run.id}/changes`
    : action === 'answer' ? `/tasks/${run.id}#ask`
    : action === 'open' ? `/tasks/${run.id}`
    : `/tasks/${run.id}#reply`
  return (
    <Button asChild size="sm" variant={action === 'open' ? 'outline' : 'primary'}>
      <Link to={to} data-slot="now-action" data-action={action}>
        {label}
      </Link>
    </Button>
  )
}

/** Retry reopens the last session (`POST /continue`), gated exactly as the thread's footer
 *  Continue: there must be a session to resume and its provider must be usable. */
function RetryButton({ run, onRetry }: { run: RunRecord; onRetry: (run: RunRecord) => Promise<unknown> }) {
  const [pending, setPending] = React.useState(false)
  const provider = useExistingProviderAvailability(run)
  const resumable = runActionFlags(run).continueRun
  const blockedReason = !resumable ? 'No session to resume — open the task instead.' : !provider.usable ? provider.reason : undefined
  if (!resumable) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link to={`/tasks/${run.id}`} data-slot="now-action" data-action="open">
          Open
        </Link>
      </Button>
    )
  }
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-slot="now-action"
      data-action="retry"
      disabled={pending || blockedReason !== undefined}
      title={blockedReason ?? 'Reopen the session and pick up where it stopped'}
      onClick={() => {
        setPending(true)
        onRetry(run).finally(() => setPending(false))
      }}
    >
      {pending ? 'Retrying…' : NEEDS_YOU_ACTION_LABEL.retry}
    </Button>
  )
}

function RunningRowView({ row, queuePosition }: { row: RunningRow; queuePosition: number | undefined }) {
  const { run } = row
  const cost = formatCost(run.costUsd)
  const scheduled = row.kind === 'scheduled' ? scheduledResume(run) : undefined
  const percent = Math.round(row.progress * 100)
  return (
    <article data-slot="now-row" data-run-id={run.id} data-kind={row.kind} className={ROW_CLASS}>
      <StatusDot
        tone={row.kind === 'running' ? 'violet' : row.kind === 'scheduled' ? 'pending' : 'neutral'}
        pulse={row.kind === 'running'}
        className="mt-1.5 md:mt-0"
        aria-label={row.label}
      />
      <div className="min-w-0">
        <Link to={`/tasks/${run.id}`} className="block truncate text-ui font-medium text-foreground">
          {runTitle(run)}
        </Link>
        <div data-slot="now-why" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
          <span>
            {workflowLabel(run)}
            {row.step ? ` · step ${row.step.index} of ${row.step.total} · ${row.step.name}` : ''}
            {row.kind === 'queued' && queuePosition !== undefined ? ` · #${queuePosition} in queue` : ''}
            {scheduled ? ` · resumes ${scheduled.label}` : ''}
            {row.label === 'monitoring' ? ' · watching' : ''}
          </span>
        </div>
      </div>
      {row.kind === 'running' ? (
        <div
          role="progressbar"
          aria-label="Steps done"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          data-slot="now-progress"
          className="col-start-2 h-1 w-24 overflow-hidden rounded-full bg-muted md:col-start-auto"
        >
          <span className="block h-full rounded-full bg-violet" style={{ width: `${percent}%` }} />
        </div>
      ) : (
        <span className="hidden md:block" />
      )}
      <span data-slot="now-cost" className="col-start-2 font-mono text-meta text-muted-foreground tabular-nums md:col-start-auto">
        {run.startedAt ? <RelativeAge at={run.startedAt} /> : null}
        {run.startedAt && cost ? ' · ' : ''}
        {cost}
        {!run.startedAt && !cost ? '—' : ''}
      </span>
    </article>
  )
}

function FinishedRowView({ run }: { run: RunRecord }) {
  const reference = taskReference(run)
  return (
    <article
      data-slot="now-row"
      data-run-id={run.id}
      data-kind="finished"
      className="grid grid-cols-[10px_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-1.5 md:grid-cols-[16px_minmax(0,1fr)_auto_auto] md:gap-x-3.5"
    >
      <StatusDot tone="neutral" aria-label="finished" />
      <Link to={`/tasks/${run.id}`} className="min-w-0 truncate text-ui text-muted-foreground hover:text-foreground">
        {runTitle(run)}
      </Link>
      {reference ? (
        <TaskReferenceChip run={run} reference={reference} compact className="hidden h-5 md:inline-flex" />
      ) : (
        <span className="hidden md:block" />
      )}
      <span className="text-meta text-soft-foreground tabular-nums">
        {run.finishedAt ? <RelativeAge at={run.finishedAt} /> : null}
      </span>
    </article>
  )
}

/**
 * Now wired to live data: `useRuns()` (kept fresh by the global SSE stream — no polling of its
 * own), the project's name from the registry, the archive-finished mutation the table uses, and
 * Retry through the same `POST /continue` the thread's footer sends.
 */
export function NowRoute() {
  const runs = useRuns()
  // Project-scoped; a failed read falls back to "git", exactly as the table's first run does.
  const repo = useRepo()
  // The name comes from health, which the scope gate already observes — NOT `useProjects()`: a
  // fresh observer on an errored registry refetches it (`retryOnMount`), the data-less query flips
  // back to pending, and the gate above would unmount this view and loop.
  const health = useHealth()
  const activeProjectId = useActiveProjectId()
  const projectName = React.useMemo(() => {
    const id = activeProjectId ?? health.data?.bootProject
    return health.data?.projects?.find((project) => project.id === id)?.name
  }, [activeProjectId, health.data])
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all })
  const archive = useMutation({ mutationFn: archiveFinished, onSuccess: invalidate })
  // An empty Continue is the footer's one-click retry; the idle-teardown retry window is the
  // ask card's (ask-answer.ts) — a stale row can hit `run is still active` a beat too early.
  const retry = useMutation({
    mutationFn: (run: RunRecord) => resumeAfterIdleTeardown(() => continueRun(run.id)),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const retryAsync = retry.mutateAsync
  const onRetry = React.useCallback((run: RunRecord) => retryAsync(run).catch(() => undefined), [retryAsync])
  // Chip statuses, hydrated here like the table does — one request list for every chip on screen.
  const projectId = useReferenceProjectId()
  const referenceRequests = React.useMemo(
    () =>
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) =>
            taskReferences(run).map((reference) => ({ projectId, kind: reference.kind, number: reference.number })),
          ),
    [runs.data, projectId],
  )
  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <NowView
        runs={runs.data}
        projectName={projectName}
        onArchiveFinished={() => archive.mutate()}
        onRetry={onRetry}
        firstRun={<FirstRun gitRepo={repo.data ? repo.data.info !== null : repo.isError ? true : undefined} />}
      />
    </ReferenceStatusProvider>
  )
}
