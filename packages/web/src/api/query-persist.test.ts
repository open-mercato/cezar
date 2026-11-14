import { QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { actionMessage, managerFixture, userMessage } from '@/routes/manager/manager-fixtures'
import { managerKeys } from './managers'
import {
  buildBlob,
  cachedAt,
  CACHE_KEY_PREFIX,
  CACHE_SCHEMA_VERSION,
  CHAT_MESSAGES_KEPT,
  clearPersistedCache,
  flushPersistedCache,
  isPersistedKey,
  keepFirstScreenPersisted,
  resetPersistState,
  restoreFirstScreen,
  type PersistOptions,
} from './query-persist'

const KEY = `${CACHE_KEY_PREFIX}http://phone.test`
const BUILD = 'build-1'

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    map,
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
const options = (storage: ReturnType<typeof memoryStorage>, extra: PersistOptions = {}): PersistOptions =>
  ({ storage, key: KEY, build: BUILD, ...extra })

const managers = { managers: [managerFixture({ id: 'a' })] }
const health = (instanceId?: string, bootProject = 'cezar') => ({ version: '1', bootProject, capabilities: { managers: true }, ...(instanceId ? { instanceId } : {}) })

function seed(queryClient: QueryClient): void {
  queryClient.setQueryData(managerKeys.list, managers)
  queryClient.setQueryData(['default', 'health'], health('server-a'))
  queryClient.setQueryData(['default', 'runs', 'list'], [{ id: 'r1', createdAt: '2026-11-01' }])
  // Never persisted: secrets, a run's detail, the workspace config.
  queryClient.setQueryData(['secrets', 'default'], { secrets: [{ name: 'TOKEN' }] })
  queryClient.setQueryData(['workspace', 'secrets'], { secrets: [] })
  queryClient.setQueryData(['default', 'runs', 'detail', 'r1'], { id: 'r1' })
  queryClient.setQueryData(['workspace', 'ui-state'], { appearance: {} })
}

function written(storage: ReturnType<typeof memoryStorage>) {
  const raw = storage.getItem(KEY)
  return raw === null ? null : (JSON.parse(raw) as { v: number; entries: Array<{ k: unknown[]; d: unknown }> })
}

beforeEach(() => resetPersistState())
afterEach(() => resetPersistState())

describe('the allowlist', () => {
  it('keeps only the first-screen keys', () => {
    const queryClient = client()
    seed(queryClient)
    const blob = buildBlob(queryClient, BUILD)!
    expect(blob.entries.map((entry) => entry.k).sort()).toEqual([
      ['default', 'health'],
      ['default', 'runs', 'list'],
      ['workspace', 'managers', 'list'],
    ].sort())
    expect(blob.instanceId).toBe('server-a')
    expect(isPersistedKey(['workspace', 'managers', 'messages', 'a'])).toBe(true)
    expect(isPersistedKey(['workspace', 'ui-state'])).toBe(false)
    expect(isPersistedKey(['default', 'runs', 'detail', 'r1'])).toBe(false)
  })

  it('keeps one page of a chat, bounded, and never a pending approval', () => {
    const queryClient = client()
    const newest = [...Array.from({ length: 60 }, (_, index) => userMessage(index + 10)), actionMessage(70), actionMessage(71, { status: 'done' })]
    queryClient.setQueryData(managerKeys.messages('a'), {
      pages: [{ messages: newest, hasMore: true }, { messages: [userMessage(1)], hasMore: false }],
      pageParams: [undefined, 10],
    })
    const [entry] = buildBlob(queryClient, BUILD)!.entries
    const data = entry!.d as { pages: Array<{ messages: Array<{ id: string; kind: string; status?: string }>; hasMore: boolean }> }
    expect(data.pages).toHaveLength(1)
    expect(data.pages[0]!.messages).toHaveLength(CHAT_MESSAGES_KEPT)
    expect(data.pages[0]!.messages.some((message) => message.kind === 'action' && message.status === 'pending')).toBe(false)
    expect(data.pages[0]!.messages.at(-1)!.id).toBe('a71')
    expect(data.pages[0]!.hasMore).toBe(true)
  })

  it('skips a failed or pending query', () => {
    const queryClient = client()
    queryClient.getQueryCache().build(queryClient, { queryKey: managerKeys.list })
    expect(buildBlob(queryClient, BUILD)).toBeNull()
  })
})

describe('the size cap', () => {
  it('drops the lowest-ranked entries first and keeps the shell essentials', () => {
    const queryClient = client()
    queryClient.setQueryData(managerKeys.list, managers)
    queryClient.setQueryData(['workspace', 'runs-index'], { runs: Array.from({ length: 150 }, (_, index) => ({ id: `r${index}`, title: 'x'.repeat(200) })) })
    const blob = buildBlob(queryClient, BUILD, 4_000)!
    expect(blob.entries.map((entry) => entry.k)).toEqual([managerKeys.list])
  })

  it('writes nothing, and removes the old copy, when nothing fits', () => {
    const storage = memoryStorage()
    const queryClient = client()
    const session = restoreFirstScreen(queryClient, options(storage, { maxChars: 50 }))
    const stop = keepFirstScreenPersisted(session)
    storage.setItem(KEY, 'an older copy')
    queryClient.setQueryData(managerKeys.list, managers)
    flushPersistedCache()
    expect(storage.getItem(KEY)).toBeNull()
    stop()
  })

  it('swallows a quota error and leaves no partial copy', () => {
    const storage = memoryStorage()
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError')
    }
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(storage)))
    queryClient.setQueryData(managerKeys.list, managers)
    expect(() => flushPersistedCache()).not.toThrow()
    expect(storage.getItem(KEY)).toBeNull()
    stop()
  })
})

describe('restore', () => {
  function savedStorage(): ReturnType<typeof memoryStorage> {
    const storage = memoryStorage()
    const source = client()
    seed(source)
    const stop = keepFirstScreenPersisted(restoreFirstScreen(source, options(storage)))
    source.setQueryData(managerKeys.list, managers)
    flushPersistedCache()
    stop()
    resetPersistState()
    return storage
  }

  it('round-trips the allowlisted entries and marks them cached', () => {
    const storage = savedStorage()
    expect(written(storage)?.v).toBe(CACHE_SCHEMA_VERSION)
    const queryClient = client()
    restoreFirstScreen(queryClient, options(storage))
    expect(queryClient.getQueryData(managerKeys.list)).toEqual(managers)
    expect(queryClient.getQueryData(['secrets', 'default'])).toBeUndefined()
    expect(cachedAt(managerKeys.list)).toBeTypeOf('number')
    // Stale, so the first observer refetches it whatever its age.
    expect(queryClient.getQueryCache().find({ queryKey: managerKeys.list })!.state.isInvalidated).toBe(true)
  })

  it('stays cached through a stream patch and turns current on a real fetch', async () => {
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(savedStorage())))
    queryClient.setQueryData(managerKeys.list, { managers: [] })
    expect(cachedAt(managerKeys.list)).toBeDefined()
    await queryClient.fetchQuery({ queryKey: managerKeys.list, queryFn: async () => managers })
    expect(cachedAt(managerKeys.list)).toBeUndefined()
    stop()
  })

  it('still refetches a patched copy when its first observer mounts', async () => {
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(savedStorage())))
    queryClient.setQueryData(managerKeys.list, { managers: [] })
    let fetched = 0
    // The chat's own staleTime: only the invalidation makes the mount fetch.
    const observer = new QueryObserver(queryClient, { queryKey: managerKeys.list, staleTime: Infinity, queryFn: async () => { fetched += 1; return managers } })
    const off = observer.subscribe(() => undefined)
    await expect.poll(() => fetched).toBe(1)
    await expect.poll(() => cachedAt(managerKeys.list)).toBeUndefined()
    off()
    stop()
  })

  it('keeps the cached mark, and the data, when the refresh fails', async () => {
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(savedStorage())))
    const observer = new QueryObserver(queryClient, { queryKey: managerKeys.list, queryFn: async () => { throw new Error('offline') } })
    const off = observer.subscribe(() => undefined)
    await expect.poll(() => observer.getCurrentResult().isError).toBe(true)
    expect(observer.getCurrentResult().data).toEqual(managers)
    expect(cachedAt(managerKeys.list)).toBeDefined()
    off()
    stop()
  })

  it('drops the copy when another server answers at this origin', async () => {
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(savedStorage())))
    await queryClient.fetchQuery({ queryKey: ['default', 'health'], queryFn: async () => health('server-b') })
    expect(queryClient.getQueryData(managerKeys.list)).toBeUndefined()
    expect(cachedAt(managerKeys.list)).toBeUndefined()
    // The answer that revealed the swap is the new server's own: kept, not refetched.
    expect(queryClient.getQueryData(['default', 'health'])).toEqual(health('server-b'))
    stop()
  })

  it('tells servers without an install id apart by their boot project', async () => {
    const storage = memoryStorage()
    const source = client()
    source.setQueryData(managerKeys.list, managers)
    source.setQueryData(['default', 'health'], health(undefined, 'repo-a'))
    expect(buildBlob(source, BUILD)!.instanceId).toBe('boot:repo-a')
    const stop0 = keepFirstScreenPersisted(restoreFirstScreen(source, options(storage)))
    source.setQueryData(managerKeys.list, managers)
    flushPersistedCache()
    stop0()
    resetPersistState()
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(storage)))
    await queryClient.fetchQuery({ queryKey: ['default', 'health'], queryFn: async () => health(undefined, 'repo-b') })
    expect(queryClient.getQueryData(managerKeys.list)).toBeUndefined()
    stop()
  })

  it('clears a copy written by another schema version or build', () => {
    for (const blob of [{ v: CACHE_SCHEMA_VERSION + 1, build: BUILD }, { v: CACHE_SCHEMA_VERSION, build: 'build-0' }]) {
      const storage = memoryStorage({ [KEY]: JSON.stringify({ ...blob, savedAt: 1, entries: [{ k: managerKeys.list, d: managers, t: 1 }] }) })
      const queryClient = client()
      restoreFirstScreen(queryClient, options(storage))
      expect(queryClient.getQueryData(managerKeys.list)).toBeUndefined()
      expect(storage.getItem(KEY)).toBeNull()
    }
  })

  it('clears a corrupt entry, or one naming a key off the allowlist', () => {
    const bad = [
      '{not json',
      'null',
      JSON.stringify({ v: CACHE_SCHEMA_VERSION, build: BUILD, savedAt: 1, entries: [{ k: ['secrets', 'default'], d: {}, t: 1 }] }),
      JSON.stringify({ v: CACHE_SCHEMA_VERSION, build: BUILD, savedAt: 1, entries: 'nope' }),
    ]
    for (const raw of bad) {
      const storage = memoryStorage({ [KEY]: raw })
      const queryClient = client()
      expect(() => restoreFirstScreen(queryClient, options(storage))).not.toThrow()
      expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
      expect(storage.getItem(KEY)).toBeNull()
    }
  })

  it('survives a storage that throws on read', () => {
    const storage = memoryStorage()
    storage.getItem = () => {
      throw new Error('SecurityError')
    }
    expect(() => restoreFirstScreen(client(), options(storage))).not.toThrow()
  })
})

describe('clearing', () => {
  it('wipes every server copy in this origin and stops writing', () => {
    const storage = memoryStorage({ [KEY]: '{}', [`${CACHE_KEY_PREFIX}http://other`]: '{}', unrelated: 'keep' })
    const queryClient = client()
    const stop = keepFirstScreenPersisted(restoreFirstScreen(queryClient, options(storage)))
    expect(window.__cezarClearCache).toBeTypeOf('function')
    window.__cezarClearCache!()
    expect([...storage.map.keys()]).toEqual(['unrelated'])
    queryClient.setQueryData(managerKeys.list, managers)
    flushPersistedCache()
    expect(storage.getItem(KEY)).toBeNull()
    stop()
  })

  it('drops the cached marks too', () => {
    const storage = memoryStorage({
      [KEY]: JSON.stringify({ v: CACHE_SCHEMA_VERSION, build: BUILD, savedAt: 1, entries: [{ k: managerKeys.list, d: managers, t: 1 }] }),
    })
    restoreFirstScreen(client(), options(storage))
    expect(cachedAt(managerKeys.list)).toBe(1)
    clearPersistedCache(storage)
    expect(cachedAt(managerKeys.list)).toBeUndefined()
  })
})
