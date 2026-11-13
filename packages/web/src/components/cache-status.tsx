import type { QueryKey } from '@tanstack/react-query'
import { CloudOffIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { dashboardLive } from '@/api/dashboard-live'
import { cachedAt, cachedVersion, subscribeCached } from '@/api/query-persist'
import { cn } from '@/lib/utils'

/** Long enough that a local cockpit's refresh lands first and nothing flashes. */
export const CACHE_CHIP_DELAY_MS = 600
/** A dropped stream gets this long to reopen on its own before the banner says so. */
export const CONNECTION_BANNER_DELAY_MS = 5_000
/** The first connect over a slow relay is not a drop: give it longer before saying so. */
export const FIRST_CONNECT_BANNER_DELAY_MS = 15_000

/** When the shown copy of `queryKey` was saved, while it is still the cached one. */
export function useCachedAt(queryKey: QueryKey): number | undefined {
  useSyncExternalStore(subscribeCached, cachedVersion, cachedVersion)
  return cachedAt(queryKey)
}

function useDelayed(on: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const timer = setTimeout(() => setShown(true), delayMs)
    return () => clearTimeout(timer)
  }, [on, delayMs])
  return on && shown
}

export function cachedTimeLabel(savedAt: number, now = Date.now()): string {
  const date = new Date(savedAt)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/**
 * Says the list or chat under it is the saved copy: "Cached · updating…" while the refresh is out,
 * "Cached from 14:02 — couldn't refresh" once it failed. Nothing once fresh data arrived.
 */
export function CacheStatusChip({
  queryKey,
  isFetching,
  isError,
  className,
}: {
  queryKey: QueryKey
  isFetching: boolean
  isError: boolean
  className?: string
}) {
  const savedAt = useCachedAt(queryKey)
  const visible = useDelayed(savedAt !== undefined, CACHE_CHIP_DELAY_MS)
  if (!visible || savedAt === undefined) return null
  const failed = isError && !isFetching
  const time = cachedTimeLabel(savedAt)
  return (
    <span
      role="status"
      data-slot="cache-status"
      data-state={failed ? 'failed' : isFetching ? 'updating' : 'cached'}
      title={`Saved ${new Date(savedAt).toLocaleString()}`}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full px-2 py-0.5 text-meta',
        failed ? 'bg-warning/10 text-warning' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {failed ? (
        <>
          <CloudOffIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">Showing cached data from {time} — couldn't refresh</span>
        </>
      ) : (
        <>
          <RefreshCwIcon aria-hidden="true" className={cn('size-3 shrink-0', isFetching && 'motion-safe:animate-spin')} />
          <span className="truncate">{isFetching ? 'Cached · updating…' : `Cached · ${time}`}</span>
        </>
      )}
    </span>
  )
}

const streamAvailable = (): boolean => typeof globalThis.EventSource === 'function'

function useOnline(): boolean {
  return useSyncExternalStore(
    (fn) => {
      window.addEventListener('online', fn)
      window.addEventListener('offline', fn)
      return () => {
        window.removeEventListener('online', fn)
        window.removeEventListener('offline', fn)
      }
    },
    () => navigator.onLine !== false,
    () => true,
  )
}

function useVisible(): boolean {
  return useSyncExternalStore(
    (fn) => {
      document.addEventListener('visibilitychange', fn)
      return () => document.removeEventListener('visibilitychange', fn)
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  )
}

/** The live stream has been down a while: say so, instead of letting the page look current. */
export function ConnectionBanner() {
  const connected = useSyncExternalStore(dashboardLive.subscribeConnected, dashboardLive.isConnected, () => true)
  const online = useOnline()
  const visible = useVisible()
  const [everConnected, setEverConnected] = useState(connected)
  if (connected && !everConnected) setEverConnected(true)
  // A hidden tab releases its stream on purpose (#1753); only a visible one is "down".
  const down = streamAvailable() && visible && (!connected || !online)
  const shown = useDelayed(down, !online ? 0 : everConnected ? CONNECTION_BANNER_DELAY_MS : FIRST_CONNECT_BANNER_DELAY_MS)
  if (!shown) return null
  return (
    <div
      role="status"
      data-slot="connection-banner"
      data-state={online ? 'reconnecting' : 'offline'}
      className="flex min-h-9 items-center gap-2 border-b border-border bg-warning/10 px-4 text-sm text-foreground"
    >
      <CloudOffIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <span className="min-w-0">
        {online ? "Can't reach cezar — reconnecting…" : "You're offline — reconnecting when the network is back."}
        <span className="text-muted-foreground"> What you see may be out of date.</span>
      </span>
    </div>
  )
}
