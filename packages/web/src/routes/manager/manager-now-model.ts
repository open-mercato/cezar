import type { AttentionItem, ManagerSummary } from '@open-mercato/cezar-api-client'

/**
 * Manager mode's Now (spec 2026-11-23-needs-you-triage § Manager mode): the attention list as the
 * managers see it. All managers by default; the filter narrows it to one. An item belongs to a manager
 * when it is the manager's own (a question, an approval, a message) or a task it started or follows.
 */

export type ManagerNowManager = Pick<ManagerSummary, 'id' | 'name' | 'followedTasks'>

export interface ManagerNowEntry {
  item: AttentionItem
  /** The managers it belongs to, in the managers list's order. */
  owners: string[]
}

export const MANAGER_NOW_PATH = '/manager/now'
export const MANAGER_FILTER_PARAM = 'manager'

export function managerNowEntries(items: readonly AttentionItem[], managers: readonly ManagerNowManager[]): ManagerNowEntry[] {
  const known = new Set(managers.map((manager) => manager.id))
  return items.flatMap((item) => {
    if (item.managerId !== undefined) return known.has(item.managerId) ? [{ item, owners: [item.managerId] }] : []
    if (!item.projectId || !item.runId) return []
    const task = `${item.projectId}/${item.runId}`
    const owners = managers.filter((manager) => manager.followedTasks.includes(task)).map((manager) => manager.id)
    return owners.length > 0 ? [{ item, owners }] : []
  })
}

export const ownedBy = (entries: readonly ManagerNowEntry[], managerId: string | undefined): ManagerNowEntry[] =>
  managerId === undefined ? [...entries] : entries.filter((entry) => entry.owners.includes(managerId))

/** What the badge counts: as Now counts, never a probably-done or uncounted item. */
export const countLive = (entries: readonly ManagerNowEntry[]): number =>
  entries.filter((entry) => entry.item.counted && !entry.item.settled).length

/** The filter's own value, or undefined (All managers) for a manager that is gone. */
export function managerFilter(search: URLSearchParams, managers: readonly Pick<ManagerSummary, 'id'>[]): string | undefined {
  const id = search.get(MANAGER_FILTER_PARAM) ?? undefined
  return id !== undefined && managers.some((manager) => manager.id === id) ? id : undefined
}

export const managerNowHref = (managerId?: string): string =>
  managerId ? `${MANAGER_NOW_PATH}?${MANAGER_FILTER_PARAM}=${encodeURIComponent(managerId)}` : MANAGER_NOW_PATH
