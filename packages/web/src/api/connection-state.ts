/**
 * The stream's liveness as a tiny external store (audit C1). `GlobalEventsProvider` is the only
 * writer: SSE 'open' and every received event mark the cockpit online, 'error' marks it offline.
 * `OfflineBanner` is the reader. A store (not context) so the provider — which deliberately
 * renders no tree of its own — can write without re-rendering the app, and only the banner
 * re-renders on a flip.
 */

type Listener = () => void

let offline = false
let retryHandler: (() => void) | null = null
const listeners = new Set<Listener>()

export function setConnectionOffline(next: boolean): void {
  if (offline === next) return
  offline = next
  for (const listener of [...listeners]) listener()
}

/** The provider registers how to force a reconnect (close + reopen + reconcile). */
export function setConnectionRetry(handler: (() => void) | null): void {
  retryHandler = handler
}

export function retryConnection(): void {
  retryHandler?.()
}

export function isConnectionOffline(): boolean {
  return offline
}

export function subscribeConnection(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
