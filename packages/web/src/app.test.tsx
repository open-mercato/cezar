import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { HealthResponse } from '@open-mercato/cezar-api-client'

import { App } from './app'

class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly readyState = 0
  closeCount = 0
  constructor() {
    FakeEventSource.instances.push(this)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closeCount += 1
  }
}

const HEALTH: HealthResponse = {
  version: '0.1.3',
  projects: [],
  bootProject: 'project-a',
  repoRoot: '/projects/project-a',
  repo: { root: '/projects/project-a', branch: 'main', remote: 'origin' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: {
    localHandoff: true,
    tokenMetrics: true,
    tokenUsageMetrics: true,
    costMetrics: true,
    followups: false,
    singleProject: true,
    automations: false,
  },
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  FakeEventSource.instances = []
  window.history.replaceState({}, '', '/p/project-a/new')
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/skills')) return response([])
    if (url.includes('/workflows')) return response({ workflows: [] })
    if (url.includes('/runs')) return response([])
    if (url.includes('/todos')) return response([])
    if (url.includes('/providers/status')) return response({ providers: [] })
    if (url.includes('/workspace/ui-state')) return response({})
    if (url.includes('/workspace/projects')) {
      return response({ projects: [], bootProject: 'project-a', projectsDir: '/projects' })
    }
    return response(HEALTH)
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps standalone Cezar on the public browser-routed cockpit facade', async () => {
  render(
    <StrictMode>
      <App apiBase="https://cezar.example" />
    </StrictMode>,
  )

  await waitFor(() => expect(document.querySelector('[data-route="new"]')).not.toBeNull())
  fireEvent.click(screen.getByRole('link', { name: 'Tasks' }))

  await waitFor(() => expect(window.location.pathname).toBe('/p/project-a/'))
  expect(FakeEventSource.instances.filter((source) => source.closeCount === 0)).toHaveLength(1)
})
