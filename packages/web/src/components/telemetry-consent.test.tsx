import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import type { TelemetryConsentPayload } from '@open-mercato/cezar-api-client'
import { shouldAskForTelemetry } from '@/lib/telemetry-consent'
import { TelemetryConsentBanner } from './telemetry-consent'

/** The opt-in bar: who sees it, and that each answer records exactly what the user did. */

const UNKNOWN: TelemetryConsentPayload = {
  consent: 'unknown',
  policyVersion: 1,
  blockedBy: null,
  endpoint: 'https://stats.openmercato.cloud',
}

let clients: QueryClient[] = []
let fetchMock: ReturnType<typeof vi.fn>

function mount(payload: TelemetryConsentPayload) {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { consent?: string }
    return new Response(JSON.stringify({ ...payload, consent: body.consent }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const client = createQueryClient()
  clients.push(client)
  client.setQueryData(workspaceQueryKeys.telemetryConsent, payload)
  render(
    <QueryClientProvider client={client}>
      <TelemetryConsentBanner />
    </QueryClientProvider>,
  )
  return client
}

afterEach(() => {
  cleanup()
  for (const c of clients) c.clear()
  clients = []
  vi.unstubAllGlobals()
})

describe('shouldAskForTelemetry', () => {
  it('asks only an unanswered machine that could actually send', () => {
    expect(shouldAskForTelemetry(UNKNOWN)).toBe(true)
    expect(shouldAskForTelemetry({ ...UNKNOWN, consent: 'granted' })).toBe(false)
    expect(shouldAskForTelemetry({ ...UNKNOWN, consent: 'denied' })).toBe(false)
    expect(shouldAskForTelemetry({ ...UNKNOWN, blockedBy: 'env' })).toBe(false)
    expect(shouldAskForTelemetry({ ...UNKNOWN, blockedBy: 'automation' })).toBe(false)
    expect(shouldAskForTelemetry(undefined)).toBe(false)
  })
})

describe('TelemetryConsentBanner', () => {
  const banner = () => document.querySelector('[data-slot="telemetry-consent-banner"]')
  const dialog = () => document.querySelector('[data-slot="telemetry-details-dialog"]')

  it('shows the bar for an unanswered machine, with no dialog', () => {
    mount(UNKNOWN)
    expect(banner()).not.toBeNull()
    expect(dialog()).toBeNull()
    expect(screen.getByText('Help improve cezar?')).toBeTruthy()
  })

  it('renders nothing once answered or when sending is blocked', () => {
    mount({ ...UNKNOWN, consent: 'denied' })
    expect(banner()).toBeNull()
    cleanup()
    mount({ ...UNKNOWN, blockedBy: 'automation' })
    expect(banner()).toBeNull()
  })

  it.each([
    ['telemetry-grant', 'granted'],
    ['telemetry-deny', 'denied'],
  ] as const)('%s records %s and removes the bar', async (slot, consent) => {
    const client = mount(UNKNOWN)
    await act(async () => {
      fireEvent.click(document.querySelector(`[data-slot="${slot}"]`)!)
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/api/v1/telemetry/consent')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ consent })
    expect(client.getQueryData<TelemetryConsentPayload>(workspaceQueryKeys.telemetryConsent)?.consent).toBe(consent)
    expect(banner()).toBeNull()
  })

  it('opens the details dialog only on request, and answers from it', async () => {
    mount(UNKNOWN)
    fireEvent.click(document.querySelector('[data-slot="telemetry-details"]')!)
    expect(dialog()).not.toBeNull()
    expect(screen.getByText('Usage data, in full')).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(dialog()!.querySelector('[data-slot="telemetry-grant"]')!)
    })
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ consent: 'granted' })
    expect(dialog()).toBeNull()
    expect(banner()).toBeNull()
  })
})
