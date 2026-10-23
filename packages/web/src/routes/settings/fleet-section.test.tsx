import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { FleetSection, isNodeStale } from './fleet-section'
import { visibleSettingsSections } from './registry'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const NOW = new Date().toISOString()
const OLD = new Date(Date.now() - 120_000).toISOString()
const job = (over: object) => ({
  id: 'j1', repoUrl: 'https://example.com/a/b', task: 'fix it', openPr: true, status: 'running', attempts: 0, createdAt: NOW, updatedAt: NOW, ...over,
})

function setup(panel: object) {
  const calls: { method: string; url: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ method, url: String(input) })
    if (method === 'POST') return new Response(JSON.stringify(job({ status: 'cancelled' })), { status: 200 })
    return new Response(JSON.stringify(panel), { status: 200 })
  }))
  render(<QueryClientProvider client={createQueryClient()}><FleetSection /></QueryClientProvider>)
  return calls
}

describe('Fleet settings section', () => {
  it('lists nodes (capacity, stale) and jobs (status, node, branch, PR, error)', async () => {
    setup({
      enabled: true, role: 'hub', nodeId: 'hub',
      nodes: [
        { nodeId: 'hub', lastSeen: NOW, capacity: { free: 1, max: 2 }, host: { cpuPct: 12 }, version: '1.0' },
        { nodeId: 'w9', lastSeen: OLD, capacity: { free: 0, max: 2 }, host: {}, version: '1.0' },
      ],
      jobs: [
        job({ id: 'a', status: 'done', nodeId: 'hub', branch: 'cez/x', prUrl: 'https://example.com/a/b/pull/3' }),
        job({ id: 'b', status: 'failed', error: 'clone failed' }),
        job({ id: 'c', status: 'done', branchUrl: 'https://example.org/g/r/-/tree/cez/y' }),
      ],
    })
    await screen.findByText('1/2 free')
    expect(screen.getAllByText('stale')).toHaveLength(1)
    expect(screen.getByText('cpu 12%')).toBeTruthy()
    expect(screen.getByText('cez/x')).toBeTruthy()
    expect(screen.getByText('PR').getAttribute('href')).toBe('https://example.com/a/b/pull/3')
    expect(screen.getByText('branch').getAttribute('href')).toBe('https://example.org/g/r/-/tree/cez/y')
    expect(screen.getByText('clone failed')).toBeTruthy()
    // Finished jobs have no cancel button.
    expect(screen.queryAllByRole('button', { name: 'Cancel' })).toHaveLength(0)
  })

  it('cancels a running job through the workspace route', async () => {
    const calls = setup({ enabled: true, role: 'worker', nodeId: 'w1', nodes: [], jobs: [job({ id: 'run-1' })] })
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/workspace/fleet/jobs/run-1/cancel'))).toBe(true))
  })

  it('shows the hub error when a worker cannot reach it', async () => {
    setup({ enabled: true, role: 'worker', nodeId: 'w1', nodes: [], jobs: [], error: 'hub answered 502' })
    expect((await screen.findByRole('alert')).textContent).toContain('hub answered 502')
  })

  it('says fleet is off when it is not enabled', async () => {
    setup({ enabled: false, nodes: [], jobs: [] })
    await screen.findByText(/Fleet coordination is off/)
  })
})

describe('isNodeStale', () => {
  it('flips after the hub liveness window', () => {
    expect(isNodeStale({ lastSeen: NOW })).toBe(false)
    expect(isNodeStale({ lastSeen: OLD })).toBe(true)
  })
})

describe('Fleet nav gate', () => {
  it('lists the Fleet section only when a fleet role is configured', () => {
    expect(visibleSettingsSections('global').some((s) => s.id === 'fleet')).toBe(false)
    expect(visibleSettingsSections('global', { fleet: false }).some((s) => s.id === 'fleet')).toBe(false)
    expect(visibleSettingsSections('global', { fleet: true }).some((s) => s.id === 'fleet')).toBe(true)
    expect(visibleSettingsSections('project', { fleet: true }).some((s) => s.id === 'fleet')).toBe(false)
  })
})
