import { ChevronDownIcon, ScaleIcon } from 'lucide-react'
import * as React from 'react'
import { useHealth, useRuns } from '@/api/queries'
import { Link, scopeTo, useProjectMatch } from '@/lib/project-router'
import type { RunRecord } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { useListView } from '@/components/list-view'
import { ReferenceChip } from '@/components/reference-chip'
import { StatusDot } from '@/components/status-dot'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { directionalUsageText } from '@/components/directional-usage'
import {
  groupRuns,
  listCounts,
  runTitle,
  type ListView,
  type QuickListBucket,
  type QuickListRow,
} from '@/lib/task-groups'
import { formatCost, prNumber, taskPrUrl } from '@/lib/tasks-table'
import { usageMetricVisibility } from '@/lib/token-metrics'
import { useNow } from '@/lib/use-now'
import { cn, isHttpUrl } from '@/lib/utils'

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
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.title}</span>
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
 * The row is a `<Link>` and the PR chip is its flex *sibling*, not its child: an anchor inside an
 * anchor is invalid, and both targets are real — the row opens the task, the chip opens the PR.
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
  const prUrl = taskPrUrl(run)
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
      // The row's highlight is a wrapper concern (the PR chip sits outside the Link), so the
      // active state has to be readable here rather than only from the Link's `aria-current`.
      data-active={isActive ? 'true' : undefined}
      className={cn(
        'flex items-center rounded-sm hover:bg-muted',
        isActive && 'bg-muted',
        variant && 'pl-4'
      )}
    >
      <Link
        to={scopeTo(scope, `/tasks/${run.id}`)}
        // The row's accessible name is the title; `title` gives the full text back when the CSS
        // truncates it, which for a one-line 264px column is most of the time.
        title={runTitle(run)}
        aria-current={isActive ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-[7px]"
      >
        {variant ? (
          <span className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-violet/15 font-mono text-[9.5px] font-semibold text-violet">
            {run.variant ?? '?'}
          </span>
        ) : null}
        <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
          {variant ? variantLabel(run, showTokens, showCost) : runTitle(run)}
        </span>
        {/* The diff numbers, once a turn has produced any (R2 #389). Nothing before that — a
            sidebar row has no column to hold an em dash open for. */}
        {run.diffStat ? <DiffStatLabel stat={run.diffStat} className="shrink-0 text-[10.5px]" /> : null}
        {/* The PR chip takes the age's slot when there is one — same as the mockup. */}
        {prUrl || !age ? null : (
          <span className="shrink-0 text-[11px] text-soft-foreground tabular-nums">{age}</span>
        )}
      </Link>
      {/* href protocol guard (#431): link only for http(s) URLs. */}
      {prUrl && isHttpUrl(prUrl) ? (
        <ReferenceChip
          reference={{
            kind: 'PR',
            ...(prNumber(prUrl) ? { number: Number(prNumber(prUrl)) } : {}),
            url: prUrl,
          }}
          taskTitle={runTitle(run)}
          compact
          className="mr-2.5 h-auto shrink-0 gap-[3px] px-1.5 py-px text-[10.5px]"
        />
      ) : null}
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

  // Nothing at all until the list has answered: a skeleton here would be inventing rows, and an
  // empty state would claim "No tasks yet" before we know whether there are any.
  if (!runs.data) return null

  return (
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
  )
}
