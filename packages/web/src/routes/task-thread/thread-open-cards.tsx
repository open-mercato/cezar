import { createContext, useContext, useMemo, type ReactNode } from 'react'

/**
 * The open-card cache (spec §"Task thread": "per-session measurement + open-card cache"):
 * which tool cards the user explicitly opened or closed, per run id, so leaving a thread and
 * coming back restores the cards exactly as they were left. Module-level like the PlanDock
 * collapse memory and the scroll cache — session-scoped, never persisted.
 *
 * Keys are `${turnKey}:${itemId}`, NOT the bare item id: per-session item ids restart
 * (`item_1` again each step), so the turn's stable render key disambiguates reuses. Cards
 * the user never touched stay out of the map — their open state remains the status-derived
 * default, which is live (a running command card still auto-opens on revisit).
 */
const openCardsByRun = new Map<string, Map<string, boolean>>()

export interface ThreadCardCacheValue {
  get(key: string): boolean | undefined
  set(key: string, open: boolean): void
}

/** Null outside a thread: a ToolCard rendered elsewhere keeps plain local state. */
export const ThreadCardCacheContext = createContext<ThreadCardCacheValue | null>(null)

export function useThreadCardCache(): ThreadCardCacheValue | null {
  return useContext(ThreadCardCacheContext)
}

/** Provides the run's slice of the cache to every card under it. */
export function ThreadCardCache({ runId, children }: { runId: string; children: ReactNode }) {
  const value = useMemo<ThreadCardCacheValue>(
    () => ({
      get: (key) => openCardsByRun.get(runId)?.get(key),
      set: (key, open) => {
        const forRun = openCardsByRun.get(runId) ?? new Map<string, boolean>()
        forRun.set(key, open)
        openCardsByRun.set(runId, forRun)
      },
    }),
    [runId],
  )
  return <ThreadCardCacheContext.Provider value={value}>{children}</ThreadCardCacheContext.Provider>
}

/** Test seam — module state must not leak between tests. */
export function clearOpenCardCache(): void {
  openCardsByRun.clear()
}
