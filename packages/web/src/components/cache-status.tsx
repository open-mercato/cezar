import type { QueryKey } from '@tanstack/react-query'
<<<<<<< HEAD
import { CloudOffIcon, RefreshCwIcon } from 'lucide-react'
=======
import { CheckCircle2Icon, CloudOffIcon, LaptopIcon, PauseCircleIcon, RefreshCwIcon } from 'lucide-react'
>>>>>>> fe1ec2d (fix(web): poll and say only 'live updates paused' while requests still get through (#2236))
import { useEffect, useState, useSyncExternalStore } from 'react'

import { dashboardLive } from '@/api/dashboard-live'
import { cachedAt, cachedVersion, subscribeCached } from '@/api/query-persist'
<<<<<<< HEAD
=======
import { connectionStatus, useNativeConnectionStatus, useReconnectAttempt, useRequestsAnswered } from '@/api/connection-status'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { isCezarShell, shellRequest } from '@/lib/phone-app'
>>>>>>> fe1ec2d (fix(web): poll and say only 'live updates paused' while requests still get through (#2236))
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
  const answered = useRequestsAnswered()
  // A hidden tab releases its stream on purpose (#1753); only a visible one is "down".
  const streamDown = streamAvailable() && visible && (!connected || !online)
  // cezar still answers plain requests: only the live updates are gone, and polling covers them.
  const paused = useDelayed(streamDown && online && answered, CONNECTION_BANNER_DELAY_MS)
  const down = streamDown && !(online && answered)
  const shown = useDelayed(down, !online ? 0 : everConnected ? CONNECTION_BANNER_DELAY_MS : FIRST_CONNECT_BANNER_DELAY_MS)
<<<<<<< HEAD
  if (!shown) return null
=======
  const long = useDelayed(shown, LONG_OFFLINE_MS)
  const [phase, setPhase] = useState<BannerPhase>('hidden')
  if (shown && phase !== 'down') setPhase('down')
  // Only a banner the reader saw says "Back online"; a drop it never showed stays silent.
  if (!shown && phase === 'down') setPhase(connected && online ? 'back' : 'hidden')
  useEffect(() => {
    if (phase !== 'back' && phase !== 'fading') return
    const timer = setTimeout(() => setPhase(phase === 'back' ? 'fading' : 'hidden'), phase === 'back' ? BACK_ONLINE_MS : BACK_ONLINE_FADE_MS)
    return () => clearTimeout(timer)
  }, [phase])
  const [retrying, setRetrying] = useState(false)
  useEffect(() => {
    if (!retrying) return
    const timer = setTimeout(() => setRetrying(false), RETRY_BUSY_MS)
    return () => clearTimeout(timer)
  }, [retrying])

  const inset = 'pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]'
  if (phase === 'hidden' && paused) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-slot="connection-banner"
        data-state="paused"
        className={cn('flex min-h-7 items-center gap-1.5 border-b border-border text-meta text-muted-foreground', inset)}
      >
        <PauseCircleIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0">Live updates paused — refreshing periodically.</span>
      </div>
    )
  }
  if (phase === 'hidden') return null
  const back = phase !== 'down'
  if (back) {
    return (
      <div
        role="status"
        aria-live="polite"
        data-slot="connection-banner"
        data-state="online"
        className={cn(
          'flex min-h-9 items-center gap-2 border-b border-border bg-success/10 text-sm text-foreground transition-opacity duration-700 motion-reduce:transition-none',
          inset,
          phase === 'fading' && 'opacity-0',
        )}
      >
        <CheckCircle2Icon aria-hidden="true" className="size-4 shrink-0 text-success" />
        <span className="min-w-0">Back online</span>
      </div>
    )
  }
  const copy = bannerCopy(online, native)
  const retry = () => {
    if (retrying) return
    setRetrying(true)
    shellRequest.open(SHELL_RECONNECT_URL)
    connectionStatus.reconnectNow()
  }
>>>>>>> fe1ec2d (fix(web): poll and say only 'live updates paused' while requests still get through (#2236))
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
