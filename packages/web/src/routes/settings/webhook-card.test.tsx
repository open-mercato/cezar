import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebhookCard } from './webhook-card'
const state = vi.hoisted(() => ({ server: { data: { capabilities: { webhooks: true, webhooksUnavailableReason: undefined as string | undefined } }, isError: false } as { data?: { capabilities: { webhooks: boolean; webhooksUnavailableReason?: string } }; isError: boolean }, receivers: [] as { state: string; pendingCount: number }[], health: { status: 'degraded', reason: 'Retained delivery storage is full' } }))
vi.mock('@/api/queries', () => ({ useHealth: () => state.server }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'alpha', Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/hooks/use-webhooks', () => ({ useWebhookSubscription: vi.fn(), useWebhookList: () => ({ data: { receivers: state.receivers, webhookHealth: state.health }, isPending: false }) }))
beforeEach(() => { state.server = { data: { capabilities: { webhooks: true } }, isError: false }; state.receivers = []; state.health = { status: 'degraded', reason: 'Retained delivery storage is full' } })
afterEach(cleanup)
it('shows service degradation even when no receivers are suspended', () => {
  render(<WebhookCard />)
  expect(screen.getByRole('status').textContent).toContain('Retained delivery storage is full')
})
it('clears current degradation once capacity recovers', () => {
  const view = render(<WebhookCard />)
  state.health = { status: 'ready', reason: '' }
  view.rerender(<WebhookCard />)
  expect(screen.queryByRole('status')).toBeNull()
})
it('does not tell an unsupported platform to enable delivery it cannot run', () => {
  state.server.data!.capabilities = { webhooks: false, webhooksUnavailableReason: 'unsupported_platform' }
  render(<WebhookCard />)
  expect(screen.getByText(/Not available on this server’s platform/)).toBeTruthy()
  expect(screen.queryByText(/Off on this server/)).toBeNull()
})

it('includes saved inactive receivers in the project summary', () => {
  state.receivers = [{ state: 'inactive', pendingCount: 0 }]
  render(<WebhookCard />)
  expect(screen.getByText('0 active · 0 paused · 1 inactive')).toBeTruthy()
})

it.each([false, true])('does not call unknown health disabled (error=%s)', isError => {
  state.server = { isError }
  render(<WebhookCard />)
  expect(screen.getByText(isError ? /Status unavailable/ : /Loading webhook status/)).toBeTruthy()
  expect(screen.queryByText('Off on this server.')).toBeNull()
})
