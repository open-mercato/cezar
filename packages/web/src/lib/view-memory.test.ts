import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { forgetViewMemory, resetViewMemory, useRememberedState } from './view-memory'

beforeEach(() => {
  resetViewMemory()
})

describe('useRememberedState', () => {
  it('behaves like useState for a caller that does not want to be remembered', () => {
    const { result, unmount } = renderHook(() => useRememberedState<string | null>(undefined, null))
    act(() => result.current[1]('src/app.ts'))
    expect(result.current[0]).toBe('src/app.ts')
    unmount()

    // A second instance starts fresh: nothing was keyed, so nothing was kept.
    const again = renderHook(() => useRememberedState<string | null>(undefined, null))
    expect(again.result.current[0]).toBeNull()
  })

  it('brings a keyed value back after a remount — the layout switch this exists for', () => {
    const { result, unmount } = renderHook(() => useRememberedState<string | null>('run-1:0:files', null))
    act(() => result.current[1]('src/app.ts'))
    unmount()

    const again = renderHook(() => useRememberedState<string | null>('run-1:0:files', null))
    expect(again.result.current[0]).toBe('src/app.ts')
  })

  it('keeps two columns of the same task apart', () => {
    const first = renderHook(() => useRememberedState<string | null>('run-1:0:files', null))
    act(() => first.result.current[1]('a.ts'))
    const second = renderHook(() => useRememberedState<string | null>('run-1:1:files', null))
    expect(second.result.current[0]).toBeNull()
  })

  it('keeps two tasks apart', () => {
    const first = renderHook(() => useRememberedState<string | null>('run-1:0:files', null))
    act(() => first.result.current[1]('a.ts'))
    const other = renderHook(() => useRememberedState<string | null>('run-2:0:files', null))
    expect(other.result.current[0]).toBeNull()
  })
})

describe('forgetViewMemory', () => {
  it('drops a deleted task’s keys and leaves every other task alone', () => {
    const doomed = renderHook(() => useRememberedState<string | null>('run-1:0:files', null))
    act(() => doomed.result.current[1]('a.ts'))
    const kept = renderHook(() => useRememberedState<string | null>('run-2:0:files', null))
    act(() => kept.result.current[1]('b.ts'))

    forgetViewMemory('run-1:')

    expect(renderHook(() => useRememberedState<string | null>('run-1:0:files', null)).result.current[0]).toBeNull()
    expect(renderHook(() => useRememberedState<string | null>('run-2:0:files', null)).result.current[0]).toBe('b.ts')
  })
})
