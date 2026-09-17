import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { AutomationTemplatesResponse } from '@open-mercato/cezar-api-client'

import { TemplatePalette } from './template-palette'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function stubTemplates(payload: AutomationTemplatesResponse): string[] {
  const paths: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input)
    paths.push(path)
    if (path === '/api/v1/workspace/automation-templates') return jsonResponse(payload)
    return jsonResponse({ error: `unmocked ${path}` }, 404)
  }))
  return paths
}

function renderPalette(onPick = vi.fn()) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/automations/new']}>
        <TemplatePalette onPick={onPick} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return onPick
}

describe('TemplatePalette', () => {
  it('lists the six built-ins and hands the picked one over', () => {
    const paths = stubTemplates({ templates: [] })
    const onPick = renderPalette()
    expect(screen.getAllByRole('button', { name: /^Use this:/ })).toHaveLength(6)
    expect(screen.getByText('Every day at 04:00')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use this: Flaky test hunt' }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Flaky test hunt',
      kind: 'schedule',
      schedule: { type: 'weekly', day: 2, hour: 2, minute: 0 },
      dispatch: { maxSubtasks: 8, reviewChild: true },
    }))
    // The other-projects list is not fetched until its tab opens.
    expect(paths).not.toContain('/api/v1/workspace/automation-templates')
  })

  it('loads the other projects lazily and shows the empty state', async () => {
    const paths = stubTemplates({ templates: [] })
    renderPalette()
    fireEvent.click(screen.getByRole('tab', { name: 'From your other projects' }))
    await waitFor(() => expect(screen.getByText('No automations in your other projects yet.')).not.toBeNull())
    expect(paths).toContain('/api/v1/workspace/automation-templates')
    expect(screen.getByText('Registered in ~/.cezar/config.json')).not.toBeNull()
  })

  it('renders another project\'s automation with its project chip and trigger', async () => {
    stubTemplates({
      templates: [{
        project: { id: 'p2', name: 'shop' },
        id: 'x1',
        name: 'Sweep failed CI',
        kind: 'github',
        events: ['pull_request.opened'],
        intervalSeconds: 600,
        task: { prompt: 'Look at {{github.url}}', runner: 'codex' },
      }],
    })
    const onPick = renderPalette()
    fireEvent.click(screen.getByRole('tab', { name: 'From your other projects' }))
    await waitFor(() => expect(screen.getByText('Sweep failed CI')).not.toBeNull())
    expect(screen.getByText('shop').getAttribute('data-slot')).toBe('branch-chip')
    expect(screen.getByText('on pull_request.opened · every 10 min')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use this: Sweep failed CI' }))
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ kind: 'github', events: ['pull_request.opened'], intervalSeconds: 600, runner: 'codex' }))
  })
})
