import { CheckIcon, FolderOpenIcon, LayersIcon, MoonIcon, PlusIcon } from 'lucide-react'
import * as React from 'react'
import { useNavigate as useRouterNavigate } from 'react-router'
import { useHealth, useProjects, useRuns, useRunsIndex, useSkills, useUiState } from '@/api/queries'
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
import { isUnread } from '@/lib/read-state'
import { orderSkillsByUsage } from '@/lib/skills'
import { runTitle } from '@/lib/task-groups'
import { useCommandShortcut, useKeyShortcut } from '@/lib/use-command-shortcut'

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
    const at = haystack.indexOf(token)
    if (at === -1) return 0
    const boundary = at === 0 || !/[a-z0-9]/.test(haystack[at - 1] ?? '')
    // Decays with distance but never to zero: a late hit still beats no hit.
    total += (boundary ? 1 : 0.5) / (1 + at / 48)
  }
  return total / tokens.length
}

/**
 * One palette task row, whichever project it came from.
 *
 * `RunIndexEntry` with a nullable project: the active project's rows come from `useRuns()`, which
 * knows nothing about ids — and in an unscoped cockpit (the boot project's legacy mount) there is
 * no id to know. `null` therefore means "wherever we already are", which is exactly how the
 * scope-wrapping navigate reads an unprefixed target.
 */
export type PaletteTask = Omit<RunIndexEntry, 'projectId'> & { projectId: string | null }

/**
 * The runs `useRuns()` answered for, plus every other project's from the cross-project index.
 *
 * `runsProjectId` is WHICH PROJECT `activeRuns` belongs to, and it is not always the active one.
 * `useRuns()` follows the API scope, which is null both for the boot project (`routes.tsx` mounts
 * it unscoped) and on global settings (no scope route at all) — in either case it answers for the
 * BOOT project. Passing the URL's active id here instead would, on global settings, fail to match
 * the index's boot rows and list every boot task twice. The caller resolves it: active id, else
 * the registry's boot slug.
 *
 * Dedup is per RUN, not per project: an index row is dropped only when the live list already has
 * that exact task. The live row wins — it is the one the SSE stream patches, and preferring a
 * snapshot for the project you are looking at would make the palette lag the sidebar beside it.
 * Dropping the whole project instead would be smaller code and a worse failure mode: the moment
 * `runsProjectId` disagreed with what `useRuns()` actually returned, every task in that project
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
    workflow: run.workflow,
    branch: run.branch,
    startedAt: run.startedAt,
  }))
  const live = new Set(mine.map(taskKey))
  const theirs = (indexed ?? [])
    .filter((entry) => !live.has(taskKey(entry)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return [...mine, ...theirs]
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
 * Most-recently-opened first, then the ACTIVE project dropped to the end.
 *
 * The recency sort is the sidebar's, byte for byte (`project-groups.tsx`) — the palette must not
 * invent a third order for the same registry. The active project moves last because this group
 * exists to LEAVE the current project: selecting the one you are already in is the only row that
 * can do nothing, so it must never be the row an empty query pre-selects. It stays listed rather
 * than filtered out, so typing your own project's name is not a dead end.
 */
export function orderProjects(
  projects: readonly ProjectListEntry[],
  activeProjectId: string | null,
): ProjectListEntry[] {
  return [...projects].sort((a, b) => {
    const activeRank = Number(a.id === activeProjectId) - Number(b.id === activeProjectId)
    return activeRank || b.lastOpenedAt.localeCompare(a.lastOpenedAt)
  })
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

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Search projects, tasks, views, actions, and skills"
      showCloseButton={false}
      filter={paletteScore}
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
function TaskItem({
  task,
  projectName,
  showProject,
  now,
  onSelect,
}: {
  task: PaletteTask
  projectName: string | null
  showProject: boolean
  now: number
  onSelect: (task: PaletteTask) => void
}) {
  const attention = deriveAttention(task)
  const label = runTitle(task)
  return (
    <CommandItem
      // The id keeps duplicate titles apart; it also lets a pasted run id find its task.
      // `runTitle`, matching the rendered text — filtering on a raw title hidden behind an
      // auto-summary would surface rows for no visible reason.
      value={`task ${label} ${task.id}`}
      // The project name is filter fodder for the same reason it is rendered: with every
      // project's tasks in one list, "shop" has to narrow to shop's tasks.
      keywords={projectName ? [projectName] : undefined}
      data-slot="palette-task"
      data-run-id={task.id}
      data-project-id={task.projectId ?? undefined}
      onSelect={() => onSelect(task)}
    >
      <StatusDot tone={attention.tone} pulse={attention.pulse} aria-label={attention.label} role="img" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
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
      <span className="shrink-0 text-xs text-soft-foreground tabular-nums">
        {shortAge(task.finishedAt ?? task.createdAt, now)}
      </span>
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
  const activeProjectId = useActiveProjectId()
  const { theme, setTheme } = useTheme()
  // Runs are already cached by the sidebar's quick-list; skills fetch here, on first open.
  const runs = useRuns()
  const skills = useSkills()
  // The registry is workspace-scoped (not project-scoped), so this is the ONE list the palette
  // can offer everywhere — including global settings, which has no active project at all. The
  // shell already holds this cache entry; opening the palette costs no extra request.
  const projects = useProjects()
  // Skills list most-used → project → global (#519) — the same order every picker renders.
  const uiState = useUiState()
  // Health is cached by the shell's chips; here it gates the forge-gated Views row (R6 1.1) —
  // the palette must not offer a GitHub view the sidebar honestly hides.
  const health = useHealth()
  const now = Date.now()

  // Same threshold as the sidebar's grouped nav (`app-shell-container.tsx`): with one registered
  // project there is nowhere to switch TO, and a one-row group would be pure noise.
  const registry = projects.data
  const multiProject = registry !== undefined && registry.projects.length > 1
  // The cross-project index answers "which project is this task in", so it is only worth asking
  // when that question has more than one answer. A single-project cockpit issues no request.
  const runsIndex = useRunsIndex(multiProject)

  const orderedProjects = React.useMemo(
    () => (multiProject ? orderProjects(registry.projects, activeProjectId) : []),
    [multiProject, registry, activeProjectId],
  )
  const projectNames = React.useMemo(
    () => new Map((registry?.projects ?? []).map((project) => [project.id, project.name])),
    [registry],
  )
  // Which project `useRuns()` just answered for — see `mergeTasks`. The active id when there is
  // one, else the boot project, which is what an unscoped API client always reaches.
  const runsProjectId = activeProjectId ?? registry?.bootProject ?? null
  const tasks = React.useMemo(
    () => mergeTasks(runs.data ?? [], runsProjectId, runsIndex.data?.runs),
    [runs.data, runsProjectId, runsIndex.data],
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
    navigate(task.projectId === null ? `/tasks/${task.id}` : scopeTo(task.projectId, `/tasks/${task.id}`))
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
