import { ChevronDownIcon, PlusIcon, ScaleIcon } from 'lucide-react'
import * as React from 'react'
import { rememberReferenceStatuses, useHealth, useProjects, useReferenceProjectId, useRuns, useRunsIndex } from '@/api/queries'
import { ProjectNavLinks, useSidebarNavigate } from '@/components/app-shell'
import { activeNavPath, visibleNavItems, type NavAvailability } from '@/components/nav-items'
import { stripProjectPrefix } from '@/lib/project-router'
import { useLocation } from 'react-router'
import { Link, scopeTo, useActiveProjectId, useProjectMatch } from '@/lib/project-router'
import type { RunIndexEntry, RunRecord } from '@open-mercato/cezar-api-client'
import { DiffStatLabel } from '@/components/diff-stat'
import { ReferenceChip } from '@/components/reference-chip'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { StatusDot } from '@/components/status-dot'
import { StatusMark } from '@/components/status-mark'
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
      <StatusMark attention={attention} className="mt-[9px]" />
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
          {/* Unread (#unread-done-items) is the title's WEIGHT alone — the trailing dot said the
              same thing twice. The accessible name keeps the word. */}
          {unread ? <span className="sr-only">unread</span> : null}
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

/** Needs-you outranks merely-running; a usage-limit `failed` with an appointment is parked,
 *  not broken, so it sorts with the live ones (same rule as `deriveAttention`). */
function needsYou(entry: { status: RunRecord['status']; autoResumeAt?: string }): boolean {
  if (entry.status === 'waiting' || entry.status === 'review') return true
  return entry.status === 'failed' && !entry.autoResumeAt
}

/** Live before finished, needs-you before working, newest first within — the order the
 *  single-project list has always used, applied per project group. */
function rankEntry(entry: RunIndexEntry): number {
  if (needsYou(entry)) return 0
  if (entry.status === 'running' || entry.status === 'queued' || entry.status === 'failed') return 1
  return 2
}

function compareEntries(a: RunIndexEntry, b: RunIndexEntry): number {
  const rank = rankEntry(a) - rankEntry(b)
  if (rank !== 0) return rank
  return (b.finishedAt ?? b.startedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.startedAt ?? a.createdAt)
}

/** How many rows a project group shows before folding the rest behind "Show N more". */
const GROUP_PREVIEW = 5

/**
 * One group per project, the project's tasks under it (user decision, Claude Code reference):
 * the sidebar's top is "what is going on, everywhere", ordered by last use — the active project
 * first, then the registry by `lastOpenedAt`. A project with no live tasks stays out of the way
 * (it is still one switcher pick away); the active project is always listed, even empty, so the
 * `+` beside its name is where a first task starts.
 *
 * One data source for every group — the workspace runs index (what the global Tasks page and
 * the palette read) — so the active project and the others cannot disagree about a task.
 */
export function ProjectTaskGroups({
  now = Date.now(),
  availability = {},
  badges = {},
}: {
  now?: number
  availability?: NavAvailability
  /** What the active project's nav rows wear: the Inbox count and the Skills update marker. */
  badges?: { inboxCount?: number | null; skillsUpdateAvailable?: boolean }
}) {
  const index = useRunsIndex(true)
  const registry = useProjects().data
  const activeFromUrl = useActiveProjectId()
  const activeProjectId = activeFromUrl ?? registry?.bootProject ?? null
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const currentRunId = match?.params.id ?? exact?.params.id ?? null
  const onNavigate = useSidebarNavigate()
  const { pathname } = useLocation()
  // The active project's views, lit from the URL's area (same rule the old workspace nav used).
  const navItems = visibleNavItems(availability)
  const activeTo = activeNavPath(stripProjectPrefix(pathname))

  // Statuses the server already had ride along with the index; cold ones are asked for below.
  const indexedStatuses = index.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])

  const groups = React.useMemo(() => {
    if (!registry) return []
    const entries = (index.data?.runs ?? []).filter((entry) => !entry.archived)
    const byProject = new Map<string, RunIndexEntry[]>()
    for (const entry of entries) {
      const list = byProject.get(entry.projectId)
      if (list) list.push(entry)
      else byProject.set(entry.projectId, [entry])
    }
    return [...registry.projects]
      .sort((a, b) => {
        if (a.id === activeProjectId) return -1
        if (b.id === activeProjectId) return 1
        return (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || '')
      })
      .map((project) => ({ project, entries: (byProject.get(project.id) ?? []).sort(compareEntries) }))
      .filter(({ project, entries }) => entries.length > 0 || project.id === activeProjectId)
  }, [registry, index.data, activeProjectId])

  const referenceRequests = React.useMemo(
    () =>
      groups.flatMap(({ project, entries }) =>
        entries.flatMap((entry) => {
          const reference = taskReference(entry)
          return reference ? [{ projectId: project.id, kind: reference.kind, number: reference.number }] : []
        }),
      ),
    [groups],
  )

  // Nothing until the registry has answered: a group list with no names would be a guess.
  if (!registry) return null

  return (
    <ReferenceStatusProvider requests={referenceRequests}>
      <div data-slot="project-task-groups" className="flex flex-col gap-3 pt-1">
        {groups.map(({ project, entries }) => (
          <ProjectTaskGroup
            key={project.id}
            projectId={project.id}
            name={project.name}
            entries={entries}
            currentRunId={currentRunId}
            now={now}
            onNavigate={onNavigate}
            nav={
              project.id === activeProjectId ? (
                <ProjectNavLinks
                  projectId={project.id}
                  items={navItems}
                  activeTo={activeTo}
                  inboxCount={badges.inboxCount ?? null}
                  skillsUpdateAvailable={badges.skillsUpdateAvailable ?? false}
                  onNavigate={onNavigate}
                />
              ) : null
            }
          />
        ))}
      </div>
    </ReferenceStatusProvider>
  )
}

function ProjectTaskGroup({
  projectId,
  name,
  entries,
  currentRunId,
  now,
  onNavigate,
  nav,
}: {
  projectId: string
  name: string
  entries: RunIndexEntry[]
  currentRunId: string | null
  now: number
  onNavigate?: () => void
  /** The project's views (Git, Skills…) — only the ACTIVE group carries them. */
  nav?: React.ReactNode
}) {
  const [expanded, setExpanded] = React.useState(false)
  const hidden = Math.max(0, entries.length - GROUP_PREVIEW)
  const shown = expanded ? entries : entries.slice(0, GROUP_PREVIEW)
  return (
    <section data-slot="project-task-group" data-project-id={projectId} className="flex flex-col gap-0.5">
      {/* The project's name is the group's label, the + beside it starts a task THERE — the
          explicit scope is what makes a group for another project more than a list. */}
      <div className="flex h-7 items-center pr-1 pl-3">
        {/* The name IS the door to that project's Tasks table (user decision: no Tasks row in
            the nav — projects, and tasks inside them). Still an h2 for the section landmark. */}
        <h2 className="min-w-0 truncate">
          <Link
            to={scopeTo(projectId, '/')}
            data-slot="group-tasks-link"
            title={`All tasks in ${name}`}
            onClick={onNavigate}
            className="text-[10.5px] font-semibold tracking-[0.05em] text-muted-foreground uppercase transition-colors hover:text-foreground"
          >
            {name}
          </Link>
        </h2>
        <Link
          to={scopeTo(projectId, '/new')}
          data-slot="group-new-task"
          aria-label={`New task in ${name}`}
          title={`New task in ${name}`}
          onClick={onNavigate}
          className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="px-3 py-1.5 text-xs text-soft-foreground">No tasks yet</p>
      ) : (
        foldVariants(shown).map((row) =>
          row.kind === 'run' ? (
            <IndexRunRow key={row.entry.id} entry={row.entry} currentRunId={currentRunId} now={now} />
          ) : (
            <IndexVariantTile key={row.groupId} projectId={projectId} row={row} currentRunId={currentRunId} now={now} />
          ),
        )
      )}
      {hidden > 0 ? (
        <button
          type="button"
          data-slot="group-show-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="self-start rounded-sm px-3 py-1 text-[12px] text-soft-foreground transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          {expanded ? 'Show less' : `Show ${hidden} more`}
        </button>
      ) : null}
      {nav}
    </section>
  )
}

type IndexRow =
  | { kind: 'run'; entry: RunIndexEntry }
  | { kind: 'group'; groupId: string; title: string; members: RunIndexEntry[] }

/** Spec 010 in the project groups: members of one variant group fold into one tile, at the
 *  position of their first member; a lone member (the others archived) stays a plain row. */
function foldVariants(entries: RunIndexEntry[]): IndexRow[] {
  const rows: IndexRow[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.groupId) {
      rows.push({ kind: 'run', entry })
      continue
    }
    if (seen.has(entry.groupId)) continue
    seen.add(entry.groupId)
    const members = entries.filter((e) => e.groupId === entry.groupId)
    if (members.length < 2) rows.push({ kind: 'run', entry })
    else rows.push({ kind: 'group', groupId: entry.groupId, title: runTitle(entry), members })
  }
  return rows
}

/** The collapsed variant group: the shared title, a ×N badge, the compare link as the toggle's
 *  flex SIBLING (a link inside a button is invalid), and the members beneath when expanded. */
function IndexVariantTile({
  projectId,
  row,
  currentRunId,
  now,
}: {
  projectId: string
  row: Extract<IndexRow, { kind: 'group' }>
  currentRunId: string | null
  now: number
}) {
  const [expanded, setExpanded] = React.useState(false)
  return (
    <>
      <div className="flex items-center rounded-sm hover:bg-card">
        <button
          type="button"
          data-slot="group-tile"
          data-group-id={row.groupId}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-2 py-[7px] pl-3 text-left"
        >
          <ChevronDownIcon
            className={cn('size-3 shrink-0 text-soft-foreground transition-transform', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{row.title}</span>
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-px font-mono text-[10.5px] font-semibold text-muted-foreground">
            ×{row.members.length}
          </span>
        </button>
        <Link
          to={scopeTo(projectId, `/compare/${row.groupId}`)}
          aria-label={`Compare variants of ${row.title}`}
          title="Compare variants"
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-soft-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <ScaleIcon className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {expanded
        ? row.members.map((entry) => (
            <IndexRunRow key={entry.id} entry={entry} currentRunId={currentRunId} now={now} variant />
          ))
        : null}
    </>
  )
}

/** One task row from the workspace index — the two-line grammar of `RunRow`, on the slim entry
 *  every project group shares. Explicit `/p/<id>` scope so a row under another project lands
 *  in that project. */
function IndexRunRow({ entry, currentRunId, now, variant = false }: { entry: RunIndexEntry; currentRunId: string | null; now: number; variant?: boolean }) {
  const attention = deriveAttention(entry)
  const isActive = entry.id === currentRunId
  const reference = taskReference(entry)
  const title = runTitle(entry)
  const displayTitle = refPrefixMatches(title, reference?.number) ? splitRefPrefix(title).rest : title
  const unread = isUnread(entry)
  const readDone = isReadDoneItem(entry)
  const age = shortAge(entry.finishedAt ?? entry.startedAt ?? entry.createdAt, now)
  return (
    <div
      data-slot="task-row"
      data-run-id={entry.id}
      data-project-id={entry.projectId}
      data-active={isActive ? 'true' : undefined}
      className={cn('flex min-h-11 items-start gap-2 rounded-sm pl-3 hover:bg-card', variant && 'pl-[26px]')}
    >
      <StatusMark attention={attention} className="mt-[9px]" />
      <span className="flex min-w-0 flex-1 flex-col gap-[3px] py-[6px] pr-2.5">
        <Link
          to={scopeTo(entry.projectId, `/tasks/${entry.id}`)}
          title={title}
          aria-current={isActive ? 'page' : undefined}
          className="flex min-w-0 items-center gap-2"
        >
          {variant && entry.variant ? (
            <span className="inline-flex size-[15px] shrink-0 items-center justify-center rounded-full bg-violet/15 font-mono text-[9.5px] font-semibold text-violet">
              {entry.variant}
            </span>
          ) : null}
          <span
            data-slot="task-row-title"
            className={cn(
              'min-w-0 flex-1 truncate text-[13px] leading-[1.3]',
              unread ? 'font-semibold text-foreground' : readDone ? 'font-medium text-muted-foreground' : 'font-medium',
            )}
          >
            {displayTitle}
          </span>
          {unread ? <span className="sr-only">unread</span> : null}
        </Link>
        <span data-slot="task-row-meta" className="flex min-w-0 items-center gap-2.5 text-[11px] leading-none text-soft-foreground">
          <span className="shrink-0 tabular-nums">{age}</span>
          {reference ? (
            <ReferenceChip
              reference={reference}
              taskTitle={title}
              projectId={entry.projectId}
              compact
              className="h-auto shrink-0 gap-[3px] rounded-none border-0 px-0 py-0 text-[10.5px] font-medium"
            />
          ) : null}
        </span>
      </span>
    </div>
  )
}

/** Kept for the per-project groups view (`project-groups.tsx`) and direct renders: the active
 *  project's own list, wired to `useRuns()`. The boot sidebar renders `ProjectTaskGroups`. */
export function TaskQuickListContainer() {
  const runs = useRuns()
  const health = useHealth()
  const visibility = usageMetricVisibility(health.data)
  const match = useProjectMatch('/tasks/:id/*')
  const exact = useProjectMatch('/tasks/:id')
  const now = useNow(30_000)
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
  if (!runs.data) return null
  return (
    <ReferenceStatusProvider projectId={projectId} requests={referenceRequests}>
      <TaskQuickList
        runs={runs.data}
        currentRunId={match?.params.id ?? exact?.params.id ?? null}
        now={now}
        showTokens={visibility.tokens}
        showCost={visibility.cost}
      />
    </ReferenceStatusProvider>
  )
}

/** The boot sidebar's list: every project's tasks, grouped, by last use. */
export function ProjectTaskGroupsContainer({
  availability,
  badges,
}: {
  availability?: NavAvailability
  badges?: { inboxCount?: number | null; skillsUpdateAvailable?: boolean }
}) {
  const now = useNow(30_000)
  return <ProjectTaskGroups now={now} availability={availability} badges={badges} />
}
