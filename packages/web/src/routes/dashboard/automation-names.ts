import { useEffect, useState } from 'react'
import { z } from 'zod'

const storageKey = 'cezar.dashboard.automation-names.v1'
const historyLimit = 500
const namesSchema = z.array(
  z.tuple([
    z.string().min(1).max(1024),
    z.string().min(1).max(1024),
    z.string().trim().min(1).max(500),
    z.number().int().nonnegative(),
  ]),
).max(historyLimit)
type NameEntry = z.infer<typeof namesSchema>[number]
const identity = (projectId: string, automationId: string) => JSON.stringify([projectId, automationId])

function readNames(): Map<string, NameEntry> {
  try {
    const parsed = namesSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
    return new Map(parsed.success ? parsed.data.map((entry) => [identity(entry[0], entry[1]), entry]) : [])
  } catch {
    return new Map()
  }
}

/** #1959: remember observed names, bounded and project-qualified. Revision beats stale history. */
export function useAutomationNames(
  observed: { projectId: string; automationId: string; name: string; revision?: number }[],
) {
  const [names, setNames] = useState(readNames)
  useEffect(() => {
    const next = new Map(names)
    // A fixed subset must win eviction every render; cycling all 501+ entries never settles.
    for (const entry of observed.slice(-historyLimit)) {
      // Older servers omit revisions; their names remain useful until a versioned snapshot exists.
      const parsed = namesSchema.element.safeParse([
        entry.projectId, entry.automationId, entry.name, entry.revision ?? 0,
      ])
      if (!parsed.success) continue
      const [p, a, name, revision] = parsed.data
      const key = identity(p, a)
      const previous = next.get(key)
      if (previous && (previous[3] > revision || (previous[2] === name && previous[3] === revision))) continue
      next.delete(key)
      next.set(key, parsed.data)
    }
    while (next.size > historyLimit) {
      const oldest = next.keys().next()
      if (oldest.done) break
      next.delete(oldest.value)
    }
    if (next.size === names.size && [...next].every(([key, entry]) => names.get(key) === entry)) return
    setNames(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify([...next.values()]))
    } catch {
      // Disabled or full browser storage must never prevent the dashboard from rendering.
    }
  }, [observed, names])
  return (projectId: string, automationId: string, snapshotRevision = 0) => {
    const entry = names.get(identity(projectId, automationId))
    return entry && entry[3] >= snapshotRevision ? entry[2] : undefined
  }
}
