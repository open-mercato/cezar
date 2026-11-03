import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/client'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const api = vi.hoisted(() => ({ list: vi.fn(), deliveries: vi.fn(), activity: vi.fn(), test: vi.fn() }))
vi.mock('@/api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('@/api/client')>(), webhookApi: api, getSelfUpdate: async () => ({ version: 'dev', installKind: 'checkout' }) }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
const receiver = { kind: 'live', id: 'r', name: 'Alerts', destination: 'https://example.com/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
function Location() { const navigate = useNavigate(); return <><output data-testid="location">{useLocation().search}</output><button onClick={() => void navigate(-1)}>Browser back</button></> }
function mount(search: string) { render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/p/alpha/settings/webhooks'+search]}><WebhooksSection /><Location /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
 vi.stubGlobal('EventSource', undefined)
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
 api.deliveries.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 api.activity.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('opens the requested Activity tab and updates the URL on tab change and close', async () => {
 mount('?endpoint=r&tab=activity')
 const tab = await screen.findByRole('tab', { name: 'Activity' })
 expect(tab.getAttribute('aria-selected')).toBe('true')
 fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deliveries' }), { button: 0, ctrlKey: false })
 await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=deliveries'))
 fireEvent.click(screen.getByRole('button', { name: 'Close' }))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(''))
})
it('opens settings from a receiver deep link', async () => {
 mount('?endpoint=r&tab=settings')
 expect(await screen.findByRole('dialog')).toBeTruthy()
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alerts')
})
it('resolves retained receiver history directly even outside the initial history page', async () => {
 const old = { kind: 'history', id: 'old', name: 'Old receiver', deletedAt: '2026-10-13T12:00:00Z' }
 api.deliveries.mockResolvedValue({ receiver: old, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 mount('?endpoint=old&tab=deliveries')
 expect(await screen.findByText('Old receiver — history')).toBeTruthy()
 expect(api.deliveries).toHaveBeenCalledWith('alpha', 'old')
})

it('tracks each explicit test result separately without claiming recovery from HTTP alone', async () => {
 api.test.mockResolvedValueOnce({ deliveryId: 'test-one' }).mockResolvedValueOnce({ deliveryId: 'test-two' })
 api.deliveries.mockResolvedValue({ receiver: { ...receiver, state: 'paused' }, items: [{ deliveryId: 'test-one', status: 'delivered' }, { deliveryId: 'test-two', status: 'delivered' }], total: 2, hasMore: false, timezone: 'UTC' })
 mount('')
 fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(document.querySelector('[data-test-delivery]')?.getAttribute('data-test-delivery')).toBe('test-one'))
 expect(await screen.findByText(/Test delivered\. Resume the receiver/)).toBeTruthy()
 await waitFor(() => expect(screen.getByRole('button', { name: 'Send test' }).hasAttribute('disabled')).toBe(false))
 fireEvent.click(screen.getByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(document.querySelector('[data-test-delivery]')?.getAttribute('data-test-delivery')).toBe('test-two'))
 expect(document.querySelector('[data-test-delivery="test-one"]')).toBeNull()
 expect(api.test).toHaveBeenCalledTimes(2)
})

it('identifies a deleted notice target and opens its retained Activity directly', async () => {
 const old = { kind: 'history', id: 'old', name: 'Deleted alerts', deletedAt: '2026-10-13T12:00:00Z' }
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 1, changeSequence: 7, webhookHealth: { status: 'ready' }, notice: { changeSequence: 7, at: old.deletedAt, action: 'deleted', receiverId: 'old', receiverName: old.name, destination: 'https://old.example/…', source: 'cockpit/api' } })
 api.activity.mockResolvedValue({ receiver: old, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 mount('')
 expect(await screen.findByText(/https:\/\/old.example/)).toBeTruthy()
 expect(screen.getByText(/via cockpit or API/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: 'View activity' }))
 expect(await screen.findByText('Deleted alerts — history')).toBeTruthy()
 expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true')
})
it('explains payload expiry separately from retry deadline and task deletion', async () => {
 api.deliveries.mockResolvedValue({ receiver, items: [{ deliveryId: 'd', eventId: 'event', receiverId: 'r', deliveryRevision: 1, eventType: 'task.finished', status: 'delivered', taskId: 'task', taskAvailability: 'deleted', createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-04T12:00:00Z', attempts: 1, destination: receiver.destination, payloadAvailability: 'expired', payloadRetainedUntil: '2026-10-08T12:00:00Z', historyRetainedUntil: '2026-10-31T12:00:00Z', retryAllowed: false, replayAllowed: false, replayUnavailableReason: 'payload_expired' }], total: 1, hasMore: false, timezone: 'UTC' })
 mount('?endpoint=r&tab=deliveries')
 fireEvent.click(await screen.findByRole('button', { name: /Task finished/ }))
 expect(screen.getByText(/\(deleted\)/)).toBeTruthy()
 expect(screen.getByText(/Replay unavailable: the payload is no longer kept/)).toBeTruthy()
 expect(screen.getByText('Payload kept until')).toBeTruthy()
 expect(screen.getByText('Retries until')).toBeTruthy()
})

it('links an available task inside the active project', async () => {
 api.deliveries.mockResolvedValue({ receiver, items: [{ deliveryId: 'available', eventType: 'task.finished', status: 'delivered', taskId: 'task-123', taskAvailability: 'available', createdAt: '2026-10-13T12:00:00Z', attempts: 1 }], total: 1, hasMore: false, timezone: 'UTC' })
 mount('?endpoint=r&tab=deliveries')
 expect(await screen.findByText(/task task-123/)).toBeTruthy()
 expect(screen.getByText(/Showing 1–1 of 1/)).toBeTruthy()
 fireEvent.click(await screen.findByRole('button', { name: /Task finished/ }))
 expect(screen.getByRole('link', { name: 'task-123' }).getAttribute('href')).toBe('/p/alpha/tasks/task-123')
})
it('renders the Result filter at the same control height as Task ID and Find', async () => {
 mount('?endpoint=r&tab=deliveries')
 // A native <select> renders as a shorter system control in the macOS WebView.
 const filter = await screen.findByRole('combobox', { name: 'Result' })
 expect(filter.tagName).toBe('BUTTON')
 expect(filter.getAttribute('data-size')).toBe('default')
 expect(filter.textContent).toContain('All results')
})
it('restores the selected history tab on browser back', async () => {
 mount('?endpoint=r&tab=activity')
 await screen.findByRole('tab', { name: 'Activity' })
 fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deliveries' }), { button: 0, ctrlKey: false })
 await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=deliveries'))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true'))
})
it('explains an invalid tab without fetching receiver history', async () => {
 mount('?endpoint=r&tab=invalid')
 expect(await screen.findByText('This receiver link is invalid.')).toBeTruthy()
 expect(api.deliveries).not.toHaveBeenCalled()
 expect(api.activity).not.toHaveBeenCalled()
})
it('explains a missing retained receiver without opening another receiver', async () => {
 api.deliveries.mockRejectedValue(new ApiError(404, 'Not found'))
 mount('?endpoint=missing&tab=deliveries')
 expect(await screen.findByText('This receiver’s history is unavailable or no longer kept.')).toBeTruthy()
 expect(screen.queryByRole('tab', { name: 'Deliveries' })).toBeNull()
})

it('creates one browser history entry for a mouse press followed by tab focus', async () => {
 mount('?endpoint=r&tab=activity')
 const tab = await screen.findByRole('tab', { name: 'Deliveries' })
 act(() => { fireEvent.mouseDown(tab, { button: 0, ctrlKey: false }); fireEvent.focus(tab) })
 await waitFor(() => expect(screen.getByRole('tab', { name: 'Deliveries' }).getAttribute('aria-selected')).toBe('true'))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true'))
})

it('retires an actionable confirmation when Back reopens receiver history', async () => {
 mount('')
 fireEvent.click(await screen.findByRole('button', { name: 'History' }))
 fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
 fireEvent.click(await screen.findByRole('button', { name: 'Pause' }))
 expect(await screen.findByRole('heading', { name: 'Pause Alerts?' })).toBeTruthy()
 fireEvent.click(screen.getByText('Browser back'))
 await screen.findByRole('heading', { name: 'Alerts — history' })
 fireEvent.keyDown(screen.getByRole('dialog', { name: 'Alerts — history' }), { key: 'Escape' })
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
})

it.each(['Escape', 'Close'])('returns focus to the History trigger after %s dismissal', async dismissal => {
 mount('')
 const trigger = await screen.findByRole('button', { name: 'History' })
 act(() => trigger.focus())
 fireEvent.click(trigger)
 const dialog = await screen.findByRole('dialog', { name: 'Alerts — history' })
 if (dismissal === 'Escape') fireEvent.keyDown(dialog, { key: 'Escape' })
 else fireEvent.click(screen.getByRole('button', { name: 'Close' }))
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 await waitFor(() => expect(document.activeElement).toBe(trigger))
})

it('retires an Add draft when Back reopens history', async () => {
 mount('')
 fireEvent.click(await screen.findByRole('button', { name: 'History' }))
 fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
 fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
 fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Abandoned draft' } })
 fireEvent.click(screen.getByText('Browser back'))
 await screen.findByRole('heading', { name: 'Alerts — history' })
 expect(screen.queryByLabelText('Name')).toBeNull()
 fireEvent.keyDown(screen.getByRole('dialog', { name: 'Alerts — history' }), { key: 'Escape' })
 await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
 fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('')
})
