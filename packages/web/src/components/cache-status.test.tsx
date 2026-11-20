import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dashboardLive } from '@/api/dashboard-live'
import { managerKeys } from '@/api/managers'
import { CACHE_KEY_PREFIX, CACHE_SCHEMA_VERSION, resetPersistState, restoreFirstScreen } from '@/api/query-persist'
import { managerFixture } from '@/routes/manager/manager-fixtures'
import { connectionStatus, nativeConnectionStatus } from '@/api/connection-status'
import { shellRequest } from '@/lib/phone-app'
import {
  BACK_ONLINE_FADE_MS,
  BACK_ONLINE_MS,
  CACHE_CHIP_DELAY_MS,
  CacheStatusChip,
  CONNECTION_BANNER_DELAY_MS,
  ConnectionBanner,
  FIRST_CONNECT_BANNER_DELAY_MS,
  LONG_OFFLINE_MS,
  SHELL_RECONNECT_URL,
} from './cache-status'

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
  afterEach(() => {
    dashboardLive.connected(false)
    connectionStatus.opened()
    connectionStatus.requestSettled(false)
    vi.restoreAllMocks()
  })

  it('says only that live updates are paused while cezar still answers requests', () => {
    render(<ConnectionBanner />)
    act(() => connectionStatus.requestSettled(true))
    act(() => vi.advanceTimersByTime(CONNECTION_BANNER_DELAY_MS - 1))
    expect(banner()).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(banner()?.getAttribute('data-state')).toBe('paused')
    expect(banner()?.textContent).toBe('Live updates paused — refreshing periodically.')
    expect(banner()?.textContent).not.toContain('reconnecting')
    expect(screen.queryByRole('button', { name: 'Retry now' })).toBeNull()
    // Requests stop getting through too: that is an outage again.
    act(() => connectionStatus.requestSettled(false))
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()?.getAttribute('data-state')).toBe('reconnecting')
    act(() => dashboardLive.connected(true))
    expect(banner()?.getAttribute('data-state')).toBe('online')
  })

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

  it('says Back online when the stream is back, then fades away', () => {
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()).not.toBeNull()
    act(() => dashboardLive.connected(true))
    expect(banner()?.getAttribute('data-state')).toBe('online')
    expect(banner()?.textContent).toBe('Back online')
    act(() => vi.advanceTimersByTime(BACK_ONLINE_MS))
    expect(banner()?.className).toContain('opacity-0')
    act(() => vi.advanceTimersByTime(BACK_ONLINE_FADE_MS))
    expect(banner()).toBeNull()
  })

  it('stays silent about a drop it never showed', () => {
    render(<ConnectionBanner />)
    act(() => dashboardLive.connected(true))
    act(() => dashboardLive.connected(false))
    act(() => vi.advanceTimersByTime(CONNECTION_BANNER_DELAY_MS - 1))
    act(() => dashboardLive.connected(true))
    expect(banner()).toBeNull()
  })

  it('counts the reconnect attempts and animates only where motion is welcome', () => {
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()?.textContent).not.toContain('attempt')
    act(() => { connectionStatus.failedAttempt(); connectionStatus.failedAttempt(); connectionStatus.failedAttempt() })
    expect(banner()?.textContent).toContain("Can't reach cezar — reconnecting… (attempt 3)")
    expect(banner()?.getAttribute('aria-live')).toBe('polite')
    const animated = [...banner()!.querySelectorAll('[class*="animate-"]')]
    expect(animated.length).toBeGreaterThan(0)
    for (const node of animated) expect(node.getAttribute('class')).toMatch(/motion-safe:animate-/)
    act(() => connectionStatus.opened())
    expect(banner()?.textContent).not.toContain('attempt')
  })

  it('Retry now asks the stream to reconnect at once, once per burst of taps', () => {
    const reconnect = vi.fn()
    const unregister = connectionStatus.setReconnect(reconnect)
    try {
      render(<ConnectionBanner />)
      act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
      const retry = screen.getByRole('button', { name: 'Retry now' })
      fireEvent.click(retry)
      fireEvent.click(retry)
      expect(reconnect).toHaveBeenCalledTimes(1)
      expect(retry.getAttribute('aria-busy')).toBe('true')
      act(() => vi.advanceTimersByTime(2_000))
      fireEvent.click(retry)
      expect(reconnect).toHaveBeenCalledTimes(2)
    } finally {
      unregister()
    }
  })

  it('Retry now also asks the CezarBot shell to redial its relay', () => {
    const open = vi.spyOn(shellRequest, 'open').mockImplementation(() => undefined)
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }))
    expect(open).toHaveBeenCalledWith(SHELL_RECONNECT_URL)
  })

  it('offers CezarBot its computer list once the outage is long', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 CezarMobile/1.0')
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(screen.queryByRole('link', { name: 'Switch computer' })).toBeNull()
    act(() => vi.advanceTimersByTime(LONG_OFFLINE_MS))
    expect(screen.getByRole('link', { name: 'Switch computer' }).getAttribute('href')).toBe('cezar://servers')
  })

  it('never offers the computer list outside the shell', () => {
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS + LONG_OFFLINE_MS))
    expect(screen.queryByRole('link', { name: 'Switch computer' })).toBeNull()
  })

  it('says offline at once when the browser knows it is', () => {
    act(() => dashboardLive.connected(true))
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(0))
    expect(banner()?.getAttribute('data-state')).toBe('offline')
  })

  describe("with the CezarBot shell's reason", () => {
    // What the shell's loopback proxy answers when it cannot deliver (packages/contract, native-shell.ts).
    const emit = (reason?: string, computer?: string, status = 502) => act(() => {
      const headers = new Headers()
      if (reason) headers.set('X-Cezar-Unreachable', reason)
      if (computer) headers.set('X-Cezar-Computer', computer)
      nativeConnectionStatus.fromResponse({ status, headers })
    })
    const down = () => {
      render(<ConnectionBanner />)
      act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    }
    const title = () => document.querySelector('[data-slot="connection-banner-title"]')?.textContent
    const hint = () => document.querySelector('[data-slot="connection-banner-hint"]')?.textContent
    afterEach(() => nativeConnectionStatus.clear())

    it('names the computer that is asleep, and what to do about it', () => {
      down()
      emit('peer-offline', encodeURIComponent("Patryk's Studio Mac"))
      expect(title()).toBe("Patryk's Studio Mac is asleep or offline")
      expect(hint()).toContain('Wake it or check that cezar is running.')
      expect(banner()?.getAttribute('data-reason')).toBe('peer-offline')
    })

    it('says "Your computer" when the shell did not name it', () => {
      down()
      emit('peer-offline')
      expect(title()).toBe('Your computer is asleep or offline')
    })

    it('says the relay is out of reach', () => {
      down()
      emit('relay-unreachable')
      expect(title()).toBe("Can't reach the relay — reconnecting…")
    })

    it('says the account cannot connect', () => {
      down()
      emit('account-blocked')
      expect(title()).toBe("Your account can't connect through the relay")
      expect(hint()).toContain('Check your account in CezarBot.')
    })

    it("says offline when the shell's network is gone", () => {
      down()
      emit('network-offline')
      expect(title()).toBe("You're offline — reconnecting when the network is back.")
      expect(banner()?.getAttribute('data-state')).toBe('offline')
    })

    it('heard the shell before the banner mounted', () => {
      emit('relay-unreachable')
      down()
      expect(title()).toBe("Can't reach the relay — reconnecting…")
    })

    it("falls back to the page's own copy once an answer gets through, and ignores what does not parse", () => {
      down()
      emit('relay-unreachable')
      emit(undefined, undefined, 200)
      expect(title()).toBe("Can't reach cezar — reconnecting…")
      for (const [reason, status] of [['sleepy', 502], ['peer-offline', 503], [undefined, 502]] as const) emit(reason, undefined, status)
      expect(title()).toBe("Can't reach cezar — reconnecting…")
      expect(banner()?.hasAttribute('data-reason')).toBe(false)
    })

    it('drops a computer name that is not valid percent-encoding', () => {
      down()
      emit('peer-offline', '%E0%A4%A')
      expect(title()).toBe('Your computer is asleep or offline')
    })
  })

  it('renders nothing where there is no stream at all', () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('EventSource', undefined)
    render(<ConnectionBanner />)
    act(() => vi.advanceTimersByTime(FIRST_CONNECT_BANNER_DELAY_MS))
    expect(banner()).toBeNull()
  })
})
