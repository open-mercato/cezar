import * as React from 'react'

import { useArchiveRun, useHealth, usePinRun, useProjectRepoBase, useReferenceProjectId, useRunsForProject } from '@/api/queries'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { ArchiveToggle } from '@/components/archive-toggle'
import { useSidebarNavigate } from '@/components/app-shell'
import { PinToggle } from '@/components/pin-toggle'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { RepoBaseContext, ROW_ACTION_BUTTON_CLASS, ROW_ACTIONS_CLASS, ROW_META_YIELD_CLASS } from '@/components/task-quick-list'
import { toast } from '@/components/ui/toaster'
import { UnreadMarker } from '@/components/unread-marker'
import { deriveAttention } from '@/lib/attention'
import { currentTasks } from '@/lib/current-tasks'
import { shortAge } from '@/lib/format'
import { Link, useActiveProjectId, useProjectMatch } from '@/lib/project-router'
import { isReadDoneItem, isUnread } from '@/lib/read-state'
import { isRunActive } from '@/lib/run-status'
import { filterRunsByOrigin } from '@/lib/task-filters'
import { lastActivityAt, refPrefixMatches, runTitle, splitRefPrefix } from '@/lib/task-groups'
import { useTaskOrigin } from '@/lib/task-origin'
import { taskReference, taskReferences } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The sidebar's "Current tasks" (redesign, Proposal 1): the active project's tasks in the Now
 * view's order — needs you, running, then the most recent — capped at six, "More…" opening the
 * full table. Each row keeps the quick-list's one-line shape and its pin / archive / unread
 * behaviour; only the ordering and the always-present age differ.
 */
export function CurrentTasks({
  runs,
  currentRunId = null,
  now = Date.now(),
  onTogglePin,
  onToggleArchive,
}: {
  runs: RunRecord[]
  currentRunId?: string | null
  now?: number
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  onToggleArchive?: (run: RunRecord, archived: boolean) => void
}) {
  const rows = currentTasks(runs)
  const onNavigate = useSidebarNavigate()
  return (
    <div data-slot="current-tasks">
      <h2 className="px-3 pt-3 pb-1 eyebrow text-soft-foreground">Current tasks</h2>
      {rows.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-soft-foreground">No tasks yet — describe one.</p>
      ) : (
        rows.map((run) => (
          <CurrentTaskRow
            key={run.id}
            run={run}
            current={run.id === currentRunId}
            now={now}
            onTogglePin={onTogglePin}
            onToggleArchive={onToggleArchive}
          />
        ))
      )}
      <Link
        to="/tasks"
        onClick={onNavigate}
        data-slot="current-tasks-more"
        className="flex h-9 items-center rounded-md px-3 text-label text-muted-foreground transition-colors hover:text-foreground md:h-7"
      >
        More…
      </Link>
    </div>
  )
}

const CurrentTaskRow = React.memo(function CurrentTaskRow({
  run,
  current,
  now,
  onTogglePin,
  onToggleArchive,
}: {
  run: RunRecord
  current: boolean
  now: number
  onTogglePin?: (run: RunRecord, pinned: boolean) => void
  onToggleArchive?: (run: RunRecord, archived: boolean) => void
}) {
  const onNavigate = useSidebarNavigate()
  const canArchive = Boolean(onToggleArchive) && (Boolean(run.archived) || !isRunActive(run.status))
  const hasActions = Boolean(onTogglePin) || canArchive
  const attention = deriveAttention(run)
  const statusId = React.useId()
  const reference = taskReference(run, React.useContext(RepoBaseContext))
  const title = runTitle(run)
  // The number is painted once, as the chip, so a matching `NNN: ` prefix drops (#788).
  const displayTitle = refPrefixMatches(title, reference?.number) ? splitRefPrefix(title).rest : title
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  const age = shortAge(lastActivityAt(run), now)
  return (
    <div
      data-slot="task-row"
      data-run-id={run.id}
      data-active={current ? 'true' : undefined}
      className={cn('group/task-row flex items-center gap-2 rounded-sm pl-2.5 hover:bg-muted', current && 'bg-muted')}
    >
      {/* Siblings of the row link, never children: an anchor inside an anchor is invalid. */}
      <Link
        to={`/tasks/${run.id}`}
        tabIndex={-1}
        aria-hidden="true"
        data-slot="task-row-dot-link"
        onClick={onNavigate}
        className="-ml-2.5 flex shrink-0 items-center self-stretch pl-2.5"
      >
        <StatusDot id={statusId} tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
      </Link>
      {reference ? (
        <TaskReferenceChip run={run} reference={reference} compact className="h-auto shrink-0 gap-[2px] px-1.5 py-px text-micro" />
      ) : null}
      <Link
        to={`/tasks/${run.id}`}
        title={title}
        aria-current={current ? 'page' : undefined}
        aria-describedby={statusId}
        data-slot="task-row-link"
        onClick={onNavigate}
        className={cn('flex min-w-0 flex-1 items-center gap-2 py-[7px]', hasActions ? 'pr-0.5' : 'pr-2.5')}
      >
        <span
          data-slot="task-row-title"
          className={cn(
            'min-w-0 flex-1 truncate text-ui',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium',
          )}
        >
          {displayTitle}
        </span>
        {age ? (
          <span data-slot="task-row-age" className={cn('shrink-0 text-meta text-soft-foreground tabular-nums', hasActions && ROW_META_YIELD_CLASS)}>
            {age}
          </span>
        ) : null}
        {unread ? <UnreadMarker /> : null}
      </Link>
      {hasActions ? (
        <div data-slot="task-row-actions" className={ROW_ACTIONS_CLASS}>
          {onTogglePin ? (
            <PinToggle pinned={Boolean(run.pinned)} onToggle={(pinned) => onTogglePin(run, pinned)} className={ROW_ACTION_BUTTON_CLASS} />
          ) : null}
          {canArchive && onToggleArchive ? (
            <ArchiveToggle archived={Boolean(run.archived)} onToggle={(archived) => onToggleArchive(run, archived)} className={ROW_ACTION_BUTTON_CLASS} />
          ) : null}
        </div>
      ) : null}
    </div>
  )
})

/** The list wired to the active project's run list (stream-patched) and the row that is open. */
export function CurrentTasksContainer() {
  const health = useHealth()
  const activeProjectId = useActiveProjectId()
  const runs = useRunsForProject(activeProjectId, health.data?.bootProject ?? null)
  const [origin] = useTaskOrigin()
  const shown = React.useMemo(
    () => (runs.data ? filterRunsByOrigin(runs.data, origin) : undefined),
    [runs.data, origin],
  )
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const now = useNow(30_000)
  const pinMutation = usePinRun('sidebar')
  const onTogglePin = React.useCallback(
    (run: RunRecord, pinned: boolean) =>
      pinMutation.mutate({ id: run.id, pinned }, { onError: (error: Error) => toast(error.message, { tone: 'danger' }) }),
    [pinMutation.mutate],
  )
  const archiveMutation = useArchiveRun('sidebar')
  const onToggleArchive = React.useCallback(
    (run: RunRecord, archived: boolean) =>
      archiveMutation.mutate({ id: run.id, archived }, { onError: (error: Error) => toast(error.message, { tone: 'danger' }) }),
    [archiveMutation.mutate],
  )
  const projectId = useReferenceProjectId()
  const repoBase = useProjectRepoBase()
  const rows = React.useMemo(() => (shown ? currentTasks(shown) : []), [shown])
  // Only the rows on screen ask for their chip status.
  const referenceRequests = React.useMemo(
    () =>
      projectId === undefined
        ? []
        : rows.flatMap((run) => taskReferences(run).map((reference) => ({ projectId, kind: reference.kind, number: reference.number }))),
    [rows, projectId],
  )
  // Nothing until the list has answered: an empty state would claim "no tasks" before we know.
  if (!shown) return null
  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <RepoBaseContext.Provider value={repoBase}>
        <CurrentTasks
          runs={shown}
          currentRunId={match?.params.id ?? exact?.params.id ?? null}
          now={now}
          onTogglePin={onTogglePin}
          onToggleArchive={onToggleArchive}
        />
      </RepoBaseContext.Provider>
    </ReferenceStatusProvider>
  )
}
