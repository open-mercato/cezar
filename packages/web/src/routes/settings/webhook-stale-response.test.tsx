import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/ui/toaster', () => ({ toast: notify }))
const api = vi.hoisted(() => ({ list: vi.fn(), deliveries: vi.fn(), activity: vi.fn(), test: vi.fn(), update: vi.fn(), rotate: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api, getSelfUpdate: async () => ({ version: 'dev', installKind: 'checkout' }) }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
const receiver = { kind: 'live', id: 'r', name: 'Alerts', destination: 'https://example.com/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
function Location() { const navigate = useNavigate(); return <><output data-testid="location">{useLocation().pathname+useLocation().search}</output><button onClick={() => void navigate("/p/beta/settings/webhooks?endpoint=b&tab=activity")}>Switch project</button><button onClick={() => void navigate(-1)}>Browser back</button><button onClick={() => void navigate(1)}>Browser forward</button></> }
function mount(search: string, destination: string) { render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={[destination, '/p/alpha/settings/webhooks'+search]}><WebhooksSection /><Location /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
 vi.stubGlobal('EventSource', undefined)
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
 api.deliveries.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 api.activity.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it.each(['/p/beta/settings/webhooks?endpoint=b&tab=activity', '/p/alpha/settings/webhooks?endpoint=r&tab=activity'])('keeps %s when an old edit response arrives', async destination => {
 let resolve!: (value: unknown) => void
 api.update.mockReturnValue(new Promise(r => { resolve = r }))
 mount('?endpoint=r&tab=settings', destination)
 await screen.findByRole('dialog')
 fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Changed'}})
 fireEvent.click(screen.getByRole('button', {name: 'Review changes'}))
 fireEvent.click(await screen.findByRole('button', {name: 'Confirm'}))
 await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(destination))
 await act(async () => { resolve({receiver}); await new Promise(r => setTimeout(r, 30)) })
 expect(screen.getByTestId('location').textContent).toBe(destination)
})

it.each([['error', 'alpha'], ['secret', 'alpha'], ['error', 'beta'], ['secret', 'beta']])('suppresses late %s after navigation to %s', async (outcome, project) => {
 let resolve!: (value: unknown) => void; let reject!: (error: Error) => void
 api.rotate.mockReturnValue(new Promise((yes, no) => { resolve=yes; reject=no }))
 mount('', '/p/'+project+'/settings/webhooks?endpoint=r&tab=activity')
 fireEvent.pointerDown(await screen.findByRole('button', { name: /More actions for/ }), { button: 0, ctrlKey: false }); fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotate key' }))
 fireEvent.click(await screen.findByRole('button', {name:'Confirm'}))
 await waitFor(() => expect(api.rotate).toHaveBeenCalled())
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=activity'))
 await act(async () => { if(outcome==='secret') resolve({receiver, secret:'PRIVATE_LATE_SECRET'}); else reject(new Error('PRIVATE_LATE_ERROR')); await new Promise(r=>setTimeout(r,30)) })
 expect(screen.queryByText('PRIVATE_LATE_SECRET')).toBeNull()
 expect(screen.queryByText('PRIVATE_LATE_ERROR')).toBeNull()
 expect(notify).not.toHaveBeenCalled()
})

it('does not revive an obsolete edit callback when Forward restores the original location key', async () => {
 let resolve!: (value: unknown) => void
 api.update.mockReturnValue(new Promise(r => { resolve = r }))
 const original='/p/alpha/settings/webhooks?endpoint=r&tab=settings'
 mount('?endpoint=r&tab=settings', '/p/alpha/settings/webhooks?endpoint=r&tab=activity')
 await screen.findByRole('dialog')
 fireEvent.change(screen.getByLabelText('Name'), {target:{value:'Old draft'}})
 fireEvent.click(screen.getByRole('button',{name:'Review changes'}))
 fireEvent.click(await screen.findByRole('button',{name:'Confirm'}))
 await waitFor(()=>expect(api.update).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(()=>expect(screen.getByTestId('location').textContent).toContain('tab=activity'))
 fireEvent.click(screen.getByText('Browser forward'))
 await waitFor(()=>expect(screen.getByTestId('location').textContent).toBe(original))
 await act(async()=>{resolve({receiver});await new Promise(r=>setTimeout(r,30))})
 expect(screen.getByTestId('location').textContent).toBe(original)
})

it('does not revive retired Test acceptance after History then Back', async () => {
 let resolve!: (value: unknown) => void
 api.test.mockReturnValue(new Promise(r => { resolve = r }))
 api.deliveries.mockResolvedValue({ receiver, items: [{ deliveryId: 'late-test', status: 'delivered' }], total: 1, hasMore: false, timezone: 'UTC' })
 mount('', '/p/alpha/settings/webhooks?endpoint=r&tab=activity')
 fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
 await waitFor(() => expect(api.test).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByRole('button', { name: 'History' }))
 await screen.findByRole('tab', { name: 'Deliveries' })
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/alpha/settings/webhooks'))
 await act(async () => { resolve({ deliveryId: 'late-test' }); await new Promise(r => setTimeout(r, 30)) })
 expect(screen.queryByText('Test late-test')).toBeNull()
 expect(notify).not.toHaveBeenCalled()
})
it.each(['secret', 'error'])('does not revive a late %s after Back and Forward', async outcome => {
 let resolve!: (value: unknown) => void; let reject!: (error: Error) => void
 api.rotate.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no }))
 mount('', '/p/alpha/settings/webhooks?endpoint=r&tab=activity')
 fireEvent.pointerDown(await screen.findByRole('button', { name: /More actions for/ }), { button: 0, ctrlKey: false }); fireEvent.click(await screen.findByRole('menuitem', { name: 'Rotate key' }))
 fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
 await waitFor(() => expect(api.rotate).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=activity'))
 fireEvent.click(screen.getByText('Browser forward'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/p/alpha/settings/webhooks'))
 await act(async () => { if (outcome === 'secret') resolve({ receiver, secret: 'SYNTHETIC_LATE_KEY' }); else reject(new Error('SYNTHETIC_LATE_ERROR')); await new Promise(r => setTimeout(r, 30)) })
 expect(screen.queryByText('SYNTHETIC_LATE_KEY')).toBeNull()
 expect(screen.queryByText('SYNTHETIC_LATE_ERROR')).toBeNull()
 expect(notify).not.toHaveBeenCalled()
})
