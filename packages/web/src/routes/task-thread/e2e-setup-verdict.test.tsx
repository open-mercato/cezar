import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiRun, E2eStatus } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { E2eSetupVerdict } from './e2e-setup-verdict'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const step = (id: string, name: string, kind: 'agent' | 'check', status: string) => ({ id, name, kind, status, iterations: 1, tokensUsed: 0 })

function run(status: ApiRun['status'], over: Partial<ApiRun> = {}): ApiRun {
  return {
    id: 'run-1', workflow: 'e2e-setup', status, branch: 'cez/abcd1234', title: 't', task: 't',
    createdAt: '2026-10-10T00:00:00Z', updatedAt: '2026-10-10T00:00:00Z',
    steps: [step('setup', 'Set up e2e', 'agent', 'done'), step('e2e-list', 'e2e config loads', 'check', 'done'), step('e2e-smoke', 'e2e smoke test', 'check', 'done')],
    ...over,
  } as unknown as ApiRun
}

function show(r: ApiRun, configFile: string | null = null) {
  const status: E2eStatus = { configFile, workflow: Boolean(configFile), credentials: [], setup: { runId: r.id, status: r.status } }
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(status), { status: 200 })))
  render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><E2eSetupVerdict run={r} /></MemoryRouter></QueryClientProvider>)
}

describe('e2e setup verdict', () => {
  it('says e2e works and names the branch left to merge', async () => {
    show(run('done'))
    expect(screen.getByText('e2e works')).toBeTruthy()
    expect(screen.getByText('cez/abcd1234')).toBeTruthy()
    expect(document.querySelector('[data-slot="e2e-setup-verdict"]')?.getAttribute('data-verdict')).toBe('works')
  })

  it('says it is live once the config is in the checkout', async () => {
    show(run('review'), 'e2e.config.ts')
    await screen.findByText(/It is live in this project/)
  })

  it('says it does not work yet and which check failed', () => {
    show(run('failed', { steps: [step('setup', 'Set up e2e', 'agent', 'done'), step('e2e-list', 'e2e config loads', 'check', 'done'), step('e2e-smoke', 'e2e smoke test', 'check', 'failed')] } as Partial<ApiRun>))
    expect(screen.getByText('e2e is not working yet')).toBeTruthy()
    expect(screen.getByText(/“e2e smoke test” did not pass/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Settings → End-to-end tests' })).toBeTruthy()
  })

  it('says a cancelled setup left e2e unset', () => {
    show(run('cancelled'))
    expect(screen.getByText(/the setup was cancelled/)).toBeTruthy()
  })

  it('stays out of other runs and of runs still in flight', () => {
    show(run('done', { workflow: 'quick-task' }))
    show(run('running'))
    expect(document.querySelector('[data-slot="e2e-setup-verdict"]')).toBeNull()
  })
})
