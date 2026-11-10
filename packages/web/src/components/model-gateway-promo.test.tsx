import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectScopeContext } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { MODEL_GATEWAY_PROMO_ID, ModelGatewayPromo } from '@/components/model-gateway-promo'

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

const renderPromo = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ProjectScopeContext.Provider value={{ projectId: null, apiBase: '/api/v1' }}>
        <MemoryRouter>
          <ModelGatewayPromo />
        </MemoryRouter>
      </ProjectScopeContext.Provider>
    </QueryClientProvider>,
  )

describe('ModelGatewayPromo', () => {
  it('links to the gateway settings and remembers a close', async () => {
    renderPromo()
    const link = await screen.findByRole('link', { name: /Set it up/ })
    expect(link.getAttribute('href')).toContain('/settings/agents#model-gateway')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss the model gateway note' }))
    await waitFor(() => expect(writes).toEqual([{ onboarding: { dismissedAnnouncements: [MODEL_GATEWAY_PROMO_ID] } }]))
    expect(document.querySelector('[data-slot="model-gateway-promo"]')).toBeNull()
  })

  it.each([
    ['once closed', () => { onboarding = { dismissedAnnouncements: [MODEL_GATEWAY_PROMO_ID] } }],
    ['once a gateway is saved', () => { gateway = { preset: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', models: [], updatedAt: 'now' } }],
    ['while a stored gateway cannot be read', () => { gatewayError = 'cannot be read' }],
  ])('says nothing %s', async (_name, arrange) => {
    arrange()
    renderPromo()
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/model-gateway'))).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(document.querySelector('[data-slot="model-gateway-promo"]')).toBeNull()
  })
})
