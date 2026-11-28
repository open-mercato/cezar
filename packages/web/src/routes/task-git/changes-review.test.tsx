import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { baseParam, patchHash, useViewedFiles } from './changes-review'

describe('baseParam', () => {
  it('sends nothing for a route default, so the request stays byte-identical', () => {
    expect(baseParam({ kind: 'merge-base', ref: '' }, 'merge-base')).toBeUndefined()
    expect(baseParam({ kind: 'worktree', ref: '' }, 'merge-base')).toBe('worktree')
    expect(baseParam({ kind: 'merge-base', ref: '' }, null)).toBe('merge-base')
  })

  it('sends a typed ref, never an empty or option-like one', () => {
    expect(baseParam({ kind: 'ref', ref: ' release/v1 ' }, 'merge-base')).toBe('release/v1')
    expect(baseParam({ kind: 'ref', ref: '' }, 'merge-base')).toBeUndefined()
    expect(baseParam({ kind: 'ref', ref: '--output=x' }, 'merge-base')).toBeUndefined()
  })
})

describe('useViewedFiles', () => {
  beforeEach(() => localStorage.clear())
  const files = [
    { path: 'a.ts', patch: 'patch-a' },
    { path: 'b.ts', patch: 'patch-b' },
  ]

  it('toggles, counts and persists across a remount', () => {
    const first = renderHook(() => useViewedFiles('s1', files))
    act(() => first.result.current.toggle('a.ts'))
    expect(first.result.current.count).toBe(1)
    expect(first.result.current.total).toBe(2)
    first.unmount()

    const second = renderHook(() => useViewedFiles('s1', files))
    expect([...second.result.current.viewed]).toEqual(['a.ts'])
    act(() => second.result.current.toggle('a.ts'))
    expect(second.result.current.count).toBe(0)
  })

  it('keeps marks per scope', () => {
    const one = renderHook(() => useViewedFiles('s1', files))
    act(() => one.result.current.toggle('a.ts'))
    const other = renderHook(() => useViewedFiles('s2', files))
    expect(other.result.current.count).toBe(0)
  })

  it('resets a file whose patch changed', () => {
    const first = renderHook(() => useViewedFiles('s1', files))
    act(() => first.result.current.toggle('a.ts'))
    first.unmount()
    const changed = [{ path: 'a.ts', patch: 'patch-a2' }, files[1]!]
    const second = renderHook(() => useViewedFiles('s1', changed))
    expect(second.result.current.count).toBe(0)
    expect(patchHash('patch-a')).not.toBe(patchHash('patch-a2'))
  })
})
