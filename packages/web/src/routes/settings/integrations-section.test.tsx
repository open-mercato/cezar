import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('External integrations', () => {
  it('opens on the Test frameworks tab with the TesterArmy e2e card', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ configFile: null, workflow: false, credentials: [], setup: null }), { status: 200 })))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByRole('tab', { name: 'Test frameworks' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
  })
})
