import { ProjectWebhookNotifications } from '@/hooks/use-webhook-toasts'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'
import { WebhooksSection } from './webhooks-section'
const api = vi.hoisted(() => ({ project: 'alpha', list: vi.fn(), test: vi.fn(), deliveries: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => api.project }))
vi.mock('@/api/client', () => ({ webhookApi: api, getSelfUpdate: async () => ({ version: '0.15.0', installKind: 'npx' }) }))
const receiver = { kind: 'live', id: 'r', name: 'Ops alerts', destination: 'https://example.com/PRIVATE_URL', state: 'inactive', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
const snapshot = (state = 'inactive', dropped = 0) => ({ receivers: [{ ...receiver, state }], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready', saturation: { pending: false, retained: false, control: false, dropped } } })
function Back() { const navigate = useNavigate(); return <button onClick={() => void navigate(-1)}>Browser back</button> }
function mount() {
 const client = createQueryClient()
 const tree = () => <QueryClientProvider client={client}><MemoryRouter><ProjectWebhookNotifications key={api.project} projectId={api.project} /><WebhooksSection /><Back /><Toaster /></MemoryRouter></QueryClientProvider>
 const view = render(tree())
 return { client, ...view, switchProject: () => { api.project = 'beta'; view.rerender(tree()) } }
}
function messages() { return [...document.querySelectorAll('[data-slot="toast"]')].map(node => node.textContent) }
beforeEach(() => { api.project = 'alpha'; api.list.mockResolvedValue(snapshot()); vi.stubGlobal('EventSource', undefined) })
afterEach(() => { cleanup(); resetToasts(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('toasts live activation, disabled and queue-drop transitions once, with a silent initial snapshot', async () => {
 const { client } = mount(); await screen.findByText('Ops alerts'); expect(messages()).toEqual([])
 act(() => client.setQueryData(['alpha', 'webhooks'], snapshot('active')))
 await waitFor(() => expect(messages()).toEqual(['Ops alerts is now active']))
 act(() => client.setQueryData(['alpha', 'webhooks'], snapshot('active')))
 expect(messages()).toHaveLength(1)
 act(() => client.setQueryData(['alpha', 'webhooks'], snapshot('disabled', 3)))
 await waitFor(() => expect(messages()).toHaveLength(3))
 expect(messages().join(' ')).toContain('Ops alerts was disabled — open it to repair and test')
 expect(messages().join(' ')).toContain('3 webhook deliveries were dropped — webhook storage capacity was exceeded')
 expect(messages().join(' ')).not.toMatch(/PRIVATE/)
 act(() => client.setQueryData(['alpha', 'webhooks'], snapshot('disabled', 3)))
 expect(messages()).toHaveLength(3)
 // Counter reset establishes a fresh baseline, without replaying old drops.
 await act(async () => { client.setQueryData(['alpha', 'webhooks'], snapshot('disabled', 0)); await new Promise(resolve => setTimeout(resolve, 10)) })
 act(() => client.setQueryData(['alpha', 'webhooks'], snapshot('disabled', 1)))
 await waitFor(() => expect(messages()).toHaveLength(4))
})
it('does not announce old project snapshots or late operations after switching projects', async () => {
 let resolve!: (value: { deliveryId: string }) => void
 api.test.mockImplementation(() => new Promise(r => { resolve = r }))
 const view = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 view.switchProject(); await screen.findByText('Ops alerts')
 await act(async () => { resolve({ deliveryId: 'old-test' }); await Promise.resolve() })
 act(() => view.client.setQueryData(['alpha', 'webhooks'], snapshot('active', 8)))
 expect(messages()).toEqual([]); expect(api.deliveries).not.toHaveBeenCalled()
 act(() => view.client.setQueryData(['beta', 'webhooks'], snapshot('active')))
 await waitFor(() => expect(messages()).toEqual(['Ops alerts is now active']))
 view.unmount(); act(() => view.client.setQueryData(['beta', 'webhooks'], snapshot('disabled', 9)))
})
it('announces each explicit test terminal result once without response text or recovery claims', async () => {
 api.test.mockResolvedValue({ deliveryId: 'test-one' })
 api.deliveries.mockResolvedValue({ receiver: { ...receiver, state: 'active' }, items: [{ deliveryId: 'test-one', status: 'pending' }] })
 const { client } = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await screen.findByText('Test sent — waiting for the result…')
 expect(messages()).toEqual([])
 const result = { receiver: { ...receiver, state: 'active' }, items: [{ deliveryId: 'test-one', status: 'delivered', response: 'PRIVATE_RESPONSE' }] }
 act(() => client.setQueryData(['alpha', 'webhooks', 'test-result', 'r', 'test-one'], result))
 await waitFor(() => expect(messages()).toEqual(['Test delivered to Ops alerts']))
 act(() => client.setQueryData(['alpha', 'webhooks', 'test-result', 'r', 'test-one'], { ...result, total: 1 }))
 expect(messages()).toHaveLength(1)
 expect(messages().join(' ')).not.toMatch(/PRIVATE|recover/i)
 expect(screen.getByText('Test delivered.')).toBeTruthy()
})
it('suppresses a late test delivery result after unmount', async () => {
 let resolve!: (value: unknown) => void
 api.test.mockResolvedValue({ deliveryId: 'test-one' })
 api.deliveries.mockImplementation(() => new Promise(r => { resolve = r }))
 const view = mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(api.deliveries).toHaveBeenCalled())
 view.unmount()
 await act(async () => { resolve({ receiver, items: [{ deliveryId: 'test-one', status: 'failed' }] }); await Promise.resolve() })
 render(<Toaster />); expect(messages()).toEqual([])
})

it('keeps the single project event subscription while snapshots and explicit test results update', async () => {
 class Stream extends EventTarget {
  static opened: Stream[] = []
  close = vi.fn()
  constructor(readonly url: string) { super(); Stream.opened.push(this) }
 }
 vi.stubGlobal('EventSource', Stream)
 api.test.mockResolvedValue({ deliveryId: 'test-one' })
 api.deliveries.mockResolvedValue({ receiver, items: [{ deliveryId: 'test-one', status: 'delivered' }] })
 const view = mount(); await screen.findByText('Ops alerts')
 act(() => view.client.setQueryData(['alpha', 'webhooks'], snapshot('active')))
 await waitFor(() => expect(messages()).toHaveLength(1))
 fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(messages()).toHaveLength(2))
 expect(Stream.opened).toHaveLength(1)
 expect(Stream.opened[0]!.url).toContain('/p/alpha/webhooks/events')
 expect(api.deliveries).toHaveBeenCalledTimes(1)
 view.switchProject(); await waitFor(() => expect(Stream.opened).toHaveLength(2))
 expect(Stream.opened[0]!.close).toHaveBeenCalledTimes(1)
 view.unmount(); expect(Stream.opened[1]!.close).toHaveBeenCalledTimes(1)
})
it('does not toast a late terminal result after leaving the test view for history', async () => {
 let resolve!: (value: unknown) => void
 const pending = new Promise(r => { resolve = r })
 api.test.mockResolvedValue({ deliveryId: 'test-one' })
 api.deliveries.mockReturnValue(pending)
 mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await screen.findByText('Test sent — waiting for the result…')
 fireEvent.click(screen.getByRole('button', { name: 'History' }))
 await screen.findByRole('tab', { name: 'Deliveries' })
 await act(async () => {
  resolve({ receiver, items: [{ deliveryId: 'test-one', eventType: 'webhook.test', status: 'delivered', createdAt: '2026-10-13T12:00:00Z' }], total: 1, timezone: 'UTC' })
  await new Promise(r => setTimeout(r, 10))
 })
 expect(messages()).toEqual([])
 expect(document.querySelector('[data-test-delivery]')).toBeNull()
})

it('does not replay an already announced test when browser Back restores its original location key', async () => {
 api.test.mockResolvedValue({ deliveryId: 'test-one' })
 api.deliveries.mockResolvedValue({ receiver, items: [{ deliveryId: 'test-one', eventType: 'webhook.test', status: 'delivered', createdAt: '2026-10-13T12:00:00Z' }], total: 1, timezone: 'UTC' })
 mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(messages()).toHaveLength(1))
 fireEvent.click(screen.getByRole('button', { name: 'History' }))
 await screen.findByRole('tab', { name: 'Deliveries' })
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 expect(messages()).toHaveLength(1)
 expect(document.querySelector('[data-test-delivery]')).toBeNull()
})
