// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { CONNECT_PHONE_HREF, ConnectPhoneLink } from './connect-phone-link'

const api = vi.hoisted(() => ({ getPhones: vi.fn() }))
const health = vi.hoisted(() => ({ phonePairing: true }))

vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { phonePairing: health.phonePairing } } }) }))
vi.mock('@/api/phones', async (original) => ({ ...(await original<typeof import('@/api/phones')>()), ...api }))

const list = (phones: PhonesResponse['phones']): PhonesResponse =>
  ({ relayOrigin: 'https://rome.cezar.run', relay: { status: 'off' }, pairing: null, account: { attached: false }, phones }) as PhonesResponse
const show = () => render(<MemoryRouter><QueryClientProvider client={createQueryClient()}><ConnectPhoneLink /></QueryClientProvider></MemoryRouter>)

describe('ConnectPhoneLink', () => {
  beforeEach(() => { api.getPhones.mockReset(); health.phonePairing = true })
  afterEach(cleanup)

  it('opens Settings > Connect a phone, labelled, and hidden below md', async () => {
    api.getPhones.mockResolvedValue(list([]))
    show()
    const link = await screen.findByRole('link', { name: 'Connect your phone' })
    expect(link.getAttribute('href')).toBe(CONNECT_PHONE_HREF)
    expect(link.getAttribute('title')).toBe('Pair the Cezar app with this computer')
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
})
