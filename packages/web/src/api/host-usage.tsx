import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { hostUsageSchema, type HostUsage } from '@open-mercato/cezar-api-client'

import { getWorkspaceHostUsage } from './client'
import { useHealth, workspaceQueryKeys } from './queries'
import { effectiveHostView } from '@/lib/host-effective'
import { useIsDesktop } from '@/lib/use-desktop'
import { subscribeTopic } from './ws'

/**
 * The Machine card's and the sidebar widget's data layer (spec
 * `.ai/specs/2026-09-20-host-telemetry-sidebar-widget.md`, Phase 2).
 *
 * One per-app store, two readers and three writers, and exactly one writer is live per viewport:
 *
 * - **root** (`useHostSubscription`, local && `md` and up) subscribes for the whole session and
 *   feeds the store, so the widget and the card read one sample and one history.
 * - **card** (`useHostUsageSubscription`, gated `enabled: !useIsDesktop()` by the card) stays the
 *   `<md` writer - it is the only local transport below `md`, where the root writer is off and the
 *   widget is unmounted.
 * - **route** (`useHostUsageRoute`, remote only) reads `GET /api/v1/workspace/host-usage` with its
 *   one bounded warm-up pair and folds every answer into the same store; a remote cockpit opens no
 *   socket at all, because browser WebSocket carries no reverse-proxy credentials.
 *
 * The store is a context value rather than a module singleton, following `UsageContext`: a
 * module-level instance would leak one test's frames into the next, and there is exactly one per
 * `HostUsageProvider` (StrictMode's double render still yields one).
 *
 * A pushed frame is validated at this one boundary - the point where untrusted bytes enter the
 * store - so a frame the schema rejects is dropped rather than rendered half-filled. The route
 * answer needs no second parse: it arrives already unwrapped by the typed client, which is the
 * same contract schema.
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
 * `@internal` — exported for the abort test; the app's read path is `useHostUsageRoute()`.
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
 * answered. The card uses it for its `live` / `last known` label; the writers use it to pick push
 * or fetch. Gating on health is deliberate — a local cockpit must not open a socket before the
 * deployment mode is known (the same rule `useHealthSubscription` follows).
 */
export function useHostTransport(): 'local' | 'remote' | undefined {
  const health = useHealth().data
  if (health === undefined) return undefined
  return health.capabilities?.localHandoff === true ? 'local' : 'remote'
}

// ---- the store ---------------------------------------------------------------------------

/** 30 points × the server's 2 s cadence = the 60 s sparkline. */
export const HOST_HISTORY_LENGTH = 30
/**
 * A gap longer than this is not a line: a reconnection that skipped more than four frames
 * restarts the sparkline instead of drawing a segment nothing measured.
 */
export const HOST_HISTORY_GAP_MS = 8_000

export type HostUsageWriter = 'root' | 'card' | 'route'

export interface HostUsagePoint {
  sampledAt: string
  /** The CLIENT receipt stamp, kept with the point: the staleness clock reads receipt, not the
   *  server's own `sampledAt` (a clock-skewed server must not be able to freeze the readout). */
  receivedAt: number
  cpuPct: number
}

export interface HostUsageState {
  latest?: HostUsage
  /** Client receipt stamp of the latest sample — the widget's `stale` clock. */
  lastFrameAt?: number
  history: HostUsagePoint[]
}

export interface HostUsageStore {
  subscribe(listener: () => void): () => void
  /** The whole state BY REFERENCE: `useSyncExternalStore` needs identity stability between
   *  pushes, and a selector then only re-renders the component whose slice changed. */
  get(): HostUsageState
  push(sample: HostUsage, receivedAt: number, writer: HostUsageWriter): void
  /** For tests: forget every sample and the writer, as a fresh mount would. */
  reset(): void
}

/** One shared empty state, so an idle cockpit hands every reader the same reference. */
const EMPTY_HOST_HISTORY: HostUsagePoint[] = Object.freeze([]) as unknown as HostUsagePoint[]
export const EMPTY_HOST_USAGE_STATE: HostUsageState = Object.freeze({
  history: EMPTY_HOST_HISTORY,
})

export function createHostUsageStore(): HostUsageStore {
  let state: HostUsageState = EMPTY_HOST_USAGE_STATE
  let writer: HostUsageWriter | undefined
  const listeners = new Set<() => void>()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => state,
    push(sample, receivedAt, nextWriter) {
      const previous = state
      // The writer change is decided BEFORE the dedupe below: a new writer whose first frame
      // replays the sample the old writer already delivered is still a change of owner, and the
      // spec's rule is that a writer change clears the line.
      const writerChanged = writer !== undefined && writer !== nextWriter
      writer = nextWriter
      // A replayed snapshot (re-subscribe, reconnect, a second writer's identical view) must not
      // add a second point for one server sample.
      const replay = previous.latest?.sampledAt === sample.sampledAt
      if (
        replay &&
        previous.latest === sample &&
        previous.lastFrameAt === receivedAt &&
        !writerChanged
      ) {
        return
      }

      const lastPoint = previous.history[previous.history.length - 1]
      const gap =
        !replay &&
        lastPoint !== undefined &&
        Date.parse(sample.sampledAt) - Date.parse(lastPoint.sampledAt) > HOST_HISTORY_GAP_MS
      const base = writerChanged || gap ? [] : previous.history
      // The ring carries the EFFECTIVE percentage, the same number the card and the widget render:
      // a line of host-wide utilization under an effective core count is the scope mix the spec
      // forbids, and the two surfaces must never disagree about which series they are drawing.
      const effectiveCpuPct = effectiveHostView(sample).cpuPct
      // One server instant is one point in the KEPT history: after a writer change or a gap the
      // arriving sample legitimately starts the new line, a plain replay never doubles it.
      const lastKept = base[base.length - 1]
      const appendPoint =
        effectiveCpuPct !== undefined && lastKept?.sampledAt !== sample.sampledAt
      const history = appendPoint
        ? [...base, { sampledAt: sample.sampledAt, receivedAt, cpuPct: effectiveCpuPct }].slice(
            -HOST_HISTORY_LENGTH,
          )
        : base
      state = { latest: sample, lastFrameAt: receivedAt, history }
      for (const listener of listeners) listener()
    },
    reset() {
      writer = undefined
      state = EMPTY_HOST_USAGE_STATE
      for (const listener of listeners) listener()
    },
  }
}

const HostUsageContext = createContext<HostUsageStore | null>(null)

/**
 * Owns the one store instance and hosts the root writer. Mounted once, above both readers — the
 * sidebar widget (through the shell) and the Settings card.
 */
export function HostUsageProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createHostUsageStore)
  return (
    <HostUsageContext.Provider value={store}>
      {children}
      <HostUsageRootWriter />
    </HostUsageContext.Provider>
  )
}

/** Renders nothing; the session-long subscription lives here so it survives route changes. */
function HostUsageRootWriter() {
  useHostSubscription()
  return null
}

export function useHostUsageStore(): HostUsageStore | null {
  return useContext(HostUsageContext)
}

const noopSubscribe = (): (() => void) => () => undefined

/**
 * The latest sample. Empty outside a provider rather than a throw: "no samples yet" is a real,
 * expected state, and a component rendered without the provider (a unit test of the card alone)
 * sees the same nothing it would see before the first frame.
 */
export function useHostUsage(): HostUsage | undefined {
  const store = useContext(HostUsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.get().latest,
    () => undefined,
  )
}

/** The 60 s CPU ring. Same reference between pushes, so a sparkline only re-renders on a push. */
export function useHostHistory(): HostUsagePoint[] {
  const store = useContext(HostUsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.get().history ?? EMPTY_HOST_USAGE_STATE.history,
    () => EMPTY_HOST_USAGE_STATE.history,
  )
}

/** When the client last received a sample — the `stale` clock's origin. */
export function useHostLastFrameAt(): number | undefined {
  const store = useContext(HostUsageContext)
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => store?.get().lastFrameAt,
    () => undefined,
  )
}

// ---- the writers -------------------------------------------------------------------------

/**
 * One local `host` subscription that folds every pushed frame into the store. The caller decides
 * the gate; the transport gate (local only) is shared, so a remote cockpit can never open a
 * socket through either writer.
 */
function useHostFrames(writer: HostUsageWriter, enabled: boolean): void {
  const store = useContext(HostUsageContext)
  const transport = useHostTransport()

  useEffect(() => {
    if (!store || !enabled || transport !== 'local') return
    return subscribeTopic('host', (data) => {
      const parsed = hostUsageSchema.safeParse(data)
      if (parsed.success) store.push(parsed.data, Date.now(), writer)
    })
  }, [store, enabled, transport, writer])
}

/**
 * The root writer: local cockpits at `md` and up, for the whole session, because the sidebar
 * widget is visible the whole session. Below `md` the widget is unmounted and the card's own
 * view-scoped subscription (below) is the demand, which is what keeps a phone from paying for a
 * sampler it cannot see.
 */
export function useHostSubscription(): void {
  useHostFrames('root', useIsDesktop())
}

/**
 * The card's view-scoped writer, kept from v1 as the `<md` transport: below `md` the card is the
 * only local reader, so its mount/unmount is the sampler's 0→1/1→0. On desktop the root writer is
 * the only one - the card passes `enabled: !useIsDesktop()`.
 */
export function useHostUsageSubscription(options: { enabled?: boolean } = {}): void {
  useHostFrames('card', options.enabled ?? true)
}

/**
 * The remote reader: the v1 query pair, renamed for what it is, folding every answer into the
 * store so the card and the widget read one shape in both transports.
 *
 * `staleTime` stays 0 so a remount or a visibility/reconnect reconcile always refreshes; the rate
 * is bounded by the card being on screen, not by a timer.
 */
export function useHostUsageRoute() {
  const store = useContext(HostUsageContext)
  const transport = useHostTransport()
  const query = useQuery({
    queryKey: workspaceQueryKeys.hostUsage,
    queryFn: ({ signal }) => readWorkspaceHostUsage(signal),
    enabled: transport === 'remote',
    retry: false,
  })

  const data = query.data
  useEffect(() => {
    if (!store || data === undefined) return
    store.push(data, Date.now(), 'route')
  }, [store, data])

  return query
}
