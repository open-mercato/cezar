import { DEFAULT_PHONE_PUSH_PREFS } from '@open-mercato/cezar-api-client'
// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { CONNECT_PHONE_HREF, ConnectPhoneLink, PhonesLink } from './connect-phone-link'

const api = vi.hoisted(() => ({ getPhones: vi.fn(), getRelayAccount: vi.fn(), reconnectRelay: vi.fn() }))
const health = vi.hoisted(() => ({ phonePairing: true }))

vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { phonePairing: health.phonePairing } } }) }))
let emit: ((name: string) => void) | undefined
vi.mock('@/api/global-events', () => ({
  onWorkspaceEvent: (listener: (name: string) => void) => { emit = listener; return () => { emit = undefined } },
}))
vi.mock('@/api/phones', async (original) => {
  const actual = await original<typeof import('@/api/phones')>()
  const { useQuery, useQueryClient } = await import('@tanstack/react-query')
  const { useEffect } = await import('react')
  return {
    ...actual,
    ...api,
    usePhones: (enabled = true) => {
      const queryClient = useQueryClient()
      useEffect(() => { emit = () => void queryClient.invalidateQueries({ queryKey: actual.phoneKeys.list }) }, [queryClient])
      return useQuery({ queryKey: actual.phoneKeys.list, queryFn: () => api.getPhones(), enabled })
    },
  }
})

const list = (phones: PhonesResponse['phones'], relay: PhonesResponse['relay'] = { status: 'off' }): PhonesResponse =>
  ({ relayOrigin: 'https://rome.cezar.run', relay, pairing: null, account: { attached: false }, keepAwake: { enabled: true, active: false }, phones }) as PhonesResponse
const IPAD: PhonesResponse['phones'] = [{ deviceId: 'd'.repeat(22), label: 'iPad', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'ios', addedAt: '', connected: false }]
const dot = () => document.querySelector<HTMLElement>('[data-slot="relay-dot"]')
const glyph = () => document.querySelector<HTMLElement>('[data-slot="phones-icon"]')
/** Radix opens a menu on pointerdown, not click. */
const open = (button: HTMLElement) => fireEvent.pointerDown(button, { button: 0, ctrlKey: false, pointerType: 'mouse' })
const show = () => render(<MemoryRouter><QueryClientProvider client={createQueryClient()}><ConnectPhoneLink /><PhonesLink /></QueryClientProvider></MemoryRouter>)

describe('ConnectPhoneLink', () => {
  beforeEach(() => { api.getPhones.mockReset(); health.phonePairing = true })
  afterEach(cleanup)

  it('opens Settings > Connect a phone, labelled, and hidden below md', async () => {
    api.getPhones.mockResolvedValue(list([]))
    show()
    const link = await screen.findByRole('link', { name: 'Connect your phone' })
    expect(link.getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(link.getAttribute('title')).toBe('Get the CezarBot app on your phone and pair it with this computer')
    expect(link.className).toMatch(/^hidden\b.*\bmd:flex\b/)
  })

  it('is gone once a phone is paired, and with pairing off', async () => {
    api.getPhones.mockResolvedValue(list([{ deviceId: 'd'.repeat(22), label: 'Pixel', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'android', addedAt: '', connected: true }]))
    show()
    await waitFor(() => expect(api.getPhones).toHaveBeenCalled())
    expect(screen.queryByRole('link', { name: 'Connect your phone' })).toBeNull()
    cleanup()
    health.phonePairing = false
    api.getPhones.mockClear()
    show()
    expect(api.getPhones).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: 'Connect your phone' })).toBeNull()
  })

  it('once a phone is paired, the row gives way to a Phones icon that opens a summary leading to the same page', async () => {
    api.getPhones.mockResolvedValue(list([{ deviceId: 'd'.repeat(22), label: 'Pixel', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'android', addedAt: '', connected: true }]))
    show()
    const icon = await screen.findByRole('button', { name: /^Phones/ })
    expect(icon.getAttribute('title')).toBe('Phones · Not connected')
    expect(icon.dataset.slot).toBe('phones-link')
    open(icon)
    const settings = await screen.findByRole('menuitem', { name: 'Open phone settings' })
    expect(settings.getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(icon.className).toMatch(/\bml-auto\b/)
    expect(icon.className).toMatch(/\bhidden\b.*\bmd:inline-flex\b/)
    expect(screen.queryByRole('link', { name: 'Connect your phone' })).toBeNull()
  })

  it('no Phones icon before pairing, or with pairing off', async () => {
    api.getPhones.mockResolvedValue(list([]))
    show()
    await screen.findByRole('link', { name: 'Connect your phone' })
    expect(screen.queryByRole('button', { name: /^Phones/ })).toBeNull()
  })
})

describe('the relay dot on the phone entry', () => {
  beforeEach(() => { api.getPhones.mockReset(); health.phonePairing = true })
  afterEach(cleanup)
  const shown = async (relay: PhonesResponse['relay'], phones = IPAD) => {
    api.getPhones.mockResolvedValue(list(phones, relay))
    show()
    return phones.length ? screen.findByRole('button', { name: /^Phones/ }) : screen.findByRole('link', { name: 'Connect your phone' })
  }

  it('not set up: a neutral icon and no dot', async () => {
    await shown({ status: 'off' }, [])
    expect(dot()).toBeNull()
  })

  it('connected: the icon itself is green, with no dot, and the tooltip says so', async () => {
    const link = await shown({ status: 'connected', connectedAt: new Date().toISOString() })
    expect(dot()).toBeNull()
    expect(glyph()?.dataset.look).toBe('ok')
    expect(glyph()?.getAttribute('class')).toMatch(/\btext-success-strong\b/)
    expect(link.getAttribute('title')).toBe('Phones · Phone relay: connected')
    expect(link.getAttribute('aria-label')).toBe('Phones: Phone relay: connected')
  })

  it('reconnecting: amber, pulsing but still under reduced motion, with the attempt', async () => {
    const link = await shown({ status: 'unreachable', attempt: 2, nextRetryAt: new Date(Date.now() + 4000).toISOString(), lastDown: { at: '', reason: 'no-pong' } })
    expect(dot()?.dataset.tone).toBe('pending')
    expect(glyph()?.dataset.look).toBe('neutral')
    expect(dot()?.className.split(' ')).toEqual(expect.arrayContaining(['animate-pulse', 'motion-reduce:animate-none']))
    expect(link.getAttribute('title')).toMatch(/Reconnecting to the phone relay \(attempt 2, next try at .+\)/)
  })

  it('connecting with no failure yet is amber too', async () => {
    await shown({ status: 'connecting' })
    expect(dot()?.dataset.tone).toBe('pending')
  })

  it('offline: red with the reason once quick retries are spent', async () => {
    const link = await shown({ status: 'unreachable', attempt: 6, lastDown: { at: '', reason: 'refused', code: 502 } })
    expect(dot()?.dataset.tone).toBe('danger')
    expect(link.getAttribute('title')).toMatch(/Can’t reach the phone relay \(refused 502\): attempt 6/)
  })

  it.each([
    ['email-unconfirmed', /confirm your email/],
    ['account-required', /add your email/],
    ['suspended', /suspended/],
  ] as const)('blocked by the account (%s): red, linking to Settings › Connect a phone', async (status, words) => {
    const link = await shown({ status, lastBlock: { at: '', reason: status } })
    expect(dot()?.dataset.tone).toBe('danger')
    expect(dot()?.dataset.blocked).toBe('true')
    expect(link.getAttribute('title')).toMatch(words)
    expect(link.getAttribute('title')).toMatch(/Open Settings › Connect a phone/)
  })

  it('follows the phone-pairing event, never a timer', async () => {
    await shown({ status: 'connected' })
    expect(glyph()?.dataset.look).toBe('ok')
    api.getPhones.mockResolvedValue(list(IPAD, { status: 'unreachable', attempt: 1 }))
    emit?.('phone-pairing')
    await waitFor(() => expect(dot()?.dataset.tone).toBe('pending'))
  })
})

describe('the Phones summary popover', () => {
  beforeEach(() => { api.getPhones.mockReset(); api.getRelayAccount.mockReset(); api.reconnectRelay.mockReset(); health.phonePairing = true })
  afterEach(cleanup)
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
  const PHONES: PhonesResponse['phones'] = [
    { deviceId: 'a'.repeat(22), label: 'Pixel 9', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'android', addedAt: '', connected: true, push: true },
    { deviceId: 'b'.repeat(22), label: 'iPad', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'ios', addedAt: '', connected: false, lastSeenAt: at(180) },
    { deviceId: 'c'.repeat(22), label: 'iPhone', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'ios', addedAt: '', connected: false },
    { deviceId: 'e'.repeat(22), label: 'Old phone', prefs: DEFAULT_PHONE_PUSH_PREFS, platform: 'android', addedAt: '', connected: false },
  ]
  const opened = async (data: PhonesResponse) => {
    api.getPhones.mockResolvedValue(data)
    show()
    open(await screen.findByRole('button', { name: /^Phones/ }))
    return screen.findByRole('menu')
  }

  it('connected: status in words, relay host and times, stats, the computer, the account masked, and each phone', async () => {
    const menu = await opened({
      ...list(PHONES, {
        status: 'connected',
        connectedAt: at(5),
        lastDown: { at: at(60), reason: 'no-pong', code: 1006 },
        stats: { since: at(120), relayedToday: 42, uptime: 0.9876 },
      }),
      account: { attached: true, email: 'jane@example.com', computerName: 'Studio Mac' },
    } as PhonesResponse)
    const slot = (name: string) => menu.querySelector<HTMLElement>(`[data-slot="${name}"]`)
    expect(slot('phones-summary-status')?.textContent).toBe('Connected')
    expect(slot('relay-host')?.textContent).toBe('rome.cezar.run')
    expect(slot('relay-since')?.textContent).toMatch(/\d/)
    expect(slot('relay-last-down')?.textContent).toMatch(/no-pong \(1006\)$/)
    expect(slot('relay-relayed')?.textContent).toBe('42 messages')
    expect(slot('relay-uptime')?.textContent).toMatch(/^98\.7% since /)
    expect(within(menu).queryByRole('menuitem', { name: 'Reconnect now' })).toBeNull()
    expect(within(menu).getByRole('menuitem', { name: /Studio Mac/ }).getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Keep awake for your phone/ }).getAttribute('aria-checked')).toBe('true')
    expect(menu.textContent).toContain('j•••@example.com')
    expect(menu.textContent).not.toContain('jane@')
    expect(slot('account-status')?.textContent).toBe('Email added')
    expect(menu.textContent).toContain('Paired phones · 4')
    const rows = menu.querySelectorAll('[data-slot="paired-phone"]')
    expect([...rows].map((row) => row.textContent)).toEqual(['Pixel 9online · push on', 'iPadseen 3 h ago · no push', 'iPhonenever seen · no push'])
    expect(slot('paired-phones-more')?.textContent).toBe('and 1 more')
    expect(within(menu).getByRole('menuitem', { name: 'Open phone settings' }).getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(within(menu).queryByRole('menuitem', { name: 'Connect a phone' })).toBeNull()
  })

  it('reconnecting: says so, and Reconnect now asks cezar (not the relay) and shows its answer', async () => {
    const menu = await opened(list(PHONES.slice(0, 1), { status: 'unreachable', attempt: 2, lastDown: { at: at(1), reason: 'closed', code: 1006 } }))
    expect(menu.querySelector('[data-slot="phones-summary-status"]')?.textContent).toBe('Reconnecting')
    api.reconnectRelay.mockResolvedValue(list(PHONES.slice(0, 1), { status: 'connected', connectedAt: at(0) }))
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Reconnect now' }))
    await waitFor(() => expect(api.reconnectRelay).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(glyph()?.dataset.look).toBe('ok'))
  })

  it('offline: red, with the reason in words', async () => {
    const menu = await opened(list(PHONES.slice(0, 1), { status: 'unreachable', attempt: 7, lastDown: { at: at(1), reason: 'refused', code: 502 } }))
    expect(menu.querySelector('[data-slot="phones-summary-status"]')?.textContent).toBe('Offline')
    expect(menu.querySelector('[data-slot="phones-summary-detail"]')?.textContent).toMatch(/Can’t reach the phone relay/)
    expect(dot()?.dataset.tone).toBe('danger')
  })

  it('email pending: red, and the account says it is not confirmed', async () => {
    const menu = await opened({
      ...list(PHONES.slice(0, 1), { status: 'email-unconfirmed', lastBlock: { at: at(1), reason: 'email-unconfirmed' } }),
      account: { attached: true, email: 'jane@example.com', computerName: 'Studio Mac' },
    } as PhonesResponse)
    expect(menu.querySelector('[data-slot="phones-summary-status"]')?.textContent).toBe('Confirm your email')
    expect(menu.querySelector('[data-slot="account-status"]')?.textContent).toBe('Not confirmed')
    expect(within(menu).getByRole('menuitem', { name: 'Reconnect now' })).toBeTruthy()
  })

  it.each([['error'], ['update-required'], ['locked'], ['suspended']] as const)('%s: no Reconnect now, which could not change it', async (status) => {
    const menu = await opened(list(PHONES.slice(0, 1), { status }))
    expect(within(menu).queryByRole('menuitem', { name: 'Reconnect now' })).toBeNull()
  })

  it('never asks the relay for the account: it reads what Settings last cached', async () => {
    await opened(list(PHONES.slice(0, 1), { status: 'connected' }))
    expect(api.getRelayAccount).not.toHaveBeenCalled()
  })
})
