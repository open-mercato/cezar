import { CheckIcon, FolderOpenIcon, LayersIcon, MoonIcon, PlusIcon, SettingsIcon, ZapIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate as useRouterNavigate } from 'react-router'
import { useHealth, useProjects, useRunsForProject, useRunsIndex, useSkills, useUiState } from '@/api/queries'
import { scopeTo, useActiveProjectId, useNavigate } from '@/lib/project-router'
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
import { lastActivityAt, runTitle } from '@/lib/task-groups'
import { taskReferences, type TaskReferenceInput } from '@/lib/tasks-table'
import { automationIdOf, ownAutomationId } from '@/lib/task-origin'
import { useCommandShortcut, useKeyShortcut } from '@/lib/use-command-shortcut'
import { openTaskPalette } from '@/components/task-palette/open'
import { useProjectOrder } from '@/lib/use-project-order'

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
  for (const token of tokens) {
    // The best of every occurrence, not the first: `#12` must find the exact `#12` reference even
    // when `#123` comes earlier in the row.
    let best = 0
    for (let at = haystack.indexOf(token); at !== -1; at = haystack.indexOf(token, at + 1)) {
      const starts = at === 0 || !/[a-z0-9]/.test(haystack[at - 1] ?? '')
      // A whole-word hit (`#12` against `#12`, not `#123`) edges out a prefix one.
      const ends = !/[a-z0-9]/.test(haystack[at + token.length] ?? '')
      // Decays with distance but never to zero: a late hit still beats no hit.
      best = Math.max(best, ((starts ? 1 : 0.5) * (ends ? 1 : 0.8)) / (1 + at / 48))
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

/** A row's exact time for its hover title — the browser's locale, to the minute. */
function exactTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
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
  // Health is cached by the shell's chips; ⌘K reads it to gate the forge-gated Views row (R6 1.1).
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
  return { activeProjectId, registry, health, multiProject, projectNames, runsProjectId, tasks }
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

  // Tab on a task row hands it to ⌘P, which acts on it (spec 2026-10-17-task-palette).
  const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    const row = event.currentTarget.querySelector<HTMLElement>('[cmdk-item][data-selected="true"][data-slot="palette-task"]')
    const runId = row?.dataset.runId
    if (!runId) return
    event.preventDefault()
    setOpen(false)
    openTaskPalette({ runId, projectId: row.dataset.projectId ?? null })
  }, [])

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
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
      <PaletteContent close={() => setOpen(false)} />
    </CommandDialog>
  )
}

/** One task row. Shared by Unread and Tasks so the two groups can never drift into rendering
 *  or filtering the same task differently — only which group holds it changes. */
export function TaskItem({
  task,
  projectName,
  showProject,
  now,
  onSelect,
  slot = 'palette-task',
  trailing,
}: {
  task: PaletteTask
  projectName: string | null
  showProject: boolean
  now: number
  onSelect: (task: PaletteTask) => void
  slot?: string
  trailing?: React.ReactNode
}) {
  const attention = deriveAttention(task)
  const label = runTitle(task)
  const references = taskReferenceText(task)
  return (
    <CommandItem
      // The id keeps duplicate titles apart; it also lets a pasted run id find its task.
      // `runTitle`, matching the rendered text — filtering on a raw title hidden behind an
      // auto-summary would surface rows for no visible reason. The PR/issue numbers sit before
      // the id so `1234` finds the task about PR #1234 ahead of a uuid that happens to hold it.
      value={`task ${label} ${references} ${task.id}`}
      // The project name is filter fodder for the same reason it is rendered: with every
      // project's tasks in one list, "shop" has to narrow to shop's tasks.
      // `auto` finds the tasks an automation started, like the chip that marks them.
      keywords={[...(projectName ? [projectName] : []), ...(task.automationId ? ['automation', 'automatic'] : [])]}
      data-slot={slot}
      data-run-id={task.id}
      className="group/task"
      data-project-id={task.projectId ?? undefined}
      onSelect={() => onSelect(task)}
    >
      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
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
      {references ? (
        <span data-slot="palette-task-refs" className="shrink-0 font-mono text-xs text-soft-foreground">
          {references.replace(/PR #/g, '#').replace(/Issue #/g, 'issue #')}
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
      {/* Last activity on every row (the Tasks table's Updated); the highlighted row adds when it
          was created, so both are one arrow key away without a second column on every row. */}
      <span
        data-slot="palette-task-age"
        title={`Created ${exactTime(task.createdAt)} · last active ${exactTime(task.lastActivityAt)}`}
        className="shrink-0 text-xs text-soft-foreground tabular-nums"
      >
        {shortAge(task.createdAt, now) !== shortAge(task.lastActivityAt, now) ? (
          <span className="hidden group-data-[selected=true]/task:inline">
            created {shortAge(task.createdAt, now)} · active{' '}
          </span>
        ) : null}
        {shortAge(task.lastActivityAt, now)}
      </span>
      {trailing}
    </CommandItem>
  )
}

function PaletteContent({ close }: { close: () => void }) {
  const navigate = useNavigate()
  // The UNSCOPED twin, for the handful of targets that live outside every project (`/tasks`).
  const routerNavigate = useRouterNavigate()
  // Controlled so the body can tell the default view from a search. cmdk still owns filtering and
  // ranking (`paletteScore`); this only decides which SECTIONS exist.
  const [search, setSearch] = React.useState('')
  const searching = search.trim() !== ''
  const { theme, setTheme } = useTheme()
  const { activeProjectId, registry, health, multiProject, projectNames, tasks } = usePaletteTasks()
  const skills = useSkills()
  // Skills list most-used → project → global (#519) — the same order every picker renders.
  const uiState = useUiState()
  const now = Date.now()

  // The sidebar's hand-picked order (#952), read from the same cached workspace ui-state the
  // sidebar writes — so a project dragged to the top of the drawer is also the top of this list.
  const { order: projectOrder } = useProjectOrder()
  const orderedProjects = React.useMemo(
    () => (multiProject && registry ? orderProjects(registry.projects, activeProjectId, projectOrder) : []),
    [multiProject, registry, activeProjectId, projectOrder],
  )
  const partitioned = React.useMemo(() => partitionTasks(tasks), [tasks])
  // Searching flattens the two task sections into one ranked list — see the Tasks group below.
  const recentlyFinished = searching ? [] : partitioned.recentlyFinished
  const otherTasks = searching ? tasks : partitioned.otherTasks
  const showProjectOnTasks = multiProject
  const taskProjectName = (task: PaletteTask): string | null =>
    task.projectId === null ? null : (projectNames.get(task.projectId) ?? null)
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
  const selectTask = (task: PaletteTask) => {
    close()
    navigate(paletteTaskPath(task))
  }
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
        {!searching && recentlyFinished.length > 0 ? (
          <CommandGroup heading="Recently finished">
            {recentlyFinished.map((task) => (
              <TaskItem
                key={taskKey(task)}
                task={task}
                projectName={taskProjectName(task)}
                showProject={showProjectOnTasks}
                now={now}
                onSelect={selectTask}
              />
            ))}
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
            forge: health.data?.forge?.available === true,
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

        {otherTasks.length > 0 ? (
          <CommandGroup heading="Tasks">
            {otherTasks.map((task) => (
              <TaskItem
                key={taskKey(task)}
                task={task}
                projectName={taskProjectName(task)}
                showProject={showProjectOnTasks}
                now={now}
                onSelect={selectTask}
              />
            ))}
          </CommandGroup>
        ) : null}

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
