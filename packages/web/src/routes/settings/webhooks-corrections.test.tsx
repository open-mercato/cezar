import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webhookEventSchema, type WebhookReceiver } from '@open-mercato/cezar-api-client'
import { WebhooksSection } from './webhooks-section'

const mocks = vi.hoisted(() => ({ enabled: true, project: 'alpha', list: vi.fn(), create: vi.fn(), update: vi.fn(), activate: vi.fn(), rotate: vi.fn(), history: vi.fn(), activity: vi.fn(), deliveries: vi.fn(), metadata: vi.fn(), test: vi.fn(), toast: vi.fn() }))
vi.mock('@/components/ui/toaster', () => ({ toast: mocks.toast }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: mocks.enabled } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => mocks.project }))
vi.mock('@/api/client', () => ({ getSelfUpdate: mocks.metadata, webhookApi: mocks }))
const receiver: WebhookReceiver = {
  kind: 'live', id: 'receiver', name: 'Alerts', destination: 'http://example.invalid/[redacted]', format: 'cezar.json.v1',
  state: 'inactive', revision: 1, deliveryRevision: 1, profile: 'standard', preset: 'all', events: [],
  scope: 'every_task', graceSeconds: 600, allowLocalNetwork: true, includeScheduledFailures: true,
  pendingCount: 2, inFlightCount: 0, consecutiveFailures: 0, activationBlocked: false, lastTest: 'none',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
}
const list = (rows = [receiver]) => ({ receivers: rows, history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>)
}
const button = (name: string) => screen.getByRole('button', { name })
const input = (name: string) => screen.getByLabelText(name) as HTMLInputElement
const click = (name: string) => fireEvent.click(button(name))
const timeOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' } as const
async function chooseMenuItem(name: string) {
  fireEvent.pointerDown(await screen.findByRole('button', { name: /More actions for/ }), { button: 0, ctrlKey: false })
  fireEvent.click(await screen.findByRole('menuitem', { name }))
}
async function edit() { mount(); fireEvent.click(await screen.findByRole('button', { name: 'Edit' })); fireEvent.change(input('Name'), { target: { value: 'My draft' } }); fireEvent.change(input('Receiver URL'), { target: { value: 'https://replacement.invalid/private-fixture' } }) }
beforeEach(() => {
  vi.resetAllMocks(); mocks.enabled = true; mocks.project = 'alpha'
  vi.stubGlobal('EventSource', undefined)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network: fixtures only') }))
  mocks.list.mockResolvedValue(list()); mocks.metadata.mockResolvedValue({ version: '0.15.0', installKind: 'global-npm' })
  mocks.deliveries.mockResolvedValue({ items: [], total: 0, timezone: 'America/New_York' })
  mocks.activity.mockResolvedValue({ items: [], total: 0, timezone: 'America/New_York' })
})
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor); else Reflect.deleteProperty(navigator, 'clipboard'); cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('independent webhook UI corrections', () => {
  it.each([409, 500])('keeps Add usable when an earlier Send test fails with %s', async status => {
    let reject!: (issue: Error) => void
    mocks.test.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    mocks.create.mockResolvedValue({ receiver })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Send test' }))
    await waitFor(() => expect(mocks.test).toHaveBeenCalledTimes(1))
    click('Add receiver')
    fireEvent.change(input('Name'), { target: { value: 'Unrelated draft' } })
    fireEvent.change(input('Receiver URL'), { target: { value: 'https://receiver.invalid/new' } })
    reject(Object.assign(new Error('Earlier test failed'), { status }))
    await waitFor(() => expect(button('Save receiver').hasAttribute('disabled')).toBe(false))
    expect(input('Name').value).toBe('Unrelated draft')
    expect(input('Receiver URL').value).toBe('https://receiver.invalid/new')
    expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/Cancel, check the refreshed receiver/)).toBeNull()
    expect(mocks.toast).toHaveBeenCalledWith('Earlier webhook action failed: Earlier test failed', { tone: 'danger' })
    click('Save receiver')
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith('alpha', expect.objectContaining({ name: 'Unrelated draft', url: 'https://receiver.invalid/new' })))
  })
  it('restores focus to the deleted receiver trigger after Escape', async () => {
    const deletedReceiver = { kind: 'history', id: 'deleted', name: 'Retired alerts', deletedAt: '2026-01-02T00:00:00Z' }
    mocks.list.mockResolvedValue({ ...list(), history: [deletedReceiver], historyCount: 1 })
    mocks.history.mockResolvedValue({ items: [deletedReceiver] })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Show deleted receivers (1)' }))
    const trigger = await screen.findByRole('button', { name: /Retired alerts — deleted/ })
    trigger.focus(); fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(trigger))
  })
  it('bounds activation scrolling without removing any disclosure or consent', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Activate' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.className).toContain('max-h-[90dvh]'); expect(dialog.className).toContain('overflow-y-auto')
    for (const label of ['Receiver', 'Destination', 'URL', 'Project', 'Message content', 'Events', 'Tasks', 'Waiting and review delay', 'Failures that resume automatically']) expect(within(dialog).getByText(label)).toBeTruthy()
    expect(within(dialog).getByText(/HTTP is unencrypted/)).toBeTruthy()
    expect(button('Confirm').hasAttribute('disabled')).toBe(true)
    screen.getAllByRole('checkbox').forEach(box => fireEvent.click(box))
    expect(button('Confirm').hasAttribute('disabled')).toBe(false)
    expect(button('Cancel')).toBeTruthy()
  })
  it('preserves every edit field through review and cancel, without any mutation', async () => {
    await edit()
    fireEvent.change(input('Message content'), { target: { value: 'minimal' } }); fireEvent.change(input('Events'), { target: { value: 'custom' } })
    fireEvent.click(input('Task failed')); fireEvent.change(input('Tasks'), { target: { value: 'main_and_questions' } })
    fireEvent.change(input('Waiting and review delay'), { target: { value: '60' } }); fireEvent.click(input('Include failures that will resume automatically (always included in All results)')); fireEvent.click(input('Allow a receiver on this computer or private network'))
    click('Review changes'); click('Cancel')
    expect(input('Name').value).toBe('My draft'); expect(input('Receiver URL').value).toBe('https://replacement.invalid/private-fixture')
    expect(input('Message content').value).toBe('minimal'); expect(input('Events').value).toBe('custom'); expect(input('Task failed').checked).toBe(true)
    expect(input('Tasks').value).toBe('main_and_questions'); expect(input('Waiting and review delay').value).toBe('60')
    expect(input('Allow a receiver on this computer or private network').checked).toBe(false)
    expect(input('Include failures that will resume automatically (always included in All results)').checked).toBe(false)
    expect(mocks.update).not.toHaveBeenCalled()
  })
  it('requires explicit reconciliation and a new review after stale edit; never silently upgrades revision', async () => {
    await edit(); click('Review changes')
    mocks.list.mockResolvedValue(list([{ ...receiver, revision: 2, name: 'Changed elsewhere', pendingCount: 7 }]))
    mocks.update.mockRejectedValueOnce(Object.assign(new Error('stale revision'), { status: 409 })).mockResolvedValue({ receiver })
    click('Confirm'); await screen.findByText(/Latest: revision 2/)
    expect(button('Confirm').hasAttribute('disabled')).toBe(true); expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[0]?.[2]).toMatchObject({ expectedRevision: 1 })
    expect(within(screen.getByRole('dialog')).getByText('Changed elsewhere')).toBeTruthy()
    click('Keep draft and review again')
    expect(input('Name').value).toBe('My draft'); expect(input('Receiver URL').value).toContain('replacement.invalid')
    expect(mocks.update).toHaveBeenCalledTimes(1)
    click('Review changes'); expect(screen.getByText(/cancels 7 pending deliveries/)).toBeTruthy()
    click('Confirm'); await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(2))
    expect(mocks.update.mock.calls[1]?.[2]).toMatchObject({ expectedRevision: 2, name: 'My draft', url: 'https://replacement.invalid/private-fixture' })
  })
  it('keeps stale edits blocked after cancelling review when the receiver was deleted', async () => {
    await edit(); click('Review changes'); mocks.list.mockResolvedValue(list([]))
    mocks.update.mockRejectedValue(Object.assign(new Error('stale revision'), { status: 409 }))
    click('Confirm'); await screen.findByText(/This receiver no longer exists/); click('Cancel')
    expect(input('Name').value).toBe('My draft'); expect(button('Review changes').hasAttribute('disabled')).toBe(true)
    expect(button('Keep draft and review again').hasAttribute('disabled')).toBe(true)
  })
  it('rejects stale activation consent and requires selecting the action again', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'Activate' })); screen.getAllByRole('checkbox').forEach(box => fireEvent.click(box))
    mocks.list.mockResolvedValue(list([{ ...receiver, revision: 2 }]))
    mocks.activate.mockRejectedValueOnce(Object.assign(new Error('stale revision'), { status: 409 })).mockResolvedValue({ receiver })
    click('Confirm'); await screen.findByText(/Earlier consent is not reused/)
    expect(button('Confirm').hasAttribute('disabled')).toBe(true); click('Cancel'); click('Activate')
    expect(button('Confirm').hasAttribute('disabled')).toBe(true)
    screen.getAllByRole('checkbox').forEach(box => fireEvent.click(box)); click('Confirm')
    await waitFor(() => expect(mocks.activate).toHaveBeenLastCalledWith('alpha', 'receiver', 2))
  })
  it('formats delivery, retry and activity instants in the advertised server zone', async () => {
    const at = '2026-01-15T12:00:00Z', retry = '2026-01-15T13:00:00Z'
    mocks.deliveries.mockResolvedValue({ items: [{ deliveryId: 'd', createdAt: at, eventType: 'task.failed', status: 'retrying', attempts: 1, nextAttemptAt: retry }], total: 1, timezone: 'America/New_York' })
    mocks.activity.mockResolvedValue({ items: [{ id: 'a', at, action: 'created', source: 'cockpit/api', fields: [] }], total: 1, timezone: 'America/New_York' })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    const expected = (value: string) => new Date(value).toLocaleString(undefined, { timeZone: 'America/New_York', ...timeOptions })
    const delivery = await screen.findByRole('button', { name: /Task failed/ }); expect(delivery.textContent).toContain(expected(at)); fireEvent.click(delivery)
    expect(screen.getByText('Next attempt').nextElementSibling?.textContent).toBe(expected(retry))
    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Activity' }), { button: 0, ctrlKey: false })
    expect((await screen.findByText('Receiver added')).closest('p')?.textContent).toContain(expected(at)); expect(screen.getByText(/Times in America\/New_York/)).toBeTruthy()
  })
  it.each([undefined, 'Not/A_Zone'])('truthfully falls back to local time for missing or invalid timezone %s', async timezone => {
    const at = '2026-01-15T12:00:00Z'
    mocks.deliveries.mockResolvedValue({ items: [{ deliveryId: 'd', createdAt: at, eventType: 'task.failed', status: 'failed', attempts: 1 }], total: 1, timezone })
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    expect(await screen.findByText(/Times in your local time/)).toBeTruthy()
    expect((await screen.findByRole('button', { name: /Task failed/ })).textContent).toContain(new Date(at).toLocaleString(undefined, timeOptions))
  })
  it('uses roving keyboard tabs with associated panels', async () => {
    mount(); fireEvent.click(await screen.findByRole('button', { name: 'History' }))
    const first = screen.getByRole('tab', { name: 'Deliveries' }), second = screen.getByRole('tab', { name: 'Activity' })
    expect(first.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id)
    first.focus(); fireEvent.keyDown(first, { key: 'ArrowRight' })
    await waitFor(() => expect(document.activeElement).toBe(second))
    await waitFor(() => expect(second.getAttribute('aria-selected')).toBe('true')); expect(first.tabIndex).toBe(-1)
    expect(second.getAttribute('aria-controls')).toBe(screen.getByRole('tabpanel').id)
    fireEvent.keyDown(second, { key: 'Home' }); await waitFor(() => expect(document.activeElement).toBe(first))
  })
  it.each(['missing', 'rejected'] as const)('keeps %s clipboard feedback and loss recovery inside the key modal', async mode => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
    mocks.rotate.mockResolvedValue({ receiver, secret: 'SYNTHETIC_KEY_ONLY' })
    mount(); await chooseMenuItem('Rotate key'); click('Confirm')
    await screen.findByText('Save your signing key'); click('Copy key')
    const dialog = within(screen.getByRole('dialog'))
    expect(await dialog.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('copy it manually'))
    expect(dialog.getByText(/shown only once/)).toBeTruthy()
    expect(dialog.getByText('SYNTHETIC_KEY_ONLY').className).toContain('select-text')
  })
  it('previews only synthetic selected-profile JSON locally and explains delay freshness', async () => {
    mount(); await screen.findByRole('button', { name: 'Edit' }); click('Add receiver')
    const sample = () => JSON.parse(screen.getByLabelText('Synthetic JSON sample').textContent!)
    const minimal = sample(); expect(webhookEventSchema.safeParse(minimal).success).toBe(true)
    expect(minimal.task.title).toBeUndefined(); expect(minimal.data.questions).toBeUndefined()
    fireEvent.change(input('Message content'), { target: { value: 'standard' } })
    const standard = sample(); expect(webhookEventSchema.safeParse(standard).success).toBe(true)
    expect(standard.task.title).toBe('Example generated task title'); expect(standard.data.questions).toHaveLength(1)
    expect(screen.getByText(/Skipped if you reply/)).toBeTruthy(); expect(mocks.create).not.toHaveBeenCalled()
  })
  it('links the main-branch guide from the opt-in notice without a Linux requirement', async () => {
    mocks.enabled = false; mount()
    await waitFor(() => expect(screen.getByRole('link', { name: 'Webhook guide' }).getAttribute('href')).toContain('/blob/main/'))
    expect(screen.queryByText(/requires Linux/)).toBeNull()
  })
  it.each([{ version: '0.15.0', installKind: 'checkout' }, { version: '0.15.1-nightly.123', installKind: 'managed' }, { version: '0.15.0', installKind: 'unknown' }])('labels the main guide fallback honestly for $installKind $version', async metadata => {
    mocks.enabled = false; mocks.metadata.mockResolvedValue(metadata); mount()
    expect(screen.getByRole('link', { name: 'Webhook guide' }).getAttribute('href')).toContain('/blob/main/')
  })
  it('uses semantic state tones', async () => {
    mocks.list.mockResolvedValue(list([{ ...receiver, state: 'suspended' }]))
    mount(); const state = await screen.findByText('Failing')
    expect(state.querySelector('[data-tone="pending"]')).toBeTruthy()
  })
  it('warns that old receiver verifier keys must be removed', async () => {
    mount(); await chooseMenuItem('Revoke old keys'); expect(within(screen.getByRole('dialog')).getByText(/remove old keys from your receiver/)).toBeTruthy()
  })
  it('names a project-removal pause instead of implying the user paused it', async () => {
    mocks.list.mockResolvedValue(list([{ ...receiver, state: 'paused', pauseReason: 'project_removal' }]))
    mount()
    expect(await screen.findByText(/Paused when this project was removed from the workspace/)).toBeTruthy()
  })
  it('does not advertise a probe retry when nothing is queued', async () => {
    mocks.list.mockResolvedValue(list([{ ...receiver, state: 'suspended', consecutiveFailures: 10, pendingCount: 0, nextProbeAt: '2026-01-01T00:15:00Z' }]))
    mount()
    expect(await screen.findByText(/Nothing is queued, so nothing will be retried/)).toBeTruthy()
    expect(screen.queryByText(/Next retry/)).toBeNull()
  })
})
