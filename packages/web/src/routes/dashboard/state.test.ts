import { renderHook, act, cleanup } from '@testing-library/react'
import { useStagedRows } from './state'
import { describe, expect, it } from 'vitest'
import { affectedKeys, reconcileRows } from './state'
describe('dashboard staged rows', () => {
  it('counts identities, preserves places and immediately removes obsolete actions', () => {
    const old = [
      { key: 'a', status: 'waiting' },
      { key: 'b', status: 'review' },
    ]
    const current = [
      { key: 'c', status: 'waiting' },
      { key: 'a', status: 'done' },
    ]
    expect(affectedKeys(old, current, (r) => r.key).size).toBe(3)
    expect(reconcileRows(old, current, (r) => r.key)).toEqual([
      { row: current[1], removed: false },
      { row: old[1], removed: true },
    ])
  })
})

it('stages allocation changes but accepts explicit user paging', () => {
  const initial = [{ key: 'one' }, { key: 'two' }, { key: 'three' }]
  const { result, rerender } = renderHook(
    ({ rows, count }) => useStagedRows(rows, (r) => r.key, 'test', count),
    { initialProps: { rows: initial, count: 0 } },
  )
  act(() => rerender({ rows: [{ key: 'new' }, ...initial], count: 0 }))
  expect(result.current.rows.map((r) => r.row.key)).toEqual(['one', 'two', 'three'])
  expect(result.current.updates).toBeGreaterThan(0)
  act(() => rerender({ rows: [{ key: 'new' }, ...initial], count: 4 }))
  expect(result.current.rows).toHaveLength(4)
  cleanup()
})

it('resets staged rows when a mounted feed changes its source filter', () => {
  const { result, rerender, unmount } = renderHook(
    ({ rows, filter }: { rows: { key: string }[] | undefined; filter: string }) =>
      useStagedRows(rows, (row) => row.key, `source:${filter}`),
    { initialProps: { rows: [{ key: 'task' }], filter: 'tasks' } as { rows: { key: string }[] | undefined; filter: string } },
  )
  expect(result.current.rows.map(({ row }) => row.key)).toEqual(['task'])
  act(() => rerender({ rows: undefined, filter: 'github' }))
  expect(result.current.rows).toEqual([])
  act(() => rerender({ rows: [{ key: 'pull-request' }], filter: 'github' }))
  expect(result.current.rows.map(({ row }) => row.key)).toEqual(['pull-request'])
  expect(result.current.updates).toBe(0)
  unmount()
})
