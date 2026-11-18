import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ChatNotificationWizard } from './chat-notification-wizard'
const api = vi.hoisted(() => ({ create: vi.fn(), test: vi.fn(), deliveries: vi.fn(), list: vi.fn(), activate: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
const receiver = { id: 'r1', name: 'Discord notifications', format: 'discord.v1', state: 'inactive', revision: 1, deliveryRevision: 1, profile: 'minimal', lastTest: 'never', activationBlocked: false }
beforeEach(() => {
  vi.resetAllMocks()
  api.create.mockResolvedValue({ receiver })
  api.test.mockResolvedValue({ deliveryId: 'test1' })
  api.activate.mockResolvedValue({})
  api.list.mockResolvedValue({ receivers: [receiver] })
})
afterEach(cleanup)
function mount(status = 'delivered', overrides = {}) {
  api.deliveries.mockResolvedValue({ receiver: { ...receiver, kind: 'live', revision: 2, lastTest: 'success', ...overrides }, items: [{ deliveryId: 'test1', status }] })
  const client = createQueryClient(); client.setDefaultOptions({ queries: { retry: false } })
  const view = render(<QueryClientProvider client={client}><ChatNotificationWizard projectId="alpha" provider={{ name: 'Discord', format: 'discord.v1', webhookNotifications: { instructions: 'Paste the channel webhook URL below.' } }} onClose={vi.fn()} /></QueryClientProvider>)
  fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send test and continue' }))
  return view
}
it('creates once, automatically tests, and activates only after confirmed delivery', async () => {
  mount()
  const activate = await screen.findByRole('button', { name: 'Activate notifications' })
  await waitFor(() => expect(activate).toHaveProperty('disabled', false))
  expect(api.create).toHaveBeenCalledTimes(1)
  expect(api.test).toHaveBeenCalledWith('alpha', 'r1', expect.objectContaining({ expectedRevision: 1, deliveryRevision: 1 }))
  expect(api.activate).not.toHaveBeenCalled()
  fireEvent.click(activate)
  expect(await screen.findByText(/Sending: verified by a delivered test/)).toBeTruthy()
  expect(api.activate).toHaveBeenCalledWith('alpha', 'r1', 2)
})
it.each(['pending', 'failed', 'cancelled'])('does not activate a %s test', async status => {
  mount(status)
  expect(await screen.findByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
  expect(api.activate).not.toHaveBeenCalled()
})
it('rejects delivery success for changed connection settings', async () => {
  mount('delivered', { deliveryRevision: 2 })
  expect(await screen.findByText(/Connection settings changed/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
})
it('retries testing a saved connection without creating it again', async () => {
  api.test.mockRejectedValueOnce(new Error('network'))
  mount()
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Send another test' }))
  await waitFor(() => expect(api.test).toHaveBeenCalledTimes(2))
  expect(api.create).toHaveBeenCalledTimes(1)
})
it('does not send a test after navigating away during creation', async () => {
  let resolve!: (value: unknown) => void
  api.create.mockImplementation(() => new Promise(done => { resolve = done }))
  const view = mount(); view.unmount(); resolve({ receiver })
  await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1))
  expect(api.test).not.toHaveBeenCalled()
})
it('shows the server reason a step failed, not only a generic hint', async () => {
  api.create.mockRejectedValueOnce(new Error('Webhook URL must use https'))
  mount()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('Webhook URL must use https')
  expect(alert.textContent).toContain('Check the URL or retry the test')
})
