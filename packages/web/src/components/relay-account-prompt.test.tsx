// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { PhonesResponse } from '@open-mercato/cezar-api-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { RelayAccountPrompt } from './relay-account-prompt'

const api = vi.hoisted(() => ({ getPhones: vi.fn(), getRelayAccount: vi.fn(), dismissRelayAccountPrompt: vi.fn(), setRelayAccount: vi.fn() }))
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
})
const show = () => render(<QueryClientProvider client={createQueryClient()}><RelayAccountPrompt /></QueryClientProvider>)

describe('RelayAccountPrompt (RELAY_PROTOCOL.md § 18)', () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset()
    health.phonePairing = true
    api.getRelayAccount.mockResolvedValue({ local: { attached: false, prompt: true }, status: { state: 'pending', email: null, termsVersion: null, acceptedAt: null, confirmedAt: null, graceEndsAt: 1, secondsLeft: 30 * 3600 } })
    api.dismissRelayAccountPrompt.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('asks once for phones paired before accounts, with the grace left, and can be put off', async () => {
    api.getPhones.mockResolvedValue(phones({ attached: false, prompt: true }))
    show()
    await screen.findByTestId('relay-account-prompt')
    expect(await screen.findByText(/keep working for 30 h 0 min/)).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()
    api.getPhones.mockResolvedValue(phones({ attached: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Later, in Settings' }))
    await waitFor(() => expect(api.dismissRelayAccountPrompt).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByTestId('relay-account-prompt')).toBeNull())
  })

  it('stays away once answered, with an account, or with pairing off', async () => {
    api.getPhones.mockResolvedValue(phones({ attached: true, email: 'me@example.test' }))
    show()
    await waitFor(() => expect(api.getPhones).toHaveBeenCalled())
    expect(screen.queryByTestId('relay-account-prompt')).toBeNull()
    cleanup()
    health.phonePairing = false
    api.getPhones.mockClear()
    show()
    expect(api.getPhones).not.toHaveBeenCalled()
    expect(api.getRelayAccount).not.toHaveBeenCalled()
  })
})
