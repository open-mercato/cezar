import type { ProjectListEntry, RunIndexEntry } from '@open-mercato/cezar-api-client'

import { allProjectTags } from '@/lib/project-tags'
import { runTitle } from '@/lib/task-groups'

/**
 * The pure half of the global Tasks page (`/tasks`): joining the cross-project run index to the
 * project registry, filtering it, and grouping it. The route only paints what these say.
 *
 * Pure on the same terms as `lib/task-groups.ts` and `lib/tasks-table.ts` — no React, no router,
 * no clock — because this is the behavior worth testing as a table.
 *
 * Three decisions worth stating once, here, rather than re-deriving them in the component:
 *
 * 1. **A task's tags are its PROJECT's tags.** Tags label repositories, not runs (see
 *    `ProjectListEntry.tags`), and the whole point of the page is that a `storefront` tag on
 *    three repos makes one list out of three projects' work. A task therefore appears under
 *    EVERY tag its project carries when grouping by tag — a run in a repo tagged
 *    `storefront` + `frontend` is genuinely both, and showing it once (under an arbitrary
 *    "first" tag) would hide it from the other group.
 * 2. **Every facet is a SET, and an empty set means "no opinion".** Values inside one facet are
 *    ORed, facets are ANDed: `tags: [storefront, infra], statuses: [running]` reads as "running
 *    work anywhere in storefront or infra". Single-select would force the exact question the
 *    page exists to answer — "how are these two repos doing?" — to be asked twice.
 *
 *    There is deliberately NO project facet. Narrowing this page to one project is that
 *    project's own Tasks page, which is a better version of the same answer (live SSE, the full
 *    column set, the composer). Every project name here is therefore a LINK, not a filter —
 *    picking one leaves for it rather than turning the global view into a worse local one.
 * 3. **Row identity is `projectId/id`.** The index already keys on the pair, and run ids are only
 *    unique within a project's `runs.json`.
 */

/** The Active/Archived split, shared with the per-project table via `lib/task-groups`. */
export type { ListView } from '@/lib/task-groups'

/** One row of the global table: an index entry plus everything the registry knows about the
 *  project it came from. Resolved once, so no cell has to look a project up again. */
export interface GlobalTask {
  run: RunIndexEntry
  /** The registered project, or `undefined` when the index names one the registry no longer
   *  does (a project removed between the two requests). Such a row still renders — losing a
   *  task from the list because its project row is a few seconds stale would be worse — it
   *  simply shows its raw id and groups as untagged. */
  project: ProjectListEntry | undefined
  /** Display name: the registry's, falling back to the raw project id. */
  projectName: string
  /** The project's tags, normalized server-side; `[]` for an untagged or unknown project. */
  tags: readonly string[]
}

/** The bucket a task with no tags falls into — a filter value and a group key, so it has to be
 *  a string. The leading space keeps it out of the reachable tag space: the registry trims every
 *  tag it stores, so no real one can collide with it. */
export const UNTAGGED = ' untagged'

/** How the table is grouped. `'none'` renders one flat list — the default, because a workspace
 *  small enough to read at a glance should not be pre-sorted into boxes. */
export type GroupBy = 'none' | 'project' | 'tag' | 'status' | 'workflow'

/**
 * The groupings a reader can PICK. `'none'` is deliberately absent: it is the state you are in
 * when nothing is pressed, not a fifth thing to choose. Clicking the pressed option releases it,
 * which is both the shorter gesture ("turn this off" rather than "turn this off by turning
 * something else on") and the honest one — a row of toggles where one is always pressed claims
 * grouping is mandatory when it is not.
 */
export const GROUP_BY_OPTIONS: readonly { value: Exclude<GroupBy, 'none'>; label: string }[] = [
  { value: 'project', label: 'Project' },
  { value: 'tag', label: 'Tag' },
  { value: 'status', label: 'Status' },
  { value: 'workflow', label: 'Workflow' },
]

/** What pressing `picked` does to the current grouping: turns it on, or — when it is already the
 *  one in force — back off. The whole "no None option" rule, in one place. */
export function toggleGroupBy(current: GroupBy, picked: Exclude<GroupBy, 'none'>): GroupBy {
  return current === picked ? 'none' : picked
}

/** Which facets exist. Named as a type so the filter bar can render them from one list and the
 *  toggle helper can name the one it edits without a stringly-typed key. */
export type FacetId = 'tags' | 'statuses' | 'workflows'

export interface GlobalTaskFilters {
  /** Free text over what the table shows — title, project, workflow, branch, tags. */
  query: string
  /** Tags, `UNTAGGED` included. Empty = every project, tagged or not. */
  tags: readonly string[]
  /** `RunStatus` values, kept as plain strings so a status from a newer server passes through
   *  rather than being silently dropped by a narrowed union. Empty = every status. */
  statuses: readonly string[]
  /** Workflow names. Empty = every workflow. */
  workflows: readonly string[]
}

export const NO_FILTERS: GlobalTaskFilters = {
  query: '',
  tags: [],
  statuses: [],
  workflows: [],
}

/** Add or remove one value from a facet — what every chip click and checkbox does. Returns a new
 *  array, so it composes with `setState` without a mutation nobody can see. */
export function toggleFacetValue(
  values: readonly string[],
  value: string,
): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

/** How many facet values are selected — the number the "Clear" affordance and each facet pill's
 *  badge print. The query is not one of them; it has its own visible input. */
export function activeFacetCount(filters: GlobalTaskFilters): number {
  return filters.tags.length + filters.statuses.length + filters.workflows.length
}

/** Are any filters narrowing the list? Drives the empty state's wording — "nothing here" and
 *  "nothing matches" are different facts. */
export function hasActiveFilters(filters: GlobalTaskFilters): boolean {
  return filters.query.trim() !== '' || activeFacetCount(filters) > 0
}

/**
 * How many things "Clear" would undo — the number the button prints, and therefore a promise it
 * has to keep. Every facet value, the search text if there is any, and the grouping: all three
 * are things the reader turned on and the button turns off, so all three count. Counting only
 * facet values made "Clear (1)" appear over two applied narrowings.
 *
 * The Active/Archived view is NOT counted, and not cleared, deliberately: it chooses WHICH list
 * you are reading, not how that list is narrowed. Clearing filters must not also move you to a
 * different list.
 */
export function resetCount(state: Pick<GlobalTasksUrlState, 'filters' | 'groupBy'>): number {
  return (
    activeFacetCount(state.filters) +
    (state.filters.query.trim() === '' ? 0 : 1) +
    (state.groupBy === 'none' ? 0 : 1)
  )
}

/** Is there anything for "Clear" to undo? The button is the one way back to a plain list, so it
 *  has to appear for a grouping applied with no filter at all — which would otherwise leave it
 *  hidden and the table boxed up with nothing to click. */
export function canReset(state: Pick<GlobalTasksUrlState, 'filters' | 'groupBy'>): boolean {
  return resetCount(state) > 0
}

/**
 * Join the index to the registry. Order is preserved — the server already sorts newest-first
 * across every project, and re-sorting here would only invent a second opinion about "recent".
 */
export function toGlobalTasks(
  runs: readonly RunIndexEntry[],
  projects: readonly ProjectListEntry[],
): GlobalTask[] {
  const byId = new Map(projects.map((project) => [project.id, project]))
  return runs.map((run) => {
    const project = byId.get(run.projectId)
    return {
      run,
      project,
      projectName: project?.name || run.projectId,
      tags: project?.tags ?? [],
    }
  })
}

/** Every workflow present in the CURRENT list — the workflow facet's options. Derived from the
 *  tasks rather than from a static catalog: a workflow nobody has run is not worth an option
 *  that can only ever produce an empty table. */
export function allWorkflows(tasks: readonly GlobalTask[]): string[] {
  const seen = new Set<string>()
  for (const task of tasks) seen.add(task.run.workflow)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** Every status present in the current list, in the same derive-from-the-data spirit. */
export function allStatuses(tasks: readonly GlobalTask[]): string[] {
  const seen = new Set<string>()
  for (const task of tasks) seen.add(task.run.status)
  return [...seen].sort((a, b) => a.localeCompare(b))
}

/** How many of `tasks` a facet value would leave — the count each chip and checkbox shows, so a
 *  filter that would empty the table says so before it is clicked. Counted against the list as
 *  filtered by the OTHER facets, which is what makes the numbers add up as you narrow. */
export function facetCounts(
  tasks: readonly GlobalTask[],
  valueOf: (task: GlobalTask) => readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const value of valueOf(task)) counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

/** A task's tag values for counting/filtering: its project's tags, or the untagged sentinel. */
export const tagValuesOf = (task: GlobalTask): readonly string[] =>
  task.tags.length === 0 ? [UNTAGGED] : task.tags

const matchesFacet = (selected: readonly string[], values: readonly string[]): boolean =>
  selected.length === 0 || values.some((value) => selected.includes(value))

const matchesTags = (task: GlobalTask, selected: readonly string[]): boolean => {
  if (selected.length === 0) return true
  const lowered = tagValuesOf(task).map((tag) => tag.toLowerCase())
  return selected.some((tag) => lowered.includes(tag.toLowerCase()))
}

/**
 * Search text for one row: the displayed title, the project name, the workflow, the tags — and
 * the branch, which is the one thing here the table does NOT print.
 *
 * The rule it bends is a real one (matching on text the table never shows makes rows appear for
 * no visible reason, which is why the run id and a title hidden behind a summary stay out), but
 * a branch name is the exception the per-project table already makes: its Branch column is
 * FOLDED by default (`lib/task-columns.ts`) and `filterRuns` searches it anyway. Pasting a
 * branch name from a terminal to find the task that made it is a deliberate gesture, not an
 * accidental match, so dropping the column here does not mean dropping the ability.
 */
function haystack(task: GlobalTask): string {
  return [
    runTitle(task.run),
    task.projectName,
    task.run.workflow,
    task.run.branch ?? '',
    ...task.tags,
  ]
    .join('\n')
    .toLowerCase()
}

/**
 * The list a set of filters leaves. Every whitespace-separated token of the query must match
 * somewhere (`shop auth` finds the auth task in shop, and nothing else) — the same
 * every-token rule the ⌘K palette uses, so the two search boxes behave alike.
 */
export function filterGlobalTasks(
  tasks: readonly GlobalTask[],
  filters: GlobalTaskFilters,
  view: 'active' | 'archived',
): GlobalTask[] {
  const tokens = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return tasks.filter((task) => {
    if (view === 'archived' ? !task.run.archived : task.run.archived) return false
    if (!matchesFacet(filters.statuses, [task.run.status])) return false
    if (!matchesFacet(filters.workflows, [task.run.workflow])) return false
    if (!matchesTags(task, filters.tags)) return false
    if (tokens.length === 0) return true
    const text = haystack(task)
    return tokens.every((token) => text.includes(token))
  })
}

/** The list as every facet EXCEPT `except` narrows it — what the counts beside that facet's own
 *  options are computed over, so unticking one of its values shows how many rows would return
 *  rather than a number that already assumes the tick. */
export function tasksExcludingFacet(
  tasks: readonly GlobalTask[],
  filters: GlobalTaskFilters,
  view: 'active' | 'archived',
  except: FacetId,
): GlobalTask[] {
  return filterGlobalTasks(tasks, { ...filters, [except]: [] }, view)
}

/** One rendered group: a heading and its rows. `key` is stable identity (a project id, a tag,
 *  a status); `label` is what the heading prints. */
export interface TaskGroup {
  key: string
  label: string
  tasks: GlobalTask[]
}

/**
 * Bucket the filtered list.
 *
 * `none` returns one unlabeled group, so the component has exactly one rendering path.
 * Grouping by tag is the one FAN-OUT: a task whose project carries three tags appears in three
 * groups (see the module header). Every other key is single-valued.
 *
 * Groups are ordered by size (largest first) then by label, which puts the piece of work you
 * actually have in flight at the top instead of wherever the alphabet happens to place it. The
 * untagged bucket always sorts last — it is the leftovers, not a group.
 */
export function groupGlobalTasks(tasks: readonly GlobalTask[], groupBy: GroupBy): TaskGroup[] {
  if (groupBy === 'none') return [{ key: 'all', label: '', tasks: [...tasks] }]

  const groups = new Map<string, TaskGroup>()
  const push = (key: string, label: string, task: GlobalTask) => {
    const existing = groups.get(key)
    if (existing) existing.tasks.push(task)
    else groups.set(key, { key, label, tasks: [task] })
  }

  for (const task of tasks) {
    if (groupBy === 'project') {
      push(task.run.projectId, task.projectName, task)
    } else if (groupBy === 'status') {
      push(task.run.status, task.run.status, task)
    } else if (groupBy === 'workflow') {
      push(task.run.workflow, task.run.workflow, task)
    } else if (task.tags.length === 0) {
      push(UNTAGGED, 'Untagged', task)
    } else {
      for (const tag of task.tags) push(tag.toLowerCase(), tag, task)
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (a.key === UNTAGGED) return 1
    if (b.key === UNTAGGED) return -1
    return b.tasks.length - a.tasks.length || a.label.localeCompare(b.label)
  })
}

/** The projects the index had to cap, named for the truncation notice — registry names where we
 *  have them, raw ids otherwise. A capped list that says nothing reads as "your task is not
 *  here" when the honest answer is "not in the newest N". */
export function truncatedProjectNames(
  truncated: readonly string[],
  projects: readonly ProjectListEntry[],
): string[] {
  const byId = new Map(projects.map((project) => [project.id, project.name]))
  return truncated.map((id) => byId.get(id) || id)
}

// ---- URL state ------------------------------------------------------------------------------

/**
 * The query-param names. Named once so the encoder, the decoder and anyone reading a pasted URL
 * agree, and short because they end up in the address bar.
 *
 * Two spellings are deliberate:
 *
 *  - `untagged` is its own boolean rather than a value of `tag`. The untagged bucket's sentinel
 *    is `' untagged'` (leading space, so no real tag can collide with it), which would either
 *    serialize as a confusing `tag=+untagged` or, spelled without the space, become genuinely
 *    ambiguous with a repo actually tagged `untagged`.
 *  - the Active/Archived split is `archived=1` PRESENT-or-ABSENT rather than `view=active|
 *    archived`. Active is the default and by far the common case, so spelling it out would put a
 *    key in every shared link that says only "the normal thing".
 */
export const SEARCH_PARAMS = {
  query: 'q',
  tag: 'tag',
  untagged: 'untagged',
  status: 'status',
  workflow: 'workflow',
  groupBy: 'group',
  archived: 'archived',
} as const

const GROUP_BY_VALUES = new Set<string>(GROUP_BY_OPTIONS.map((option) => option.value))

/** Everything about the page that a URL carries — what a refresh restores and a pasted link
 *  reproduces. */
export interface GlobalTasksUrlState {
  filters: GlobalTaskFilters
  groupBy: GroupBy
  /** Active/Archived. Also mirrored into the shared `useListView()` context by the route, so the
   *  rest of the cockpit keeps answering the same question. */
  view: ListViewValue
}

/** The local spelling of `ListView`, so this module's public shape does not depend on a
 *  re-export the type-only `export type { ListView }` above cannot provide a value for. */
type ListViewValue = 'active' | 'archived'

/** A bare `/tasks`: everything unfiltered, ungrouped, Active. */
export const DEFAULT_URL_STATE: GlobalTasksUrlState = {
  filters: NO_FILTERS,
  groupBy: 'none',
  view: 'active',
}

/**
 * Page state → query params.
 *
 * Defaults emit NOTHING, so a bare `/tasks` stays bare rather than a URL full of keys saying
 * "the normal thing" — which also means "is anything narrowed?" is visible in the address bar.
 * Multi-value facets repeat their key (`?tag=api&tag=web`), the form `URLSearchParams` was built
 * for and the one that cannot be broken by a value containing the separator.
 */
export function urlStateToSearchParams(state: GlobalTasksUrlState): URLSearchParams {
  const params = new URLSearchParams()
  const query = state.filters.query.trim()
  if (query !== '') params.set(SEARCH_PARAMS.query, query)
  for (const tag of state.filters.tags) {
    if (tag === UNTAGGED) params.set(SEARCH_PARAMS.untagged, '1')
    else params.append(SEARCH_PARAMS.tag, tag)
  }
  for (const status of state.filters.statuses) params.append(SEARCH_PARAMS.status, status)
  for (const workflow of state.filters.workflows) params.append(SEARCH_PARAMS.workflow, workflow)
  if (state.groupBy !== 'none') params.set(SEARCH_PARAMS.groupBy, state.groupBy)
  if (state.view === 'archived') params.set(SEARCH_PARAMS.archived, '1')
  return params
}

/**
 * Query params → page state. The inverse of the above, and deliberately FORGIVING: this parses
 * whatever a pasted, hand-edited or older-version URL happens to carry, so an unknown `group`
 * degrades to "not grouped" rather than to a blank page, and absent keys are simply the defaults.
 * A filter naming a tag or workflow nothing has just leaves an empty table, which is the honest
 * answer to what the URL asked for.
 */
export function urlStateFromSearchParams(params: URLSearchParams): GlobalTasksUrlState {
  const tags = params.getAll(SEARCH_PARAMS.tag).filter((tag) => tag !== '')
  if (params.get(SEARCH_PARAMS.untagged) === '1') tags.push(UNTAGGED)
  const group = params.get(SEARCH_PARAMS.groupBy) ?? ''
  return {
    filters: {
      query: params.get(SEARCH_PARAMS.query) ?? '',
      tags,
      statuses: params.getAll(SEARCH_PARAMS.status).filter((status) => status !== ''),
      workflows: params.getAll(SEARCH_PARAMS.workflow).filter((workflow) => workflow !== ''),
    },
    groupBy: GROUP_BY_VALUES.has(group) ? (group as GroupBy) : 'none',
    view: params.get(SEARCH_PARAMS.archived) === '1' ? 'archived' : 'active',
  }
}
