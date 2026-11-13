// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { ADD_EMAIL_HREF, RelayAccountNotice } from './relay-account-notice'

const api = vi.hoisted(() => ({ getPhones: vi.fn(), getRelayAccount: vi.fn(), dismissRelayAccountPrompt: vi.fn() }))
const health = vi.hoisted(() => ({ phonePairing: true }))

vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { phonePairing: health.phonePairing } } }) }))
vi.mock('@/api/phones', async (original) => {
  const actual = await original<typeof import('@/api/phones')>()
  const { useQuery } = await import('@tanstack/react-query')
  return {
    ...actual,
    ...api,
    useRelayAccount: () => useQuery({ queryKey: actual.phoneKeys.account, queryFn: () => api.getRelayAccount() }),
  }
})

const phones = (account: PhonesResponse['account']): PhonesResponse => ({
  relayOrigin: 'https://rome.cezar.run', relay: { status: 'connected' }, pairing: null, account,
  phones: [{ deviceId: 'd'.repeat(22), label: 'Pixel', platform: 'android', addedAt: '', connected: true }],
} as PhonesResponse)
const show = () => render(<MemoryRouter><QueryClientProvider client={createQueryClient()}><RelayAccountNotice /></QueryClientProvider></MemoryRouter>)

describe('RelayAccountNotice (RELAY_PROTOCOL.md § 18)', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    health.phonePairing = true
    api.getRelayAccount.mockResolvedValue({ local: { attached: false, prompt: true }, status: { state: 'pending', email: null, termsVersion: null, acceptedAt: null, confirmedAt: null, graceEndsAt: 1, secondsLeft: 30 * 3600 } })
    api.dismissRelayAccountPrompt.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('is a small bar, not a modal, with the grace left and a link to the email step, and can be dismissed', async () => {
    api.getPhones.mockResolvedValue(phones({ attached: false, prompt: true }))
    show()
    const bar = await screen.findByTestId('relay-account-notice')
    expect(await screen.findByText(/keep working for 30 h/)).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(screen.getByRole('link', { name: 'Add email' }).getAttribute('href')).toBe(ADD_EMAIL_HREF)
    api.getPhones.mockResolvedValue(phones({ attached: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.dismissRelayAccountPrompt).toHaveBeenCalled())
    await waitFor(() => expect(bar.isConnected).toBe(false))
  })

  it('stays away with an account, once dismissed, or with pairing off', async () => {
    api.getPhones.mockResolvedValue(phones({ attached: true, email: 'me@example.test' }))
    show()
    await waitFor(() => expect(api.getPhones).toHaveBeenCalled())
    expect(screen.queryByTestId('relay-account-notice')).toBeNull()
    cleanup()
    health.phonePairing = false
    api.getPhones.mockClear()
    show()
    expect(api.getPhones).not.toHaveBeenCalled()
  })
})
