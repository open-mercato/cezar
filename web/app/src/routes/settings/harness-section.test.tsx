import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { HarnessStatusResponse } from '@/api/types'

import { HarnessSection } from './harness-section'

/**
 * Settings → Harness (spec 2026-07-23-harness-orchestration; user feedback
 * 2026-07-23: "i don't see option to check and configure access to different
 * models"): the model-access surface. Shows the roster from
 * `GET /api/harness/status`, marks which profiles this cezar drives, and
 * routes configuration to a `cez-setup-harness` task — cezar reads the
 * om pipeline's config, it never writes it.
 */

function serve(status: HarnessStatusResponse) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/harness/status')) {
        return new Response(JSON.stringify(status), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
}

function mount() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={createQueryClient()}>
        <HarnessSection />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The normal packaged answer: the vendored collection is present and pinned. */
const BUNDLED_RUNTIME = { installed: true, source: 'bundled' as const, commit: 'a'.repeat(40) }

describe('Settings → Harness', () => {
  it('renders the model roster with bindings and roles', async () => {
    serve({
      configured: true,
      profiles: ['standard', 'multi'],
      driven: ['standard'],
      runtime: BUNDLED_RUNTIME,
      models: [
        { id: 'claude', family: 'anthropic', model: 'host app', roles: ['host', 'reviewer'], profiles: ['standard', 'multi'] },
        { id: 'codex', family: 'openai', model: 'gpt-5.6-sol', roles: ['worker', 'reviewer'], profiles: ['multi'] },
      ],
    })
    mount()
    await waitFor(() => expect(screen.getByText('codex')).toBeTruthy())
    expect(screen.getByText('claude')).toBeTruthy()
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy()
    expect(screen.getAllByText('reviewer').length).toBeGreaterThan(0)
  })

  it('says plainly when no external models are configured', async () => {
    serve({
      configured: false,
      profiles: ['standard'],
      driven: ['standard'],
      runtime: BUNDLED_RUNTIME,
      models: [{ id: 'claude', family: 'anthropic', model: 'host app', roles: ['host', 'reviewer'], profiles: ['standard'] }],
    })
    mount()
    await waitFor(() => expect(screen.getByText(/no external models configured/i)).toBeTruthy())
    // standard still works with zero config — the section must say so.
    expect(screen.getByText(/needs no provider config/i)).toBeTruthy()
  })

  it('offers configure and check actions that prefill a cez-setup-harness task', async () => {
    serve({
      configured: false,
      profiles: ['standard'],
      driven: ['standard'],
      runtime: BUNDLED_RUNTIME,
      models: [{ id: 'claude', roles: ['host', 'reviewer'], profiles: ['standard'] }],
    })
    mount()
    await waitFor(() => expect(screen.getByRole('link', { name: /configure models/i })).toBeTruthy())
    const configure = screen.getByRole('link', { name: /configure models/i })
    expect(configure.getAttribute('href')).toContain('skill=cez-setup-harness')
    const check = screen.getByRole('link', { name: /check setup/i })
    expect(check.getAttribute('href')).toContain('cez-setup-harness')
    expect(decodeURIComponent(check.getAttribute('href') ?? '')).toContain('--check')
  })
})
