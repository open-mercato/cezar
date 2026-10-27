import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { RemoveProjectDialog } from './remove-project'
const mocks = vi.hoisted(() => ({ enabled: true, list: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: mocks.enabled } } }), useRemoveProject: vi.fn() }))
vi.mock('@/api/client', async importOriginal => ({ ...await importOriginal<typeof import('@/api/client')>(), webhookApi: { list: mocks.list } }))
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.enabled = true })
it('discloses affected receiver and delivery counts before project removal', async () => {
  mocks.list.mockResolvedValue({ receivers: [{ state: 'active', pendingCount: 3, inFlightCount: 1 }, { state: 'suspended', pendingCount: 2, inFlightCount: 0 }, { state: 'inactive', pendingCount: 0, inFlightCount: 0 }] })
  render(<QueryClientProvider client={createQueryClient()}><RemoveProjectDialog project={{ id: 'a', name: 'Alpha', root: '/tmp/alpha' } as never} onOpenChange={() => {}} onConfirm={() => {}} /></QueryClientProvider>)
  expect(await screen.findByText(/2 receivers will be paused/)).toBeTruthy()
  expect(screen.getByText(/5 pending deliveries/).textContent).toContain('1 in flight')
  expect(mocks.list).toHaveBeenCalledWith('a', expect.anything())
})
it('does not query webhook state while the removal dialog is closed', () => {
  render(<QueryClientProvider client={createQueryClient()}><RemoveProjectDialog project={null} onOpenChange={() => {}} onConfirm={() => {}} /></QueryClientProvider>)
  expect(mocks.list).not.toHaveBeenCalled()
})

it('uses singular receiver and pending delivery counts', async () => {
  mocks.list.mockResolvedValue({ receivers: [{ state: 'active', pendingCount: 1, inFlightCount: 0 }] })
  render(<QueryClientProvider client={createQueryClient()}><RemoveProjectDialog project={{ id: 'a', name: 'Alpha', root: '/missing' } as never} onOpenChange={() => {}} onConfirm={() => {}} /></QueryClientProvider>)
  expect(await screen.findByText(/1 receiver will be paused. 1 pending delivery will be cancelled/)).toBeTruthy()
})
it('does not attribute unavailable state to another cockpit when the root is missing', async () => {
  mocks.list.mockRejectedValue(Object.assign(new Error('Project root is missing'), { status: 409 }))
  render(<QueryClientProvider client={createQueryClient()}><RemoveProjectDialog project={{ id: 'a', name: 'Alpha', root: '/missing' } as never} onOpenChange={() => {}} onConfirm={() => {}} /></QueryClientProvider>)
  expect(await screen.findByText(/Webhook state is unavailable/)).toBeTruthy()
  expect(screen.queryByText(/Another cockpit/)).toBeNull()
})
