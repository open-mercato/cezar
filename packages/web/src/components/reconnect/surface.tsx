import { createContext, useContext } from 'react'

/**
 * What the surface around a reconnect card can do that the card cannot: switch the blocked work to
 * another account of the same agent. A manager PATCHes its `agentProfile` and re-sends the turn; a
 * task Continues with `agentProfile`, which starts a fresh session (spec 2026-07-29-agent-profiles).
 */
export interface ReconnectSurface {
  kind: 'manager' | 'task'
  /** The manager or run this card belongs to: "Also resuming" lists only the others. */
  ownId?: string
  switchTo?: (profileId: string) => Promise<unknown>
  /** A task's current auth park; `null` when it is not parked, so an old rejection stays quiet. */
  parked?: { provider: string; profileId: string } | null
}

export const ReconnectSurfaceContext = createContext<ReconnectSurface | undefined>(undefined)

export const useReconnectSurface = (): ReconnectSurface | undefined => useContext(ReconnectSurfaceContext)
