import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection, LegacyWebhooksRedirect } from './integrations-section'

const jira = { kind: 'jira', connectionId: 'connection-1', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'Platform' }
const connection = { id: 'connection-1', kind: 'jira', origin: 'https://acme.atlassian.net', email: 'user@example.com' }
const installed = { configFile: 'e2e.config.ts', workflow: true, credentials: [], setup: null }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function mount(overrides: Record<string, unknown> = {}, offline = false, enabled = false, initialEntry = '/') {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (offline) return json({ error: 'Offline' }, 503)
    const url = String(input)
    const suffix = Object.keys(overrides).find(key => url.endsWith(key))
    if (suffix) return json(overrides[suffix])
    if (url.endsWith('/tracker/association')) return json({ association: jira })
    if (url.endsWith('/tracker/connection')) return json({ connection, demo: false })
    if (url.endsWith('/e2e')) return json(installed)
    if (url.endsWith('/telegram')) return json({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] })
    return json({ error: 'Unexpected request' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  for (const project of ['alpha', 'beta']) client.setQueryData([project, 'health'], { capabilities: { webhooks: enabled } })
  const tree = (projectId: string) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[initialEntry]}><ProjectScopeProvider projectId={projectId}><IntegrationsSection /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>
  const view = render(tree('alpha'))
  return { fetch, client, switchProject: () => view.rerender(tree('beta')) }
}

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

describe('Integrations gallery', () => {
  it('shows Jira and TesterArmy together and opens only the selected provider configuration', async () => {
    mount()
    await screen.findByText('Connected')
    expect(screen.getByText('Installed')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Notifications' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    const panel = await screen.findByRole('region', { name: 'Jira' })
    expect(within(panel).getByRole('button', { name: 'Replace Jira credentials' })).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: /Linear credentials/ })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: 'All integrations' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Configure Linear' }))
    const linear = await screen.findByRole('region', { name: 'Linear' })
    expect(within(linear).getByText(/replaces the issue source/)).toBeTruthy()
    expect(within(linear).queryByRole('button', { name: 'Disconnect' })).toBeNull()
    expect(within(linear).queryByRole('button', { name: 'Remove project credentials' })).toBeNull()
  })

  it('filters the gallery by integration name and reports empty searches', async () => {
    mount()
    await screen.findByText('Connected')
    const search = screen.getByRole('searchbox', { name: 'Search integrations' })
    fireEvent.change(search, { target: { value: 'slack' } })
    expect(screen.getByRole('button', { name: 'Configure Slack' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
    fireEvent.change(search, { target: { value: 'does-not-exist' } })
    expect(screen.getByRole('status').textContent).toBe('No integrations match “does-not-exist”.')
    fireEvent.change(search, { target: { value: 'platform' } })
    expect(screen.getByRole('button', { name: 'Configure Jira' })).toBeTruthy()
  })

  it('keeps the configuration open while its connection status changes', async () => {
    const { client } = mount({ '/tracker/association': { association: null }, '/tracker/connection': { connection: null, demo: true } })
    await waitFor(() => expect(screen.getAllByText('Not connected')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    await screen.findByRole('region', { name: 'Jira' })
    act(() => { client.setQueryData(['tracker', 'alpha', 'association'], { association: jira }) })
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())
    expect(screen.getByRole('region', { name: 'Jira' })).toBeTruthy()
  })

  it('discards unsaved credential forms when the project changes', async () => {
    const { switchProject } = mount()
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace Jira credentials' }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'unsaved-test-value' } })
    switchProject()
    await waitFor(() => expect(screen.queryByLabelText('API token')).toBeNull())
    fireEvent.click(await screen.findByRole('button', { name: 'Replace Jira credentials' }))
    expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('')
  })

  it('does not report unavailable or mismatched connections as connected', async () => {
    mount({ '/tracker/connection': { connection: { ...connection, id: 'different' }, demo: false } })
    await screen.findByText('Credentials missing')
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('shows unavailable status on the tiles only, without a gallery-wide alert or retry', async () => {
    mount({}, true)
    await waitFor(() => expect(screen.getAllByText('Status unavailable')).toHaveLength(3))
    expect(screen.queryByText('Not connected')).toBeNull()
    expect(screen.queryByText('Not set up')).toBeNull()
    expect(screen.queryByText(/Could not load some integration statuses/)).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('filters by category together with search and keeps Webhooks last', async () => {
    mount()
    await screen.findByText('Connected')
    const filter = screen.getByRole('group', { name: 'Integration category' })
    fireEvent.click(within(filter).getByRole('button', { name: /^Notifications/ }))
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Configure TesterArmy e2e' })).toBeNull()
    const tiles = screen.getAllByRole('button', { name: /^Configure / }).map(tile => tile.getAttribute('aria-label'))
    expect(tiles).toEqual(['Configure Slack', 'Configure Discord', 'Configure Telegram', 'Configure Webhooks'])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: 'jira' } })
    expect(screen.getByRole('status').textContent).toBe('No integrations match “jira”.')
    fireEvent.click(within(filter).getByRole('button', { name: /^All categories/ }))
    expect(screen.getByRole('button', { name: 'Configure Jira' })).toBeTruthy()
  })

  it('keeps the category filter when returning from a configuration', async () => {
    mount()
    await screen.findByText('Connected')
    fireEvent.click(within(screen.getByRole('group', { name: 'Integration category' })).getByRole('button', { name: /^Testing/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure TesterArmy e2e' }))
    fireEvent.click(await screen.findByRole('button', { name: 'All integrations' }))
    expect(within(screen.getByRole('group', { name: 'Integration category' })).getByRole('button', { name: /^Testing/ }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
  })

  it('shows setup awaiting merge and opens the real TesterArmy setup form', async () => {
    mount({ '/e2e': { ...installed, configFile: null, workflow: false, setup: { runId: 'setup-1', status: 'done' } } })
    await screen.findByText('Awaiting merge')
    fireEvent.click(screen.getByRole('button', { name: 'Configure TesterArmy e2e' }))
    const panel = await screen.findByRole('region', { name: 'TesterArmy e2e' })
    expect(within(panel).getByRole('button', { name: 'Set up e2e' })).toBeTruthy()
    expect(within(panel).getByRole('link', { name: 'Open the setup task' })).toBeTruthy()
  })

  it('keeps the search when returning from a configuration', async () => {
    mount()
    await screen.findByText('Connected')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search integrations' }), { target: { value: 'jira' } })
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    fireEvent.click(await screen.findByRole('button', { name: 'All integrations' }))
    expect((screen.getByRole('searchbox', { name: 'Search integrations' }) as HTMLInputElement).value).toBe('jira')
    await waitFor(() => expect(document.activeElement?.id).toBe('integration-jira'))
  })

  it('opens the real Telegram setup with its own heading and status, not a second one', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Telegram' }))
    const panel = await screen.findByRole('region', { name: 'Telegram' })
    expect(within(panel).getAllByRole('heading', { name: 'Telegram' })).toHaveLength(1)
    expect(within(panel).getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.textContent).toBe('All integrations'))
  })
})

const receiver = (id: string, format: string) => ({
  kind: 'live', id, name: id, format, destination: 'https://example.com/…', state: 'active',
  revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [],
  scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false,
  pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'success', activationBlocked: false,
})

it('groups multiple notification receivers by tool and opens a provider-specific add form', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1'), receiver('slack-two', 'slack.v1'), receiver('discord-one', 'discord.v1'), receiver('custom-one', 'cezar.json.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure Slack' }).textContent).toContain('2 active'))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Slack' }))
  expect(await screen.findByRole('heading', { name: /slack-one/ })).toBeTruthy()
  expect(screen.getByRole('heading', { name: /slack-two/ })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: /discord-one|custom-one/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('slack.v1')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Discord' }))
  expect(await screen.findByRole('heading', { name: /discord-one/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('discord.v1')
})

it('keeps notification integrations visible when delivery is off and makes no receiver request', async () => {
  const { fetch } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Configure Slack' }))
  expect(await screen.findByText('Webhooks are off')).toBeTruthy()
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/webhooks'))).toBe(false)
})

function renderLegacyRedirect(entry: string, receivers: unknown[] = [], webhooks = true) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/webhooks')
    ? json({ receivers, history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    : json({ error: 'Unexpected request' }, 404)))
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  client.setQueryData(['alpha', 'health'], { capabilities: { webhooks } })
  function Location() { const location = useLocation(); return <output>{location.pathname + location.search + location.hash}</output> }
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[entry]}><ProjectScopeProvider projectId="alpha"><Routes>
    <Route path="/p/:id/settings/webhooks" element={<LegacyWebhooksRedirect />} />
    <Route path="/p/:id/settings/integrations" element={<Location />} />
  </Routes></ProjectScopeProvider></MemoryRouter></QueryClientProvider>)
}

it('redirects old receiver links into integrations without losing project, tab or hash', async () => {
  renderLegacyRedirect('/p/alpha/settings/webhooks?endpoint=abc&tab=activity#details', [receiver('abc', 'cezar.json.v1')])
  expect(await screen.findByText('/p/alpha/settings/integrations?endpoint=abc&tab=activity&integration=webhooks#details')).toBeTruthy()
})

it('lands an old Slack or Discord receiver link on that tool\'s tile', async () => {
  renderLegacyRedirect('/p/alpha/settings/webhooks?endpoint=slack-one&tab=settings', [receiver('slack-one', 'slack.v1')])
  expect(await screen.findByText('/p/alpha/settings/integrations?endpoint=slack-one&tab=settings&integration=slack')).toBeTruthy()
  cleanup()
  renderLegacyRedirect('/p/alpha/settings/webhooks?endpoint=discord-one&tab=deliveries', [receiver('discord-one', 'discord.v1')])
  expect(await screen.findByText('/p/alpha/settings/integrations?endpoint=discord-one&tab=deliveries&integration=discord')).toBeTruthy()
})

it('falls back to the Webhooks tile when delivery is off and the receiver cannot be looked up', async () => {
  renderLegacyRedirect('/p/alpha/settings/webhooks?endpoint=abc', [], false)
  expect(await screen.findByText('/p/alpha/settings/integrations?endpoint=abc&integration=webhooks')).toBeTruthy()
})

it('redirects an old general webhooks bookmark to the integrations gallery', async () => {
  renderLegacyRedirect('/p/alpha/settings/webhooks?tab=activity')
  expect(await screen.findByText('/p/alpha/settings/integrations')).toBeTruthy()
})

it('names only the tile\'s own destination when its receiver list is empty', async () => {
  mount({ '/webhooks': { receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, '/p/alpha/settings/integrations?integration=slack')
  expect(await screen.findByText(/Add a Slack channel through its Incoming Webhook URL/)).toBeTruthy()
  expect(screen.queryByText(/Discord/)).toBeNull()
})

it('describes each gallery tile status to assistive technology', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true)
  const slack = await screen.findByRole('button', { name: 'Configure Slack' })
  const descriptionId = slack.getAttribute('aria-describedby')
  expect(descriptionId).toBeTruthy()
  await waitFor(() => expect(document.getElementById(descriptionId!)?.textContent).toContain('1 active'))
})

it('opens an old Slack receiver settings link even when it lands through the Webhooks card', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, '/p/alpha/settings/integrations?integration=webhooks&endpoint=slack-one&tab=settings')
  expect(await screen.findByRole('dialog', { name: 'Edit receiver' })).toBeTruthy()
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('slack.v1')
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('slack-one')
})

it('keeps a receiver saved from one tile visible there after its destination moved it to another', async () => {
  const receivers: unknown[] = []
  const list = () => ({ receivers, history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
  const { fetch } = mount({ '/webhooks': list() }, false, true, '/p/alpha/settings/integrations?integration=webhooks')
  fetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('/webhooks') && init?.method === 'POST') { receivers.push(receiver('moved-to-slack', 'slack.v1')); return json({ receiver: receivers[0] }) }
    if (url.endsWith('/webhooks')) return json(list())
    return json({ error: 'Unexpected request' }, 404)
  })
  await screen.findByText('No receivers yet')
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
  fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'moved-to-slack' } })
  fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://receiver.invalid/x' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
  expect(await screen.findByRole('heading', { name: /moved-to-slack/ })).toBeTruthy()
})

const E2E_EMPTY = { configFile: null, workflow: false, credentials: [], setup: null }
const REVISION = 'a'.repeat(64)

const TELEGRAM_RECEIVER = {
  id: 'r1', name: 'My bot', format: 'telegram.v1', state: 'active', lastTest: 'success',
  profile: 'standard', preset: 'attention', events: ['task.attention_required'], telegramChatId: '123',
}

function connectedTelegram(health: string = 'polling') {
  return {
    available: true,
    receivers: [{ receiverId: 'r1', botId: '123', inboundRevision: REVISION, state: 'active' }],
    bots: [{ botId: '123', inboundRevision: REVISION, health: { state: health } }],
    grants: [],
  }
}

const EMPTY_TELEGRAM = { available: true, receivers: [], bots: [], grants: [] }

/** Fills the contract's per-level availability the way the server derives it from `available`/`reason`. */
const withLevels = (body: any) => body && typeof body === 'object' && 'available' in body ? {
  notifications: body.available || body.reason === 'flag_off' ? { available: true } : { available: false, reason: body.reason ?? 'unavailable' },
  taskControl: body.available ? { available: true } : { available: false, reason: body.reason ?? 'unavailable' },
  ...body,
} : body
const renderTab = () => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/?integration=telegram']}><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

function mockAllFetches({ webhookReceivers = [] as unknown[], telegram, webhooks = true, telegramStatus = 200 }: { webhookReceivers?: unknown[]; telegram?: unknown; webhooks?: boolean; telegramStatus?: number } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/e2e')) {
      return new Response(JSON.stringify(E2E_EMPTY), { status: 200 })
    }
    if (url.includes('/health')) {
      return new Response(JSON.stringify({ version: '1.0.0', capabilities: { webhooks } }), { status: 200 })
    }
    if (url.includes('/telegram/activity')) {
      return new Response(JSON.stringify({ entries: [], nextCursor: undefined }), { status: 200 })
    }
    if (url.includes('/telegram')) {
      const body = withLevels(telegram ?? (webhookReceivers.length ? connectedTelegram() : EMPTY_TELEGRAM))
      return new Response(JSON.stringify(telegramStatus === 200 ? body : { error: 'boom' }), { status: telegramStatus })
    }
    if (url.includes('/webhooks')) {
      return new Response(JSON.stringify({ receivers: webhookReceivers }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}


describe('Integrations → Telegram', () => {
  it('keeps diagnostics reachable and hides access management when no Telegram receiver is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    renderTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    expect(await screen.findByText('No Telegram receivers yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.queryByText('People and permissions')).toBeNull()
    expect(screen.queryByText('Approve a person')).toBeNull()
  })

  it('shows connected status and access management once a bot is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER] }))
    renderTab()
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByText('No Telegram receivers yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a chat' })).toBeTruthy()
    expect(await screen.findByText('People and permissions')).toBeTruthy()
    // Diagnostics stay collapsed behind one quiet trigger until asked for.
    expect(screen.getByRole('button', { name: 'Diagnostics' }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Add a chat' }))
    expect(await screen.findByRole('heading', { name: 'Add a Telegram chat' })).toBeTruthy()
    expect(screen.getByText(/Paste the token of the bot you already connected/)).toBeTruthy()
  })

  it('surfaces a degraded bot health state in the badge instead of counting receivers', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: connectedTelegram('blocked') }))
    renderTab()
    expect(await screen.findByText('Blocked')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('reads Not set up from bot health, not from a configured webhook receiver', async () => {
    const telegram = { available: true, receivers: [{ receiverId: 'r1', inboundRevision: REVISION, state: 'active' }], bots: [], grants: [] }
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram }))
    renderTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  const unavailable = (reason: string, extra: object = {}) => ({ available: false, reason, receivers: [], bots: [], grants: [], ...extra })

  it('explains CEZ_WEBHOOKS before the dialog opens and keeps Connect disabled', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhooks: false, telegram: unavailable('webhooks_off') }))
    renderTab()
    expect(await screen.findByText(/Telegram needs CEZ_WEBHOOKS=1/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toHaveProperty('disabled', true)
  })

  it('explains a hosted cockpit and keeps Connect disabled even with webhooks on', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ telegram: unavailable('hosted') }))
    renderTab()
    expect(await screen.findByText(/not available on a hosted cockpit/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toHaveProperty('disabled', true)
  })

  it('lets notifications be set up with CEZ_WEBHOOKS alone and names CEZ_CHAT_INBOUND for task control', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ telegram: unavailable('flag_off') }))
    renderTab()
    expect(await screen.findByText(/Notifications work now\. Task control needs CEZ_CHAT_INBOUND=1/)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Telegram' })).toHaveProperty('disabled', false))
  })

  it('names CEZ_CHAT_INBOUND once when only notifications are available', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: unavailable('flag_off') }))
    renderTab()
    expect(await screen.findByRole('article', { name: 'My bot' })).toBeTruthy()
    expect(screen.getAllByText(/CEZ_CHAT_INBOUND/)).toHaveLength(1)
  })

  it('prefers the per-capability availability a newer server sends', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ telegram: unavailable('flag_off', { notifications: { available: true }, taskControl: { available: false, reason: 'flag_off' } }) }))
    renderTab()
    expect(await screen.findByText(/Task control needs CEZ_CHAT_INBOUND=1/)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect Telegram' })).toHaveProperty('disabled', false))
  })

  it('reads Notifications only when receivers deliver but task control is off', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: unavailable('flag_off') }))
    renderTab()
    expect(await screen.findByText('Notifications only')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Add a chat' })).toBeTruthy()
  })

  it('reads Notifications only for a bound bot nobody is approved on, whose poller therefore stays stopped', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: connectedTelegram('stopped') }))
    renderTab()
    expect(await screen.findByText('Notifications only')).toBeTruthy()
    expect(screen.queryByText('Not running')).toBeNull()
  })

  it('reads Notifications only for a bound bot when task control is turned off', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...connectedTelegram('stopped'), available: false, reason: 'flag_off', grants: [{ receiverId: 'r1' }] } }))
    renderTab()
    expect(await screen.findByText('Notifications only')).toBeTruthy()
  })

  it('still reads Not running once someone is approved, and Blocked without anyone approved', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...connectedTelegram('stopped'), grants: [{ id: 'g', receiverId: 'r1', chatId: '123', userId: '456', label: 'Ada', permissions: ['respond'] }] } }))
    renderTab()
    expect(await screen.findByText('Not running', { selector: '[data-slot="telegram-badge"]' })).toBeTruthy()
    cleanup()
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: connectedTelegram('blocked') }))
    renderTab()
    expect(await screen.findByText('Blocked')).toBeTruthy()
  })

  it('reads Notifications only when replies are disabled on every chat of a bot with approved people', async () => {
    const ada = { id: 'g', receiverId: 'r1', chatId: '123', userId: '456', label: 'Ada', permissions: ['respond'] }
    const disabled = { ...connectedTelegram('stopped'), grants: [ada], receivers: [{ receiverId: 'r1', botId: '123', inboundRevision: REVISION, state: 'disabled' }] }
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: disabled }))
    renderTab()
    expect(await screen.findByText('Notifications only', { selector: '[data-slot="telegram-badge"]' })).toBeTruthy()
    cleanup()
    // A suspended chat is a fault, not a choice: it still needs attention.
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: { ...disabled, receivers: [{ ...disabled.receivers[0], state: 'suspended' }] } }))
    renderTab()
    expect(await screen.findByText('Not running', { selector: '[data-slot="telegram-badge"]' })).toBeTruthy()
    cleanup()
    // Pausing the chat suspends its replies on purpose: notifications only, not a fault.
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [{ ...TELEGRAM_RECEIVER, state: 'paused' }], telegram: { ...disabled, receivers: [{ ...disabled.receivers[0], state: 'suspended' }] } }))
    renderTab()
    expect(await screen.findByText('Notifications only', { selector: '[data-slot="telegram-badge"]' })).toBeTruthy()
  })

  it('does not read Not set up when the Telegram state cannot be loaded', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ telegramStatus: 500 }))
    renderTab()
    expect(await screen.findByText('Unavailable')).toBeTruthy()
    expect(screen.queryByText('Not set up')).toBeNull()
  })

  it('sizes the Telegram heading like the TesterArmy card', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    renderTab()
    expect((await screen.findByRole('heading', { name: 'Telegram' })).className).toContain('text-sm')
  })
})
