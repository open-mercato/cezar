import { CheckIcon, FolderOpenIcon, LayersIcon, MoonIcon, PlusIcon, SettingsIcon, ZapIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate as useRouterNavigate } from 'react-router'
import {
  rememberReferenceStatuses,
  useHealth,
  useProjectRepoBase,
  useProjects,
  useReferenceProjectId,
  useRunsForProject,
  useRunsIndex,
  useSkills,
  useUiState,
} from '@/api/queries'
import { TaskReferenceChip } from '@/components/reference-conflict-action'
import { ReferenceStatusProvider } from '@/components/reference-status'
import { scopeTo, useActiveProjectId, useNavigate } from '@/lib/project-router'
import { useActiveForge } from '@/lib/active-forge'
import type { ProjectListEntry, RunIndexEntry, RunRecord } from '@open-mercato/cezar-api-client'
import { visibleNavItems } from '@/components/nav-items'
import { StatusDot } from '@/components/status-dot'
import { NEXT_THEME } from '@/components/theme-toggle'
import { useTheme } from '@/components/theme-provider'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { deriveAttention } from '@/lib/attention'
import { shortAge } from '@/lib/format'
import { orderProjects as orderRegistry } from '@/lib/project-order'
import { isUnread } from '@/lib/read-state'
import { orderSkillsByUsage } from '@/lib/skills'
import { lastActivityAt, refPrefixMatches, runTitle, splitRefPrefix } from '@/lib/task-groups'
import { taskReferences, type TaskReference, type TaskReferenceInput } from '@/lib/tasks-table'
import { automationIdOf, ownAutomationId } from '@/lib/task-origin'
import { useCommandShortcut, useKeyShortcut } from '@/lib/use-command-shortcut'
import {
  searchModes,
  trackPaletteDismissed,
  trackPaletteModes,
  trackPaletteOpened,
  trackTaskSwitched,
  type PaletteMode,
} from '@/lib/telemetry'
import { openTaskPalette } from '@/components/task-palette/open'
import { useProjectOrder } from '@/lib/use-project-order'
import { cn } from '@/lib/utils'

/**
 * The ⌘K command palette (spec, "Cross-cutting"): projects, tasks, views, actions, skills —
 * everything, one keystroke from anywhere.
 *
 * Opened by ⌘K *and* Ctrl+K (the shared `useCommandShortcut` registers both together), by the
 * sidebar footer's hint, or programmatically via `openCommandPalette()`. Escape and selecting
 * anything close it.
 */

/** The programmatic-open seam: a window event rather than a context, so chrome that must stay
 *  presentational (the sidebar hint today, an onboarding nudge tomorrow) can open the palette
 *  without threading a setter through the tree. */
export const OPEN_COMMAND_PALETTE_EVENT = 'cezar:open-command-palette'

export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE_EVENT))
}

/** Newest first — the palette's unfiltered Tasks group should lead with what you touched last,
 *  exactly like the sidebar. Stable for equal timestamps (variant groups started together). */
export function orderRuns(runs: readonly RunRecord[]): RunRecord[] {
  return [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
}

/**
 * How the palette ranks a row against the query. Replaces cmdk's default scorer.
 *
 * The default is `command-score`, which matches a SUBSEQUENCE — the query's characters in order,
 * anywhere, with gaps. That is wrong here for a specific and very visible reason: every task's
 * value carries its run id so a pasted id finds its thread, and a run id is a uuid. Typing a task
 * number like `767` then subsequence-matches the stray `7`, `6`, `7` scattered through dozens of
 * unrelated uuids, and those accidents outrank the task actually called "767: …".
 *
 * So: SUBSTRING matching, every whitespace-separated token required (`shop auth` finds the auth
 * task in shop, and nothing else). Ranking, best first:
 *
 *  - a token starting at a word boundary beats one buried mid-word — `767` in `767: fix the thing`
 *    beats `767` inside `…a767b…`, which is exactly the uuid case;
 *  - an earlier match beats a later one, gently, so a title hit outranks an id hit;
 *  - the score is the mean across tokens, so every token has to be good, not just one.
 *
 * Returns 0 to hide the row — cmdk drops anything scoring 0 and sorts the rest descending, both
 * within a group and between groups. That is what puts the best match at the top of the list
 * rather than wherever its section happens to sit.
 */
export function paletteScore(value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (query === '') return 1
  const haystack = (keywords?.length ? `${value} ${keywords.join(' ')}` : value).toLowerCase()
  const tokens = query.split(/\s+/)
  let total = 0
  for (const [index, token] of tokens.entries()) {
    // A number is a reference: where it sits says nothing — the references follow the title, so a
    // decay would rank `#12` on a long title below `#123`. `pr`/`issue` only as the word naming
    // the number after it (`pr 12`); alone they are title words ("review pr"), and position counts.
    const isNumber = (value: string | undefined) => value !== undefined && /^#?\d+$/.test(value)
    const reference = isNumber(token) || (/^(pr|issue)$/.test(token) && isNumber(tokens[index + 1]))
    // The best of every occurrence, not the first: `#12` must find the exact `#12` reference even
    // when `#123` comes earlier in the row.
    let best = 0
    for (let at = haystack.indexOf(token); at !== -1; at = haystack.indexOf(token, at + 1)) {
      const starts = at === 0 || !/[a-z0-9]/.test(haystack[at - 1] ?? '')
      // A whole-word hit (`#12` against `#12`, not `#123`) edges out a prefix one.
      const ends = !/[a-z0-9]/.test(haystack[at + token.length] ?? '')
      const whole = reference && starts && ends
      // Decays with distance but never to zero: a late hit still beats no hit.
      best = Math.max(best, whole ? 1 : ((starts ? 1 : 0.5) * (ends ? 1 : 0.8)) / (1 + at / 48))
    }
    if (best === 0) return 0
    total += best
  }
  return total / tokens.length
}

/** A task's PR and issue numbers as search text — `PR #1234 Issue #56` — so a pasted number finds
 *  every task about it. Resolved by `taskReferences`, the rule the chips use (#407, #526). */
export function taskReferenceText(task: TaskReferenceInput): string {
  return taskReferences(task)
    .map((reference) => `${reference.kind} #${reference.number}`)
    .join(' ')
}

/**
 * One palette task row, whichever project it came from.
 *
 * `RunIndexEntry` with a nullable project: the active project's live rows are already standing
 * in their project, and an unprefixed target keeps them there. `null` therefore means "wherever
 * we already are", which is exactly how the scope-wrapping navigate reads it.
 */
export type PaletteTask = Omit<RunIndexEntry, 'projectId'> & { projectId: string | null }

/** The reference fields a run record and an index row share — what `taskReferenceText` reads. */
const referenceFields = (run: RunRecord): Partial<PaletteTask> => ({
  pullRequestUrl: run.pullRequestUrl,
  referencedPullRequestUrl: run.referencedPullRequestUrl,
  referencedPrCandidates: run.referencedPrCandidates,
  prNumber: run.prNumber,
  prRefs: run.prRefs,
  issueNumber: run.issueNumber,
  referencedIssueUrl: run.referencedIssueUrl,
  referencedIssueCandidates: run.referencedIssueCandidates,
  markerRefs: run.markerRefs,
})

/**
 * The live runs for one project, plus every other project's from the cross-project index.
 *
 * `runsProjectId` is WHICH PROJECT `activeRuns` belongs to, and it is not always the active one:
 * global settings and other global pages use the boot project's live list. Passing the URL's
 * active id here instead would, on global settings, fail to match the index's boot rows and list
 * every boot task twice. The caller resolves it: active id, else the registry's boot slug.
 *
 * Dedup is per RUN, not per project: an index row is dropped only when the live list already has
 * that exact task. The live row wins — it is the one the SSE stream patches, and preferring a
 * snapshot for the project you are looking at would make the palette lag the sidebar beside it.
 * Dropping the whole project instead would be smaller code and a worse failure mode: the moment
 * `runsProjectId` disagreed with what the live list actually returned, every task in that project
 * would vanish from the palette rather than merely arrive a few seconds stale.
 *
 * Ordering is locality-first, like `orderProjects`: the active project's tasks (newest first),
 * then everyone else's (newest first). An unfiltered palette therefore looks exactly as it did
 * before this became cross-project — typing is what reaches into the other projects, and cmdk
 * scores those hits on merit once you do.
 */
export function mergeTasks(
  activeRuns: readonly RunRecord[],
  runsProjectId: string | null,
  indexed: readonly RunIndexEntry[] | undefined,
): PaletteTask[] {
  const mine: PaletteTask[] = orderRuns(activeRuns).map((run) => ({
    projectId: runsProjectId,
    id: run.id,
    title: run.title,
    titleSummary: run.titleSummary,
    titleOrigin: run.titleOrigin,
    status: run.status,
    activity: run.activity,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    seenAt: run.seenAt,
    archived: run.archived,
    autoResumeAt: run.autoResumeAt,
    awaitingAnswerSince: run.awaitingAnswerSince,
    workflow: run.workflow,
    branch: run.branch,
    startedAt: run.startedAt,
    lastActivityAt: lastActivityAt(run),
    ...definedOnly(referenceFields(run)),
    ...definedOnly({
      automationId: ownAutomationId(run),
      dispatch: run.dispatch && {
        rootRunId: run.dispatch.rootRunId,
        parentRunId: run.dispatch.parentRunId,
        kind: run.dispatch.kind,
      },
    }),
  }))
  const live = new Set(mine.map(taskKey))
  const theirs = (indexed ?? [])
    .filter((entry) => !live.has(taskKey(entry)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const all = [...mine, ...theirs]
  // A task an automation's task dispatched is automatic too — the Tasks tables' rule
  // (`automationIdOf`), so the palette and the Automations filter agree on every row.
  const byId = new Map(all.map((task) => [task.id, task]))
  return all.map((task) => {
    if (task.automationId !== undefined) return task
    const inherited = automationIdOf(task, (rootId) => byId.get(rootId))
    return inherited === undefined ? task : { ...task, automationId: inherited }
  })
}

/** One age column — as wide as its label ("Updated"); `shortAge` never prints more than `999d`. */
const DATE_COLUMN = 'w-12 text-right'

/**
 * A task group's heading with the date columns' labels over them. The labels are drawn by CSS
 * (`content`), so the heading's text — what screen readers and the tests read — stays its name.
 */
export function TaskColumnsHeading({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 flex-1">{label}</span>
      <span aria-hidden="true" className="flex shrink-0 gap-1 text-[11px] font-normal">
        <span className={cn(DATE_COLUMN, "after:content-['Updated']")} />
        <span className={cn(DATE_COLUMN, "after:content-['Created']")} />
      </span>
    </span>
  )
}

/**
 * An agent mid-turn is active this very moment, whatever its last step boundary says — a step that
 * has run for 19 minutes would otherwise read "Updated 19m". The record carries no per-event time
 * (that lives in the event stream), but `running` outside monitoring IS that answer.
 */
export function isWorkingNow(task: Pick<PaletteTask, 'status' | 'activity'>): boolean {
  return task.status === 'running' && task.activity !== 'monitoring'
}

/** A row's exact time for its hover title — the browser's locale, to the minute. */
function exactTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : exactTimeFormat().format(date)
}

// One formatter for every row: `toLocaleString` builds a fresh Intl formatter per call, which at
// hundreds of rows was a visible share of each keystroke.
let exactTimeFormatter: Intl.DateTimeFormat | undefined
const exactTimeFormat = () =>
  (exactTimeFormatter ??= new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }))

/**
 * A task row's derived strings, computed ONCE per task list rather than per render — the row's
 * label, PR/issue text, what cmdk filters on, and its hover title. Keystrokes then only rank and
 * slice; they never redo this work.
 */
export interface SearchableTask {
  task: PaletteTask
  key: string
  label: string
  references: string
  /** The PR/issue chips, as `taskReferences` resolves them — the chips' own rule. */
  refList: TaskReference[]
  /** Exactly what the row hands cmdk, so the pre-ranking below and cmdk's filter agree. */
  value: string
  keywords: string[]
  projectName: string | null
  title: string
}

export function searchableTasks(
  tasks: readonly PaletteTask[],
  projectNames: ReadonlyMap<string, string>,
  /** Each project's repo web root — a reference known only by number becomes a link with it. */
  repoBases: ReadonlyMap<string, string> = new Map(),
): SearchableTask[] {
  return tasks.map((task) => {
    const label = runTitle(task)
    const refList = taskReferences(task, task.projectId === null ? undefined : repoBases.get(task.projectId))
    const references = refList.map((reference) => `${reference.kind} #${reference.number}`).join(' ')
    const projectName = task.projectId === null ? null : (projectNames.get(task.projectId) ?? null)
    return {
      task,
      key: taskKey(task),
      label,
      references,
      refList,
      // The id keeps duplicate titles apart; it also lets a pasted run id find its task.
      // `runTitle`, matching the rendered text — filtering on a raw title hidden behind an
      // auto-summary would surface rows for no visible reason. The PR/issue numbers sit before
      // the id so `1234` finds the task about PR #1234 ahead of a uuid that happens to hold it.
      value: `task ${label} ${references} ${task.id}`,
      // The project name is filter fodder for the same reason it is rendered: with every
      // project's tasks in one list, "shop" has to narrow to shop's tasks. `auto` finds the tasks
      // an automation started, like the chip that marks them.
      keywords: [...(projectName ? [projectName] : []), ...(task.automationId ? ['automation', 'automatic'] : [])],
      projectName,
      title: `${isWorkingNow(task) ? 'Working now' : `Updated ${exactTime(task.lastActivityAt)}`} · created ${exactTime(task.createdAt)}`,
    }
  })
}

/** How many task rows a palette mounts. Hundreds of cmdk items made every keystroke filter,
 *  re-sort and re-render all of them; nobody reads past this many matches — they type more. */
export const TASK_ROW_LIMIT = 50

/**
 * The best `limit` tasks for `query`, best first, by the palette's own scorer — the work cmdk
 * would do, done once over plain strings, so only the rows that will show are ever mounted.
 * An empty query keeps the list's order. `total` is every match, for the "N more" line.
 */
export function rankTasks(
  entries: readonly SearchableTask[],
  query: string,
  limit = TASK_ROW_LIMIT,
): { shown: SearchableTask[]; total: number } {
  if (query.trim() === '') return { shown: entries.slice(0, limit), total: entries.length }
  const scored: { entry: SearchableTask; score: number; index: number }[] = []
  entries.forEach((entry, index) => {
    const score = paletteScore(entry.value, query, entry.keywords)
    if (score > 0) scored.push({ entry, score, index })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return { shown: scored.slice(0, limit).map((item) => item.entry), total: scored.length }
}

/**
 * Status for the chips on the rows that are SHOWING — asked once typing pauses, not per keystroke:
 * each new request set republishes to the app-wide registry, which would cost a re-render of
 * every chip in the app per key. Statuses the runs index already carried paint immediately.
 */
export function PaletteReferenceStatuses({
  entries,
  children,
}: {
  entries: readonly SearchableTask[]
  children: React.ReactNode
}) {
  const projectId = useReferenceProjectId()
  const wanted = React.useMemo(
    () =>
      entries.flatMap((entry) =>
        entry.refList.map((reference) => ({
          projectId: entry.task.projectId ?? projectId ?? '',
          kind: reference.kind,
          number: reference.number,
        })),
      ).filter((request) => request.projectId !== ''),
    [entries, projectId],
  )
  // Keyed on CONTENT: the rows' array is rebuilt every render, and a timer keyed on its identity
  // would re-arm forever.
  const signature = wanted.map((request) => `${request.projectId} ${request.kind}#${request.number}`).join('|')
  const latest = React.useRef(wanted)
  latest.current = wanted
  const [requests, setRequests] = React.useState(wanted)
  React.useEffect(() => {
    const timer = setTimeout(() => setRequests(latest.current), 250)
    return () => clearTimeout(timer)
  }, [signature])
  return (
    <ReferenceStatusProvider projectId={projectId} requests={requests}>
      {children}
    </ReferenceStatusProvider>
  )
}

/** A task group's rows as a flex column, so `MoreTasks` can sit last by `order`. */
export const TASK_GROUP_CLASS = '[&_[cmdk-group-items]]:flex [&_[cmdk-group-items]]:flex-col'

/** The line under a capped task group: how many more match, and the way to reach them. */
export function MoreTasks({ hidden }: { hidden: number }) {
  if (hidden <= 0) return null
  // An item so cmdk always shows it (`forceMount`), disabled so it is never picked. cmdk re-orders
  // only selectable rows, which would leave this one stranded on top — `order-last` (the group is a
  // flex column, `TASK_GROUP_CLASS`) keeps it under the matches whatever the DOM order.
  return (
    <CommandItem
      forceMount
      disabled
      value="__more-tasks"
      data-slot="palette-more-tasks"
      className="order-last py-1.5! text-xs text-soft-foreground data-[disabled=true]:opacity-100"
    >
      {hidden} more — keep typing to narrow
    </CommandItem>
  )
}

/** Drops undefined keys, so a run without references keeps the row's exact old shape. */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>
}

/** Stable identity for a row that may come from either source — the run id alone collides
 *  across projects only in theory, but the pair is free and says what it means. */
const taskKey = (task: Pick<PaletteTask, 'projectId' | 'id'>): string =>
  `${task.projectId ?? ''}/${task.id}`

/**
 * Split the merged list into the default view's lead section and everything else.
 *
 * The section holds finished tasks you have not opened since they finished — `isUnread` from
 * `lib/read-state`, the SAME decider behind the Tasks nav badge and the sidebar rows, not a
 * re-derivation. It is headed "Recently finished" rather than "Unread" because that is what it
 * reads as: cezar only stamps a read receipt when you open a thread in the cockpit, so a task you
 * followed in the terminal, or simply never clicked, stays technically unread for as long as it
 * exists. Sorted by when they FINISHED (not created) — the question is "what landed while I was
 * away", and that is the order to work through them in.
 *
 * The split is exclusive: a task in this section does NOT appear again under Tasks. One row per
 * task, or the palette teaches you to distrust its own counts.
 */
export function partitionTasks(tasks: readonly PaletteTask[]): {
  recentlyFinished: PaletteTask[]
  otherTasks: PaletteTask[]
} {
  const recentlyFinished = tasks
    .filter((task) => isUnread(task))
    .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? ''))
  const led = new Set(recentlyFinished.map(taskKey))
  return { recentlyFinished, otherTasks: tasks.filter((task) => !led.has(taskKey(task))) }
}

/**
 * The sidebar's order, then the ACTIVE project dropped to the end.
 *
 * The order itself is not computed here: it is `lib/project-order.ts`, the same module the
 * sidebar's groups use, so the user's hand-picked order (#952) reaches the palette and the
 * palette cannot invent a second order for the same registry. Only the active-project rule is the
 * palette's own — this group exists to LEAVE the current project, so selecting the one you are
 * already in is the single row that can do nothing and must never be what an empty query
 * pre-selects. It stays listed rather than filtered out, so typing your own project's name is not
 * a dead end.
 */
export function orderProjects(
  projects: readonly ProjectListEntry[],
  activeProjectId: string | null,
  storedOrder: readonly string[] = [],
): ProjectListEntry[] {
  const ordered = orderRegistry(projects, storedOrder)
  // A stable partition rather than a sort: the picked order must survive being split.
  return [
    ...ordered.filter((project) => project.id !== activeProjectId),
    ...ordered.filter((project) => project.id === activeProjectId),
  ]
}

/**
 * Every task a palette can list: the live runs of the project on screen, plus every other
 * project's from the cross-project index — ⌘K's Tasks and ⌘P's switcher read the same list.
 */
export function usePaletteTasks() {
  const activeProjectId = useActiveProjectId()
  // The registry is workspace-scoped (not project-scoped), so this is the ONE list the palette
  // can offer everywhere — including global settings, which has no active project at all. The
  // shell already holds this cache entry; opening the palette costs no extra request.
  const projects = useProjects()
  // Health is cached by the shell's chips; ⌘K reads it to gate the forge-gated Views row (R6 1.1)
  // with the sidebar's recognized-remote rule (#1412), so the two never disagree.
  const health = useHealth()
  const registry = projects.data
  const bootProjectId = registry?.bootProject ?? health.data?.bootProject ?? null
  // Runs are already cached by the sidebar/shell. The palette also sits above the project route
  // provider, so ask for the URL project explicitly rather than trusting the module scope.
  const runs = useRunsForProject(activeProjectId, bootProjectId)
  // Same threshold as the sidebar's grouped nav (`app-shell-container.tsx`): with one registered
  // project there is nowhere to switch TO, and a one-row group would be pure noise.
  const multiProject = registry !== undefined && registry.projects.length > 1
  // The cross-project index answers "which project is this task in", so it is only worth asking
  // when that question has more than one answer. A single-project cockpit issues no request.
  const runsIndex = useRunsIndex(multiProject)
  // The statuses the index already carries colour the chips in the first paint (as All tasks does).
  const indexedStatuses = runsIndex.data?.referenceStatuses
  React.useEffect(() => {
    if (indexedStatuses) rememberReferenceStatuses(indexedStatuses)
  }, [indexedStatuses])
  const projectNames = React.useMemo(
    () => new Map((registry?.projects ?? []).map((project) => [project.id, project.name])),
    [registry],
  )
  // Which project the live run list answered for — see `mergeTasks`. The active id when there is
  // one, else the boot project, which is what an unscoped API client always reaches.
  const runsProjectId = (activeProjectId === 'default' ? null : activeProjectId) ?? bootProjectId
  const tasks = React.useMemo(
    () => mergeTasks(runs.data ?? [], runsProjectId, runsIndex.data?.runs),
    [runs.data, runsProjectId, runsIndex.data],
  )
  // Each project's repo web root, for links to references known only by number. The project on
  // screen may have none registered — its remote (`useProjectRepoBase`) answers then.
  const ownRepoBase = useProjectRepoBase()
  const repoBases = React.useMemo(() => {
    const bases = new Map<string, string>()
    for (const project of registry?.projects ?? []) if (project.repoUrl) bases.set(project.id, project.repoUrl)
    if (runsProjectId && ownRepoBase && !bases.has(runsProjectId)) bases.set(runsProjectId, ownRepoBase)
    return bases
  }, [registry, runsProjectId, ownRepoBase])
  return { activeProjectId, registry, health, multiProject, projectNames, repoBases, runsProjectId, tasks }
}

/** Where a palette task row lives: unprefixed for the project on screen, scoped otherwise. */
export function paletteTaskPath(task: Pick<PaletteTask, 'projectId' | 'id'>, suffix = ''): string {
  const path = `/tasks/${task.id}${suffix}`
  return task.projectId === null ? path : scopeTo(task.projectId, path) as string
}

/** The two palettes are one surface at a time: opening either closes the other. */
export const PALETTE_OPENED_EVENT = 'cezar:palette-opened'

export function announcePaletteOpened(which: 'command' | 'task'): void {
  window.dispatchEvent(new CustomEvent(PALETTE_OPENED_EVENT, { detail: which }))
}

export function usePaletteExclusion(which: 'command' | 'task', open: boolean, close: () => void): void {
  React.useEffect(() => {
    if (open) announcePaletteOpened(which)
  }, [open, which])
  React.useEffect(() => {
    const onOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== which) close()
    }
    window.addEventListener(PALETTE_OPENED_EVENT, onOpened)
    return () => window.removeEventListener(PALETTE_OPENED_EVENT, onOpened)
  }, [which, close])
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false)
  const navigate = useNavigate()

  useCommandShortcut('k', () => setOpen((current) => !current))
  const newTask = React.useCallback(() => {
    setOpen(false)
    navigate('/new')
  }, [navigate])
  // ⌘N works only in the desktop shell — the browser reserves it (new window), so the page
  // never sees it. `c`-to-create (GitHub/Linear) is the browser-usable accelerator and the one
  // the hint chips advertise; ⌘N stays registered for the Electron shell where it fires.
  useCommandShortcut('n', newTask)
  useKeyShortcut('c', newTask)

  React.useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen)
  }, [])
  const close = React.useCallback(() => setOpen(false), [])
  usePaletteExclusion('command', open, close)
  React.useEffect(() => {
    if (open) trackPaletteOpened('command')
  }, [open])

  // Tab on a task row hands it to ⌘P, which acts on it (spec 2026-10-17-task-palette).
  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    const row = event.currentTarget.querySelector<HTMLElement>('[cmdk-item][data-selected="true"][data-slot="palette-task"]')
    const runId = row?.dataset.runId
    if (!runId) return
    event.preventDefault()
    trackTaskSwitched('cmdk_tab')
    setOpen(false)
    openTaskPalette({ runId, projectId: row.dataset.projectId ?? null })
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        // Radix closes only on Escape or a click outside — choosing something closes it via `close`.
        if (!next) trackPaletteDismissed('command')
        setOpen(next)
      }}
      title="Command palette"
      description="Search projects, tasks, views, actions, and skills"
      showCloseButton={false}
      filter={paletteScore}
      commandProps={{ onKeyDown }}
      // Two overrides of the shared dialog, both for this surface only — every other dialog in
      // the cockpit is a form, which wants to stay narrow and centred.
      //
      // WIDTH: wider than the `sm:max-w-lg` default and growing with the viewport. This dialog
      // lists task titles from every project, and at 32rem the useful half of a title truncates.
      //
      // TOP: pinned, replacing `top-1/2 -translate-y-1/2`. A centred dialog re-centres every time
      // the result count changes, so the whole modal — search box included — jumps under the
      // cursor as you type. Anchored near the top it only ever grows downward, and the input you
      // are typing into never moves.
      className="top-[10vh] translate-y-0 sm:max-w-2xl lg:max-w-3xl xl:max-w-4xl"
    >
      {/* The body mounts only while the dialog is open (Radix portals nothing when closed), so
          its queries — notably the skills fetch — run on first open, never on app boot. */}
      <PaletteContent close={close} />
    </CommandDialog>
  )
}

/** One task row. Shared by Unread and Tasks so the two groups can never drift into rendering
 *  or filtering the same task differently — only which group holds it changes. */
export const TaskItem = React.memo(function TaskItem({
  entry,
  showProject,
  now,
  onSelect,
  slot = 'palette-task',
  current = false,
}: {
  entry: SearchableTask
  showProject: boolean
  now: number
  onSelect: (task: PaletteTask) => void
  slot?: string
  /** The task on screen — marked `open`. */
  current?: boolean
}) {
  const { task, label, projectName } = entry
  const attention = deriveAttention(task)
  // A chip needs the project its reference status is asked under.
  const chip = task.projectId ? entry.refList[0] : undefined
  return (
    <CommandItem
      value={entry.value}
      keywords={entry.keywords}
      data-slot={slot}
      data-run-id={task.id}
      data-project-id={task.projectId ?? undefined}
      onSelect={() => onSelect(task)}
    >
      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
      {/* The sidebar's own chip, leading the row as it does there (#788) — status colour, the
          conflict panel and its Resolve action included. A click opens the PR, not the task. */}
      {chip && task.projectId ? (
        <span
          data-slot="palette-task-refs"
          // The palette sizes every icon in a row at 20px; the chips keep the sidebar's.
          className="flex shrink-0 items-center gap-1 [&_svg]:size-3!"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <TaskReferenceChip
            run={task}
            projectId={task.projectId}
            reference={chip}
            compact
            className="h-auto shrink-0 gap-[2px] px-1.5 py-px text-[10.5px]"
          />
        </span>
      ) : null}
      {/* Like the sidebar: the chip carries the number, so a matching `NNN: ` prefix is not
          painted twice. The search still matches the full title. */}
      <span className="min-w-0 flex-1 truncate" title={label}>
        {refPrefixMatches(label, chip?.number) ? splitRefPrefix(label).rest : label}
      </span>
      {task.automationId ? (
        <span
          data-slot="palette-task-automation"
          title="Started by an automation"
          className="flex shrink-0 items-center gap-0.5 text-xs text-soft-foreground"
        >
          <ZapIcon aria-hidden="true" className="size-3!" />
          auto
        </span>
      ) : null}
      {/* Only in a multi-project workspace: with one project the label would name the only
          place a task could possibly be. */}
      {showProject && projectName ? (
        <span
          data-slot="palette-task-project"
          className="shrink-0 truncate text-xs text-soft-foreground"
        >
          {projectName}
        </span>
      ) : null}
      {current ? <span className="shrink-0 text-xs text-primary">open</span> : null}
      {/* Updated and Created, as two right-aligned table columns under the group's own labels
          (`TaskColumnsHeading`) — same widths there and here, so every date lines up. */}
      <span data-slot="palette-task-age" title={entry.title} className="flex shrink-0 gap-1 text-xs tabular-nums">
        <span data-slot="palette-task-updated" className={cn(DATE_COLUMN, 'text-muted-foreground')}>
          {isWorkingNow(task) ? 'now' : shortAge(task.lastActivityAt, now)}
        </span>
        <span data-slot="palette-task-created" className={cn(DATE_COLUMN, 'text-soft-foreground')}>
          {shortAge(task.createdAt, now)}
        </span>
      </span>
    </CommandItem>
  )
})

function PaletteContent({ close }: { close: () => void }) {
  const navigate = useNavigate()
  // The UNSCOPED twin, for the handful of targets that live outside every project (`/tasks`).
  const routerNavigate = useRouterNavigate()
  // Controlled so the body can tell the default view from a search. cmdk still owns filtering and
  // ranking (`paletteScore`); this only decides which SECTIONS exist.
  const [search, setSearch] = React.useState('')
  const searching = search.trim() !== ''
  // How this session searched (a PR number, "auto") — sent once each when it closes (unmounts).
  const sessionModes = React.useRef(new Set<PaletteMode>())
  React.useEffect(() => {
    // ⌘K has no prefixes: only the shape of what was searched (a PR number, `auto`).
    for (const used of searchModes(search)) sessionModes.current.add(used)
  }, [search])
  React.useEffect(() => () => trackPaletteModes(sessionModes.current), [])
  const { theme, setTheme } = useTheme()
  const { activeProjectId, registry, health, multiProject, projectNames, repoBases, tasks } = usePaletteTasks()
  // The Views row's GitHub gate follows the active project's forge, not the boot folder's (#1410).
  const activeForge = useActiveForge()
  const skills = useSkills()
  // Skills list most-used → project → global (#519) — the same order every picker renders.
  const uiState = useUiState()
  // Once per opening: a clock that ticked per keystroke would re-render every (memoized) row.
  const [now] = React.useState(Date.now)

  // The sidebar's hand-picked order (#952), read from the same cached workspace ui-state the
  // sidebar writes — so a project dragged to the top of the drawer is also the top of this list.
  const { order: projectOrder } = useProjectOrder()
  const orderedProjects = React.useMemo(
    () => (multiProject && registry ? orderProjects(registry.projects, activeProjectId, projectOrder) : []),
    [multiProject, registry, activeProjectId, projectOrder],
  )
  const sections = React.useMemo(() => {
    const { recentlyFinished, otherTasks } = partitionTasks(tasks)
    return {
      all: searchableTasks(tasks, projectNames, repoBases),
      recentlyFinished: searchableTasks(recentlyFinished, projectNames, repoBases),
      otherTasks: searchableTasks(otherTasks, projectNames, repoBases),
    }
  }, [tasks, projectNames, repoBases])
  // Searching flattens the two task sections into one ranked list — see the Tasks group below.
  // Either way only the rows that will show are mounted (`rankTasks`).
  const recentlyFinished = searching ? { shown: [], total: 0 } : rankTasks(sections.recentlyFinished, '', 20)
  const otherTasks = rankTasks(searching ? sections.all : sections.otherTasks, search)
  const showProjectOnTasks = multiProject
  const skillUsage = uiState.data?.skillUsage
  const orderedSkills = React.useMemo(
    () => orderSkillsByUsage(skills.data ?? [], skillUsage),
    [skills.data, skillUsage],
  )

  const go = (to: string) => {
    close()
    navigate(to)
  }
  /** A target OUTSIDE every project (`/tasks`, and anything else global that lands later). The
   *  scope-wrapping navigate would prefix it with the active `/p/<id>`, which is not a route. */
  const goGlobal = (to: string) => {
    close()
    routerNavigate(to)
  }
  // An explicit `/p/<id>/…` target, which the scoping wrapper passes through untouched — the
  // whole point of this group is landing in a project that is NOT the active one. `/` is that
  // project's tasks pane, the same door the sidebar group's "More…" opens.
  const goProject = (projectId: string) => {
    close()
    navigate(scopeTo(projectId, '/'))
  }
  /** A task thread in its OWN project — the one navigation that must ignore the active scope.
   *  A row with no project id belongs to wherever we already are, which is exactly what an
   *  unprefixed target means to the scope-wrapping navigate. */
  // Stable, so typing does not re-render every memoized task row.
  const selectTask = React.useCallback(
    (task: PaletteTask) => {
      trackTaskSwitched('cmdk')
      close()
      navigate(paletteTaskPath(task))
    },
    [close, navigate],
  )
  const nextTheme = NEXT_THEME[theme]

  return (
    <>
      <CommandInput
        placeholder="Search projects, tasks, views, actions, skills…"
        value={search}
        onValueChange={setSearch}
      />
      {/* The shadcn default is a flat `max-h-[300px]` — about seven rows, on any monitor. Scaled
          to the viewport instead, so a large screen actually shows the list it has room for.
          `min-h` keeps a short result set from collapsing the box to nothing, which would move
          the bottom edge as violently as the old centring moved the top. */}
      <CommandList className="max-h-[55vh] min-h-[14rem] sm:max-h-[60vh] lg:max-h-[68vh]">
        <CommandEmpty>Nothing matches.</CommandEmpty>

        {/* First, headless, and the row an empty query pre-selects: opening ⌘K and pressing
            Enter starts a task. It used to sit ninth in Views with a duplicate down in Actions;
            one authoritative row at the top is what "New task" being the default means. */}
        <CommandGroup>
          <CommandItem
            value="new task"
            data-slot="palette-view"
            data-nav-to="/new"
            onSelect={() => go('/new')}
          >
            <PlusIcon aria-hidden="true" />
            New task
            <CommandShortcut>C</CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {/* Only in the DEFAULT view. Once you type, splitting tasks by read-state is noise: it
            floats a section of near-misses above the exact match you are looking for, purely
            because that section renders first. Searching gets one ranked Tasks list. */}
        <PaletteReferenceStatuses entries={[...recentlyFinished.shown, ...otherTasks.shown]}>
        {!searching && recentlyFinished.shown.length > 0 ? (
          <CommandGroup heading={<TaskColumnsHeading label="Recently finished" />} className={TASK_GROUP_CLASS}>
            {recentlyFinished.shown.map((entry) => (
              <TaskItem key={entry.key} entry={entry} showProject={showProjectOnTasks} now={now} onSelect={selectTask} />
            ))}
            <MoreTasks hidden={recentlyFinished.total - recentlyFinished.shown.length} />
          </CommandGroup>
        ) : null}

        <CommandGroup heading="Views">
          {/* The one GLOBAL view, listed first because it is the only row here that is not
              about the project you are standing in. Multi-project only, matching the sidebar:
              with one project it would be that project's own Tasks page under another name. */}
          {multiProject ? (
            <CommandItem
              value="view All tasks"
              data-slot="palette-view"
              data-nav-to="/tasks"
              onSelect={() => goGlobal('/tasks')}
            >
              <LayersIcon aria-hidden="true" />
              All tasks
            </CommandItem>
          ) : null}
          {visibleNavItems({
            forge: activeForge != null,
            inbox: health.data?.capabilities.followups === true,
            automations: health.data?.capabilities.automations === true,
            tracker: registry?.projects.find((project) => project.id === (activeProjectId ?? registry.bootProject))?.tracker,
          }).map((item) => {
            const Icon = item.icon
            return (
              <CommandItem
                key={item.to}
                // The `view` prefix keeps values unique across groups and gives "view git" a
                // deterministic hit; the value is filter fodder, never rendered.
                value={`view ${item.label}`}
                data-slot="palette-view"
                data-nav-to={item.to}
                onSelect={() => go(item.to)}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </CommandItem>
            )
          })}
          {/* Global settings sit OUTSIDE every project (`/settings/global`, unified settings spec
              2026-10-13) — the one view the scoped nav items cannot express, so it is its own
              row, through the unscoped navigate. */}
          <CommandItem
            value="view global settings"
            data-slot="palette-view"
            data-nav-to="/settings/global"
            onSelect={() => goGlobal('/settings/global')}
          >
            <SettingsIcon aria-hidden="true" />
            Global settings
          </CommandItem>
        </CommandGroup>

        {orderedProjects.length > 0 ? (
          <CommandGroup heading="Projects">
            {orderedProjects.map((project) => {
              const active = project.id === activeProjectId
              // Nothing to open: the folder is gone. The row stays listed (Settings → Projects
              // owns removing it) but cannot be picked, rather than navigating into a project
              // whose every request 4xxs — the same rule the composer's project pill applies.
              const missing = project.status === 'missing'
              return (
                <CommandItem
                  key={project.id}
                  // The `project` prefix keeps values unique across groups; the id is what makes
                  // two same-named registry entries separately reachable.
                  value={`project ${project.name} ${project.id}`}
                  // The root is how you tell apart two checkouts of one repo — searchable, but
                  // not worth a line of its own in a row this dense.
                  keywords={[project.root]}
                  data-slot="palette-project"
                  data-project-id={project.id}
                  disabled={missing}
                  onSelect={() => goProject(project.id)}
                >
                  <FolderOpenIcon aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {missing ? (
                    <span className="shrink-0 text-xs text-soft-foreground">folder not found</span>
                  ) : project.branch !== undefined ? (
                    <span className="shrink-0 font-mono text-xs text-soft-foreground">
                      {project.branch}
                    </span>
                  ) : null}
                  {active ? (
                    <CheckIcon aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
                  ) : null}
                </CommandItem>
              )
            })}
          </CommandGroup>
        ) : null}

        {otherTasks.shown.length > 0 ? (
          <CommandGroup heading={<TaskColumnsHeading label="Tasks" />} className={TASK_GROUP_CLASS}>
            {otherTasks.shown.map((entry) => (
              <TaskItem key={entry.key} entry={entry} showProject={showProjectOnTasks} now={now} onSelect={selectTask} />
            ))}
            <MoreTasks hidden={otherTasks.total - otherTasks.shown.length} />
          </CommandGroup>
        ) : null}
        </PaletteReferenceStatuses>

        <CommandGroup heading="Actions">
          <CommandItem
            value="action toggle theme"
            data-slot="palette-action"
            data-action="toggle-theme"
            onSelect={() => {
              setTheme(nextTheme)
              close()
            }}
          >
            <MoonIcon aria-hidden="true" />
            Toggle theme
            <CommandShortcut className="tracking-normal">
              {theme} → {nextTheme}
            </CommandShortcut>
          </CommandItem>
        </CommandGroup>

        {orderedSkills.length > 0 ? (
          <CommandGroup heading="Skills">
            {orderedSkills.map((skill) => (
              <CommandItem
                key={skill.path}
                // The path suffix keeps values unique when a project skill shadows a global
                // one of the same name — both stay selectable.
                value={`skill ${skill.name} ${skill.path}`}
                keywords={skill.description ? [skill.description] : undefined}
                data-slot="palette-skill"
                data-skill={skill.name}
                onSelect={() => go(`/new?skill=${encodeURIComponent(skill.name)}`)}
              >
                <span className="shrink-0 font-medium">{skill.name}</span>
                {skill.description ? (
                  <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">{skill.description}</span>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </>
  )
}
