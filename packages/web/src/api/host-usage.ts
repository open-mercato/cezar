import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { hostUsageSchema, type HostUsage } from '@open-mercato/cezar-api-client'

import { getWorkspaceHostUsage } from './client'
import { useHealth, workspaceQueryKeys } from './queries'
import { subscribeTopic } from './ws'

/**
 * Live host totals — the Machine card's data layer (spec
 * `.ai/specs/2026-09-20-host-resource-telemetry.md`).
 *
 * One cache (`workspaceQueryKeys.hostUsage`), two transports:
 *
 * - **Local** cockpits subscribe to the `host` topic from the card's own view effect and fold
 *   each pushed frame into the cache. Nothing fetches, and leaving the screen is the 1→0 that
 *   stops the server's sampler.
 * - **Remote** cockpits never open a socket (browser WebSocket carries no proxy credentials).
 *   They read `GET /api/v1/workspace/host-usage` on mount and on the existing
 *   visibility/reconnect reconcile.
 *
 * `cpuPct` is a delta the server can only produce from a recent CPU-times baseline: the first
 * read after an idle gap legitimately answers without it (the card renders `sampling…`). So a
 * remote read follows that answer with **exactly one** warm-up read ~2.5 s later — a second
 * `await` inside the same query execution, never an interval and never more than one pending.
 * That is also why the pair lives in the query function: every refetch (mount, reconcile) gets
 * its own bounded pair, and an unmount aborts both halves through the query's own signal.
 */

/** How long the warm-up read waits — a little over the server's 2 s sampling interval. */
export const HOST_USAGE_WARMUP_MS = 2_500

const delay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })

/**
 * The remote read pair. The second read exists only to turn "no CPU baseline yet" into a real
 * ~2 s delta; when the first answer already carries `cpuPct` it is the whole read.
 *
 * `@internal` — exported for the abort test; the app's read path is `useHostUsage()`.
 */
export async function readWorkspaceHostUsage(
  signal?: AbortSignal,
): Promise<HostUsage> {
  const first = await getWorkspaceHostUsage({ signal })
  if (first.cpuPct !== undefined) return first
  await delay(HOST_USAGE_WARMUP_MS, signal)
  return getWorkspaceHostUsage({ signal })
}

/**
 * Which transport this cockpit has: `undefined` until health (the authenticated bootstrap) has
 * answered. The card uses it for its `live` / `last known` label; the data hooks use it to pick
 * push or fetch. Gating on health is deliberate — a local cockpit must not open a socket before
 * the deployment mode is known (the same rule `useHealthSubscription` follows).
 */
export function useHostTransport(): 'local' | 'remote' | undefined {
  const health = useHealth().data
  if (health === undefined) return undefined
  return health.capabilities?.localHandoff === true ? 'local' : 'remote'
}

/**
 * The Machine card's cache read. A pure read in local mode — the subscription below fills it —
 * and the bounded read pair in remote mode. `staleTime` stays at 0 so a remount or a reconcile
 * always refreshes — the workspace default is five minutes, and a remount inside that window would
 * otherwise render a five-minute-old sample as a fresh one. The rate is bounded by the card being
 * on screen, not by a timer.
 */
export function useHostUsage() {
  const transport = useHostTransport()
  return useQuery({
    queryKey: workspaceQueryKeys.hostUsage,
    queryFn: ({ signal }) => readWorkspaceHostUsage(signal),
    enabled: transport === 'remote',
    // Overrides the workspace default (5 min): every mount reads the route, because this card
    // stamps the age of what it renders and a cached answer would stamp it wrong.
    staleTime: 0,
    retry: false,
  })
}

/**
 * Local-only: subscribe for the lifetime of the CALLER's view and fold frames into the cache.
 * The card is the only caller, which is what keeps the subscription scope honest — the server's
 * sampler runs exactly while the screen is open (0→1 / 1→0).
 */
export function useHostUsageSubscription(): void {
  const queryClient = useQueryClient()
  const transport = useHostTransport()

  useEffect(() => {
    if (transport !== 'local') return
    return subscribeTopic('host', (data) => {
      // Frames are validated at the one boundary where untrusted bytes enter the cache; a frame
      // the schema rejects is dropped rather than rendered as a half-filled card.
      const sample = hostUsageSchema.safeParse(data)
      if (sample.success) queryClient.setQueryData(workspaceQueryKeys.hostUsage, sample.data)
    })
  }, [queryClient, transport])
}
