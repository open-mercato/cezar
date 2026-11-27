import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArchiveIcon, ArrowRightIcon, ListChecksIcon, PlusIcon, SearchIcon } from 'lucide-react'
import * as React from 'react'
import { useLocation, useNavigate as useRouterNavigate } from 'react-router'

import { archiveFinished, continueRun } from '@/api/client'
import { queryKeys, useHealth, useReferenceProjectId, useRepo, useRuns } from '@/api/queries'
import type { AttentionItem, AttentionOverride, AttentionSettled, RunRecord } from '@open-mercato/cezar-api-client'
import { useAttention } from '@/api/attention'
import { useManagers } from '@/api/managers'
import { Segmented } from '@/components/segmented'
import { CenteredState } from '@/components/centered-state'
import { DiffStatLabel } from '@/components/diff-stat'
import { FirstRun, SetupPill, WelcomeBack } from '@/components/first-run'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { SignInRow } from '@/components/reconnect/reconnect-row'
import { ScheduledTasks } from '@/components/scheduled-tasks'
import { StatusDot } from '@/components/status-dot'
import { StatusDescription, StatusMark } from '@/components/status-mark'
import { Button } from '@/components/ui/button'
import { IconTooltip } from '@/components/ui/icon-tooltip'
import { toast } from '@/components/ui/toaster'
import { UnreadMarker } from '@/components/unread-marker'
import { deriveAttention } from '@/lib/attention'
import { LiveNowProvider, RelativeAge } from '@/lib/live-now'
import { Link, useActiveProjectId, useNavigate } from '@/lib/project-router'
import { isUnread } from '@/lib/read-state'
import { useScheduledTasksGate } from '@/lib/scheduled-tasks-gate'
import { queuePositions, runTitle } from '@/lib/task-groups'
import { formatCost, scheduledResume, taskReference, taskReferences, workflowLabel } from '@/lib/tasks-table'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'
import { useAutomationsGate, useAutomationsQuery } from '@/routes/automations/use-automations'
import { useExistingProviderAvailability } from '@/routes/task-thread/active-provider'
import { resumeAfterIdleTeardown } from '@/routes/task-thread/ask-answer'
import { runActionFlags } from '@/routes/task-thread/run-actions'
import { ManagerProjectsContext } from '@/routes/manager/manager-reference'
import { taskPath } from '@/routes/manager/manager-session-card'
import type { ManagerReferenceProject } from '@/lib/managers'

import {
  FINISHED_TODAY_CAP,
  NEEDS_YOU_ACTION_LABEL,
  finishedTodayRows,
  needsYouRows,
  signInGroups,
  runningRows,
  todayLabel,
  type NeedsYouRow,
  type RunningRow,
} from './now-model'
import { AttentionRow, type AttentionActions } from './now-attention'
import { useNeedsYouActions } from './use-needs-you-actions'
import { DismissButton, ProbablyDoneGroup, SettledReason, SwipeRow, TriageMenu, useRowMenu, type TriageActions } from './now-triage'
import {
  SNOOZE_LABEL,
  KIND_RANK,
  KIND_TIER,
  REASON_RANK,
  REASON_TIER,
  isHidden,
  isRunHidden,
  orderNeedsYou,
  itemForRun,
  itemTarget,
  shortLabel,
  snoozeUntil,
  taskRowTarget,
  type SnoozeChoice,
  type TriageTarget,
} from './now-triage-model'
import {
  READABLE,
  attentionGroups,
  projectManagerItems,
  readNowScope,
  saveNowScope,
  type NowScope,
} from './now-attention-model'

const NO_RUNS: RunRecord[] = []
const NO_KEYS: ReadonlySet<string> = new Set()
const NO_PROJECTS: readonly ManagerReferenceProject[] = []
const NO_MANAGERS: readonly { id: string; notify?: boolean | undefined }[] = []
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
  scheduledTasks,
  hasScheduledTasks = false,
  setupPill,
  welcomeBack,
  managersAvailable = false,
  attention,
  scope = 'project',
  onScope,
  managerConnected,
  projectLabel,
  attentionActions,
  onMarkAllRead,
  triage,
  projectId,
  pendingQuestions = NO_KEYS,
  referenceProjects = NO_PROJECTS,
}: {
  /** The projects on this computer: a card's `[[pr:<project>/N]]` paints as a chip only for one of them. */
  referenceProjects?: readonly ManagerReferenceProject[]
  /** The attention list (spec 2026-11-20-phone-notifications-inbox); absent keeps Now's own rows only. */
  attention?: { items: AttentionItem[]; total: number; overrides?: AttentionOverride[]; olderAfterDays?: number } | undefined
  /** Dismiss, snooze and the ⋯ menu (spec 2026-11-23-needs-you-triage). */
  triage?: TriageActions
  /** This project, for matching its runs to their attention items. */
  projectId?: string | undefined
  /** Questions waiting out their undo window before their card closes. */
  pendingQuestions?: ReadonlySet<string>
  scope?: NowScope
  onScope?: (scope: NowScope) => void
  /** This project's view takes the items of the managers connected to it. */
  managerConnected?: (managerId: string) => boolean
  projectLabel?: (projectId: string) => string
  attentionActions?: AttentionActions
  /** Marks every message, review and failure shown read; decisions stay. */
  onMarkAllRead?: (items: AttentionItem[]) => void
  /** Manager owns task creation on mobile when available, as on the Tasks page (#2272). */
  managersAvailable?: boolean
  /** Undefined while `/api/runs` has not answered: the header renders, the body waits. */
  runs: RunRecord[] | undefined
  projectName?: string
  /** First-run onboarding (spec 2026-10-26-first-run-onboarding) — the home still owns it, so
   *  it replaces the plain "No tasks yet" when the route supplies it. */
  firstRun?: React.ReactNode
  /** The composer's scheduled starts (#1340) — the strip the table shows; the composer lands here. */
  scheduledTasks?: React.ReactNode
  /** A scheduled start counts as a task: the first-run hero would say there are none. */
  hasScheduledTasks?: boolean
  /** What is left of setup once tasks exist — this is the landing page, so it lives here. */
  setupPill?: React.ReactNode
  /** After a long absence: what the user left and what changed — above the setup pill. */
  welcomeBack?: React.ReactNode
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
  const signIn = React.useMemo(() => signInGroups(all), [all])
  const running = React.useMemo(() => runningRows(all), [all])
  const finished = React.useMemo(() => finishedTodayRows(all, at), [all, at])
  const positions = React.useMemo(() => queuePositions(all), [all])
  const hasTasks = React.useMemo(() => all.some((run) => !run.archived), [all])
  const navigate = useNavigate()
  const [query, setQuery] = React.useState('')
  // Dismissed items are already out of the server's list; a question in its undo window is not yet.
  const visibleItems = React.useMemo(
    () => attention?.items.filter((item) => !isHidden(itemTarget(item), attention.overrides, pendingQuestions)),
    [attention, pendingQuestions],
  )
  const managerRows = React.useMemo(
    () => (visibleItems ? projectManagerItems(visibleItems, managerConnected ?? (() => false)) : []),
    [visibleItems, managerConnected],
  )
  // Now's own task rows borrow the server's verdict, key and question by run.
  const taskRows = React.useMemo(() => needsYou.flatMap((row) => {
    const item = itemForRun(attention?.items, projectId, row.run.id)
    const target = taskRowTarget(item, projectId, row.run, row.since, shortLabel(runTitle(row.run)))
    if (isHidden(target, attention?.overrides, pendingQuestions) || isRunHidden(projectId, row.run.id, row.since, attention?.overrides)) return []
    return [{ row, target, settled: item?.settled }]
  }), [needsYou, attention, projectId, pendingQuestions])
  const groups = React.useMemo(
    () => (visibleItems && scope === 'all' ? attentionGroups(visibleItems.filter((item) => !item.settled), projectLabel ?? ((id) => id)) : []),
    [visibleItems, scope, projectLabel],
  )
  const showAll = attention !== undefined && scope === 'all'
  const liveManagerRows = managerRows.filter((item) => !item.settled)
  const liveTaskRows = taskRows.filter((entry) => !entry.settled)
  const doneItems = showAll ? (visibleItems ?? []).filter((item) => item.settled) : managerRows.filter((item) => item.settled)
  const doneTaskRows = showAll ? [] : taskRows.filter((entry) => entry.settled)
  const doneCount = doneItems.length + doneTaskRows.length
  const runsById = React.useMemo(() => new Map(all.map((run) => [run.id, run])), [all])
  const runOf = (item: AttentionItem) => (item.projectId !== undefined && item.projectId === projectId && item.runId ? runsById.get(item.runId) : undefined)
  // All counts what the Now badge and the phone's icon count: a failed task shows, uncounted.
  const needsCount = showAll ? attention.total : liveTaskRows.length + liveManagerRows.length
  const shownCount = showAll ? groups.reduce((sum, group) => sum + group.items.length, 0) : needsCount
  const readable = showAll ? (visibleItems ?? []).filter((item) => READABLE.has(item.kind) && !item.settled) : []
  let hinted = false
  // The phone's swipe peek plays on the first row only.
  const hintOnce = () => (hinted ? false : (hinted = true))

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
        {scheduledTasks}

        <div className="flex flex-1 flex-col gap-6 p-3 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {runs === undefined ? null : !hasTasks ? (
            hasScheduledTasks ? (
              <p data-slot="now-nothing-started" className="text-label text-muted-foreground">
                No tasks have started yet.
              </p>
            ) : (
              (firstRun ?? <NoTasks />)
            )
          ) : (
            <>
              {welcomeBack || setupPill ? (
                // `empty:hidden`: both render null once dismissed, and an empty slot would still take a gap.
                <div data-slot="now-onboarding" className="-mb-3 flex flex-col empty:hidden">
                  {welcomeBack}
                  {setupPill}
                </div>
              ) : null}
              {signIn.length > 0 ? (
                <Section slot="sign-in" title="Sign-in needed" count={signIn.length} empty="">
                  <ul data-slot="sign-in-list" className="overflow-hidden rounded-xl border border-border bg-card">
                    {signIn.map((group, index) => (
                      <SignInRow
                        key={`${group.provider}:${group.profileId}`}
                        provider={group.provider}
                        profileId={group.profileId}
                        first={index === 0}
                        blocks={group.runs.map((run) => `“${runTitle(run)}”`)}
                      />
                    ))}
                  </ul>
                </Section>
              ) : null}
              <Section
                slot="needs-you"
                title="Needs you"
                count={needsCount}
                shown={shownCount + doneCount}
                empty={showAll ? 'Nothing needs you on this computer.' : 'Nothing needs you right now.'}
                actions={attention && onScope ? (
                  <div className="flex items-center gap-2">
                    {readable.length > 0 && onMarkAllRead ? (
                      <Button type="button" variant="ghost" size="sm" data-slot="now-mark-all-read" onClick={() => onMarkAllRead(readable)}>
                        Mark all read
                      </Button>
                    ) : null}
                    <Segmented
                      slot="now-scope"
                      label="Show what needs you in"
                      value={scope}
                      onChange={onScope}
                      options={[
                        { value: 'project', label: 'This project' },
                        { value: 'all', label: `All ${attention.total}` },
                      ]}
                    />
                  </div>
                ) : undefined}
              >
                <ManagerProjectsContext.Provider value={referenceProjects}>
                {showAll && attentionActions ? (
                  groups.map((group) => (
                    <div key={group.key} data-slot="now-attention-group" className="flex flex-col gap-1.5">
                      <h3 className="px-1 pt-1 text-label font-medium text-muted-foreground">{group.label}</h3>
                      {group.items.map((item) => <AttentionRow key={item.key} item={item} actions={attentionActions} triage={triage} run={runOf(item)} hint={hintOnce()} />)}
                    </div>
                  ))
                ) : (
                  <>
                    {orderNeedsYou(
                      [
                        ...(attentionActions ? liveManagerRows.map((item) => ({ tier: KIND_TIER[item.kind], rank: KIND_RANK[item.kind], since: item.since, item })) : []),
                        ...liveTaskRows.map((entry) => ({ tier: REASON_TIER[entry.row.reason], rank: REASON_RANK[entry.row.reason], since: entry.row.since, entry })),
                      ],
                      attention?.olderAfterDays ?? 0,
                      at,
                    ).map((slot) => 'item' in slot ? (
                      <AttentionRow key={slot.item.key} item={slot.item} actions={attentionActions!} triage={triage} hint={hintOnce()} />
                    ) : (
                      <NeedsYouRowView key={slot.entry.row.run.id} row={slot.entry.row} onRetry={onRetry} projectId={projectId} target={slot.entry.target} triage={triage} hint={hintOnce()} />
                    ))}
                  </>
                )}
                {triage ? (
                  <ProbablyDoneGroup
                    count={doneCount}
                    onDismissAll={() => triage.dismissAll([...doneItems.map((item) => itemTarget(item, shortLabel(item.title))), ...doneTaskRows.map((entry) => entry.target)])}
                  >
                    {attentionActions ? doneItems.map((item) => (
                      <AttentionRow
                        key={item.key}
                        item={item}
                        actions={attentionActions}
                        triage={triage}
                        run={runOf(item)}
                        {...(showAll && item.projectId ? { source: projectLabel?.(item.projectId) ?? item.projectId } : {})}
                      />
                    )) : null}
                    {doneTaskRows.map(({ row, target, settled }) => (
                      <NeedsYouRowView key={row.run.id} row={row} onRetry={onRetry} projectId={projectId} target={target} triage={triage} settled={settled} />
                    ))}
                  </ProbablyDoneGroup>
                ) : null}
                </ManagerProjectsContext.Provider>
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
                    <IconTooltip label="Archive every finished task and free its worktree (branches kept; Continue restores one)">
                      <Button type="button" variant="ghost" size="sm" data-slot="archive-finished" onClick={onArchiveFinished}>
                        <ArchiveIcon className="size-3.5" aria-hidden="true" />
                        Archive all finished
                      </Button>
                    </IconTooltip>
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
        {managersAvailable ? null : <Link
          to="/new"
          data-slot="new-task-fab"
          aria-label="New task"
          className="fixed right-4 bottom-[calc(16px+var(--phone-bar,0px)+env(safe-area-inset-bottom))] z-20 inline-flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-modal md:hidden"
        >
          <PlusIcon className="size-[22px]" aria-hidden="true" />
        </Link>}
      </div>
    </LiveNowProvider>
  )
}

function Section({
  slot,
  title,
  count,
  shown = count,
  empty,
  actions,
  children,
}: {
  slot: string
  title: string
  count: number
  /** Rows on screen, when the count leaves some out (an uncounted failed task). */
  shown?: number
  empty: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section data-slot={`now-${slot}`} data-count={count} aria-labelledby={`now-${slot}-heading`} className="flex flex-col">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 id={`now-${slot}-heading`} className="eyebrow flex items-center gap-2 whitespace-nowrap text-soft-foreground">
          {title}
          <span className="rounded-full bg-muted px-1.5 font-mono text-micro font-medium tracking-normal text-foreground tabular-nums normal-case">
            {count}
          </span>
        </h2>
        <div className="flex-1" />
        {actions}
      </div>
      {shown === 0 ? (
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

function NeedsYouRowView({
  row,
  onRetry,
  projectId,
  target,
  triage,
  settled,
  hint = false,
}: {
  row: NeedsYouRow
  onRetry: (run: RunRecord) => Promise<unknown>
  /** This project, for the row's shareable link. */
  projectId?: string | undefined
  target?: TriageTarget
  triage?: TriageActions | undefined
  /** In Probably done: why. */
  settled?: AttentionSettled | undefined
  hint?: boolean
}) {
  const { run } = row
  const reference = taskReference(run)
  const cost = formatCost(run.costUsd)
  const to = `/tasks/${run.id}`
  const menu = useRowMenu()
  const triaged = triage && target ? { triage, target } : undefined
  const article = (
    <article
      data-slot="now-row"
      data-run-id={run.id}
      data-reason={row.reason}
      data-settled={settled ? settled.why : undefined}
      onContextMenu={triaged ? menu.onContextMenu : undefined}
      className={cn(
        ROW_CLASS,
        'group/row',
        settled ? 'border-border bg-card/60' : row.reason === 'failed' ? 'border-danger/45' : 'border-info/50',
      )}
    >
      <StatusDot tone={settled ? 'neutral' : row.tone} pulse={settled ? false : row.pulse} className="mt-1.5 md:mt-0" aria-label={row.label} />
      <div className="min-w-0">
        <Link to={to} className={cn('block truncate text-ui font-medium', settled ? 'text-muted-foreground' : 'text-foreground')}>
          {runTitle(run)}
        </Link>
        <div data-slot="now-why" className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-label text-muted-foreground">
          {settled ? <SettledReason settled={settled} /> : null}
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
      <div className="col-start-2 flex items-center gap-1 md:col-start-auto">
        {settled && triaged ? (
          <Button type="button" size="sm" variant="ghost" data-slot="now-keep" onClick={() => triaged.triage.keep(triaged.target)}>
            Still needs me
          </Button>
        ) : (
          <RowAction row={row} onRetry={onRetry} />
        )}
        {triaged ? (
          <>
            <DismissButton target={triaged.target} actions={triaged.triage} />
            <TriageMenu
              target={triaged.target}
              actions={triaged.triage}
              href={row.action === 'answer' ? `/tasks/${run.id}#ask` : to}
              {...(projectId ? { copyHref: taskPath(projectId, run.id) } : {})}
              run={run}
              settled={settled}
              open={menu.open}
              onOpenChange={menu.setOpen}
            />
          </>
        ) : null}
      </div>
    </article>
  )
  return triaged ? <SwipeRow target={triaged.target} actions={triaged.triage} hint={hint}>{article}</SwipeRow> : article
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
  const unread = isUnread(run)
  const attention = deriveAttention(run)
  const statusId = React.useId()
  return (
    <article
      data-slot="now-row"
      data-run-id={run.id}
      data-kind="finished"
      className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-x-3 px-3.5 py-1.5 md:grid-cols-[16px_minmax(0,1fr)_auto_auto] md:gap-x-3.5"
    >
      {/* Done, cancelled and idle all land here: the shape tells them apart (WCAG 1.4.1). */}
      <StatusMark attention={attention} />
      {/* Unread is weight, plus the word for a screen reader (#unread-done-items) — the table's rule. */}
      <Link
        to={`/tasks/${run.id}`}
        aria-describedby={statusId}
        data-unread={unread || undefined}
        className={cn(
          'min-w-0 truncate text-ui hover:text-foreground',
          unread ? 'font-semibold text-foreground' : 'text-muted-foreground',
        )}
      >
        {runTitle(run)}
        <StatusDescription id={statusId} attention={attention} />
        {unread ? <UnreadMarker /> : null}
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

/** `{ nowScope }` in a navigation's state, from the bottom bar's quick actions. */
export function nowScopeFromState(state: unknown): NowScope | undefined {
  const value = (state as { nowScope?: unknown } | null)?.nowScope
  return value === 'all' || value === 'project' ? value : undefined
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
  const archive = useMutation({ mutationFn: () => archiveFinished(), onSuccess: invalidate })
  // An empty Continue is the footer's one-click retry; the idle-teardown retry window is the
  // ask card's (ask-answer.ts) — a stale row can hit `run is still active` a beat too early.
  const retry = useMutation({
    mutationFn: (run: RunRecord) => resumeAfterIdleTeardown(() => continueRun(run.id)),
    onSuccess: invalidate,
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  // Scheduled starts — the table route's own gate and query (#1340): the composer lands here after
  // scheduling, so the strip must be here too.
  const automationsGate = useAutomationsGate()
  const scheduledGate = useScheduledTasksGate()
  const automations = useAutomationsQuery(automationsGate.known && !automationsGate.off && scheduledGate)
  const hasScheduledTasks = !!automations.data?.automations.some((entry) => entry.deferredStart)
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
  // Variant D (spec 2026-11-20-phone-notifications-inbox): Needs you reads the attention list.
  const attention = useAttention()
  const managersOn = health.data?.capabilities?.managers === true
  const managers = useManagers(managersOn)
  const [scope, setScope] = React.useState<NowScope>(readNowScope)
  // The bottom bar's "Needs you — all projects" quick action hands the scope over in history state,
  // once: it is cleared from the entry so Back or a reload keeps the user's later choice.
  const location = useLocation()
  // The router's own navigate: `location.pathname` is already project-prefixed.
  const navigate = useRouterNavigate()
  const askedScope = nowScopeFromState(location.state)
  React.useEffect(() => {
    if (askedScope === undefined) return
    setScope(askedScope)
    saveNowScope(askedScope)
    const rest: Record<string, unknown> = { ...(location.state as Record<string, unknown>) }
    delete rest.nowScope
    void navigate({ pathname: location.pathname, search: location.search, hash: location.hash }, { replace: true, state: Object.keys(rest).length > 0 ? rest : null })
  }, [askedScope, location, navigate])
  const here = activeProjectId ?? health.data?.bootProject
  const managerConnected = React.useCallback(
    (managerId: string) => here !== undefined && (managers.data?.managers.find((manager) => manager.id === managerId)?.connectedProjectIds.includes(here) ?? false),
    [managers.data, here],
  )
  const projectLabel = React.useCallback(
    (id: string) => health.data?.projects?.find((project) => project.id === id)?.name ?? id,
    [health.data],
  )
  const { attentionActions, triage, pendingQuestions, referenceProjects, stopDialog } = useNeedsYouActions()
  const onMarkAllRead = React.useCallback((items: AttentionItem[]) => {
    void Promise.allSettled(items.map((item) => attentionActions.markRead(item))).then((results) => {
      if (results.some((result) => result.status === 'rejected')) toast('Some items could not be marked read', { tone: 'danger' })
    })
  }, [attentionActions])
  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <NowView
        attention={attention.data ? { items: attention.data.items, total: attention.data.counts.total, overrides: attention.data.overrides, olderAfterDays: attention.data.olderAfterDays } : undefined}
        triage={triage}
        projectId={here}
        pendingQuestions={pendingQuestions}
        referenceProjects={referenceProjects}
        scope={scope}
        onScope={(next) => { setScope(next); saveNowScope(next) }}
        managerConnected={managerConnected}
        projectLabel={projectLabel}
        attentionActions={attentionActions}
        onMarkAllRead={onMarkAllRead}
        runs={runs.data}
        projectName={projectName}
        onArchiveFinished={() => archive.mutate()}
        onRetry={onRetry}
        firstRun={<FirstRun gitRepo={repo.data ? repo.data.info !== null : repo.isError ? true : undefined} />}
        scheduledTasks={<ScheduledTasks enabled={scheduledGate} />}
        hasScheduledTasks={hasScheduledTasks}
        setupPill={<SetupPill />}
        welcomeBack={<WelcomeBack runs={runs.data ?? NO_RUNS} />}
        managersAvailable={health.data?.capabilities?.managers === true}

      />
      {stopDialog}
    </ReferenceStatusProvider>
  )
}
