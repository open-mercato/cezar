import type { ApiRun, ProcessUsage, RunRecord, TodoItem } from '@open-mercato/cezar-api-client'

/**
 * The global stream's data layer: parse one SSE message, and fold it into cached state.
 *
 * Everything here is pure (plus one tiny store) and React-free on purpose — this is the part that
 * has to be right, and a reducer you can call with an array and an event is a reducer you can
 * table-test. `global-events.tsx` owns the connection and does nothing but call into this.
 *
 * The doctrine (spec, "Architecture"): the stream is for immediacy, `GET /api/runs` and
 * `GET /api/runs/:id` are authoritative. So these reducers only ever *patch* what a query already
 * fetched. They never invent a cache out of a stream message — a list built from whatever events
 * happened to arrive after connect is not the run list, it is a subset that looks like one.
 */

// ---- wire → typed event ------------------------------------------------------------------

/** One message from `GET /api/events` (src/server/server.ts). */
export type GlobalEvent =
  | { type: 'run'; run: RunRecord }
  | { type: 'run-deleted'; id: string }
  | { type: 'todos'; items: TodoItem[] }
  | { type: 'usage'; usage: Record<string, ProcessUsage> }
  | { type: 'ping' }

/**
 * Parse an SSE `event:`/`data:` pair, or null when it is not something we act on.
 *
 * Null rather than a throw: this runs on data from a socket, and one malformed frame must cost
 * one frame — not the stream, and not the app. An unknown event name is the same case (the
 * server may grow events before this client knows them).
 */
export function parseGlobalEvent(name: string, data: string): GlobalEvent | null {
  // The keep-alive carries no payload at all, so it is answered before any parsing.
  if (name === 'ping') return { type: 'ping' }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }

  switch (name) {
    case 'run':
      return isRunRecord(payload) ? { type: 'run', run: payload } : null
    case 'run-deleted': {
      const id = (payload as { id?: unknown } | null)?.id
      return typeof id === 'string' && id ? { type: 'run-deleted', id } : null
    }
    case 'todos':
      return Array.isArray(payload) ? { type: 'todos', items: payload as TodoItem[] } : null
    case 'usage':
      return isRecord(payload) ? { type: 'usage', usage: payload as Record<string, ProcessUsage> } : null
    default:
      return null
  }
}

/**
 * One message from `GET /api/workspace/events` (multi-project spec, step 2.8): the same events
 * as the legacy stream, each stamped with the owning project — additively where the legacy
 * payload is an object (`run` grows a `project` key, `run-deleted` is `{id, project}`), wrapped
 * where it is not (`todos` → `{project, items}`, `usage` → `{project, usage}`). This parser
 * unwraps the envelope back to today's `GlobalEvent` so the reducers below never learn the wire
 * changed; the caller dispatches or drops on `project` (null only for the unstamped `ping`).
 *
 * A stamped event with no usable `project` is dropped whole: without the stamp there is no way
 * to know whose caches it belongs in, and guessing is exactly the cross-project bleed the
 * envelope exists to prevent. Workspace-only event names (`project-added`, `checkout-progress`)
 * are not parsed here — no listener subscribes to them yet.
 */
export function parseWorkspaceEvent(
  name: string,
  data: string,
): { project: string | null; event: GlobalEvent } | null {
  if (name === 'ping') return { project: null, event: { type: 'ping' } }

  let payload: unknown
  try {
    payload = JSON.parse(data)
  } catch {
    return null
  }
  if (!isRecord(payload)) return null
  const project = payload.project
  if (typeof project !== 'string' || project === '') return null

  switch (name) {
    case 'run': {
      // Strip the stamp: the reducers (and the cache) must see today's bare RunRecord.
      const { project: _stamp, ...run } = payload
      return isRunRecord(run) ? { project, event: { type: 'run', run } } : null
    }
    case 'run-deleted': {
      const id = payload.id
      return typeof id === 'string' && id ? { project, event: { type: 'run-deleted', id } } : null
    }
    case 'todos':
      return Array.isArray(payload.items)
        ? { project, event: { type: 'todos', items: payload.items as TodoItem[] } }
        : null
    case 'usage':
      return isRecord(payload.usage)
        ? { project, event: { type: 'usage', usage: payload.usage as Record<string, ProcessUsage> } }
        : null
    default:
      return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The one field every reducer keys on. Deep-validating the record would only re-implement the
 *  server's own schema in a place that cannot enforce it. */
function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value) && typeof value.id === 'string' && value.id !== ''
}

// ---- reducers ----------------------------------------------------------------------------

/**
 * Fold a `run` event into the cached run list.
 *
 * `undefined` in → `undefined` out: the list query has not fetched, so there is nothing to patch
 * and `[run]` would be a lie. TanStack's `setQueryData` reads an `undefined` return as "leave it
 * alone", which is exactly the intent.
 *
 * An existing row is replaced in place — the same run arriving 50 times during its life must stay
 * one row, at its position, rather than churning the list order under the reader's cursor. A new
 * one is inserted by `createdAt` descending, matching `store.listRuns()`'s order, so a run that
 * appears mid-session lands where a refetch would have put it.
 */
export function applyRunEvent(list: ApiRun[] | undefined, run: RunRecord): ApiRun[] | undefined {
  if (!list) return undefined

  const index = list.findIndex((r) => r.id === run.id)
  if (index >= 0) {
    const next = [...list]
    next[index] = mergeRun(list[index], run)
    return next
  }

  // `?? ''` because only `id` is validated on the way in: a record missing `createdAt` must sort
  // last, not throw and take the stream's message loop with it.
  const createdAt = run.createdAt ?? ''
  const at = list.findIndex((r) => (r.createdAt ?? '').localeCompare(createdAt) < 0)
  const next = [...list]
  next.splice(at < 0 ? list.length : at, 0, run)
  return next
}

/** Drop a deleted run. Same reference back when the id isn't there — an event about a run this
 *  cache never held must not re-render every list on screen. */
export function applyRunDeleted(list: ApiRun[] | undefined, id: string): ApiRun[] | undefined {
  if (!list) return undefined
  const next = list.filter((r) => r.id !== id)
  return next.length === list.length ? list : next
}

/**
 * The stream's record over the cached one.
 *
 * `usage` is carried over rather than dropped: the global `run` event is a bare `RunRecord`, while
 * `GET /api/runs` answers with the live sample attached (`withUsage`). An absent field on the wire
 * means "this message doesn't carry it", not "there is none" — overwriting would blink the sample
 * out on every status change. Freshness for it comes from the `usage` ticks either way.
 */
export function mergeRun(previous: ApiRun | undefined, run: RunRecord): ApiRun {
  return previous?.usage ? { ...run, usage: previous.usage } : run
}

// ---- live usage --------------------------------------------------------------------------

/**
 * The live `{runId → {cpuPct, rssBytes, procCount}}` map, kept outside the query cache.
 *
 * It ticks about every 2 s while any run is alive, and it is *never persisted* — no NDJSON line,
 * no run record. Putting it in the query cache would mean either invalidating runs every 2 s (a
 * refetch storm aimed at a server on the same laptop) or writing it into the durable run objects
 * (a new identity for every row, so every list re-renders for a CPU percentage most views don't
 * show). An external store keeps the blast radius at exactly the components that subscribe.
 *
 * The snapshot is the whole map by reference, so `useSyncExternalStore` stays stable between ticks
 * and a per-run selector only re-renders when that run's own sample was replaced.
 */
export interface UsageStore {
  subscribe(listener: () => void): () => void
  get(): Record<string, ProcessUsage>
  /** Each tick is a complete snapshot of the runs that currently have samples, so it replaces
   *  rather than merges — a run that ended must stop reporting, not keep its last number. */
  set(usage: Record<string, ProcessUsage>): void
}

export const EMPTY_USAGE: Record<string, ProcessUsage> = Object.freeze({})

export function createUsageStore(): UsageStore {
  let snapshot: Record<string, ProcessUsage> = EMPTY_USAGE
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: () => snapshot,
    set(usage) {
      snapshot = usage
      for (const listener of listeners) listener()
    },
  }
}
