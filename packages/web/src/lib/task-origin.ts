import * as React from 'react'

/**
 * Who started a task — a person, or an automation — and the remembered filter both Tasks tables
 * read it through.
 *
 * Automations launch an ordinary run per match or occurrence, so a busy one buries the work a
 * person typed under a page of its own. Each table therefore opens on REGULAR tasks, with
 * Automations and All a click away. Unlike the Active/Archived split (in-memory on purpose, see
 * `components/list-view.tsx`), this choice is remembered: it is a standing preference about what
 * the list is FOR, not a narrowing the user forgets they applied — and the selected control on
 * the filter row says what is hidden, every time the page opens.
 *
 * Per browser, in localStorage, like the sidebar collapse map (`lib/sidebar-collapse.ts`): one
 * answer shared by the per-project table and the global page, with no PUT to race.
 */

export type TaskOrigin = 'regular' | 'automation' | 'all'

export const DEFAULT_TASK_ORIGIN: TaskOrigin = 'regular'

export const TASK_ORIGIN_OPTIONS: readonly { value: TaskOrigin; label: string }[] = [
  { value: 'regular', label: 'Regular' },
  { value: 'automation', label: 'Automations' },
  { value: 'all', label: 'All' },
]

export const TASK_ORIGIN_STORAGE_KEY = 'cez-task-origin'

/** The provenance keys a run may carry, on either wire shape: the full `RunRecord` has the three
 *  launch records, the slim cross-project `RunIndexEntry` has them folded into `automationId`. */
export interface OriginInput {
  id: string
  automationId?: string
  automation?: { automationId: string }
  automationTrigger?: { automationId: string }
  automationTracker?: { automationId: string }
  dispatch?: { rootRunId: string }
}

/** The automation that launched THIS run, read off its own record only. */
export function ownAutomationId(run: OriginInput): string | undefined {
  return (
    run.automationId ??
    run.automation?.automationId ??
    run.automationTrigger?.automationId ??
    run.automationTracker?.automationId
  )
}

/**
 * The automation a run belongs to — its own, or its dispatch root's. A task an automation started
 * may dispatch children, and those children carry no provenance of their own; filing them as
 * "regular" would leave them floating at the top of the person's list as orphans of a parent the
 * filter just hid. `rootOf` resolves a root id against the list being filtered; a root the list
 * does not hold (capped, or deleted) leaves the child as its own answer.
 */
export function automationIdOf<T extends OriginInput>(
  run: T,
  rootOf: (rootRunId: string) => T | undefined,
): string | undefined {
  const own = ownAutomationId(run)
  if (own !== undefined) return own
  const rootId = run.dispatch?.rootRunId
  if (rootId === undefined || rootId === run.id) return undefined
  const root = rootOf(rootId)
  return root === undefined ? undefined : ownAutomationId(root)
}

/** Does a run with this automation id (or none) belong under `origin`? */
export function matchesOrigin(automationId: string | undefined, origin: TaskOrigin): boolean {
  if (origin === 'all') return true
  return origin === 'automation' ? automationId !== undefined : automationId === undefined
}

/** Anything (a missing key, a hand-edited value) → a valid origin, defaulting to Regular. */
export function normalizeTaskOrigin(raw: unknown): TaskOrigin {
  return raw === 'regular' || raw === 'automation' || raw === 'all' ? raw : DEFAULT_TASK_ORIGIN
}

export function readStoredTaskOrigin(): TaskOrigin {
  try {
    return normalizeTaskOrigin(localStorage.getItem(TASK_ORIGIN_STORAGE_KEY))
  } catch {
    // Private mode or no storage — the default still answers.
    return DEFAULT_TASK_ORIGIN
  }
}

const listeners = new Set<() => void>()

/** What a write that storage refused leaves behind, so the control still moves this session. */
let fallback: TaskOrigin | undefined

export function writeStoredTaskOrigin(origin: TaskOrigin): void {
  try {
    localStorage.setItem(TASK_ORIGIN_STORAGE_KEY, origin)
  } catch {
    // Private mode / storage full — the choice still applies until the page reloads.
    fallback = origin
  }
  for (const listener of listeners) listener()
}

function snapshot(): TaskOrigin {
  return fallback ?? readStoredTaskOrigin()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another tab's choice is this tab's choice too — the same browser, the same preference.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === TASK_ORIGIN_STORAGE_KEY) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

/** The remembered origin and its setter — one value for every table that reads it. */
export function useTaskOrigin(): [TaskOrigin, (origin: TaskOrigin) => void] {
  const origin = React.useSyncExternalStore(subscribe, snapshot, () => DEFAULT_TASK_ORIGIN)
  return [origin, writeStoredTaskOrigin]
}
