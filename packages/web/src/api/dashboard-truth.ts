import { useSyncExternalStore } from 'react'
import type { DashboardTaskRow } from '@open-mercato/cezar-api-client'
// Thin transition overlay; it never synthesizes a dashboard row. A staged row must stop
// offering an obsolete action immediately, before the debounced authoritative read returns.
const rows = new Map<
  string,
  {
    value: { status: DashboardTaskRow['status']; archived: boolean } | null
    revision: number
  }
>()
const removedProjects = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0
/** Registry removal applies to every retained task, including rows outside the current page. */
export function dashboardProjectTransition(project: string, removed: boolean) {
  if (removed) removedProjects.set(project, version + 1)
  else removedProjects.delete(project)
  version++
  listeners.forEach((fn) => fn())
}
export function dashboardTransition(
  project: string,
  run: { id: string; status: DashboardTaskRow['status']; archived: boolean } | string,
) {
  const key = `${project}:${typeof run === 'string' ? run : run.id}`
  rows.delete(key)
  rows.set(key, {
    value:
      typeof run === 'string' ? null : { status: run.status, archived: run.archived },
    revision: version + 1,
  })
  if (rows.size > 2000) rows.delete(rows.keys().next().value!)
  version++
  listeners.forEach((fn) => fn())
}
export function useDashboardTruth(row: Pick<DashboardTaskRow, 'projectId' | 'id'>) {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    () => version,
  )
  return dashboardTruth(row.projectId, row.id)
}

export const dashboardTruthRevision = () => version
export const dashboardTruth = (projectId: string, runId: string) =>
  removedProjects.has(projectId) ? null : rows.get(`${projectId}:${runId}`)?.value
/** Bounded pages cannot disprove a known transition for an absent identity.
 * Reconcile only positively returned identities; keep their current fields overlaid
 * for staged rows that still contain an older status. In-flight newer frames win. */
export function reconcileDashboardTruth(
  revision: number,
  present: readonly (Pick<DashboardTaskRow, 'projectId' | 'id'> &
    Partial<Pick<DashboardTaskRow, 'status' | 'archived'>>)[] = [],
) {
  const current = new Map(present.map((row) => [`${row.projectId}:${row.id}`, row]))
  let changed = false
  for (const row of present) {
    const removedAt = removedProjects.get(row.projectId)
    if (removedAt !== undefined && removedAt <= revision) {
      removedProjects.delete(row.projectId)
      changed = true
    }
  }
  for (const [key, entry] of rows) {
    const row = current.get(key)
    if (entry.revision > revision || !row) continue
    if (row.status !== undefined && row.archived !== undefined) {
      // The observation itself is newer, even if its value is unchanged. Saved
      // pages captured before this confirmation must not roll it back later.
      rows.set(key, {
        value: { status: row.status, archived: row.archived },
        revision: version + 1,
      })
      changed = true
    } else if (entry.value === null) {
      rows.delete(key)
      changed = true
    }
  }
  if (changed) {
    version++
    listeners.forEach((fn) => fn())
  }
}
