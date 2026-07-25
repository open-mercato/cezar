import { describe, expect, it, vi } from 'vitest'

import {
  applyRunDeleted,
  applyRunEvent,
  createUsageStore,
  mergeRun,
  parseGlobalEvent,
  parseWorkspaceEvent,
  type GlobalEvent,
} from './events'
import type { ApiRun, RunRecord } from './types'

function run(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: id,
    workflow: 'quick-task',
    task: 'do it',
    status: 'running',
    createdAt: '2026-07-14T10:00:00.000Z',
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  }
}

const SAMPLE = { cpuPct: 12, rssBytes: 1024, procCount: 3 }

describe('parseGlobalEvent', () => {
  const cases: Array<[string, string, GlobalEvent | null]> = [
    ['ping', '', { type: 'ping' }],
    // The server sends `event: ping` with an empty data line — parsing it as JSON would throw.
    ['ping', 'anything', { type: 'ping' }],
    ['run', JSON.stringify(run('r1')), { type: 'run', run: run('r1') }],
    ['run-deleted', '{"id":"r1"}', { type: 'run-deleted', id: 'r1' }],
    ['todos', '[]', { type: 'todos', items: [] }],
    ['usage', JSON.stringify({ r1: SAMPLE }), { type: 'usage', usage: { r1: SAMPLE } }],
    ['usage', '{}', { type: 'usage', usage: {} }],
    // Garbage costs one frame, never the stream.
    ['run', 'not json', null],
    ['run', '{"title":"no id"}', null],
    ['run', 'null', null],
    ['run-deleted', '{}', null],
    ['run-deleted', '{"id":""}', null],
    ['todos', '{"not":"an array"}', null],
    ['usage', '[]', null],
    ['usage', 'null', null],
    // A name this client does not know (the server may grow events first).
    ['permission', '{"id":"x"}', null],
  ]

  it.each(cases)('%s + %j → %j', (name, data, expected) => {
    expect(parseGlobalEvent(name, data)).toEqual(expected)
  })
})

describe('parseWorkspaceEvent', () => {
  // The workspace stream's stamped envelopes (step 2.8) → today's GlobalEvent + the owner.
  // The reducers must never learn the wire changed: every unwrapped event below is exactly
  // the shape parseGlobalEvent produced from the legacy stream.
  const cases: Array<[string, string, { project: string | null; event: GlobalEvent } | null]> = [
    ['ping', '', { project: null, event: { type: 'ping' } }],
    // `run` grows a project key riding ON the record — the parser strips it back off.
    ['run', JSON.stringify({ ...run('r1'), project: 'a' }), { project: 'a', event: { type: 'run', run: run('r1') } }],
    ['run-deleted', '{"id":"r1","project":"a"}', { project: 'a', event: { type: 'run-deleted', id: 'r1' } }],
    // Array/record payloads have nowhere to carry a stamp, so they arrive wrapped.
    ['todos', '{"project":"a","items":[]}', { project: 'a', event: { type: 'todos', items: [] } }],
    [
      'usage',
      JSON.stringify({ project: 'a', usage: { r1: SAMPLE } }),
      { project: 'a', event: { type: 'usage', usage: { r1: SAMPLE } } },
    ],
    // No stamp, no owner, no way to route it — dropped whole rather than guessed at.
    ['run', JSON.stringify(run('r1')), null],
    ['run', JSON.stringify({ ...run('r1'), project: '' }), null],
    ['run-deleted', '{"id":"r1"}', null],
    ['todos', '{"items":[]}', null],
    ['usage', JSON.stringify({ r1: SAMPLE }), null],
    // And the same garbage tolerance as the legacy parser: one bad frame costs one frame.
    ['run', 'not json', null],
    ['run', '{"project":"a"}', null],
    ['run-deleted', '{"project":"a","id":""}', null],
    ['todos', '{"project":"a","items":{"not":"an array"}}', null],
    ['usage', '{"project":"a","usage":[]}', null],
    ['project-added', '{"project":"a"}', null],
  ]

  it.each(cases)('%s + %j → %j', (name, data, expected) => {
    expect(parseWorkspaceEvent(name, data)).toEqual(expected)
  })
})

describe('applyRunEvent', () => {
  it('leaves an unfetched list alone rather than inventing one', () => {
    // A one-run "list" assembled from whichever event happened to arrive is not the run list.
    // `undefined` is what setQueryData reads as "don't touch it".
    expect(applyRunEvent(undefined, run('r1'))).toBeUndefined()
  })

  it('upserts a run the list has never seen', () => {
    const next = applyRunEvent([], run('r1'))
    expect(next).toEqual([run('r1')])
  })

  it('updates an existing run in place — one run stays one row', () => {
    const list: ApiRun[] = [run('r1', { status: 'queued' }), run('r2')]
    const next = applyRunEvent(list, run('r1', { status: 'done', tokensUsed: 99 }))

    expect(next).toHaveLength(2)
    expect(next?.map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(next?.[0]?.status).toBe('done')
    expect(next?.[0]?.tokensUsed).toBe(99)
  })

  it('does not duplicate a row however many events one run emits', () => {
    let list: ApiRun[] | undefined = []
    for (const status of ['queued', 'running', 'review', 'done'] as const) {
      list = applyRunEvent(list, run('r1', { status }))
    }
    expect(list).toHaveLength(1)
    expect(list?.[0]?.status).toBe('done')
  })

  it('inserts a new run by createdAt descending, matching the server order', () => {
    const list: ApiRun[] = [
      run('newest', { createdAt: '2026-07-14T12:00:00.000Z' }),
      run('oldest', { createdAt: '2026-07-14T08:00:00.000Z' }),
    ]

    const middle = applyRunEvent(list, run('middle', { createdAt: '2026-07-14T10:00:00.000Z' }))
    expect(middle?.map((r) => r.id)).toEqual(['newest', 'middle', 'oldest'])

    // A run started right now — the common case — goes to the top.
    const top = applyRunEvent(list, run('now', { createdAt: '2026-07-14T13:00:00.000Z' }))
    expect(top?.map((r) => r.id)).toEqual(['now', 'newest', 'oldest'])

    // And one older than everything goes to the bottom rather than off the end.
    const bottom = applyRunEvent(list, run('ancient', { createdAt: '2020-01-01T00:00:00.000Z' }))
    expect(bottom?.map((r) => r.id)).toEqual(['newest', 'oldest', 'ancient'])
  })

  it('never mutates the list it was given', () => {
    const list: ApiRun[] = [run('r1', { status: 'queued' })]
    const frozen = Object.freeze([...list])
    applyRunEvent(frozen as ApiRun[], run('r1', { status: 'done' }))
    applyRunEvent(frozen as ApiRun[], run('r2'))
    expect(list[0]?.status).toBe('queued')
    expect(frozen).toHaveLength(1)
  })

  it('keeps the usage the GET attached — the stream record simply has no such field', () => {
    const list: ApiRun[] = [{ ...run('r1'), usage: SAMPLE }]
    const next = applyRunEvent(list, run('r1', { status: 'done' }))
    expect(next?.[0]?.usage).toEqual(SAMPLE)
    expect(next?.[0]?.status).toBe('done')
  })
})

describe('mergeRun', () => {
  it('carries usage over, and invents none when there was none', () => {
    expect(mergeRun({ ...run('r1'), usage: SAMPLE }, run('r1', { status: 'done' })).usage).toEqual(SAMPLE)
    expect(mergeRun(run('r1'), run('r1')).usage).toBeUndefined()
    expect(mergeRun(undefined, run('r1')).usage).toBeUndefined()
  })
})

describe('applyRunDeleted', () => {
  it('removes the run', () => {
    const next = applyRunDeleted([run('r1'), run('r2')], 'r1')
    expect(next?.map((r) => r.id)).toEqual(['r2'])
  })

  it('returns the same list for an id it never held — no re-render for someone else\'s news', () => {
    const list: ApiRun[] = [run('r1')]
    expect(applyRunDeleted(list, 'nope')).toBe(list)
  })

  it('leaves an unfetched list alone', () => {
    expect(applyRunDeleted(undefined, 'r1')).toBeUndefined()
  })
})

describe('createUsageStore', () => {
  it('starts empty and hands back a stable snapshot', () => {
    const store = createUsageStore()
    expect(store.get()).toEqual({})
    // Stable identity between reads, or useSyncExternalStore re-renders forever.
    expect(store.get()).toBe(store.get())
  })

  it('replaces the map on each tick and notifies subscribers', () => {
    const store = createUsageStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.set({ r1: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.get()).toEqual({ r1: SAMPLE })

    // A finished run drops out of the tick, and must stop reporting rather than keep its last
    // number — which is why a tick replaces instead of merging.
    store.set({ r2: SAMPLE })
    expect(store.get()).toEqual({ r2: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    store.set({ r3: SAMPLE })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(store.get()).toEqual({ r3: SAMPLE })
  })
})
