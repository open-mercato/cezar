// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { CONNECT_PHONE_HREF, ConnectPhoneLink, PhonesLink } from './connect-phone-link'

const api = vi.hoisted(() => ({ getPhones: vi.fn() }))
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
const IPAD: PhonesResponse['phones'] = [{ deviceId: 'd'.repeat(22), label: 'iPad', platform: 'ios', addedAt: '', connected: false }]
const dot = () => document.querySelector<HTMLElement>('[data-slot="relay-dot"]')
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
    api.getPhones.mockResolvedValue(list([{ deviceId: 'd'.repeat(22), label: 'Pixel', platform: 'android', addedAt: '', connected: true }]))
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

  it('once a phone is paired, the row gives way to a Phones icon that opens the same page', async () => {
    api.getPhones.mockResolvedValue(list([{ deviceId: 'd'.repeat(22), label: 'Pixel', platform: 'android', addedAt: '', connected: true }]))
    show()
    const icon = await screen.findByRole('link', { name: /^Phones/ })
    expect(icon.getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(icon.getAttribute('title')).toBe('Phones')
    expect(icon.dataset.slot).toBe('phones-link')
    expect(icon.className).toMatch(/\bml-auto\b/)
    expect(icon.className).toMatch(/\bhidden\b.*\bmd:inline-flex\b/)
    expect(screen.queryByRole('link', { name: 'Connect your phone' })).toBeNull()
  })

  it('no Phones icon before pairing, or with pairing off', async () => {
    api.getPhones.mockResolvedValue(list([]))
    show()
    await screen.findByRole('link', { name: 'Connect your phone' })
    expect(screen.queryByRole('link', { name: /^Phones/ })).toBeNull()
  })
})

describe('the relay dot on the phone entry', () => {
  beforeEach(() => { api.getPhones.mockReset(); health.phonePairing = true })
  afterEach(cleanup)
  const shown = async (relay: PhonesResponse['relay'], phones = IPAD) => {
    api.getPhones.mockResolvedValue(list(phones, relay))
    show()
    return screen.findByRole('link', { name: phones.length ? /^Phones/ : 'Connect your phone' })
  }

  it('not set up: no dot', async () => {
    await shown({ status: 'off' }, [])
    expect(dot()).toBeNull()
  })

  it('connected: green, and the tooltip says so', async () => {
    const link = await shown({ status: 'connected', connectedAt: new Date().toISOString() })
    expect(dot()?.dataset.tone).toBe('success')
    expect(dot()?.className).not.toMatch(/animate-pulse/)
    expect(link.getAttribute('title')).toBe('Phones · Phone relay: connected')
    expect(link.getAttribute('aria-label')).toBe('Phones: Phone relay: connected')
  })

  it('reconnecting: amber, pulsing but still under reduced motion, with the attempt', async () => {
    const link = await shown({ status: 'unreachable', attempt: 2, nextRetryAt: new Date(Date.now() + 4000).toISOString(), lastDown: { at: '', reason: 'no-pong' } })
    expect(dot()?.dataset.tone).toBe('pending')
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
    expect(link.getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(link.getAttribute('title')).toMatch(words)
    expect(link.getAttribute('title')).toMatch(/Open Settings › Connect a phone/)
  })

  it('follows the phone-pairing event, never a timer', async () => {
    await shown({ status: 'connected' })
    expect(dot()?.dataset.tone).toBe('success')
    api.getPhones.mockResolvedValue(list(IPAD, { status: 'unreachable', attempt: 1 }))
    emit?.('phone-pairing')
    await waitFor(() => expect(dot()?.dataset.tone).toBe('pending'))
  })
})
