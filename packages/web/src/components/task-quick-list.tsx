import { ChevronDownIcon, ScaleIcon } from 'lucide-react'
import * as React from 'react'
import { useHealth, useReferenceProjectId, useRuns } from '@/api/queries'
import { Link, scopeTo, useProjectMatch } from '@/lib/project-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { useListView } from '@/components/list-view'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { isReadDoneItem, isUnread } from '@/lib/read-state'
import { directionalUsageText } from '@/components/directional-usage'
import {
  groupRuns,
  listCounts,
  refPrefixMatches,
  runTitle,
  splitRefPrefix,
  type ListView,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { formatCost, taskReference } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn } from '@/lib/utils'

/**
 * The sidebar's task quick-list (spec, "App shell & navigation"): Active/Archived tabs, then the
 * runs grouped Needs you / Working / Recent, with variant groups collapsed into one tile.
 *
 * Presentational — every decision it paints (which bucket, which order, which dot, whether a
 * group collapses) is made by `lib/task-groups.ts` and `lib/attention.ts`, which are pure and
 * table-tested. What is left here is markup, the router, and the expand/collapse toggle.
 */
export function TaskQuickList({
  runs,
  view,
  onViewChange,
  currentRunId = null,
  now = Date.now(),
  showTokens = true,
  showCost = true,
}: {
  runs: RunRecord[]
  view: ListView
  onViewChange: (view: ListView) => void
  /** The run open at `/tasks/:id`, so its row can show as active. */
  currentRunId?: string | null
  /** Injected so the ages are not racing the clock in tests. */
  now?: number
  /** Presentation capability; defaults visible for older health responses and direct renders. */
  showTokens?: boolean
  showCost?: boolean
}) {
  const counts = listCounts(runs)
  const buckets = groupRuns(runs, view)

  return (
    <div data-slot="quick-list">
      {/* Sticky, not scrolled away: the tabs say what you are looking at, and a long Recent list
          must not be able to hide that the view is filtered. */}
      <div className="sticky top-0 z-10 bg-sidebar pt-2 pb-1">
        <div className="inline-flex w-full gap-0.5 rounded-md bg-muted p-[3px]">
          <ViewTab view="active" current={view} onSelect={onViewChange} count={counts.active}>
            Active
            {/* The one reason to look at a tab you are not on. */}
            {counts.waiting > 0 && view !== 'active' ? (
              <StatusDot tone="pending" pulse data-slot="waiting-dot" aria-label="needs you" />
            ) : null}
          </ViewTab>
          <ViewTab view="archived" current={view} onSelect={onViewChange} count={counts.archived}>
            Archived
          </ViewTab>
        </div>
      </div>

      {buckets.length === 0 ? (
        <p className="px-3 py-3.5 text-xs text-soft-foreground">
          {view === 'archived' ? 'Nothing archived yet.' : 'No tasks yet — describe one.'}
        </p>
      ) : (
        <QuickListBuckets
          buckets={buckets}
          currentRunId={currentRunId}
          now={now}
          showTokens={showTokens}
          showCost={showCost}
        />
      )}
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
}: {
  buckets: QuickListBucket[]
  currentRunId?: string | null
  now?: number
  scope?: string | null
  showTokens?: boolean
  showCost?: boolean
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
        <div key={bucket.label} data-slot="quick-list-bucket" data-bucket={bucket.label}>
          <h2 className="px-3 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.04em] text-soft-foreground uppercase">
            {bucket.label}
          </h2>
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

function ViewTab({
  view,
  current,
  onSelect,
  count,
  children,
}: {
  view: ListView
  current: ListView
  onSelect: (view: ListView) => void
  count: number
  children: React.ReactNode
}) {
  const isActive = view === current
  return (
    <button
      type="button"
      data-slot="view-tab"
      data-view={view}
      // Toggle buttons rather than a real tablist: these filter one list in place, they do not
      // switch between panels — `aria-pressed` is what that actually is.
      aria-pressed={isActive}
      onClick={() => onSelect(view)}
      className={cn(
        'flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[7px] text-[12.5px] font-medium text-muted-foreground',
        isActive && 'bg-card font-semibold text-foreground shadow-xs'
      )}
    >
      {children}
      {/* No "0": an empty bucket says so by being empty. */}
      {count > 0 ? <span className="font-mono text-[11px] tabular-nums">{count}</span> : null}
    </button>
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
      ? `#${queuePosition}`
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
        'flex items-center gap-2 rounded-sm pl-2.5 hover:bg-muted',
        isActive && 'bg-muted',
        // The indent a member row wears under an expanded group tile. One padding declaration,
        // not two: `cn` is tailwind-merge, so this REPLACES the `pl-2.5` above rather than losing
        // to it — 26px = the row's own 10px plus the 16px indent.
        variant && 'pl-[26px]'
      )}
    >
      {/* Outside the Link so it can lead the reference chip. The dot is a status indicator, not a
          navigation target, and the wrapper still owns the row's hover surface. */}
      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
      {/* The reference, ONCE (#788, option C): the number that used to be both a `775: ` title
          prefix and a trailing `PR ↗` chip is now one leading chip that is itself the link. */}
      {reference ? (
        <TaskReferenceChip
          run={run}
          reference={reference}
          compact
          className="h-auto shrink-0 gap-[2px] px-1.5 py-px text-[10.5px]"
        />
      ) : null}
      <Link
        to={scopeTo(scope, `/tasks/${run.id}`)}
        // `title` carries the FULL stored title — including a `NNN: ` prefix the chip let the
        // visible text drop — so hover always gives back everything the column could not show.
        title={title}
        aria-current={isActive ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 py-[7px] pr-2.5"
      >
        {variant ? (
          <span className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-violet/15 font-mono text-[9.5px] font-semibold text-violet">
            {run.variant ?? '?'}
          </span>
        ) : null}
        <span
          data-slot="task-row-title"
          className={cn(
            // `min-w-[7rem]`: the floor of the width-priority rule above. The title never gives
            // way past ~17 characters; metadata drops instead.
            'min-w-[7rem] flex-1 truncate text-[13px]',
            unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium'
          )}
        >
          {variant ? variantLabel(run, showTokens, showCost) : displayTitle}
        </span>
        {/* The diff numbers, once a turn has produced any (R2 #389). Nothing before that — a
            sidebar row has no column to hold an em dash open for.

            Droppable metadata, per the width-priority rule: `+59514 −12160` is ~82px, which a
            264px column cannot spend and still name the task, and its exact numbers stay in the
            `title` tooltip and in the Tasks table's ± column either way.

            23rem is not the width at which the pair merely *fits* — it is the width at which it
            fits AND the name is still at least as long as it was in the default 264px column
            (measured: 146px of title at 23rem vs 132px at 264px). Anything narrower buys the
            numbers back by making the task names shorter than they were before the drag, which
            is precisely the bargain this issue exists to stop making. */}
        {run.diffStat ? (
          <DiffStatLabel
            stat={run.diffStat}
            className="hidden shrink-0 text-[10.5px] @min-[23rem]/sidebar:inline"
          />
        ) : null}
        {/* The reference chip takes the AGE's slot when there is one — same as the mockup, and
            the same trade as before: a row that knows its PR or issue number is identified by
            that, not by how long ago it finished.

            It never takes the QUEUE POSITION's slot. `#2` is not an age, it is where the engine
            will pick this run up, it is carried nowhere else in the row, and a queued run is
            exactly the kind that has an issue reference and no PR yet — so keying this on "has a
            reference" alone would have silently deleted the queue position from every
            issue-driven queued row. */}
        {age && (queuePosition !== null || !reference) ? (
          <span className="shrink-0 text-[11px] text-soft-foreground tabular-nums">{age}</span>
        ) : null}
        {/* The unread marker (#unread-done-items): a trailing violet dot, opposite end and
            different hue from the leading status dot, so the two read as two signals. */}
        {unread ? (
          <StatusDot
            tone="violet"
            role="img"
            aria-label="unread"
            title="Unread — not opened since it finished"
            className="ml-0.5 shrink-0"
          />
        ) : null}
      </Link>
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
  return parts.join(' · ')
}

/**
 * The quick-list wired to live data: `useRuns()` for the list (kept fresh by the global SSE
 * stream, Step 3.2), the router for which row is open, and the shared Active/Archived context so
 * the sidebar and the Tasks table (Step 3.4) always show the same filter.
 */
export function TaskQuickListContainer() {
  const runs = useRuns()
  const health = useHealth()
  const visibility = usageMetricVisibility(health.data)
  const [view, setView] = useListView()
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
        view={view}
        onViewChange={setView}
        // Both matches: `/tasks/:id` and its `/changes` and `/files` children all keep the row lit.
        currentRunId={match?.params.id ?? exact?.params.id ?? null}
        now={now}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
      />
    </ReferenceStatusProvider>
  )
}
