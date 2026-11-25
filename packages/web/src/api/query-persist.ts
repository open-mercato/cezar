import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query'
import { getApiBaseUrl } from '@open-mercato/cezar-api-client'
import type { ApiRun, HealthResponse, ManagerMessage, ManagerMessagesResponse } from '@open-mercato/cezar-api-client'

/**
 * The first screen's last-known data, kept in localStorage so a cockpit behind a slow link (the
 * phone app's relay) paints it at once and refreshes it after. Only the allowlist below is ever
 * written; a hydrated entry stays marked cached until a real fetch replaces it.
 */

export const CACHE_SCHEMA_VERSION = 1
/** In UTF-16 code units, i.e. what `JSON.stringify(...).length` measures. */
export const CACHE_MAX_CHARS = 1_000_000
export const CACHE_KEY_PREFIX = 'cezar.first-screen-cache:'
export const CHAT_MESSAGES_KEPT = 50
export const RUNS_KEPT = 100
const WRITE_DEBOUNCE_MS = 2_000
const WRITE_MAX_WAIT_MS = 10_000

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

interface Entry {
  /** The query key. */
  k: QueryKey
  /** The trimmed data. */
  d: unknown
  /** `dataUpdatedAt` when it was written. */
  t: number
}

interface Blob {
  v: number
  build: string
  savedAt: number
  instanceId?: string
  entries: Entry[]
}

/** Lower drops first when the cap is hit; the shell's gating reads are the last to go. */
function rank(key: QueryKey): number | null {
  const [a, b, c] = key
  if (a === 'workspace') {
    if (b === 'managers' && c === 'list' && key.length === 3) return 5
    if (b === 'managers' && c === 'messages' && key.length === 4) return 3
    if (b === 'projects' && key.length === 2) return 5
    if (b === 'providers' && c === 'status' && key.length === 3) return 5
    // Not `ui-state`: its writers merge into the cached copy, and a stale one would be written back.
    if (b === 'runs-index' && key.length === 2) return 1
    return null
  }
  if (typeof a !== 'string') return null
  if (b === 'health' && key.length === 2) return 5
  if (b === 'runs' && c === 'list' && key.length === 3) return a === 'default' ? 4 : 2
  return null
}

export const isPersistedKey = (key: QueryKey): boolean => rank(key) !== null

/** Bounded, and never a pending approval: a cached card must not be executable (#first-screen). */
function trim(key: QueryKey, data: unknown): unknown {
  if (key[1] === 'managers' && key[2] === 'messages') {
    const pages = (data as { pages?: ManagerMessagesResponse[] }).pages
    const newest = pages?.[0]
    if (!newest) return undefined
    const messages = newest.messages
      .filter((message: ManagerMessage) => !(message.kind === 'action' && message.status === 'pending'))
      .slice(-CHAT_MESSAGES_KEPT)
    const dropped = messages.length < newest.messages.length
    return { pages: [{ messages, hasMore: newest.hasMore || dropped }], pageParams: [undefined] }
  }
  if (key[1] === 'runs' && key[2] === 'list' && Array.isArray(data)) return (data as ApiRun[]).slice(0, RUNS_KEPT)
  if (key[1] === 'runs-index' && data && typeof data === 'object') {
    const index = data as { runs?: unknown[] }
    return Array.isArray(index.runs) ? { ...index, runs: index.runs.slice(0, RUNS_KEPT * 2) } : data
  }
  return data
}

/** Scoped per server: the origin (the phone app gives each server its own) plus any API base. */
export function cacheStorageKey(origin = globalThis.location?.origin ?? '', apiBase = getApiBaseUrl()): string {
  return `${CACHE_KEY_PREFIX}${origin}${apiBase}`
}

/** The bundle's own URL carries Vite's content hash: a new build never reads an old shape. */
const BUILD_ID = import.meta.url.replace(/^[a-z]+:\/\/[^/]+/i, '')

/** Which server answered: its install id, else its boot project (a plain cockpit has no id). */
function serverIdentity(health: HealthResponse | undefined): string | undefined {
  if (!health) return undefined
  return health.instanceId ?? (health.bootProject ? `boot:${health.bootProject}` : undefined)
}

function safeLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readBlob(storage: Storage, key: string, build: string): Blob | null {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw === null) return null
  try {
    const blob = JSON.parse(raw) as Partial<Blob> | null
    const valid = blob !== null && typeof blob === 'object'
      && blob.v === CACHE_SCHEMA_VERSION && blob.build === build
      && typeof blob.savedAt === 'number' && Array.isArray(blob.entries)
      && blob.entries.every((entry) => Array.isArray(entry?.k) && typeof entry.t === 'number' && isPersistedKey(entry.k))
    if (valid) return blob as Blob
  } catch {
    // Corrupt: dropped below.
  }
  safeRemove(storage, key)
  return null
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // Nothing more to do.
  }
}

/** The blob to write, or null when even the essentials do not fit. Drops by rank, oldest first. */
export function buildBlob(queryClient: QueryClient, build: string, maxChars = CACHE_MAX_CHARS, now = Date.now()): Blob | null {
  const ranked: Array<{ entry: Entry; rank: number; size: number }> = []
  let instanceId: string | undefined
  for (const query of queryClient.getQueryCache().getAll()) {
    const r = rank(query.queryKey)
    if (r === null || query.state.status !== 'success' || query.state.data === undefined) continue
    if (query.queryKey[1] === 'health') instanceId ??= serverIdentity(query.state.data as HealthResponse)
    const data = trim(query.queryKey, query.state.data)
    if (data === undefined) continue
    const entry: Entry = { k: query.queryKey, d: data, t: query.state.dataUpdatedAt }
    let size: number
    try {
      size = JSON.stringify(entry).length
    } catch {
      continue
    }
    ranked.push({ entry, rank: r, size })
  }
  ranked.sort((a, b) => b.rank - a.rank || b.entry.t - a.entry.t)
  const envelope = 200
  let total = envelope
  const kept: Entry[] = []
  for (const item of ranked) {
    if (total + item.size + 1 > maxChars) continue
    total += item.size + 1
    kept.push(item.entry)
  }
  if (kept.length === 0) return null
  return { v: CACHE_SCHEMA_VERSION, build, savedAt: now, ...(instanceId ? { instanceId } : {}), entries: kept }
}

// ---- which entries are still the cached copy --------------------------------------------------

const cachedHashes = new Map<string, number>()
const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeCached(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export const cachedVersion = (): number => version

/** When the shown data was saved, while it is still the cached copy; undefined once fresh. */
export function cachedAt(key: QueryKey): number | undefined {
  return cachedHashes.get(hashKey(key))
}

function markFresh(hash: string): void {
  if (cachedHashes.delete(hash)) notify()
}

// ---- wiring -------------------------------------------------------------------------------

let suppressed = false
let activeFlush: (() => void) | null = null

/** Wipe every server's cached copy in this origin, and stop writing until the next load. */
export function clearPersistedCache(storage: Storage | null = safeLocalStorage()): void {
  suppressed = true
  if (storage) {
    const keys: string[] = []
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key?.startsWith(CACHE_KEY_PREFIX)) keys.push(key)
      }
    } catch {
      // Unreadable storage holds nothing of ours.
    }
    for (const key of keys) safeRemove(storage, key)
  }
  if (cachedHashes.size > 0) {
    cachedHashes.clear()
    notify()
  }
}

declare global {
  interface Window {
    /** Called by the phone app on Forget/Remove; also usable from devtools. */
    __cezarClearCache?: () => void
  }
}

export interface PersistOptions {
  storage?: Storage | null
  key?: string
  build?: string
  maxChars?: number
}

export interface PersistSession {
  queryClient: QueryClient
  storage: Storage | null
  key: string
  build: string
  maxChars: number
  /** The server the restored copy came from (`serverIdentity`), when it said. */
  instanceId: string | undefined
}

/**
 * Restore the last-known first screen into `queryClient`, synchronously so the first render
 * paints it. Never throws: no storage or a corrupt/old entry is just no cache.
 */
export function restoreFirstScreen(queryClient: QueryClient, options: PersistOptions = {}): PersistSession {
  const storage = options.storage === undefined ? safeLocalStorage() : options.storage
  if (typeof window !== 'undefined') window.__cezarClearCache = () => clearPersistedCache(storage)
  suppressed = false
  const session: PersistSession = {
    queryClient,
    storage,
    key: options.key ?? cacheStorageKey(),
    build: options.build ?? BUILD_ID,
    maxChars: options.maxChars ?? CACHE_MAX_CHARS,
    instanceId: undefined,
  }
  const blob = storage ? readBlob(storage, session.key, session.build) : null
  if (!blob) return session
  session.instanceId = blob.instanceId
  for (const entry of blob.entries) {
    if (queryClient.getQueryData(entry.k) !== undefined) continue
    queryClient.setQueryData(entry.k, entry.d, { updatedAt: entry.t })
    cachedHashes.set(hashKey(entry.k), blob.savedAt)
  }
  // Stale whatever its age, so the first observer refetches it (the chat's staleTime is Infinity).
  void queryClient.invalidateQueries({ predicate: (query) => cachedHashes.has(query.queryHash), refetchType: 'none' })
  notify()
  return session
}

/** Keep the allowlisted entries written as they change. Returns the disposer. */
export function keepFirstScreenPersisted(session: PersistSession): () => void {
  const { queryClient, storage, key, build, maxChars } = session
  if (!storage) return () => undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  let firstPending: number | undefined
  const write = (): void => {
    clearTimeout(timer)
    timer = undefined
    firstPending = undefined
    if (suppressed) return
    const next = buildBlob(queryClient, build, maxChars)
    if (!next) {
      safeRemove(storage, key)
      return
    }
    try {
      storage.setItem(key, JSON.stringify(next))
    } catch {
      // Quota or a locked store: no cache beats a stale one.
      safeRemove(storage, key)
    }
  }
  const schedule = (): void => {
    if (suppressed) return
    const now = Date.now()
    firstPending ??= now
    clearTimeout(timer)
    timer = setTimeout(write, Math.max(0, Math.min(WRITE_DEBOUNCE_MS, firstPending + WRITE_MAX_WAIT_MS - now)))
  }

  // Another server answering at this origin: its copy is not ours to show.
  const checkServerIdentity = (health: HealthResponse | undefined, healthHash: string): void => {
    const fresh = serverIdentity(health)
    if (!session.instanceId || !fresh || session.instanceId === fresh) return
    session.instanceId = fresh
    const stale = new Set(cachedHashes.keys())
    // The answer that told us is already the new server's: keep it.
    stale.delete(healthHash)
    cachedHashes.clear()
    notify()
    void queryClient.resetQueries({ predicate: (query) => stale.has(query.queryHash) })
  }

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (!isPersistedKey(event.query.queryKey)) return
    if (event.type === 'removed') {
      markFresh(event.query.queryHash)
      schedule()
      return
    }
    if (event.type !== 'updated' || event.action.type !== 'success') return
    // A fetch, not a stream patch, is what makes a restored copy current.
    if (!event.action.manual) {
      if (event.query.queryKey[1] === 'health') checkServerIdentity(event.query.state.data as HealthResponse | undefined, event.query.queryHash)
      markFresh(event.query.queryHash)
    } else if (cachedHashes.has(event.query.queryHash)) {
      // setQueryData clears the stale flag: a patched copy is still old, and the chat (staleTime
      // Infinity) would never fetch the gap before it.
      event.query.invalidate()
    }
    schedule()
  })

  const flushIfPending = (): void => {
    if (timer !== undefined) write()
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flushIfPending()
  }
  window.addEventListener('pagehide', flushIfPending)
  document.addEventListener('visibilitychange', onVisibility)
  activeFlush = flushIfPending

  return () => {
    unsubscribe()
    // Unmounting is not a reason to lose the last edit.
    flushIfPending()
    window.removeEventListener('pagehide', flushIfPending)
    document.removeEventListener('visibilitychange', onVisibility)
    if (activeFlush === flushIfPending) activeFlush = null
  }
}

/** Test seam: write now instead of after the debounce. */
export function flushPersistedCache(): void {
  activeFlush?.()
}

/** Test seam: forget module state between cases. */
export function resetPersistState(): void {
  cachedHashes.clear()
  suppressed = false
  activeFlush = null
  notify()
}
