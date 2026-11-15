import { useSyncExternalStore } from 'react'
import {
  NATIVE_CONNECTION_STATUS_EVENT,
  nativeConnectionStatusSchema,
  type NativeConnectionStatus,
} from '@open-mercato/cezar-api-client'

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

// The shell's side of the contract: `nativeConnectionStatusSchema` (packages/contract, native-shell.ts).
function createNativeConnectionStatus() {
  const listeners = new Set<() => void>()
  let status: NativeConnectionStatus | undefined
  return {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    current: () => status,
    receive(event: Event) {
      const parsed = nativeConnectionStatusSchema.safeParse((event as CustomEvent<unknown>).detail)
      if (!parsed.success) return
      status = parsed.data.reason === 'connected' ? undefined : parsed.data
      listeners.forEach((fn) => fn())
    },
    /** Test seam. */
    reset() {
      status = undefined
    },
  }
}

export const nativeConnectionStatus = createNativeConnectionStatus()
// From the first import, not the banner's mount: the shell may speak before React has rendered.
if (typeof window !== 'undefined') window.addEventListener(NATIVE_CONNECTION_STATUS_EVENT, nativeConnectionStatus.receive)

/** The shell's reason for the drop, while it has one (never 'connected'). */
export const useNativeConnectionStatus = (): NativeConnectionStatus | undefined =>
  useSyncExternalStore(nativeConnectionStatus.subscribe, nativeConnectionStatus.current, () => undefined)
