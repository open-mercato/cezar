import {
  AUTOMATION_ORDER_LIMIT,
  automationScheduleSchema,
  nextOccurrence,
  type AutomationListEntry,
  type AutomationListPreferences,
} from '@open-mercato/cezar-api-client'

export type AutomationSort = NonNullable<AutomationListPreferences['sort']>
export type AutomationOrder = Required<Pick<AutomationListPreferences, 'sort' | 'order'>>

export function normalizeAutomationOrder(value: unknown): AutomationOrder {
  const prefs = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const sort = prefs.sort === 'manual' || prefs.sort === 'nextRun' ? prefs.sort : 'name'
  const ids = new Set<string>()
  if (Array.isArray(prefs.order)) {
    for (const candidate of prefs.order) {
      if (typeof candidate !== 'string') continue
      const id = candidate.trim()
      if (id && id.length <= 200) ids.add(id)
      if (ids.size >= AUTOMATION_ORDER_LIMIT) break
    }
  }
  return { sort, order: [...ids] }
}

/** Shared by the display and sort so unavailable instants cannot disagree (#1819). */
export function nextAutomationRun(automation: AutomationListEntry, timeZone: string, now: number): number | null {
  if (!automation.enabled || automation.kind !== 'schedule') return null
  if (automation.nextRunAt !== undefined) {
    const value = Date.parse(automation.nextRunAt)
    return Number.isFinite(value) ? value : null
  }
  // A newer server may send multiple schedules before this client's response type knows
  // that optional field. Validate each shape with the contract and use the shared clock math.
  const raw: unknown = 'schedules' in automation ? automation.schedules : undefined
  let earliest: number | null = null
  for (const candidate of Array.isArray(raw) ? raw : [automation.schedule]) {
    const schedule = automationScheduleSchema.safeParse(candidate)
    if (!schedule.success) continue
    const next = nextOccurrence(schedule.data, now, timeZone)
    if (next !== null && Number.isFinite(next) && (earliest === null || next < earliest)) earliest = next
  }
  return earliest
}

const byName = (a: AutomationListEntry, b: AutomationListEntry) =>
  a.name.localeCompare(b.name) || a.id.localeCompare(b.id)

export function orderAutomations(
  entries: readonly AutomationListEntry[], prefs: AutomationOrder, timeZone: string, now: number,
): AutomationListEntry[] {
  if (prefs.sort === 'manual') {
    const rank = new Map(prefs.order.map((id, index) => [id, index]))
    const unplaced = entries.filter((entry) => !rank.has(entry.id)).sort(byName)
    const placed = entries.filter((entry) => rank.has(entry.id))
      .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    return [...unplaced, ...placed]
  }
  if (prefs.sort === 'name') return [...entries].sort(byName)

  const rank = (entry: AutomationListEntry): [number, number] => {
    const instant = nextAutomationRun(entry, timeZone, now)
    if (instant !== null) return [0, instant]
    return [entry.enabled && entry.kind !== 'schedule' ? 1 : 2, 0]
  }
  const ranks = new Map(entries.map((entry) => [entry.id, rank(entry)]))
  return [...entries].sort((a, b) => {
    const left = ranks.get(a.id), right = ranks.get(b.id)
    if (left === undefined || right === undefined) return byName(a, b)
    return left[0] - right[0] || left[1] - right[1] || byName(a, b)
  })
}

export function moveAutomation(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length || from === to) return [...ids]
  const result = [...ids]
  const [id] = result.splice(from, 1)
  if (id === undefined) return [...ids]
  result.splice(to, 0, id)
  return result
}
