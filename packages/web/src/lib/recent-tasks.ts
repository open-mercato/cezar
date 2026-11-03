/**
 * The tasks you opened most recently, newest first — the ⌘P switcher's order (spec
 * 2026-10-17-task-palette). Run ids only: a uuid names one task across projects, and the palette
 * resolves the rest from the run lists it already holds. Browser-local and capped, so it can only
 * ever be lost, never wrong; a blocked `localStorage` degrades to an in-memory list.
 */

const STORAGE_KEY = 'cezar:recent-tasks:v1'
export const RECENT_TASKS_CAP = 30

let memory: string[] | null = null

function read(): string[] {
  if (memory) return memory
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')
    memory = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    memory = []
  }
  return memory
}

export function readRecentTasks(): readonly string[] {
  return read()
}

export function recordTaskVisit(runId: string): void {
  const next = [runId, ...read().filter((id) => id !== runId)].slice(0, RECENT_TASKS_CAP)
  memory = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private mode or a full quota: the in-memory list still serves this tab.
  }
}

/** Test seam. */
export function resetRecentTasks(): void {
  memory = null
}

/** `items` reordered so recently opened ones lead, in recency order; the rest keep their order. */
export function orderByRecency<T>(items: readonly T[], idOf: (item: T) => string, recent: readonly string[]): T[] {
  const rank = new Map(recent.map((id, index) => [id, index]))
  const visited = items.filter((item) => rank.has(idOf(item)))
  visited.sort((a, b) => rank.get(idOf(a))! - rank.get(idOf(b))!)
  return [...visited, ...items.filter((item) => !rank.has(idOf(item)))]
}
