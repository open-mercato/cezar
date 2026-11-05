import { useEffect, useState } from 'react'
import { z } from 'zod'

const storageKey = 'cezar.dashboard.automation-names.v1'
const namesSchema = z.array(
  z.tuple([
    z.string().min(1).max(1024),
    z.string().min(1).max(1024),
    z.string().trim().min(1).max(500),
  ]),
).max(500)
const identity = (projectId: string, automationId: string) => JSON.stringify([projectId, automationId])

function readNames(): Map<string, string> {
  try {
    const parsed = namesSchema.safeParse(JSON.parse(localStorage.getItem(storageKey) ?? '[]'))
    return new Map(parsed.success ? parsed.data.map(([p, a, name]) => [identity(p, a), name]) : [])
  } catch {
    return new Map()
  }
}

/** Best-effort history of names actually observed in this browser. Never infer removal here. */
export function useAutomationNames(
  observed: { projectId: string; automationId: string; name: string }[],
) {
  const [names, setNames] = useState(readNames)
  useEffect(() => {
    const next = new Map(names)
    for (const entry of observed) {
      const parsed = namesSchema.element.safeParse([entry.projectId, entry.automationId, entry.name])
      if (!parsed.success) continue
      const [p, a, name] = parsed.data
      const key = identity(p, a)
      if (next.get(key) === name) continue
      next.delete(key)
      next.set(key, name)
    }
    while (next.size > 500) next.delete(next.keys().next().value!)
    if (next.size === names.size && [...next].every(([key, name]) => names.get(key) === name)) return
    setNames(next)
    try {
      const entries = [...next].map(([key, name]) => [...JSON.parse(key), name])
      localStorage.setItem(storageKey, JSON.stringify(entries))
    } catch {
      // Disabled or full browser storage must never prevent the dashboard from rendering.
    }
  }, [observed, names])
  return (projectId: string, automationId: string) => names.get(identity(projectId, automationId))
}
