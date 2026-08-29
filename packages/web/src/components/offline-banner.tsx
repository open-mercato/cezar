import { RefreshCwIcon, WifiOffIcon } from 'lucide-react'
import { useSyncExternalStore } from 'react'

import {
  isConnectionOffline,
  retryConnection,
  subscribeConnection,
} from '@/api/connection-state'
import { Button } from '@/components/ui/button'

/**
 * The visible half of a dead server (audit C1): when the event stream errors, this bar names the
 * state instead of letting the cockpit sit there looking live with yesterday's data. It clears
 * itself the moment any event (including the ping) arrives. Retry forces an immediate reconnect
 * plus a reconcile, so failed queries re-ask without waiting out the backoff.
 *
 * `role="alert"`, not polite — losing the server is the one status change worth interrupting for.
 */
export function OfflineBanner() {
  const offline = useSyncExternalStore(subscribeConnection, isConnectionOffline, () => false)
  if (!offline) return null
  return (
    <div
      data-slot="offline-banner"
      role="alert"
      className="flex items-center gap-2.5 border-b border-danger/30 bg-danger/10 px-4 py-2 text-[13px] text-foreground md:px-6"
    >
      <WifiOffIcon aria-hidden="true" className="size-4 shrink-0 text-danger" />
      <span className="min-w-0">
        <span className="font-semibold">Server unreachable.</span>{' '}
        <span className="text-muted-foreground">
          Reconnecting — what you see may be out of date.
        </span>
      </span>
      <Button
        variant="outline"
        size="sm"
        className="ml-auto shrink-0"
        onClick={retryConnection}
      >
        <RefreshCwIcon aria-hidden="true" />
        Retry now
      </Button>
    </div>
  )
}
