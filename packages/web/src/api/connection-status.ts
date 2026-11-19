import { useSyncExternalStore } from 'react'
import {
  CEZAR_COMPUTER_HEADER,
  CEZAR_UNREACHABLE_HEADER,
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
  let answering = false
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
    /** Whether the last plain request got cezar's own answer: the stream can be down while it does. */
    answering: () => answering,
    /** Every request's outcome: an answer, or none (unreachable, or a gateway's 502/503/504). */
    requestSettled(answered: boolean) {
      if (answered === answering) return
      answering = answered
      emit()
    },
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

export const useRequestsAnswered = (): boolean =>
  useSyncExternalStore(connectionStatus.subscribe, connectionStatus.answering, () => false)

/** A 502/503/504 is a gateway's (the CezarBot proxy's, a reverse proxy's), not cezar's. */
export const answeredByCezar = (status: number): boolean => status !== 502 && status !== 503 && status !== 504

function decodeName(value: string | null): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

// The shell's side of the contract: the 502 headers in packages/contract, native-shell.ts.
function createNativeConnectionStatus() {
  const listeners = new Set<() => void>()
  let status: NativeConnectionStatus | undefined
  const set = (next: NativeConnectionStatus | undefined) => {
    if (next === status || (next && status && JSON.stringify(next) === JSON.stringify(status))) return
    status = next
    listeners.forEach((fn) => fn())
  }
  return {
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
    current: () => status,
    /** Every answer the cockpit gets: the shell's 502 sets the reason, anything else clears it. */
    fromResponse(res: { status: number; headers?: Headers }) {
      const reason = res.status === 502 ? res.headers?.get(CEZAR_UNREACHABLE_HEADER) : null
      if (!reason) return set(undefined)
      const parsed = nativeConnectionStatusSchema.safeParse({ reason, computerName: decodeName(res.headers?.get(CEZAR_COMPUTER_HEADER) ?? null) })
      set(parsed.success ? parsed.data : undefined)
    },
    clear: () => set(undefined),
  }
}

export const nativeConnectionStatus = createNativeConnectionStatus()

/** The shell's reason for the drop, while its proxy keeps answering 502. */
export const useNativeConnectionStatus = (): NativeConnectionStatus | undefined =>
  useSyncExternalStore(nativeConnectionStatus.subscribe, nativeConnectionStatus.current, () => undefined)
