/**
 * Where "open this run" goes (spec 2026-11-15-framework-board): a framework card opens its card
 * wizard, every other run its task view. Call sites that hold the run use `runRoute`; links that
 * only know an id land on `/tasks/:id`, whose route redirects a card through `cardRedirect`.
 */

type Routable = { id: string; card?: unknown }

export interface RunRouteOptions {
  /** Force the task view even for a card — the wizard's "Open task view". */
  taskView?: boolean
  /** A task-view sub-path or hash (`/changes`, `#ask`): only the task view has those tabs. */
  suffix?: string
}

/** The query that keeps `/tasks/:id` on the task view for a card (sticky for the session). */
export const TASK_VIEW_PARAM = 'view'
export const TASK_VIEW_VALUE = 'task'

export function cardRoute(runId: string): string {
  return `/cards/${runId}`
}

/** The flat (project-relative) path that opens `run`. */
export function runRoute(run: Routable, options: RunRouteOptions = {}): string {
  const suffix = options.suffix ?? ''
  const isCard = run.card !== undefined && run.card !== null
  if (isCard && !options.taskView) {
    // `#ask` / `#reply` are answered in the wizard's conversation body too.
    if (suffix === '' || suffix.startsWith('#')) return `${cardRoute(run.id)}${suffix}`
  }
  if (isCard && options.taskView && suffix === '') return `/tasks/${run.id}?${TASK_VIEW_PARAM}=${TASK_VIEW_VALUE}`
  return `/tasks/${run.id}${suffix}`
}

/** Cards whose task view was asked for explicitly this session: their `/tasks/:id` stays put, so
 *  the task view's own tab links (Session ↔ Changes) do not bounce back to the wizard. */
const taskViewChosen = new Set<string>()

export function rememberTaskView(runId: string): void {
  taskViewChosen.add(runId)
}

/** Test seam. */
export function forgetTaskViews(): void {
  taskViewChosen.clear()
}

/**
 * Where a bare `/tasks/:id` visit should go instead, or null to stay: a card redirects to its
 * wizard unless `?view=task` asks for the task view (remembered for the session).
 */
export function cardRedirect(run: Routable, search: string, hash = ''): string | null {
  if (run.card === undefined || run.card === null) return null
  if (new URLSearchParams(search).get(TASK_VIEW_PARAM) === TASK_VIEW_VALUE) {
    rememberTaskView(run.id)
    return null
  }
  if (taskViewChosen.has(run.id)) return null
  return `${cardRoute(run.id)}${hash}`
}
