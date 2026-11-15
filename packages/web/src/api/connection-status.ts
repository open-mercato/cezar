import { useSyncExternalStore } from 'react'

/**
 * What the connection banner says beyond up/down (`dashboardLive.connected`): how many reconnect
 * attempts failed since the stream was last open, and the one way to ask for another right now.
 * The workspace stream (global-events.tsx) owns both; the banner only reads and asks.
 */
export function createConnectionStatus() {
  const listeners = new Set<() => void>()
  let attempt = 0
  let reconnect: (() => void) | undefined
  const emit = () => listeners.forEach((fn) => fn())
  return {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    attempt: () => attempt,
    /** One more try that has not (yet) opened the stream. */
    failedAttempt() {
      attempt += 1
      emit()
    },
    opened() {
      if (attempt === 0) return
      attempt = 0
      emit()
    },
    /** The stream registers how to reconnect; returns the unregister. */
    setReconnect(fn: () => void) {
      reconnect = fn
      return () => {
        if (reconnect === fn) reconnect = undefined
      }
    },
    /** Skip any backoff and reconnect now (the banner's Retry now). */
    reconnectNow() {
      reconnect?.()
    },
  }
}

export const connectionStatus = createConnectionStatus()

export const useReconnectAttempt = (): number =>
  useSyncExternalStore(connectionStatus.subscribe, connectionStatus.attempt, () => 0)
