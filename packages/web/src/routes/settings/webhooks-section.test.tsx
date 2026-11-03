import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const mocks = vi.hoisted(() => ({ healthState: 'ready', enabled: false, unsupported: false, project: 'alpha', list: vi.fn(), create: vi.fn(), activity: vi.fn(), deliveries: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ isError: mocks.healthState === 'error', data: mocks.healthState === 'ready' ? { capabilities: { webhooks: mocks.enabled, webhooksUnavailableReason: mocks.unsupported ? 'unsupported_platform' : undefined } } : undefined }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => mocks.project }))
vi.mock('@/api/client', () => ({ getSelfUpdate: vi.fn().mockResolvedValue({ version: '0.15.0', installKind: 'checkout' }), webhookApi: { list: mocks.list, create: mocks.create, activity: mocks.activity, deliveries: mocks.deliveries } }))
beforeEach(() => { vi.stubGlobal('EventSource', undefined); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') })) })
afterEach(() => { vi.unstubAllGlobals(); cleanup(); vi.clearAllMocks(); mocks.healthState = 'ready'; mocks.enabled = false; mocks.unsupported = false; mocks.project = 'alpha' })
function mount(client = createQueryClient()) { return render(<QueryClientProvider client={client}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>) }
describe('project webhook settings', () => {

  it('explains unsupported platforms without an enable-flag remedy or receiver query', () => {
    mocks.unsupported = true
    mount()
    expect(screen.getByText(/aren’t available on this platform/i)).toBeTruthy()
    expect(screen.getByText(/Linux/)).toBeTruthy()
    expect(screen.queryByText(/CEZ_WEBHOOKS=1/)).toBeNull()
    expect(screen.queryByText(/How to enable/)).toBeNull()
    expect(mocks.list).not.toHaveBeenCalled()
  })
  it('summarizes the exact receiver settings and HTTP risk before activation', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [{ kind: 'live', id: 'r', name: 'Alerts', destination: 'http://example.com/[redacted]', state: 'inactive', revision: 1, profile: 'standard', preset: 'custom', events: ['task.failed'], scope: 'every_task', graceSeconds: 600, allowLocalNetwork: false, pendingCount: 0, lastTest: 'none' }], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Activate' }))
    const dialog = within(screen.getByRole('dialog'))
    for (const value of ['Alerts', 'http://example.com/[redacted]', 'alpha', 'Custom: Task failed', 'Every task', '10 minutes']) expect(dialog.getByText(value)).toBeTruthy()
    expect(dialog.getByText(/HTTP is unencrypted/)).toBeTruthy()
    expect(dialog.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true)
  })
  it('shows changed field names and revision in Activity', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [{ kind: 'live', id: 'r', name: 'Alerts', destination: 'https://example.com', state: 'active', revision: 2, lastTest: 'none', profile: 'minimal', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0 }], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.deliveries.mockResolvedValue({ items: [], total: 0 }); mocks.activity.mockResolvedValue({ items: [{ id: 'a', at: '2026-10-13T12:00:00Z', action: 'configuration_changed', source: 'cockpit/api', fields: ['url', 'profile'], revision: 2 }], total: 1 })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'History' })); fireEvent.mouseDown(screen.getByRole('tab', { name: 'Activity' }), { button: 0, ctrlKey: false })
    expect(await screen.findByText('Changed: url, profile')).toBeTruthy(); expect(screen.getByText(/revision 2/)).toBeTruthy()
  })
  it('explains opt-in in friendly language without creating a receiver query', async () => {
    mount(); expect(screen.getByText('Webhooks are off')).toBeTruthy()
    expect(screen.getByText(/CEZ_WEBHOOKS=1/)).toBeTruthy(); expect(mocks.list).not.toHaveBeenCalled()
  })
  it('offers full Custom selection and keeps destination secrets out of warnings', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mount(); await screen.findByText(/No receivers yet/); expect(screen.getByText(/Send a test, then activate it/)).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    expect(screen.getByText('Attention, review and results')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Events'), { target: { value: 'custom' } })
    expect(screen.getByLabelText('Task finished')).toBeTruthy(); expect(screen.getByLabelText('Task cancelled')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://hooks.slack.com/services/private-value' } })
    expect(screen.getByText(/This is a Slack webhook/)).toBeTruthy()
    expect(screen.getByRole('link', { name: 'How to build a receiver' }).getAttribute('href')).toBe('https://github.com/open-mercato/cezar/blob/main/packages/cezar/docs/webhooks.md#external-automation-receivers')
    expect(screen.getByLabelText('Allow a receiver on this computer or private network').closest('details')).toBeNull()
    expect(screen.getByText(/This is a Slack webhook/).textContent).not.toContain('private-value')
  })
  it.each(['slack.v1', 'discord.v1'])('hides signing key actions for %s receivers', async format => {
    mocks.enabled = true
    mocks.list.mockResolvedValue({ receivers: [{ kind: 'live', id: 'chat', name: 'Chat alerts', format, destination: 'https://example.com/[redacted]', state: 'active', revision: 1, profile: 'minimal', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none' }], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mount()
    await screen.findByText('Chat alerts')
    expect(screen.getByText(format === 'slack.v1' ? 'Slack' : 'Discord')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send test' })).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions for Chat alerts' }), { button: 0, ctrlKey: false })
    const menu = await screen.findByRole('menu')
    expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Delete'])
  })
  it('does not reveal a key after creating a chat receiver', async () => {
    mocks.enabled = true
    mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.create.mockResolvedValue({ receiver: { id: 'chat', format: 'slack.v1' }, secret: 'UNEXPECTED_CHAT_SECRET' })
    mount(); await screen.findByText(/No receivers yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack.v1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Chat alerts' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://hooks.slack.com/services/T1/B1/test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.queryByText('Save your signing key')).toBeNull()
  })
  it('never retains a returned key in the shared mutation cache', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.create.mockResolvedValue({ receiver: { id: 'receiver' }, secret: 'EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET' })
    const client = createQueryClient(); mount(client); await screen.findByText(/No receivers yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://example.com/receiver' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    await screen.findByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')
    await waitFor(() => expect(client.getMutationCache().getAll().some(item => item.state.status === 'success')).toBe(true))
    expect(JSON.stringify(client.getMutationCache().getAll().map(item => item.state.data))).not.toContain('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')
  })
  it('shows a new key once and clears it when the project changes', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.create.mockResolvedValue({ receiver: { id: 'receiver' }, secret: 'EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET' })
    const view = mount(); await screen.findByText(/No receivers yet/); fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://example.com/receiver' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(await screen.findByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')).toBeTruthy()
    mocks.project = 'beta'; view.rerender(<QueryClientProvider client={createQueryClient()}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>)
    expect(screen.queryByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')).toBeNull()
  })
  it('states the real retry and pause semantics instead of promising a synthetic probe', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [
      { kind: 'live', id: 's', name: 'Suspended', destination: 'https://example.com/s', state: 'suspended', revision: 3, deliveryRevision: 3, profile: 'minimal', pendingCount: 4, inFlightCount: 0, consecutiveFailures: 10, nextProbeAt: '2026-10-17T12:12:00Z', lastTest: 'none', activationBlocked: false },
      { kind: 'live', id: 's0', name: 'Drained', destination: 'https://example.com/e', state: 'suspended', revision: 3, deliveryRevision: 3, profile: 'minimal', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 3, lastTest: 'none', activationBlocked: false },
      { kind: 'live', id: 'p', name: 'Paused', destination: 'https://example.com/p', state: 'paused', revision: 2, deliveryRevision: 2, profile: 'minimal', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false },
      { kind: 'live', id: 'd', name: 'Disabled', destination: 'https://example.com/d', state: 'disabled', revision: 1, deliveryRevision: 1, profile: 'minimal', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false },
    ], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mount()
    expect(await screen.findByText(/10 failed attempts in a row\. Next retry .*\./)).toBeTruthy()
    expect(screen.getByText(/3 failed attempts in a row\. Nothing is queued, so nothing will be retried/)).toBeTruthy()
    expect(screen.queryByText(/recovery attempt/)).toBeNull()
    expect(screen.getByText('Paused. New events aren’t queued.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test after repair' })).toBeTruthy()
  })
})

it.each(['loading', 'error'])('does not call %s health disabled', state => {
  mocks.healthState = state
  mount()
  expect(screen.getByRole('status').textContent).toContain(state === 'loading' ? 'Loading webhook status' : 'Webhook status unavailable')
  expect(screen.queryByText('Webhooks are off')).toBeNull()
  expect(mocks.list).not.toHaveBeenCalled()
})
