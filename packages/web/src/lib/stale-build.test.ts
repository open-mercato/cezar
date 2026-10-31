import { afterEach, describe, expect, it, vi } from 'vitest'

import { reloadForStaleBuild, resetStaleBuildReload } from './stale-build'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  }
}

afterEach(() => resetStaleBuildReload())

describe('reloadForStaleBuild (telemetry c66965f8)', () => {
  it('reloads once when a chunk of an outdated shell fails to load', () => {
    const reload = vi.fn()
    expect(reloadForStaleBuild(memoryStorage(), reload, 1_000_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('answers true without reloading again while the first reload is under way', () => {
    const reload = vi.fn()
    const storage = memoryStorage()
    reloadForStaleBuild(storage, reload, 1_000_000)
    expect(reloadForStaleBuild(storage, reload, 1_000_001)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('does not loop: a chunk still missing right after a reload is a real failure', () => {
    const reload = vi.fn()
    const storage = memoryStorage({ 'cez:stale-build-reload-at': String(1_000_000) })
    expect(reloadForStaleBuild(storage, reload, 1_030_000)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })

  it('tries again once the previous reload is long past', () => {
    const reload = vi.fn()
    const storage = memoryStorage({ 'cez:stale-build-reload-at': String(1_000_000) })
    expect(reloadForStaleBuild(storage, reload, 1_000_000 + 61_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never reloads when the attempt cannot be remembered', () => {
    const reload = vi.fn()
    const throwing = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(reloadForStaleBuild(null, reload)).toBe(false)
    expect(reloadForStaleBuild(throwing, reload)).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
