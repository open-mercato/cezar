import type { QueryKey } from '@tanstack/react-query'
import { CheckCircle2Icon, CloudOffIcon, LaptopIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { dashboardLive } from '@/api/dashboard-live'
import { cachedAt, cachedVersion, subscribeCached } from '@/api/query-persist'
import { connectionStatus, useReconnectAttempt } from '@/api/connection-status'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { isCezarShell } from '@/lib/phone-app'
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

/** How long the banner says "Back online" before it fades, and how long the fade takes. */
export const BACK_ONLINE_MS = 1_800
export const BACK_ONLINE_FADE_MS = 700
/** Down this long, CezarBot offers its computer list: the Mac itself may be the one that is gone. */
export const LONG_OFFLINE_MS = 30_000
/** Retry now stays busy this long, so a frantic tap is one reconnect, not ten. */
const RETRY_BUSY_MS = 2_000
// The CezarBot shell opens its native computer list on this navigation (mobile switcher spec).
const SWITCH_COMPUTER_URL = 'cezar://servers'

type BannerPhase = 'hidden' | 'down' | 'back' | 'fading'

/** The live stream has been down a while: say so, what is being done, and what the reader can do. */
export function ConnectionBanner() {
  const connected = useSyncExternalStore(dashboardLive.subscribeConnected, dashboardLive.isConnected, () => true)
  const attempt = useReconnectAttempt()
  const online = useOnline()
  const visible = useVisible()
  const [everConnected, setEverConnected] = useState(connected)
  if (connected && !everConnected) setEverConnected(true)
  // A hidden tab releases its stream on purpose (#1753); only a visible one is "down".
  const down = streamAvailable() && visible && (!connected || !online)
  const shown = useDelayed(down, !online ? 0 : everConnected ? CONNECTION_BANNER_DELAY_MS : FIRST_CONNECT_BANNER_DELAY_MS)
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

  if (phase === 'hidden') return null
  const back = phase !== 'down'
  const inset = 'pr-[max(1rem,env(safe-area-inset-right))] pl-[max(1rem,env(safe-area-inset-left))]'
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
  const retry = () => {
    if (retrying) return
    setRetrying(true)
    connectionStatus.reconnectNow()
  }
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="connection-banner"
      data-state={online ? 'reconnecting' : 'offline'}
      className={cn('flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-warning/40 bg-warning/15 py-1.5 text-sm text-foreground', inset)}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <span aria-hidden="true" className="absolute inline-flex size-full rounded-full bg-warning/40 motion-safe:animate-ping" />
        <RefreshCwIcon aria-hidden="true" className="relative size-4 text-warning motion-safe:animate-spin motion-safe:[animation-duration:2s]" />
      </span>
      <span className="min-w-0 flex-1">
        <span data-slot="connection-banner-title" className="font-medium">
          {online ? "Can't reach cezar — reconnecting…" : "You're offline — reconnecting when the network is back."}
          {attempt > 0 ? <span data-slot="connection-banner-attempt" className="tabular-nums"> (attempt {attempt})</span> : null}
        </span>
        <span className="text-muted-foreground"> What you see may be out of date.</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {long && isCezarShell() ? (
          <Button asChild variant="ghost" size="sm" className="pointer-coarse:h-11">
            <a href={SWITCH_COMPUTER_URL} data-slot="connection-banner-switch">
              <LaptopIcon aria-hidden="true" />
              Switch computer
            </a>
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          className="pointer-coarse:h-11"
          data-slot="connection-banner-retry"
          // aria-disabled, not disabled: a disabled button drops keyboard focus.
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          onClick={retry}
        >
          {retrying ? <Spinner /> : null}
          Retry now
        </Button>
      </span>
    </div>
  )
}
