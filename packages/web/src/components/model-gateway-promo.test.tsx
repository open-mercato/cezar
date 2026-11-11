import type * as React from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { GatewayHint, MODEL_GATEWAY_PROMO_ID, ModelGatewayPromo } from '@/components/model-gateway-promo'

/** The header line about the model gateway: shown until closed or until a gateway is saved. */

vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))

const fetchMock = vi.fn<typeof fetch>()
let gateway: unknown = null
let gatewayError: string | undefined
let onboarding: Record<string, unknown> = {}
let writes: unknown[] = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/v1/workspace/model-gateway') return json({ presets: [], gateway, ...(gatewayError ? { error: gatewayError } : {}) })
    if (url.pathname === '/api/v1/workspace/ui-state') {
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)))
        return json({ onboarding: (JSON.parse(String(init.body)) as { onboarding: unknown }).onboarding })
      }
      return json({ onboarding })
    }
    return json({ error: 'not stubbed' }, 404)
  })
})

afterEach(() => {
  gateway = null
  gatewayError = undefined
  onboarding = {}
  writes = []
  cleanup()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
})

const renderPromo = (node: React.ReactNode = <ModelGatewayPromo />) =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectScopeContext.Provider value={{ projectId: null, apiBase: '/api/v1' }}>
        <MemoryRouter>
          {node}
        </MemoryRouter>
      </ProjectScopeContext.Provider>
    </QueryClientProvider>,
  )

describe('ModelGatewayPromo', () => {
  it('links to the gateway settings and remembers a close', async () => {
    renderPromo()
    const link = await screen.findByRole('link', { name: /Set it up/ })
    expect(link.getAttribute('href')).toContain('/settings/global/accounts#openmercato-gateway')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the model gateway note' }))
    await waitFor(() => expect(writes).toEqual([{ onboarding: { dismissedAnnouncements: [MODEL_GATEWAY_PROMO_ID] } }]))
    expect(document.querySelector('[data-slot="model-gateway-promo"]')).toBeNull()
  })

  it.each([
    ['once closed', () => { onboarding = { dismissedAnnouncements: [MODEL_GATEWAY_PROMO_ID] } }],
    ['once a gateway is saved', () => { gateway = { preset: 'openmercato', name: 'OpenMercato Gateway', baseUrl: 'https://eu.ai-gateway.openmercatocloud.com/v1', models: ['anthropic/claude-sonnet'], updatedAt: 'now' } }],
    ['while a stored gateway cannot be read', () => { gatewayError = 'cannot be read' }],
  ])('says nothing %s', async (_name, arrange) => {
    arrange()
    renderPromo()
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/model-gateway'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-slot="model-gateway-promo"]')).toBeNull()
  })
})

describe('GatewayHint', () => {
  it('stays under the welcome composer even after the header strip was closed', async () => {
    onboarding = { dismissedAnnouncements: [MODEL_GATEWAY_PROMO_ID, 'model-gateway-2026-11'] }
    renderPromo(<GatewayHint />)
    const link = await screen.findByRole('link', { name: /Add your key/ })
    expect(link.getAttribute('href')).toContain('/settings/global/accounts#openmercato-gateway')
  })

  it('goes once a gateway is saved', async () => {
    gateway = { preset: 'custom', name: 'Acme', baseUrl: 'https://api.acme.example/v1', models: ['m'], updatedAt: 'now' }
    renderPromo(<GatewayHint />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-slot="gateway-hint"]')).toBeNull()
  })
})
