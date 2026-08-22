import { ArchiveIcon, CheckCheckIcon, ChevronDownIcon, EllipsisIcon, ScaleIcon } from 'lucide-react'
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { archiveFinished, markAllRunsSeen } from '@/api/client'
import { queryKeys, useHealth, useProjects, useReferenceProjectId, useRuns, useRunsIndex } from '@/api/queries'
import { toast } from '@/components/ui/toaster'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Link, scopeTo, useActiveProjectId, useProjectMatch } from '@/lib/project-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread } from '@/lib/read-state'
import { directionalUsageText } from '@/components/directional-usage'
import {
  groupRuns,
  refPrefixMatches,
  runTitle,
  splitRefPrefix,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { formatCost, taskReference } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The sidebar's task quick-list (spec, "App shell & navigation"): the live runs as ONE flat,
 * Claude-sessions-style list — ordered needs-you → working → recent, status carried by each
 * row's dot, variant groups collapsed into one tile. The archive lives only on the Tasks page.
 *
 * Presentational — every decision it paints (which bucket, which order, which dot, whether a
 * group collapses) is made by `lib/task-groups.ts` and `lib/attention.ts`, which are pure and
 * table-tested. What is left here is markup, the router, and the expand/collapse toggle.
 */
export function TaskQuickList({
  runs,
  currentRunId = null,
  now = Date.now(),
  showTokens = true,
  showCost = true,
}: {
  runs: RunRecord[]
  /** The run open at `/tasks/:id`, so its row can show as active. */
  currentRunId?: string | null
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
}) {
  // ONE flat list, Claude-sessions style (user decision): no Active row, no RECENT label, no
  // bucket headings — just the live tasks under a small TASKS cap. The grouping still ORDERS
  // the rows (needs-you first, then working, then recent) and each row's status dot carries
  // what the headings used to say. The archive lives only behind the Tasks page's own tab.
  const buckets = groupRuns(runs, 'active')

  return (
    <div data-slot="quick-list">
      <div className="flex flex-col gap-0.5 pb-0.5">
        {buckets.length === 0 ? (
          <p className="px-3 py-2 text-xs text-soft-foreground">No tasks yet — describe one.</p>
        ) : (
          <QuickListBuckets
            buckets={buckets}
            currentRunId={currentRunId}
            now={now}
            showTokens={showTokens}
            showCost={showCost}
            headings={false}
          />
        )}
      </div>
    </div>
  )
}

/**
 * The bucketed rows alone — the piece the multi-project sidebar reuses per project group
 * (step 3.3), without the Active/Archived tabs that belong to the boot list's framing.
 *
 * `scope` prefixes every row target with an EXPLICIT `/p/<id>` (a non-active project's rows
 * must land in that project); `null` keeps the wrapper-Link default — the active scope.
 */
export function QuickListBuckets({
  buckets,
  currentRunId = null,
  now = Date.now(),
  scope = null,
  showTokens = true,
  showCost = true,
  headings = true,
}: {
  buckets: QuickListBucket[]
  currentRunId?: string | null
  now?: number
  scope?: string | null
  showTokens?: boolean
  showCost?: boolean
  /** `false` renders the buckets as ONE continuous flat list (the boot sidebar's
   *  Claude-sessions style) — the grouping still orders the rows, it just stops labelling. */
  headings?: boolean
}) {
  // Which variant groups are open. Local: it is view state about this list, nothing else reads it.
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(() => new Set())
  const toggleGroup = (groupId: string) =>
    setExpanded((current) => {
      const next = new Set(current)
      if (!next.delete(groupId)) next.add(groupId)
      return next
    })

  return (
    <>
      {buckets.map((bucket) => (
        <div
          key={bucket.label}
          data-slot="quick-list-bucket"
          data-bucket={bucket.label}
          // Uniform rhythm: the group separator supplies the space above the FIRST bucket;
          // siblings space themselves identically. Flat mode drops the gaps with the labels.
          className={cn(headings && 'mt-3 first:mt-0')}
        >
          {headings ? (
            <h2 className="px-3 pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
              {bucket.label}
            </h2>
          ) : null}
          {bucket.rows.map((row) => (
            <Row
              key={row.kind === 'group' ? row.groupId : row.run.id}
              row={row}
              currentRunId={currentRunId}
              now={now}
              scope={scope}
              showTokens={showTokens}
              showCost={showCost}
              expanded={row.kind === 'group' && expanded.has(row.groupId)}
              onToggle={toggleGroup}
            />
          ))}
        </div>
      ))}
    </>
  )
}


function Row({
  row,
  currentRunId,
  now,
  scope,
  expanded,
  onToggle,
  showTokens,
  showCost,
}: {
  row: QuickListRow
  currentRunId: string | null
  now: number
  scope: string | null
  expanded: boolean
  onToggle: (groupId: string) => void
  showTokens: boolean
  showCost: boolean
}) {
  if (row.kind === 'run') {
    return (
      <RunRow
        run={row.run}
        queuePosition={row.queuePosition}
        currentRunId={currentRunId}
        now={now}
        scope={scope}
        showTokens={showTokens}
        showCost={showCost}
      />
    )
  }
  return (
    <>
      {/* Like RunRow: the compare link is the toggle button's flex SIBLING, not its child —
          a link inside a button is invalid, and both targets are real. */}
      <div className="flex items-center rounded-sm hover:bg-muted">
        <button
          type="button"
          data-slot="group-tile"
          data-group-id={row.groupId}
          aria-expanded={expanded}
          onClick={() => onToggle(row.groupId)}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-[7px] text-left"
        >
          <ChevronDownIcon
            className={cn('size-3 shrink-0 text-soft-foreground transition-transform', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
          {/* Same width-priority rule as `RunRow`: the shared title has a floor, and the `×N`
              badge and the compare link give way before it does. */}
          <span className="min-w-[7rem] flex-1 truncate text-[13px] font-medium">{row.title}</span>
          <span className="shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10.5px] font-semibold text-muted-foreground">
            ×{row.members.length}
          </span>
        </button>
        <Link
          to={scopeTo(scope, `/compare/${row.groupId}`)}
          data-slot="group-compare"
          title="Compare the variants"
          aria-label={`Compare the variants of ${row.title}`}
          className="mr-1.5 inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground hover:bg-violet/10 hover:text-violet"
        >
          <ScaleIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {expanded
        ? row.members.map((member) => (
            <RunRow
              key={member.id}
              run={member}
              queuePosition={null}
              currentRunId={currentRunId}
              now={now}
              scope={scope}
              variant
              showTokens={showTokens}
              showCost={showCost}
            />
          ))
        : null}
    </>
  )
}

/**
 * One run.
 *
 * The row is a `<Link>` and the reference chip is its flex *sibling*, not its child: an anchor
 * inside an anchor is invalid, and both targets are real — the row opens the task, the chip opens
 * the PR or issue. The status dot is a sibling too, so the reading order can be dot → chip →
 * title rather than a chip wedged in front of the status it is not about.
 *
 * WIDTH-PRIORITY RULE (#788, option C) — read this before adding anything to this row.
 * The column is 264px by default and the title is the ONLY thing here a person scans for, so:
 *
 *  1. The title is the only element allowed to GROW (`flex-1`) and it has a floor
 *     (`min-w-[7rem]`, replacing the `min-w-0` that let it be squeezed to nothing) that no other
 *     element may push it below.
 *  2. Every other element is metadata and must be DROPPABLE beneath that floor. The mechanism is
 *     the `@container/sidebar` the app shell declares: metadata that does not fit a narrow column
 *     is hidden by a container query and comes back when the user drags the column wider.
 *  3. Anything a dropped element was the only carrier of has to survive somewhere reachable —
 *     the diff numbers keep their `title` tooltip, the reference keeps its own chip.
 *
 * Before this rule the title was the sole compressible item in a row of `shrink-0` metadata, so
 * it absorbed 100% of any deficit — which is how `775: i…` happened.
 */
function RunRow({
  run,
  queuePosition,
  currentRunId,
  now,
  scope,
  variant = false,
  showTokens,
  showCost,
}: {
  run: RunRecord
  queuePosition: number | null
  currentRunId: string | null
  now: number
  /** Explicit `/p/<id>` link scope for a non-active project's row; null = the active scope. */
  scope: string | null
  /** A member row under an expanded group tile: indented, letter-chipped, and labelled with what
   *  actually distinguishes the variants (runner and spend) rather than the shared title. */
  variant?: boolean
  showTokens: boolean
  showCost: boolean
}) {
  const attention = deriveAttention(run)
  const isActive = run.id === currentRunId
  // The strongest tracker reference the run knows about — the PR once one exists, else the issue
  // it was opened on. It is the row's leading chip AND the reason the title may drop its `NNN: `
  // prefix (#788, option C): the number is painted once, as a link, instead of twice as digits.
  const reference = taskReference(run)
  const title = runTitle(run)
  // Only when the two numbers are the same number — see `refPrefixMatches`. A run opened on issue
  // #788 that shipped as PR #790 keeps its prefix, because the chip is no longer saying it.
  const displayTitle = refPrefixMatches(title, reference?.number) ? splitRefPrefix(title).rest : title
  // Read/unread (#unread-done-items, "Option B"): an unread done item is promoted (bright +
  // semibold) and wears a trailing violet dot; a read one dims so the history steps back. Both
  // are orthogonal to the leading status dot, which keeps saying done/failed.
  const unread = isUnread(run)
  const readDone = isReadDoneItem(run)
  // A variant row spends its width on what distinguishes the variants (runner and spend) rather
  // than on an age they all share — they started together. Per the mockup.
  const age = variant
    ? ''
    : queuePosition !== null
      ? `queue #${queuePosition}`
      : shortAge(run.finishedAt ?? run.createdAt, now)

  return (
    <div
      data-slot="task-row"
      data-run-id={run.id}
      // The row's highlight is a wrapper concern (the dot and the reference chip sit outside the
      // Link), so the active state has to be readable here rather than only from the Link's
      // `aria-current`.
      data-active={isActive ? 'true' : undefined}
      className={cn(
        // Plain rows on the sidebar ground — a white surface only on HOVER. Even the open task
        // stays flat (a resting card here re-tinted the column); `aria-current` on the link and
        // the thread being open are what say "this one".
        'flex min-h-11 items-start gap-2 rounded-sm pl-3 hover:bg-card',
        // The indent a member row wears under an expanded group tile. One padding declaration,
        // not two: `cn` is tailwind-merge, so this REPLACES the `pl-2.5` above rather than losing
        // to it — 26px = the row's own 10px plus the 16px indent.
        variant && 'pl-[26px]'
      )}
    >
      {/* Outside the Link so it can lead the reference chip. The dot is a status indicator, not a
          navigation target, and the wrapper still owns the row's hover surface. */}
      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" className="mt-[12px]" />
      {/* Two lines, ONE anchor: the title line is the row's link; the meta line sits beside it
          as a sibling because the reference chip is itself a link, and an anchor inside an
          anchor is invalid HTML. The wrapper still paints the hover for both. */}
      <span className={cn('flex min-w-0 flex-1 flex-col gap-[3px] pr-2.5', variant ? 'py-[7px]' : 'py-[6px]')}>
        <Link
          to={scopeTo(scope, `/tasks/${run.id}`)}
          // `title` carries the FULL stored title — including a `NNN: ` prefix the chip let the
          // visible text drop — so hover always gives back everything the column could not show.
          title={title}
          aria-current={isActive ? 'page' : undefined}
          className="flex min-w-0 items-center gap-2"
        >
          {variant ? (
            <span className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-violet/15 font-mono text-[9.5px] font-semibold text-violet">
              {run.variant ?? '?'}
            </span>
          ) : null}
          <span
            data-slot="task-row-title"
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-[1.3]',
              unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
            )}
          >
            {variant ? variantLabel(run, showTokens, showCost) : displayTitle}
          </span>
          {/* The unread marker (#unread-done-items): a trailing violet dot, opposite end and
              different hue from the leading status dot, so the two read as two signals. */}
          {unread ? (
            <StatusDot
              tone="violet"
              role="img"
              aria-label="unread"
              className="size-[6px] shrink-0"
            />
          ) : null}
        </Link>
        {/* The META line (Devin-style two-line row): age or queue slot, then the reference with
            its live status in its own tone, then the diff pair where the column affords it.
            Space separates, never a glyph (house style). A variant row has no meta of its own —
            its first line already says what distinguishes it. */}
        {!variant ? (
          <span data-slot="task-row-meta" className="flex min-w-0 items-center gap-2.5 text-[11px] leading-none text-soft-foreground">
            {age ? <span className="shrink-0 tabular-nums">{age}</span> : null}
            {reference ? (
              <TaskReferenceChip
                run={run}
                reference={reference}
                compact
                // De-pilled for the sidebar: plain mono text that keeps its STATUS tone (open,
                // merged, failing) — the one colour on the meta line, and it means something.
                className="h-auto shrink-0 gap-[3px] rounded-none border-0 px-0 py-0 text-[10.5px] font-medium"
              />
            ) : null}
            {run.diffStat ? (
              <DiffStatLabel stat={run.diffStat} className="hidden shrink-0 @min-[20rem]/sidebar:inline" />
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  )
}

/** A variant row's subtitle: what differs between A and B — the backend and what it has spent.
 *  `runner` is absent on records predating the choice; those are Claude by definition. */
function variantLabel(run: RunRecord, showTokens: boolean, showCost: boolean): string {
  const parts: string[] = [run.runner ?? 'claude']
  if (showTokens && (run.inputTokens !== undefined || run.outputTokens !== undefined)) {
    parts.push(directionalUsageText(run.inputTokens, run.outputTokens))
  }
  const cost = formatCost(run.costUsd)
  if (showCost && cost) parts.push(cost)
  return parts.join(', ')
}

/** A cross-project row is worth sidebar space only while it can still ask for a human:
 *  live, waiting, or failed. Finished work in other repos belongs to the All-tasks page. */
function needsSupervision(entry: { status: RunRecord['status'] }): boolean {
  return entry.status !== 'done' && entry.status !== 'cancelled'
}

/** Needs-you outranks merely-running; a usage-limit `failed` with an appointment is parked,
 *  not broken, so it sorts with the live ones (same rule as `deriveAttention`). */
function needsYou(entry: { status: RunRecord['status']; autoResumeAt?: string }): boolean {
  if (entry.status === 'waiting' || entry.status === 'review') return true
  return entry.status === 'failed' && !entry.autoResumeAt
}

/**
 * The parallel-work band (user decision, 25-repo review follow-up): tasks from OTHER projects
 * that are live or waiting on a human, under the active project's own list. This is what makes
 * supervising agents across repos possible without switching — the sidebar names every place
 * that needs eyes, and a click lands in that project's thread.
 *
 * Renders nothing when every other project is quiet: the band is a signal, not a fixture.
 */
export function CrossProjectTasks({ activeProjectId, now = Date.now() }: { activeProjectId: string | null; now?: number }) {
  const index = useRunsIndex(true)
  const registry = useProjects().data
  // An unscoped URL still MEANS the boot project — its runs are the quick list above, so they
  // must not repeat here as "other".
  const excludedId = activeProjectId ?? registry?.bootProject ?? null
  const rows = React.useMemo(() => {
    const entries = (index.data?.runs ?? []).filter(
      (entry) => entry.projectId !== excludedId && !entry.archived && needsSupervision(entry),
    )
    return entries.sort((a, b) => {
      const attention = Number(needsYou(b)) - Number(needsYou(a))
      if (attention !== 0) return attention
      return (b.startedAt ?? b.createdAt).localeCompare(a.startedAt ?? a.createdAt)
    })
  }, [index.data, excludedId])

  if (rows.length === 0) return null
  const projectName = (id: string) => registry?.projects.find((project) => project.id === id)?.name ?? id

  return (
    <div data-slot="cross-project-tasks">
      <hr aria-hidden="true" className="mx-2.5 mt-3 mb-2 border-border" />
      <h2 className="px-3 pb-1 text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        Other projects
      </h2>
      <div className="flex flex-col gap-0.5">
        {rows.map((entry) => {
          const attention = deriveAttention(entry)
          return (
            <Link
              key={`${entry.projectId}/${entry.id}`}
              to={scopeTo(entry.projectId, `/tasks/${entry.id}`)}
              data-slot="cross-project-row"
              data-project-id={entry.projectId}
              title={`${projectName(entry.projectId)}: ${runTitle(entry)}`}
              className="flex min-h-11 items-center gap-2 rounded-md py-[7px] pr-2.5 pl-3 transition-colors hover:bg-card md:min-h-9"
            >
              <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
              {/* The project is the row's leading identifier here — which repo needs you is the
                  question this band answers; the task title elaborates. */}
              <span className="max-w-[12ch] shrink-0 truncate font-mono text-[10.5px] font-medium text-soft-foreground">
                {projectName(entry.projectId)}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-muted-foreground">
                {runTitle(entry)}
              </span>
              <span className="shrink-0 text-[10.5px] text-soft-foreground tabular-nums">
                {shortAge(entry.startedAt ?? entry.createdAt, now)}
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The Recent header's overflow (Devin-style): the two list-wide verbs the Tasks page has always
 * owned, so the sidebar can tidy the list without a trip to the table. Rendered by the shell's
 * header through the `listMenu` slot — the shell owns the header, this owns the mutations.
 */
export function RecentListMenu() {
  const queryClient = useQueryClient()
  const archive = useMutation({
    mutationFn: archiveFinished,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  const markAllRead = useMutation({
    mutationFn: markAllRunsSeen,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.runs.all }),
    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
  })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-slot="recent-menu"
          aria-label="List actions"
          title="List actions"
          className="flex size-6 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <EllipsisIcon className="size-3.5" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[11rem]">
        <DropdownMenuItem onSelect={() => markAllRead.mutate()}>
          <CheckCheckIcon aria-hidden="true" /> Mark all read
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => archive.mutate()}>
          <ArchiveIcon aria-hidden="true" /> Archive finished
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The quick-list wired to live data: `useRuns()` for the list (kept fresh by the global SSE
 * stream, Step 3.2), the router for which row is open, and the shared Active/Archived context so
 * the sidebar and the Tasks table (Step 3.4) always show the same filter.
 */
export function TaskQuickListContainer({ crossProject = false }: { crossProject?: boolean } = {}) {
  const runs = useRuns()
  const activeProjectId = useActiveProjectId()
  const health = useHealth()
  const visibility = usageMetricVisibility(health.data)
  // Project-prefix-agnostic matches (step 3.2): `/p/<id>/tasks/:id` must light its row too.
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const now = useNow(30_000)
  // The sidebar's chips are the same chips as the tables', so they get their status the same way:
  // one batched request for the whole list, mounted here where the list is.
  const projectId = useReferenceProjectId()
  const referenceRequests = React.useMemo(
    () =>
      projectId === undefined
        ? []
        : (runs.data ?? []).flatMap((run) => {
            const reference = taskReference(run)
            return reference ? [{ projectId, kind: reference.kind, number: reference.number }] : []
          }),
    [runs.data, projectId],
  )

  // Nothing at all until the list has answered: a skeleton here would be inventing rows, and an
  // empty state would claim "No tasks yet" before we know whether there are any.
  if (!runs.data) return null

  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TaskQuickList
        runs={runs.data}
        // Both matches: `/tasks/:id` and its `/changes` and `/files` children all keep the row lit.
        currentRunId={match?.params.id ?? exact?.params.id ?? null}
        now={now}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
      />
      {/* The parallel-work band (multi-project only): what OTHER repos need eyes on, under this
          project's own list. */}
      {crossProject ? <CrossProjectTasks activeProjectId={activeProjectId} now={now} /> : null}
    </ReferenceStatusProvider>
  )
}
