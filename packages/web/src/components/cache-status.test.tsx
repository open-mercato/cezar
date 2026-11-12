import { act, cleanup, render, screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dashboardLive } from '@/api/dashboard-live'
import { managerKeys } from '@/api/managers'
import { CACHE_KEY_PREFIX, CACHE_SCHEMA_VERSION, resetPersistState, restoreFirstScreen } from '@/api/query-persist'
import { managerFixture } from '@/routes/manager/manager-fixtures'
import { CACHE_CHIP_DELAY_MS, CacheStatusChip, CONNECTION_BANNER_DELAY_MS, ConnectionBanner, FIRST_CONNECT_BANNER_DELAY_MS } from './cache-status'

const KEY = `${CACHE_KEY_PREFIX}http://phone.test`
const SAVED_AT = new Date(2026, 10, 12, 14, 2).getTime()

function restoreManagers(): void {
  const storage = new Map([[KEY, JSON.stringify({
    v: CACHE_SCHEMA_VERSION,
    build: 'b',
    savedAt: SAVED_AT,
    entries: [{ k: managerKeys.list, d: { managers: [managerFixture()] }, t: SAVED_AT }],
  })]])
  restoreFirstScreen(new QueryClient(), {
    key: KEY,
    build: 'b',
    storage: {
      length: storage.size,
      key: () => null,
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => void storage.set(key, value),
      removeItem: (key) => void storage.delete(key),
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetPersistState()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetPersistState()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const chip = () => document.querySelector('[data-slot="cache-status"]')

describe('CacheStatusChip', () => {
  it('says nothing about data that was never restored', () => {
    render(<CacheStatusChip queryKey={managerKeys.list} isFetching isError={false} />)
    act(() => vi.advanceTimersByTime(CACHE_CHIP_DELAY_MS))
    expect(chip()).toBeNull()
  })

  it('marks a restored copy as updating, after a beat so a fast refresh never flashes', () => {
    restoreManagers()
    render(<CacheStatusChip queryKey={managerKeys.list} isFetching isError={false} />)
    expect(chip()).toBeNull()
    act(() => vi.advanceTimersByTime(CACHE_CHIP_DELAY_MS))
    expect(chip()?.getAttribute('data-state')).toBe('updating')
    expect(screen.getByRole('status').textContent).toBe('Cached · updating…')
  })

  it('says the copy is old once the refresh failed', () => {
    restoreManagers()
    render(<CacheStatusChip queryKey={managerKeys.list} isFetching={false} isError />)
    act(() => vi.advanceTimersByTime(CACHE_CHIP_DELAY_MS))
    expect(chip()?.getAttribute('data-state')).toBe('failed')
    expect(chip()?.textContent).toMatch(/^Showing cached data from (.* )?(14|0?2):02.* — couldn't refresh$/)
  })

  it('goes away when fresh data replaces the copy', () => {
    restoreManagers()
    render(<CacheStatusChip queryKey={managerKeys.list} isFetching isError={false} />)
    act(() => vi.advanceTimersByTime(CACHE_CHIP_DELAY_MS))
    expect(chip()).not.toBeNull()
    act(() => resetPersistState())
    expect(chip()).toBeNull()
  })
})

describe('ConnectionBanner', () => {
  const banner = () => document.querySelector('[data-slot="connection-banner"]')

  beforeEach(() => {
    vi.stubGlobal('EventSource', function EventSource() {})
    dashboardLive.connected(false)
  })
  afterEach(() => dashboardLive.connected(false))

  it('waits out a short drop, then says it is reconnecting', () => {
    render(<ConnectionBanner />)
    act(() => dashboardLive.connected(true))
    act(() => dashboardLive.connected(false))
    act(() => vi.advanceTimersByTime(CONNECTION_BANNER_DELAY_MS - 1))
    expect(banner()).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(banner()?.getAttribute('data-state')).toBe('reconnecting')
    expect(banner()?.textContent).toContain("Can't reach cezar — reconnecting…")
  })

  it('gives a slow first connect longer before saying anything', () => {
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS - 1))
    expect(banner()).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(banner()?.getAttribute('data-state')).toBe('reconnecting')
  })

  it('goes away when the stream is back', () => {
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()).not.toBeNull()
    act(() => dashboardLive.connected(true))
    expect(banner()).toBeNull()
  })

  it('says offline at once when the browser knows it is', () => {
    act(() => dashboardLive.connected(true))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(0))
    expect(banner()?.getAttribute('data-state')).toBe('offline')
  })

  it('renders nothing where there is no stream at all', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('EventSource', undefined)
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()).toBeNull()
  })
})
